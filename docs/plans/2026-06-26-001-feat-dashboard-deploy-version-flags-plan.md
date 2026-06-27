---
title: "feat: Add dashboard deploy version flags"
type: feat
status: completed
date: 2026-06-26
---

# feat: Add dashboard deploy version flags

## Overview

Add operator-facing `--image-version` and `--digest` flags to `infra dashboard deploy` so the CLI can dispatch the existing Dashboard deploy workflow's versioned release path. The workflow contract already exists; this plan wires the CLI to it without changing MCP exposure or deploy workflow behavior. The CLI flag is `--image-version` because goke reserves root `--version` before subcommand handlers see it.

## Problem Frame

The Dashboard deploy workflow accepts optional `version` and `digest` `workflow_dispatch` inputs, validates them before the environment gate, deploys the selected `ghcr.io/fro-bot/dashboard:<version>` image, and opens an audit PR when a versioned release runs. The CLI currently dispatches the same workflow with no inputs, so CLI and agent-assisted operators can only trigger the no-version fallback unless they drop down to raw `gh workflow run -f` commands.

## Requirements Trace

- R1. `infra dashboard deploy --image-version <YYYY.MM.N>` dispatches the Dashboard workflow with the `version` input.
- R2. `infra dashboard deploy --image-version <YYYY.MM.N> --digest <sha256:...>` dispatches the workflow with both inputs so the workflow cross-checks the resolved digest.
- R3. `infra dashboard deploy` with no release flags preserves the current no-version fallback behavior.
- R4. Invalid CalVer, invalid digest, and digest-without-version fail locally before spawning `gh`.
- R5. `--local` deploy mode remains unchanged and does not accept remote workflow dispatch flags.
- R6. `dashboard deploy` remains CLI-only and is not added to the MCP allowlist.
- R7. Because this changes the published CLI surface, include a patch changeset.

## Scope Boundaries

- Do not modify `.github/workflows/deploy-dashboard.yaml`; it already owns authoritative validation and deployment behavior.
- Do not add `deploy.yaml` aggregate passthrough inputs.
- Do not expose `dashboard deploy` over MCP.
- Do not add `GITHUB_TOKEN`, `GH_TOKEN`, `actions: write`, or a self-dispatch workflow step.
- Do not change local dashboard deploy semantics beyond rejecting remote-only release flags when `--local` is set.

### Deferred to Separate Tasks

