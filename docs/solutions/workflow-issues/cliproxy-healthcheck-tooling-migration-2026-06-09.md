---
title: 'A healthcheck that depended on the app image: an upstream alpine to debian base migration removed wget and broke deploys'
problem_type: workflow_issue
component: development_workflow
root_cause: missing_tooling
resolution_type: workflow_improvement
severity: medium
date: 2026-06-09
tags: [cliproxy, docker-compose, healthcheck, debian, alpine, wget, deploy, upstream]
module: apps/cliproxy
related_issues: []
related_docs:
  - docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md
  - docs/solutions/workflow-issues/gateway-deploy-stale-image-2026-05-31.md
  - docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md
  - docs/solutions/workflow-issues/gateway-v0500-undeployable-upstream-2026-06-02.md
  - docs/solutions/best-practices/major-version-upstream-upgrade-playbook-2026-05-29.md
---

# A Healthcheck That Depended on the App Image's Toolchain

## Context

The cliproxy Docker Compose stack gated deploys on the `cli-proxy-api` container's
Docker healthcheck:

```yaml
healthcheck:
  test: [CMD, wget, --spider, -q, 'http://localhost:8317/healthz']
```

`apps/cliproxy/src/deploy.ts` runs `docker compose up -d --wait --wait-timeout 90`,
which blocks until every service with a healthcheck reports healthy.

Upstream `eceasy/cli-proxy-api` v7.1.54 migrated its image base from `alpine:3.23`
to `debian:bookworm`. Alpine bundles BusyBox, which provides a `wget` applet, so the
healthcheck worked for every release through v7.1.53. The Debian base ships no
`wget`, `curl`, `busybox`, or `nc` — it installs only `tzdata` and `ca-certificates`.
On v7.1.54+ the healthcheck command's binary no longer exists in the image.

## Symptoms

- `docker compose up -d --wait --wait-timeout 90` timed out and the deploy exited 1.
- `docker inspect` health log showed: `OCI runtime exec failed: exec: "wget":
  executable file not found in $PATH` (observed `FailingStreak: 27`).
- The container reported `Up (unhealthy)` while `https://cliproxy.fro.bot/healthz`
  returned `200 {"status":"ok"}` and the management API returned `200` the entire time.

The misleading part: the **server was healthy**. Only the healthcheck **command**
was broken. The deploy failed because `--wait` waits for a `healthy` status that a
missing binary can never produce.

## What Didn't Fully Work

Rolling the pin back to v7.1.50 (the stopgap) restores deployability — but only
because v7.1.50 is the **alpine** base where BusyBox `wget` still exists. It is a
symptom fix: it strands the deployment on a pre-v7.1.54 version permanently, and
every future Debian-based release re-breaks identically. Useful as an emergency
stopgap, not a durable fix.

## Guidance

Do not put an HTTP healthcheck inside a minimal app container whose toolchain you
do not control. An upstream base-image change can silently remove the probe binary
while the server stays perfectly healthy.

Instead, move the probe to a sidecar that already ships HTTP tooling and have it
probe the backend across the compose network:

- Remove the healthcheck from the minimal backend container; keep `restart: unless-stopped`.
- Add the healthcheck to a tool-bearing sidecar (here, `caddy:*-alpine`, which has `wget`).
- Point the sidecar's probe at the backend by its compose service name.
- Add `depends_on: <backend>: condition: service_started` (NOT `service_healthy` —
  the backend no longer has a healthcheck, so `service_healthy` would be invalid).
- Keep an app-level post-deploy HTTP probe (deploy.ts hits `/v0/management/config`)
  as defense-in-depth.

`docker compose up -d --wait` then gates on the sidecar being healthy, which —
because the sidecar's probe targets the backend — transitively proves the backend
is serving. The probe lives in an image whose toolchain is stable across upstream
backend base-image changes.

## Why This Matters

A container can be healthy at the application layer yet fail at the Docker
healthcheck layer because the probe binary disappeared upstream. If the probe lives
inside the app image, the deploy gate is hostage to the upstream maintainer's base-image
choices. Moving the probe to a sidecar you control makes health-gating version-agnostic.

This also reinforces a recurring lesson across this repo's deploy docs: a
`docker compose up --wait` result can lie about *why* it passed or failed — it can
pass on a stale image (see `gateway-deploy-stale-image-2026-05-31.md`) or fail on a
healthy server with a broken probe (this doc). Always verify live state, and gate on
a probe whose tooling you control.

## When to Apply

- An upstream image change removes shell/network tools from the runtime image.
- Docker healthchecks start failing with `executable file not found`.
- The app endpoint is up (200) but `docker compose --wait` times out.
- You want health-gating without bloating the app image with extra tooling.
- You need a probe that survives upstream base-image migrations.

## Examples

### Broken (probe binary lives in the app image)

```yaml
services:
  cli-proxy-api:
    image: eceasy/cli-proxy-api:v7.1.56@sha256:0e7daf45...
    healthcheck:
      test: [CMD, wget, --spider, -q, 'http://localhost:8317/healthz']
```

On the Debian image, `wget` is absent → `exec: "wget": executable file not found`
→ container `unhealthy` → `--wait` times out → deploy fails, even though the proxy
serves 200.

### Durable (sidecar probes the backend over the compose network)

```yaml
services:
  cli-proxy-api:
    image: eceasy/cli-proxy-api:v7.1.56@sha256:0e7daf45...
    restart: unless-stopped
    # no healthcheck — the minimal Debian image has no in-container HTTP probe tool

  caddy:
    image: caddy:2.11.3-alpine@sha256:86deaf5e...
    depends_on:
      cli-proxy-api:
        condition: service_started
    healthcheck:
      test: [CMD, wget, --spider, -q, 'http://cli-proxy-api:8317/healthz']
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

### Diagnostics that pinpoint the failure

```bash
# Exact failing command + output (shows "wget: executable file not found")
docker inspect <container> --format '{{json .State.Health}}'

# Confirm the binary is gone from the image
docker exec <container> sh -c 'which wget || echo NO_WGET'

# Prove the server is actually up (healthcheck-independent)
curl -i http://localhost:8317/healthz

# Confirm the FROM line at the suspect tag
curl -s https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/v7.1.56/Dockerfile | grep -i '^FROM'
```

### Verified result

- Backend runs on the Debian image (v7.1.56).
- Sidecar (Caddy) healthcheck passes (`failingStreak=0`), probing the backend.
- `cli-proxy-api` runs with no healthcheck (by design).
- Public `/healthz` returns 200; management API returns 200.
- The deploy `--wait` gates on the sidecar, not a broken app-image probe.

## References

- PR #463 — stopgap rollback to v7.1.50 (alpine) to restore deployability.
- PR #469 — durable fix: move the healthcheck to the Caddy sidecar, return the pin to v7.1.56.
- Upstream Dockerfile: `FROM alpine:3.23` at v7.1.50 vs `FROM debian:bookworm` at v7.1.55+.
