export interface Env {
	SLACK_TOKEN: string;
	PACT_CACHE: KVNamespace;
	DEBUG_KEY: string;
}

const slackChannel = "#pact-verifications";

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

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		await env.PACT_CACHE.put("lastEventTime", Date.now().toString());

		try {
			const payload = await request.json();

			const {
				eventType,
				providerName,
				consumerName,
				verificationResultUrl,
				pactUrl,
				githubVerificationStatus,
				consumerVersionBranch,
				providerVersionBranch,
			} = payload;

			const pacticipant = getPacticipant(eventType, providerName, consumerName);

			// Bucket by current minute
			const minuteBucket = Math.floor(Date.now() / 60000);
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
				ts: Date.now(),
			});

			await env.PACT_CACHE.put(cacheKey, JSON.stringify(events), { expirationTtl: 600 });

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing error", err);
			return new Response("OK", { status: 200 });
		}
	},

	// Runs automatically every minute (Cloudflare Cron)
	async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		const lastEventTimeStr = await env.PACT_CACHE.get("lastEventTime");
		const lastEventTime = lastEventTimeStr ? parseInt(lastEventTimeStr) : 0;
		const quietPeriodMs = 60_000; // 60 seconds
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
			return consumer;
		default:
			return "unknown";
	}
}

// async function processAllBatches(env: Env) {
// 	const list = await env.PACT_CACHE.list({ prefix: "pactEvents:" });
// 	if (list.keys.length === 0) return;

// 	let allEvents: any[] = [];
// 	for (const key of list.keys) {
// 		const eventsRaw = await env.PACT_CACHE.get(key.name);
// 		if (!eventsRaw) continue;
// 		const events = JSON.parse(eventsRaw);
// 		allEvents = allEvents.concat(events);
// 		await env.PACT_CACHE.delete(key.name);
// 	}

// 	await postSummaryToSlack(env, allEvents);
// }

async function processAllBatches(env: Env) {
	const nowMinute = Math.floor(Date.now() / 60_000);
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
		const publications = evts.filter((e) => e.eventType === "contract_content_changed");

		const branch =
			verifications.length !== 0
				? verifications[0].providerVersionBranch
				: publications[0]?.consumerVersionBranch;

		const ok = verifications.filter((e) => e.status === "success").length;
		const fail = verifications.filter((e) => e.status !== "success").length;

		const publicationSummary =
			publications.length === 0 ? "" : `Pact publications: ${publications.length}`;
		const okString = ok === 0 ? "" : `✅ ${ok}`;
		const failString = fail === 0 ? "" : `❌ ${fail}`;
		const verificationSummary =
			verifications.length === 0 ? "" : " Pact verifications: " + okString + failString;

		const summary = `*${pacticipant}* ${branch}\n${publicationSummary}${verificationSummary}`;

		const summaryResp = await slackPost(env, {
			text: summary,
			channel: slackChannel,
		});

		const summaryTs = summaryResp.ts;

		// Post thread details
		for (const e of publications) {
			const detail = `Published contract: <${e.pactUrl}|contract-details> for *${e.provider}* ${e.providerVersionBranch || ""
				}`;
			await slackPost(env, { text: detail, channel: slackChannel, thread_ts: summaryTs });
		}

		for (const e of verifications) {
			const detail = `*${e.consumer}* ${e.consumerVersionBranch || ""}: ${e.status === "success" ? "✅" : "❌"
				} <${e.resultUrl}|Details>`;
			await slackPost(env, { text: detail, channel: slackChannel, thread_ts: summaryTs });
			await new Promise((r) => setTimeout(r, 100));
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
	const json = await res.json();
	if (!json.ok) console.error("Slack error", json);
	return json;
}

function formatTime(timestamp: number) {
	const date = new Date(timestamp);
	const hh = String(date.getHours()).padStart(2, '0');
	const mm = String(date.getMinutes()).padStart(2, '0');
	const ss = String(date.getSeconds()).padStart(2, '0');
	return `${hh}:${mm}:${ss}`;
}
