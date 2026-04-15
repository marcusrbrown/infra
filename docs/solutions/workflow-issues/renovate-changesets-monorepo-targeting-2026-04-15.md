---
title: Renovate-Changesets Monorepo Targeting Saga
category: workflow-issues
date: 2026-04-15
problem_type: workflow_issue
component: development_workflow
root_cause: config_error
resolution_type: config_change
severity: high
tags:
  - renovate
  - changesets
  - monorepo
  - release-pipeline
  - bfra-me-github
  - reusable-workflows
related_issues:
  - https://github.com/bfra-me/.github/issues/1990
  - https://github.com/bfra-me/.github/issues/2003
  - https://github.com/bfra-me/.github/issues/2012
  - https://github.com/bfra-me/.github/issues/2018
related_prs:
  - https://github.com/marcusrbrown/infra/pull/88
  - https://github.com/marcusrbrown/infra/pull/114
  - https://github.com/marcusrbrown/infra/pull/118
---

# Renovate-Changesets Monorepo Targeting Saga

## Problem

The `bfra-me/.github` renovate-changesets action generated changesets
targeting `@marcusrbrown/infra-workspace` (the private workspace root)
instead of `@marcusrbrown/infra` (the published CLI package). This broke
`changeset version` on every Release workflow run because the private
root isn't in manypkg's workspace package list.

## Symptoms

- Release workflow fails with: `Found changeset for package @marcusrbrown/infra-workspace which is not in the workspace`
- Renovate PRs merge successfully but the next Release run crashes
- Bad changeset files accumulate in `.changeset/` on main

## Root Cause

The action's package resolution logic has a fallback chain for files
that don't belong to any workspace member (e.g., `.github/workflows/`
touched by github-actions manager updates):

1. Match changed files to workspace packages → no match for workflow files
2. Fall back to `getRootPackageName()` → returns `@marcusrbrown/infra-workspace`
3. Generate changeset targeting that name → `changeset version` rejects it

The reusable workflow at `bfra-me/.github` didn't expose `exclude-patterns`
or `target-package` inputs, so callers had no way to control this behavior.

## What Didn't Work

### Phase 1: Reusable workflow skipped entirely (bfra-me/.github#1990)

The reusable workflow's job-level `if` checked `github.event_name == 'workflow_call'`,
but inside a reusable workflow `github.event_name` is always the caller's
event (`pull_request_target`), never `workflow_call`. Result: workflow
always skipped for external callers.

**Fix**: Upstream removed the `event_name` check in v4.16.1.

### Phase 2: Author allowlist rejected mrbro-bot (bfra-me/.github#2003)

The action hardcoded `['renovate[bot]', 'bfra-me[bot]']` as allowed
PR authors. `mrbro-bot[bot]` (our Renovate app) wasn't in the list.

**Fix**: Upstream changed to `endsWith('[bot]')` in v4.16.2.

### Phase 3: Sed workaround in release.yaml (bfra-me/.github#2012)

Added a `Normalize changeset targets` step to `release.yaml` that
rewrote `@marcusrbrown/infra-workspace` → `@marcusrbrown/infra` in
changeset frontmatter before `changesets/action` ran. Worked but was
duct tape — fragile regex, extra CI step, masked the real problem.

**Upstream fix**: v4.16.4 made `getRootPackageName()` skip private
workspace roots. Workaround removed in PR #114.

### Phase 4: Upstream fix was insufficient

Even after v4.16.4, the action still generated changesets for
github-actions updates. `getRootPackageName()` now correctly fell
back to `@marcusrbrown/infra` (first non-private member), but the
fundamental issue remained: workflow SHA pin updates don't affect
the published CLI package and shouldn't generate changelog entries.

## Solution

Switched from the reusable workflow to calling the published action
directly (`renovate-changesets@0.2.31`), gaining access to two inputs
the reusable workflow didn't expose:

```yaml
# .github/workflows/renovate-changesets.yaml
- name: Generate Renovate changesets
  uses: bfra-me/.github/.github/actions/renovate-changesets@06b5ae65... # renovate-changesets@0.2.31
  with:
    token: ${{ steps.get-app-token.outputs.token }}
    commit-back: 'true'
    max-retries: '3'
    target-package: '@marcusrbrown/infra'
    exclude-patterns: '.github/**,apps/**,bun.lock,package.json'
```

- **`exclude-patterns`**: Removes non-CLI files from the action's file
  detection before package resolution runs. github-actions SHA pins,
  Docker digest bumps, root dev-deps, and private app changes all
  produce "No relevant files changed, skipping."
- **`target-package`**: Safety net — any file that slips through the
  exclude filter gets directed to the correct published package.

Result: only Renovate PRs that modify files under `packages/cli/`
generate changesets. Everything else merges without a changelog entry.

## Why This Works

The exclude-patterns approach is fundamentally better than all
previous workarounds because it operates at the right layer — it
prevents the action from even considering irrelevant files, rather
than fixing up bad output after the fact. The action's `run-analysis.ts`
applies exclude-patterns before any file-to-package matching runs,
so the fallback chain never fires for excluded paths.

## Prevention

1. **When using reusable workflows from external orgs**: Always check
   what inputs are exposed vs what the underlying action supports.
   The reusable workflow abstraction can hide critical configuration
   options. If you need inputs the wrapper doesn't expose, call the
   action directly.

2. **Monorepo changesets scope**: In a monorepo with a private root
   and one published package, always set both `exclude-patterns`
   (deny-list for non-shipping paths) and `target-package` (explicit
   fallback). Belt and suspenders.

3. **Test renovate-changesets with every manager type**: The bun
   manager (package.json changes) behaves differently from the
   github-actions manager (workflow SHA pins) and the docker manager
   (digest bumps). Each has different file-to-package resolution
   paths. A fix that works for one manager may not work for another.

4. **Don't trust upstream fixes without empirical verification**:
   We removed the sed workaround (PR #114) after upstream v4.16.4
   shipped, but the next Renovate PR immediately broke the Release
   workflow again. The upstream fix addressed the symptom (wrong
   package name) but not the cause (unwanted changesets for non-CLI
   changes).

5. **Changesets in monorepos should be scoped to published packages**:
   Not every file change needs a changelog entry. Dev tooling,
   workflow configs, lockfiles, and private app packages don't ship
   to npm and shouldn't pollute the release pipeline.
