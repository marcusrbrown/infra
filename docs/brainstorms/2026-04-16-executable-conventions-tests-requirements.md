---
date: 2026-04-16
topic: executable-conventions-tests
source_ideation: docs/ideation/2026-04-04-cli-keeweb-testing-ideation.md
scope: standard
---

# Executable Conventions Tests

## Summary

Convert the structurally-checkable subset of root `AGENTS.md` rules into mechanically-enforced CI failures. Two mechanisms: ESLint severity/config changes for code-level rules (handled by `@bfra.me/eslint-config`'s bundled plugins without new additions), and a conventions test file for content-pattern rules (YAML workflow content, JSON value invariants, filesystem shape) where the ecosystem's existing ESLint plugin rules don't reach. Custom inline ESLint AST rules are deliberately out of scope for v1 — the cost of hand-rolling YAML/JSONC AST visitors exceeds the cost of equivalent assertions in a test, with no runtime benefit for CI-only enforcement.

Enforced rules in `AGENTS.md` get an in-place annotation marker so humans skimming the doc (and agents parsing it) can tell at a glance which rules are mechanical vs. judgment-based. Fro Bot autoheal category 3 stays as the post-merge safety net, trimmed to cover rules this suite doesn't mechanize.

## Problem

`AGENTS.md` rules decay because they're advisory. Agents violate them silently; reviewers miss violations in large diffs. Existing enforcement is advisory-by-default:

- ESLint — `@typescript-eslint/no-explicit-any` is currently **off** (severity 0) and `ban-ts-comment` allows `ts-expect-error` with description. Code-level convention rules don't actually fail CI today.
- Fro Bot autoheal category 3 — daily post-merge check, reports but doesn't gate.
- Reviewer diligence.

Concrete slipped-through examples: `bundledDependencies` added to `packages/cli/package.json` (broke publish), `apps/**` over-excluded in `renovate-changesets.yaml` (missed Docker image bump changelogs), file-naming drift. These pre-date autoheal going live; a supporting datapoint for planning is the count of category-3 violations autoheal has opened or auto-fixed in the 30–60 days since it started running, to calibrate whether the remaining drift rate justifies a pre-merge gate.

## Goals

- Pre-merge CI failure on violations of structurally-checkable root `AGENTS.md` rules.
- Every enforced rule is green on `main` the day the suite ships (fix-first, not baselined).
- Each enforced rule has a one-line link or reference to its implementation (ESLint rule name or conventions test assertion), and changing the rule updates AGENTS.md annotation and implementation in the same PR.
- Human contributors skimming AGENTS.md can tell at a glance which rules are mechanical.
- Agents benefit primarily from the CI failure itself — the annotation is secondary signal.

## Non-Goals

- Source-of-truth migration. AGENTS.md stays canonical for documentation; enforcement is additive.
- Judgment-based rules ("prefer root cause over symptom", first-person voice in `gh` comments, run `git status` before committing).
- Broad refactor of AGENTS.md beyond per-rule annotation markers and one factual correction (Rule 6 scope, below).
- Replacing or rebuilding Fro Bot autoheal category 3. The suite complements it; category 3 will be trimmed to non-mechanized rules in the same PR so it doesn't double-report.
- Baselining or allow-listing existing violations.
- Per-app AGENTS.md rules (`apps/keeweb/AGENTS.md`, `apps/cliproxy/AGENTS.md`, `packages/cli/AGENTS.md`). Root-only v1. Per-app extension is a follow-up once the mechanics are proven.
- New ESLint plugin additions beyond what `@bfra.me/eslint-config` already pulls in.
- Custom inline ESLint AST rules (covered in Mechanism Policy — the ecosystem's built-in content-pattern rules are insufficient and the hand-rolled alternative has no advantage over a test).
- Net-new regression encoding of compound-learning docs beyond what's named in the v1 rule set.

## Rules in Scope (v1)

9 rules. Mechanism assignments are firm (based on a feasibility audit of what `@bfra.me/eslint-config`'s bundled plugins actually ship).

| # | Rule | Source | Mechanism |
| --- | --- | --- | --- |
| 1 | No `as any` in source | AGENTS.md | ESLint: `@typescript-eslint/no-explicit-any` → error (currently off) |
| 2 | No `@ts-ignore` / `@ts-expect-error` in source | AGENTS.md | ESLint: `@typescript-eslint/ban-ts-comment` → error, no description carveout |
| 3 | No `bundledDependencies` in any `package.json` | AGENTS.md anti-pattern (Bun constraint) | Conventions test: glob `**/package.json`, JSON parse, assert no `bundledDependencies` key |
| 4 | `apps/keeweb/config/config.json` has empty `dropboxSecret` | AGENTS.md + `apps/keeweb/src/build.ts` contract | Conventions test: JSON parse, assert `.dropboxSecret === ''` |
| 5 | No `secrets: inherit` on any job whose `uses:` points to a cross-org workflow | AGENTS.md (cross-org constraint) | Conventions test: YAML parse each workflow, walk jobs, correlate `uses:` owner with an allowed-org list (`marcusrbrown/*`, internal), fail if `secrets: inherit` appears on a cross-org job |
| 6 | No `ssh-keyscan` under `.github/workflows/**` | `docs/solutions/` + AGENTS.md (scoped) | Conventions test: regex over workflow files |
| 7 | Every `uses: …@<sha>` has a trailing version comment (either `# vX.Y.Z` or `# <scope>@X.Y.Z`) | AGENTS.md (SHA-pin convention) | Conventions test: YAML parse, walk `uses:` values, correlate trailing line comment via source location |
| 8 | Files under `.github/workflows/` use `.yaml` extension (not `.yml`) | AGENTS.md | Conventions test: glob `.github/workflows/*.yml` must be empty. Explicitly scoped — `.github/settings.yml` is not a workflow and is exempt. |
| 9 | No `.sh` files outside `apps/keeweb/deploy.sh` | AGENTS.md (TypeScript-only policy) | Conventions test: glob `**/*.sh` minus the one exempt path must be empty |

**Dropped from initial draft:**

- **Rule 10** (`.github/renovate.json5` exists): structurally checkable but near-zero regression risk. The file has existed since repo inception; a silent rename would break Renovate visibly within one scheduled run. Not worth the enforcement weight.
- **Rule 11** (CLIProxyAPI management headers use `x-management-key`): confirmed covered by existing unit tests at `packages/cli/src/commands/cliproxy/config.test.ts:121,173`, and grep-style enforcement produces false positives on the legitimate Bearer usage in `setup.ts:407` (`assertProxyKeyWorks` hits `/v1/models` with a user API key — not a management call). Keep the coverage in unit tests.

## Mechanism Policy

1. **ESLint for code-level rules via existing built-ins.** Rules 1, 2 are severity/config changes to `@typescript-eslint/no-explicit-any` and `ban-ts-comment`. Both require a **real config change** (not just severity bump): rule 1's built-in is currently off, and rule 2's current config allows `ts-expect-error` with description — both need overriding in `eslint.config.ts` at error severity.
2. **Conventions test for content patterns, JSON value invariants, and filesystem shape.** Rules 3-9 all go here. Justification: `eslint-plugin-jsonc@3.1.2` and `eslint-plugin-yml@3.3.1` (bundled via `@bfra.me/eslint-config`) ship no content-pattern restriction rules (no `no-restricted-keys`, no `no-restricted-syntax` on JSONC/YAML AST). A hand-rolled custom ESLint rule targeting the YAML AST is 40-80 LOC per rule plus parser type imports, and offers no advantage over the equivalent TypeScript test since these rules run only on CI and don't need editor feedback. The test is simpler, shorter, and lives in a familiar place.
3. **Test location and path resolution.** One test file at `packages/cli/src/conventions.test.ts`. All file paths resolve via `path.resolve(import.meta.dir, '../../..')` to reach the repo root — do not use `process.cwd()`, which differs between `bun test --recursive` (CWD=repo-root) and `bun test` in `packages/cli/` (CWD=package). This pattern matches existing tests at `packages/cli/src/cli.test.ts:8` and the keeweb/cliproxy deploy tests.

## Success Criteria

- `bun run lint` fails on any violation of rules 1 or 2.
- `bun test --recursive` fails on any violation of rules 3 through 9.
- `bun run lint` and `bun test --recursive` are both green on `main` on ship day (fix-first policy).
- Enforced rules in root `AGENTS.md` carry a single `(enforced)` marker appended inline.
- Changes to any enforced rule update both the AGENTS.md prose and the enforcement (ESLint config entry or test assertion) in the same PR. Not mechanically enforced in v1 but stated as a working rule.

## Shipping Policy

- **Fix-first, ship green.** Audit each of rules 1-9 on `main` before enabling. Fix violations in the same PR if tally is small; split into audit PR + enable PR if tally is large for any single rule. Threshold for splitting is decided during planning based on the actual audit numbers, not before.
- **Audit is a planning-phase deliverable.** Produce per-rule violation counts as the first planning step, before deciding PR structure.

## AGENTS.md Annotation

Each enforced rule in root `AGENTS.md` gets a single `(enforced)` marker appended inline. Unenforced rules stay unannotated. One marker variant chosen deliberately to avoid drift when a rule's mechanism changes (ESLint ↔ conventions test) — demonstrated during this brainstorm's feasibility pass, where 5 rules moved mechanism. Anyone who needs to know *which* mechanism backs a rule greps `eslint.config.ts` or `conventions.test.ts`.

Plus one factual correction in the annotation pass: the current `Never use ssh-keyscan` anti-pattern in AGENTS.md should be narrowed to `Never use ssh-keyscan in CI workflows — host keys are pinned in .github/known_hosts. Provisioning scripts may use ssh-keyscan locally; apps/cliproxy/server/provision-droplet.ts is the current example.` This matches the Rule 6 scope and resolves the current discrepancy between the prose and the actual usage at `apps/cliproxy/server/provision-droplet.ts:217,219`.

## Fro Bot Category 3 Coordination

In the same PR as the enforcement lands, trim Fro Bot autoheal category 3's convention-check list to remove the items now mechanically gated. The prompt is at `.github/workflows/fro-bot.yaml` (category 3 of `SCHEDULE_PROMPT`). Category 3 retains:

- Items the v1 suite does not cover (e.g., AGENTS.md accuracy drift — a judgment call).
- Build + type-check + stale-TODO scans.
- Any convention named in AGENTS.md but not in rules 1-9.

This avoids double-reporting once enforcement is live.

## Open Questions

None. All brainstorm-phase product decisions resolved. Remaining items are planning-phase deliverables (see below).

## Audit Result (done 2026-04-16 on `main`)

**Zero violations across all 9 rules.** Ship-green is trivially achievable in a single PR.

| # | Rule | Violations | Notes |
| --- | --- | --- | --- |
| 1 | No `as any` / explicit `any` | 0 | Grep for `as any`, `: any`, `<any>`, `any[]`, `Record<…, any>`, `Promise<any>` across `apps/**/*.ts` and `packages/**/*.ts` all returned empty. |
| 2 | No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` | 0 | No existing comment directives. |
| 3 | No `bundledDependencies` | 0 | No `package.json` in the tree contains the key. |
| 4 | `apps/keeweb/config/config.json` `dropboxSecret === ''` | 0 | Confirmed `"dropboxSecret": ""` at line 26. |
| 5 | No cross-org `secrets: inherit` | 0 | 3 grep matches in `fro-bot.yaml` are all inside prompt heredoc prose (`PR_REVIEW_PROMPT` line 48, `SCHEDULE_PROMPT` lines 143, 315), not actual YAML keys on job definitions. This confirms the mechanism choice — a regex would false-positive; the conventions test must parse YAML and inspect only job-level keys. |
| 6 | No `ssh-keyscan` in `.github/workflows/**` | 0 | The one repo-wide occurrence is `apps/cliproxy/server/provision-droplet.ts:217,219`, outside the rule scope. |
| 7 | Every `uses: …@<sha>` has version comment | 0 | All 37 `uses:` lines across 9 workflow files carry either `# vX.Y.Z` or `# <scope>@X.Y.Z` (e.g., `# renovate-changesets@0.2.31`). |
| 8 | No `.yml` in `.github/workflows/` | 0 | Glob `.github/workflows/*.yml` returns empty. `.github/settings.yml` sits at `.github/` root, outside the rule scope. |
| 9 | No `.sh` outside `apps/keeweb/deploy.sh` | 0 | The single `.sh` file in the tree is the allowed one. |

Implication for planning: no per-rule PR split needed. One PR enables all rules, writes the conventions test, updates `eslint.config.ts`, annotates AGENTS.md, narrows the `ssh-keyscan` prose, and trims Fro Bot category 3.

## Planning Inputs
- Category-3 violation count from Fro Bot's issue history (last 30-60 days) to confirm the pre-merge-gate value proposition is sized right.
- Exact `ban-ts-comment` config: verify `{ 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false, minimumDescriptionLength: 0 }` at error severity produces the desired behavior.
- YAML parser choice for rules 5 and 7: `yaml-eslint-parser` (transitive via `eslint-plugin-yml`) vs. a direct `yaml` / `js-yaml` dep. Prefer the transitive if parsing through `Bun.file(...).text()` + `parse()` works cleanly from a test; add a direct dep only if transitive resolution is brittle under Bun's `.bun/` symlink layout.
- Comment correlation for rule 7: match by `comment.loc.start.line === valueNode.loc.end.line`; accept version forms `# v\d+\.\d+\.\d+` OR `# [\w@/-]+@\d+\.\d+\.\d+` (e.g., `# renovate-changesets@0.2.31`).
- Cross-org allowlist for rule 5: define as `['marcusrbrown', 'bfra-me']` or similar; finalize with the user during planning based on which reusable-workflow sources we've vetted.
- Category-3 prompt trim: produce the diff against `fro-bot.yaml` SCHEDULE_PROMPT alongside the enforcement changes.
- `ssh-keyscan` rule prose update in AGENTS.md: the factual correction described in the Annotation section.

## Alternatives Considered

- **Do-nothing + tighten ESLint severities only.** Rules 1, 2 can ship via ESLint config alone with no new test file and no annotations. This is about 20% of the proposed value for about 5% of the work. Rejected because it leaves the compound-learning and structural rules (3-9) advisory — specifically `bundledDependencies` (prior publish break), SHA-pin comments (convention drift vector), and `secrets: inherit` cross-org (audited risk).
- **Custom inline ESLint AST rules for rules 3-7.** Gives unified lint-run reporting but adds 40-80 LOC of AST-walking code per rule, requires learning `yaml-eslint-parser` / `jsonc-eslint-parser` AST shapes, and provides zero editor-time feedback for YAML/JSON content that editors don't live-lint. Rejected: equivalent expressiveness in a test is shorter, more familiar, and has the same CI failure profile.
- **Extend to per-app AGENTS.md in v1.** Would include the cliproxy `config.yaml`-never-overwritten rule (a high-value compound-learning invariant). Rejected for v1 to prove mechanics on root rules first; per-app is a clear follow-up.
- **Source-of-truth migration (slim AGENTS.md, reference tests).** Higher long-term leverage but larger churn and multiple feedback cycles. Deferred — annotation is the reversible first step.
