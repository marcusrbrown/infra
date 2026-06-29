---
title: Gateway mention loop hangs on tool-using prompts (unanswered permission.asked + empty workspace)
date: 2026-06-05
last_updated: 2026-06-28
category: docs/solutions/integration-issues/
module: apps/gateway
problem_type: integration_issue
component: assistant
symptoms:
  - empty "(no output)" message appears immediately in the Discord thread
  - "the task timed out" arrives ~10 minutes later
  - tool-using mentions never complete while no-tool prompts work
  - agent reports "/workspace/repos is empty — No files are available"
root_cause: missing_permission
resolution_type: config_change
severity: high
tags:
  - discord
  - fro-bot
  - gateway
  - opencode
  - permission-asked
  - workspace
  - timeout
---

# Gateway mention loop hangs on tool-using prompts (unanswered permission.asked + empty workspace)

## Problem

The Fro Bot Discord mention loop (`@Fro Bot <prompt>` in a bound channel) failed for any prompt that used tools: the thread showed an immediate empty `(no output)` message, then `The task timed out` ~10 minutes later. A trivial no-tool prompt (`reply with only the word VICTORY`) worked. Two independent root causes were in play — an unanswered OpenCode permission prompt, and an empty workspace because the cloned repo does not survive deploys.

## Symptoms

- Discord thread: `(no output)` immediately, then `The task timed out. Please try again.`
- Gateway logs: `run-core: session created` → `event stream subscribed` → `prompt sent` → `run-core: stream ended due to timeout signal` → `run: execution failed kind:timeout`. `session.idle received` never arrived.
- After the permission fix, the agent ran tools but reported `/workspace/repos is empty — No files are available.`

## What Didn't Work

- **Directory-routing theory.** The first hypothesis was that `session.create` was not threading `directory` (the #766 class of bug). Empirical curl probes through the workspace proxy disproved it: directory routing works in v0.54.1 and the parent session received all 288 events. The body-vs-query framing was an overreach caught during review. Reproduce empirically before filing.
- **Hot-editing the workspace `opencode.json` permission block on the running server.** No effect — the OpenCode server reads permission config at startup, not per session. The change only took effect after a workspace restart.

## Solution

Two fixes plus a recovery step.

### Fix 1 — permission overlay (the hang)

In OpenCode, `external_directory` and `doom_loop` are the only permissions that default to `ask`; everything else defaults to `allow`. A tool-using agent that touches paths outside the project root (the agent explored `/workspace`, `/workspace/repos`, `/`) raises `external_directory` prompts. Nothing answers them in the headless workspace, so the run never emits `session.idle` and the gateway waits out its run timeout.

Add a `permission` block to `WORKSPACE_OPENCODE_CONFIG` (a single-line JSON secret, stored as bare JSON in both the GitHub `gateway` environment secret and local `.env`):

```json
{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}},"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}},"small_model":"anthropic/claude-haiku-4-5-20251001","permission":{"external_directory":"allow","doom_loop":"allow"}}
```

Update the GitHub secret via stdin and the local `.env`, then redeploy the gateway. The workspace must restart for the new permission config to load.

> **Superseded (2026-06-28):** the `permission` block is no longer owned by the secret. Deploy code injects an authoritative policy (`WORKSPACE_PERMISSION_POLICY` in `apps/gateway/src/deploy.ts`) that overwrites whatever `permission` the secret carries. Allowing only `external_directory`/`doom_loop` (as above) left `bash` at OpenCode's default `allow`, so destructive commands never hit the Discord Approve/Deny gate. See `docs/solutions/integration-issues/gateway-bash-approval-default-allow-2026-06-28.md`.

### Fix 2 — the cloned repo does not survive deploys

The workspace container has no persistent volume for `/workspace/repos` (confirmed via `docker inspect`: only secret bind-mounts; the upstream compose declares only a `mitmproxy-certs` named volume, and the workspace service has no `volumes:` block). `/workspace/repos` is therefore ephemeral container filesystem, and every `docker compose up --force-recreate workspace` (i.e. every deploy) wipes the clone. The S3 binding survives but the working tree does not. Tracked upstream as a needed persistent named volume.

### Recovery — re-clone after a stale binding

`/fro-bot add-project` refuses with `already bound` because the S3 binding survived even though the clone was wiped. Delete the binding keys (via Bun's `S3Client` with AWS creds from `.env`; bucket `fro-bot-gateway-fronomenal`, region `us-east-1`):

```
# primary binding
fro-bot-state/discord-gateway/<owner>/<repo>/bindings/repo.json

# by-channel index — delete this too, or add-project creates a new #<repo>-2 channel
fro-bot-state/discord-gateway/_/_/bindings/by-channel/<channelId>.json
```

Then re-run `/fro-bot add-project`; it reclones into `/workspace/repos/<owner>/<repo>`.

### Diagnostic probe that proved the root cause

Drive the workspace OpenCode server directly through `opencode-proxy` (port 9200, bearer from `$WORKSPACE_OPENCODE_TOKEN_FILE`, inside the workspace container):

```
POST /session?directory=<urlenc>
GET  /event?directory=<urlenc>            # background SSE stream
POST /session/{id}/message?directory=<urlenc>
```

Count `permission.asked` vs `session.idle`. Before the fix: 3 `permission.asked`, 0 `session.idle`. After the fix: 0 `permission.asked`, 1 `session.idle`, 363 deltas.

### Temporary debug logging

The gateway `LOG_LEVEL` is a `readOptionalSecret` (`debug|info|warn|error`, default `info`). For a one-off diagnostic, inject `LOG_LEVEL: debug` into the deploy-generated `compose.override.yaml` under `gateway.environment` and recreate only the gateway service. It is ephemeral — regenerated on the next deploy — so restore it afterward.

## Why This Works

Allowing `external_directory` and `doom_loop` removes the only prompts that default to `ask`, so the headless run completes and reaches `session.idle` — the terminal event the gateway's run-core event loop waits for. The repo clone must exist on disk because the agent reads real files; the S3 binding is separate state from the working tree, which is why a surviving binding plus a wiped clone produces a working mention that reports an empty repo.

## Prevention

- Persist `/workspace/repos` with a named volume so deploys stop wiping clones (upstream fix needed; until then, every gateway deploy requires re-running `/fro-bot add-project`).
- Upstream `run-core` should auto-answer `permission.asked` so headless runs never hang regardless of workspace permission config; it should also not post an empty `(no output)` placeholder or omit a progress indicator before timeout.
- After any workspace-config change, re-run the proxy probe and confirm `0 permission.asked` and that `session.idle` fires before declaring the loop fixed.
- When deleting a binding to force a re-clone, delete both the primary and the by-channel keys to avoid stranding the original channel.

## Related Issues

- Upstream `fro-bot/agent#787` — run-core should auto-answer `permission.asked`; plus the empty `(no output)` / no-progress UX defect.
- Upstream `fro-bot/agent#791` — `/workspace/repos` needs a persistent named volume (deploys wipe clones).
- `docs/solutions/integration-issues/gateway-mention-loop-supervisor-timeout-2026-06-03.md` — prior mention-loop no-output cause (workspace OpenCode supervisor readiness timeout, `fro-bot/agent#749`); same symptom family, distinct causal chain.
- `docs/solutions/integration-issues/gateway-mention-loop-model-config-2026-06-04.md` — adjacent mention-loop failure (model/`small_model` config, event-directory routing).
