import { describe, it, expect } from 'vitest';
import { createSummaryAndDetailsMessages, type MessageEnv } from '../src/messages';
import type { StoredProviderVerificationEventData, StoredContractRequiringVerificationEventData } from '../src/types';
import {
	PROVIDER_VERIFICATION_PUBLISHED,
	CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
} from '../src/constants';

// Mock environment for testing
const mockEnv: MessageEnv = {
	GITHUB_BASE_URL: 'https://github.com/test-org',
	PACTICIPANT_TO_REPO_MAP: {
		'TestProvider': 'test-provider-repo',
		'TestConsumer': 'test-consumer-repo',
		'UserService': 'user-service',
		'PaymentService': 'payment-service'
	},
	SUCCESS_EMOJI: "✅",
	FAILURE_EMOJI: "😢"
};

describe('createSummaryAndDetailsMessages', () => {
	describe('with verification events only', () => {
		it('should create summary and details for successful verifications', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				verifications
			);

			// Check summary
			expect(result.summaryText).toContain('TestProvider');
			expect(result.summaryText).toContain('develop');
			expect(result.summaryText).toContain('def456');
			expect(result.summaryText).toContain(`Pact verifications: ${mockEnv.SUCCESS_EMOJI}1`);
			expect(result.summaryText).toContain('https://github.com/test-org/test-provider-repo/tree/develop');
			expect(result.summaryText).toContain('https://github.com/test-org/test-provider-repo/commit/def456');

			// Check details
			expect(result.detailsList).toHaveLength(2); // "Verified consumers:" + 1 verification
			expect(result.detailsList[0]).toBe('Verified consumers:');
			expect(result.detailsList[1]).toContain(mockEnv.SUCCESS_EMOJI);
			expect(result.detailsList[1]).toContain('TestConsumer');
			expect(result.detailsList[1]).toContain('verification-results/1');
			expect(result.detailsList[1]).toContain('https://github.com/test-org/test-consumer-repo/tree/main');
		});

		it('should handle failed verifications', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'failure',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				verifications
			);

			expect(result.summaryText).toContain(`Pact verifications: ${mockEnv.FAILURE_EMOJI}1`);
			expect(result.detailsList[1]).toContain(mockEnv.FAILURE_EMOJI);
		});

		it('should handle mixed success and failure verifications', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer1',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				},
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer2',
					verificationResultUrl: 'https://pact.example.com/verification-results/2',
					githubVerificationStatus: 'failure',
					consumerVersionBranch: 'feature/test',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'xyz789',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				verifications
			);

			expect(result.summaryText).toContain(`Pact verifications: ${mockEnv.SUCCESS_EMOJI}1 ${mockEnv.FAILURE_EMOJI}1`);
			expect(result.detailsList).toHaveLength(3); // "Verified consumers:" + 2 verifications
			expect(result.detailsList[1]).toContain(mockEnv.SUCCESS_EMOJI);
			expect(result.detailsList[2]).toContain(mockEnv.FAILURE_EMOJI);
		});
	});

	describe('with publication events only', () => {
		it('should create summary and details for publications', () => {
			const publications: StoredContractRequiringVerificationEventData[] = [
				{
					eventType: CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer',
					pactUrl: 'https://pact.example.com/pacts/testconsumer-testprovider',
					consumerVersionBranch: 'feature/new-api',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					providerVersionDescriptions: 'Latest from main branch',
					pacticipant: 'TestConsumer',
					pacticipantVersionNumber: 'abc123',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestConsumer',
				'abc123',
				publications
			);

			// Check summary
			expect(result.summaryText).toContain('TestConsumer');
			expect(result.summaryText).toContain('feature/new-api');
			expect(result.summaryText).toContain('abc123');
			expect(result.summaryText).toContain('Pact publications: 1');
			expect(result.summaryText).not.toContain('Pact verifications:');

			// Check details
			expect(result.detailsList).toHaveLength(1);
			expect(result.detailsList[0]).toContain('Published');
			expect(result.detailsList[0]).toContain('testconsumer-testprovider');
			expect(result.detailsList[0]).toContain('TestProvider');
			expect(result.detailsList[0]).toContain('Latest from main branch');
			expect(result.detailsList[0]).toContain(`https://pact.example.com/pacts/provider/TestProvider/consumer/TestConsumer/version/abc123/diff/previous-distinct`);
		});

		it('should handle publications without provider version descriptions', () => {
			const publications: StoredContractRequiringVerificationEventData[] = [
				{
					eventType: CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer',
					pactUrl: 'https://pact.example.com/pacts/testconsumer-testprovider',
					consumerVersionBranch: 'feature/new-api',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestConsumer',
					pacticipantVersionNumber: 'abc123',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestConsumer',
				'abc123',
				publications
			);

			expect(result.detailsList[0]).toContain('Published');
			expect(result.detailsList[0]).toContain('TestProvider');
			expect(result.detailsList[0]).not.toContain(' - '); // No description separator
		});
	});

	describe('with mixed events', () => {
		it('should handle both verifications and publications', () => {
			const events: (StoredProviderVerificationEventData | StoredContractRequiringVerificationEventData)[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'TestConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				},
				{
					eventType: CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
					providerName: 'SomeProvider',
					consumerName: 'TestProvider',
					pactUrl: 'https://pact.example.com/pacts/testprovider-someprovider',
					consumerVersionBranch: 'develop',
					providerVersionBranch: 'main',
					consumerVersionNumber: 'def456',
					providerVersionNumber: 'xyz789',
					providerVersionDescriptions: 'Test version',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				events
			);

			// Should contain both publication and verification summaries
			expect(result.summaryText).toContain('Pact publications: 1');
			expect(result.summaryText).toContain(`Pact verifications: ${mockEnv.SUCCESS_EMOJI}1`);

			// Details should contain both publication and verification details
			expect(result.detailsList.length).toBeGreaterThan(2);
			expect(result.detailsList.join(' ')).toContain('Published');
			expect(result.detailsList.join(' ')).toContain('Verified consumers:');
		});
	});

	describe('with no events', () => {
		it('should handle empty event arrays', () => {
			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				[]
			);

			expect(result.summaryText).toContain('TestProvider');
			expect(result.summaryText).toContain('def456');
			expect(result.summaryText).not.toContain('Pact publications:');
			expect(result.summaryText).not.toContain('Pact verifications:');
			expect(result.detailsList).toHaveLength(0);
		});
	});

	describe('GitHub link generation', () => {
		it('should use pacticipant to repo mapping when available', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'UserService',
					consumerName: 'TestConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'UserService',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'UserService',
				'def456',
				verifications
			);

			expect(result.summaryText).toContain('user-service'); // Mapped repo name
			expect(result.summaryText).toContain('https://github.com/test-org/user-service');
		});

		it('should use pascal-case-to-dash conversion for unmapped participants', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'UnmappedService',
					consumerName: 'TestConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/1',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'UnmappedService',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'UnmappedService',
				'def456',
				verifications
			);

			expect(result.summaryText).toContain('unmapped-service'); // Pascal case converted
		});
	});

	describe('verification sorting', () => {
		it('should sort verifications by consumer name and verification ID', () => {
			const verifications: StoredProviderVerificationEventData[] = [
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'ZConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/5',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				},
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'AConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/10',
					githubVerificationStatus: 'failure',
					consumerVersionBranch: 'main',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'abc123',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				},
				{
					eventType: PROVIDER_VERIFICATION_PUBLISHED,
					providerName: 'TestProvider',
					consumerName: 'AConsumer',
					verificationResultUrl: 'https://pact.example.com/verification-results/2',
					githubVerificationStatus: 'success',
					consumerVersionBranch: 'feature/test',
					providerVersionBranch: 'develop',
					consumerVersionNumber: 'xyz789',
					providerVersionNumber: 'def456',
					pacticipant: 'TestProvider',
					pacticipantVersionNumber: 'def456',
					ts: Date.now()
				}
			];

			const result = createSummaryAndDetailsMessages(
				mockEnv,
				'TestProvider',
				'def456',
				verifications
			);

			// Should have AConsumer first (alphabetical), then ZConsumer
			// Within AConsumer, should be sorted by verification ID (2 then 10)
			expect(result.detailsList[1]).toContain('AConsumer');
			expect(result.detailsList[1]).toContain('verification-results/2');
			expect(result.detailsList[2]).toContain('AConsumer');
			expect(result.detailsList[2]).toContain('verification-results/10');
			expect(result.detailsList[3]).toContain('ZConsumer');
			expect(result.detailsList[3]).toContain('verification-results/5');
		});
	});
});
