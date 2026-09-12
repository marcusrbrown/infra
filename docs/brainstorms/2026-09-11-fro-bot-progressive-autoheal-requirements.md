---
date: 2026-09-11
topic: fro-bot-progressive-autoheal
---

# Fro Bot Progressive Autoheal

## Summary

Evolve the existing Fro Bot workflow into a tighter daily improvement loop that combines proactive detection, bounded reactive repair, portfolio learning, and reliable single-report reconciliation. Deferred work is recorded as concise, unassigned notes that another LLM agent can execute without prior context.

---

## Problem Frame

The repository already runs a mature daily autoheal strategy inside the main Fro Bot workflow. It repairs eligible failing PRs, reports security and workflow risks, verifies quality gates and deployments, reviews the live KeeWeb site, compares sibling repositories, and watches pinned upstream projects. Separate maintenance or autoheal workflows are not needed.

The reporting contract is not holding in production. Twelve daily reports from August 31 through September 11 remain open. They were created by `fro-bot` and carry the managed body marker, but lack the `autoheal-report` label; the strict trust gate therefore refuses to adopt or close them. The prompt describes a perpetual single-report outcome, while live state has no trusted canonical report.

The current report also favors exhaustive status output over accumulated learning. Repeated green checks and low-signal comparisons can crowd out systemic improvements derived from recurring incidents, stale assumptions, active plans, and patterns proven elsewhere in the project portfolio.

In this document, a **managed daily report** means an issue with the exact daily title format, exact `fro-bot` authorship, the managed marker, and the `autoheal-report` label. A **canonical report** is the one managed daily report selected to remain open for the current UTC date.

---

## Actors

- A1. Repository owner: reviews proposed changes, retains control of high-risk operations, and consumes the daily report.
- A2. Fro Bot daily agent: detects issues, applies bounded repairs, reconciles the managed report, and records durable improvement notes.
- A3. Future LLM agent: receives an unassigned note and must be able to act without access to the originating autoheal session.
- A4. GitHub Actions and GitHub Issues: provide execution, repository state, and the shared reporting surface.

---

## Key Flows

- F1. Daily proactive and reactive autoheal
  - **Trigger:** The daily schedule or an empty manual dispatch runs on the default branch.
  - **Actors:** A2, A4
  - **Steps:** Inspect eligible failures and operational signals, apply only bounded repairs, synthesize progressive improvements, reconcile the managed report, and verify final state.
  - **Outcome:** Safe repairs are proposed through PRs, risks are reported, and exactly one current managed report remains open.
  - **Covered by:** R1, R2, R3, R8, R10, R12
- F2. Recover drifted report lineage
  - **Trigger:** Bot-authored marker-bearing daily reports exist without the managed label.
  - **Actors:** A2, A4
  - **Steps:** After a successful agent run, a deterministic workflow-owned gate establishes trusted authorship, inspects only the marker predicate, adopts eligible reports, selects the canonical report, and closes superseded reports idempotently.
  - **Outcome:** Historical drift is repaired without trusting or mutating title-only collisions.
  - **Covered by:** R6, R7, R8, R12
- F3. Hand off an improvement opportunity
  - **Trigger:** A finding is valuable but outside the daily agent's safe mutation boundary.
  - **Actors:** A2, A3
  - **Steps:** Capture the desired outcome, evidence, relevant paths, constraints, current status, and verification criteria without assigning a named agent.
  - **Outcome:** Another LLM agent can continue the work from the report alone.
  - **Covered by:** R4, R5, R11
- F4. Manual production validation
  - **Trigger:** The workflow changes merge to the default branch.
  - **Actors:** A1, A2, A4
  - **Steps:** Run the normal daily strategy manually, inspect its issue mutations, and verify the perpetual-report postcondition.
  - **Outcome:** The live backlog is reconciled and runtime behavior matches the prompt contract.
  - **Covered by:** R9, R12

---

## Requirements

**Workflow shape and safety**

- R1. Proactive and reactive autoheal behavior remains in `.github/workflows/fro-bot.yaml`; no separate autoheal, organization-autoheal, or maintenance workflow or schedule is introduced.
- R2. The existing daily schedule, empty-prompt manual-dispatch behavior, custom-prompt dispatch behavior, reactive content path, trusted-head handling, storage-backed daily path, hardened egress, and least-privilege boundaries remain intact.
- R3. Existing infra-specific coverage remains intact, including failed-PR repair, security remediation, repository hygiene, workflow integrity, quality gates, deploy health and stranded-deploy detection, CLIProxy auth monitoring, live-site review, cross-project intelligence, and upstream modernization.
- R4. Workflow, automation-prompt, deployment, server, environment, credential, branch-protection, merge, and approval changes remain human-directed and report-only unless an existing narrower category already authorizes the exact mutation. Schedule and empty-prompt dispatch runs skip session-cache restore so each daily-equivalent scan starts fresh; custom dispatches retain normal cache behavior.

**Progressive improvement**

