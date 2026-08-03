---
title: Egress allowlist on the credential-bearing autoheal job blocked its own health checks
date: 2026-08-03
category: integration-issues
module: fro-bot
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Report-only health curls to kw.igg.ms, metrics.fro.bot, dashboard.fro.bot, broker.fro.bot returned 000 / connection refused"
  - "npx agent-browser open https://kw.igg.ms failed with net::ERR_CONNECTION_REFUSED"
  - "The autoheal filed a false-outage issue (#1026) although every endpoint was up"
  - "DNS resolved for each host but the TLS connection was blocked"
root_cause: incomplete_setup
resolution_type: config_change
related_components:
  - autoheal
  - harden-runner
  - egress
tags:
  - fro-bot
  - harden-runner
  - egress-allowlist
  - fail-closed
  - prompt-injection
  - credential-bearing
  - agent-browser
  - false-outage
---

# Egress allowlist on the credential-bearing autoheal job blocked its own health checks

## Problem

A content/storage job split (PR #1013) moved the daily-autoheal prompt into the `fro-bot-storage` job, which runs under `step-security/harden-runner` with `egress-policy: block`. The allowlist did not include the first-party deploy-health hosts the autoheal probes or the live-site-review browser target, so those report-only checks failed closed and the autoheal misread the block as an outage.

## Symptoms

- `curl --connect-timeout 10 https://kw.igg.ms` (and `metrics.fro.bot`, `dashboard.fro.bot`, `broker.fro.bot`) returned `000` / "Failed to connect ... port 443".
- `npx agent-browser open "https://kw.igg.ms"` → `net::ERR_CONNECTION_REFUSED`.
- `getent hosts` resolved every host correctly — DNS worked; only the TLS connect was blocked.
- The autoheal filed **#1026** "Public endpoints unreachable from scheduled autoheal" even though all endpoints were healthy.

## What Didn't Work

**Removing harden-runner entirely.** The initial fix direction was to delete the egress block, justified as "the storage job runs operator-only triggers (`schedule`/`workflow_dispatch@main`) with a fixed prompt, and `fro-bot/agent` scrubs `AWS_*` from the model environment, so the credentials are unreachable." An independent security review disproved every premise:

- **The autoheal ingests untrusted content mid-run** — it reads issue/PR/comment bodies, other repositories' files, and drives a headless browser to live pages. Indirect prompt injection enters through that content, so an operator-*triggered* run is not a trusted *session*.
- **The job holds `FRO_BOT_PAT` in the model session by design.** `configureGhAuth` writes the PAT into `GH_CONFIG_DIR/hosts.yml` specifically so the env-scrubbed model bash can run `gh`; model bash can `gh auth token` / read `hosts.yml` and exfiltrate it.
- **The AWS/OIDC credentials are reachable via `/proc`.** Env scrubbing (`filter-env.ts` `DENY_PREFIXES = ['AWS_', 'INPUT_']` at the pinned `v0.96.0`) only protects the OpenCode *child*; the parent `fro-bot/agent` action process still holds the credentials, and same-UID descendants can read the ancestor's initial environment via `/proc/<pid>/environ`.

So the storage job is genuinely prompt-injectable and credential-bearing; unrestricted egress would enable arbitrary-host exfiltration. Removal was rejected.

## Solution

**Widen the allowlist; keep `egress-policy: block`** (PR #1029). Add the four first-party health hosts the autoheal legitimately reaches:

```yaml
allowed-endpoints: >-
  api.github.com:443 github.com:443 *.githubusercontent.com:443
  *.actions.githubusercontent.com:443 nodejs.org:443 registry.npmjs.org:443
  cliproxy.fro.bot:443 sts.amazonaws.com:443
  sts.${{ vars.FRO_BOT_S3_REGION }}.amazonaws.com:443 s3.amazonaws.com:443
  s3.${{ vars.FRO_BOT_S3_REGION }}.amazonaws.com:443
  ${{ vars.FRO_BOT_S3_BUCKET }}.s3.${{ vars.FRO_BOT_S3_REGION }}.amazonaws.com:443
  kw.igg.ms:443 metrics.fro.bot:443 dashboard.fro.bot:443 broker.fro.bot:443
```

`npx agent-browser` downloads its binary from `github.com` / `*.githubusercontent.com` (already allowlisted); its live-site target `kw.igg.ms` is now allowlisted.

**Verified live** on run `30797628035` — harden-runner's own endpoint report showed all four health hosts + `cliproxy.fro.bot` as "endpoint called" (none denied), `kw.igg.ms` loaded by the `chrome` process, `EgressPolicy: block` still in force, and the storage path completed with 0 AccessDenied.

## Why This Works

A fail-closed allowlist blocks the TLS connect *after* DNS resolves, so a missing host looks like a connection refusal rather than a policy block. Enumerating every host the agent legitimately reaches makes the allowlist match the job's real network behavior — the report-only checks succeed — while every other destination stays blocked, preserving the exfiltration bound around a credential-bearing, prompt-injectable job.

## Prevention

- **A fail-closed egress allowlist on an agent job must enumerate every host the agent reaches** — health probes, live-site targets, and package/browser-binary downloads. A missing host silently breaks a check and can be misread as an outage.
- **Audit the agent's actual network behavior before tightening egress.** When a job that runs an LLM agent gains egress restrictions, read what the prompt does on the network first.
- **Widen, don't remove.** A credential-bearing, prompt-injectable agent job should keep egress bounded as defense-in-depth; removing the control to fix a functionality break trades a real (if partial) exfil bound for none.
- **A fail-closed allowlist cannot distinguish "blocked by policy" from "endpoint down."** Teach the agent/report to consult the harden-runner block report before declaring an outage.

The honest limit: `api.github.com` is allowlisted and the PAT posts issues, so GitHub itself is an app-layer exfil channel — harden-runner is defense-in-depth, not DLP. It still blocks arbitrary-destination exfiltration, which is why widening beats removing.

## Related Issues

- [`gateway-mention-loop-supervisor-timeout-2026-06-03.md`](gateway-mention-loop-supervisor-timeout-2026-06-03.md) — the fail-closed egress-allowlist precedent: one missing host silently breaks a downstream tool; verify against ground truth.
- [`gateway-mention-loop-model-config-2026-06-04.md`](gateway-mention-loop-model-config-2026-06-04.md) — adjacent "looks like an egress block, verify actual output" lesson.
- [`../best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md`](../best-practices/dedicated-hermetic-aws-child-env-for-cli-subprocess-2026-08-03.md) — sibling credential-boundary lesson from the same rollout (env scrubbing is not process isolation).
- [`agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md`](agent-s3-key-layout-diverged-from-pinned-action-2026-08-03.md) — same durable-storage rollout.
- Issues/PRs: #1026 (false outage), #1013 (the content/storage split), #1029 (fix).
