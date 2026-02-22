import { DurableObject } from 'cloudflare:workers';
import { now, getMinuteBucket } from './time-utils';
import type {
	PactEventData,
	StoredPactEventData,
	DebugInfo,
	PublicationThreadInfo,
	PublicationThreadEntry,
	PactWebhookPayload,
	ContractRequiringVerificationPublishedPayload,
} from './types';
import { getPactVersionFromPayload } from './payload-utils';
import { CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from './constants';
import { DAY_MS } from './constants';
import { coerceInt, getPacticipantMasterBranch } from './utils';

interface DeprecationGroupEntry {
	key: string;
	info: PublicationThreadInfo;
	updatedTime: number;
}

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
	 * Peek events that are eligible for publishing without deleting them.
	 * Caller must invoke ackPublishedBuckets() after successful publication.
	 */
	async peekEventsToPublish(): Promise<{ events: StoredPactEventData[]; bucketsToDelete: string[] }> {
		const currentTime = now();
		const currentMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);

		// Consolidate before selecting eligible buckets
		await this.consolidateEvents(currentTime);

		const allEvents = await this.getEvents();
		const events: StoredPactEventData[] = [];
		const bucketsToDelete: string[] = [];

		// Select all buckets except current minute
		for (const [bucketKey, eventList] of allEvents.entries()) {
			const bucketMinute = this.getMinuteFromBucketKey(bucketKey);
			if (bucketMinute.toString() !== currentMinute) {
				events.push(...eventList);
				bucketsToDelete.push(bucketKey);
			}
		}

		return { events, bucketsToDelete };
	}

	/**
	 * Acknowledge successful publication by deleting the specified buckets and updating stats.
	 */
	async ackPublishedBuckets(bucketsToDelete: string[], processedCount: number): Promise<void> {
		const allEvents = await this.getEvents();

		for (const key of bucketsToDelete) {
			allEvents.delete(key);
		}

		await this.setLastProcessTime(now());

		if (bucketsToDelete.length > 0) {
			await this.setEvents(allEvents);
		}

		if (processedCount > 0) {
			await this.updateProcessingStats(processedCount);
		}
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
				this.env.PACTICIPANT_TO_REPO_MAP,
			)}`,
		);

		return {
			currentTime: new Date(currentTime).toISOString(),
			lastEventTime: new Date(lastEventTime).toISOString(),
			lastProcessTime: new Date(lastProcessTime).toISOString(),
			eventBuckets: Object.fromEntries(
				Array.from(events.entries()).map(([key, eventList]: [string, StoredPactEventData[]]) => [
					key,
					{ count: eventList.length, events: eventList },
				]),
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
	async upsertPublicationThreadInfo(
		pub: PactWebhookPayload,
		channel: string,
		threadTs: string,
		channelId: string,
	): Promise<PublicationThreadEntry[]> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		const currentTime = now();
		const currentTimeString = currentTime.toString();

		const existing = threads[key];
		const info = {
			ts: threadTs,
			channelId: channelId,
			payload: pub, // always store latest payload
			updatedTs: currentTimeString,
			createdTs: existing?.createdTs ?? currentTimeString,
			replyCount: existing?.replyCount ?? 0,
		};

		const deprecatedCandidates =
			pub.eventType === CONTRACT_REQUIRING_VERIFICATION_PUBLISHED
				? this.collectDeprecatedEntries(threads, pub, channel, key, info, currentTime)
				: [];

		threads[key] = info;
		await this.ctx.storage.put('publicationThreads', threads);
		return deprecatedCandidates;
	}

	/**
	 * Determines the number of publication threads to keep for a given branch.
	 * - For the 'master' branch, keep the latest 2 versions (latest and production).
	 * - For any other identified branch, keep only the latest version.
	 * - For empty or unidentified branches, no deprecation is applied (keep all).
	 * @param branch The branch name
	 * @returns The number of threads to keep, or undefined if the branch is not specified
	 */
	private getDeprecationKeepCount(pacticipant: string, branch: string): number | undefined {
		if (!branch) return undefined;
		const masterBranch = getPacticipantMasterBranch(this.env, pacticipant);
		return branch === masterBranch ? 2 : 1;
	}

	private selectDeprecatedCandidatesFromGroupEntries(
		groupEntries: DeprecationGroupEntry[],
		keepCount: number,
		keyToExclude?: string,
	): PublicationThreadEntry[] {
		if (groupEntries.length <= keepCount) return [];

		groupEntries.sort((a, b) => b.updatedTime - a.updatedTime);

		const activeKeys = new Set(groupEntries.slice(0, keepCount).map((e) => e.key));
		const deprecated: PublicationThreadEntry[] = [];
		for (const entry of groupEntries) {
			if (keyToExclude && entry.key === keyToExclude) continue;
			if (activeKeys.has(entry.key)) continue;
			deprecated.push({ key: entry.key, info: entry.info });
		}
		return deprecated;
	}

	/**
	 * Collects the publication threads that should be removed and marked as deprecated at slack
	 * Each branch should have only the latest pact version.
	 * Exceptions:
	 *
	 * - configured "master" branch: keep 2 versions (latest and production)
	 * - empty branch (not identified)
	 *
	 */
	private collectDeprecatedEntries(
		threads: Record<string, PublicationThreadInfo | undefined>,
		pub: ContractRequiringVerificationPublishedPayload,
		channel: string,
		key: string,
		currentInfo: PublicationThreadInfo,
		currentTime: number,
	) {
		const branch = pub.consumerVersionBranch ?? '';

		const keepCount = this.getDeprecationKeepCount(pub.consumerName, branch);
		if (!keepCount) return [];
		const groupEntries: DeprecationGroupEntry[] = [];

		for (const [existingKey, info] of Object.entries(threads)) {
			if (!existingKey.endsWith(`|${channel}`)) continue;
			if (info!.payload.providerName !== pub.providerName) continue;
			if (info!.payload.consumerName !== pub.consumerName) continue;
			if (info!.payload.consumerVersionBranch !== branch) continue;
			groupEntries.push({ key: existingKey, info: info!, updatedTime: this.getThreadUpdatedTime(info!) });
		}

		// Include the newly published pact version as the newest entry.
		groupEntries.push({ key, info: currentInfo, updatedTime: currentTime });

		return this.selectDeprecatedCandidatesFromGroupEntries(groupEntries, keepCount, key);
	}

	/**
	 * Returns the Slack thread timestamp ID for a given pact event and channel, if it exists.
	 * This is used to post messages in the correct thread for pact publications and verifications.
	 *
	 * If the key (in the form of provider|consumer|version|channel) does not exist, returns undefined.
	 *
	 * @param ver PactWebhookPayload
	 * @param channel string
	 * @returns string | undefined
	 */
	async getPublicationThreadTs(ver: PactWebhookPayload, channel: string): Promise<string | undefined> {
		const key = this.makeKeyForPublicationThread(ver, channel);
		const threads = await this.getAllPublicationThreads();
		return threads[key]?.ts;
	}

	/**
	 * Updates the last updated timestamp and increments the reply count for a publication thread.
	 */
	async updatePublicationThread(pub: PactWebhookPayload, channel: string): Promise<void> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		const info = threads[key];
		if (!info) return;

		info.updatedTs = now().toString();
		const current = typeof info.replyCount === 'number' ? info.replyCount : 0;
		info.replyCount = current + 1;
		await this.ctx.storage.put('publicationThreads', threads);
	}

	async getPublicationPayload(pub: PactWebhookPayload, channel: string): Promise<PactWebhookPayload | undefined> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		return threads[key]?.payload;
	}

	async getPublicationChannelId(pub: PactWebhookPayload, channel: string): Promise<string | undefined> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		return threads[key]?.channelId;
	}

	async getPublicationThreadReplyCount(pub: PactWebhookPayload, channel: string): Promise<number | undefined> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		return threads[key]?.replyCount;
	}

	async setPublicationThreadReplyCount(pub: PactWebhookPayload, channel: string, replyCount: number): Promise<void> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		const info = threads[key];
		if (!info) return;
		info.replyCount = replyCount;
		await this.ctx.storage.put('publicationThreads', threads);
	}

	/**
	 * Rotates the stored publication thread to a new Slack root message ts.
	 * Deletes the existing entry and recreates it with replyCount reset to 0.
	 */
	async rotatePublicationThread(pub: PactWebhookPayload, channel: string, newThreadTs: string, channelId: string): Promise<void> {
		const key = this.makeKeyForPublicationThread(pub, channel);
		const threads = await this.getAllPublicationThreads();
		const existing = threads[key];
		if (!existing) return;

		// Remove old entry then create a fresh one so legacy fields don't linger.
		delete threads[key];

		const currentTimeString = now().toString();
		threads[key] = {
			ts: newThreadTs,
			channelId,
			payload: existing.payload,
			createdTs: currentTimeString,
			updatedTs: currentTimeString,
			replyCount: 0,
		};
		await this.ctx.storage.put('publicationThreads', threads);
	}

	/**
	 * Clear all stored data
	 */
	async clearAll(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}

	async clearPublicationThreads(): Promise<void> {
		await this.ctx.storage.delete('publicationThreads');
	}

	/**
	 * Prune stored publication thread metadata according to docs/pact-retention policy.md.
	 *
	 * Policy (per provider/consumer pair):
	 * - Keep at least the newest N pact versions by update time.
	 * - Keep anything updated within the last D days.
	 * - Delete only entries that are both old and beyond the newest N.
	 */
	async prunePublicationThreads(): Promise<PublicationThreadEntry[]> {
		const threads = await this.getAllPublicationThreads();
		const threadEntries = Object.entries(threads);
		const entries = threadEntries
			.map(([key, info]) => {
				if (!info) return undefined;
				return {
					key,
					info,
				};
			})
			.filter((x): x is PublicationThreadEntry => Boolean(x));

		if (entries.length === 0) {
			return [];
		}

		const recentDays = coerceInt(this.env.RETENTION_RECENT_DAYS, 90, { min: 0 });
		const minPactVersions = coerceInt(this.env.RETENTION_MIN_PACT_VERSIONS, 10, { min: 1 });
		const cutoff = now() - recentDays * DAY_MS;
		const groups = new Map<string, PublicationThreadEntry[]>();
		for (const entry of entries) {
			const groupKey = `${entry.info.payload.providerName}|${entry.info.payload.consumerName}|${entry.info.channelId}`;
			const group = groups.get(groupKey);
			if (group) {
				group.push(entry);
			} else {
				groups.set(groupKey, [entry]);
			}
		}

		const removedEntries: PublicationThreadEntry[] = [];
		for (const groupEntries of groups.values()) {
			// Newest first by update time.
			groupEntries.sort((a, b) => Number(b.info.updatedTs) - Number(a.info.updatedTs));

			const newestKeys = new Set(groupEntries.slice(0, minPactVersions).map((e) => e.key));

			for (const entry of groupEntries) {
				const isRecent = Number(entry.info.updatedTs) >= cutoff;
				const shouldKeep = newestKeys.has(entry.key) || isRecent;
				if (!shouldKeep) {
					removedEntries.push({ key: entry.key, info: entry.info });
					delete threads[entry.key];
				}
			}
		}

		if (removedEntries.length > 0) {
			await this.ctx.storage.put('publicationThreads', threads);
		}

		return removedEntries;
	}

	/**
	 * Finds deprecated publicationThreads entries in existing storage.
	 *
	 * Deprecated means: for the same provider+consumer+consumerVersionBranch+channelId,
	 * there are multiple pact versions stored. Only the newest (by updatedTs) should remain.
	 *
	 * This is intended as a one-off production cleanup for deployments that already have
	 * duplicated/superseded pact threads stored.
	 */
	async findDeprecatedPublicationThreads(limit?: number): Promise<PublicationThreadEntry[]> {
		const threads = await this.getAllPublicationThreads();
		const entries: PublicationThreadEntry[] = Object.entries(threads)
			.map(([key, info]) => (info ? { key, info } : undefined))
			.filter((x): x is PublicationThreadEntry => Boolean(x));

		if (entries.length === 0) return [];

		const groups = new Map<string, PublicationThreadEntry[]>();
		for (const entry of entries) {
			const groupKey = `${entry.info.payload.providerName}|${entry.info.payload.consumerName}|${entry.info.payload.consumerVersionBranch}|${entry.info.channelId}`;
			const group = groups.get(groupKey);
			if (group) {
				group.push(entry);
			} else {
				groups.set(groupKey, [entry]);
			}
		}

		const deprecated: PublicationThreadEntry[] = [];
		for (const groupEntries of groups.values()) {
			const consumerName = groupEntries[0]?.info.payload.consumerName ?? '';
			const branch = groupEntries[0]?.info.payload.consumerVersionBranch ?? '';
			const keepCount = this.getDeprecationKeepCount(consumerName, branch);
			if (!keepCount) continue;

			const selectionEntries: DeprecationGroupEntry[] = groupEntries.map((e) => {
				return {
					key: e.key,
					info: e.info,
					updatedTime: this.getThreadUpdatedTime(e.info),
				};
			});
			const selected = this.selectDeprecatedCandidatesFromGroupEntries(selectionEntries, keepCount);
			for (const entry of selected) {
				deprecated.push(entry);
				if (limit && deprecated.length >= limit) return deprecated;
			}
		}

		return deprecated;
	}

	async removePublicationThreadKeys(keys: string[]): Promise<number> {
		if (keys.length === 0) return 0;
		const threads = await this.getAllPublicationThreads();
		let removedCount = 0;
		for (const key of keys) {
			if (threads[key]) {
				delete threads[key];
				removedCount += 1;
			}
		}
		if (removedCount > 0) {
			await this.ctx.storage.put('publicationThreads', threads);
		}
		return removedCount;
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
		allEvents: Map<string, StoredPactEventData[]>,
	) {
		if (eventsToMove.length > 0) {
			console.log(`Moving ${eventsToMove.length} events to current bucket ${currentBucketKey}`);
		}

		// Move the collected events to the current bucket
		for (const { eventToMove, fromBucket } of eventsToMove) {
			// Remove from original bucket
			const fromEventList = allEvents.get(fromBucket)!;
			const eventIndexToMove = fromEventList.findIndex(
				(e) => e.ts === eventToMove.ts && e.pacticipantVersionNumber === eventToMove.pacticipantVersionNumber,
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

	private async getAllPublicationThreads(): Promise<Record<string, PublicationThreadInfo | undefined>> {
		const threads: Record<string, PublicationThreadInfo | undefined> = (await this.ctx.storage.get('publicationThreads')) ?? {};
		return threads;
	}

	private getThreadUpdatedTime(info: PublicationThreadInfo): number {
		const candidate = info.updatedTs;
		const numeric = Number(candidate);
		if (Number.isFinite(numeric)) return numeric;
		if (candidate) {
			const parsed = Date.parse(candidate);
			if (Number.isFinite(parsed)) return parsed;
		}
		return 0;
	}

	/**
	 * Returns a unique key for the publication thread based on provider, consumer, pact version, and channel.
	 *
	 * e.g. "ProviderA|ConsumerB|1.2.3|#pact-ProviderA"
	 *
	 * @param pub PactWebhookPayload
	 * @param channel string
	 * @returns string
	 */
	private makeKeyForPublicationThread(pub: PactWebhookPayload, channel: string) {
		const pactVersion = getPactVersionFromPayload(pub);

		return `${pub.providerName}|${pub.consumerName}|${pactVersion}|${channel}`;
	}

	private createBucketKey(minute: string) {
		return `events:${minute}`;
	}

	private getMinuteFromBucketKey(bucketKey: string) {
		return parseInt(bucketKey.split(':')[1]);
	}
}