- R5. The daily strategy includes a report-only progressive-improvement synthesis that derives at most three high-leverage opportunities from evidence already gathered by existing categories, recent repository changes, active plans, and documented incidents. It must not re-scan or reinterpret surfaces owned by another category.
- R6. Progressive improvement prefers durable guardrails, tests, automation, runbooks, and simplification over repeating prompt warnings or creating recurring manual work.
- R7. A progressive-improvement item is reportable only when it identifies a recurring documented failure, a blocked active plan, a stale operational assumption, a missing mechanical guardrail, or a proven cross-project pattern with a concrete local adoption path. Unchanged or monitor-only observations are omitted.
- R8. Cross-project intelligence remains observation-only and data-minimized. It may identify portable patterns in either direction only when supported by public-safe evidence and a concrete adoption path; it must not copy raw issue bodies, secrets, environment values, private operational details, or other repository content into a destination where that content is not already appropriate.

**Agent-ready notes**

- R9. Deferred actionable work is recorded in a dedicated section of the canonical report as unassigned notes optimized for LLM agents, not as separate task issues, comments, repository files, or assignments to Fro Bot, Copilot, or another named agent.
- R10. The section contains at most three notes. Each note states the desired outcome, minimum durable evidence or references, relevant paths or surfaces, material safety constraints, and a concrete verification target; status or blocker is included only when it changes execution.
- R11. Notes must not depend on hidden session context, name an agent assignee, use vague directives such as “investigate” without a bounded outcome, or repeat an existing issue or PR unless its evidence, blocker, or required decision materially changed.
- R12. The report omits unchanged green-status boilerplate and repeated low-signal findings when they do not change an operator decision or enable future work. Existing issues, PRs, run history, and source documents remain the audit trail; no second reporting store is introduced.

**Single-report reconciliation**

- R13. Report reconciliation is enforced by a deterministic workflow-owned gate after a successful daily-agent step. Prompt text remains responsible for report content but is not the enforcement boundary for issue identity, adoption, closure, or final-state verification.
- R14. A managed daily report requires the exact title format `Daily Autohealing Report — YYYY-MM-DD`, exact `fro-bot` authorship, the managed marker, and the `autoheal-report` label. Title-only collisions remain untrusted and untouched.
- R15. A bot-authored issue with the exact daily title format and managed marker but no managed label may be adopted by adding the label. Issue titles, bodies, and comments are always untrusted data: the deterministic gate may evaluate fixed author, title, label, state, and marker predicates, but must not pass issue text to the LLM as instructions.
- R16. Discovery uses complete pagination and is fail-closed. An incomplete page set, API inconsistency, or failed trust, label, mutation, or readback operation halts reconciliation before any later mutation; untrusted candidates are never mutated.
- R17. Daily-equivalent runs are serialized by the existing concurrency group. The agent uses the lowest issue number among valid same-day candidates and writes the current workflow run ID as an inert body marker. The gate selects the one trusted or adoptable current-date issue carrying that exact run marker; absence or ambiguity fails without creating report content or closing reports.
- R18. Before destructive mutation, the gate verifies that the canonical body contains the managed marker, current run marker, and required report sections. Each noncanonical issue is revalidated by numeric issue ID immediately before mutation, labeled if adoptable, given at most one supersession comment authored by `fro-bot` for the selected canonical issue, and closed.
- R19. Mutation ordering and retry behavior are idempotent. A later run must repair partial label, comment, or close progress without duplicating supersession comments or assuming the prior run completed.
- R20. Final readback must prove exactly one open managed daily report, that it is the selected current-date canonical issue, and that no untrusted issue was mutated.
- R21. A clean first run may create the current report; later runs update the same report rather than creating one report per day.

**Validation and output**

- R22. The existing single daily-report format remains the operator surface, extended only with `Progressive Improvement` and `Agent-Ready Notes`; `Needs Human Attention` remains reserved for approvals, secrets, irreversible actions, and untrusted collisions.
- R23. The implementation is covered by behavior tests for deterministic reconciliation and repository-level workflow convention tests for trigger parity, safety, post-agent ordering, report headings, and the invariants that can be checked statically.
- R24. The schedule and empty-prompt manual dispatch execute the same prompt and deterministic reconciliation gate. A non-empty custom prompt executes only the custom request and must not invoke daily-report reconciliation.
- R25. After merge, one empty-prompt manual dispatch exercises the normal daily strategy and must reconcile the existing report backlog to exactly one open managed daily report without changing production infrastructure.

---

## Acceptance Examples

