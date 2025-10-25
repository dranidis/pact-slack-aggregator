import type { Env } from './index';

// Configuration constants
const QUIET_PERIOD_MS = 10_000; // 10 seconds
const MINUTE_BUCKET_MS = 60000; // 1 minute for event bucketing
const MAX_TIME_BEFORE_FLUSHING = 5 * 60 * 1000; // 5 minutes in milliseconds

// Durable Object for handling pact event aggregation
export class PactAggregator {
	private state: DurableObjectState;
	private env: Env;
	private events: Map<string, any[]> = new Map();
	private lastEventTime: number = 0;
	private lastProcessTime: number = 0;

	constructor(state: DurableObjectState, env: Env) {
		this.state = state;
		this.env = env;
	}

	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		switch (url.pathname) {
			case "/add-event":
				return await this.addEvent(request);
			case "/process-batches":
				return await this.processBatches(request);
			case "/get-debug-info":
				return await this.getDebugInfo();
			default:
				return new Response("Not Found", { status: 404 });
		}
	}

	private async addEvent(request: Request): Promise<Response> {
		try {
			// Load existing state first
			await this.loadState();

			const event = await request.json() as any;

			// Update last event time
			this.lastEventTime = Date.now();

			// Create bucket key (1-minute buckets)
			const minuteBucket = Math.floor(this.lastEventTime / MINUTE_BUCKET_MS);
			const bucketKey = `events:${minuteBucket}`;

			// Get existing events for this bucket
			if (!this.events.has(bucketKey)) {
				this.events.set(bucketKey, []);
			}

			// Add event to bucket
			this.events.get(bucketKey)!.push({
				...event,
				ts: this.lastEventTime
			});

			// Persist both lastEventTime and updated events
			await this.state.storage.put("lastEventTime", this.lastEventTime);
			await this.state.storage.put("events", Object.fromEntries(this.events));

			return new Response("Event added", { status: 200 });

		} catch (err) {
			console.error("Error adding event:", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	private async processBatches(request: Request): Promise<Response> {
		try {
			await this.loadTimes();

			const now = Date.now();
			const currentMinute = Math.floor(now / MINUTE_BUCKET_MS);

			// Check timing constraints before processing
			const timeSinceLastEvent = now - this.lastEventTime;
			const timeSinceLastProcess = now - this.lastProcessTime;

			// Don't process if within quiet period unless 5 minutes have passed since last process
			if (timeSinceLastEvent < QUIET_PERIOD_MS && timeSinceLastProcess < MAX_TIME_BEFORE_FLUSHING) {
				console.log(`Skipping processing: within quiet period (${timeSinceLastEvent}ms since last event) and less than 5 minutes since last process (${timeSinceLastProcess}ms)`);
				return new Response(JSON.stringify({
					processedEvents: [],
					eventCount: 0,
					bucketsProcessed: 0,
					skipped: true,
					reason: "within_quiet_period"
				}), {
					headers: { "Content-Type": "application/json" }
				});
			}

			let allEvents: any[] = [];
			const bucketsToDelete: string[] = [];

			await this.loadEvents();

			// Process all buckets except current minute
			for (const [bucketKey, events] of this.events.entries()) {
				const bucketMinute = parseInt(bucketKey.split(":")[1]);

				if (bucketMinute !== currentMinute) {
					allEvents = allEvents.concat(events);
					bucketsToDelete.push(bucketKey);
				}
			}

			// Remove processed buckets
			for (const key of bucketsToDelete) {
				this.events.delete(key);
			}

			// Update last process time
			this.lastProcessTime = now;

			// Persist updated state
			await this.state.storage.put("lastProcessTime", this.lastProcessTime);

			if (bucketsToDelete.length > 0) {
				await this.state.storage.put("events", Object.fromEntries(this.events));

				console.log(`Processed ${allEvents.length} events from ${bucketsToDelete.length} buckets`);
			}

			return new Response(JSON.stringify({
				processedEvents: allEvents,
				eventCount: allEvents.length,
				bucketsProcessed: bucketsToDelete.length
			}), {
				headers: { "Content-Type": "application/json" }
			});

		} catch (err) {
			console.error("Error processing batches:", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	}

	private async getDebugInfo(): Promise<Response> {
		await this.loadState();

		const debugData = {
			lastEventTime: this.lastEventTime,
			lastProcessTime: this.lastProcessTime,
			eventBuckets: Object.fromEntries(
				Array.from(this.events.entries()).map(([key, events]) => [
					key,
					{ count: events.length, events }
				])
			),
			totalEvents: Array.from(this.events.values()).reduce((sum, events) => sum + events.length, 0)
		};

		return new Response(JSON.stringify(debugData, null, 2), {
			headers: { "Content-Type": "application/json" }
		});
	}

	private async loadState(): Promise<void> {
		this.loadTimes();
		this.loadEvents();
	}

	private async loadEvents(): Promise<void> {
		const storedEvents = await this.state.storage.get("events") as Record<string, any[]>;

		if (storedEvents) {
			this.events = new Map(Object.entries(storedEvents));
		}
	}

	private async loadTimes(): Promise<void> {
		const storedLastEventTime = await this.state.storage.get("lastEventTime") as number;
		const storedLastProcessTime = await this.state.storage.get("lastProcessTime") as number;

		if (storedLastEventTime) {
			this.lastEventTime = storedLastEventTime;
		}

		if (storedLastProcessTime) {
			this.lastProcessTime = storedLastProcessTime;
		}
	}
}
