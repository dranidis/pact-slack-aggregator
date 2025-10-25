export interface Env {
	SLACK_CHANNEL: string;
	SLACK_TOKEN: string;
	PACT_AGGREGATOR: DurableObjectNamespace<import('./pact-aggregator').PactAggregator>;
	DEBUG_KEY: string;
}

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
