---
title: "Traces first deploy: host-only defects that passed every test, as a checklist for the next new app"
problem_type: workflow_issue
component: development_workflow
root_cause: incomplete_setup
resolution_type: environment_setup
severity: high
date: 2026-11-22
tags: [traces, digitalocean, docker-compose, ssh, ufw, clickhouse, langfuse, tempo]
module: apps/traces
applies_when:
  - "A new droplet app is about to merge its first PR, or is about to run its first deploy"
  - "A service image is new to the stack and its defaults (listen address, user, directory modes) are not known"
  - "Tests run against a simulated host and all pass"
related_issues:
  - https://github.com/marcusrbrown/infra/pull/2007
  - https://github.com/marcusrbrown/infra/pull/2012
  - https://github.com/marcusrbrown/infra/pull/2015
  - https://github.com/marcusrbrown/infra/pull/2016
  - https://github.com/marcusrbrown/infra/pull/2019
related_docs:
  - docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md
  - docs/solutions/workflow-issues/gateway-first-deploy-cascade-2026-05-20.md
  - docs/solutions/workflow-issues/umami-first-deploy-cascade-2026-05-29.md
  - docs/solutions/workflow-issues/broker-first-deploy-cascade-2026-06-30.md
  - docs/solutions/workflow-issues/vpn-lightsail-first-provision-cascade-2026-06-10.md
  - docs/solutions/integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md
  - docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md
---

# Traces First Deploy: Host-Only Defects That Passed Every Test

## Problem

