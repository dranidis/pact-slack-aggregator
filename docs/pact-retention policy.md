# Pact Retention Policy (Publication Threads)

Date: 2026-02-03

## Purpose

This document defines the retention requirements for **publication thread entries** stored by the Durable Object in `publicationThreads`.

The goals are:

- Keep enough history to support troubleshooting and context in Slack.
- Prefer retaining the most recent pact versions.
- Retain anything that is still “recently active”.

## Scope

This policy applies to the metadata entries stored for publication threads (e.g., timestamps, channel IDs, and payload metadata) keyed by pact version.

It does **not** define retention for the raw event buckets (`events:*`).

## Definitions

- **Provider/consumer pair**: identified by `providerName` + `consumerName`.
- **Pact version**: the pact version derived from the webhook payload (see `getPactVersionFromPayload`).
- **Publication thread entry**: a stored item representing the root Slack message (and associated metadata) for a specific provider/consumer/pactVersion.
- **Updated time**:
  - Prefer `updatedTs` when present.
  - Otherwise fall back to `createdTs`.
  - Timestamps are stored as millisecond-epoch strings.
- **Recent**: updated within the last **3 months**.
  - For implementation, use a rolling window (e.g., `now - 90 days`) unless a calendar-month definition is explicitly required later.

## Requirements

### R1: Minimum retained pact versions

For each **provider/consumer pair**, retain **at least the 10 newest pact versions**.

- “Newest” means the 10 pact versions with the most recent update time (as defined above).
- If there are fewer than 10 total entries for the pair, retain all of them.

### R2: Retain recently updated pacts

For each **provider/consumer pair**, retain **all** pact versions updated in the last **3 months**, even if this results in retaining more than 10 versions.

### R3: Deletion rule for older pacts

A pact entry **may be deleted** only when **all** of the following are true:

1. The pact entry was updated **more than 3 months ago**, **and**
2. There are already **10 newer pact versions** for the same provider/consumer pair.

Equivalently:

- Keep everything in the “latest 10” set, regardless of age.
- Keep everything “recent” (updated < 3 months), regardless of rank.
- Delete only entries that are both **old** and **beyond the newest 10**.

### R4: Notification when deleting pact versions

When a pact version is removed from `publicationThreads`, the Worker must:

1. Post the message **"Pact version removed from slack-aggregator: this thread will stop receiving updates"** in the Slack thread channel for that pact version.
2. Update the corresponding summary message with the same text so that the top-level summary also reflects the removal.

These notifications ensure Slack users know the thread is no longer active.

## Channel handling (note)

Publication thread entries are also stored with a Slack channel dimension in the key.

This policy is stated in terms of a provider/consumer pair. If entries exist for multiple channels, the recommended application is:

- Apply the retention rules **per provider/consumer pair per channel**, because threads are channel-specific.

If you want retention to be enforced across all channels combined, that should be explicitly adopted as a separate requirement.

## Example

Assume provider/consumer pair `P/C` has 15 pact versions in storage:

- The newest 10 are always retained.
- Among the 5 older-than-top-10 entries:
  - If any were updated within the last 3 months, they are retained.
  - Any that are older than 3 months and have at least 10 newer versions may be deleted.

## Non-goals

- This policy does not define how to discover “newer” pact versions beyond ordering by update time.
- This policy does not define Slack message cleanup/deletion; it only governs the durable metadata retention.
