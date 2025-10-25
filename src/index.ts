
import type { Env, WebhookPayload, PactEventData, StoredPactEvent } from './types';
export { PactAggregator } from './pact-aggregator';

// Emoji constants
const SUCCESS_EMOJI = "✅";
const FAILURE_EMOJI = "💥";

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Debug endpoint
		if (url.pathname === "/debug" && url.searchParams.get("key") === env.DEBUG_KEY) {
			const stub = getPactAggregatorStub(env);
			const response = await stub.fetch(new Request("http://fake-host/get-debug-info"));
			return response;
		}

		// Manual trigger endpoint
		if (url.pathname === "/trigger" && url.searchParams.get("key") === env.DEBUG_KEY) {
			console.log("🔄 Manual trigger requested");
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

			const stub = getPactAggregatorStub(env);
			await stub.fetch(new Request("http://fake-host/add-event", {
				method: "POST",
				body: JSON.stringify(eventData),
				headers: { "Content-Type": "application/json" }
			}));

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing error", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	},

	// Runs automatically (Cloudflare Cron). Schedule defined in wrangler.jsonc
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const now = Date.now();
		console.log("🕒 Scheduled summary check at " + formatTime(now));
		ctx.waitUntil(processAllBatches(env));
	},
};
// --- Helper functions ---

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
	const stub = getPactAggregatorStub(env);
	const response = await stub.fetch(new Request("http://fake-host/process-batches", {
		method: "POST"
	}));

	if (!response.ok) {
		console.error("Failed to process batches:", response.statusText);
		return;
	}

	const result = await response.json() as { processedEvents: StoredPactEvent[], eventCount: number };

	// Send to Slack if we have events
	if (result.processedEvents.length > 0) {
		await postSummaryToSlack(env, result.processedEvents);
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
			text: createSummaryText(pacticipant, verifications, publications),
			channel: slackChannel,
		});

		// Build single thread reply with all details
		await slackPost(env, {
			text: createThreadText(publications, verifications),
			channel: slackChannel,
			thread_ts: summaryResp.ts
		});
	}
}

function createSummaryText(pacticipant: string, verifications: StoredPactEvent[], publications: StoredPactEvent[]): string {
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
	const { branchLink, githubLink } = createGithubLinks(pacticipant, branch, commitHash);
	const summary = `*${pacticipant}* ${branchLink}${githubLink}\n${publicationSummary}${verificationSummary}`;
	return summary;
}

function createThreadText(publications: StoredPactEvent[], verifications: StoredPactEvent[]): string {
	let threadDetails = "";

	for (const e of publications) {
		const description = e.providerVersionDescriptions ? ` - ${e.providerVersionDescriptions}` : "";
		const providerVersionNumber = description !== "" ? e.providerVersionNumber : undefined;
		const providerVersionBranch = description !== "" ? e.providerVersionBranch : undefined;
		const { branchLink, githubLink } = createGithubLinks(e.provider, providerVersionBranch, providerVersionNumber);
		threadDetails += `Published <${e.pactUrl}|contract> to be verified from *${e.provider}* ${branchLink}${githubLink}${description}\n`;
	}

	for (const e of verifications) {
		const { branchLink, githubLink } = createGithubLinks(e.consumer, e.consumerVersionBranch, e.consumerVersionNumber);
		threadDetails += `*${e.consumer}* ${branchLink}${githubLink}: ${e.status === "success" ? SUCCESS_EMOJI : FAILURE_EMOJI} <${e.resultUrl}|Details>\n`;
	}
	return threadDetails;
}

async function slackPost(env: Env, body: Record<string, any>) {
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

function formatTime(timestamp: number) {
	const date = new Date(timestamp);
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	const ss = String(date.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}

function createCommitLink(repo: string, commitHash: string): string {
	return ` <https://github.com/yourorganization/${repo}/commit/${commitHash}|${commitHash.substring(0, 7)}>`;
}

function createBranchLink(repo: string, branch: string): string {
	return `<https://github.com/yourorganization/${repo}/tree/${branch}|${branch}>`;
}

function createGithubLinks(participant: string, branch?: string, commitHash?: string): { branchLink: string; githubLink: string } {
	const repo = mapPacticipantToRepo(participant);
	return {
		branchLink: branch ? createBranchLink(repo, branch) : "",
		githubLink: commitHash ? createCommitLink(repo, commitHash) : ""
	};
}

function getPactAggregatorStub(env: Env): DurableObjectStub {
	const id = env.PACT_AGGREGATOR.idFromName("pact-events");
	return env.PACT_AGGREGATOR.get(id);
}

function mapPacticipantToRepo(consumer: any) {
	switch (consumer) {
		case "Bo":
		case "BoUI":
			return "someback";
		case "LaravelBonusEngine":
			return "lbe";
		case "SomeAPI":
			return "someapi"
		case "FrontEnd":
			return "frontend"
		default:
			return consumer.toLowerCase();
	}
}

