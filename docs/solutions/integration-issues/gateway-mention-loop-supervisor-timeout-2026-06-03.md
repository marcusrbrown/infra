---
title: Gateway @fro-bot mention loop fails across egress-allowlist and OpenCode supervisor layers
date: 2026-06-03
category: docs/solutions/integration-issues/
module: gateway
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - 'Discord reply: "The workspace is not reachable right now."'
  - 'Gateway log: Session create failed: Bad Gateway (kind: unreachable)'
  - 'Workspace log: opencode server did not become ready within 15000ms'
  - 'Workspace log: opencode-server process exited {code:null}'
  - 'opencode-proxy: upstream error connect ECONNREFUSED 127.0.0.1:54321'
root_cause: async_timing
resolution_type: config_change
related_components:
  - mitmproxy
  - workspace-agent
  - opencode
tags:
  - gateway
  - discord
  - opencode
  - mitmproxy
  - egress-allowlist
  - supervisor-timeout
  - upstream-escalation
  - integration-failure
---

# Gateway @fro-bot mention loop fails across egress-allowlist and OpenCode supervisor layers

## Problem

After cutting the gateway daemon over to `fro-bot/agent` v0.52.1, `/fro-bot add-project` cloning worked end-to-end, but an authorized `@fro-bot <prompt>` mention failed with "The workspace is not reachable right now." The failure was **two distinct, stacked layers** behind a single user-visible symptom: a workspace egress-allowlist gap (fixable on our side) and an upstream `workspace-agent` OpenCode-supervisor robustness bug (not fixable from the deploy side). One layer was necessary but not sufficient to explain the failure — diagnosing it required peeling them apart on the live droplet.

## Symptoms

- Discord: `The workspace is not reachable right now.`
- Gateway log: `{"level":"error","kind":"unreachable","err":"Session create failed: Bad Gateway\n","msg":"run: execution failed"}`
- Workspace log: `opencode server did not become ready within 15000ms` → `opencode-server: process exited { code: null }` → `opencode-proxy: upstream error { message: 'connect ECONNREFUSED 127.0.0.1:54321' }`
- `/healthz` (workspace-agent on :9100) reports `{"ok":true,"opencode":"starting"}` **indefinitely** — never flips to `ready` or `down`.
- `/fro-bot add-project` (repo clone) **works** — only the mention loop is broken.

The misleading signal: OpenCode itself is healthy. Run `opencode serve` standalone inside the same container and it becomes ready in ~10s. So this looked like a network/runtime problem, not a supervisor problem.

## Architecture (for context)

A 3-service Docker Compose stack on a DigitalOcean droplet (`gateway.fro.bot`), upstream `fro-bot/agent` v0.52.1:

- **gateway** — Discord bot daemon; on an authorized mention it asks the workspace to create an OpenCode session.
- **workspace** — runs `workspace-agent` (Hono) on `:9100` (`/healthz`, `/clone`) plus an `opencode-proxy` bearer proxy on `:9200` that forwards to a locally-spawned `opencode serve` on `127.0.0.1:54321`. On `sandbox-net` (`internal: true`) — **no direct egress**.
- **mitmproxy** — the workspace's mandatory egress proxy, dual-homed on `sandbox-net` + `egress-net`, enforcing a **fail-closed** host allowlist via `WORKSPACE_EGRESS_HOSTS` / `OBJECT_STORE_HOSTS`.

## What Didn't Work

Four reasonable hypotheses, all wrong — each ruled out empirically:

1. **"The `models.dev` allowlist fix will solve it."** It was **necessary but not sufficient**. After allowing `models.dev`, the mention still failed — the supervisor bug was underneath.
2. **"Cold catalog cache → a warm restart fixes it."** `docker compose restart workspace` preserves the container's disk cache, but the workspace stayed `starting` for 36s+. Disproved the caching theory.
3. **"`HTTP_PROXY` poisons the agent's loopback readiness fetch."** Tested directly: `node -e "fetch('http://127.0.0.1:54321/')"` returns `200`. Undici does not auto-route loopback through `HTTP_PROXY`, and `NO_PROXY` includes `127.0.0.1`. Disproved.
4. **"`:54321` returned 200 once, so OpenCode is fine."** That was a transient boot window. A process probe afterward (`ps` shows only `workspace-agent` PID 1, zero `opencode` processes; `:54321` empty) proved the supervisor killed OpenCode at the 15s deadline and never respawned it.

Context: the earlier v0.51.0 egress topology bug (mitmproxy on internal-only `sandbox-net` → `502 CONNECT tunnel failed` on all egress) was already fixed by the v0.52.1 cutover, which dual-homes mitmproxy. That fix is why `add-project` now reaches the clone at all (see `gateway-v0500-undeployable-upstream-2026-06-02.md` for the adjacent upstream-contract lesson).

## Solution

### Layer 1 — `models.dev` egress allowlist (shipped, our fix)

OpenCode fetches its model catalog from `models.dev` at startup. The workspace allowlist only had `cliproxy.fro.bot`, so mitmproxy logged `[allowlist] BLOCKED connect host=models.dev` and OpenCode could not finish starting. Fix in `apps/gateway/src/deploy.ts` (`buildGatewayEnvFileContents`):

```ts
// before
WORKSPACE_EGRESS_HOSTS=${CLIPROXY_EGRESS_HOST}            // = cliproxy.fro.bot

// after
const OPENCODE_CATALOG_HOST = 'models.dev'
WORKSPACE_EGRESS_HOSTS=${CLIPROXY_EGRESS_HOST},${OPENCODE_CATALOG_HOST}   // = cliproxy.fro.bot,models.dev
```

