
#!/bin/zsh
# ------------------------------------------------------------------------------
# delete-messages-and-replies.sh
#
# This script deletes a Slack message and all its replies (thread messages).
#
# How it works:
#   1. Accepts a Slack message URL as input (e.g. https://.../archives/<channel>/p<ts>)
#   2. Extracts the channel ID and message timestamp (ts) from the URL.
#   3. Uses the Slack API to fetch all replies to the message (thread).
#   4. Deletes each reply using the Slack API.
#   5. Deletes the original message using the Slack API.
#
# Requirements:
#   - SLACK_BOT_TOKEN must be set in the environment (with chat:write, channels:history permissions)
#   - curl, jq, iconv must be installed
#   - The message URL must be in the format: https://<workspace>.slack.com/archives/<channel>/p<ts>
#
# Usage:
#   ./delete-messages-and-replies.sh <slack_message_url>
#
# Example:
#   ./delete-messages-and-replies.sh https://yourworkspace.slack.com/archives/C12345678/p1710512345678
#
# Debugging:
#   - The raw Slack API response is saved to /tmp/slack_replies_raw.json for inspection.
#   - The script prints the first 10 lines of the API response for troubleshooting.
# ------------------------------------------------------------------------------

set -e

if [ -z "$SLACK_BOT_TOKEN" ]; then
	echo "Error: SLACK_BOT_TOKEN environment variable not set."
	exit 1
fi

if [ $# -ne 1 ]; then
	echo "Usage: $0 <slack_message_url>"
	exit 1
fi

SLACK_URL="$1"

# Extract channel and ts from the URL
if [[ "$SLACK_URL" =~ slack.com/archives/([^/]+)/p([0-9]+) ]]; then
	CHANNEL_ID="$match[1]"
	RAW_TS="$match[2]"
	# Convert ts from e.g. 1710512345678 to 1710512345.678
	TS="${RAW_TS[1,10]}.${RAW_TS[11,-1]}"
else
	echo "Error: Could not parse Slack message URL."
	exit 1
fi

echo "Channel: $CHANNEL_ID"
echo "Message ts: $TS"





# Get all replies to the message, handle missing .messages, sanitize control and invalid UTF-8 characters
RAW_REPLIES_JSON=$(curl -s -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
	"https://slack.com/api/conversations.replies?channel=$CHANNEL_ID&ts=$TS")
echo "$RAW_REPLIES_JSON" > /tmp/slack_replies_raw.json
echo "--- First 10 lines of raw Slack API response ---"
echo "$RAW_REPLIES_JSON" | head -10
echo "--- End of preview ---"

# Try to sanitize and parse
REPLIES_JSON=$(echo "$RAW_REPLIES_JSON" | tr -d '\000-\037' | iconv -c -f utf-8 -t utf-8)

OK=$(echo "$REPLIES_JSON" | jq -r '.ok' 2>/dev/null)
if [ "$OK" != "true" ]; then
	echo "Error fetching replies or invalid JSON:"
	echo "$REPLIES_JSON" | head -20
	exit 1
fi

REPLIES=$(echo "$REPLIES_JSON" | jq -r '.messages[]? | select(.thread_ts == "'$TS'" and .ts != "'$TS'") | .ts' 2>/dev/null)

if [ -z "$REPLIES" ]; then
	echo "No replies found."
else
	echo "Deleting replies..."
	for REPLY_TS in ${(f)REPLIES}; do
		echo "Deleting reply ts: $REPLY_TS"
		curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
			--data "channel=$CHANNEL_ID" --data "ts=$REPLY_TS" \
			"https://slack.com/api/chat.delete" | jq .
	done
fi

echo "Deleting original message..."
curl -s -X POST -H "Authorization: Bearer $SLACK_BOT_TOKEN" \
	--data "channel=$CHANNEL_ID" --data "ts=$TS" \
	"https://slack.com/api/chat.delete" | jq .
