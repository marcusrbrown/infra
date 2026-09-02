---
title: Approval-gated GitHub Actions runs ignore cancellation requests
date: 2026-09-02
category: docs/solutions/workflow-issues
module: infra
problem_type: workflow_issue
component: development_workflow
root_cause: wrong_api
resolution_type: workflow_improvement
severity: critical
symptoms:
  - '`gh run cancel --repo <repo> <id>` reports success, but a `waiting` run remains indefinitely'
  - 'A later dispatch remains `pending` behind the environment-gated run'
  - 'A cancellation loop passes when the queue is empty and fails silently as a safeguard'
  - 'A checkout-free `gh run cancel <id>` reports `failed to determine base repo`'
tags:
  - github-actions
  - environment-approval
  - cancellation
  - concurrency
  - deploy
  - gh-cli
  - staleness
  - workflow-dispatch
  - runtime-verification
---

# Approval-gated GitHub Actions runs ignore cancellation requests

## Diagnostic signature

An Actions run blocked at an Environment approval gate has status **`waiting`**. Running
`gh run cancel --repo <repo> <id>` prints **"✓ Request to cancel workflow submitted"** and exits 0,
but the run remains `waiting` indefinitely. This was reproduced repeatedly from both the workflow
`GITHUB_TOKEN` and an owner PAT, over several minutes.

GitHub's REST documentation does not describe this endpoint's behavior for `waiting` runs; the
cancel no-op is an empirical finding. The cancel endpoint is:

```text
POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel
```

The mechanism that actually clears the run is rejecting its pending deployment:

```text
POST /repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments
```

with `state=rejected`. That takes effect within seconds.

## API-shape trap

The `pending_deployments` request body requires a JSON integer array. This fails:

```sh
gh api -f "environment_ids[]=<id>" ...
```

with `HTTP 422 — For 'items', "<id>" is not an integer`. Use JSON input instead:

```sh
printf '%s\n' '{"environment_ids":[<id>],"state":"rejected"}' |
  gh api --input - \
    -X POST \
    "/repos/{owner}/{repo}/actions/runs/{run_id}/pending_deployments"
```

## Why cancellation automation cannot work around it

Per GitHub's REST reference, `pending_deployments` requires the caller to be a required reviewer of
the Environment. `github-actions[bot]` is not a required reviewer, and GitHub limits App review to
"their own custom deployment protection rules". A reviewer-capable PAT would work, but storing one
in the repository is not an acceptable workaround: anyone who can trigger a workflow could use that
credential to approve a production deployment, nullifying the Environment gate.

## Concurrency interaction

A `waiting` run holds its concurrency slot. With `cancel-in-progress: false`, later dispatches remain
`pending` until the waiting run reaches a terminal state. In the observed sequence, the second
dispatch moved from `pending` to `waiting` within seconds of the first being rejected. This queue
behavior is the mechanism behind #1203.

## Earlier masked defect

The first implementation also ran in a checkout-free job. `gh run cancel "<id>"` failed with:

```text
failed to determine base repo: fatal: not a git repository
```

`gh run list` worked in the same step only because it passed `--repo`. Every `gh` call in a step
that may run before checkout must name the repository explicitly. This was fixed in #1253, but
explicit repository selection cannot make the cancellation API terminate an approval-gated run.

## Working solution

Make the stale run harmless instead of trying to cancel it. The deploy job's first step,
`Reject stale dashboard dispatch`, runs before app-token minting and checkout. On
`workflow_dispatch` it lists `deploy-dashboard.yaml` runs with a `databaseId` greater than the
current `github.run_id`; if any exist, it prints their IDs and exits 1. A newer run represents newer
intent and should be approved instead.

The step uses `actions: read` and an explicit repository:

```yaml
if: github.event_name == 'workflow_dispatch'
env:
  GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  CURRENT_RUN_ID: ${{ github.run_id }}
```

It is skipped under `workflow_call` because the callee has no run of its own and `github.run_id`
belongs to the deploy router, making the comparison meaningless. A `gh run list` API failure
hard-fails the step before deployment secrets are touched. This is deliberate fail-closed behavior;
the cost is one wasted approval click.

The reframe is the important part: the stale run cannot be prevented, so approving it is made
harmless. It fails fast, freeing the concurrency slot so the newer run advances to its own gate;
the stale deployment becomes unreachable.

## Live verification

The behavior was verified with two dispatches:

- Run `33676976997` (A) reached `waiting`.
- Run `33677038514` (B) reached `pending` behind A.
- Approving A failed it in about forty seconds with:

  ```text
  Newer dashboard run(s) supersede this run: 33677038514.
  ```

- Step results: `Reject stale dashboard dispatch=failure`, `Get app token=skipped`, and all deploy
  steps skipped.
- B moved from `pending` to `waiting` once A became terminal.

## Process lesson

A non-functional job passed a written plan, a six-persona document review, two independent Fro Bot
approvals, and purpose-built conventions tests because those checks verified the job's shape, not
its runtime behavior. The safeguard looked healthy when the queue was empty: the cancellation loop
never executed, so the job reported success. Only dispatching it twice against a real queue exposed
the no-op cancellation behavior.

The related permission finding in
`docs/solutions/workflow-issues/reusable-workflow-permission-parity-startup-failure-2026-09-01.md`
records the same class of lesson: `gh workflow run deploy.yaml --ref <branch>` was the available
pre-merge proof there, because static YAML and conventions checks could not validate the runtime
boundary. CI automation that manipulates CI state needs live exercise, not static assertions.
