import { DurableObject } from "cloudflare:workers";
import type { Env, PactEventData, StoredPactEvent } from './types';

// Configuration constants
const QUIET_PERIOD_MS = 10_000; // 10 seconds
const MINUTE_BUCKET_MS = 60000; // 1 minute for event bucketing
const MAX_TIME_BEFORE_FLUSHING = 5 * 60 * 1000; // 5 minutes in milliseconds

// Durable Object for handling pact event aggregation
export class PactAggregator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	private async getLastEventTime(): Promise<number> {
		return (await this.ctx.storage.get("lastEventTime") as number) || 0;
	}

	private async setLastEventTime(time: number): Promise<void> {
		await this.ctx.storage.put("lastEventTime", time);
	}

	private async getLastProcessTime(): Promise<number> {
		return (await this.ctx.storage.get("lastProcessTime") as number) || 0;
	}

	private async setLastProcessTime(time: number): Promise<void> {
		await this.ctx.storage.put("lastProcessTime", time);
	}

	private async getEvents(): Promise<Map<string, StoredPactEvent[]>> {
		const storedEvents = await this.ctx.storage.get("events") as Record<string, StoredPactEvent[]>;
		return storedEvents ? new Map(Object.entries(storedEvents)) : new Map();
	}

	private async setEvents(events: Map<string, StoredPactEvent[]>): Promise<void> {
		await this.ctx.storage.put("events", Object.fromEntries(events));
	}

	private async getProcessingStats(): Promise<{ totalProcessed: number; lastProcessedCount: number }> {
		const totalProcessed = (await this.ctx.storage.get("totalProcessed") as number) || 0;
		const lastProcessedCount = (await this.ctx.storage.get("lastProcessedCount") as number) || 0;
		return { totalProcessed, lastProcessedCount };
	}

	private async updateProcessingStats(processedCount: number): Promise<void> {
		const currentTotal = (await this.ctx.storage.get("totalProcessed") as number) || 0;
		await this.ctx.storage.put("totalProcessed", currentTotal + processedCount);
		await this.ctx.storage.put("lastProcessedCount", processedCount);
	}

	async addEvent(event: PactEventData): Promise<void> {
		try {
			const now = Date.now();

			// Create bucket key (1-minute buckets)
			const minuteBucket = Math.floor(now / MINUTE_BUCKET_MS);
			const bucketKey = `events:${minuteBucket}`;

			// Get existing events
			const events = await this.getEvents();

			// Get existing events for this bucket
			if (!events.has(bucketKey)) {
				events.set(bucketKey, []);
			}

			// Add event to bucket
			events.get(bucketKey)!.push({
				...event,
				ts: now
			} as StoredPactEvent);

			await this.setLastEventTime(now);
			await this.setEvents(events);
		} catch (err) {
			console.error("❌ addEvent: Error adding event:", err);
		}
	}

	async processBatches(): Promise<StoredPactEvent[]> {
		try {
			const now = Date.now();
			const currentMinute = Math.floor(now / MINUTE_BUCKET_MS);

			// Check timing constraints before processing
			const timeSinceLastEvent = now - await this.getLastEventTime();
			const timeSinceLastProcess = now - await this.getLastProcessTime();

			// Don't process if within quiet period unless 5 minutes have passed since last process
			if (timeSinceLastEvent < QUIET_PERIOD_MS && timeSinceLastProcess < MAX_TIME_BEFORE_FLUSHING) {
				console.log(`Skipping processing: within quiet period (${timeSinceLastEvent}ms since last event) and less than 5 minutes since last process (${timeSinceLastProcess}ms)`);
				return [];
			}

			let allEvents: StoredPactEvent[] = [];
			const bucketsToDelete: string[] = [];

			// Get current events
			const events = await this.getEvents();

			// Process all buckets except current minute
			for (const [bucketKey, eventList] of events.entries()) {
				const bucketMinute = parseInt(bucketKey.split(":")[1]);

				if (bucketMinute !== currentMinute) {
					allEvents = allEvents.concat(eventList);
					bucketsToDelete.push(bucketKey);
				}
			}

			// Remove processed buckets
			for (const key of bucketsToDelete) {
				events.delete(key);
			}

			// Persist updated state
			await this.setLastProcessTime(now);

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

	async getDebugInfo() {
		const lastEventTime = await this.getLastEventTime();
		const lastProcessTime = await this.getLastProcessTime();
		const events = await this.getEvents();
		const { totalProcessed, lastProcessedCount } = await this.getProcessingStats();

		return {
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
			timeSinceLastEvent: lastEventTime > 0 ? Date.now() - lastEventTime : null,
			timeSinceLastProcess: lastProcessTime > 0 ? Date.now() - lastProcessTime : null
		};
	}
}
