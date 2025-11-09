import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from "./constants";
import type { BasePactWebhookPayload, PactWebhookPayload, PactEventData } from "./types";

export function getEventDataFromPayload(rawPayload: PactWebhookPayload): PactEventData {
	return {
		pacticipant: getPacticipant(rawPayload),
		pacticipantVersionNumber: getPacticipantVersionNumber(rawPayload),
		...rawPayload,
	} as PactEventData;
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

