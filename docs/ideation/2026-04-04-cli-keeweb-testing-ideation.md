---
date: 2026-04-04
topic: cli-keeweb-testing
focus: testing for @marcusrbrown/infra CLI and KeeWeb app deployment
---

# Ideation: Testing for CLI & KeeWeb Deployment

## Codebase Context

Bun workspace monorepo with zero test infrastructure — no test files, no test deps, no test scripts, no test config. CI only runs lint + typecheck. CLI uses goke framework with Zod schemas; KeeWeb build downloads a zip, SHA-256 verifies, extracts, and injects secrets. Deploy uses bash + rsync over SSH. Known past failures include lockfile staleness, backup directory permissions, and group-write permission breakage from activation script.

Bun's built-in test runner (`bun:test`) provides Jest-compatible API with `mock()`, `spyOn()`, snapshot testing, and `*.test.ts` convention — no extra dependencies needed.

## Ranked Ideas

### 1. Test Infrastructure Foundation
**Description:** Create shared test helpers (temp dir management, fixture loading, CLI spawn wrappers, fetch mocking patterns). Add `bun test` scripts to all workspace packages. Wire into CI and pre-commit hooks.
**Rationale:** Everything else depends on this. Without infrastructure, each test reinvents plumbing.
**Downsides:** Upfront cost before any actual test coverage. Risk of over-engineering helpers.
**Confidence:** 95%
**Complexity:** Low-Medium
**Status:** Explored

### 2. CLI Help/Option Snapshot Tests
**Description:** Snapshot test all `--help` outputs and command discovery. Assert goke registers all expected commands. Test Zod schema validation catches invalid inputs.
**Rationale:** Cheapest tests to write, highest compound value. Every future CLI change gets regression coverage for free.
**Downsides:** Snapshot noise on intentional changes (acceptable — update snapshots).
**Confidence:** 90%
**Complexity:** Low
**Status:** Unexplored

### 3. KeeWeb Build Pipeline Integration Test
**Description:** Run `build.ts` end-to-end with mocked `fetch` (serve a small test zip fixture), controlled env vars, temp `dist/` directory. Assert: correct files produced, SHA-256 verification works, secret injected into `dist/config.json`, template untouched, empty secret when env unset.
**Rationale:** Covers the most complex single script. Catches upstream format changes, download failures, secret leakage, and extraction bugs.
**Downsides:** Needs a small fixture zip file. Mocking fetch at the right layer.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 4. CLI Deploy Command Option Contract Tests
**Description:** Unit test the deploy command's flag validation matrix: `--nginx` without `--local` throws, `--dry-run` short-circuits, local mode requires `SSH_AUTH_SOCK`, remote mode constructs correct `gh` command.
**Rationale:** This command has irreversible operational impact. Option semantics must be airtight.
**Downsides:** Some mocking complexity for `Bun.spawn` and env validation.
**Confidence:** 85%
**Complexity:** Medium
**Status:** Unexplored

### 5. Content Hash Drift Detection Test
**Description:** Test `checkContentHash` and `hashSha256` with controlled fixtures — missing local dist (warning), matching hashes (ok), mismatched hashes (warning), failed remote fetch (graceful fallback).
**Rationale:** Pure-ish function with clear branches. Anti-drift signal is operationally critical.
**Downsides:** Needs fetch mock for remote content.
**Confidence:** 80%
**Complexity:** Low
**Status:** Unexplored

### 6. Executable Conventions Test Suite
**Description:** Convert key AGENTS.md rules + `docs/solutions/` learnings into test assertions: workflow files use `.yaml`, no `secrets: inherit` cross-org, no `as any`/`@ts-ignore` in TS, no `ssh-keyscan` in CI workflows, SHA-pinned actions have version comments.
**Rationale:** Unique to this repo's AI-agent workflow. Makes institutional knowledge enforceable.
**Downsides:** Tests are structural/grep-based — can be brittle if over-specified.
**Confidence:** 75%
**Complexity:** Low-Medium
**Status:** Unexplored

### 7. Deploy Script Dry-Run Validation
**Description:** Test `deploy.sh` flag parsing and precondition checks (required env vars, file existence, `--nginx` flag behavior). Test the TypeScript deploy precondition validation similarly.
**Rationale:** Deploy scripts are high-risk paths with known failure history. Even basic precondition testing prevents regressions.
**Downsides:** Shell testing is inherently limited without a real SSH target.
**Confidence:** 70%
**Complexity:** Medium
**Status:** Unexplored

### 8. Published Package Smoke Test
**Description:** After packaging, execute the CLI entrypoint from the package root (not source path) and verify shebang works, `--help` exits 0, `--version` prints correct version.
**Rationale:** Source tests can pass while the distributed artifact breaks.
**Downsides:** Only useful around release time. Marginal if snapshot tests cover `--help`.
**Confidence:** 65%
**Complexity:** Low
**Status:** Unexplored

## Rejection Summary

| # | Idea | Reason Rejected |
|---|------|-----------------|
| 1 | Malformed config parse failure | Low-value edge case |
| 2 | Date formatting stability | Trivial fix, not a testing idea |
| 3 | Error message surface tests | Subsumed by CLI E2E and option contract tests |
| 4 | MCP bridge contract test | Low drift risk (auto-generated by goke), too complex for v1 |
| 5 | Local SSH sandbox deploy test | Requires container infra, overkill for project scale |
| 6 | Frozen-lockfile sentinel | CI `--frozen-lockfile` already IS the sentinel |
| 7 | Deploy workflow YAML parsing | Brittle, poor ROI |
| 8 | Activation permission invariant | Requires server access, not CI-testable |
| 9 | Backup path chaos test | Needs real user/group semantics |
| 10 | Nightly full deploy rehearsal | Overkill for current scale |
| 11 | Changeset contract tests | Low ROI — upstream well-tested |
| 12 | AI regression corpus | Premature — need base tests first |

## Session Log
- 2026-04-04: Initial ideation — 32 candidates generated (4 frames: unit, integration, CI/deploy, DX/leverage), 8 survived adversarial filtering
- 2026-04-04: Brainstormed top 5 ideas (foundation + snapshots + build + deploy + status) → requirements doc at docs/brainstorms/2026-04-04-cli-keeweb-testing-requirements.md
