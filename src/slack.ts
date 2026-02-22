import type {
	SlackConversationsRepliesResponse,
	SlackPostMessageRequest,
	SlackPostMessageResponse,
	SlackUpdateMessageRequest,
} from './types';

// Minimal environment interface for Slack operations
interface SlackEnv {
	SLACK_CHANNEL: string;
	SLACK_TOKEN: string;
}

export async function postPacticipantEventsToSlack(slackEnv: SlackEnv, summaryText: string, detailsList: string[]) {
	const summaryResp = await slackPost(slackEnv, summaryText);
	if (!summaryResp.ok || !summaryResp.ts) {
		throw new Error(`Slack summary post failed: ${summaryResp.error ?? 'unknown_error'}`);
	}

	if (detailsList.length === 0) return;

	const threadText = detailsList.join('\n');
	const threadResp = await slackPost(slackEnv, threadText, summaryResp.ts);
	if (!threadResp.ok) {
		throw new Error(`Slack thread post failed: ${threadResp.error ?? 'unknown_error'}`);
	}
}

export async function slackPost(slackEnv: SlackEnv, text: string, threadTs?: string): Promise<SlackPostMessageResponse> {
	const body: SlackPostMessageRequest = {
		text,
		channel: slackEnv.SLACK_CHANNEL, // postMessage works with channel name also
	};

	if (threadTs) body.thread_ts = threadTs;

	const res = await fetch('https://slack.com/api/chat.postMessage', {
		method: 'POST',
		headers: createSlackHeaders(slackEnv),
		body: JSON.stringify(body),
	});
	const json: SlackPostMessageResponse = await res.json();
	if (!json.ok) {
		console.error('❌ Slack API Error:', {
			error: json.error,
			needed: json.needed,
			provided: json.provided,
			channel: body.channel,
			hasThreadTs: !!body.thread_ts,
			messageLength: body.text?.length,
		});
	} else {
		console.log('✅ Slack message sent successfully', { ts: json.ts, channel: json.channel, text: body.text.substring(0, 30) + '...' });
	}
	return json;
}

export async function slackUpdate(slackEnv: SlackEnv, ts: string, newText: string): Promise<SlackPostMessageResponse> {
	const body: SlackUpdateMessageRequest = {
		text: newText,
		channel: slackEnv.SLACK_CHANNEL, // expect channel ID here (channel name won't work for updates)
		ts,
	};

	const res = await fetch('https://slack.com/api/chat.update', {
		method: 'POST',
		headers: createSlackHeaders(slackEnv),
		body: JSON.stringify(body),
	});
	const json: SlackPostMessageResponse = await res.json();
	if (!json.ok) {
		console.error('❌ Slack API Error (update):', {
			error: json.error,
			needed: json.needed,
			provided: json.provided,
			channel: body.channel,
			ts,
		});
	} else {
		console.log('✅ Slack message updated successfully', { ts: body.ts, channel: body.channel });
	}
	return json;
}

/**
 * Fetches the reply count for a thread (parent message) using conversations.replies.
 * Returns undefined on Slack API failures.
 */
export async function slackFetchThreadReplyCount(slackEnv: SlackEnv, threadTs: string): Promise<number | undefined> {
	const url = new URL('https://slack.com/api/conversations.replies');
	url.searchParams.append('channel', slackEnv.SLACK_CHANNEL);
	url.searchParams.append('ts', threadTs);
	url.searchParams.append('limit', '1');

	const res = await fetch(url.toString(), {
		method: 'GET',
		headers: {
			Authorization: `Bearer ${slackEnv.SLACK_TOKEN}`,
		},
	});
	const json: SlackConversationsRepliesResponse = await res.json();
	if (!json.ok) {
		console.error('❌ Slack API Error (fetch thread replies):', {
			error: json.error,
			needed: json.needed,
			provided: json.provided,
			channel: slackEnv.SLACK_CHANNEL,
			threadTs,
		});
		return undefined;
	}

	return json.messages?.[0]?.reply_count;
}

function createSlackHeaders(slackEnv: SlackEnv): HeadersInit | undefined {
	return {
		Authorization: `Bearer ${slackEnv.SLACK_TOKEN}`,
		'Content-Type': 'application/json',
	};
}
