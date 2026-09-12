---
title: Fro Bot Progressive Autoheal Plan
type: feat
status: active
date: 2026-09-11
origin: docs/brainstorms/2026-09-11-fro-bot-progressive-autoheal-requirements.md
---

# Fro Bot Progressive Autoheal Plan

## Summary

Strengthen the existing combined Fro Bot workflow without adding another workflow or schedule. Keep the agent responsible for analysis and report content, add a deterministic post-agent issue reconciler for the single-report invariant, restore fresh sessions for daily-equivalent runs, and add bounded progressive-improvement and agent-ready-note sections.

## Problem Frame

The current prompt already combines reactive repair, daily proactive analysis, deploy health, live-site checks, cross-project intelligence, and an upstream watch. Production state disproves its reconciliation promise: twelve bot-authored marker-bearing daily reports are open without the required label, so the prompt's own trust gate treats every report as untrusted and closes none. Prompt instructions are not a reliable state-machine boundary.

## Technical Decisions

1. Keep `.github/workflows/fro-bot.yaml` as the only workflow and keep one daily cron.
2. Freeze `AUTOHEAL_DATE` once per run and give the agent an `AUTOHEAL_RUN_ID` marker.
3. Require daily-equivalent runs to start fresh with `skip-cache`; custom dispatches retain normal cache behavior.
4. Let the agent create or update report content; let a tested TypeScript gate own label adoption, duplicate closure, and readback.
5. Authenticate the reconciler with the existing `FRO_BOT_PAT`; do not widen `GITHUB_TOKEN` permissions.
6. Trust managed issues only after exact title format, authenticated actor identity, and body-marker checks. Use the current run marker to select fresh canonical content.
7. Keep progressive improvement report-only, evidence-backed, capped at three, and free of named-agent assignments.
8. Add no changeset because no published CLI surface changes.

## Unit 1 — Write the Reconciler Contract Tests

**Files**

- Add `packages/cli/scripts/reconcile-autoheal-reports.test.ts`
- Update `packages/cli/src/conventions.test.ts`

**Behavior tests**

- exhaustively follow pagination;
- identify the authenticated actor and reject an unexpected login;
- ensure the label with exact 200/404/other handling;
- treat only exact-title, bot-authored, marker-bearing issues as managed or adoptable;
- select exactly one current-date issue carrying the current run marker;
- reject missing or ambiguous run markers before destructive mutation;
- validate required report headings before destructive mutation;
- adopt unlabeled managed issues;
- ignore and preserve untrusted collisions;
- add one bot-authored supersession marker, close noncanonical issues, and read back each write;
- resume safely after partial comment/close progress;
- fail closed on API, parse, pagination, rate-limit, candidate-cap, or readback failure;
- verify exactly one current report remains and all untrusted snapshots are unchanged.

**Workflow contract tests**

- one workflow and one cron;
- no `fro-bot-autoheal*.yaml` or maintenance schedule;
- fixed date step before `Run Fro Bot`;
- `skip-cache` enabled for schedule and empty dispatch only;
- reconciler immediately after the successful agent step and skipped for custom prompts;
- existing permissions, egress, trusted-head, storage, and brokered-push constraints preserved;
- required report markers and headings present in the schedule prompt.

**Verification**

- New behavior tests fail before the implementation exists.
- New convention assertions fail against the current workflow.

## Unit 2 — Implement the Deterministic Reconciler

**Files**

- Add `packages/cli/scripts/reconcile-autoheal-reports.ts`
- Make Unit 1 behavior tests pass

**Contract**

