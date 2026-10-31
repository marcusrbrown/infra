---
title: "OpenCode V2 gateway rollout: deploy checks passed while every model call failed"
date: 2026-10-31
module: apps/gateway
problem_type: workflow_issue
component: development_workflow
severity: high
applies_when:
  - Bumping the fro-bot/agent pin for the gateway or workspace, especially across an OpenCode major version
  - Runs fail seconds after launch with provider-auth-unavailable, or cliproxy logs 401s for workspace traffic
  - Running operator-surface acceptance against an OpenCode V2 stack
symptoms:
  - "Every run failed about 9 s in with provider-auth-unavailable after the V2 deploy"
  - "cliproxy logged 401s for workspace traffic"
  - "The deploy's health probe contract, digest and memory readback checks all passed"
  - "The V2 server's credential table had 0 rows"
root_cause: incomplete_setup
resolution_type: dependency_update
tags: [gateway, opencode-v2, fro-bot-agent, deploy, provider-routing, cliproxy, rollback, smoke-run]
related_components:
  - tooling
---

# OpenCode V2 gateway rollout: deploy checks passed while every model call failed

## Context

The gateway and workspace move from OpenCode V1 to V2 together, through `fro-bot/agent` pin bumps. The first V2 rollout was green on every deploy check and broke every model call. Only a real model run exposes that kind of failure.

Timeline:

- 10-30 11:08Z: [PR #1712](https://github.com/marcusrbrown/infra/pull/1712) deployed V2 (agent v0.130.0). Every run failed about 9 s in with `provider-auth-unavailable`. The V2 server's per-spawn `credential` table in its `opencode.db` had 0 rows: the provisioned legacy `auth.json` (120 B, uid 10001) was never imported. cliproxy saw 401s.
- About 15:10Z: [PR #1718](https://github.com/marcusrbrown/infra/pull/1718) reverted to v0.129.0 (V1), roughly 4 h down. Upstream issue fro-bot/agent#1992.
- [PR #1720](https://github.com/marcusrbrown/infra/pull/1720) added `models.opencode.ai` to `WORKSPACE_EGRESS_HOSTS` because mitmproxy was returning 403 for V2's catalog host. From v0.130.1 the V2 server sets `OPENCODE_DISABLE_MODELS_FETCH`, so that host sees no traffic and the entry is harmless.
- 10-31: V2 re-landed on v0.130.1 ([PR #1723](https://github.com/marcusrbrown/infra/pull/1723), after #1992 was fixed), then bumped to v0.130.3 ([PR #1735](https://github.com/marcusrbrown/infra/pull/1735): OpenCode V2 2.2.5, Systematic 3.28.0, contract still 1.14.0).

## Guidance

### 1. A model run is the only proof of provider routing

The deploy's own checks (health probe contract, image digests, memory readback) all passed on the broken V2 deploy. After any gateway or workspace pin change, launch a smoke run and check two things:

- The run reaches a model response. A failure about 9 s in with `provider-auth-unavailable` can mean the credential import failed. Check the credential table and the proxy logs.
- The V2 credential table has one row per provider:

  ```sql
  SELECT integration_id, count(*) FROM credential GROUP BY 1
  ```

  Expected after the fix: `anthropic=1, openai=1`, and the gateway log line `provider credentials provisioned { providers: ['anthropic','openai'], count: 2 }`.

### 2. Read-only discriminators

These help separate "credential never imported" from "cliproxy rejects the key" from "egress blocked", without a restart or any write:

- Find the V2 server's database path. Read its environment (`/proc/<pid>/environ`) as uid 10001 and print only the value of `OPENCODE_DB`, never the whole environment.
- Query that file read-only with `node:sqlite`. The workspace image has no `sqlite3` CLI. Illustrative shape, not a tested command:

  ```ts
  new DatabaseSync(dbPath, {readOnly: true})
    .prepare("SELECT integration_id, count(*) AS n FROM credential GROUP BY 1")
    .all()
  ```

- Read the mitmproxy logs. cliproxy 401s mean a credential was sent and refused. No cliproxy traffic does not tell a missing credential apart from a request that was blocked or lost before it reached cliproxy; correlate the gateway, workspace and mitmproxy logs. A 403 on a host means the egress allowlist blocked it.

### 3. Acceptance exclusions

Some operator-surface checks are unsafe or not demonstrable on V2. For example, Reject can quarantine the repo: the lock remains until its 900-second lease expires and a takeover confirms the repo is quiet. The current list is in the runbooks: [operator-surface-acceptance.md](../../runbooks/operator-surface-acceptance.md) and [operator-surface-acceptance-automated.md](../../runbooks/operator-surface-acceptance-automated.md).

### 4. Rollback rules

- Rollback between releases at or after v0.118.2 is a gateway pin reversal. Pair it with the dashboard pin only when the operator contract version differs. No volume restore. The V2 revert (v0.130.0 back to v0.129.0) was one.
- A rollback that crosses v0.118.2 needs the pre-upgrade `workspace-repos` volume snapshot, and the gateway and workspace images must roll back together. See [Rollback is not pin reversal](../../../apps/gateway/AGENTS.md#rollback-is-not-pin-reversal).
- Never run V2 on v0.130.0: every model call fails with 401. Gateway and workspace switch together, because the gateway picks V1 or V2 per run from the workspace `/readyz` `opencodeVersion`. An old gateway (before v0.130.0) must never run behind a V2 workspace. A new gateway behind a V1 workspace is safe.
- For the image-pair and break-glass revert steps, see [Revert from OpenCode V2](../../../apps/gateway/AGENTS.md#revert-from-opencode-v2).

## Why This Matters

The deploy reported green while every model call failed. The deploy proves containers are up, digests match and memory reads back. It does not exercise the path from credential provisioning through the egress proxy to cliproxy. The credential-table query and the proxy logs tell you which of those layers failed, without a restart. Recording the V2 acceptance exclusions keeps a skipped check from being read as a pass.

## When to Apply

- After any `fro-bot/agent` pin bump that touches the gateway or workspace, and after any workspace image rebuild.
- When runs fail within seconds with `provider-auth-unavailable`, or cliproxy shows 401s for workspace traffic.
- Before running operator-surface acceptance against a V2 stack.

## Related

- [apps/gateway/AGENTS.md](../../../apps/gateway/AGENTS.md): [Revert from OpenCode V2](../../../apps/gateway/AGENTS.md#revert-from-opencode-v2) and [Rollback is not pin reversal](../../../apps/gateway/AGENTS.md#rollback-is-not-pin-reversal)
- [operator-surface-acceptance.md](../../runbooks/operator-surface-acceptance.md), [operator-surface-acceptance-automated.md](../../runbooks/operator-surface-acceptance-automated.md)
- fro-bot/agent issues #1990, #1992, #2001, #2002, #2007
- PRs [#1712](https://github.com/marcusrbrown/infra/pull/1712), [#1718](https://github.com/marcusrbrown/infra/pull/1718), [#1720](https://github.com/marcusrbrown/infra/pull/1720), [#1723](https://github.com/marcusrbrown/infra/pull/1723), [#1735](https://github.com/marcusrbrown/infra/pull/1735)
