import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from './constants';
// ...existing code...

export interface BasePactWebhookPayload {
	eventType: typeof PROVIDER_VERIFICATION_PUBLISHED | typeof CONTRACT_REQUIRING_VERIFICATION_PUBLISHED;
	providerName: string;
	consumerName: string;
	consumerVersionBranch: string;
	providerVersionBranch: string;
	consumerVersionNumber: string;
	providerVersionNumber: string;
}

export interface ProviderVerificationPublishedPayload extends BasePactWebhookPayload {
	eventType: typeof PROVIDER_VERIFICATION_PUBLISHED;
	githubVerificationStatus: string;
	verificationResultUrl: string;
}

export interface ContractRequiringVerificationPublishedPayload extends BasePactWebhookPayload {
	eventType: typeof CONTRACT_REQUIRING_VERIFICATION_PUBLISHED;
	pactUrl: string;
	providerVersionDescriptions?: string;
}

// Simple utility class with static methods - cleanest approach
// PayloadUtils moved to payload.ts

export type PactWebhookPayload = ProviderVerificationPublishedPayload | ContractRequiringVerificationPublishedPayload;

export interface ProviderVerificationEventData extends ProviderVerificationPublishedPayload {
	pacticipant: string;
	pacticipantVersionNumber: string;
}

export interface ContractRequiringVerificationEventData extends ContractRequiringVerificationPublishedPayload {
	pacticipant: string;
	pacticipantVersionNumber: string;
}

export type PactEventData = ProviderVerificationEventData | ContractRequiringVerificationEventData;

export interface StoredProviderVerificationEventData extends ProviderVerificationEventData {
	ts: number; // timestamp when event was received
}

export interface StoredContractRequiringVerificationEventData extends ContractRequiringVerificationEventData {
	ts: number; // timestamp when event was received
}

export type StoredPactEventData = StoredProviderVerificationEventData | StoredContractRequiringVerificationEventData;

export interface PublicationThreadInfo {
	ts: string; // root message timestamp
	createdTs: string; // creation timestamp
	updatedTs?: string; // latest update message timestamp
	channelId?: string; // Slack channel Id
	// Store the original webhook payload that created the root message so we can derive summary text later
	payload?: PactWebhookPayload;
	// Legacy field kept for backward compatibility (existing stored entries before refactor)
	summary?: string;
}

export interface DebugInfo {
	currentTime: string;
	lastEventTime: string;
	lastProcessTime: string;
	eventBuckets: Record<
		string,
		{
			count: number;
			events: StoredPactEventData[];
		}
	>;
	totalEvents: number;
	totalProcessedEvents: number;
	lastProcessedCount: number;
	timeSinceLastEvent: number | null;
	timeSinceLastProcess: number | null;
	slackChannel: string;
	githubBaseUrl: string;
	pacticipantToRepoMap: Record<string, string>;
	publicationThreads: Record<string, PublicationThreadInfo>;
}

export interface SlackPostMessageRequest {
	text: string;
	channel: string;
	thread_ts?: string; // optional for root messages or updates
}

// Slack update message request (chat.update)
export interface SlackUpdateMessageRequest {
	text: string;
	channel: string;
	ts: string; // timestamp of the message to update
}

export interface SlackPostMessageResponse {
	ok: boolean;
	ts?: string;
	channel?: string;
	error?: string;
	needed?: string;
	provided?: string;
	thread_ts?: string;
	text?: string;
}

// chat.delete request/response (similar shape, but no text field in request)
export interface SlackDeleteMessageRequest {
	channel: string;
	ts: string;
}

export interface SlackDeleteMessageResponse {
	ok: boolean;
	error?: string;
	needed?: string;
	provided?: string;
	channel?: string;
	ts?: string;
}
