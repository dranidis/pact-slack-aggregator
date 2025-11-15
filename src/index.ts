import { now } from "./time-utils";
import type {
	PactWebhookPayload,
	PactEventData,
	StoredPactEventData,
	DebugInfo,
} from './types';
import { getEventDataFromPayload } from './payload-utils';
import { createPublicationSummaryTextForProviderChannel, createSummaryAndDetailsMessages, createVerificationThreadDetailsForProviderChannel } from "./messages";
import { postPacticipantEventsToSlack, slackPost } from "./slack";
export { PactAggregator } from './pact-aggregator';

export default {

	async fetch(request: Request, env: Env) {
		const url = new URL(request.url);

		// Debug endpoint
		if (url.pathname === "/debug" && url.searchParams.get("key") === env.DEBUG_KEY) {
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
			console.log(`Should process? ${shouldProcessAtCurrentTime(env)}`);
			await processEventsForPublication(env);
			return new Response("Processing completed", { status: 200 });
		}

		if (request.method !== "POST") {
			return new Response("Method Not Allowed", { status: 405 });
		}

		// Check DEBUG_KEY for POST requests
		const debugKey = url.searchParams.get("key");
		if (debugKey !== env.DEBUG_KEY) {
			return new Response("Unauthorized", { status: 401 });
		}

		// A POST request - process webhook from Pact
		try {
			const rawPayload: PactWebhookPayload = await request.json();
			const eventData: PactEventData = getEventDataFromPayload(rawPayload);

			await getPactAggregatorStub(env).addEvent(eventData);

			// Also send to provider-specific channel
			await postToProvidersChannel(rawPayload, env);

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing error", err);
			return new Response("Internal Server Error", { status: 500 });
		}
	},

	// Runs automatically (Cloudflare Cron). Schedule defined in wrangler.jsonc
	scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		if (shouldProcessAtCurrentTime(env)) {
			ctx.waitUntil(processEventsForPublication(env));
		}
	},
};

async function postToProvidersChannel(rawPayload: PactWebhookPayload, env: Env) {
	const providerChannel = `#ci-${rawPayload.providerName}`;

	if (rawPayload.eventType === "contract_requiring_verification_published") {
		const pub = rawPayload;
		const summaryText = createPublicationSummaryTextForProviderChannel(pub, env);

		// Post to Slack and get thread timestamp
		const summaryResp = await slackPost({
			SLACK_CHANNEL: providerChannel,
			SLACK_TOKEN: env.SLACK_TOKEN
		}, summaryText);

		// Store thread timestamp in Durable Object
		await getPactAggregatorStub(env).setPublicationThreadTs(pub, providerChannel, summaryResp.ts!);
	}

	// If this is a verification result, post in the thread
	if (rawPayload.eventType === "provider_verification_published") {
		const ver = rawPayload;
		const threadTs = await getPactAggregatorStub(env).getPublicationThreadTs(ver, providerChannel);
		console.log(`Posting verification result to channel ${providerChannel} in thread ${threadTs}`);
		if (threadTs) {
			const verificationThreadDetail = createVerificationThreadDetailsForProviderChannel(ver, env);
			await slackPost({
				SLACK_CHANNEL: providerChannel,
				SLACK_TOKEN: env.SLACK_TOKEN
			}, verificationThreadDetail, threadTs);
		}
	}
}

function shouldProcessAtCurrentTime(env: Env): boolean {
	const currentTime = now();
	// Convert UTC time to target timezone (configurable via environment variable)
	const timezone = env.TIMEZONE ?? 'UTC';
	const date = new Date(currentTime);

	// Get timezone-adjusted time
	const localTime = new Date(date.toLocaleString("en-US", { timeZone: timezone }));
	const dayOfWeek = localTime.getDay(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
	const hour = localTime.getHours(); // 0-23
	const minute = localTime.getMinutes(); // 0-59

	const isWeekday = dayOfWeek >= 1 && dayOfWeek <= 5; // Monday to Friday
	const isWorkingHours = hour >= 8 && hour < 21; // 8 AM to 9 PM

	if (isWeekday && isWorkingHours) {
		return true; // Cron runs every 2 minutes, so always process
	} else if (isWeekday && !isWorkingHours) {
		// Off hours on weekdays: every hour (at minute 0)
		return minute === 0;
	} else {
		// Weekends (non-working days): every 4 hours (at 00:00, 04:00, 08:00, 12:00, 16:00)
		return minute === 0 && hour % 4 === 0;
	}
}

async function processEventsForPublication(env: Env) {
	const eventsToPublish: StoredPactEventData[] = await getPactAggregatorStub(env).getEventsToPublish();
	await postMessagesForEventsToSlack(env, eventsToPublish);
}

async function postMessagesForEventsToSlack(env: Env, events: StoredPactEventData[]) {
	// Group events by pacticipant version number
	const grouped = events.reduce((acc: Record<string, StoredPactEventData[]>, e: StoredPactEventData) => {
		const key = `${e.pacticipant}:${e.pacticipantVersionNumber}`;
		acc[key] = acc[key] || [];
		acc[key].push(e);
		return acc;
	}, {});

	for (const [key, pacticipantEvents] of Object.entries(grouped)) {
		console.log(`Posting Slack message for ${key} with ${pacticipantEvents.length} events`);

		const [pacticipant, pacticipantVersionNumber] = key.split(":");
		const { summaryText, detailsList } = createSummaryAndDetailsMessages(env, pacticipant, pacticipantVersionNumber, pacticipantEvents);
		await postPacticipantEventsToSlack(env, summaryText, detailsList);
	}
}

function getPactAggregatorStub(env: Env) {
	const objectName = env.PACT_AGGREGATOR_NAME;
	const stub = env.PACT_AGGREGATOR.getByName(objectName);
	return stub;
}
