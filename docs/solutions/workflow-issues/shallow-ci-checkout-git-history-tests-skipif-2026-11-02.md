---
title: "Shallow CI checkout breaks a test that needs git history: skip it and name the covering job"
date: 2026-11-02
problem_type: workflow_issue
component: testing_framework
severity: low
module: apps/docs
root_cause: test_isolation
resolution_type: test_fix
symptoms:
  - "The real-repo CLI test for the diagram renderer failed in CI and passed locally"
  - "The failure text reported that diagrams cannot be rendered from a shallow checkout"
tags:
  - ci
  - shallow-checkout
  - fetch-depth
  - bun-test
  - diagrams
  - git-log
---

# Shallow CI checkout breaks a test that needs git history: skip it and name the covering job

## Problem

`apps/docs/scripts/render-diagrams.ts` labels each diagram "spec last changed in <commit>" from `git log -1 --format=%h -- <spec>`. It refuses to run on a shallow checkout, because depth-1 history gives wrong labels (the check is `git rev-parse --is-shallow-repository`):

```ts
      'cannot render diagrams from a shallow checkout: the "spec last changed in" labels need git history ' +
```

The CI `Test` job runs `bun test --recursive` after a default `actions/checkout`, which is depth 1.

## Symptoms

- The real-repo CLI test `works with cwd set to apps/docs and publishes only HTML` failed in CI and passed locally.
- The failure text was the shallow-checkout error above.

## What Didn't Work

Loosening the production guard was rejected. The guard keeps publishing builds from carrying wrong labels, and `.github/workflows/site.yaml` checks out full history for those:

<!-- prettier-ignore -->
```yaml
          fetch-depth: 0
```

Setting `fetch-depth: 0` on the Test job would fix one test at the cost of a full clone for the whole suite.

## Solution

Skip that one test on a shallow checkout (`apps/docs/scripts/render-diagrams.test.ts`):

<!-- prettier-ignore -->
```ts
// CI test jobs check out shallow; the real render is exercised by site.yaml's full-history build.
const SHALLOW_CHECKOUT =
  Bun.spawnSync(['git', 'rev-parse', '--is-shallow-repository'], {cwd: REPO_ROOT}).stdout.toString().trim() === 'true'
```

and `it.skipIf(SHALLOW_CHECKOUT)(` on the CLI test. The fixture-repo tests still run in CI. One of them asserts that a `--depth 1` clone fails with the shallow error.

## Why This Works

The skipped test needs real history by design. The fixture tests run the same code against a history the test controls, and the production path is covered by the `Build site` step in `site.yaml`. That step runs on pull requests that touch its path filter, and `apps/docs/**` includes the renderer and its test. Verified on a `git clone --depth 1` of the branch: the suite passes with that one test skipped, and a full checkout runs it.

## Prevention

- A test that runs `git log` or similar against the real repo must skip when `git rev-parse --is-shallow-repository` is `true`, or build a fixture repo of its own.
- Keep the skip narrow: one test, with a documented replacement in another job. Do not widen the Test job's checkout to avoid it.
- Name where the skipped behavior is still covered, as the comment above does.
