
import { now, formatTime as timeUtilsFormatTime } from "./time-utils";
import type { WebhookPayload, PactEventData, StoredPactEvent, DebugInfo, SlackPost } from './types';
import { pascalCaseToDash } from "./utils";
export { PactAggregator } from './pact-aggregator';

// Emoji constants
const SUCCESS_EMOJI = "✅";
const FAILURE_EMOJI = "💥";

export default {
	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		// Debug endpoint
		if (url.pathname === "/debug" && url.searchParams.get("key") === env.DEBUG_KEY) {
			// Check if this is a clear request (for test isolation)
			if (url.searchParams.get("clear") === "true") {
				await getPactAggregatorStub(env).clearAll();
				return new Response("State cleared", { status: 200 });
			}

			const debugData: DebugInfo = await getPactAggregatorStub(env).getDebugInfo();
			return new Response(JSON.stringify(debugData, null, 2), {
				headers: { "Content-Type": "application/json" }
			});
		}

		// Manual trigger endpoint
		if (url.pathname === "/trigger" && url.searchParams.get("key") === env.DEBUG_KEY) {
			await processAllBatches(env);
			return new Response("Processing completed", { status: 200 });
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		// A POST request - process webhook from Pact
		try {
			const {
				eventType,
				providerName,
				consumerName,
				verificationResultUrl,
				pactUrl,
				githubVerificationStatus,
				consumerVersionBranch,
				providerVersionBranch,
				consumerVersionNumber,
				providerVersionNumber,
				providerVersionDescriptions,
			} = await request.json() as WebhookPayload;

			const pacticipant = getPacticipant(eventType, providerName, consumerName);

			const eventData: PactEventData = {
				pacticipant,
				eventType,
				provider: providerName,
				consumer: consumerName,
				status: githubVerificationStatus,
				resultUrl: verificationResultUrl,
				pactUrl,
				consumerVersionBranch,
				providerVersionBranch,
				consumerVersionNumber,
				providerVersionNumber,
				providerVersionDescriptions,
			};

			await getPactAggregatorStub(env).addEvent(eventData);

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing error", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	},

	// Runs automatically (Cloudflare Cron). Schedule defined in wrangler.jsonc
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const currentTime = now();
		console.log("🕒 Scheduled summary check at " + timeUtilsFormatTime(currentTime));
		ctx.waitUntil(processAllBatches(env));
	},
};

function getPacticipant(eventType: string, provider: string, consumer: string) {
	switch (eventType) {
		case "provider_verification_published":
			return provider;
		case "contract_content_changed":
		case "contract_requiring_verification_published":
			return consumer;
		default:
			throw new Error(`Unknown event type: ${eventType}`);
	}
}

async function processAllBatches(env: Env) {
	const processedEvents: StoredPactEvent[] = await getPactAggregatorStub(env).processBatches();

	if (processedEvents.length > 0) {
		await postSummaryToSlack(env, processedEvents);
	}
}

async function postSummaryToSlack(env: Env, events: StoredPactEvent[]) {
	const slackChannel = env.SLACK_CHANNEL || "#pact-broker";

	if (events.length === 0) return;

	// Group events by pacticipant
	const grouped = events.reduce((acc: Record<string, StoredPactEvent[]>, e: StoredPactEvent) => {
		acc[e.pacticipant] = acc[e.pacticipant] || [];
		acc[e.pacticipant].push(e);
		return acc;
	}, {});

	for (const [pacticipant, evts] of Object.entries(grouped)) {
		const verifications = evts.filter((e) =>
			e.eventType === "provider_verification_published");
		const publications = evts.filter((e) =>
			e.eventType === "contract_content_changed" || e.eventType === "contract_requiring_verification_published");

		const summaryResp = await slackPost(env, {
			text: createSummaryText(env, pacticipant, verifications, publications),
			channel: slackChannel,
		} as SlackPost);

		// Build single thread reply with all details
		await slackPost(env, {
			text: createThreadText(env, publications, verifications),
			channel: slackChannel,
			thread_ts: summaryResp.ts
		} as SlackPost);
	}
}

function createSummaryText(env: Env, pacticipant: string, verifications: StoredPactEvent[], publications: StoredPactEvent[]): string {
	const successCount = verifications.filter((e) => e.status === "success").length;
	const failedCount = verifications.length - successCount;

	const publicationSummary = publications.length === 0 ? "" : `Pact publications: ${publications.length} `;
	const okString = successCount === 0 ? "" : `${SUCCESS_EMOJI}${successCount} `;
	const failString = failedCount === 0 ? "" : `${FAILURE_EMOJI}${failedCount}`;
	const verificationSummary = verifications.length === 0 ? "" : `Pact verifications: ${okString}${failString}`;

	const branch = verifications.length !== 0
		? verifications[0].providerVersionBranch
		: publications[0]?.consumerVersionBranch;
	const commitHash = verifications.length !== 0
		? verifications[0].providerVersionNumber
		: publications[0]?.consumerVersionNumber;
	const { branchLink, githubLink } = createGithubLinks(env, pacticipant, branch, commitHash);
	const summary = `*${pacticipant}* ${branchLink}${githubLink}\n${publicationSummary}${verificationSummary}`;
	return summary;
}

function createThreadText(env: Env, publications: StoredPactEvent[], verifications: StoredPactEvent[]): string {
	let threadDetails = "";

	for (const e of publications) {
		const description = e.providerVersionDescriptions ? ` - ${e.providerVersionDescriptions}` : "";
		// provider version info only relevant if descriptions exist since these are
		// separate events for each version
		const providerVersionNumber = e.providerVersionDescriptions ? e.providerVersionNumber : undefined;
		const providerVersionBranch = e.providerVersionDescriptions ? e.providerVersionBranch : undefined;
		const { branchLink, githubLink } = createGithubLinks(env, e.provider, providerVersionBranch, providerVersionNumber);
		threadDetails += `Published <${e.pactUrl}|contract> to be verified from provider *${e.provider}* ${branchLink}${githubLink}${description}\n`;
	}

	if (verifications.length > 0) {
		threadDetails += "Verified consumers:\n";
		verifications.sort((a, b) => a.consumer.localeCompare(b.consumer));
	}

	for (const e of verifications) {
		const { branchLink, githubLink } = createGithubLinks(env, e.consumer, e.consumerVersionBranch, e.consumerVersionNumber);
		threadDetails += `- ${e.status === "success" ? SUCCESS_EMOJI : FAILURE_EMOJI} <${e.resultUrl}|Details> *${e.consumer}* ${branchLink}${githubLink}\n`;
	}
	return threadDetails;
}

async function slackPost(env: Env, body: SlackPost) {
	const res = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.SLACK_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json = await res.json() as any;
	if (!json.ok) {
		console.error("❌ Slack API Error:", {
			error: json.error,
			needed: json.needed,
			provided: json.provided,
			channel: body.channel,
			hasThreadTs: !!body.thread_ts,
			messageLength: body.text?.length
		});
	} else {
		console.log("✅ Slack message sent successfully", { ts: json.ts, channel: body.channel });
	}
	return json;
}

function createCommitLink(env: Env, repo: string, commitHash: string): string {
	return ` <${env.GITHUB_BASE_URL}/${repo}/commit/${commitHash}|${commitHash.substring(0, 7)}>`;
}

function createBranchLink(env: Env, repo: string, branch: string): string {
	return `<${env.GITHUB_BASE_URL}/${repo}/tree/${branch}|${branch}>`;
}

function createGithubLinks(env: Env, participant: string, branch?: string, commitHash?: string): { branchLink: string; githubLink: string } {
	const repo = mapPacticipantToRepo(env, participant);
	return {
		branchLink: branch ? createBranchLink(env, repo, branch) : "",
		githubLink: commitHash ? createCommitLink(env, repo, commitHash) : ""
	};
}

function getPactAggregatorStub(env: Env) {
	// console.log("Using PACT_AGGREGATOR_NAME:", env.PACT_AGGREGATOR_NAME);
	const objectName = env.PACT_AGGREGATOR_NAME || "pact-events";
	const stub = env.PACT_AGGREGATOR.getByName(objectName);
	return stub;
}

function mapPacticipantToRepo(env: Env, pacticipant: string) {
	const mapped = env.PACTICIPANT_TO_REPO_MAP ? JSON.parse(env.PACTICIPANT_TO_REPO_MAP) as Record<string, string> : {};
	if (mapped[pacticipant]) {
		return mapped[pacticipant];
	}
	return pascalCaseToDash(pacticipant);
}

