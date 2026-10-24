---
title: Gateway mention loop stalls — layered causes (supervisor timeout, model config, permission prompts, wiped clones)
date: 2026-06-03
last_updated: 2026-10-23
category: docs/solutions/integration-issues/
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - 'Discord reply: "The workspace is not reachable right now."'
  - Mention creates a thread but Fro Bot posts nothing, or posts "(no output)" and then "The task timed out"
  - "Workspace log: opencode server did not become ready within <N>ms"
  - Agent reports /workspace/repos is empty, or /fro-bot add-project refuses with "already bound"
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - workspace-agent
  - opencode
  - cliproxy
  - mitmproxy
tags:
  - gateway
  - discord
  - opencode
  - mention-loop
  - supervisor-timeout
  - permission-asked
  - workspace
  - troubleshooting
---

# Gateway mention loop stalls — layered causes

## Problem

An authorized `@fro-bot <prompt>` mention (or an operator run) never completes, or the workspace refuses it. In June 2026 this one symptom hid four independent causes, peeled apart one at a time. This doc replaces the three per-incident write-ups and keeps what still holds: the timeline, where each fix lives today, and a diagnosis order.

## Timeline

Each layer was necessary but not sufficient; fixing one exposed the next.

| Layer | Symptom | Cause | Where the fix lives now |
| --- | --- | --- | --- |
| 1. Egress | OpenCode never finishes starting | `models.dev` (OpenCode's catalog fetch) missing from the fail-closed mitmproxy allowlist | `OPENCODE_CATALOG_HOST` in `apps/gateway/src/deploy.ts:226`, appended to `WORKSPACE_EGRESS_HOSTS` in `buildGatewayEnvFileContents` (`apps/gateway/src/deploy.ts:1169`) |
| 2. Supervisor | `Session create failed: Bad Gateway`; workspace stuck `starting` | `workspace-agent` supervised `opencode serve` with a hard 15s ready deadline, no per-probe timeout, no respawn, and a `/healthz` that stayed green with OpenCode dead (at the time, v0.52.1) | Fixed upstream (`fro-bot/agent#749`, closed). Deadline is now operator-tunable via `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` |
| 3. Model config | Thread with no reply; OpenCode retrying `ProviderHeaderTimeoutError` | A model id absent from cliproxy `/v1/models` returns 502 "unknown provider"; OpenCode retries silently | Operator-owned secrets (see Diagnosis step 4) |
| 3b. Event routing | Model answered (stored in OpenCode) but nothing reached Discord | Gateway `run-core` subscribed to `/event` filtered to a directory the session wasn't rooted at | Fixed upstream (`fro-bot/agent#766`, closed) |
| 4. Permissions | Immediate "(no output)", then "task timed out" ~10 min later; tool-using prompts only | `external_directory` / `doom_loop` default to `ask`; nothing answers `permission.asked` in a headless workspace, so `session.idle` never fires | Deploy-owned `WORKSPACE_PERMISSION_POLICY` (`apps/gateway/src/deploy.ts:373`), injected over the secret's `permission` block at `apps/gateway/src/deploy.ts:1132`. Policy and rationale: [gateway-bash-approval-default-allow-2026-06-28.md](./gateway-bash-approval-default-allow-2026-06-28.md). Upstream `fro-bot/agent#787` (auto-answer / empty-placeholder UX) is closed |
| 5. Empty workspace | Agent says the repo dir is empty; `add-project` says `already bound` | The clone was ephemeral container filesystem and every deploy recreated the workspace, while the S3 binding survived | `workspace-repos` named volume mounted at `/workspace/repos` (`apps/gateway/src/deploy.ts:1744`). Upstream `fro-bot/agent#791` is closed |

Details worth keeping:

- **Supervisor knob.** Absent or empty `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` uses the upstream default; otherwise the deploy validates it (positive integer, ceiling `READY_TIMEOUT_MAX_MS` at `apps/gateway/src/deploy.ts:960`), writes it to the remote `.env` (`apps/gateway/src/deploy.ts:1167`), and the compose override passes it to the workspace container (`apps/gateway/src/deploy.ts:1742`). It is no longer true that no override exists, and holding an old upstream tag is no longer the answer; the gateway moves with the pin in `apps/gateway/upstream.json`.
- **Model config.** The deploy checks only that `WORKSPACE_OPENCODE_MODEL` is shaped `provider/model` (`MODEL_ALLOWLIST_RE`, `apps/gateway/src/deploy.ts:357`) and that the provider `baseURL` is https, ends in `/v1`, and routes through cliproxy. It does not check the id exists in the catalog. Nothing in deploy code sets `small_model`; if one is present it came from the `WORKSPACE_OPENCODE_CONFIG` secret. In 2026 the observed trap was OpenCode's default small (title-generation) model being misrouted through the cliproxy overlay and 502ing, which an explicit `small_model` avoided.
- **Permissions.** The June fix (allow `external_directory` and `doom_loop` in the secret) made runs complete but left `bash` ungated. That config guidance is superseded; do not reintroduce it in the secret.
- **Wiped clones.** Checkouts now survive redeploys. Only `docker compose down -v` or `docker volume prune` destroys them (`apps/gateway/AGENTS.md`, anti-patterns). A stale binding with a missing clone is now an abnormal state worth investigating, not routine post-deploy cleanup.

## Diagnosis checklist

Work top-down; each step rules out one layer.

1. **`bunx @marcusrbrown/infra gateway status`** — service states plus the `Workspace memory` block: limit, usage, OOM kills, restarts, and OpenCode state from the workspace `/readyz` (`starting`, `ready`, `down`, `degraded`, `skipped`, `unknown`). `skipped` means the probe was deliberately not run near the memory limit. See [Workspace memory](../../../apps/gateway/AGENTS.md) in `apps/gateway/AGENTS.md`.
2. **`gateway logs workspace --tail 200`** — look for `did not become ready within`, `process exited`, `ECONNREFUSED 127.0.0.1:54321`, or an OOM-driven restart. Raise `WORKSPACE_OPENCODE_READY_TIMEOUT_MS` only if cold boot is genuinely slow.
3. **`gateway logs mitmproxy`** — `[allowlist] BLOCKED connect host=…` means a startup dependency is missing from `WORKSPACE_EGRESS_HOSTS` / `OBJECT_STORE_HOSTS`.
4. **Model resolution** — query cliproxy `/v1/models` with the workspace key and confirm `WORKSPACE_OPENCODE_MODEL` (and any `small_model`) appears. An unresolvable id 502s and OpenCode retries silently, giving an empty run.
5. **`gateway logs gateway`** — the run-core sequence `session created` → `event stream subscribed` → `prompt sent` → `session.idle received`. Ending at `stream ended due to timeout signal` with a stored assistant message means an event-routing problem; ending with `permission.asked` and no reply means an unanswered prompt.
6. **Probe the workspace OpenCode directly** — from inside the workspace container, drive `opencode-proxy` (port 9200, bearer from `$WORKSPACE_OPENCODE_TOKEN_FILE`): `POST /session?directory=…`, `GET /event?directory=…`, `POST /session/{id}/message?directory=…` (the prompt route is `/message`; `/prompt` returns the web-UI HTML). Count `permission.asked` against `session.idle`.
7. **Check the checkout** — confirm the repo exists under `/workspace/repos/<owner>/<repo>` on the `fro-bot_workspace-repos` volume. If a binding is stale and the clone is gone, delete both the primary binding key and the by-channel index key in S3 before re-running `/fro-bot add-project`, or it creates a duplicate `#<repo>-2` channel.
8. **A run stuck `running` after the workspace died** — a workspace OOM kill or OpenCode crash mid-run leaves the run `running` indefinitely. Recover with `docker compose restart workspace` on the droplet, then cancel the run from its card. Tracked as `fro-bot/agent#1922` (open).

## Prevention

- A fail-closed egress allowlist means every host an embedded tool needs at startup must be listed explicitly. A missing one looks like a hung process, not a network error.
- A health endpoint that checks the supervisor rather than the supervised child lies. Trust `/readyz` OpenCode state, and when in doubt verify the actual port.
- Validate model ids against `/v1/models` before putting them in a secret. Deploy validation will not catch an id the catalog doesn't serve.
- Keep security-relevant OpenCode policy in reviewed deploy code, not in `WORKSPACE_OPENCODE_CONFIG`. Relaxing permissions to fix a hang can silently disable a gate.
- Workspace config is read at OpenCode startup. Hot-editing the config on a running workspace has no effect; deploy or restart the workspace.
- Reproduce a suspected routing bug empirically before filing upstream. The first hypothesis for the hang (directory routing, as in #766) was wrong the second time around.
- Never run `docker compose down -v` or `docker volume prune` on the gateway stack.

## Related

- [gateway-bash-approval-default-allow-2026-06-28.md](./gateway-bash-approval-default-allow-2026-06-28.md) — current home of the permission policy.
- `apps/gateway/AGENTS.md` — deploy flow, `WORKSPACE_OPENCODE_READY_TIMEOUT_MS`, workspace memory limit and `gateway status` block, volume anti-patterns, pin rollback.
- [gateway-operator-repos-unmounted-and-keyless-bindings-2026-06-24.md](./gateway-operator-repos-unmounted-and-keyless-bindings-2026-06-24.md) — adjacent binding and fail-closed gating.
- Upstream `fro-bot/agent`: #741 (egress topology, closed), #749 (supervisor, closed), #766 (event directory, closed), #787 (permission auto-answer, closed), #791 (persistent volume, closed), #1922 (run stays `running` after workspace OpenCode dies, open).
- No standalone workspace memory-limit solution exists yet; the operational reference is the `Workspace memory` section of `apps/gateway/AGENTS.md`.
