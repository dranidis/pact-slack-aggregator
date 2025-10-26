# A cloudflare worker for aggregating pact broker events sent by pact-broker webhooks

## Description

This application is a Cloudflare Worker designed to aggregate events from the company's Pact Broker. It processes webhook events, organizes them, and posts summaries to a specified Slack channel. The application leverages Durable Objects for stateful event aggregation and provides endpoints for debugging and manual processing.

### Timing Details

- **Quiet Period**: Events are aggregated over a quiet period of 10 seconds to ensure batching of related events.
- **Event Bucketing**: Events are grouped into 1-minute buckets for efficient processing.
- **Flushing Interval**: Events are flushed and processed if they remain unprocessed for more than 5 minutes.

## TS Env types

```sh
wrangler types
```

generates Env type using .env and vars in wrangler.jsonc

## Local dev

```sh
wrangler dev
```

CRON jobs do not work in dev. You have to trigger the job execution manually (DEV_PORT is the port reported):

```sh
curl http://localhost:$DEV_PORT/trigger\?key\=$DEBUG_KEY
```

## Deploy

```sh
wrangler deploy
```

## Set slack token

The only action needed to change the slack workspace (e.g. BA Trigonon or Test templates) to which the messages are being sent is:

```sh
wrangler secret put SLACK_TOKEN
```

This is the Bot User OAuth Token found at OAuth & Permissions at https://api.slack.com/apps
e.g. `xoxb-......................`

## Watch logs

```sh
wrangler tail pact-slack-aggregator
```

## Debug

```
curl https://psa.workers.dev/debug\?key\=DEBUG_KEY
```

## List existing webhooks

```sh
curl -X GET https://pactbrokerurl.com/webhooks
```

## Install/update webhooks

In folder `pact-broker-webhooks`

- optionally edit the json files for any changes (e.g. disable)
- change the `PUT` to `POST` in `update_new_webhooks.sh` for creation.
- execute the `create_new_webhooks` for creation
- execute the `update_new_webhooks.sh` for updating existing webhooks (change the UUID of the webhook at the end of the link)
