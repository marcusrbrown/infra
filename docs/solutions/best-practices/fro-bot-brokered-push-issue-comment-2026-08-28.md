---
title: Brokered push on issue_comment mention runs — auth model and the silent trusted-head-sha bypass
date: 2026-08-28
category: best-practices
module: .github/workflows/fro-bot.yaml
problem_type: architecture_pattern
component: ci_cd
severity: medium
applies_when:
  - "Diagnosing why fro-bot did not push a commit on an issue_comment mention run"
  - "Reasoning about why a workflow job with contents: read can still push via the agent action"
  - "Adding or auditing the trusted-head-sha wiring for PR-comment-triggered runs"
tags: [fro-bot, github-actions, issue_comment, push, trusted-head-sha, permissions]
---

# Brokered push on issue_comment mention runs — auth model and the silent trusted-head-sha bypass

## Context

Issue #1194 set out to "evaluate" adding brokered push support for `@fro-bot` mention runs on `issue_comment`. The evaluation found the agent action has **always** supported pushing on this trigger — there was no missing feature to build, only workflow wiring to add (shipped in #1213).

## Guidance

**The push write authenticates via the action's `github-token` input, not the workflow's `GITHUB_TOKEN`.** `fro-bot-content` in `.github/workflows/fro-bot.yaml` passes `github-token: ${{ secrets.FRO_BOT_PAT }}` to `fro-bot/agent`. The action uses that PAT for its own git operations, independent of the job's `permissions:` block. That's why the job can declare `contents: read` / `pull-requests: read` (least privilege for checkout and PR reads) and pushes still work — no `contents: write` grant is needed or should be added.

**A missing `trusted-head-sha` is a silent no-push, not an error.** The `Resolve same-repo PR-head ref` step (`id: prehead`) only resolves a ref when the triggering PR's head repo matches the workflow's own repo (guards against pulling fork-controlled code into a secret-bearing run). If that resolution fails or the PR head is a fork, `steps.prehead.outputs.ref` is empty, `trusted-head-sha` is passed as `""`, and the action quietly skips the push. There's no failure surfaced — the run looks identical to "push isn't supported," which is the trap that made this look like a missing feature during triage.

## Why This Matters

Conflating "no push happened" with "push isn't wired" leads to redundant feature-evaluation work (as #1194 shows) instead of checking the actual gate: is `trusted-head-sha` resolving to a non-empty value for this trigger. The fix is always in the `prehead` step's same-repo check, never in the action's `github-token` auth path.

## When to Apply

- A mention run on a PR comment made no commit and no error is visible — check whether the PR head repo matched the workflow repo before assuming push is unsupported.
- Auditing job `permissions:` for fro-bot workflows — `contents: write` is not required for push to work and should not be added just because a push is expected.

## Related

- `.github/workflows/fro-bot.yaml` — `prehead` step and `trusted-head-sha` wiring on `fro-bot-content`.
- Shipped in PR #1213 (`ci(fro-bot): enable brokered pushes for mention runs`), following the evaluation in #1194.