- Read `GH_TOKEN`, `GITHUB_REPOSITORY`, `AUTOHEAL_DATE`, and `AUTOHEAL_RUN_ID` from the environment in an `import.meta.main` entrypoint.
- Export the reconciler and fetch boundary for direct tests.
- Use `Accept: application/vnd.github+json` and `X-GitHub-Api-Version: 2026-03-10`.
- Follow `Link rel=next` exactly with a maximum of 100 items per page.
- Authenticate with `GET /user`, require login `fro-bot`, and compare numeric actor IDs for managed issues and comments.
- Ensure `autoheal-report`; create only on confirmed 404, re-read on `422 already_exists`, fail on other states.
- Filter issue metadata before fetching bodies. Require the managed marker as the first body line and the current run marker on the canonical report.
- Reject more than 100 managed/adoptable open candidates before mutation.
- Validate canonical headings, then label the canonical issue if needed.
- For every noncanonical managed issue, re-read by numeric ID, adopt if needed, create one idempotent bot-authored supersession comment, close as duplicate, and read back.
- On ambiguous write failure, read back before deciding whether a retry is safe.
- Finish with fresh exhaustive discovery and verify one current canonical issue plus unchanged untrusted snapshots.
- Log only safe counts, numbers, statuses, and URLs; never log tokens or issue bodies.

## Unit 3 — Wire Progressive Autoheal Into the Existing Workflow

**Files**

- Update `.github/workflows/fro-bot.yaml`
- Complete `packages/cli/src/conventions.test.ts`

**Prompt changes**

- Preserve all existing operational categories.
- Add `Progressive Improvement` as a synthesis over evidence already collected; report at most three high-leverage opportunities.
- Add `Agent-Ready Notes`; at most three unassigned cold-start notes with outcome, evidence, paths, constraints, and verification.
- Omit unchanged green boilerplate, repeated low-signal findings, and monitor-only cross-project comparisons.
- Require public-safe cross-project evidence and a concrete local adoption path.
- Require a report every daily-equivalent run, including clean runs.
- Use exact `AUTOHEAL_DATE`; put the managed marker first and current run marker second.
- Align same-day canonical choice with the lowest valid issue number.
- Remove prompt ownership of closing old reports; the deterministic gate owns reconciliation.

**Job changes**

- Resolve the UTC date before the agent step.
- Pass date and run ID to the agent.
- Restore fresh sessions for schedule and empty-prompt dispatch via `skip-cache`.
- Run `bun run packages/cli/scripts/reconcile-autoheal-reports.ts` after successful daily-equivalent agent execution.
- Pass the existing PAT only through the step environment.
- Preserve one cron, custom prompt behavior, hardened egress, S3 storage, timeout, action pin, and permissions.

## Unit 4 — Validate, Review, Commit, and Open the PR

- Run `aft_inspect` after edits.
- Run targeted tests for the reconciler and workflow conventions.
- Run `bun run lint`, `bunx tsc --noEmit`, and `bun test --recursive`.
- Parse the workflow YAML and run `git diff --check`.
- Review correctness, reliability, security, maintainability, testing, TypeScript, project conventions, agent-native parity, API contracts, and adversarial failure cases.
- Resolve valid findings and rerun affected gates.
- Commit only intended files, push the requested branch, open the PR, monitor every check, and read the complete Fro Bot review body. Do not enable automerge.

## Unit 5 — Prove the Workflow on GitHub

After the PR merges:

1. Capture the current autoheal report issue IDs, labels, states, comments, and timestamps, plus a deployment-health baseline.
2. Dispatch `.github/workflows/fro-bot.yaml` once on `main` with an empty prompt.
3. Identify the new run by set difference and wait for terminal success.
4. Verify one open current-date report remains with bot identity, managed label, managed marker, exact run marker, and required new sections.
5. Verify the twelve legacy reports were adopted and closed with at most one bot-authored supersession marker each.
6. Verify untrusted collisions and production state were unchanged.
7. Inspect the report for evidence-backed progressive improvements and unassigned agent-ready notes.

If the run fails or cannot prove the postcondition, stop and diagnose from exact run/issue evidence before another dispatch.

## Validation Commands

```bash
bun test packages/cli/scripts/reconcile-autoheal-reports.test.ts
bun test packages/cli/src/conventions.test.ts
bun run lint
bunx tsc --noEmit
bun test --recursive
```

## Success Criteria

- One combined workflow and one daily schedule remain.
- Daily-equivalent runs start fresh; custom dispatches preserve cache behavior.
- Progressive improvement and agent-ready notes are bounded, useful, unassigned, and report-only.
- The single-report invariant is enforced by tested code rather than prompt compliance.
- One empty manual dispatch closes the current backlog and leaves exactly one trusted current report.
- No secrets leak, permissions widen, separate task system appears, or cross-repository mutation occurs.
