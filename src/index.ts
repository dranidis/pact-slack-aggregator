import { now } from './time-utils';
import type {
	PactWebhookPayload,
	PactEventData,
	StoredPactEventData,
	DebugInfo,
	PublicationThreadEntry,
	ProviderVerificationPublishedPayload,
} from './types';
import { getEventDataFromPayload, getProviderSlackChannel } from './payload-utils';
import {
	createSummaryAndDetailsMessages,
	createVerificationThreadDetailsForProviderChannel,
	appendVerificationStatusToProviderPublicationSummary,
	getPublicationSummaryForPayload,
} from './messages';
import { postPacticipantEventsToSlack, slackPost, slackUpdate, slackFetchThreadReplyCount } from './slack';
import { DEPRECATION_NOTICE, THREAD_REMOVAL_NOTICE, THREAD_DISCONTINUED_DUE_TO_SIZE_NOTICE } from './constants';
import { coerceInt, getPacticipantMasterBranch } from './utils';
import { PactAggregator } from './pact-aggregator';
export { PactAggregator } from './pact-aggregator';

const PUBLISH_CRON = '*/2 * * * *';
const DAILY_MAINTENANCE_CRON = '0 3 * * *';

export default {
	async fetch(request: Request, env: Env) {
		const aggregatorStub = getPactAggregatorStub(env);

		const url = new URL(request.url);

		// Debug endpoint
		if (url.pathname === '/debug' && url.searchParams.get('key') === env.DEBUG_KEY) {
			if (url.searchParams.get('clear') === 'true') {
				await aggregatorStub.clearAll();
				return new Response('State cleared', { status: 200 });
			}
			if (url.searchParams.get('clearPublicationThreads') === 'true') {
				await aggregatorStub.clearPublicationThreads();
				return new Response('Publication threads cleared', { status: 200 });
			}

			const debugData: DebugInfo = await aggregatorStub.getDebugInfo();
			return new Response(JSON.stringify(debugData, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Manual trigger endpoint
		if (url.pathname === '/trigger') {
			if (url.searchParams.get('key') !== env.DEBUG_KEY) {
				return new Response('Unauthorized', { status: 401 });
			}
			console.log(`Should process? ${shouldProcessAtCurrentTime(env)}`);
			await processEventsForPublication(env);
			return new Response('Processing completed', { status: 200 });
		}

		if (url.pathname === '/trigger-daily') {
			if (url.searchParams.get('key') !== env.DEBUG_KEY) {
				return new Response('Unauthorized', { status: 401 });
			}
			await runDailyMaintenance(env);
			return new Response('Daily maintenance completed', { status: 200 });
		}

		if (request.method !== 'POST') {
			return new Response('Method Not Allowed', { status: 405 });
		}

		// Check DEBUG_KEY for POST requests
		const debugKey = url.searchParams.get('key');
		if (debugKey !== env.DEBUG_KEY) {
			return new Response('Unauthorized', { status: 401 });
		}

		// A POST request - process webhook from Pact
		try {
			const rawPayload: PactWebhookPayload = await request.json();
			const eventData: PactEventData = getEventDataFromPayload(rawPayload);

			await aggregatorStub.addEvent(eventData);

			// Also send to provider-specific channel
			await postToProvidersChannel(rawPayload, env);

			return new Response('OK', { status: 200 });
		} catch (err) {
			console.error('Webhook processing error', err);
			return new Response('Internal Server Error', { status: 500 });
		}
	},

	// Runs automatically (Cloudflare Cron). Schedule defined in wrangler.jsonc
	scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
		if (event.cron === DAILY_MAINTENANCE_CRON) {
			ctx.waitUntil(runDailyMaintenance(env));
			return;
		}

		// Default: publish cron (frequent) gated by local working-hours rules.
		// If Cloudflare ever calls us with an unexpected cron string, fall back to the gated path.
		if (event.cron === PUBLISH_CRON || !event.cron) {
			if (shouldProcessAtCurrentTime(env)) {
				ctx.waitUntil(processEventsForPublication(env));
			}
			return;
		}

		if (shouldProcessAtCurrentTime(env)) {
			ctx.waitUntil(processEventsForPublication(env));
		}
	},
};

async function runDailyMaintenance(env: Env) {
	// Daily cron runs under the longer Scheduled Worker limit (15 min for intervals >= 1 hour).
	// Run retention pruning for publication thread metadata, then attempt a publish.
	const aggregatorStub = getPactAggregatorStub(env);
	const removedEntries = await aggregatorStub.prunePublicationThreads();
	await notifySlackAboutRemovedPactVersions(env, removedEntries);
}

async function notifySlackAboutRemovedPactVersions(env: Env, removedEntries: PublicationThreadEntry[]) {
	for (const entry of removedEntries) {
		const threadTs = entry.info.ts;
		const channelForThread = entry.info.channelId;

		await slackPost(
			{
				SLACK_CHANNEL: channelForThread,
				SLACK_TOKEN: env.SLACK_TOKEN,
			},
			THREAD_REMOVAL_NOTICE,
			threadTs,
		);

		const summaryText = getPublicationSummaryForPayload(entry.info.payload, env);

		await slackUpdate(
			{
				SLACK_CHANNEL: channelForThread,
				SLACK_TOKEN: env.SLACK_TOKEN,
			},
			threadTs,
			summaryText + '\n' + THREAD_REMOVAL_NOTICE,
		);
	}
}

async function postToProvidersChannel(rawPayload: PactWebhookPayload, env: Env) {
	const aggregatorStub = getPactAggregatorStub(env);
	const providerSlackChannel = getProviderSlackChannel(env, rawPayload);

	let threadTs = await aggregatorStub.getPublicationThreadTs(rawPayload, providerSlackChannel);

	// A publication event will always have a new pact and the thread will not exist yet!
	// A verification event may or may not have an existing thread for its pact
	//
	// If the thread timestamp ID does not exist yet, create it by posting the summary
	threadTs ??= await createPublicationThread(rawPayload, env);

	if (!threadTs) {
		console.error('Failed to obtain thread timestamp for provider channel post');
		return;
	}

	// If this is a verification result, post in the thread
	if (rawPayload.eventType === 'provider_verification_published') {
		const ver = rawPayload;
		console.log(`Posting verification result to channel ${providerSlackChannel} in thread ${threadTs}`);
		threadTs = await rotatePublicationThreadIfNeeded(aggregatorStub, ver, providerSlackChannel, env, threadTs);

		// If provider branch is the configured "master" branch, update original summary instead of posting thread detail
		const providerMasterBranch = getPacticipantMasterBranch(env, ver.providerName);
		if (ver.providerVersionBranch === providerMasterBranch) {
			await updateProviderThreadSummaryForMasterBranch(ver, providerSlackChannel, env, threadTs);
		}

		const verificationThreadDetail = createVerificationThreadDetailsForProviderChannel(ver, env);
		const replyResp = await slackPost(
			{
				SLACK_CHANNEL: providerSlackChannel,
				SLACK_TOKEN: env.SLACK_TOKEN,
			},
			verificationThreadDetail,
			threadTs,
		);
		if (replyResp.ok) {
			await aggregatorStub.updatePublicationThread(ver, providerSlackChannel);
		}
	}
}

async function rotatePublicationThreadIfNeeded(
	aggregatorStub: DurableObjectStub<PactAggregator>,
	ver: ProviderVerificationPublishedPayload,
	providerSlackChannel: string,
	env: Env,
	threadTs: string,
) {
	const maxMessagesPerThread = coerceInt(env.MAX_MESSAGES_PER_PACT_IN_THREAD, 100, { min: 0 });
	if (maxMessagesPerThread === 0) {
		return threadTs; // Rotation disabled
	}
	const channelId = await aggregatorStub.getPublicationChannelId(ver, providerSlackChannel);
	if (!channelId) {
		console.error('Missing channel ID for thread counting/rotation; skipping rotation');
		return threadTs;
	}

	let replyCount = await aggregatorStub.getPublicationThreadReplyCount(ver, providerSlackChannel);
	if (replyCount === undefined) {
		// Legacy entries: backfill from Slack once.
		replyCount = await slackFetchThreadReplyCount(
			{
				SLACK_CHANNEL: channelId,
				SLACK_TOKEN: env.SLACK_TOKEN,
			},
			threadTs,
		);
		if (replyCount !== undefined) {
			await aggregatorStub.setPublicationThreadReplyCount(ver, providerSlackChannel, replyCount);
		}
	}

	if (replyCount === undefined || replyCount < maxMessagesPerThread) {
		return threadTs; // No rotation needed or unable to determine reply count
	}

	console.log(
		`Rotating thread for ${ver.consumerName} v${ver.consumerVersionNumber} in channel ${providerSlackChannel} due to reply count ${replyCount}`,
	);

	const oldThreadTs = threadTs;
	const originalPayload = (await aggregatorStub.getPublicationPayload(ver, providerSlackChannel)) ?? ver;
	const summaryText = getPublicationSummaryForPayload(originalPayload, env);
	const discontinuationNotice = `${THREAD_DISCONTINUED_DUE_TO_SIZE_NOTICE}`;

	// Close the old thread (update root message in place)
	await slackUpdate(
		{
			SLACK_CHANNEL: channelId,
			SLACK_TOKEN: env.SLACK_TOKEN,
		},
		oldThreadTs,
		summaryText + '\n' + discontinuationNotice,
	);

	// Open a new thread by posting a new root summary
	const summaryResp = await slackPost(
		{
			SLACK_CHANNEL: providerSlackChannel,
			SLACK_TOKEN: env.SLACK_TOKEN,
		},
		summaryText,
	);
	if (summaryResp.ok && summaryResp.ts && summaryResp.channel) {
		threadTs = summaryResp.ts;
		await aggregatorStub.rotatePublicationThread(ver, providerSlackChannel, threadTs, summaryResp.channel);
	} else {
		console.error('Failed to create rotated thread root message; continuing in existing thread');
		threadTs = oldThreadTs;
	}
	return threadTs;
}

/**
 * Updates the provider channel summary message in place when a master-branch verification completes.
 * Fetches the original publication payload to rebuild the summary, appends verification status, and updates Slack.
 */
async function updateProviderThreadSummaryForMasterBranch(
	ver: ProviderVerificationPublishedPayload,
	providerSlackChannel: string,
	env: Env,
	threadTs: string,
) {
	const aggregatorStub = getPactAggregatorStub(env);

	const originalPayload = (await aggregatorStub.getPublicationPayload(ver, providerSlackChannel)) ?? undefined;
	const originalSummary = originalPayload ? getPublicationSummaryForPayload(originalPayload, env) : '';
	const updatedSummary = appendVerificationStatusToProviderPublicationSummary(
		originalSummary || `Verification results for *${ver.consumerName}*`,
		ver,
		env,
	);
	const channelId = await aggregatorStub.getPublicationChannelId(ver, providerSlackChannel);
	if (!channelId) {
		console.error('Missing channel ID for update! ');
	} else {
		await slackUpdate(
			{
				SLACK_CHANNEL: channelId,
				SLACK_TOKEN: env.SLACK_TOKEN,
			},
			threadTs,
			updatedSummary,
		);
	}
}

/**
 * Publishes the summary message for a pact publication to the provider's Slack channel.
 * Creates a new  (or updates an existing) thread info for the publication.
 * Returns the thread timestamp ID of the message posted.
 *
 * @param rawPayload
 * @param env
 * @returns {Promise<string | undefined>}
 */
async function createPublicationThread(rawPayload: PactWebhookPayload, env: Env): Promise<string | undefined> {
	const aggregatorStub = getPactAggregatorStub(env);
	const providerSlackChannel = getProviderSlackChannel(env, rawPayload);

	const summaryText = getPublicationSummaryForPayload(rawPayload, env);
	const summaryResp = await slackPost(
		{
			SLACK_CHANNEL: providerSlackChannel,
			SLACK_TOKEN: env.SLACK_TOKEN,
		},
		summaryText,
	);

	if (!summaryResp.ok) {
		console.error(`Failed to post verification summary to ${providerSlackChannel}:`, summaryResp.error);
		return;
	}
	const threadTs = summaryResp.ts!;
	const deprecatedCandidates = await aggregatorStub.upsertPublicationThreadInfo(
		rawPayload,
		providerSlackChannel,
		threadTs,
		summaryResp.channel!,
	);
	const { removedKeys } = await notifySlackAboutDeprecatedThreadEntries(env, deprecatedCandidates);
	await aggregatorStub.removePublicationThreadKeys(removedKeys);
	return threadTs;
}

async function notifySlackAboutDeprecatedThreadEntries(env: Env, entries: PublicationThreadEntry[]) {
	const removedKeys: string[] = [];
	const slackFailures: { key: string; error: string }[] = [];
	for (const entry of entries) {
		const threadTs = entry.info.ts;
		const channelForThread = entry.info.channelId;
		const notice = DEPRECATION_NOTICE;
		const summaryText = getPublicationSummaryForPayload(entry.info.payload, env);

		if (!threadTs || !channelForThread) {
			slackFailures.push({ key: entry.key, error: 'missing_thread_metadata' });
			continue;
		}

		try {
			const postResp = await slackPost(
				{
					SLACK_CHANNEL: channelForThread,
					SLACK_TOKEN: env.SLACK_TOKEN,
				},
				notice,
				threadTs,
			);

			const updateResp = await slackUpdate(
				{
					SLACK_CHANNEL: channelForThread,
					SLACK_TOKEN: env.SLACK_TOKEN,
				},
				threadTs,
				summaryText + '\n' + notice,
			);

			if (!postResp.ok || !updateResp.ok) {
				slackFailures.push({
					key: entry.key,
					error: postResp.ok ? (updateResp.error ?? 'update_failed') : (postResp.error ?? 'post_failed'),
				});
				continue;
			}
			removedKeys.push(entry.key);
		} catch (err) {
			slackFailures.push({ key: entry.key, error: err instanceof Error ? err.message : 'unknown_error' });
		}
	}
	return { removedKeys, slackFailures };
}

function shouldProcessAtCurrentTime(env: Env): boolean {
	const currentTime = now();
	// Convert UTC time to target timezone (configurable via environment variable)
	const timezone = env.TIMEZONE ?? 'UTC';
	const date = new Date(currentTime);

	// Get timezone-adjusted time
	const localTime = new Date(date.toLocaleString('en-US', { timeZone: timezone }));
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
	try {
		const aggregatorStub = getPactAggregatorStub(env);
		const { events, bucketsToDelete } = await aggregatorStub.peekEventsToPublish();

		if (events.length === 0 && bucketsToDelete.length === 0) return;

		await postMessagesForEventsToSlack(env, events);
		await aggregatorStub.ackPublishedBuckets(bucketsToDelete, events.length);
	} catch (err) {
		// Do not delete events on publish errors; next cron/trigger will retry.
		console.error('Failed to publish events to Slack; will retry later', err);
	}
}

async function postMessagesForEventsToSlack(env: Env, events: StoredPactEventData[]) {
	// Group events by pacticipant version number
	if (events.length === 0) return;

	const grouped = events.reduce((acc: Record<string, StoredPactEventData[]>, e: StoredPactEventData) => {
		const key = `${e.pacticipant}:${e.pacticipantVersionNumber}`;
		acc[key] = acc[key] || [];
		acc[key].push(e);
		return acc;
	}, {});

	for (const [key, pacticipantEvents] of Object.entries(grouped)) {
		console.log(`Posting Slack message for ${key} with ${pacticipantEvents.length} events`);

		const [pacticipant, pacticipantVersionNumber] = key.split(':');
		const { summaryText, detailsList } = createSummaryAndDetailsMessages(env, pacticipant, pacticipantVersionNumber, pacticipantEvents);
		await postPacticipantEventsToSlack(env, summaryText, detailsList);
	}
}

function getPactAggregatorStub(env: Env) {
	const objectName = env.PACT_AGGREGATOR_NAME;
	const stub = env.PACT_AGGREGATOR.getByName(objectName);
	return stub;
}
