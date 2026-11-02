---
title: "Status history in an Actions artifact: look up the newest eligible artifact, whatever its run concluded"
date: 2026-11-02
problem_type: architecture_pattern
component: tooling
severity: high
module: packages/cli
root_cause: logic_error
resolution_type: code_fix
symptoms:
  - "A lookup guard that required the newest successful producing run wedged collection after a re-run or a cancel following upload"
  - "The newest-sample regression check failed when every previous sample had aged out and the incoming sample was a duplicate"
  - "A deploy-state reader returned fail because a gate-rejected branch deployment was the newest deployment"
tags:
  - status-history
  - actions-artifact
  - history-locate
  - concurrency
  - invariants
  - bootstrap
  - deploy-state
---

# Status history in an Actions artifact: look up the newest eligible artifact, whatever its run concluded

## Context

The public status page needs a 90-day sample history. Candidates for where it lives:

- **Pages:** any docs-only redeploy would replace it, a first run would get a 404, and the CDN could serve a stale read.
- **A repo branch:** this adds a writer with commit rights to the repo.
- **An Actions artifact:** the snapshot job re-uploads the whole history every run, so the newest copy carries everything the previous run loaded.

It lives in an artifact. The history is `meta.json` plus `apps/<app>.json`, uploaded as the last step of `status-snapshot.yaml`:

<!-- prettier-ignore -->
```yaml
      - name: Upload status history
        if: github.ref == 'refs/heads/main'
```

with `retention-days: 7`. A re-upload every 30 minutes keeps it alive; an outage over 7 days loses it, and the runbook has the reset path. The schemas live in `packages/shared/status/history-schema.ts`, shared by the CLI (writer) and the site (reader).

## Guidance

### Locate by artifact, not by run outcome

`status history-locate` (`packages/cli/src/commands/status-history-locate.ts`) lists non-expired `status-history` artifacts built on `main`, newest first. It confirms each candidate's run was a `schedule` or `workflow_dispatch` run of `.github/workflows/status-snapshot.yaml`. The first candidate that checks out wins. The code states the rule:

```ts
 * The producing run's status and conclusion are deliberately never consulted. Snapshot runs are serialized by the
 * workflow's concurrency group and each run locates afresh, so the newest eligible artifact is the right base
```

The serialization comes from the snapshot workflow:

```yaml
concurrency:
  group: status-snapshot
  cancel-in-progress: false
```

### Three outcomes, never a silent fourth

`LocateResult` is `found`, `empty` or `error`. Any API failure or exhausted call budget (`HISTORY_LOCATE_RUN_CHECK_BUDGET = 5`, plus one list call) exits non-zero. A truncated listing is an error only when no eligible candidate was found in the returned page: an eligible candidate that appears first wins, and `empty` is reported only when the listing is complete. An outage is never read as "no history", which would trigger a reset.

The locator sees only what the artifact listing shows. It cannot detect an eligible artifact that a stale listing omits, and the merge invariants compare only against the history that was loaded. Completeness therefore depends on the artifact listing being visible.

### Only a bootstrap dispatch creates history

The snapshot job refuses `empty` unless `bootstrap` is set, and refuses `found` when it is set. Scheduled runs never create history.

### Merge enforces invariants before anything is written

`packages/cli/src/status/history.ts` throws a `HistoryError` before the first write if any of these fail:

- No in-window sample is dropped.
- The newest sample time never moves backwards.
- Duplicates are dropped, keyed on run ID and attempt.
- App IDs must be known.
- No sample is dated more than 5 minutes after `now`.
- The whole history stays under 10 MiB (`HISTORY_MAX_BYTES`).
- Writes stage temp files and rename them into place, `meta.json` last.

The regression check applies only while the previous newest sample is still inside the window:

```ts
    // A previous newest that has aged out of the window cannot be regressed from: trimming removed it.
    const floor = Date.parse(previous.meta.lastSampleAt)
    if (floor >= cutoff && (newest < floor || Date.parse(next.meta.lastSampleAt) < floor)) {
```

A run outside Actions gets the run ID `local-<ISO time>` and attempt 1. Local snapshots taken at different times do not dedupe against each other; two taken with the same `now` do.

### Read deploy state from `main` only

The Deployments API reader passes `ref=${DEPLOY_STATE_REF}`, defined in `packages/cli/src/status/deploy-state.ts`:

<!-- prettier-ignore -->
```ts
export const DEPLOY_STATE_REF = 'main'
```

Without it, a gate-rejected branch dispatch is the newest deployment and the app reads as `fail`.

## Why This Matters

A first version of `history-locate` required the artifact's run to be the newest successful snapshot run. The aim was to stop a lagging artifact listing from rolling history back. Fro Bot's review on #1756 showed the guard wedges collection permanently. Re-running the newest successful run, or cancelling a run after its upload step, leaves the newest artifact's producing run without `success`. Every later run then fails until someone deletes the history. The guard was removed before merge.

The artifact content is what matters, and a run's outcome stays mutable after the artifact exists. The serialized concurrency group already guarantees that the newest artifact came from a run that reached its upload.

## When to Apply

- A scheduled job writes state that the next run must read back.
- A lookup gates on a property of the producer (run status, tag, approval) that can change after the output exists.
- A "not found" result can trigger a destructive or resetting action. Make errors a separate state.
- A reader of "latest" state spans branches. Pin the ref.

## Examples

- `packages/cli/src/commands/status-history-locate.test.ts`, `producing run lifecycle never decides the choice`: a re-run in progress, a cancel after upload, and a failed run all resolve `found`.
- `packages/cli/src/status/history.test.ts`: a history whose every previous sample has aged out, merged with a duplicate incoming sample, trims and succeeds. This pins the aged-out edge of the regression check.
- Recovery from expired or corrupt history: "Expired or corrupt history" in [`docs/runbooks/docs-site.md`](../../runbooks/docs-site.md) (delete the artifacts, then bootstrap).
- The publish side of this pipeline, and why it uses `workflow_run`: [reusable workflow permission parity](../workflow-issues/reusable-workflow-permission-parity-startup-failure-2026-09-01.md).
