# A cloudflare worker for aggregating pact broker events sent by pact-broker webhooks

## Features

- **Pact Broker webhook ingestion**: Accepts Pact Broker webhook `POST` payloads (currently `contract_requiring_verification_published` and `provider_verification_published`) and converts them into normalized event records. Webhook requests are expected to include `?key=$DEBUG_KEY` (otherwise the worker responds `401`).
- **Stateful aggregation via Durable Objects**: Uses a Durable Object (`PactAggregator`) to persist events and ensure serialized processing (no interleaving) per aggregator instance.
- **Retry-friendly publishing**: Publishing uses a “peek then ack” flow, so if Slack posting fails the events are not deleted and will be retried on the next cron/trigger.
- **Batching + bucketing**:
  - Stores events in **minute buckets** (`MINUTE_BUCKET_MS`, default 60s).
  - Enforces a **quiet period** (`QUIET_PERIOD_MS`, default 10s) so events arriving “right now” don’t get published prematurely.
  - Consolidates events across adjacent buckets so that events for the same pacticipant/version are published together.
  - Uses `MAX_TIME_BEFORE_FLUSHING` (default 5 minutes) as the consolidation window: recent events can be pulled forward into the current bucket for better grouping, but publishing still only includes completed buckets (everything except the current minute).
- **Slack publishing (main channel)**:
  - Posts a **summary message** per pacticipant version (counts of publications + verification successes/failures).
  - Posts a **thread reply** containing the detailed publication/verification lines (including links to Pact and GitHub).
- **Provider-specific Slack channels + per-contract threads**:
  - On publication, posts a root summary to a provider channel derived from `PROVIDER_CHANNEL_PREFIX` (default `#pact-`) + provider name.
  - On verification, posts results into the matching contract thread; verifications on the provider’s configured “master” branch (see `DEFAULT_MASTER_BRANCH` / `PACTICIPANT_MASTER_BRANCH_EXCEPTIONS`) also update the root message with the latest status.
  - Supports **thread rotation** when a thread becomes too large (`MAX_MESSAGES_PER_PACT_IN_THREAD`), closing the old thread and opening a new one.
  - **Deprecated pact handling (new publications)**: when a new `contract_requiring_verification_published` event is received for the same provider + consumer + consumer branch + provider channel, older pact versions are marked as deprecated and stop receiving updates:
    - If `consumerVersionBranch` matches the consumer’s configured “master” branch, keep the **2 most recently updated** pact versions for that provider/consumer/branch/channel; deprecate the rest.
    - If `consumerVersionBranch` is any other non-empty value, keep only the **most recently updated** pact version for that provider/consumer/branch/channel; deprecate the rest.
    - If `consumerVersionBranch` is empty/unknown, branch-based deprecation is skipped (nothing is auto-deprecated on publish).
    - Deprecation is communicated in Slack by replying `🧹 *Deprecated pact!*` in the old thread and updating the root summary message to include the same notice.
- **Scheduled flushing with working-hours gating**:
  - Designed to run from Cloudflare Cron every 2 minutes, but gated by local time (`TIMEZONE`) so it publishes frequently during working hours and less often off-hours/weekends.
  - A daily cron runs maintenance (retention pruning for stored publication-thread metadata):
    - Uses `RETENTION_MIN_PACT_VERSIONS` (default 10) and `RETENTION_RECENT_DAYS` (default 90) to remove _old_ publication-thread entries per provider/consumer/channel.
    - When an entry is pruned, Slack is notified by replying `🦕 *Old pact!*` in that thread and updating the root summary message with the same notice so it’s clear the thread will no longer receive updates.
- **Operational endpoints (guarded by `DEBUG_KEY`)**:
  - `GET /debug?key=...` returns Durable Object state (event buckets, stats, stored publication threads).
  - `GET /debug?key=...&clear=true` clears all stored state.
  - `GET /debug?key=...&clearPublicationThreads=true` clears only publication-thread metadata.
  - `GET /trigger?key=...` manually triggers a publish cycle (useful locally since cron doesn’t run in `wrangler dev`).
  - `GET /trigger-daily?key=...` runs the daily maintenance job.
  - `GET /trigger-deprecate?key=...` finds deprecated publication-thread entries (same branch rules as above). Use `&apply=true&limit=N` to post the deprecation notices in Slack and remove the deprecated entries from Durable Object storage.

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
- **DEBUG_KEY**: A secret key for accessing worker endpoints (debug/trigger and webhook ingestion)
- **SLACK_CHANNEL**: Target Slack channel (e.g., `#ci`)
- **DEFAULT_MASTER_BRANCH**: Default “master” branch name used for branch-specific behavior (e.g., `master` or `main`)
- **PACTICIPANT_MASTER_BRANCH_EXCEPTIONS**: JSON map of pacticipant name -> master branch name for exceptions to the default
- **GITHUB_BASE_URL**: Your GitHub organization URL
- **PACTICIPANT_TO_REPO_MAP**: JSON mapping of Pact broker pacticipant names to Github repository names. For pacticipants with no entry, it is assumed that the repo name is found by converting PascalCase pacticipant names to dash-separated strings.

#### Slack configuration

Visit `https://api.slack.com/apps` and click on your application or create a new one.

Go to OAuth & Permissions and make sure that you have the following bot token scopes (assuming your app is called "Pact Broker"):

- `channels:history`: View messages and other content in public channels that "Pact Broker" has been added to
- `chat:write` Send messages as @Pact Broker
- `chat:write.public` Send messages to channels @Pact Broker isn't a member of

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

## Set secrets

The slack workspace to which the messages are being sent.
This is the Bot User OAuth Token found at OAuth & Permissions at https://api.slack.com/apps
e.g. `xoxb-......................`

```sh
wrangler secret put SLACK_TOKEN --name pact-slack-aggregator
```

and to set the key for authorization:

```
wrangler secret put DEBUG_KEY --name pact-slack-aggregator
```

## Watch logs

```sh
wrangler tail pact-slack-aggregator
```

## Debug

```
curl https://psa.workers.dev/debug\?key\=DEBUG_KEY
```

## Install/update webhooks

### List existing webhooks

```sh
curl -X GET $PACT_URL/webhooks
```

In folder `pact-broker-webhooks` read the `README` file for instructions.

## Local development with Pact-broker in docker

For a Pact broker webhook to communicate from inside Docker to the host localhost POST to `http://host.docker.internal:8787` and
run wrangler at ip `0.0.0.0`:

```
wrangler dev --port 8787 --ip 0.0.0.0 --config wrangler.dev.jsonc
```

Also add to the docker file the environment variables:

```
      PACT_BROKER_WEBHOOK_SCHEME_WHITELIST: 'https http'
```

And map host.docker.internal so the container can reach services running on the host (eg. webhook target on host port 8787)

```
    extra_hosts:
      - "host.docker.internal:host-gateway"
```

## Testing

Run tests:

```
npm test
```

With coverage:

```
npm run test -- --coverage=true
```
