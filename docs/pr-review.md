# PR Review Notes (Repository)

Date: 2026-02-02

## Status (as of 2026-02-02)

- [x] High Priority #1: Don’t delete events on Slack failure (two-phase publish: peek → post → ack)
- [x] High Priority #2: Prevent orphan detail posts when summary fails (throw/abort on missing `ts`)
- [ ] Medium: Slack API robustness (handle non-2xx / non-JSON, log `res.status`)

## Summary

Overall the codebase is small, readable, and well-covered by tests. The main risk area is **reliability**: the current flow can **drop events permanently** when Slack errors occur, and can also post “orphan” messages (details without their intended parent thread).

## High Priority Findings

### 1) Potential permanent data loss when Slack fails

- **Where**: `src/index.ts` (aggregation + publishing flow)
- **Why it matters**: Durable Object state is reduced/cleared before Slack posting is verified as successful. If Slack is down, rate-limited, token revoked, wrong channel, etc., events can be deleted from DO storage and never retried.
- **Addressed**:
  - Publish is now two-phase: eligible events are selected without deletion, posted to Slack, and only then acknowledged (deleted) on success.
  - Failures during posting do not delete Durable Object state, so the next cron/trigger will retry.
- **Still recommended**:
  - Consider explicit retry/backoff semantics (especially for Slack rate limits) and/or surfacing failures to an alerting channel.

### 2) Orphaned Slack messages when root post fails

- **Where**: `src/slack.ts` (`postPacticipantEventsToSlack`)
- **Current behavior (pre-fix)**: It posted a summary, then posted the details using `summaryResp.ts` as `thread_ts`. If the summary post failed (`ok: false`), `ts` was missing and the details could be posted as a new root message.
- **Impact**: Slack channel noise + missing correlation between summary and details; plus it hides the failure of the summary post.
- **Addressed**:
  - The code now aborts (throws) if the summary post fails or does not return a `ts`, so details are never posted as a new root message.
  - Thread-post failures also throw so the caller can avoid acknowledging (deleting) events and rely on retry.

## Medium Priority Observations

- **Slack API robustness**: `slackPost`/`slackUpdate` parse JSON without checking HTTP status. Consider handling non-JSON responses and logging `res.status` for debugging.

## Suggested Next Steps (If You Want to Improve Reliability)

1. (Done) Change the publish flow so Slack success is verified before deleting DO events.
2. (Open) Add explicit retry/backoff semantics for Slack rate limiting/network failures.

(These are design-level recommendations; they can be implemented incrementally.)
