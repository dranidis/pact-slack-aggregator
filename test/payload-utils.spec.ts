import { describe, it, expect } from 'vitest';
import { getEventDataFromPayload } from '../src/payload-utils';
import {
	PROVIDER_VERIFICATION_PUBLISHED,
	CONTRACT_REQUIRING_VERIFICATION_PUBLISHED
} from '../src/constants';
import type {
	ProviderVerificationPublishedPayload,
	ContractRequiringVerificationPublishedPayload,
	ProviderVerificationEventData,
	ContractRequiringVerificationEventData
} from '../src/types';

describe('payload-utils', () => {
	describe('getEventDataFromPayload', () => {
		describe('for provider verification events', () => {
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
					providerVersionNumber: 'def456'
				};

				const result: ProviderVerificationEventData = getEventDataFromPayload(payload) as ProviderVerificationEventData;

				// For provider verification events:
				// - pacticipant should be the provider name
				// - pacticipantVersionNumber should be the provider version number
				expect(result.pacticipant).toBe('UserService');
				expect(result.pacticipantVersionNumber).toBe('def456');

				// All original payload properties should be preserved
				const originalKeys = Object.keys(payload);
				originalKeys.forEach(key => {
					expect(result).toHaveProperty(key, payload[key as keyof typeof payload]);
				});
			});
		});

		describe('for contract requiring verification events', () => {
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
					providerVersionDescriptions: 'Latest from main branch'
				};

				const result: ContractRequiringVerificationEventData = getEventDataFromPayload(payload) as ContractRequiringVerificationEventData;

				// For contract requiring verification events:
				// - pacticipant should be the consumer name
				// - pacticipantVersionNumber should be the consumer version number
				expect(result.pacticipant).toBe('OrderService');
				expect(result.pacticipantVersionNumber).toBe('abc123');

				// All original payload properties should be preserved
				const originalKeys = Object.keys(payload);
				originalKeys.forEach(key => {
					expect(result).toHaveProperty(key, payload[key as keyof typeof payload]);
				});
			});
		});
	});
});
