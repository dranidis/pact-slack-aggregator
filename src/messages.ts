import type { StoredPactEventData, StoredContractRequiringVerificationEventData, StoredProviderVerificationEventData, ProviderVerificationPublishedPayload, ContractRequiringVerificationPublishedPayload } from './types';
import {
	PROVIDER_VERIFICATION_PUBLISHED,
	CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
} from "./constants";
import { getVerificationId, extractPactUrlFromVerificationUrl, pascalCaseToDash } from "./utils";

// Minimal environment interface for message creation
export interface MessageEnv {
	GITHUB_BASE_URL: string;
	PACTICIPANT_TO_REPO_MAP: Record<string, string>;
	SUCCESS_EMOJI: string;
	FAILURE_EMOJI: string;
}

export function getPublicationSummaryForPayload(e: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload, env: MessageEnv): string {
	// provider version info only relevant if descriptions exist since these are
	// separate events for each version
	const consumerVersionNumber = e.consumerVersionNumber;
	const consumerVersionBranch = e.consumerVersionBranch;
	const { branchLink, githubLink } = createGithubLinks(env, e.consumerName, consumerVersionBranch, consumerVersionNumber);
	const { pactUrl, diffUrl } = createPactAndPactDiffUrl(e);
	const text = e.eventType === CONTRACT_REQUIRING_VERIFICATION_PUBLISHED
		? "First published at"
		: "(Unknown first publication) Found at";
	return `<${pactUrl}|Contract> by consumer *${e.consumerName}*. ${text} ${branchLink}${githubLink}. <${diffUrl}|Diff> with previous distinct version of this pact.`;
}

export function createSummaryAndDetailsMessages(
	messageEnv: MessageEnv,
	pacticipant: string,
	pacticipantVersionNumber: string,
	pacticipantEvents: (StoredProviderVerificationEventData | StoredContractRequiringVerificationEventData)[]
): { summaryText: string; detailsList: string[] } {
	const verifications = pacticipantEvents.filter((e) =>
		e.eventType === PROVIDER_VERIFICATION_PUBLISHED);
	const publications = pacticipantEvents.filter((e) =>
		e.eventType === CONTRACT_REQUIRING_VERIFICATION_PUBLISHED);
	const summaryText = createSummaryText(messageEnv, pacticipant, pacticipantVersionNumber, verifications, publications);
	const threadText = createThreadText(messageEnv, verifications, publications);

	return { summaryText, detailsList: threadText };
}

function createSummaryText(messageEnv: MessageEnv, pacticipant: string, pacticipantVersionNumber: string, verifications: StoredPactEventData[], publications: StoredPactEventData[]): string {
	const verificationEvents = verifications.filter((e) => e.eventType === PROVIDER_VERIFICATION_PUBLISHED);
	const successCount = verificationEvents.filter((e) => e.githubVerificationStatus === "success").length;
	const failedCount = verificationEvents.length - successCount;

	const publicationSummary = publications.length === 0 ? "" : `Pact publications: ${publications.length} `;
	const okString = successCount === 0 ? "" : `${messageEnv.SUCCESS_EMOJI}${successCount} `;
	const failString = failedCount === 0 ? "" : `${messageEnv.FAILURE_EMOJI}${failedCount}`;
	const verificationSummary = verifications.length === 0 ? "" : `Pact verifications: ${okString}${failString}`;

	const branch = verifications.length !== 0
		? verifications[0].providerVersionBranch
		: publications[0]?.consumerVersionBranch;
	const { branchLink, githubLink } = createGithubLinks(messageEnv, pacticipant, branch, pacticipantVersionNumber);
	const summary = `*${pacticipant}* ${branchLink}${githubLink}\n${publicationSummary}${verificationSummary}`;
	return summary;
}

function createThreadText(messageEnv: MessageEnv, verifications: StoredPactEventData[], publications: StoredPactEventData[]): string[] {
	const threadDetails: string[] = [];

	const contractPublications = publications.filter((e) => e.eventType === CONTRACT_REQUIRING_VERIFICATION_PUBLISHED);
	for (const e of contractPublications) {
		threadDetails.push(createPublicationSummaryText(e as ContractRequiringVerificationPublishedPayload, messageEnv));
	}

	const verificationEvents = verifications.filter((e) => e.eventType === PROVIDER_VERIFICATION_PUBLISHED);
	if (verificationEvents.length > 0) {
		threadDetails.push("Verified consumers:");
		// Sort by consumer name first, then by verification ID (last number in resultUrl)
		verificationEvents.sort((a, b) =>
			a.consumerName.localeCompare(b.consumerName) ||
			getVerificationId(a.verificationResultUrl) - getVerificationId(b.verificationResultUrl)
		);
	}

	for (const e of verificationEvents) {
		threadDetails.push(createVerificationThreadDetails(e, messageEnv));
	}
	return threadDetails;
}

function createVerificationThreadDetails(e: ProviderVerificationPublishedPayload, messageEnv: MessageEnv) {
	const { branchLink, githubLink } = createGithubLinks(messageEnv, e.consumerName, e.consumerVersionBranch, e.consumerVersionNumber);
	const pactUrl = extractPactUrlFromVerificationUrl(e.verificationResultUrl);
	const pactLink = ` | <${pactUrl}|Pact>`;
	return `- ${getEmoji(messageEnv, e.githubVerificationStatus)} <${e.verificationResultUrl}|Results>${pactLink} *${e.consumerName}* ${branchLink}${githubLink}`;
}