- AE1. **Covers R13-R20.** Given twelve open issues authored by `fro-bot` with the managed marker but no managed label and one current-date report containing the current run marker, when the deterministic gate runs, all eligible issues are adopted, the run-marked report remains open, and every other managed report is closed with at most one bot-authored supersession comment.
- AE2. **Covers R14-R16, R20.** Given an issue whose title matches the daily-report prefix but whose author or marker is not trusted, when reconciliation runs, the issue text is not passed to the LLM and the issue is neither labeled, edited, commented on, nor closed.
- AE3. **Covers R16, R19.** Given an API or pagination failure while discovering reports, or a non-404 failure while checking the managed label, when the gate cannot prove the candidate set is complete, it fails without creating a report or mutating a later candidate. A later run safely repairs any mutation already completed before the failure.
- AE4. **Covers R5-R7, R12.** Given several green checks and one recurring incident that lacks a mechanical guardrail, when the report is written, the recurring incident becomes one of at most three progressive-improvement findings while unchanged green boilerplate is omitted.
- AE5. **Covers R9-R11.** Given a deferred workflow-integrity finding, when it is recorded, the canonical report contains a concise unassigned note with outcome, evidence, constraints, paths, and verification target, without creating another artifact or naming an agent assignee.
- AE6. **Covers R1-R4, R24.** Given an empty manual dispatch on the default branch, when the workflow runs, it executes the same fresh-session prompt, storage path, and deterministic gate as the schedule; a non-empty custom prompt executes only the custom request and retains normal cache behavior.
- AE7. **Covers R8.** Given a useful pattern in a sibling repository, when cross-project intelligence reports it, the report uses sanitized public-safe evidence and a concrete local adoption path without modifying or opening work in that repository.
- AE8. **Covers R25.** Given the current twelve-report backlog and a merged implementation, when one empty-prompt manual dispatch succeeds, live readback shows exactly one open current-date managed daily report and eleven or more superseded managed reports closed, with production infrastructure unchanged.

---

## Success Criteria

- The repository has one Fro Bot workflow and one daily autoheal schedule.
- A live manual run leaves exactly one open current-date managed daily report and closes the current backlog of superseded managed reports.
- The report contains concise progressive-improvement findings and agent-ready notes only when they change an operator decision or support future execution.
- Existing reactive repair, operational checks, trust boundaries, credentials, hardened egress, and cross-repository read-only constraints do not regress.
- Another LLM agent can execute any recorded note from the canonical report without needing the originating run's conversation or hidden context.

---

## Scope Boundaries

- No separate `fro-bot-autoheal.yaml`, `fro-bot-autoheal-org.yaml`, or maintenance schedule.
- No wholesale import of the Space Bus or Mothership prompts.
- No new GitHub token permissions, secrets, environments, dependencies, or lockfile changes.
- No cross-repository mutations, assigned tasks for named agents, autonomous workflow edits, deployments, server changes, or merges.
- No replacement or reduction of the repository's existing infra-specific operational checks.
- No broad refactor of the content-triggered PR-review path beyond changes required to preserve shared workflow behavior.

---

## Key Decisions

- Preserve the single combined workflow: the repository already has the requested proactive and reactive strategy in one place.
- Repair trust drift through constrained adoption: exact title format and bot authorship plus a fixed marker predicate are sufficient to restore the missing label without weakening the title-collision boundary.
- Make progressive improvement a synthesis layer: it should turn evidence from existing categories into systemic opportunities rather than duplicate their scans.
- Keep deferred work unassigned and in the canonical report: agent-ready notes describe executable outcomes and constraints without adding a task-management subsystem or coupling work to a specific agent product.
- Enforce issue state outside the prompt: a deterministic post-agent gate owns adoption, cleanup, and readback because live prompt-only reconciliation already failed.
- Bind cleanup to fresh content: a per-run inert body marker proves which current-date report the successful agent run wrote before older reports may be closed.
- Validate with production state: static and behavior tests cannot fully prove GitHub issue reconciliation, so the existing backlog is the post-merge acceptance fixture.

---

## Dependencies / Assumptions

- The `autoheal-report` label exists and current bot-authored reports retain the managed body marker.
- The `FRO_BOT_PAT` available to the storage-backed job can label, edit, comment on, and close issues.
- The action pinned in this repository continues to support trusted-head handling, schedule cache isolation, prompt selection, and S3-backed session storage.
- GitHub issue authorship and numeric issue IDs remain stable trust signals for reports created by the workflow.
- GitHub's `GITHUB_RUN_ID` is stable for the workflow run and is available to the agent step and deterministic gate.

---

## Sources / Research

- `.github/workflows/fro-bot.yaml`
- `docs/solutions/workflow-issues/fro-bot-schedule-session-bloat-no-op-2026-06-14.md`
- `docs/solutions/workflow-issues/autoheal-single-report-reconciliation-label-anchor-deadlock-2026-08-03.md`
- `docs/solutions/integration-issues/fro-bot-storage-egress-allowlist-false-outage-2026-08-03.md`
- `fro-bot/space-bus` workflow at commit `49f503d1db3259c89ae1b335f9c35b8fd4992719`
- `marcusrbrown/mothership` workflow at commit `bc5ccd6aa3dfa6e1f1786884d70855207349003d`
- `fro-bot/agent` action at commit `620a314e241ec2f4a72167eb1ad2c5a3a909cc86`
