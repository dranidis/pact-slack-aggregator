import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import type { PactEventData } from '../src/types';
import { mockTime, now } from '../src/time-utils';
import { expectTimestampToBeRecent, createUniqueTestId, createPactEventData } from './test-utilities';
import { PactAggregator } from '../src';

describe('PactAggregator', () => {
	let aggregator: DurableObjectStub<PactAggregator>

	beforeEach(async () => {
		// Use a unique ID for each test to avoid state persistence
		const uniqueId = createUniqueTestId('pact-aggregator');
		aggregator = env.PACT_AGGREGATOR.getByName(uniqueId);
	});

	describe('addEvent', () => {
		it('should add a pact event to storage', async () => {
			const testEvent = createPactEventData();

			const baseTime = new Date(0).getTime();
			const currentMockTime = baseTime;

			mockTime(() => currentMockTime);

			// Call the method directly
			await aggregator.addEvent(testEvent);

			// Verify the event was stored by checking debug info
			const debugData = await aggregator.getDebugInfo();
			// console.log("Debug Data after addEvent:", debugData);

			expect(debugData.totalEvents).toBe(1);
			expectTimestampToBeRecent(debugData.lastEventTime, currentMockTime);

			// there is one bucket with the correct key
			// there is one bucket with one event
			const bucketKey = 'events:0';
			expect(debugData.eventBuckets).toHaveProperty(bucketKey);

			const eventBucketsArray = Object.values(debugData.eventBuckets);
			expect(eventBucketsArray).toHaveLength(1);
			expect(eventBucketsArray[0]!).toHaveProperty('count', 1);
			expect(eventBucketsArray[0]!).toHaveProperty('events');

			const storedEvent = eventBucketsArray[0].events[0];
			expect(storedEvent).toMatchObject(testEvent);
		});
	});

	describe('processBatches', () => {
		it('should process events correctly', async () => {
			const testEvent: PactEventData = {
				pacticipant: 'TestProvider',
				eventType: 'provider_verification_published',
				provider: 'TestProvider',
				consumer: 'TestConsumer',
				status: 'success'
			};

			// Add an event first
			await aggregator.addEvent(testEvent);

			// Process batches
			const result = await aggregator.processBatches();

			// Should return array of processed events
			expect(Array.isArray(result)).toBe(true);
		});

		it('should return empty result when no events to process', async () => {
			const result = await aggregator.processBatches();
			expect(result).toEqual([]);
		});
	});

	describe('getDebugInfo', () => {
		it('should return debug information', async () => {
			const debugData = await aggregator.getDebugInfo();

			expect(debugData).toHaveProperty('lastEventTime');
			expect(debugData).toHaveProperty('lastProcessTime');
			expect(debugData).toHaveProperty('eventBuckets');
			expect(debugData).toHaveProperty('totalEvents');
			expect(debugData).toHaveProperty('totalProcessedEvents');
		});

		it('should show correct event counts after adding events', async () => {
			const testEvent = createPactEventData();
			const timeBeforeCall = now();

			// Add an event
			await aggregator.addEvent(testEvent);

			// Check debug info
			const debugData = await aggregator.getDebugInfo();

			expect(debugData.totalEvents).toBe(1);
			expectTimestampToBeRecent(debugData.lastEventTime, timeBeforeCall);
		});
	});
});
