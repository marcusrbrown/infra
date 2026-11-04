---
title: "Download one upstream data file instead of checking out upstream source: Bun test discovery ignores .gitignore"
date: 2026-11-04
problem_type: best_practice
component: tooling
severity: medium
module: apps/docs
root_cause: wrong_api
resolution_type: tooling_addition
symptoms:
  - "A sparse checkout of upstream deploy/ would put its *.test.mjs files where bun test --recursive runs them"
  - "Gitignoring the checkout directory and excluding it from tsc and eslint does not keep it out of test discovery"
  - "In fro-bot-storage the agent runs bun test after AWS credentials and the PAT are set, so upstream test code would run with them on every pin bump"
tags:
  - bun-test
  - test-discovery
  - gitignore
  - ci-security
  - upstream-pin
  - fetch-script
  - fro-bot-storage
---

# Download one upstream data file instead of checking out upstream source: Bun test discovery ignores .gitignore

Plan review for the diagram drift check (#1785) caught this before anything shipped.

## Problem

The drift check needs one upstream file: the gateway's `deploy/compose.yaml` at the ref pinned in `apps/gateway/upstream.json`. The first plan fetched it with a sparse `actions/checkout` of fro-bot/agent `deploy/` into a gitignored `upstream-agent/`, excluded from `tsc` and ESLint. Upstream `deploy/` ships `*.test.mjs` files under `deploy/scripts/`. `bun test --recursive` would have run them in two places:

- the CI test job;
- the scheduled `fro-bot-storage` job, where the agent runs `bun test --recursive` in its `Run Fro Bot` step after `Configure AWS credentials` and after the PAT is written to git config.

Every Renovate pin bump would have pulled new upstream test code into that environment.

## Why the obvious guard fails

Bun's test discovery does not read `.gitignore`. It does skip `node_modules` and any dot-prefixed directory. We checked this with the repo-pinned Bun, not the docs: test files in the root and in a gitignored directory ran, and test files in a gitignored `.cache/`, a `.hidden/` and `node_modules/` did not. `.cache/` is safe because of its leading dot, not because it is ignored.

## Guidance

Fetch the one data file at a validated ref, into a dot-prefixed path keyed by ref. Don't check out a tree you then hope to exclude.

`apps/docs/scripts/fetch-upstream-compose.ts`, run as `bun run fetch:upstream-compose`:

- It reads `ref` from `apps/gateway/upstream.json` and requires the whole string to be a release tag. It does that before any request:

  ```ts
  /** The whole string must be a release tag; there is no `m` flag, so a second line cannot ride along. */
  export const UPSTREAM_REF_PATTERN = /^v\d+\.\d+\.\d+$/
  ```

- It downloads the raw file to `.cache/upstream-compose/<ref>/compose.yaml`. The path carries the ref, so a file fetched for an older pin is never read after a bump, and no stale-file guard is needed.
- It fails on a non-2xx response or an empty body, uses a 30 s timeout, and writes to a temp file before renaming it into place.
- It uses no action, no token and no checkout.

Both workflows run the same bare step:

```yaml
# Data file only: an upstream checkout would put its tests where `bun test --recursive` runs them.
- name: Download upstream gateway compose
  run: bun run fetch:upstream-compose
```

The checker fails closed. If the file for the current ref is missing or parses empty, it reports a source error that names `bun run fetch:upstream-compose`. It never skips the gateway checks.

A first implementation used `jq`, a bash regex and `curl` in both workflows, plus a `package.json` one-liner. Its `grep -Eq` checked the ref line by line, so a multi-line value could pass. The repo also allows only two shell scripts. One TypeScript script fixes both and keeps the ref rule in one place.

## When to Apply

- A test or check needs a fact from another repository.
- The job runs `bun test --recursive`, or any runner that discovers files by pattern.
- The job holds credentials, or later steps in it do.

## Prevention

- Store fetched fixtures under a dot-prefixed directory. Don't rely on `.gitignore` to keep files out of `bun test`.
- Validate refs as whole strings, in TypeScript, in one place.
- The conventions tests in `packages/cli/src/conventions.test.ts` (`upstream gateway compose download step`) pin the workflow shape:
  - exactly one download step per job, with only `name` and `run`;
  - no expression, token or secret;
  - placed after install and before the step that runs tests;
  - identical in both workflows.

## Related

- [Diagram drift test design](diagram-drift-test-design-fact-table-2026-11-04.md)
- [Shallow CI checkout vs git-history tests](../workflow-issues/shallow-ci-checkout-git-history-tests-skipif-2026-11-02.md)
- `docs/plans/2026-11-03-001-feat-diagram-drift-detection-plan.md`