- Package tarball smoke coverage for newly published CLI flags: separate CI/tooling hardening task. It is valuable, but it touches CI/build pipeline policy and is outside this CLI-only follow-up.
- Authenticated browser/API verification for operator routes: separate operational check; not required for CLI dispatch flags.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/src/commands/dashboard/deploy.ts` registers `dashboard deploy` with goke/Zod options, dry-run output, and remote `gh workflow run` dispatch.
- `packages/cli/src/commands/dashboard/deploy.test.ts` runs the real CLI entry point in dry-run mode and asserts planned command output.
- `packages/cli/src/__snapshots__/cli.test.ts.snap` snapshots CLI help output; new flags require snapshot refresh.
- `apps/dashboard/AGENTS.md` documents dashboard CLI usage and should mention the new flags.
- `.github/workflows/deploy-dashboard.yaml` declares optional `version` and `digest` inputs and validates them before environment approval.
- `packages/cli/AGENTS.md` requires goke schema-based options, non-interactive CLI surfaces, and keeps mutating deploy commands out of MCP.

### Institutional Learnings

- `docs/solutions/workflow-issues/fro-bot-schedule-session-bloat-no-op-2026-06-14.md`: do not introduce self-dispatch jobs or broaden `GITHUB_TOKEN` permissions to solve dispatch ergonomics.
- `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`: keep deploy concurrency at per-app workflows; do not reintroduce aggregate fan-out coupling.
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`: digest-pinned deploys need validation and explicit wiring through every entry point.
- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`: when adding deploy inputs, ensure every entry point forwards them deliberately; missing one hop creates silent drift.

## Key Technical Decisions

- Use CLI-side validation as fast-fail UX, not as the security boundary. The workflow remains authoritative because operators can still dispatch from GitHub UI or raw `gh`.
- Build the `gh workflow run` argv conditionally with `-f version=<value>` and `-f digest=<value>` only when values are present. Do not send empty inputs.
- Reject `--digest` without `--image-version` locally to mirror the workflow input-mode gate.
- Reject `--image-version` or `--digest` with `--local` because these flags target GitHub Actions dispatch, not the local Bun deploy path.
- Keep the command out of `MCP_ALLOWLIST`; environment-gated deploy mutation remains CLI-only.

## Open Questions

### Resolved During Planning

- Should `--digest` be mandatory when `--image-version` is set? No. The confirmed scope keeps digest optional so the workflow can resolve the digest itself; provided digest is a cross-check.
- Should the aggregate deploy workflow gain passthrough inputs? No. Confirmed scope is direct `deploy-dashboard.yaml` dispatch from CLI only.
- Should MCP expose versioned dashboard deploy? No. Confirmed out of scope.

### Deferred to Implementation

- Exact error wording for invalid option combinations: match existing terse CLI style while naming the offending flags.

## Implementation Units

- [x] **Unit 1: Add dashboard deploy release flags**

**Goal:** Extend `infra dashboard deploy` remote mode with validated `--image-version` and `--digest` options that forward to GitHub Actions inputs.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** None

**Files:**
- Modify: `packages/cli/src/commands/dashboard/deploy.ts`
- Test: `packages/cli/src/commands/dashboard/deploy.test.ts`

**Approach:**
- Add Zod-backed string options for `--image-version <version>` and `--digest <digest>` with help text matching the workflow vocabulary.
- Validate CalVer and digest shape before spawning `gh`.
- Validate `--digest` requires `--image-version`.
- Validate release flags are remote-only and rejected when `--local` is set.
- Refactor remote command construction into a small helper if it keeps dry-run output and spawn argv identical.

**Execution note:** Implement test-first for the new CLI behavior.

**Patterns to follow:**
- `packages/cli/src/commands/dashboard/deploy.ts` existing dry-run and `Bun.spawn` shape.
- `packages/cli/src/commands/gateway/deploy.ts` conditional flag argv construction.
- `.agents/skills/goke/SKILL.md` option schema and help-text rules.

**Test scenarios:**
- Happy path: no flags dry-run prints the existing `gh workflow run "Deploy Dashboard" --repo marcusrbrown/infra` command and no `-f` inputs.
- Happy path: `--image-version 2026.06.50 --dry-run` prints `-f version=2026.06.50` and no digest input.
- Happy path: `--image-version 2026.06.50 --digest sha256:<64 hex> --dry-run` prints both `-f` inputs.
- Error path: `--digest sha256:<64 hex> --dry-run` exits non-zero with a digest-requires-version message and does not dispatch.
- Error path: invalid versions such as `latest` or `v1.2.3` are rejected before dispatch.
- Error path: malformed digests such as `sha256:bad` or `md5:<64 hex>` are rejected before dispatch.
- Error path: `--local --image-version 2026.06.50 --dry-run` is rejected as a remote-only flag combination.

**Verification:**
- Dashboard deploy command tests pass and prove dry-run argv mirrors the spawn argv shape.

- [x] **Unit 2: Refresh CLI docs and package metadata**

**Goal:** Keep help snapshots, operator docs, and release metadata in sync with the new CLI surface.

**Requirements:** R6, R7

**Dependencies:** Unit 1

**Files:**
- Modify: `packages/cli/src/__snapshots__/cli.test.ts.snap`
- Modify: `apps/dashboard/AGENTS.md`
- Create: `.changeset/dashboard-deploy-version-digest.md`

**Approach:**
- Refresh the CLI snapshot after adding the flags.
- Update the dashboard CLI command table to mention `--image-version` and `--digest` for versioned workflow dispatch.
- Add a patch changeset because this changes the published `@marcusrbrown/infra` CLI surface.
- Leave `packages/cli/src/commands/mcp.ts` unchanged.

**Execution note:** Snapshot update follows the implementation test change; do not hand-edit snapshot output unless the test runner cannot update it.

**Patterns to follow:**
- Existing `.changeset/*.md` one-line patch entries.
- Existing `apps/dashboard/AGENTS.md` CLI command table wording.

**Test scenarios:**
- Happy path: root CLI help snapshot includes the new dashboard deploy options.
- Integration: no MCP allowlist change occurs; `dashboard deploy` remains absent from MCP.

**Verification:**
- CLI snapshot tests pass.
- Grep confirms no `dashboard deploy` MCP allowlist addition.

## System-Wide Impact

- **Interaction graph:** CLI `dashboard deploy` → `gh workflow run Deploy Dashboard` → existing workflow pre-gate validation → dashboard environment approval → deploy/audit PR. Only the CLI entry point changes.
- **Error propagation:** CLI validation failures should exit before `gh`; workflow validation remains the second gate for non-CLI dispatches.
- **State lifecycle risks:** No local state mutation. Versioned dispatch can create an audit PR via existing workflow behavior.
- **API surface parity:** GitHub UI/raw `gh` and CLI now have equivalent access to `version` and `digest` inputs; MCP intentionally remains read-only for dashboard deploy.
- **Unchanged invariants:** No `GITHUB_TOKEN` dispatch shim, no aggregate deploy concurrency changes, no deploy workflow contract changes.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| CLI and workflow validation drift | Keep workflow authoritative; CLI regex mirrors workflow contract and tests cover representative invalid values. |
| Accidental empty-string inputs sent to GitHub Actions | Build `-f` argv only for non-empty values. |
| Local deploy semantics become ambiguous | Reject release flags with `--local` rather than silently ignoring them. |
| Published package drift | Add changeset now; defer tarball smoke CI to separate approved tooling work. |

## Documentation / Operational Notes

- `infra dashboard deploy --image-version 2026.06.50` triggers the versioned release path and requires dashboard environment approval.
- Adding `--digest sha256:<64 hex>` makes the workflow fail if GHCR resolves the tag to a different digest.
- Omit both flags to use the committed compose pin.

## Sources & References

- `packages/cli/src/commands/dashboard/deploy.ts`
- `packages/cli/src/commands/dashboard/deploy.test.ts`
- `packages/cli/src/__snapshots__/cli.test.ts.snap`
- `apps/dashboard/AGENTS.md`
- `.github/workflows/deploy-dashboard.yaml`
- `packages/cli/AGENTS.md`
- `.agents/skills/goke/SKILL.md`
- `docs/solutions/workflow-issues/fro-bot-schedule-session-bloat-no-op-2026-06-14.md`
- `docs/solutions/workflow-issues/aggregate-deploy-concurrency-cancels-gated-deploys-2026-06-25.md`
- `docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`
- `docs/solutions/integration-issues/gateway-caddy-announce-ingress-self-404-2026-06-04.md`
