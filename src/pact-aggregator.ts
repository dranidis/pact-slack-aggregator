import { DurableObject } from "cloudflare:workers";
import { now, getMinuteBucket } from "./time-utils";
import type { PactEventData, StoredPactEvent, DebugInfo } from './types';

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

	async addEvent(eventData: PactEventData): Promise<void> {
		try {
			const currentTime = now();
			const bucketMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);
			const bucketKey = `events:${bucketMinute}`;			// Get existing events
			const events = await this.getEvents();

			// Get existing events for this bucket
			if (!events.has(bucketKey)) {
				events.set(bucketKey, []);
			}

			// Add event to bucket
			events.get(bucketKey)!.push({
				...eventData,
				ts: currentTime
			} as StoredPactEvent);

			await this.setLastEventTime(currentTime);
			await this.setEvents(events);
		} catch (err) {
			console.error("❌ addEvent: Error adding event:", err);
		}
	}

	async processBatches(): Promise<StoredPactEvent[]> {
		try {
			const currentTime = now();
			const currentMinute = getMinuteBucket(currentTime, this.env.MINUTE_BUCKET_MS);

			// Get current events
			const events = await this.getEvents();

			// Step 1: Consolidate events by pacticipantVersionNumber before processing
			this.consolidateEvents(events, currentMinute);

			// Persist consolidated events
			await this.setEvents(events);

			let allEvents: StoredPactEvent[] = [];
			const bucketsToDelete: string[] = [];

			// Process all buckets except current minute
			for (const [bucketKey, eventList] of events.entries()) {
				const bucketMinute = parseInt(bucketKey.split(":")[1]);

				if (bucketMinute.toString() !== currentMinute) {
					allEvents = allEvents.concat(eventList);
					bucketsToDelete.push(bucketKey);
				}
			}

			// Remove processed buckets
			for (const key of bucketsToDelete) {
				events.delete(key);
			}

			// Persist updated state
			await this.setLastProcessTime(currentTime);

			if (bucketsToDelete.length > 0) {
				await this.setEvents(events);
				await this.updateProcessingStats(allEvents.length);

				console.log(`Processed ${allEvents.length} events from ${bucketsToDelete.length} buckets`);
			}

			return allEvents;

		} catch (err) {
			console.error("Error processing batches:", err);
			return [];
		}
	}

	private consolidateEvents(events: Map<string, StoredPactEvent[]>, currentMinute: string) {
		// Use the current minute bucket as the target bucket
		const currentBucketKey = `events:${currentMinute}`;

		// Get all pacticipantVersionNumbers from the current bucket
		const recentVersionNumbers = new Set<string>();

		for (const event of events.get(currentBucketKey) ?? []) {
			recentVersionNumbers.add(event.pacticipantVersionNumber);
		}
		// Add to recentVersionNumbers the pacticipantVersionNumbers from the previous minute that had timestaps less than QUIET_PERIOD_MS ago
		// we don't want to publish events that arrived just before the processing trigger
		const previousMinute = (parseInt(currentMinute) - 1).toString();
		const previousBucketKey = `events:${previousMinute}`;

		for (const event of events.get(previousBucketKey) ?? []) {
			if (event.ts > now() - this.env.QUIET_PERIOD_MS
			) {
				recentVersionNumbers.add(event.pacticipantVersionNumber);
			}
		}

		// For each bucket (except current), find events with matching pacticipantVersionNumber
		// but only if timestamp is younger than MAX_TIME_BEFORE_FLUSHING
		const currentTime = now();
		const eventsToMove: { eventToMove: StoredPactEvent; fromBucket: string }[] = [];

		for (const [bucketKey, eventList] of events.entries()) {
			if (bucketKey !== currentBucketKey) {
				for (const event of eventList) {
					if (recentVersionNumbers.has(event.pacticipantVersionNumber)
						&& event.ts > currentTime - this.env.MAX_TIME_BEFORE_FLUSHING
					) {
						eventsToMove.push({ eventToMove: event, fromBucket: bucketKey });
					}
				}
			}
		}

		console.log(`Consolidating ${eventsToMove.length} events to current bucket ${currentBucketKey}`);
		// Move the collected events to the current bucket
		for (const { eventToMove, fromBucket } of eventsToMove) {
			// Remove from original bucket
			const originalEventList = events.get(fromBucket)!;
			const eventIndex = originalEventList.findIndex(e =>
				e.ts === eventToMove.ts && e.pacticipantVersionNumber === eventToMove.pacticipantVersionNumber
			);

			// eventIndex should always be found
			originalEventList.splice(eventIndex, 1);

			// Add to current bucket
			if (!events.has(currentBucketKey)) {
				events.set(currentBucketKey, []);
			}
			events.get(currentBucketKey)!.push(eventToMove);
		}
	}

	async getDebugInfo(): Promise<DebugInfo> {
		const currentTime = now();
		const lastEventTime = await this.getLastEventTime();
		const lastProcessTime = await this.getLastProcessTime();
		const events = await this.getEvents();
		const { totalProcessed, lastProcessedCount } = await this.getProcessingStats();

		return {
			currentTime,
			lastEventTime,
			lastProcessTime,
			eventBuckets: Object.fromEntries(
				Array.from(events.entries()).map(([key, eventList]: [string, StoredPactEvent[]]) => [
					key,
					{ count: eventList.length, events: eventList }
				])
			),
			totalEvents: Array.from(events.values()).reduce((sum, eventList) => sum + eventList.length, 0),
			totalProcessedEvents: totalProcessed,
			lastProcessedCount,
			timeSinceLastEvent: lastEventTime > 0 ? now() - lastEventTime : null,
			timeSinceLastProcess: lastProcessTime > 0 ? now() - lastProcessTime : null
		};
	}

	private async getLastEventTime(): Promise<number> {
		return ((await this.ctx.storage.get("lastEventTime"))!) || 0;
	}

	private async setLastEventTime(time: number): Promise<void> {
		await this.ctx.storage.put("lastEventTime", time);
	}

	private async getLastProcessTime(): Promise<number> {
		return ((await this.ctx.storage.get("lastProcessTime"))!) || 0;
	}

	private async setLastProcessTime(time: number): Promise<void> {
		await this.ctx.storage.put("lastProcessTime", time);
	}

	private async getEvents(): Promise<Map<string, StoredPactEvent[]>> {
		const storedEvents = (await this.ctx.storage.get("events"))!;
		return storedEvents ? new Map(Object.entries(storedEvents)) : new Map();
	}

	private async setEvents(events: Map<string, StoredPactEvent[]>): Promise<void> {
		await this.ctx.storage.put("events", Object.fromEntries(events));
	}

	private async getProcessingStats(): Promise<{ totalProcessed: number; lastProcessedCount: number }> {
		const totalProcessed: number = ((await this.ctx.storage.get("totalProcessed"))!) || 0;
		const lastProcessedCount: number = ((await this.ctx.storage.get("lastProcessedCount"))!) || 0;
		return { totalProcessed, lastProcessedCount };
	}

	private async updateProcessingStats(processedCount: number): Promise<void> {
		const currentTotal: number = ((await this.ctx.storage.get("totalProcessed"))!) || 0;
		await this.ctx.storage.put("totalProcessed", currentTotal + processedCount);
		await this.ctx.storage.put("lastProcessedCount", processedCount);
	}

	/**
	 * Clear all stored data (useful for testing)
	 */
	async clearAll(): Promise<void> {
		await this.ctx.storage.deleteAll();
	}
}
