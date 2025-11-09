import type { StoredPactEventData, StoredContractRequiringVerificationEventData, StoredProviderVerificationEventData } from './types';
import {
	PROVIDER_VERIFICATION_PUBLISHED,
	CONTRACT_REQUIRING_VERIFICATION_PUBLISHED,
	SUCCESS_EMOJI,
	FAILURE_EMOJI
} from "./constants";
import { getVerificationId, extractPactUrlFromVerificationUrl, pascalCaseToDash } from "./utils";

// Minimal environment interface for message creation
export interface MessageEnv {
	GITHUB_BASE_URL: string;
	PACTICIPANT_TO_REPO_MAP: string;
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
	const okString = successCount === 0 ? "" : `${SUCCESS_EMOJI}${successCount} `;
	const failString = failedCount === 0 ? "" : `${FAILURE_EMOJI}${failedCount}`;
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
		const description = e.providerVersionDescriptions ? ` - ${e.providerVersionDescriptions}` : "";
		// provider version info only relevant if descriptions exist since these are
		// separate events for each version
		const providerVersionNumber = e.providerVersionDescriptions ? e.providerVersionNumber : undefined;
		const providerVersionBranch = e.providerVersionDescriptions ? e.providerVersionBranch : undefined;
		const { branchLink, githubLink } = createGithubLinks(messageEnv, e.providerName, providerVersionBranch, providerVersionNumber);
		threadDetails.push(`Published <${e.pactUrl}|contract> to be verified from provider *${e.providerName}* ${branchLink}${githubLink}${description}`);
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
		const { branchLink, githubLink } = createGithubLinks(messageEnv, e.consumerName, e.consumerVersionBranch, e.consumerVersionNumber);
		const pactUrl = extractPactUrlFromVerificationUrl(e.verificationResultUrl);
		const pactLink = ` | <${pactUrl}|Pact>`;
		threadDetails.push(`- ${e.githubVerificationStatus === "success" ? SUCCESS_EMOJI : FAILURE_EMOJI} <${e.verificationResultUrl}|Results>${pactLink} *${e.consumerName}* ${branchLink}${githubLink}`);
	}
	return threadDetails;
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
	const mapped = JSON.parse(messageEnv.PACTICIPANT_TO_REPO_MAP) as Record<string, string>;
	if (mapped[pacticipant]) {
		return mapped[pacticipant];
	}
	return pascalCaseToDash(pacticipant);
}

