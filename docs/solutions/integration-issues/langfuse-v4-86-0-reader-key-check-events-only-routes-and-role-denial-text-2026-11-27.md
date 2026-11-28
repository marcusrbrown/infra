---
title: "Langfuse v4.86.0 Viewer-key check: events-only routes and the role-denial text"
date: 2026-11-27
category: integration-issues
module: apps/traces
problem_type: integration_issue
component: tooling
severity: medium
symptoms:
  - "traces reader backend langfuse fails read-failed:404 when the read probe hits an events-only route"
  - "It fails rest-write-not-denied:403 with a valid Viewer key when the denial text is not recognised"
root_cause: wrong_api
resolution_type: code_fix
tags: [langfuse, events-only, rbac, reader-gate, viewer-key, v4-86-0]
---

# Langfuse v4.86.0 Viewer-key check: events-only routes and the role-denial text

## Problem

In Langfuse v4.86.0's events-only mode, the Viewer-key check must use a served read route and match the role-denial message.

## Symptoms

- `read-failed:404`: the read probe hit a route that events-only mode does not serve.
- `rest-write-not-denied:403`: Langfuse refused the write, but the check did not recognise the refusal.

## What Didn't Work

- **`GET /api/public/traces` as the read probe.** The default write mode is `events_only` (Langfuse `packages/shared/src/env.ts:474-476`). A route flagged `rejectInEventsOnlyMode` answers 404 before auth, with body `{message: EVENTS_ONLY_UNAVAILABLE_MESSAGE}` (`web/src/features/public-api/server/createAuthedProjectAPIRoute.ts:69-71`, `:206-213`).
- **The `ForbiddenError` default text,** `Access denied. You do not have permission to access this resource.` (`packages/shared/src/errors/ForbiddenError.ts:5`). The role-denial path never sends it.

## Solution

- Read probe: `GET /api/public/projects`, which needs only `project:read` (`web/src/pages/api/public/projects/index.ts:30`). The check requires 200 and a `data` array (`apps/traces/reader-gate/check.ts:195-208`). Failure reasons end in the HTTP status (`check.ts:190-193`).
- Both write probes require the exact denial (`check.ts:54-55`, `:229-233`): `Access denied. The "scores:save" permission is required to access this resource.` Source: `deniedError`, `web/src/features/rbac/authorize.ts:82-86`, returned at `:34` and `:38`.
- The check accepts HTTP 403 carrying the exact `scores:save` denial text, or HTTP 200 carrying JSON-RPC `-32600` with that exact text (`check.ts:251-260`). MCP maps `ForbiddenError` to `-32600` (`web/src/features/mcp/core/error-formatting.ts:64-66`).

## Why This Works

Under `web/src/pages/api/public/`, these routes set `rejectInEventsOnlyMode: true` and answer 404 in events-only mode:

- **GET:** `traces`, `traces/{traceId}`, `sessions`, `sessions/{sessionId}`, `observations`, `observations/{observationId}`, `scores`, `scores/{scoreId}`, `v2/scores`, `v2/scores/{scoreId}`, `metrics`, `metrics/daily`, `datasets/{name}/runs`, `datasets/{name}/runs/{runName}`, `dataset-run-items`.
- **DELETE:** `datasets/{name}/runs/{runName}` (`datasets/[name]/runs/[runName].ts:34-43`).
- **Legacy writes:** POST `traces`, `spans`, `generations`, `events`; PATCH `spans`, `generations`.

Not flagged: `v2/observations`, `v3/scores`, `v2/metrics`, `projects`, `health`, POST `scores` (`scores/index.ts:29-31`), so the write probe reaches the role check. DELETE `traces/{traceId}` is not flagged either.

## Prevention

- After every Langfuse bump, re-prove a Viewer key live ([upgrade review](../best-practices/langfuse-upgrade-review-new-tables-outside-retention-2026-11-25.md), step 6). A changed denial text fails the check until `ROLE_DENIAL` is updated.
- Probe a route against the running Langfuse before adding it to the allowlist (`apps/traces/reader-gate/paths.ts:6-9`).
- If the CLI reports `unrecognised-answer`, update the CLI checkout and retry.
- Reader query rules (`v2/metrics` grouping, cursors) are in the runbook's [Consumer contract](../../runbooks/trace-collection.md#consumer-contract).
