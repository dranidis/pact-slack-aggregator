export interface Env {
	SLACK_TOKEN: string;
	PACT_AGGREGATOR: DurableObjectNamespace;
	DEBUG_KEY: string;
}

export { PactAggregator } from './pact-aggregator';

interface WebhookPayload {
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

// const slackChannel = "#pact-verifications";
const slackChannel = "#ci";

// Configuration constants
const CACHE_TTL_SECONDS = 600; // 10 minutes
const QUIET_PERIOD_MS = 60_000; // 60 seconds
const MINUTE_BUCKET_MS = 60000; // 1 minute for event bucketing

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext) {
		const url = new URL(request.url);

		// Debug endpoint
		if (url.pathname === "/debug" && url.searchParams.get("key") === env.DEBUG_KEY) {
			const id = env.PACT_AGGREGATOR.idFromName("pact-events");
			const stub = env.PACT_AGGREGATOR.get(id);
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
			const payload = await request.json() as WebhookPayload;

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
			} = payload;

			const pacticipant = getPacticipant(eventType, providerName, consumerName);

			// Send event to Durable Object
			const id = env.PACT_AGGREGATOR.idFromName("pact-events");
			const stub = env.PACT_AGGREGATOR.get(id);

			const eventData = {
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

	// Runs automatically every 2 minutes (Cloudflare Cron)
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const now = Date.now();
		console.log("🕒 Scheduled summary check at " + formatTime(now));

		// Simply process batches - the Durable Object will handle timing logic
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
			return "unknown";
	}
}

async function processAllBatches(env: Env) {
	// Get Durable Object instance
	const id = env.PACT_AGGREGATOR.idFromName("pact-events");
	const stub = env.PACT_AGGREGATOR.get(id);

	// Process batches through Durable Object
	const response = await stub.fetch(new Request("http://fake-host/process-batches", {
		method: "POST"
	}));

	if (!response.ok) {
		console.error("Failed to process batches:", response.statusText);
		return;
	}

	const result = await response.json() as { processedEvents: any[], eventCount: number };
	console.log(`Processing ${result.eventCount} events`);

	// Send to Slack if we have events
	if (result.processedEvents.length > 0) {
		await postSummaryToSlack(env, result.processedEvents);
	}
}

async function postSummaryToSlack(env: Env, events: any[]) {
	if (events.length === 0) return;

	// Group events by pacticipant
	const grouped = events.reduce((acc: Record<string, any[]>, e: any) => {
		acc[e.pacticipant] = acc[e.pacticipant] || [];
		acc[e.pacticipant].push(e);
		return acc;
	}, {});

	for (const [pacticipant, evts] of Object.entries(grouped)) {
		const verifications = evts.filter((e) => e.eventType === "provider_verification_published");
		const publications = evts.filter((e) =>
			e.eventType === "contract_content_changed" || e.eventType === "contract_requiring_verification_published");

		const branch =
			verifications.length !== 0
				? verifications[0].providerVersionBranch
				: publications[0]?.consumerVersionBranch;

		const commitHash =
			verifications.length !== 0
				? verifications[0].providerVersionNumber
				: publications[0]?.consumerVersionNumber;

		const ok = verifications.filter((e) => e.status === "success").length;
		const fail = verifications.filter((e) => e.status !== "success").length;

		const publicationSummary =
			publications.length === 0 ? "" : `Pact publications: ${publications.length} `;
		const okString = ok === 0 ? "" : `🟢${ok} `;
		const failString = fail === 0 ? "" : `🔴${fail}`;
		const verificationSummary =
			verifications.length === 0 ? "" : `Pact verifications: ${okString}${failString}`;

		// Add GitHub link if commit hash exists
		const githubLink = commitHash ? ` <https://github.com/yourorganization/${mapPacticipantToRepo(pacticipant)}/commit/${commitHash}|${commitHash.substring(0, 7)}>` : "";
		// Make branch name clickable
		const branchLink = branch ? `<https://github.com/yourorganization/${mapPacticipantToRepo(pacticipant)}/tree/${branch}|${branch}>` : "";
		const summary = `*${pacticipant}* ${branchLink}${githubLink}\n${publicationSummary}${verificationSummary}`;

		const summaryResp = await slackPost(env, {
			text: summary,
			channel: slackChannel,
		});

		const summaryTs = summaryResp.ts;

		// Build single thread reply with all details
		let threadDetails = "";

		for (const e of publications) {
			const description = e.providerVersionDescriptions ? ` - ${e.providerVersionDescriptions}` : "";
			const providerVersionNumber = description !== "" ? e.providerVersionNumber : undefined;
			const providerVersionBranch = description !== "" ? e.providerVersionBranch : undefined;
			const providerGithubLink = providerVersionNumber ? ` <https://github.com/yourorganization/${mapPacticipantToRepo(e.provider)}/commit/${providerVersionNumber}|${providerVersionNumber.substring(0, 7)}>` : "";
			const providerBranchLink = providerVersionBranch ? `<https://github.com/yourorganization/${mapPacticipantToRepo(e.provider)}/tree/${providerVersionBranch}|${providerVersionBranch}>` : "";
			threadDetails += `Published <${e.pactUrl}|contract> to be verified from *${e.provider}* ${providerBranchLink}${providerGithubLink}${description}\n`;
		}

		for (const e of verifications) {
			const consumerVersionNumber = e.consumerVersionNumber;
			const repo = mapPacticipantToRepo(e.consumer);
			const githubCommitLink = consumerVersionNumber ? ` <https://github.com/yourorganization/${repo}/commit/${consumerVersionNumber}|${consumerVersionNumber.substring(0, 7)}>` : "";
			const consumerBranchLink = e.consumerVersionBranch ? `<https://github.com/yourorganization/${repo}/tree/${e.consumerVersionBranch}|${e.consumerVersionBranch}>` : "";
			threadDetails += `*${e.consumer}* ${consumerBranchLink}${githubCommitLink}: ${e.status === "success" ? "🟢" : "🔴"} <${e.resultUrl}|Details>\n`;
		}

		// Send single thread reply if there are any details
		if (threadDetails.trim()) {
			await slackPost(env, { text: threadDetails.trim(), channel: slackChannel, thread_ts: summaryTs });
		}
	}
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

