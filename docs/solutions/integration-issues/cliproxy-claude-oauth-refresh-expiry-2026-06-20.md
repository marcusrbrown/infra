---
title: Claude OAuth refresh token expiry broke Anthropic-routed CLIProxyAPI requests
date: 2026-06-20
category: docs/solutions/integration-issues/
module: cliproxy
problem_type: integration_issue
component: tooling
symptoms:
  - Scheduled Fro Bot GitHub Actions run failed with HTTP 401 authentication_error
  - "cliproxy /v1/messages returned Invalid authentication credentials for an Anthropic model"
  - "Anthropic-routed requests returned 503 auth_unavailable: no auth available (providers=claude)"
  - OpenAI/Codex requests still succeeded, making the failure look non-global
  - Downstream repo api-keys remained intact, ruling out key loss
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - development_workflow
tags:
  - cliproxy
  - claude
  - oauth
  - refresh-token
  - anthropic
  - auth
  - github-actions
---

# Claude OAuth refresh token expiry broke Anthropic-routed CLIProxyAPI requests

## Problem

Scheduled Fro Bot runs in an Anthropic-routed consumer repo started failing with proxy auth errors even though the repo's downstream bearer key was still valid. The break was in the self-hosted CLIProxyAPI proxy's **upstream** Claude (Anthropic) OAuth credential, not in any downstream repo's key.

## Symptoms

- A scheduled Fro Bot run failed with the agent's HTTP call to `https://cliproxy.fro.bot/v1/messages` returning:
  `401 {"type":"error","error":{"type":"authentication_error","message":"Invalid authentication credentials"}}`
- The session burned through its 3-cycle grace period and exited 1.
- Direct proxy probe with a **valid downstream api-key**:
  - `claude-sonnet-4-6` → `503 "auth_unavailable: no auth available (providers=claude, model=claude-sonnet-4-6); check Claude auth"`
  - `gpt-5.5` → `200` (valid completion)
- Container logs (`cli-proxy-api`):
  - `[anthropic_auth.go] Token refresh attempt 1 failed: token refresh failed with status 400: {"error":"invalid_grant","error_description":"Refresh token not found or invalid"}`
  - `core auth auto-refresh started (interval=15m0s)`
- The proxy auth-dir held a Claude credential file rewritten ~11 minutes before the first failure, and a separate Codex/OpenAI credential file that was still healthy.

## What Didn't Work

- **Checked whether the repo's downstream api-key was dropped** from the proxy's `api-keys` array (a real prior failure class — a deploy once overwrote `config.yaml` and wiped runtime keys). Failed: all api-keys were intact.
- **Pursued a "full-array PUT lost-update"** hypothesis (`cliproxy keys`/`setup --force` do a destructive GET-modify-PUT of the whole array). Failed: keys intact. Also, CLIProxyAPI truncates key name-slugs (e.g. `sk-fro-bot-<owner>-<3chars>…`), so slug text is **not reliable identity** — you cannot tell two repos' keys apart from the management list.
- **Assumed "not global" meant a per-repo cause**, because other repos' Fro Bot runs succeeded in the same window. Misleading: those repos route through OpenAI/Codex (still-valid upstream), while the failing repo routes through Anthropic.
- **Checked `/v0/management/usage-queue`** to correlate the prior-day success with the failure. Empty — no retained history.

## Solution

Re-authenticate Claude on the proxy host. No code change, no deploy.

```bash
bunx @marcusrbrown/infra cliproxy login claude
```

The command runs the Claude OAuth device flow on the remote droplet over SSH:

1. It prints a `claude.ai/oauth/authorize` URL and an optional SSH tunnel command (`ssh -L 54545:127.0.0.1:54545 root@<droplet>`).
2. Authorize in the browser as the proxy's Claude account.
3. The browser redirects to `http://localhost:54545/callback?code=...&state=...`. If you didn't set up the tunnel, paste that full callback URL back at the `Paste the Claude callback URL` prompt (paste-fallback).
4. The flow prints `Claude authentication successful` and writes a fresh Claude credential file to the proxy's auth-dir.

Verification (re-probe with a valid downstream api-key):

- `claude-sonnet-4-6` → `200` (was 503/401)
- `gpt-5.5` → `200`

Then re-trigger the affected repo's Fro Bot to confirm green end-to-end.

The proxy droplet SSH key is operator-local (`~/.ssh/cliproxy_deploy`), not in the repo `.env`.

## Why This Works

The root cause was the proxy's **upstream Anthropic OAuth refresh token expiring/becoming invalid** (`invalid_grant: "Refresh token not found or invalid"`). The proxy authenticates upstream to Anthropic with stored OAuth credentials and auto-refreshes them every 15 minutes; when the refresh fails it leaves no usable Claude credential. From that point every Anthropic-routed downstream call returns `401`/`503 auth_unavailable: providers=claude`. OpenAI/Codex routes kept working because their stored upstream auth was independent and still valid — which is exactly why the failure was scoped to Anthropic-routed repos and looked "not global." The downstream repo's bearer key was never the problem; re-authenticating Claude restores a valid upstream credential and all Anthropic routing recovers at once.

## Prevention

- **Dual-model probe is the fast diagnosis.** Probe the proxy with a valid downstream api-key for both provider families:
  - `claude-*` fails (`auth_unavailable: providers=claude` / 401 / 503) **and** `gpt-*` succeeds → upstream Claude auth is dead → run `cliproxy login claude`.
  - **Both** fail → suspect the downstream key/config or a proxy-wide problem.
  - Only **one repo** fails while same-provider repos work → suspect that repo's downstream key.
- **A "green the day before" run does not prove the bearer still works** — confirm a real successful proxy call (`Completed OpenCode execution, success:true`) when establishing a working→broken timeline.
- **The repository monitor probes the real provider route** — `infra cliproxy monitor` uses the structured Anthropic auth probe behind `cliproxy status` and classifies healthy, definitive auth failure, and transient unknown results without parsing human output. Scheduled execution requires `.github/workflows/cliproxy-auth-monitor.yaml` on the default branch with the required repository secrets configured; GitHub schedule delivery is best-effort at the nominal 15-minute cadence (`7,22,37,52` minutes past the hour).
- **Definitive auth failure has durable transition state** — the monitor opens or reopens the canonical GitHub issue labeled `cliproxy-auth-monitor`, sends one outage notification through the dedicated outbound Discord webhook, and persists a safe notification marker. An open issue means dead provider auth; a closed or absent issue means healthy auth. Unknown or transient probe results preserve issue and notification state, while an active outage receives a safe last-check heartbeat.
- **Recovery is explicit and transition-only** — after `infra cliproxy login claude` succeeds, verify with `infra cliproxy status` and trigger an immediate manual live monitor run. The monitor closes the canonical issue and sends recovery only when the prior notified state was dead. Synthetic validation uses `cliproxy-auth-monitor-test`, is owner-only, and never probes Anthropic or mutates production monitor state.
- **Do not treat CLIProxyAPI api-key slugs as identity** — they are truncated and ambiguous across repos.

## Related Issues

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` — same app, but initial-setup `auth-dir`/config/host-key cascade, not upstream OAuth expiry.
- `docs/solutions/workflow-issues/cliproxy-healthcheck-tooling-migration-2026-06-09.md` — same deploy path, but a broken in-container healthcheck binary, not auth.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — same proxy + OAuth token volume, from the upgrade-playbook angle (back up the auth volume before risky changes).
