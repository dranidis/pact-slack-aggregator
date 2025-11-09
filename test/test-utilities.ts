import { expect } from 'vitest';
import { now } from '../src/time-utils';
import type { PactEventData, ProviderVerificationPublishedPayload, ContractRequiringVerificationPublishedPayload } from '../src/types';
import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from '../src/constants';
import { getEventDataFromPayload } from '../src/payload-utils';

let auto_id = 0;

/**
 * Assert that a timestamp is within a reasonable time range of the current time
 * @param timestamp - The timestamp to check
 * @param baseTime - The base time to compare against (defaults to current time)
 * @param toleranceMs - The tolerance in milliseconds (defaults to 100ms)
 */
export function expectTimestampToBeRecent(
	timestampString: string,
	baseTime?: number,
	toleranceMs = 100
): void {
	const referenceTime = baseTime ?? now();
	const timestamp = Date.parse(timestampString);
	expect(timestamp).toBeGreaterThanOrEqual(referenceTime);
	expect(timestamp).toBeLessThan(referenceTime + toleranceMs);
}

/**
 * Create a unique test ID for Durable Object testing to avoid state persistence
 * @param prefix - Optional prefix for the ID
 */
export function createUniqueTestId(prefix = 'test') {
	return `${prefix}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}
/**
 * Factory for ProviderVerificationEventData with overrides
 */

export function makeProviderVerificationEventData(overrides: Partial<ProviderVerificationPublishedPayload> = {}): PactEventData {
	return getEventDataFromPayload({ ...createProviderVerificationPayload(), ...overrides } as ProviderVerificationPublishedPayload);
}

/**
 * Factory for ContractPublicationEventData with overrides
 */
export function makeContractPublicationEventData(overrides: Partial<ContractRequiringVerificationPublishedPayload> = {}): PactEventData {
	return getEventDataFromPayload({ ...createContractPublicationPayload(), ...overrides } as ContractRequiringVerificationPublishedPayload);
}

/**
 * Factory for raw ProviderVerificationPublishedPayload with overrides (for webhook testing)
 */
export function makeProviderVerificationPayload(overrides: Partial<ProviderVerificationPublishedPayload> = {}): ProviderVerificationPublishedPayload {
	return { ...createProviderVerificationPayload(), ...overrides };
}

/**
 * Factory for raw ContractRequiringVerificationPublishedPayload with overrides (for webhook testing)
 */
export function makeContractPublicationPayload(overrides: Partial<ContractRequiringVerificationPublishedPayload> = {}): ContractRequiringVerificationPublishedPayload {
	return { ...createContractPublicationPayload(), ...overrides };
}

function createContractPublicationPayload(): ContractRequiringVerificationPublishedPayload {
	return {
		eventType: CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
		providerName: 'TestProvider',
		consumerName: 'TestConsumer',
		pactUrl: 'https://example.com/pact',
		consumerVersionBranch: 'main',
		providerVersionBranch: 'develop',
		consumerVersionNumber: '1.0.0',
		providerVersionNumber: '2.0.0',
		providerVersionDescriptions: 'Test version',
	};
}

function createProviderVerificationPayload(): ProviderVerificationPublishedPayload {
	auto_id += 1;
	return {
		eventType: PROVIDER_VERIFICATION_PUBLISHED,
		providerName: 'TestProvider',
		consumerName: 'TestConsumer',
		githubVerificationStatus: 'success',
		verificationResultUrl: `https://example.com/verification-results/${auto_id}`,
		consumerVersionBranch: 'main',
		providerVersionBranch: 'develop',
		consumerVersionNumber: '1.0.0',
		providerVersionNumber: '2.0.0',
	};
}


