---
title: Unpruned containerd image store filled the cliproxy disk and a truncated OAuth file took Claude down
date: 2026-10-31
module: apps/cliproxy
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "deploy-cliproxy failed at docker compose pull with mkdir /var/lib/containerd/io.containerd.content.v1.content/ingest/...: no space left on device"
  - "Root disk at 100% while docker system df showed far less usage"
  - "cliproxy Caddy container unhealthy: OCI runtime exec failed: write /tmp/runc-process…: no space left on device"
  - "After a redeploy, /v1/models listed no anthropic models and every Claude request returned 400 model_not_found: unknown provider for model claude-sonnet-4-6"
root_cause: missing_workflow_step
resolution_type: code_fix
tags: [cliproxy, docker, containerd, disk-full, image-prune, oauth, deploy, broker]
related_components:
  - development_workflow
---

# Unpruned containerd image store filled the cliproxy disk and a truncated OAuth file took Claude down

## Problem

The cliproxy droplet's 25 GB root disk filled up because its containerd image store was never pruned. With the disk full, CLIProxyAPI's token-refresh rewrite left the Claude OAuth auth file at 0 bytes. The next deploy restarted the container, the credential did not load, and every Claude consumer (gateway runs, PR reviews, daily runs) got `400 model_not_found` for about 21 minutes.

## Symptoms

- Issue #1726: the `deploy-cliproxy` job in run 41076567511 (2026-10-30 15:00Z) failed at `docker compose pull` with `mkdir /var/lib/containerd/io.containerd.content.v1.content/ingest/...: no space left on device`. It was deploying the v8.0.48 bump ([PR #1717](https://github.com/marcusrbrown/infra/pull/1717)).
- Root disk at 100%. Docker on that host uses the containerd image store (`driver-type: io.containerd.snapshotter.v1`):
  - `/var/lib/containerd` held 17 GB.
  - `/var/lib/docker` held 283 MB.
  - The systemd journal added 2 GB.
- `docker system df` under-reports usage on the containerd store.
- The cliproxy Caddy container showed `unhealthy`. Its `docker exec` healthcheck failed with `OCI runtime exec failed: write /tmp/runc-process…: no space left on device`. Caddy itself was still serving.
- On 10-31 at 03:56Z, the Claude OAuth auth file was rewritten and left at 0 bytes.
  - The running process kept the token in memory, so the 03:56 auth monitor still read healthy.
  - At 04:10Z the v8.0.48 deploy restarted the container. It reloaded the auth directory from disk, the client count went from 3 to 2, and the Claude file did not load.
  - From then on `/v1/models` had no `anthropic/*` entries and every Claude request returned: `400 {"error":{"message":"unknown provider for model claude-sonnet-4-6","type":"invalid_request_error","code":"model_not_found"}}`
  - All Claude consumers were down from about 04:10Z to 04:31Z.
  - The auth monitor did not alert. See [the monitor miss](./cliproxy-claude-oauth-refresh-expiry-2026-06-20.md#2026-10-31-the-monitor-did-not-alert-on-provider-missing).

## What Didn't Work

- Rolling back to the previous cliproxy version would not have helped. The credential was missing from disk. The version was not the cause.
- The first delete attempt for the zero-byte auth files used `find -newermt`, which matched none of them. A `stat`-based size and date match worked.
- `docker image prune` printed `gc failed` from dockerd but still freed the space. Check free space, not that line.

## Solution

**Immediate recovery** (operator-approved):

- `docker image prune -a` took the containerd store from 17G to 394M.
- `journalctl --vacuum-size=200M` took the journal from 2.0G to 160M.
- Root went from 100% to 26%. No containers restarted, and `config.yaml` was unchanged. Caddy turned healthy on its own.
- Redeploy run 41167295244 succeeded.
- `bunx @marcusrbrown/infra cliproxy login claude` wrote a new 666 B Claude auth file. A dispatched monitor run (41168968229) reported `probe=healthy reason=ok`.
- The two older zero-byte auth files from 2026-10-15 were deleted.

**Permanent fix, [PR #1730](https://github.com/marcusrbrown/infra/pull/1730).** About 188 old `eceasy/cli-proxy-api` images (one per Renovate bump since August) and 6 caddy images had accumulated. The gateway and dashboard deploys already pruned before pulling; broker, cliproxy and umami did not. Those three now run `docker image prune -af` as its own SSH step right before the pull (cliproxy: `apps/cliproxy/src/deploy.ts:483-496`, `deploy`).

Broker, cliproxy, gateway and umami prune best-effort: a prune failure only warns and the deploy continues. The dashboard differs. Its remote script (`apps/dashboard/src/remote-deploy.ts:356-357`, `capture_prune`) fails the deploy if the prune fails, then enforces a 6 GiB post-prune free-space gate (`REMOTE_MIN_FREE_BYTES`, `apps/dashboard/src/remote-deploy.ts:16,455`). VPN has no Docker.

First run with the change (router run 41203355464): umami reclaimed 2.0 GB and broker 930 MB. That run also exposed the SSH connection limit described in [the cliproxy recurrence](../workflow-issues/gateway-first-deploy-cascade-2026-05-20.md#recurrence-cliproxy-deploy-hit-the-ufw-ssh-limit-2026-10-31).

## Why This Works

`docker image prune -af` removes every image that no container references, running or stopped. That includes unused rollback images and a cached copy of the image about to be pulled, so the pull downloads it again. Pruning right before each pull keeps image buildup bounded. It limits image buildup only: volumes are untouched, and the auth files live on bind-mounted state, not in images. The step is warn-only on four apps because it is housekeeping; if it fails, the pull may still succeed.

Watch disk use separately, because the journal grew too. A full disk can still truncate a file the app rewrites, and only a probe that classifies the resulting `400 model_not_found` catches a truncated credential.

## Prevention

- Every droplet-side deploy that runs `docker compose pull` prunes unused images first. Broker, cliproxy, gateway and umami treat a prune failure as a warning; the dashboard fails the deploy. Never use `docker system prune --volumes` (`apps/gateway/src/deploy.ts:3231-3232` explains why: volumes hold OAuth tokens, workspace repos and state).
- Tests in `apps/cliproxy/src/deploy.test.ts:1190-1214` assert:
  - the prune runs before `docker compose pull`
  - no command contains `system prune` or `--volumes`
  - a failing prune (exit code 1) still lets pull and up run, and `deploy` resolves
- Do not trust `docker system df` on the containerd store. Check `/var/lib/containerd` and the journal directly.
- Do not read a healthy monitor as proof the credential is on disk. A running process can hold the token in memory after the file is truncated. After any disk-full event, check that every auth file is non-empty before the next restart.
- A new deploy step must not raise the SSH connection count per deploy. The prune step did, and the fix is the shared control socket in [the cliproxy recurrence](../workflow-issues/gateway-first-deploy-cascade-2026-05-20.md#recurrence-cliproxy-deploy-hit-the-ufw-ssh-limit-2026-10-31).

## Related Issues

- [cliproxy-claude-oauth-refresh-expiry-2026-06-20.md](./cliproxy-claude-oauth-refresh-expiry-2026-06-20.md): the upstream-expiry failure class and the monitor, including the `provider-missing` classification added after this outage.
- [gateway-first-deploy-cascade-2026-05-20.md](../workflow-issues/gateway-first-deploy-cascade-2026-05-20.md): UFW `limit ssh` and the ControlMaster rule, with the cliproxy recurrence.
- Issue #1726; PRs [#1717](https://github.com/marcusrbrown/infra/pull/1717), [#1730](https://github.com/marcusrbrown/infra/pull/1730).