`apps/traces` merged as code only ([PR #2007](https://github.com/marcusrbrown/infra/pull/2007)). Its simulated-host tests passed, and provisioning and the first deploys then found host-only defects. This is a checklist for the next new app. The five defects fixed in PR #2015 each have a test; the others are fixed in code or procedure.

## What Didn't Work

Simulated hosts missed image defaults and provider timing; a loopback-only healthcheck missed a cross-container failure. For first-deploy fixes, an operator-run local deploy loop exposed successive host defects faster than 30–45-minute PR rounds; a subsequent PR deploy verified the workflow path.

## Solution

Each row: the defect, how it surfaced, and the fix with the pin that keeps it fixed.

| Defect | How it was caught | Fix and pin |
| --- | --- | --- |
| `ufw limit 22/tcp` (6 new connections per 30 s per source) locked out provisioning and CLI calls | Provisioning on the new host ([PR #2012](https://github.com/marcusrbrown/infra/pull/2012)) | One ControlMaster connection per provisioning run (`withRemote` at `apps/traces/server/provision.ts:1179-1206`, `SSH_CONTROL_PERSIST` at `apps/traces/server/provision.ts:82`) and per multi-call CLI command (`withRemoteSession` at `packages/cli/src/commands/traces/remote.ts:261`). A recurrence after the gateway, broker and cliproxy cascades |
| Each `ssh-keyscan` opens about five connections | Same | `SSH_SCAN_PAUSE_MS` at `apps/traces/server/provision.ts:76`: a 35 s pause before each scan and after the last (`apps/traces/server/provision.ts:1275-1277`); the shared `pinHostKeys` takes the pause as an option (`packages/shared/server/droplet-helpers.ts:298`) |
| containerd 2.4.2 refused `disabled_plugins = ["cri"]` in a `version = 2` file, which left Docker in a restart loop until the config was fixed | Provisioning on the host | The full plugin id, `io.containerd.grpc.v1.cri` (`apps/traces/server/provision.ts:962-965`, the `CONTAINERD_CONFIG_PATH` entry) |
| The DNS record must exist before provisioning pins host keys (keys are pinned under both the address and the hostname); macOS caches a negative answer from earlier attempts | Provisioning | Create the A record as soon as the droplet exists. Existing fix for the cache: [broker cascade](./broker-first-deploy-cascade-2026-06-30.md) |
| Pinned host keys prove consistency, not authenticity: the helper appends raw `ssh-keyscan` output | Review blocker on #2012 | Compare all three fingerprints with the droplet's own keys through the provider console before merge, and record the match in the PR |
| A directory mounted over ClickHouse's `config.d` hid the image's file that makes the server listen beyond localhost. The localhost healthcheck passed; Langfuse could not connect | First deploys | Mount single files (`apps/traces/docker-compose.yaml:191-197`, the `clickhouse` volumes). The test at `apps/traces/docker-compose.test.ts:336` asserts single-file mounts and no directory mounted over the image's config directories |
| Langfuse binds to `HOSTNAME`, which Docker sets to the container name, so loopback healthchecks and the deploy's in-container probe were refused | Langfuse web and worker healthchecks | `HOSTNAME: 0.0.0.0` on both (`apps/traces/docker-compose.yaml:36`, `x-langfuse-env`); test at `apps/traces/docker-compose.test.ts:329` |
| `system.tables.create_table_query` is one line, so a parser that looked for a line starting with `TTL` found none; the rule was applied and the check was wrong | Retention read-back | `extractTtl` at `apps/traces/src/retention.ts:137-148`. Review rounds then added: ignore quoted text and column TTLs, stop at a trailing table `COMMENT` |
| Tempo creates its data directories mode 0700, so the health reporter could not list them and the verdict stayed `unknown` | Reporter verdict | The reporter runs as Tempo's user: `TEMPO_USER_ID` at `apps/traces/src/host.ts:109`, followed by `health-reporter.user` at `apps/traces/docker-compose.yaml:330-333` and the reporter secrets' owner |
| Deploy compared a managed file by content only, so a file with the right content and a wrong owner or mode was left as it was | Found while fixing the reporter's secret ownership | `compareFileScript` at `apps/traces/src/deploy.ts:877-894` reads `uid:gid` and mode with `stat -c` as well; a failed comparison goes through the deploy's failure handler (`FilesNotComparedError` at `apps/traces/src/deploy.ts:1787`) |
| Tempo keeps `work.json` beside its tenant directories; the reporter listed it as a directory | Reporter | `readTempoBlockMetasFrom` at `apps/traces/src/health-report.ts:1509-1517` enters directories only |
| A build attestation changes the pinned image digest on every build | A deploy of unchanged code | [Provenance section](../best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md) |
| The provider's listing lags completed actions | Provisioning, restore, backup | [Listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md) |

## Prevention

Before merging the first PR of a new droplet app:

- **Expect a gated deploy on merge.** The router starts it. The #2007 merge deploy was cancelled at its gate; the #2012 merge deploy ran and failed. Create the Environment with a reviewer and a `main`-only branch rule first ([broker cascade](./broker-first-deploy-cascade-2026-06-30.md)).
- **Count SSH connections** per provisioning run and per CLI command. Anything that opens more than a few needs one multiplexed connection ([gateway cascade](./gateway-first-deploy-cascade-2026-05-20.md)).
- **For each new image, read its defaults before mounting over them:** its config directories and the files the entrypoint writes there, its bind address and the env variable that sets it, its runtime user, and the mode of the directories it creates. Prefer single-file mounts.
- **Make a healthcheck prove the path other containers use,** not only loopback.
- **Compare managed files by content, owner and mode.**
- **Use bounded polling for the volume and snapshot listing read-backs that lagged, and evaluate every other read-back after a provider change individually.** Some single reads are safe because they fail closed ([listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md)).
- **Verify pinned host keys out of band** (provider console) and record it in the PR.
- **Keep a "proven only on the real host" list current.** `apps/traces/AGENTS.md` carries one, with what the first deploy proved and what is still unproven.
- **Use a local break-glass deploy loop for first-deploy fixes,** then let the PR deploy prove the workflow path. Do not iterate through PR deploys at 30 to 45 minutes a round.

Open test gap, not yet done: only per-app tests assert SSH multiplexing (for example `apps/traces/server/provision.test.ts:847` and `packages/cli/src/commands/traces/remote.test.ts:470`), which is how provisioning and the `traces` CLI missed the rule the traces deploy followed. A cross-app conventions test could fail a multi-call `ssh` or `scp` path that lacks multiplexing. Commands that make a single connection, such as `traces open` and `traces logs`, must stay allowed.

## Related Issues

- [DigitalOcean listing lag](../integration-issues/digitalocean-listing-lags-completed-actions-poll-read-backs-2026-11-22.md) and the [provenance section](../best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md) — two of the defects, documented on their own.
- [cliproxy](./cliproxy-first-deploy-cascade-2026-04-06.md), [gateway](./gateway-first-deploy-cascade-2026-05-20.md), [umami](./umami-first-deploy-cascade-2026-05-29.md), [broker](./broker-first-deploy-cascade-2026-06-30.md) and [vpn](./vpn-lightsail-first-provision-cascade-2026-06-10.md) — the earlier cascades; the SSH limit and DNS hits recur here.
- PRs [#2007](https://github.com/marcusrbrown/infra/pull/2007), [#2012](https://github.com/marcusrbrown/infra/pull/2012), [#2015](https://github.com/marcusrbrown/infra/pull/2015), [#2016](https://github.com/marcusrbrown/infra/pull/2016), [#2019](https://github.com/marcusrbrown/infra/pull/2019).
- `apps/traces/AGENTS.md` (Proven only on the real host) and `docs/runbooks/trace-collection.md`.
