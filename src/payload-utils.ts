import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from "./constants";
import type { BasePactWebhookPayload, PactWebhookPayload, PactEventData, ProviderVerificationPublishedPayload, ContractRequiringVerificationPublishedPayload } from "./types";

export function getEventDataFromPayload(rawPayload: PactWebhookPayload): PactEventData {
	return {
		pacticipant: getPacticipant(rawPayload),
		pacticipantVersionNumber: getPacticipantVersionNumber(rawPayload),
		...rawPayload,
	} as PactEventData;
}

export function getPactVersionFromPayload(pub: ProviderVerificationPublishedPayload | ContractRequiringVerificationPublishedPayload) {
	// Pick source URL based on event type
	const sourceUrl = pub.eventType === PROVIDER_VERIFICATION_PUBLISHED
		? pub.verificationResultUrl
		: pub.pactUrl;

	// Extract the segment after /pact-version/ up to the next slash (if any)
	const match = /\/pact-version\/([^/]+)/.exec(sourceUrl);
	return match ? match[1] : undefined;
}

function getPacticipant(payload: BasePactWebhookPayload): string {
	switch (payload.eventType) {
		case PROVIDER_VERIFICATION_PUBLISHED:
			return payload.providerName;
		case CONTRACT_REQUIRING_VERIFICATION_PUBLISHED:
			return payload.consumerName;
	}
}

function getPacticipantVersionNumber(payload: BasePactWebhookPayload): string {
	switch (payload.eventType) {
		case PROVIDER_VERIFICATION_PUBLISHED:
			return payload.providerVersionNumber;
		case CONTRACT_REQUIRING_VERIFICATION_PUBLISHED:
			return payload.consumerVersionNumber;
	}
}

