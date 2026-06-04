---
title: Gateway deploy swap-thrash — on-droplet --build OOMs the 1vCPU/2GB droplet while the old stack runs
date: 2026-06-04
category: docs/solutions/workflow-issues
module: apps/gateway
problem_type: workflow_issue
component: tooling
severity: critical
symptoms:
  - 'Gateway deploy step runs 45+ min still in_progress (normal fresh-ref deploy is ~3-5 min)'
  - 'Droplet load average ~31 on a 1-vCPU box; ~15 MB RAM free; deep in swap'
  - '`docker ps` itself times out on the droplet (too saturated to list containers)'
  - 'Public endpoint (gateway.fro.bot/v1/announce) returns 000 — production down ~50 min'
  - 'SSH connections hang (CPU starvation), risking UFW new-connection rate-limit lockout'
root_cause: config_error
resolution_type: workflow_improvement
related_components:
  - cliproxy
tags:
  - gateway
  - deploy
  - docker-build
  - oom
  - swap-thrash
  - droplet-sizing
  - digitalocean
---

# Gateway deploy swap-thrash — on-droplet `--build` OOMs the 1vCPU/2GB droplet while the old stack runs

## Problem

A `fro-bot/agent` daemon bump (v0.53.1 → v0.54.1) deployed through normal CI sent the gateway
droplet into a swap death-spiral and took production down for ~50 minutes. The deploy never
self-recovered; the box became too saturated to even list its own containers.

## Symptoms

- "Deploy gateway" GitHub Actions step ran 45+ min still `in_progress` (a normal fresh-ref deploy is ~3-5 min).
- Droplet (`s-1vcpu-2gb`) load average **~31** on a single vCPU; **~15 MB** RAM free; deep in swap; load *climbing* (31/22/17 across 1/5/15-min).
- `docker ps` timed out on the droplet — too saturated to respond.
- Public `https://gateway.fro.bot/v1/announce` returned **000** (down) for ~50 min.
- SSH probes hung (CPU starvation); repeated SSH risks UFW's default 6-new-connections/30s lockout.

## What Didn't Work

- **Waiting it out passively.** Load was increasing, not stabilizing — the build was grinding through swap with no path to recovery on a 2 GB box.
- **SSH intervention during the thrash.** The box couldn't run `docker ps`; piling on SSH connections risked a UFW lockout and worsened the thrash. Not attempted past one bounded probe.
- **Trusting the git source dir as the running version.** After recovery, `/opt/gateway/deploy/source` showed `v0.54.1`, but the *running image* was still the old v0.53.1 — see "image vs source ref" below.

## Solution

Two parts: immediate restore, then a clean rebuild in a planned-downtime window.

### 1. Immediate restore (DigitalOcean power-cycle)

```sh
export DIGITALOCEAN_ACCESS_TOKEN=...   # from repo .env
doctl compute droplet-action power-cycle <droplet-id>   # gateway = 571825046
gh run cancel <stuck-deploy-run-id>                     # SSH will be severed anyway
```

The `restart: unless-stopped` policy auto-starts the last successfully-built stack on reboot.
Recovery took **~90 s** (`announce: 000 → 502 booting → 400 live`). Load dropped 31 → 1.67,
free RAM 15 MB → 1190 MB.

### 2. Clean rebuild in a planned-downtime window (run DETACHED)

The thrash happens because `docker compose up -d --build` rebuilds the memory-heavy workspace
image **while the old stack is still running**. Stopping the old stack first frees the RAM:

```sh
# Run detached so an SSH drop / local fork-pressure can't leave it half-done:
setsid bash -c 'nohup /opt/gateway/rebuild.sh > /opt/gateway/rebuild.log 2>&1 &'
# rebuild.sh:
cd /opt/gateway/deploy
docker compose down --remove-orphans          # planned downtime starts
docker compose build                          # full RAM available — no thrash
docker compose up -d --wait --wait-timeout 180 --remove-orphans
```

With the old stack down, the build ran at **load ~2** with full RAM; total downtime ~5 min.

### Confirm the RUNNING image (not the source ref)

```sh
docker inspect fro-bot-gateway-1 --format '{{.Image}}' \
  | xargs docker inspect --format '{{.Created}}'   # build timestamp ≈ now if new
docker exec fro-bot-gateway-1 sh -c \
  "grep -oh 'session.create([^)]*)' /app/packages/gateway/dist/main.mjs"   # code signature
```

## Why This Works

`docker compose up --build` builds the new images first, *then* recreates containers — so the
old stack keeps running (and consuming RAM) throughout the build. On a 2 GB droplet the
gateway + workspace/OpenCode images can't build alongside the running stack without exhausting
memory and thrashing swap. A fresh upstream ref makes it worse: a cold build cache rebuilds far
more layers than a patch bump. Stopping the old stack first removes the RAM contention, so the
identical build completes quickly. The failure mode of `--build` is otherwise *safe* (the old
stack stays up if the build OOMs) — the problem is the build never *finishes* to trigger recreate.

**Image vs source ref gotcha:** the deploy runs `git reset --hard <ref>` early (so the source
dir shows the new ref immediately), but the *running image* only changes after `up` recreates
containers. A power-cycle mid-build returns the **old image** with a **new source dir** — always
verify the running image's build timestamp + code signature, never the git checkout.

## Prevention

- **The next `fro-bot/agent` CI bump WILL re-thrash** — same `--build`-with-old-stack-running path. Fix before the next daemon bump, via one of:
  - **Resize the droplet to ≥4 GB** — simplest; the build gets headroom alongside the running stack. Standing cost increase.
  - **Build off-droplet (GHCR) and pull** — no recurring cost; the droplet only pulls a prebuilt image. Larger change (CI build/push + registry auth).
  - **Stop the old stack before building in `deploy.ts`** — no cost; accepts a planned downtime window per deploy (no safe-failure fallback during the build).
- **Always run a manual recovery rebuild detached** (`setsid`/`nohup` to a logfile) so an SSH drop or local fork-pressure can't abort it half-done.
- **Never SSH-hammer a thrashing droplet** — it can't run `docker ps`, and UFW rate-limits new connections. Use external probes (public endpoint, GitHub run API, `doctl`) which add zero droplet load.

## Related Issues

- `docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md` — the `--build` flag was *added* to fix stale-image reuse; this doc covers the resourcing cost of that build running on an undersized droplet.
- `docs/solutions/integration-issues/gateway-mention-loop-model-config-2026-06-04.md` — the v0.54.1 being deployed here is the `#766` mention-loop fix; this outage was the cutover, not the code.
- `docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md` — earlier gateway deploy-pipeline cascade (different failure class).
