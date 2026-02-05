import { PROVIDER_VERIFICATION_PUBLISHED, CONTRACT_REQUIRING_VERIFICATION_PUBLISHED } from './constants';
import type { BasePactWebhookPayload, PactWebhookPayload, PactEventData } from './types';

export function getEventDataFromPayload(rawPayload: PactWebhookPayload): PactEventData {
	return {
		pacticipant: getPacticipant(rawPayload),
		pacticipantVersionNumber: getPacticipantVersionNumber(rawPayload),
		...rawPayload,
	} as PactEventData;
}

export function getPactVersionFromPayload(pub: PactWebhookPayload) {
	// Pick source URL based on event type
	const sourceUrl = pub.eventType === PROVIDER_VERIFICATION_PUBLISHED ? pub.verificationResultUrl : pub.pactUrl;

	// Extract the segment after /pact-version/ up to the next slash (if any)
	const match = /\/pact-version\/([^/]+)/.exec(sourceUrl);
	return match ? match[1] : undefined;
}

/**
 * Returns the Slack channel name for the payload passed.
 * The name is built using the PROVIDER_CHANNEL_PREFIX environment variable and the provider name from the payload.
 *
 * e.g. if the prefix is '#pact-' and the provider name is 'UserService', the resulting channel name will be '#pact-UserService'.
 *
 * @param env
 * @param rawPayload
 * @returns
 */
export function getProviderSlackChannel(env: Env, rawPayload: PactWebhookPayload) {
	const basePrefix = env.PROVIDER_CHANNEL_PREFIX ?? '#pact-';
	const normalizedPrefix = basePrefix.startsWith('#') ? basePrefix : `#${basePrefix}`;
	const providerSlackChannel = `${normalizedPrefix}${rawPayload.providerName}`;
	return providerSlackChannel;
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
