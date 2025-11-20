import { DurableObject } from 'cloudflare:workers';
import { now, getMinuteBucket } from './time-utils';
import type {
	PactEventData,
	StoredPactEventData,
	DebugInfo,
	ContractRequiringVerificationPublishedPayload,
	ProviderVerificationPublishedPayload,
	PublicationThreadInfo,
} from './types';
import { getPactVersionFromPayload } from './payload-utils';

/**
 * Cloudflare Durable Objects ensure that:

Only one method call executes at a time per instance
The second request waits until the first completely finishes
There's no interleaving of operations within methods

 */
export class PactAggregator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	/**
	 * Add a new event to the aggregator.
	 * The event is stored in a minute-based bucket.
	 * @param eventData The event data to add
	 */
	async addEvent(eventData: PactEventData): Promise<void> {
		try {
			const currentTime = now();
			const currentMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);
			const currentBucketKey = this.createBucketKey(currentMinute);
			const allEvents = await this.getEvents();

			if (!allEvents.has(currentBucketKey)) {
				allEvents.set(currentBucketKey, []);
			}

			allEvents.get(currentBucketKey)!.push({
				...eventData,
				ts: currentTime,
			} as StoredPactEventData);

			await this.setLastEventTime(currentTime);
			await this.setEvents(allEvents);
		} catch (err) {
			console.error('❌ addEvent: Error adding event:', err);
		}
	}

	/**
	 * Process the event buckets
	 * @returns An array of events to be sent
	 */
	async getEventsToPublish(): Promise<StoredPactEventData[]> {
		try {
			const currentTime = now();
			const currentMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);

			// Step 1: Consolidate events by pacticipantVersionNumber before processing
			await this.consolidateEvents(currentTime);

			const allEvents = await this.getEvents();

			let eventsToSend: StoredPactEventData[] = [];
			const bucketsToDelete: string[] = [];

			// Process all buckets except current minute
			for (const [bucketKey, eventList] of allEvents.entries()) {
				const bucketMinute = this.getMinuteFromBucketKey(bucketKey);

				if (bucketMinute.toString() !== currentMinute) {
					eventsToSend = eventsToSend.concat(eventList);
					bucketsToDelete.push(bucketKey);
				}
			}

			// Remove processed buckets
			for (const key of bucketsToDelete) {
				allEvents.delete(key);
			}

			// Persist updated state
			await this.setLastProcessTime(currentTime);

			if (bucketsToDelete.length > 0) {
				await this.setEvents(allEvents);
				await this.updateProcessingStats(eventsToSend.length);

				console.log(`Processed ${eventsToSend.length} events from ${bucketsToDelete.length} buckets`);
			}

			return eventsToSend;
		} catch (err) {
			console.error('Error processing batches:', err);
			return [];
		}
	}

	async getDebugInfo(): Promise<DebugInfo> {
		const currentTime = now();
		const lastEventTime = await this.getLastEventTime();
		const lastProcessTime = await this.getLastProcessTime();
		const events = await this.getEvents();
		const { totalProcessed, lastProcessedCount } = await this.getProcessingStats();

		console.log(
			`ENV VARIABLES: GITHUB_BASE_URL=${this.env.GITHUB_BASE_URL} PACTICIPANT_TO_REPO_MAP=${JSON.stringify(
				this.env.PACTICIPANT_TO_REPO_MAP
			)}`
		);

		return {
			currentTime: new Date(currentTime).toISOString(),
			lastEventTime: new Date(lastEventTime).toISOString(),
			lastProcessTime: new Date(lastProcessTime).toISOString(),
			eventBuckets: Object.fromEntries(
				Array.from(events.entries()).map(([key, eventList]: [string, StoredPactEventData[]]) => [
					key,
					{ count: eventList.length, events: eventList },
				])
			),
			totalEvents: Array.from(events.values()).reduce((sum, eventList) => sum + eventList.length, 0),
			totalProcessedEvents: totalProcessed,
			lastProcessedCount,
			timeSinceLastEvent: lastEventTime > 0 ? now() - lastEventTime : null,
			timeSinceLastProcess: lastProcessTime > 0 ? now() - lastProcessTime : null,
			slackChannel: this.env.SLACK_CHANNEL,
			githubBaseUrl: this.env.GITHUB_BASE_URL,
			pacticipantToRepoMap: this.env.PACTICIPANT_TO_REPO_MAP,
			publicationThreads: await this.getAllPublicationThreads(),
		};
	}

	/**
	 * Store the Slack thread timestamp for a publication event in a dictionary under 'publicationThreads'
	 */
	async setPublicationThreadTs(
		pub: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload,
		channel: string,
		threadTs: string,
		channelId?: string
	): Promise<void> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads: Record<string, PublicationThreadInfo> = await this.getAllPublicationThreads();
		// Remove any other entries with same provider|consumer|branch (regardless of pact version or channel)
		// We only keep the most recent publication thread metadata for that trio.
		const targetProvider = pub.providerName;
		const targetConsumer = pub.consumerName;
		const targetBranch = pub.consumerVersionBranch;
		for (const existingKey of Object.keys(threads)) {
			if (existingKey === key) continue;
			const [providerName, consumerName, branch] = existingKey.split('|');
			if (providerName === targetProvider && consumerName === targetConsumer && branch === targetBranch) {
				// delete threads[existingKey];
			}
		}
		const existing = threads[key];
		threads[key] = {
			ts: threadTs,
			channelId: channelId ?? existing?.channelId,
			payload: pub, // always store latest payload
			summary: existing?.summary, // legacy fallback retained (will be ignored if payload present)
		};
		await this.ctx.storage.put('publicationThreads', threads);
	}
	/**
	 * Retrieve the Slack thread timestamp for a publication event from the dictionary
	 */
	async getPublicationThreadTs(ver: ProviderVerificationPublishedPayload, channel: string): Promise<string | undefined> {
		const key = this.makeKeyForPublicationThread(ver, channel);
		const threads: Record<string, PublicationThreadInfo> = await this.getAllPublicationThreads();
		return threads[key]?.ts;
	}

	async getPublicationPayload(
		pub: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload,
		channel: string
	): Promise<ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload | undefined> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads: Record<string, PublicationThreadInfo> = await this.getAllPublicationThreads();
		return threads[key]?.payload;
	}

	async setPublicationSummaryText(
		pub: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload,
		channel: string,
		summaryText: string
	): Promise<void> {
		// Deprecated: only used for legacy upgrade scenarios
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads: Record<string, PublicationThreadInfo> = await this.getAllPublicationThreads();
		if (threads[key]) {
			threads[key].summary = summaryText;
			await this.ctx.storage.put('publicationThreads', threads);
		}
	}

	async getPublicationChannelId(
		pub: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload,
		channel: string
	): Promise<string | undefined> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads: Record<string, PublicationThreadInfo> = await this.getAllPublicationThreads();
		return threads[key]?.channelId;
	}

	/**
	 * Clear all stored data
	 */
	async clearAll(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	private async consolidateEvents(currentTime: number) {
		const allEvents = await this.getEvents();

		// Use the current minute bucket as the target bucket
		const currentMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);
		const currentBucketKey = this.createBucketKey(currentMinute);

		// Get version numbers from current bucket plus recent versions from previous bucket
		// to identify events that should be consolidated together
		const recentVersionNumbers = this.getRecentVersionNumbers(allEvents, currentMinute, currentTime);

		// For each bucket (except current), find events with matching pacticipantVersionNumber
		// but only if timestamp is younger than MAX_TIME_BEFORE_FLUSHING
		const eventsToMove: { eventToMove: StoredPactEventData; fromBucket: string }[] = [];

		for (const [bucketKey, eventList] of allEvents.entries()) {
			if (bucketKey !== currentBucketKey) {
				for (const event of eventList) {
					if (recentVersionNumbers.has(event.pacticipantVersionNumber) && event.ts > currentTime - this.env.MAX_TIME_BEFORE_FLUSHING) {
						eventsToMove.push({ eventToMove: event, fromBucket: bucketKey });
					}
				}
			}
		}

		this.moveEvents(eventsToMove, currentBucketKey, allEvents);

		await this.setEvents(allEvents);
	}

	private moveEvents(
		eventsToMove: { eventToMove: StoredPactEventData; fromBucket: string }[],
		currentBucketKey: string,
		allEvents: Map<string, StoredPactEventData[]>
	) {
		if (eventsToMove.length > 0) {
			console.log(`Moving ${eventsToMove.length} events to current bucket ${currentBucketKey}`);
		}

		// Move the collected events to the current bucket
		for (const { eventToMove, fromBucket } of eventsToMove) {
			// Remove from original bucket
			const fromEventList = allEvents.get(fromBucket)!;
			const eventIndexToMove = fromEventList.findIndex(
				(e) => e.ts === eventToMove.ts && e.pacticipantVersionNumber === eventToMove.pacticipantVersionNumber
			);

			// eventIndex should always be found
			fromEventList.splice(eventIndexToMove, 1);

			// Add to current bucket
			if (!allEvents.has(currentBucketKey)) {
				allEvents.set(currentBucketKey, []);
			}
			allEvents.get(currentBucketKey)!.push(eventToMove);
		}
	}

	private getRecentVersionNumbers(events: Map<string, StoredPactEventData[]>, currentMinute: string, currentTime: number) {
		const currentBucketKey = this.createBucketKey(currentMinute);

		const recentVersionNumbers = new Set<string>();

		for (const event of events.get(currentBucketKey) ?? []) {
			recentVersionNumbers.add(event.pacticipantVersionNumber);
		}

		// Add to recentVersionNumbers the pacticipantVersionNumbers from the previous minute that had timestaps less than QUIET_PERIOD_MS ago
		// we don't want to publish events that arrived just before the processing trigger
		const previousMinute = (parseInt(currentMinute) - 1).toString();
		const previousBucketKey = this.createBucketKey(previousMinute);

		for (const event of events.get(previousBucketKey) ?? []) {
			if (event.ts > currentTime - this.env.QUIET_PERIOD_MS) {
				recentVersionNumbers.add(event.pacticipantVersionNumber);
			}
		}

		return recentVersionNumbers;
	}

	private async getLastEventTime(): Promise<number> {
		return (await this.ctx.storage.get('lastEventTime'))! || 0;
	}

	private async setLastEventTime(time: number): Promise<void> {
		await this.ctx.storage.put('lastEventTime', time);
	}

	private async getLastProcessTime(): Promise<number> {
		return (await this.ctx.storage.get('lastProcessTime'))! || 0;
	}

	private async setLastProcessTime(time: number): Promise<void> {
		await this.ctx.storage.put('lastProcessTime', time);
	}

	private async getEvents(): Promise<Map<string, StoredPactEventData[]>> {
		const storedEvents = (await this.ctx.storage.get('events'))!;
		return storedEvents ? new Map(Object.entries(storedEvents)) : new Map();
	}

	private async setEvents(events: Map<string, StoredPactEventData[]>): Promise<void> {
		await this.ctx.storage.put('events', Object.fromEntries(events));
	}

	private async getProcessingStats(): Promise<{ totalProcessed: number; lastProcessedCount: number }> {
		const totalProcessed: number = (await this.ctx.storage.get('totalProcessed'))! || 0;
		const lastProcessedCount: number = (await this.ctx.storage.get('lastProcessedCount'))! || 0;
		return { totalProcessed, lastProcessedCount };
	}

	private async updateProcessingStats(processedCount: number): Promise<void> {
		const currentTotal: number = (await this.ctx.storage.get('totalProcessed'))! || 0;
		await this.ctx.storage.put('totalProcessed', currentTotal + processedCount);
		await this.ctx.storage.put('lastProcessedCount', processedCount);
	}

	private async getAllPublicationThreads(): Promise<Record<string, PublicationThreadInfo>> {
		const threads: Record<string, PublicationThreadInfo> = (await this.ctx.storage.get('publicationThreads')) ?? {};
		return threads;
	}

	private makeKeyForPublicationThread(
		pub: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload,
		channel: string
	) {
		const pactVersion = getPactVersionFromPayload(pub);

		return `${pub.providerName}|${pub.consumerName}|${pub.consumerVersionBranch}|${pactVersion}|${channel}`;
	}

	private createBucketKey(minute: string) {
		return `events:${minute}`;
	}
	private getMinuteFromBucketKey(bucketKey: string) {
		return parseInt(bucketKey.split(':')[1]);
	}
}
