import type { SlackPostMessageRequest, SlackPostMessageResponse, SlackUpdateMessageRequest } from './types';

// Minimal environment interface for Slack operations
export interface SlackEnv {
	SLACK_CHANNEL: string;
	SLACK_TOKEN: string;
}

export async function postPacticipantEventsToSlack(
	slackEnv: SlackEnv,
	summaryText: string,
	detailsList: string[]
) {
	const summaryResp = await slackPost(slackEnv, summaryText);
	const threadText = detailsList.join('\n');
	await slackPost(slackEnv, threadText, summaryResp.ts);
}

export async function slackPost(slackEnv: SlackEnv, text: string, threadTs?: string): Promise<SlackPostMessageResponse> {
	const body: SlackPostMessageRequest = {
		text,
		channel: slackEnv.SLACK_CHANNEL, // postMessage works with channel name also
	};

	if (threadTs) body.thread_ts = threadTs;

	const res = await fetch("https://slack.com/api/chat.postMessage", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${slackEnv.SLACK_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json: SlackPostMessageResponse = await res.json();
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
		console.log("✅ Slack message sent successfully", { ts: json.ts, channel: json.channel, text: body.text.substring(0, 30) + '...' });
	}
	return json;
}

export async function slackUpdate(slackEnv: SlackEnv, ts: string, newText: string): Promise<SlackPostMessageResponse> {
	const body: SlackUpdateMessageRequest = {
		text: newText,
		channel: slackEnv.SLACK_CHANNEL, // expect channel ID here (channel name won't work for updates)
		ts
	};

	const res = await fetch("https://slack.com/api/chat.update", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${slackEnv.SLACK_TOKEN}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
	});
	const json: SlackPostMessageResponse = await res.json();
	if (!json.ok) {
		console.error("❌ Slack API Error (update):", { error: json.error, needed: json.needed, provided: json.provided, channel: body.channel, ts });
	} else {
		console.log("✅ Slack message updated successfully", { ts: body.ts, channel: body.channel });
	}
	return json;
}

