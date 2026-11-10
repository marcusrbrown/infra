---
title: "GitHub's compare endpoint lists at most 300 changed files, so a path-change check must fail closed at 300"
date: 2026-11-10
problem_type: integration_issue
component: tooling
severity: medium
module: docs/runbooks
root_cause: wrong_api
resolution_type: documentation_update
symptoms:
  - "A path-change check on a large compare passes with no match although the diff touches a watched path"
  - "gh api --paginate on the compare endpoint returns extra pages that carry no files"
tags: [github-api, compare-endpoint, truncation, fail-closed, release-gates, discord-pass]
---

# GitHub's compare endpoint lists at most 300 changed files, so a path-change check must fail closed at 300

## Problem

The Discord-pass trigger in the gateway release gates decides whether a release touched the Discord checklist by reading the changed files of `compare/<anchor>...<REF>`. The first version read the list with `--paginate` and treated 3,000 or more files as truncated. The compare endpoint caps the list at 300, so a large diff could lose a matching file and report `none`, which skips a required human pass.

## Symptoms

- On a large release diff the check reports no checklist match, and the file list is missing entries.
- `gh api --paginate` returns more pages, but every page after the first has an empty file list.
- Nothing errors.

## What Didn't Work

- **`--paginate`.** On the compare endpoint pagination applies to commits. GitHub's [Compare two commits](https://docs.github.com/en/rest/commits/commits#compare-two-commits) documentation says the file list "is only shown on the first page of results, and it includes up to 300 changed files for the entire comparison". A live read of `v0.120.0...v0.136.5` returned 300 files on page one and 0 on each later page.
- **The 3,000 figure.** That limit belongs to [Get a commit](https://docs.github.com/en/rest/commits/commits#get-a-commit), which paginates a single commit's files up to 3,000.

## Solution

Read the file list once, with no `--paginate`, and treat an empty list or a list of 300 or more files as `trigger check failed`. That result requires the Discord pass. The runbook carries the commands under step 3 of [When the Discord pass runs](../../runbooks/operator-surface-acceptance-automated.md#when-the-discord-pass-runs). The count check:

<!-- prettier-ignore -->
```bash
jq 'length | if . == 0 or . >= 300 then "trigger check failed: \(.) files" else "files: \(.)" end' "$WORK/compare.json"
```

## Why This Works

A list of exactly 300 is ambiguous: the diff may have 300 files, or more files that GitHub truncated. Failing closed costs one extra human pass on a very large release. Failing open costs an unnoticed skip. An empty list also fails closed. It can be a valid compare, for example when a later commit reverts an earlier one, but it is more often a broken read, and the runbook does not tell the two apart.

## Prevention

- A path check built on `compare.files` must fail closed at 300 or get the file list from another source.
- Before reusing a limit, confirm which endpoint documents it.
- Test the boundaries whenever the check changes: 0, 299, 300 and 301 files. Only 299 may pass.

## Related

- [Discord pass checklist](../../runbooks/operator-surface-acceptance-automated.md#discord-pass-checklist)
- [Gate a human-only release check on a last-pass anchor](../best-practices/anchor-gated-conditional-human-pass-for-release-gates-2026-11-10.md)
- PR #1867, where review caught the 3,000 threshold
