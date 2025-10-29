export interface WebhookPayload {
	eventType: string;
	providerName: string;
	consumerName: string;
	verificationResultUrl?: string;
	pactUrl?: string;
	githubVerificationStatus?: string;
	consumerVersionBranch?: string;
	providerVersionBranch?: string;
	consumerVersionNumber?: string;
	providerVersionNumber?: string;
	providerVersionDescriptions?: string;
}

export interface PactEventData {
	pacticipant: string;
	pacticipantVersionNumber: string;
	eventType: string;
	provider: string;
	consumer: string;
	status?: string;
	resultUrl?: string;
	pactUrl?: string;
	consumerVersionBranch?: string;
	providerVersionBranch?: string;
	consumerVersionNumber?: string;
	providerVersionNumber?: string;
	providerVersionDescriptions?: string;
}

export interface StoredPactEvent extends PactEventData {
	ts: number; // timestamp when event was received
}

export interface DebugInfo {
	currentTime: number;
	lastEventTime: number;
	lastProcessTime: number;
	eventBuckets: Record<string, {
		count: number;
		events: StoredPactEvent[];
	}>;
	totalEvents: number;
	totalProcessedEvents: number;
	lastProcessedCount: number;
	timeSinceLastEvent: number | null;
	timeSinceLastProcess: number | null;
}

export interface SlackPostMessageRequest {
	text: string;
	channel: string;
	thread_ts: string;
}

export interface SlackPostMessageResponse {
	ok: boolean;
	ts?: string;
	error?: string;
	needed?: string;
	provided?: string;
}
