---
title: 'Gateway v0.50.0 undeployable: daemon required secrets its own compose never wired'
date: 2026-06-02
category: workflow-issues
module: gateway
problem_type: workflow_issue
component: tooling
symptoms:
  - 'Gateway container crash-loops on boot: "Missing required secret: GATEWAY_WEBHOOK_SECRET"'
  - Isolated workspace-only preflight passed (false green) while the gateway daemon contract was never exercised
  - Cutover deploy rebuilt the workspace healthy but fro-bot-gateway-1 went unhealthy after --force-recreate
root_cause: incomplete_setup
resolution_type: workflow_improvement
severity: high
related_components:
  - deployment
  - tooling
tags:
  - gateway
  - fro-bot
  - upstream
  - compose
  - secrets
  - crash-loop
  - deployment
---

# Gateway v0.50.0 undeployable: daemon required secrets its own compose never wired

## Problem

Upgrading the `fro-bot/agent` gateway daemon from `v0.46.3` to `v0.50.0` (to enable the workspace-agent mention loop) crash-looped production. The release was self-inconsistent upstream: the daemon hard-required two secrets that the shipped Compose stack never wired into the gateway container, so it was undeployable as shipped — no amount of repo-side secret seeding could satisfy it.

## Symptoms

- Live cutover (gated deploy run `26853064449`, after PR #387 merged `fa4a2b4`): the `workspace` service rebuilt healthy, but `fro-bot-gateway-1` went unhealthy / crash-looped after `--force-recreate`.
- Container log, with every secret the session had already seeded present:
  ```text
  Missing required secret: GATEWAY_WEBHOOK_SECRET
  ```
- A prior **isolated workspace-only preflight** on the droplet had passed and gave false confidence — it only exercised the workspace service, never the gateway daemon's secret contract:
  ```text
  v0.50.0 workspace image built in 203s
  /healthz → ok
  /clone   → 400
  /nope    → 404
  ```

## What Didn't Work

- **Reading `deploy/compose.yaml` alone and treating it as ground truth.** The compose read concluded only `WORKSPACE_OPENCODE_TOKEN` plus a couple of values needed wiring. Compose tells you what is *wired*, not what the daemon *requires*.
- **Seeding "more secrets" on the repo side.** The two required values were not reachable by the container regardless of how they were materialized, because nothing in compose passed them through.
- **Trusting the workspace-only preflight.** A single-service green check does not validate the gateway daemon's boot contract.

## Solution

1. **Filed the upstream defect** `fro-bot/agent#738` with the source-cited daemon-vs-compose mismatch and a suggested fix (wire the two secret files plus matching `_FILE` env into the gateway service, mirroring the existing secret-file pattern).
2. **Reverted the daemon pin** to `v0.46.3` and set the Renovate ceiling to `<0.47.0`.
3. **Restored production** via the real deploy materializer; verified healthy on `v0.46.3` two ways — a local deploy and CI redeploy run `26855044040`.
4. **Corrected infra issue #373** — its earlier "materialize 2 more secrets" checklist was impossible and was replaced with the upstream-blocked reality.
5. Confirmed the new `:3000` announce server is **container-internal (no published host port)**, so no ingress work was needed.

Two local-deploy footguns surfaced while restoring and were fixed with code:

- **PEM `\n` normalization (PR #389).** A local deploy aborts when `.env` lacks `GH_APP_ID` / `GH_APP_PRIVATE_KEY` (they exist only as write-only GitHub Environment secrets). `deploy.ts` writes `GH_APP_PRIVATE_KEY` verbatim to a key file, so a single-line `\n`-escaped PEM in `.env` produced an invalid key. The normalizer unescapes literal `\n` → newline before writing — a no-op for the real-newline CI form, a fix for the single-line `.env` form:
  ```ts
  // before: keyContent written verbatim → single-line \n-escaped PEM is invalid
  // after: unescape literal \n, guarantee trailing newline
  function normalizePemPrivateKey(value: string): string {
    if (!value) return value
    let normalized = value.includes(String.raw`\n`)
      ? value.replaceAll(String.raw`\r\n`, '\n').replaceAll(String.raw`\n`, '\n')
      : value
    return normalized.endsWith('\n') ? normalized : `${normalized}\n`
  }
  ```

- **macOS SSH ControlPath length (PR #391).** The ControlMaster socket was rooted under `os.tmpdir()` = `/var/folders/.../T/` (long); with the `%C` expansion the unix-domain socket path exceeded the 104-byte `sun_path` limit, so ssh exited 255 with `ControlPath too long`. Linux CI (`/tmp`) never hit it. Fix — root the control socket under a short `/tmp` dir on all platforms while keeping the private key in the user-owned `tmpdir()` mode-0600 dir:
  ```ts
  keyTmpDir = mkdtempSync(join(tmpdir(), 'gateway-deploy-key-')) // private key (secure, mode 0600)
  controlTmpDir = mkdtempSync(join('/tmp', 'gw-cm-'))            // control socket (short path)
  const controlPath = join(controlTmpDir, 'cm-%C')
  ```

A co-occurring (unrelated) issue: PR reviews failed while `FRO_BOT_MODEL` was a `gpt-5.x` model — the OpenAI Responses API path (`/v1/responses`) attaches an `image_generation` tool that cliproxy/OpenAI rejected (`image_generation_user_error` / `invalid_value`). Switching `FRO_BOT_MODEL` to `anthropic/claude-sonnet-4-6` (Anthropic chat path, no Responses API) restored reviews.

## Why This Works

For a containerized upstream daemon, the **authoritative source of boot-required secrets is the daemon's own config loader** (its `readSecret` / config-parse code), not the Compose file. Compose tells you what is *wired*; the loader tells you what is *required*.

At tag `v0.50.0`, the daemon loader (`packages/gateway/src/config.ts:361-362`) called the throwing `readSecret('GATEWAY_WEBHOOK_SECRET')` and `readSecret('GATEWAY_PRESENCE_CHANNEL_ID')`. The shipped `deploy/compose.yaml` gateway service wired **neither** — no secret bind-mount, no `environment:` entry, no `env_file:`, no `${}` interpolation. `readSecret` reads env var `NAME` or file `NAME_FILE`; compose supplied neither path. The failure was therefore **structural, not operational**: the release could not boot from its own shipped stack. Editing upstream's compose to add the wiring is a banned pattern here (this repo materializes secrets only; the compose is upstream's), and `v0.50.0` was the latest tag with no patch — so the only correct move was to escalate upstream and hold at the last good pin.

## Prevention

- **Before any gated cutover, diff the daemon config loader's required-secret list against the compose wiring.** The invariant:
  ```text
  REQUIRED secrets (daemon loader readSecret/config-parse)
    ==
  WIRED secrets (compose environment: + *_FILE env + secret mounts + ${} interpolation)
  ```
  If these differ, stop — the release is not deployable as shipped, regardless of how many secrets you seed.
- **An isolated single-service preflight does not validate the daemon's contract.** A green `/healthz` on the workspace service says nothing about the gateway daemon's boot-required secrets. Preflight the service whose contract you're actually changing.
- **PEM guard:** normalize local `.env` PEMs before writing — accept real newlines *and* literal `\n`, and always write a single trailing newline (CI strips trailing whitespace from secrets).
- **ControlPath guard:** keep SSH control sockets under a short `/tmp` path on all platforms; never assume macOS `os.tmpdir()` is short enough for the 104-byte `sun_path` limit.
- **Model-routing guard:** treat `FRO_BOT_MODEL` as a provider/model routing choice. If reviews/tool-calls start failing through cliproxy, check whether the model hits the OpenAI Responses API path (`/v1/responses`, attaches `image_generation`) vs the Anthropic chat path before blaming the gateway.

## Related Issues

- infra #373 — Hold `fro-bot/agent` at v0.46.3 until the workspace agent ships (corrected with this incident's findings).
- upstream `fro-bot/agent#738` — v0.50.0 undeployable: daemon requires `GATEWAY_WEBHOOK_SECRET` + `GATEWAY_PRESENCE_CHANNEL_ID` but compose wires neither.
- [Gateway first deploy: 5-wave cascade](gateway-first-deploy-cascade-2026-05-20.md) — same family (gateway deploy contract drift), distinct incident.
- [Gateway deploys never rebuilt the image](gateway-deploy-stale-image-2026-05-31.md) — adjacent: a stale image masked a broken upstream rebuild; this incident is the inverse (a fresh rebuild exposed the undeployable contract).
- [Major-version upstream upgrade playbook](../best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md) — the probe-first, backup-anchored playbook this incident reinforces.
