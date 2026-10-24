---
title: "Brokered push checked out main but anchored trusted-head-sha on the PR head"
date: 2026-10-20
category: integration-issues
module: .github/workflows/fro-bot.yaml
problem_type: integration_issue
component: development_workflow
symptoms:
  - "A re-review mention on a PR that changed only apps/gateway/upstream.json failed the run"
  - "Run failed with 'Brokered push delivery failed: apps/gateway/upstream.json: path is not allowed for brokered push'"
  - "Fro Bot posted an Internal Error comment although the agent had edited nothing"
root_cause: config_error
resolution_type: workflow_improvement
severity: medium
tags: [fro-bot, github-actions, issue-comment, brokered-push, trusted-head-sha, checkout, allowlist, pr-head]
related_issues:
  - https://github.com/marcusrbrown/infra/pull/1620
  - https://github.com/marcusrbrown/infra/pull/1622
related_docs:
  - docs/solutions/best-practices/fro-bot-brokered-push-issue-comment-2026-08-28.md
---

# Brokered push checked out main but anchored trusted-head-sha on the PR head

## Problem

An `@fro-bot` mention on a same-repo PR failed delivery whenever the PR changed a path outside the brokered-push allowlist. The `fro-bot-content` job checked out `main` but passed the PR head SHA as the brokered-push anchor, so every difference between `main` and the PR looked like an edit by the agent.

## Symptoms

- A mention asking for a re-review on [#1620](https://github.com/marcusrbrown/infra/pull/1620), whose only change was `apps/gateway/upstream.json`, failed with `Brokered push delivery failed: apps/gateway/upstream.json: path is not allowed for brokered push`.
- Fro Bot posted an "Internal Error … a changed file path is outside the brokered-push allowlist" comment, and the trigger comment got a `confused` reaction.
- The PR branch head did not change.

## What Didn't Work

- **Reading it as an agent edit.** The first explanation was that Fro Bot had tried to edit the file. The run's OpenCode log artifact showed one read of the file (`git show <sha> -- apps/gateway/upstream.json`) and a single edit, to its own response file. The "changes" came from the checkout, not from the agent.

## Solution

Resolve the same-repo PR head first, then check out that ref. An empty ref (fork PR, non-PR comment, API error, any other event) falls back to the default branch, so fork code still never enters the job.

Before, the checkout came first and had no `ref`, so it checked out the default branch:

```yaml
- name: Checkout repository
  uses: actions/checkout@<sha> # v7.0.1
  with:
    fetch-depth: 0
    persist-credentials: false
    token: ${{ secrets.FRO_BOT_PAT }}
```

After, the `prehead` step (`id: prehead` in `.github/workflows/fro-bot.yaml`) runs first, and the checkout (`.github/workflows/fro-bot.yaml:931-934`) uses its output:

```yaml
- name: Checkout repository
  uses: actions/checkout@<sha> # v7.0.1
  with:
    ref: ${{ steps.prehead.outputs.ref }}
    fetch-depth: 0
    persist-credentials: false
    token: ${{ secrets.FRO_BOT_PAT }}
```

`trusted-head-sha` on the `Run Fro Bot` step (`.github/workflows/fro-bot.yaml:968`) reads the same `steps.prehead.outputs.ref`.

## Why This Works

Brokered push rebuilds the agent's changes as a working-tree diff against `trusted-head-sha`. The upstream `reconstructChanges` runs `git diff` against that SHA and deliberately ignores local HEAD ([`src/features/delegated/reconstruct-changes.ts` at fro-bot/agent v0.124.1](https://github.com/fro-bot/agent/blob/0e317f0c78fed3aa5db3d6610f1a089ca13c4d04/src/features/delegated/reconstruct-changes.ts)). The diff only shows the agent's own edits when the working tree starts at that SHA. Every `@fro-bot` mention that passes the job's `if` (the comment-trigger clause on `fro-bot-content` in `.github/workflows/fro-bot.yaml`) takes this path, whatever the comment asks ([`packages/runtime/src/agent/response-delivery.ts` at the same tag](https://github.com/fro-bot/agent/blob/0e317f0c78fed3aa5db3d6610f1a089ca13c4d04/packages/runtime/src/agent/response-delivery.ts)).

## Prevention

- Never set the checkout `ref` and `trusted-head-sha` separately. The `fro-bot-content checkout matches the brokered-push anchor` suite in `packages/cli/src/conventions.test.ts` pins the step order, the shared ref, the checkout credentials, and the same-repo guard in the `prehead` script.
- When the action pin moves, re-check that `reconstructChanges` still diffs against the anchor. The links above are at the incident's tag.
- When a mention fails with a path rejection, read the run's OpenCode log artifact before blaming the agent: it shows every edit permission the agent asked for.
- Not yet confirmed live: bot comments skip the job, so the first check is the next human `@fro-bot` mention on a same-repo PR that changes a path outside the allowlist.

## Related Issues

- [#1620](https://github.com/marcusrbrown/infra/pull/1620) — the PR whose mention failed.
- [#1622](https://github.com/marcusrbrown/infra/pull/1622) — the fix.
- [fro-bot-brokered-push-issue-comment-2026-08-28.md](../best-practices/fro-bot-brokered-push-issue-comment-2026-08-28.md) — the brokered-push wiring this fix extends: the `prehead` same-repo check, the allowlist, and the empty-anchor bypass.
