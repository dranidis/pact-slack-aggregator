import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { mockTime, now } from '../src/time-utils';
import { expectTimestampToBeRecent, createUniqueTestId, makeProviderVerificationEventData, makeContractPublicationEventData } from './test-utilities';
import { PactAggregator } from '../src';

describe('PactAggregator', () => {
	let aggregator: DurableObjectStub<PactAggregator>

	beforeEach(() => {
		// Use a unique ID for each test to avoid state persistence
		const uniqueId = createUniqueTestId('pact-aggregator');
		aggregator = env.PACT_AGGREGATOR.getByName(uniqueId);
	});

	describe('addEvent', () => {
		it('should add a pact event to storage', async () => {
			const testEvent = makeProviderVerificationEventData();

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
			expect(eventBucketsArray[0].count).toBe(1);
			expect(eventBucketsArray[0].events).toBeDefined();

			const storedEvent = eventBucketsArray[0].events[0];
			expect(storedEvent).toMatchObject(testEvent);
		});

		it('should add multiple events to the same bucket when in the same minute', async () => {
			const baseTime = 60000; // 1 minute
			mockTime(() => baseTime);

			const event1 = makeProviderVerificationEventData({
				providerName: 'Provider1',
				verificationResultUrl: 'https://example.com/results/1',
			});

			const event2 = makeProviderVerificationEventData({
				providerName: 'Provider2',
				verificationResultUrl: 'https://example.com/results/2',
			});

			await aggregator.addEvent(event1);
			await aggregator.addEvent(event2);

			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(2);

			// Should have one bucket with two events
			const eventBucketsArray = Object.values(debugData.eventBuckets);
			expect(eventBucketsArray).toHaveLength(1);
			expect(eventBucketsArray[0].count).toBe(2);
		});
	});

	describe('getEventsToPublish', () => {
		it('should process events correctly', async () => {
			const testEvent = makeProviderVerificationEventData({
				providerName: 'TestProvider',
			});

			// Add an event first
			await aggregator.addEvent(testEvent);

			// Process batches
			const result = await aggregator.getEventsToPublish();

			// Should return array of processed events
			expect(Array.isArray(result)).toBe(true);
		});

		it('should return empty result when no events to process', async () => {
			const result = await aggregator.getEventsToPublish();
			expect(result).toEqual([]);
		});

		it('should process events from previous minute buckets but not current minute', async () => {
			const baseTime = 120000; // 2 minutes
			const previousTime = 60000; // 1 minute

			// Add event in previous minute
			mockTime(() => previousTime);
			const pastEvent = makeProviderVerificationEventData({
				providerName: 'PastProvider',
				providerVersionNumber: '1.0.0',
				verificationResultUrl: 'https://example.com/results/past',
			});
			await aggregator.addEvent(pastEvent);

			// Add event in current minute
			mockTime(() => baseTime);
			const currentEvent = makeProviderVerificationEventData({
				providerVersionNumber: '2.0.0',
				providerName: 'CurrentProvider',
				verificationResultUrl: 'https://example.com/results/current',
			});
			await aggregator.addEvent(currentEvent);

			// Process events
			const result = await aggregator.getEventsToPublish();

			// Should only return the past event, not the current minute event
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				pacticipant: 'PastProvider',
				pacticipantVersionNumber: '1.0.0'
			});

			// Verify the past bucket was removed
			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(1); // Only current minute event remains

			// Verify processing stats were updated
			expect(debugData.lastProcessedCount).toBe(1);
			expect(debugData.totalProcessedEvents).toBe(1);
		});

		it('should consolidate events with same pacticipantVersionNumber from different buckets', async () => {
			const baseTime = 180000; // 3 minutes
			const versionNumber = '1.0.0';

			// Add event in previous minute
			mockTime(() => 120000); // 2 minutes
			const pastEvent = makeProviderVerificationEventData({
				providerVersionNumber: versionNumber,
				providerName: 'Provider1',
				verificationResultUrl: 'https://example.com/results/past',
			});
			await aggregator.addEvent(pastEvent);

			// Add event with same version number in current minute
			mockTime(() => baseTime);
			const currentEvent = makeContractPublicationEventData({
				consumerName: 'Provider1',
				consumerVersionNumber: versionNumber,
			});
			await aggregator.addEvent(currentEvent);

			// Process events - this should consolidate the events
			const result = await aggregator.getEventsToPublish();

			// Should not return any events because they were consolidated to current bucket
			expect(result).toHaveLength(0);

			// Verify both events are now in the current bucket
			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(2); // Both events consolidated

			const buckets = Object.values(debugData.eventBuckets);
			expect(buckets).toHaveLength(1); // Only current bucket remains
			expect(buckets[0].count).toBe(2); // Both events in same bucket
		});

		it('should handle events from previous bucket that are within quiet period', async () => {
			const baseTime = 240000; // 4 minutes
			const veryRecentTime = baseTime - 30000; // Just 30 seconds ago (within quiet period)

			// Add event in previous minute that's very recent
			mockTime(() => veryRecentTime);
			const recentEvent = makeProviderVerificationEventData({
				providerName: 'RecentProvider',
				verificationResultUrl: 'https://example.com/results/recent',
			});
			await aggregator.addEvent(recentEvent);

			// Add event with same version in current minute
			mockTime(() => baseTime);
			const currentEvent = makeProviderVerificationEventData({
				providerName: 'RecentProvider',
				verificationResultUrl: 'https://example.com/results/current',
			});
			await aggregator.addEvent(currentEvent);

			// Process events
			const result = await aggregator.getEventsToPublish();

			// Should consolidate the recent event due to quiet period logic
			expect(result).toHaveLength(0);

			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(2); // Both events consolidated
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
			const testEvent = makeProviderVerificationEventData();
			const timeBeforeCall = now();

			// Add an event
			await aggregator.addEvent(testEvent);

			// Check debug info
			const debugData = await aggregator.getDebugInfo();

			expect(debugData.totalEvents).toBe(1);
			expectTimestampToBeRecent(debugData.lastEventTime, timeBeforeCall);
		});

		it('should handle null time values correctly', async () => {
			// Fresh aggregator with no events should have null time values
			const debugData = await aggregator.getDebugInfo();

			expect(Date.parse(debugData.lastEventTime)).toBe(0);
			expect(Date.parse(debugData.lastProcessTime)).toBe(0);
			expect(debugData.timeSinceLastEvent).toBeNull();
			expect(debugData.timeSinceLastProcess).toBeNull();
		});

		it('should calculate time differences correctly when events exist', async () => {
			const baseTime = 300000; // 5 minutes
			mockTime(() => baseTime);

			const testEvent = makeContractPublicationEventData();
			await aggregator.addEvent(testEvent);

			// Mock time 1 minute later
			mockTime(() => baseTime + 60000);

			const debugData = await aggregator.getDebugInfo();

			expect(debugData.timeSinceLastEvent).toBe(60000); // 1 minute difference
			expect(Date.parse(debugData.lastEventTime)).toBe(baseTime);
		});
	});

	describe('clearAll', () => {
		it('should clear all stored data', async () => {
			// Add some events first
			const testEvent = makeContractPublicationEventData();
			await aggregator.addEvent(testEvent);

			// Verify data exists
			let debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(1);

			// Clear all data
			await aggregator.clearAll();

			// Verify all data is cleared
			debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(0);
			expect(Date.parse(debugData.lastEventTime)).toBe(0);
			expect(Date.parse(debugData.lastProcessTime)).toBe(0);
			expect(debugData.totalProcessedEvents).toBe(0);
			expect(Object.keys(debugData.eventBuckets)).toHaveLength(0);
		});
	});

	describe('event consolidation edge cases', () => {
		it('should handle events that exceed max time before flushing', async () => {
			const baseTime = 600000; // 10 minutes
			const oldTime = baseTime - 420000; // 7 minutes ago (exceeds MAX_TIME_BEFORE_FLUSHING which is 5 minutes)

			// Add old event
			mockTime(() => oldTime);
			const oldEvent = makeProviderVerificationEventData({
				providerName: 'OldProvider',
				providerVersionNumber: '3.0.0',
				verificationResultUrl: 'https://example.com/results/old',
			});
			await aggregator.addEvent(oldEvent);

			// Add current event with same version number
			mockTime(() => baseTime);
			const currentEvent = makeProviderVerificationEventData({
				providerName: 'OldProvider',
				verificationResultUrl: 'https://example.com/results/current',
			});
			await aggregator.addEvent(currentEvent);

			// Process events
			const result = await aggregator.getEventsToPublish();

			// Should process the old event because it exceeds max time
			expect(result).toHaveLength(1);
			expect(result[0]).toMatchObject({
				pacticipant: 'OldProvider',
				pacticipantVersionNumber: '3.0.0',
				ts: oldTime
			});

			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(1); // Only current event remains
		});

		it('should handle moving events to new current bucket', async () => {
			const baseTime = 420000; // 7 minutes
			const previousTime = 360000; // 6 minutes
			const versionNumber = '1.0.0';

			// Add event in previous minute
			mockTime(() => previousTime);
			const pastEvent = makeProviderVerificationEventData({
				providerName: 'Provider1',
				providerVersionNumber: versionNumber,
				verificationResultUrl: 'https://example.com/results/past',
			});
			await aggregator.addEvent(pastEvent);

			// Move to current time and add event with same version
			mockTime(() => baseTime);
			const currentEvent = makeProviderVerificationEventData({
				providerName: 'Provider1',
				providerVersionNumber: versionNumber,
				verificationResultUrl: 'https://example.com/results/current',
			});
			await aggregator.addEvent(currentEvent);

			// Verify consolidation happens when processing
			await aggregator.getEventsToPublish();

			const debugData = await aggregator.getDebugInfo();
			// Should consolidate both events into current bucket
			expect(debugData.totalEvents).toBe(2);

			const buckets = Object.values(debugData.eventBuckets);
			expect(buckets).toHaveLength(1); // All events consolidated to one bucket
		});
	});
});
