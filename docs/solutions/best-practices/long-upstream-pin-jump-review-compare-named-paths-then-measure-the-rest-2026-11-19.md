---
title: "Reviewing a long fro-bot/agent pin jump: compare named paths at both tags, then measure what source cannot settle"
date: 2026-11-19
problem_type: best_practice
component: development_workflow
severity: medium
module: apps/gateway
applies_when:
  - "A gateway pin bump spans enough tags that the GitHub compare file list is truncated"
  - "The operator contract version is unchanged and the bump looks pin-only"
  - "The new release changes the OpenCode version the workspace runs"
tags: [gateway, upstream-pin, fro-bot-agent, compare-api, pin-only, memory-cap, egress, renovate, release-review]
---

# Reviewing a long fro-bot/agent pin jump: compare named paths at both tags, then measure what source cannot settle

## Context

The gateway pin moved from fro-bot/agent v0.138.0 to v0.146.0 in one step: about 20 tags, 137 commits and 398 changed paths. The workspace went from OpenCode 2.2.6 to 2.3.2, and upstream removed its OpenCode V1 run path in the same range. A diff of that size cannot be read end to end, and the compare endpoint lists only 300 of the changed files ([the 300-file cap](../integration-issues/github-compare-api-300-file-cap-fail-closed-trigger-check-2026-11-10.md)). The review had to answer one question: is this a pin-only change, or does this repo have to change first?

## Guidance

1. **Do not use the compare file list to claim that a file is unchanged.** A file that is missing from a truncated list proves nothing. Compare each named path's blob SHA at both tags, from `git/trees/<tag>?recursive=1` or a blobless clone. A recursive tree response can be truncated too, so check its `truncated` field. Equal SHAs mean the contents are unchanged. Compare the entry's mode as well, because an executable bit can change with the contents equal. Read the patch of every file whose SHA differs, and look for a rename when a path is missing at one tag.
2. **Name the paths that decide "pin-only" before you look.** For the gateway these are:
   - `deploy/compose.yaml`, both Dockerfiles and `deploy/workspace-entrypoint.sh`;
   - `packages/gateway/src/config.ts` and the other files that read the environment at boot;
   - `packages/gateway/src/operator-contract/version.ts`;
   - `packages/runtime/src/shared/opencode-v2-pin.json`;
   - `packages/runtime/src/coordination/**`, which holds the lock format.
3. **An unchanged contract version is a signal, not proof.** It shows that upstream declared no contract change, so no paired dashboard release is expected. It says nothing about the deploy inputs. Before you call a bump pin-only, also check the deploy files, the config parsing, the egress hosts and the build inputs.
4. **List what the source cannot settle, and measure it after the deploy.** Two risks were open here: workspace memory under the 1024 MiB limit, because OpenCode 2.3 runs subagents in the background and compacts in the background, and network calls from OpenCode 2.3 to hosts that the egress allowlist blocks. Record both during acceptance, and state how much load the measurement covered.
5. **Compare candidate tags by the changes that reach the gateway.** v0.146.0 was published eight hours after v0.145.2. For the gateway the two differed only by two OpenCode patch releases on the same minor version, and both carried the same 2.3 risks, so the older tag was no safer.
6. **Use one deploy and one digest pair for acceptance.** Cancel a waiting deploy gate that would redeploy the old pin. Hold Renovate changes that rebuild the gateway until acceptance ends.
7. **Search this repo for text about code that upstream removed.** This jump left three stale items: a workflow comment about a V1 fallback, a release-gate pin check on a Dockerfile line that no longer exists, and a log line whose wording had changed.

## Why This Matters

A claim that nothing changed, read from a truncated list, is a guess. Blob equality is exact. The contract version does not cover the deploy inputs: a new required setting, a renamed mount or a new egress host breaks the gateway at boot or on the first run while the contract version stays the same. Memory and egress behaviour of a new OpenCode minor version are not visible in the upstream source, so the first evidence is either a measurement during acceptance or an incident.

## When to Apply

- The compare call for the range returns 300 files.
- The bump changes the OpenCode minor or major version.
- Upstream removes a code path that this repo's docs, comments or checks still name.

## Examples

On v0.138.0 to v0.146.0:

- `config.ts`, `operator-contract/version.ts` and the 23 files under `coordination/` had equal blob SHAs. `compose.yaml` differed by 3 added and 5 removed lines, all comments.
- `workspace.Dockerfile` and `workspace-entrypoint.sh` did change. The Dockerfile gained a stage that refuses any OpenCode version except the upstream pin, which the build already passed.
- After the deploy, saved `docker stats` samples from the automated gates ranged from 268 to 307 MiB of 1024 MiB, and readings during the Discord pass reached 329 MiB. The cgroup `oom`, `oom_kill` and `max` counters stayed at 0, and the proxy log showed no blocked host. The 16 runs were short and none triggered compaction, so these numbers do not establish peak memory use or cover every network call.

## Related

- [GitHub's compare endpoint lists at most 300 changed files](../integration-issues/github-compare-api-300-file-cap-fail-closed-trigger-check-2026-11-10.md)
- [OpenCode V2 gateway rollout: deploy checks passed while every model call failed](../workflow-issues/opencode-v2-gateway-rollout-deploy-checks-do-not-prove-provider-routing-2026-10-31.md)
- [Gateway release gates](../../runbooks/operator-surface-acceptance-automated.md#gateway-release-gates-agent-run)
- `apps/gateway/AGENTS.md`, for the deploy flow and rollback rules