function createPublicationSummaryText(e: ContractRequiringVerificationPublishedPayload, messageEnv: MessageEnv) {
	const description = e.providerVersionDescriptions ? ` - ${e.providerVersionDescriptions}` : "";
	// provider version info only relevant if descriptions exist since these are
	// separate events for each version
	const providerVersionNumber = e.providerVersionDescriptions ? e.providerVersionNumber : undefined;
	const providerVersionBranch = e.providerVersionDescriptions ? e.providerVersionBranch : undefined;
	const { branchLink, githubLink } = createGithubLinks(messageEnv, e.providerName, providerVersionBranch, providerVersionNumber);
	const pactBrokerURL = // get the base URL from e.pactUrl
		e.pactUrl.split('/pacts/')[0];
	const diffUrl = `${pactBrokerURL}/pacts/provider/${e.providerName}/consumer/${e.consumerName}/version/${e.consumerVersionNumber}/diff/previous-distinct`;
	return `Published <${e.pactUrl}|contract> to be verified from provider *${e.providerName}* ${branchLink}${githubLink}${description}. <${diffUrl}|Diff> with previous distinct version of this pact.`;
}

export function createVerificationThreadDetailsForProviderChannel(e: ProviderVerificationPublishedPayload, messageEnv: MessageEnv) {
	const { branchLink, githubLink } = createGithubLinks(messageEnv, e.providerName, e.providerVersionBranch, e.providerVersionNumber);
	const { branchLink: consumerBranchLink, githubLink: consumerGithubLink } = createGithubLinks(messageEnv, e.consumerName, e.consumerVersionBranch, e.consumerVersionNumber);
	return `- ${getEmoji(messageEnv, e.githubVerificationStatus)} <${e.verificationResultUrl}|Results> *${e.providerName}* ${branchLink}${githubLink}\nVerified ${e.consumerName} ${consumerBranchLink}${consumerGithubLink}`;
}

function getEmoji(messageEnv: MessageEnv, status: string): string {
	return status === 'success' ? messageEnv.SUCCESS_EMOJI : messageEnv.FAILURE_EMOJI;
}

function createPactAndPactDiffUrl(e: ContractRequiringVerificationPublishedPayload | ProviderVerificationPublishedPayload) {

	const pactBrokerURL = // get the base URL from e.pactUrl
		e.eventType === PROVIDER_VERIFICATION_PUBLISHED
			? e.verificationResultUrl.split('/pacts/')[0]
			: e.pactUrl.split('/pacts/')[0];
	const pactUrl = e.eventType === PROVIDER_VERIFICATION_PUBLISHED
		? `${pactBrokerURL}/pacts/provider/${e.providerName}/consumer/${e.consumerName}/version/${e.consumerVersionNumber}`
		: e.pactUrl;
	const diffUrl = `${pactBrokerURL}/pacts/provider/${e.providerName}/consumer/${e.consumerName}/version/${e.consumerVersionNumber}/diff/previous-distinct`;
	return { pactUrl, diffUrl };
}

// Append verification status line to an existing publication summary message for provider channel
export function appendVerificationStatusToProviderPublicationSummary(originalSummary: string, ver: ProviderVerificationPublishedPayload, messageEnv: MessageEnv) {
	const statusEmoji = getEmoji(messageEnv, ver.githubVerificationStatus);
	const { branchLink, githubLink } = createGithubLinks(messageEnv, ver.providerName, ver.providerVersionBranch, ver.providerVersionNumber);

	// Keep original summary; add a blank line to separate if not already ending with newline
	const prefix = originalSummary.endsWith('\n') ? '' : '\n';
	return `${originalSummary}${prefix}Last verification on (${ver.providerName}) *${branchLink}*${githubLink}: ${statusEmoji} <${ver.verificationResultUrl}|Results>`;
}

function createCommitLink(messageEnv: MessageEnv, repo: string, commitHash: string): string {
	return ` <${messageEnv.GITHUB_BASE_URL}/${repo}/commit/${commitHash}|${commitHash.substring(0, 7)}>`;
}

function createBranchLink(messageEnv: MessageEnv, repo: string, branch: string): string {
	return `<${messageEnv.GITHUB_BASE_URL}/${repo}/tree/${branch}|${branch}>`;
}

function createGithubLinks(messageEnv: MessageEnv, participant: string, branch?: string, commitHash?: string): { branchLink: string; githubLink: string } {
	const repo = mapPacticipantToRepo(messageEnv, participant);
	return {
		branchLink: branch ? createBranchLink(messageEnv, repo, branch) : "",
		githubLink: commitHash ? createCommitLink(messageEnv, repo, commitHash) : ""
	};
}

function mapPacticipantToRepo(messageEnv: MessageEnv, pacticipant: string) {
	const mapped = messageEnv.PACTICIPANT_TO_REPO_MAP;
	if (mapped[pacticipant]) {
		return mapped[pacticipant];
	}
	return pascalCaseToDash(pacticipant);
}

