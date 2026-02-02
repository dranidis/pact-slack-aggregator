# Copilot Onboarding Guide

## Repository Summary

- **Purpose**: Cloudflare Worker that ingests Pact Broker webhooks, aggregates them via a Durable Object (`PactAggregator`), and posts summaries plus provider-specific threads to Slack.
- **Tech stack**: TypeScript (strict, ES2021), Cloudflare Workers/Durable Objects, Slack Web API, Vitest + `@cloudflare/vitest-pool-workers`, ESLint flat config. No UI.
- **Repo size**: ~20 source files plus tests, scripts, and configuration. Build is npm-based; no monorepo.

## Environment & Prerequisites

- **Node.js**: Use the default LTS (v18+) that ships with modern Wrangler; npm v10 works fine.
- **Wrangler**: `npx wrangler` installs from devDependencies. Login (`wrangler login`) before deploying or using `wrangler dev` if you need Cloudflare APIs.
- **Secrets/config**:
  - Copy `.env.example` → `.env` and fill `SLACK_TOKEN`, `DEBUG_KEY`. Always run `wrangler types` after changing env vars so `worker-configuration.d.ts` stays current.
  - Copy wrangler templates → `wrangler.dev.jsonc` and `wrangler.prod.jsonc`, fill non-secret vars (channel names, GitHub base URL, etc.). Prod file stays gitignored.
  - Durable Object binding name must match `PACT_AGGREGATOR` in configs; leave cron schedule at `*/2 * * * *` unless you know why to change it.

## Commands & Validation

_All commands run from repo root unless stated. Times recorded on a Linux devcontainer with warm cache._

| Purpose           | Command                                 | Notes & Preconditions                                                                                                                             | Verified?                                                                                            |
| ----------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Bootstrap         | `npm install`                           | Installs Wrangler, Vitest pool, ESLint, etc. Requires network access.                                                                             | ✅ (~19s, no issues)                                                                                 |
| Lint              | `npm run lint`                          | Runs ESLint across `.ts`, `.js`, `.mts`. No extra setup.                                                                                          | ✅ (passes cleanly)                                                                                  |
| Tests             | `npm test`                              | Launches Vitest in watch mode using `vitest.config.mts`. Auto-detects `.env`, spins Cloudflare runtimes per test. Press `q` to exit watch.        | ✅ (~6s for 5 suites)                                                                                |
| Dev (local)       | `npm run dev`                           | `wrangler dev --config wrangler.dev.jsonc`. Requires filled config + Wrangler auth; CRS jobs won't run so hit `/trigger?key=DEBUG_KEY`.           | ⚠️ Not run during onboarding due to needing Cloudflare login; expect Wrangler banner and local port. |
| Dev (prod config) | `npm run dev:prod`                      | Uses default `wrangler.jsonc` (copy prod template first). Same requirements as above.                                                             | ⚠️ Not validated.                                                                                    |
| Deploy (prod)     | `npm run deploy`                        | Copies prod config to `wrangler.jsonc`, runs `wrangler types`, deploys, then deletes temp file. Needs logged-in Wrangler and populated prod file. | ⚠️ Not run; use only when secrets ready.                                                             |
| Deploy (dev env)  | `npm run deploy:dev`                    | Uses `wrangler.dev.jsonc`. Handy for preview namespace.                                                                                           | ⚠️ Not run.                                                                                          |
| Type generation   | `npm run cf-typegen` or `npm run types` | Generates `worker-configuration.d.ts`. Run after touching env vars or configs.                                                                    | ⚠️ Not run in this pass.                                                                             |

**Script quirks**

- If Vitest reruns hang, run `./fix-test-rerun.sh` once; it patches `@cloudflare/vitest-pool-workers` to reset Miniflare options.
- Slack cleanup: `scripts/delete-messages-and-replies.sh <message_url>` deletes a thread. Needs `SLACK_BOT_TOKEN` env and `jq`, `iconv`.

## Project Layout & Key Files

- **Entry point**: `src/index.ts` exports Worker handlers. Routes `/debug` & `/trigger`, validates `DEBUG_KEY`, and uses Durable Object stub for state.
- **Durable Object**: `src/pact-aggregator.ts` contains aggregation, bucketing, consolidation logic, and Slack thread metadata storage. Functions like `getEventsToPublish()` and `consolidateEvents()` govern batching behavior.
- **Message formatting**: `src/messages.ts` builds Slack message bodies, branch/commit links, and provider-thread updates.
- **Slack integration**: `src/slack.ts` wraps `chat.postMessage`, `chat.update`, `chat.delete`, and `conversations.history` with logging.
- **Payload helpers**: `src/payload-utils.ts` extracts participant/version info, provider channels, pact versions.
- **Utility modules**: `src/time-utils.ts`, `src/utils.ts`, `src/constants.ts`, `src/types.ts`, `src/payload-utils.ts` define shared logic and typing.
- **Tests**: Under `test/`, matching spec files verify utilities, worker behavior, message generation, aggregator logic. `test/setup.ts` silences console noise; `test/test-utilities.ts` supplies payload factories/mocks.
- **Configs**:
  - `tsconfig.json` (strict TypeScript, includes only `src/**`).
  - `vitest.config.mts` (workers pool, `wrangler.dev.jsonc`, sequential tests, coverage output).
  - `eslint.config.mjs` (flat config, TypeScript-aware, ignores generated folders).
  - `wrangler.*.jsonc` templates describe Durable Object binding, cron, vars, migrations. Always edit the template and copy to env-specific file.
- **Docs/templates**: `README.md` for setup/deploy guidance. `example-payloads/` contains sample Pact webhook JSON for manual testing. `pact-broker-webhooks/` has shell helpers & payload templates for webhook management. `secret/` holds gitignored local copies.

## Validation & CI Expectations

- No GitHub Actions present; assume reviewers run lint + tests locally. For PRs, **always**:
  1. `npm install`
  2. `npm run lint`
  3. `npm test`
- If touching Worker behavior, run `npm run dev` to manually hit `/debug` or `/trigger`. Document any Wrangler warnings in PR descriptions.
- Deploy scripts rely on copying prod config; be sure to clean `wrangler.jsonc` if a run aborts mid-way to avoid leaking secrets.
- Cloudflare cron drives scheduled flushing, so unit tests mock `now()`. When changing time logic, update `test/test-utilities.ts` factories and `test/setup.ts` mocks to keep deterministic behavior.

## Additional Tips

- Durable Object state keys live under `events`, `publicationThreads`, etc. Use `/debug?key=DEBUG_KEY` to inspect state; `/debug?clear=true` wipes storage.
- Provider-channel threads rely on `PROVIDER_CHANNEL_PREFIX` and per-provider Slack channels. If you add providers, ensure Slack channel exists or Slack API calls will fail.
- `worker-configuration.d.ts` is massive (auto-generated); never hand-edit.
- Sample cURL to trigger processing locally: `curl "http://localhost:$DEV_PORT/trigger?key=$DEBUG_KEY"` while `npm run dev` is running.
- When adding environment variables, update `.env.example`, both wrangler templates, and regenerate types.

## Final Guidance

Trust these instructions for future tasks; only search the codebase when information here is missing or proven incorrect.
