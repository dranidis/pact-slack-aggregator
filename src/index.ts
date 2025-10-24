export interface Env {
	SLACK_TOKEN: string;
	PACT_CACHE: KVNamespace;
	DEBUG_KEY: string;
}

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
			const list = await env.PACT_CACHE.list({ prefix: "pactEvents:" });
			const data: Record<string, any> = {};
			for (const key of list.keys) {
				data[key.name] = await env.PACT_CACHE.get(key.name);
			}
			return new Response(JSON.stringify(data, null, 2), {
				headers: { "Content-Type": "application/json" },
			});
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
		await env.PACT_CACHE.put("lastEventTime", Date.now().toString());

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

			// Bucket by current minute
			const minuteBucket = Math.floor(Date.now() / MINUTE_BUCKET_MS);
			const cacheKey = `pactEvents:${minuteBucket}`;

			const eventsRaw = await env.PACT_CACHE.get(cacheKey);
			const events = eventsRaw ? JSON.parse(eventsRaw) : [];

			events.push({
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
				ts: Date.now(),
			});

			await env.PACT_CACHE.put(cacheKey, JSON.stringify(events), { expirationTtl: CACHE_TTL_SECONDS });

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing error", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	},

	// Runs automatically every minute (Cloudflare Cron)
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const lastEventTimeStr = await env.PACT_CACHE.get("lastEventTime");
		const lastEventTime = lastEventTimeStr ? parseInt(lastEventTimeStr) : 0;
		const quietPeriodMs = QUIET_PERIOD_MS;
		const now = Date.now();

		console.log("🕒 Scheduled summary check at " + formatTime(now));
		console.log(" Last event time: " + formatTime(lastEventTime));
		if (lastEventTime && now - lastEventTime < quietPeriodMs) {
			console.log(` Skipping summary — events still incoming: ${(now - lastEventTime) / 1000}s since last event`);
			return new Response("Skipped (still receiving events)", { status: 200 });
		}

		console.log("🕒 Quiet period passed — posting summary to Slack");
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
	const nowMinute = Math.floor(Date.now() / MINUTE_BUCKET_MS);
	const list = await env.PACT_CACHE.list({ prefix: "pactEvents:" });
	if (list.keys.length === 0) return;

	let allEvents: any[] = [];
	for (const key of list.keys) {
		const bucketMinute = parseInt(key.name.split(":")[1]);
		if (bucketMinute === nowMinute) continue; // skip current active bucket

		const eventsRaw = await env.PACT_CACHE.get(key.name);
		if (!eventsRaw) continue;

		const events = JSON.parse(eventsRaw);
		allEvents = allEvents.concat(events);

		await env.PACT_CACHE.delete(key.name);
	}

	await postSummaryToSlack(env, allEvents);
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

