---
title: Gateway mention loop empty/no reply — model resolution, small_model, and event-directory chain
date: 2026-06-04
category: docs/solutions/integration-issues
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - 'Discord @fro-bot mention creates a thread but Fro Bot posts no reply'
  - 'workspace OpenCode log: ProviderHeaderTimeoutError ms:10000 stream error, retrying forever'
  - 'cliproxy /v1/responses returns 502 "unknown provider for model <id>" for an unlisted model'
  - 'gateway log ends: session created → prompt sent → "stream ended due to timeout signal"'
  - 'OpenCode stored a complete assistant message (finish:stop, output tokens) but nothing reached Discord'
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - cliproxy
tags:
  - gateway
  - opencode
  - cliproxy
  - mention-loop
  - model-resolution
  - small-model
  - event-stream
  - reasoning-model
---

# Gateway mention loop empty/no reply — model resolution, small_model, and event-directory chain

## Problem

After the gateway daemon reached the model successfully (post-#749 supervisor fix), an
`@fro-bot` mention produced a thread but no reply. Diagnosis peeled back three independent
layers: an invalid main model id, an invalid default `small_model`, and finally an upstream
gateway event-subscription bug that drops the response even when the model answers correctly.

## Symptoms

- Mention thread created, but Fro Bot posts nothing (or "workspace not reachable" / "task timed out").
- Workspace OpenCode: `ERROR service=llm ... ProviderHeaderTimeoutError ms:10000 stream error`, retrying forever.
- A direct `POST cliproxy.fro.bot/v1/responses` for the configured model returns **502 "unknown provider for model <id>"**.
- Gateway log: `run-core: session created → event stream subscribed → prompt sent → stream ended due to timeout signal` — no reply, no error.
- The OpenCode session API (`GET /session/{id}/message`) shows a **complete** assistant message (`finish:"stop"`, non-zero output tokens, a `text` part with the answer) — proving the model worked.

## What Didn't Work

- Assuming the failure was the v0.53.1 supervisor (#749). It was fixed — runs reach `prompt sent`.
- Assuming mitmproxy broke the streaming Responses API. Disproven: gpt-5.5 streaming was **byte-identical** direct vs through mitmproxy (same SSE frames, same answer).
- Assuming the model itself returns empty. Disproven: the model produced the answer (stored in OpenCode; `finish:stop`).
- Assuming the `gpt-5-nano` title-gen 502 was an egress block. Disproven: mitmproxy logged **zero** blocked hosts; the request reached cliproxy (`via: Caddy`) and got "unknown provider".
- Reproducing the run with `POST /session/{id}/prompt` — that path returns the OpenCode **web-UI HTML** (SPA fallback). The real prompt route is `POST /session/{id}/message`.

## Solution

Three config-level fixes, applied to the deploy `.env`, the local `.env`, and the GitHub
`gateway` environment secrets (so they survive redeploys):

1. **Main model must be a real cliproxy `/v1/models` id.**
   `WORKSPACE_OPENCODE_MODEL=openai/gpt-5.5-fast` → **`openai/gpt-5.5`**.
   `gpt-5.5-fast` is not in the catalog (502); `gpt-5.5` returns 200. Validate first:
   ```sh
   OKEY=$(bun --env-file=.env -e 'process.stdout.write(JSON.parse(process.env.WORKSPACE_OPENCODE_AUTH).openai.key)')
   curl -s https://cliproxy.fro.bot/v1/models -H "Authorization: Bearer $OKEY" | jq '.data[].id'
   ```

2. **Override OpenCode's default `small_model`** (used for title generation) to a real cliproxy model.
   OpenCode's default small model is `gpt-5-nano`, which routes through the `openai`→cliproxy
   baseURL overlay and 502s ("unknown provider"). Add to `WORKSPACE_OPENCODE_CONFIG`:
   ```json
   { "provider": { "...": "..." }, "small_model": "anthropic/claude-haiku-4-5-20251001" }
   ```

3. **The real mention-loop blocker is upstream** (`fro-bot/agent#766`): `run-core.ts` creates the
   OpenCode session with **no directory** (it roots at the default cwd `/workspace/repos`) but
   subscribes to `/event` **filtered to the repo subdir** — so the gateway receives none of the
   session's events and times out. No infra-side config fixes this; tracked via smart note until a
   patched tag ships.

## Why This Works

`readSecret`/provider routing sends any `openai/*` model id to the overlaid cliproxy baseURL.
cliproxy only serves the ids in its `/v1/models` catalog (the proxied subscription models); an
unlisted id (`gpt-5.5-fast`, `gpt-5-nano`) yields a 502 that OpenCode surfaces as an infinite
`ProviderHeaderTimeoutError` retry (no usable assistant text → empty run). Picking ids that exist
in the catalog makes both the main and small model calls succeed.

The #766 directory mismatch is proven by an A/B capture of the same gpt-5.5 run: an **unfiltered**
`/event` subscription received `message.part.delta` + `session.idle` + the reply text, while the
**subdir-filtered** subscription (the gateway's exact pattern) received only heartbeats.

## Prevention

- **Validate every workspace/CI model id against `/v1/models` before setting it.** An unresolvable
  id does not error cleanly — it 502s and OpenCode retries silently, producing an empty run.
- **Always set an explicit `small_model`** in any OpenCode config that overlays the `openai`
  provider to a custom proxy — otherwise the `gpt-5-nano` default is misrouted to the proxy and 502s.
- **When a run "succeeds" but nothing posts, check the consumer's event subscription, not the model.**
  Confirm the model's output via `GET /session/{id}/message` (route: `POST /session/{id}/message`
  to send) before blaming the model/transport.
- The diagnostic order that works: supervisor ready? → model in catalog? → egress allowed (mitmproxy
  blocked list)? → did the model store output? → did the consumer receive the events?

## Related Issues

- `fro-bot/agent#766` — gateway run-core subscribes to an event stream filtered to a directory the session isn't rooted at (the real mention-loop blocker).
- `fro-bot/agent#749` — workspace-agent OpenCode supervisor cold-boot timeout (fixed in v0.53.1; prerequisite for reaching the model).
- `docs/solutions/integration-issues/gateway-mention-loop-supervisor-timeout-2026-06-03.md` — the prior layer (supervisor) of the same mention-loop arc.
- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md` — sibling gateway integration learning.
