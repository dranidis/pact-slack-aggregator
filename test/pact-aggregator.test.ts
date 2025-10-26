import { describe, it, expect, beforeEach } from 'vitest';
import { env } from 'cloudflare:test';
import { PactAggregator } from '../src/pact-aggregator';
import type { PactEventData } from '../src/types';

describe('PactAggregator', () => {
	let aggregator: any; // The actual Durable Object instance

	beforeEach(async () => {
		// Use a unique ID for each test to avoid state persistence
		const uniqueId = `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		const id = env.PACT_AGGREGATOR.idFromName(uniqueId);
		const stub = env.PACT_AGGREGATOR.get(id);

		// Get the actual instance - in Vitest, this should give us access to the real methods
		aggregator = stub;
	});

	describe('addEvent', () => {
		it('should add a pact event to storage', async () => {
			const testEvent: PactEventData = {
				pacticipant: 'TestProvider',
				eventType: 'provider_verification_published',
				provider: 'TestProvider',
				consumer: 'TestConsumer',
				status: 'success',
				resultUrl: 'https://example.com/results',
				pactUrl: 'https://example.com/pact'
			};

			// Call the method directly
			await aggregator.addEvent(testEvent);

			// Verify the event was stored by checking debug info
			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(1);
		});

		it('should handle different event types correctly', async () => {
			const contractEvent: PactEventData = {
				pacticipant: 'TestConsumer',
				eventType: 'contract_content_changed',
				provider: 'TestProvider',
				consumer: 'TestConsumer',
				pactUrl: 'https://example.com/pact'
			};

			// Call the method directly - should not throw
			await expect(aggregator.addEvent(contractEvent)).resolves.not.toThrow();

			// Verify event was stored
			const debugData = await aggregator.getDebugInfo();
			expect(debugData.totalEvents).toBe(1);
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
			const testEvent: PactEventData = {
				pacticipant: 'TestProvider',
				eventType: 'provider_verification_published',
				provider: 'TestProvider',
				consumer: 'TestConsumer',
				status: 'success'
			};

			// Add an event
			await aggregator.addEvent(testEvent);

			// Check debug info
			const debugData = await aggregator.getDebugInfo();

			expect(debugData.totalEvents).toBe(1);
			expect(debugData.lastEventTime).toBeGreaterThan(0);
		});
	});
});