### Layer 2 — upstream `workspace-agent` supervisor bug (escalated, not fixable here)

`apps/workspace-agent/src/opencode-server.ts` at v0.52.1 supervises `opencode serve` with **four compounding defects**:

1. **Hardcoded 15s readiness timeout, no override.** `readyTimeoutMs = 15_000` default; `main.ts` passes no override and there is no env var anywhere to change it.
2. **Readiness probe has no per-attempt timeout.** `defaultPollReady(url)` does `await fetch(url, {signal})` with `signal === undefined`. A probe that connects but doesn't get a response can hang with no deadline of its own → the supervisor sits in `starting` **forever** (never `ready`, never `down`). This is the paradox-breaker for "live port + stuck-starting + never-down."
3. **One-shot — no retry/respawn.** `main.ts` does `.then(status='ready').catch(status='down')`. A single transient cold-boot overrun permanently disables the mention loop until the container is recreated.
4. **`/healthz` masks a dead OpenCode.** It returns `200` as long as the Hono agent is up, so the gateway keeps routing mention runs to a workspace whose OpenCode is permanently dead.

Escalated as `fro-bot/agent#749` with the minimal fix surface: per-probe `AbortController` timeout + configurable `readyTimeoutMs` (default 60–120s) + retry/respawn + process-group kill + a `/readyz` that reflects OpenCode-down.

## Why This Works

`models.dev` was the missing allowlist entry — a hard OpenCode startup dependency, independent of provider routing. Allowing it lets OpenCode get past the catalog fetch.

But the deeper break is timing under the supervisor. OpenCode is healthy (`opencode serve` standalone → ready in ~10s), yet the **first cold boot at container-create** races with entrypoint work (mitmproxy-CA install, auth provisioning, git clone) plus the now-permitted `models.dev` catalog fetch over the proxied egress path. That pushes first-ready past the hardcoded 15s deadline; the supervisor SIGTERMs OpenCode (`process exited {code:null}`) and — being one-shot — never respawns it. Meanwhile `/healthz` keeps saying `starting`, so the gateway keeps sending mention runs that are guaranteed to fail with `Bad Gateway`.

So: Layer 1 is required for OpenCode to start at all; Layer 2 is why it still doesn't stay up under the managed supervisor on a cold boot. Both had to be understood before the user-visible symptom made sense.

## Prevention

Reusable diagnosis sequence for "workspace is not reachable" on this gateway:

1. **Correlate process + socket ownership** (orphan vs agent-owned, hung connection):
   ```bash
   docker exec <ws> ps -eo pid,ppid,stat,etime,args | grep -E 'opencode|workspace-agent'
   docker exec <ws> sh -c '(ss -tanp || netstat -tanp) | grep 54321'
   ```
2. **Measure real readiness time** standalone vs the managed window:
   ```bash
   docker exec <ws> sh -c 'cd /workspace/repos && opencode serve --hostname 127.0.0.1 --port 54322 & \
     S=$(date +%s); until curl -s -o /dev/null --noproxy 127.0.0.1 http://127.0.0.1:54322/; do sleep 1; done; \
     echo "ready_after=$(( $(date +%s) - S ))s"'
   ```
3. **Watch mitmproxy for allowlist gaps** — the smoking gun for egress-blocked startup deps:
   ```bash
   docker logs <mitmproxy> 2>&1 | grep -iE 'BLOCKED|ALLOWED connect'
   ```
4. **Rule out proxy poisoning** of a loopback probe (don't assume it):
   ```bash
   docker exec <ws> sh -c "node -e \"fetch('http://127.0.0.1:54321/').then(r=>console.log(r.status)).catch(e=>console.log(e.message))\""
   ```
5. **Remember the paradox-breaker:** live port + stuck `starting` + never `down` ⇒ the readiness probe has no per-attempt timeout and/or the supervisor never respawns. A health endpoint that only checks the supervising process (not the supervised child) will lie.

Standing guidance:
- A **fail-closed egress allowlist** means every external host an embedded tool needs at startup (model catalogs, package registries, auth endpoints) must be explicitly listed. Enumerate them deliberately — one missing host silently breaks a downstream tool.
- **Daemon/child liveness ≠ supervisor liveness.** When a health endpoint reports the wrapper rather than the wrapped process, a green check can mask a dead service. Verify the actual port, not just `/healthz`.
- The `models.dev` allowlist entry is permanent in the materializer (`WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev`), so it survives every deploy. The mention loop stays degraded until `fro-bot/agent#749` ships the supervisor fix; **hold v0.52.1, do not roll back** (`add-project` and the gateway core are healthy).

## Related Issues

- `docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md` — adjacent upstream-contract lesson (daemon required-secrets vs compose wiring at v0.50.0). Different defect, same verify-at-the-tag discipline.
- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — gateway upstream pinning + rebuild verification.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — first-deploy cascade for the same deploy stack.
- `docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md` — probe-first upstream-upgrade discipline.
- Upstream: `fro-bot/agent#741` (egress topology, closed/shipped in v0.52.1), `fro-bot/agent#749` (supervisor robustness, open).
- Infra: `#373` (gateway daemon hold, closed), `#341` (v0.46.1 GitHub App + add-project adoption, closed).
