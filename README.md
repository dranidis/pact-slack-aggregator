# A cloudflare worker for aggregating pact broker events sent by pact-broker webhooks

## Description

This application is a Cloudflare Worker designed to aggregate events from the company's Pact Broker. It processes webhook events, organizes them, and posts summaries to a specified Slack channel. The application leverages Durable Objects for stateful event aggregation and provides endpoints for debugging and manual processing.

### Timing Details

- **Quiet Period**: Events are aggregated over a quiet period of 10 seconds to ensure batching of related events.
- **Event Bucketing**: Events are grouped into 1-minute buckets for efficient processing.
- **Flushing Interval**: Events are flushed and processed if they remain unprocessed for more than 5 minutes.

## Setup

### 1. Environment Configuration

Copy the environment templates and configure them:

```sh
# Copy environment variables template
cp .env.example .env

# Copy local and production wrangler configuration template
cp wrangler.dev.template.jsonc wrangler.dev.jsonc
cp wrangler.prod.template.jsonc wrangler.prod.jsonc
```

Then edit both `.env`, `wrangler.dev.jsonc` and `wrangler.prod.jsonc` with your specific values:

- **SLACK_TOKEN**: Your Slack bot token
- **DEBUG_KEY**: A secret key for accessing debug endpoints
- **SLACK_CHANNEL**: Target Slack channel (e.g., `#ci`)
- **GITHUB_BASE_URL**: Your GitHub organization URL
- **PACTICIPANT_TO_REPO_MAP**: JSON mapping of service names to repository names

### 2. Secrets Management

Set up secrets for production deployment:

```sh
# Set authentication secrets
wrangler secret put SLACK_TOKEN
wrangler secret put DEBUG_KEY
```

## TS Env types

```sh
wrangler types -c wrangler.dev.jsonc
```

generates Env type using .env and vars in wrangler.dev.jsonc

## Local dev

For local development (uses wrangler.dev.jsonc):

```sh
npm run dev
# or
wrangler dev --config wrangler.dev.jsonc
```

For production-like local testing (uses wrangler.jsonc):

```sh
npm run dev:prod
```

CRON jobs do not work in dev. You have to trigger the job execution manually (DEV_PORT is the port reported):

```sh
curl http://localhost:$DEV_PORT/trigger\?key\=$DEBUG_KEY
```

## Deploy

### Production Deployment Configuration

The production deployment uses `wrangler.prod.jsonc` which contains environment-specific configuration values. This file is **excluded from git** (listed in `.gitignore`) to avoid committing sensitive company information while still allowing non-secret environment variables to be managed as configuration rather than secrets.

### Automated Deployment Process

The deployment script automatically handles the production configuration:

```sh
npm run deploy
```

This command performs the following steps:

1. **Copies** `wrangler.prod.jsonc` to `wrangler.jsonc` (temporary file)
2. **Generates** TypeScript types with `wrangler types`
3. **Deploys** the worker with `wrangler deploy`
4. **Cleans up** by removing the temporary `wrangler.jsonc` file

### Manual Deployment

If you need to deploy manually:

```sh
wrangler deploy
```

**Note:** Manual deployment requires that `wrangler.jsonc` exists in the project root. For production deployments, always use `npm run deploy` to ensure the correct configuration is used.

## Set slack token

The only action needed to change the slack workspace to which the messages are being sent is:

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
