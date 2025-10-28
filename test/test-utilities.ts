import { expect } from 'vitest';
import { now } from '../src/time-utils';
import type { PactEventData, WebhookPayload } from '../src/types';

/**
 * Assert that a timestamp is within a reasonable time range of the current time
 * @param timestamp - The timestamp to check
 * @param baseTime - The base time to compare against (defaults to current time)
 * @param toleranceMs - The tolerance in milliseconds (defaults to 100ms)
 */
export function expectTimestampToBeRecent(
	timestamp: number,
	baseTime?: number,
	toleranceMs: number = 100
): void {
	const referenceTime = baseTime ?? now();
	expect(timestamp).toBeGreaterThanOrEqual(referenceTime);
	expect(timestamp).toBeLessThan(referenceTime + toleranceMs);
}

/**
 * Assert that a timestamp is within a specific time range
 * @param timestamp - The timestamp to check
 * @param minTime - The minimum expected time
 * @param maxTime - The maximum expected time
 */
export function expectTimestampInRange(
	timestamp: number,
	minTime: number,
	maxTime: number
): void {
	expect(timestamp).toBeGreaterThan(minTime);
	expect(timestamp).toBeLessThan(maxTime);
}

/**
 * Create a unique test ID for Durable Object testing to avoid state persistence
 * @param prefix - Optional prefix for the ID
 */
export function createUniqueTestId(prefix: string = 'test'): string {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Helper to create test event data
 * @param overrides - Properties to override in the default event
 */
export function createPactEventData(overrides: Partial<PactEventData> = {}): PactEventData {
	return {
		pacticipant: 'TestProvider',
		eventType: 'provider_verification_published',
		provider: 'TestProvider',
		consumer: 'TestConsumer',
		status: 'success',
		resultUrl: 'https://example.com/results',
		pactUrl: 'https://example.com/pact',
		...overrides
	};
}

export function createWebhookPayload(): WebhookPayload {
	return {
		eventType: 'provider_verification_published',
		providerName: 'TestProvider',
		consumerName: 'TestConsumer',
		verificationResultUrl: 'https://example.com/verification',
		pactUrl: 'https://example.com/pact',
		githubVerificationStatus: 'success',
		consumerVersionBranch: 'main',
		providerVersionBranch: 'main',
		consumerVersionNumber: '1.0.0',
		providerVersionNumber: '1.0.0',
		providerVersionDescriptions: 'Initial release'
	};
}
