import { describe, it, expect } from 'vitest';
import { getEventDataFromPayload, getProviderSlackChannel } from '../src/payload-utils';
import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from '../src/constants';
import type { ProviderVerificationPublishedPayload, ContractRequiringVerificationPublishedPayload, PactEventData } from '../src/types';

describe('payload-utils', () => {
	describe('getEventDataFromPayload', () => {
		it('should correctly extract pacticipant and pacticipantVersionNumber from provider verification payload', () => {
			const payload: ProviderVerificationPublishedPayload = {
				eventType: PROVIDER_VERIFICATION_PUBLISHED,
				providerName: 'UserService',
				consumerName: 'OrderService',
				verificationResultUrl: 'https://pact.example.com/verification-results/123',
				githubVerificationStatus: 'success',
				consumerVersionBranch: 'feature/new-api',
				providerVersionBranch: 'main',
				consumerVersionNumber: 'abc123',
				providerVersionNumber: 'def456',
			};

			const result: PactEventData = getEventDataFromPayload(payload);

			// For provider verification events:
			// - pacticipant should be the provider name
			// - pacticipantVersionNumber should be the provider version number
			expect(result.pacticipant).toBe('UserService');
			expect(result.pacticipantVersionNumber).toBe('def456');

			// All original payload properties should be preserved
			const originalKeys = Object.keys(payload);
			originalKeys.forEach((key) => {
				expect(result).toHaveProperty(key, payload[key as keyof typeof payload]);
			});
		});

		it('should correctly extract pacticipant and pacticipantVersionNumber from contract publication payload', () => {
			const payload: ContractRequiringVerificationPublishedPayload = {
				eventType: CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
				providerName: 'UserService',
				consumerName: 'OrderService',
				pactUrl: 'https://pact.example.com/pacts/orderservice-userservice',
				consumerVersionBranch: 'feature/user-integration',
				providerVersionBranch: 'main',
				consumerVersionNumber: 'abc123',
				providerVersionNumber: 'def456',
				providerVersionDescriptions: 'Latest from main branch',
			};

			const result: PactEventData = getEventDataFromPayload(payload);

			// For contract requiring verification events:
			// - pacticipant should be the consumer name
			// - pacticipantVersionNumber should be the consumer version number
			expect(result.pacticipant).toBe('OrderService');
			expect(result.pacticipantVersionNumber).toBe('abc123');

			// All original payload properties should be preserved
			const originalKeys = Object.keys(payload);
			originalKeys.forEach((key) => {
				expect(result).toHaveProperty(key, payload[key as keyof typeof payload]);
			});
		});
	});

	describe('getProviderSlackChannel', () => {
		const payload: ProviderVerificationPublishedPayload = {
			eventType: PROVIDER_VERIFICATION_PUBLISHED,
			providerName: 'UserService',
			consumerName: 'OrderService',
			verificationResultUrl: 'https://pact.example.com/verification-results/456',
			githubVerificationStatus: 'success',
			consumerVersionBranch: 'feature/x',
			providerVersionBranch: 'main',
			consumerVersionNumber: '1.2.3',
			providerVersionNumber: '4.5.6',
		};
		it('builds channel name using configured prefix (adding # if missing)', () => {
			const env = { PROVIDER_CHANNEL_PREFIX: 'ci-' } as unknown as Env; // prefix without # to test normalization

			const channel = getProviderSlackChannel(env, payload);
			expect(channel).toBe('#ci-UserService');
		});

		it('builds channel name using configured prefix', () => {
			const env = { PROVIDER_CHANNEL_PREFIX: '#ci-' } as unknown as Env; // prefix without # to test normalization

			const channel = getProviderSlackChannel(env, payload);
			expect(channel).toBe('#ci-UserService');
		});
	});
});
