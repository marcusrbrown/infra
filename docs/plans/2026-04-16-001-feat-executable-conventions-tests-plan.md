---
title: 'feat: Enforce root AGENTS.md conventions with ESLint config and conventions test'
type: feat
status: active
date: 2026-04-16
origin: docs/brainstorms/2026-04-16-executable-conventions-tests-requirements.md
---

# Enforce root AGENTS.md conventions with ESLint config and conventions test

## Overview

Mechanically enforce the 9 structurally-checkable rules from root `AGENTS.md` via two mechanisms: ESLint config changes in `eslint.config.ts` (rules 1-2, code-level) and a new TypeScript test at `packages/cli/src/conventions.test.ts` (rules 3-9, content-pattern and filesystem shape). Annotate each enforced rule in root `AGENTS.md` with an `(enforced)` marker and narrow the `ssh-keyscan` anti-pattern prose. Trim Fro Bot autoheal category 3 to drop items now mechanically gated so the post-merge check doesn't double-report.

The brainstorm's audit confirmed zero violations on `main` across all 9 rules. Ship-green is trivial — everything lands in one PR, no cleanup commits required.

## Problem Frame

See origin doc for the full framing. Short version: `AGENTS.md` convention rules are advisory. Agents silently violate them, and the existing enforcement stack — ESLint with most convention-adjacent rules at warn/off severity, plus daily Fro Bot autoheal category 3 — reports but doesn't gate. Pre-merge CI failures would prevent the regressions we've already paid for (`bundledDependencies` publish break, `apps/**` over-exclusion in `renovate-changesets.yaml`, file-naming drift).

## Requirements Trace

From origin doc's "Rules in Scope (v1)":

- **R1**: No `as any` / explicit `any` in source (ESLint `@typescript-eslint/no-explicit-any` at error)
- **R2**: No `@ts-ignore` / `@ts-expect-error` / `@ts-nocheck` in source (ESLint `ban-ts-comment` at error with no description carveout)
- **R3**: No `bundledDependencies` key in any `package.json`
- **R4**: `apps/keeweb/config/config.json` has `settings.dropboxSecret === ''` (the key is nested under `settings`)
- **R5**: No `secrets: inherit` on any job whose `uses:` points to a cross-org workflow
- **R6**: No `ssh-keyscan` under `.github/workflows/**`
- **R7**: Every `uses: ...@<sha>` has a trailing version comment (`# vX.Y.Z` or `# <scope>@X.Y.Z`)
- **R8**: Files under `.github/workflows/` use `.yaml` (not `.yml`)
- **R9**: No `.sh` files outside `apps/keeweb/deploy.sh`

Plus Rset (origin "AGENTS.md Annotation"):

- **R10**: Each enforced rule in root `AGENTS.md` carries a single `(enforced)` marker
- **R11**: The `Never use ssh-keyscan` anti-pattern prose narrows to the CI-only scope
- **R12**: Fro Bot autoheal category 3 trims the convention checks now mechanically gated (same PR, same workflow file)

## Scope Boundaries

Full Non-Goals list lives in the origin doc. Plan-specific scope calls:

- Dropped from v1: Rule 10 (`renovate.json5` exists — near-zero regression risk), Rule 11 (CLIProxyAPI management headers — already covered by existing unit tests at `packages/cli/src/commands/cliproxy/config.test.ts:121,173`; grep-style enforcement would false-positive on the legitimate `Bearer` usage in `setup.ts:407`)
- Custom inline ESLint AST rules are deliberately out of scope — mechanism choice rests on what `@bfra.me/eslint-config`'s bundled plugins actually ship (see origin)

### Deferred to Separate Tasks

- Extending enforcement to per-app AGENTS.md rules (e.g., cliproxy `config.yaml`-never-overwritten invariant) — follow-up once root mechanics are proven
- Drift check mechanism (parse AGENTS.md for `(enforced)` markers, assert each maps to a real ESLint rule or test assertion) — explicitly deferred in origin; nice-to-have
- Category-3 violation count from Fro Bot's issue history (30-60 day baseline) — planning input flagged by origin's product review but not blocking

## Context & Research

### Relevant Code and Patterns

- `eslint.config.ts` — flat config using `@bfra.me/eslint-config`'s `defineConfig`. Adds overrides in named blocks. Pattern for rule severity overrides is a new named block with `rules:`.
- `packages/cli/src/cli.test.ts:8` — canonical path-resolution pattern: `const cliDir = resolve(import.meta.dir, '..')`. Conventions test uses the same shape but with `../../..` to reach repo root.
- `packages/cli/src/commands/keeweb/build.test.ts` and existing tests in `packages/cli/src/commands/cliproxy/` — file-reading + JSON-parsing patterns. Conventions test uses `Bun.file(path).text()` + `JSON.parse()`.
- `.github/workflows/fro-bot.yaml` — `SCHEDULE_PROMPT` category 3 lives in the multi-line YAML block starting around line 128. Trim target is the convention-compliance bullet list under "Verify convention compliance".
- Root `AGENTS.md` — rules live under `## Conventions` and `## Anti-Patterns (THIS PROJECT)`. Annotation pass appends `(enforced)` after the specific bullets matching R1-R9.

### Institutional Learnings

- `docs/solutions/workflow-issues/cliproxy-first-deploy-cascade-2026-04-06.md` documents the `ssh-keyscan`-in-CI class of incident — the rationale for R6.
- `docs/solutions/workflow-issues/bun-deploy-user-permissions-ci-2026-04-02.md` documents why `deploy-kw` permissions matter but is orthogonal to this plan.

### External References

Not needed. `yaml` package (npm) and `@typescript-eslint/ban-ts-comment` options are documented in their standard docs; no research gap.

## Key Technical Decisions

- **Add `yaml` package as a direct devDependency in `packages/cli/package.json`** (not root). Bun's `.bun/` symlink layout installs `yaml@2.8.3` transitively (via `eslint-plugin-yml`), but transitive deps aren't directly importable. `yaml` is a small, well-maintained package; adding it explicitly is cleaner than wrestling with transitive resolution. Devdep in the test's home package, not root workspace.
- **Cross-org allowlist for R5 is `['marcusrbrown']`**. Origin suggested `['marcusrbrown', 'bfra-me']` as a starting value. Narrowing to `['marcusrbrown']` makes R5 also enforce the explicit-secrets-pass pattern on `bfra-me/*` reusable-workflow calls (treating them as cross-org), which matches current practice — all `bfra-me/*` jobs in this repo already pass secrets explicitly rather than via `inherit`. If we ever want to let a specific `bfra-me` workflow use `inherit`, expand the list then.
- **R5 walker handles local reusable-workflow paths explicitly**. If `job.uses` starts with `./` or `../` (local reusable workflow), skip the cross-org check — local workflows are same-repo and `secrets: inherit` is legitimate for them. Only jobs whose `uses:` value has the `owner/repo/...@ref` shape and an owner outside `INTERNAL_ORGS` are cross-org.
- **Rule 7 uses a regex check, not YAML AST**. The `uses:` lines in our workflows are single-line forms (`uses: owner/name@sha # version-comment`). A line-oriented regex pass is simpler than AST comment correlation and suffices for the syntax we actually use. Regex: `/@[a-f0-9]{7,}\s+#\s+(v\d+(?:\.\d+){0,2}|[\w@/-]+@\d+(?:\.\d+){0,2})\s*$/` on each `uses:` value line. The check distinguishes two violation types: **missing** (no trailing content after the SHA) and **malformed** (trailing content present but doesn't match the version-comment regex). Error messages should name the case for clearer diagnostics. If multi-line `uses:` ever shows up, escalate to AST — noted in deferred.
- **Rule 5 uses YAML AST**. The brainstorm's audit proved naive regex false-positives on prose inside prompt heredocs (`SCHEDULE_PROMPT` / `PR_REVIEW_PROMPT` in `fro-bot.yaml`). Parse each workflow with `yaml`, walk `jobs.*` nodes, check each job's `uses:` + `secrets:` keys. Only flag `secrets: inherit` on a job whose `uses:` owner isn't in the allowlist (and isn't local — see above).
- **`@typescript-eslint/ban-ts-comment` full shape**: `['error', { 'ts-expect-error': true, 'ts-ignore': true, 'ts-nocheck': true, 'ts-check': false }]`. `true` bans outright; `false` on `ts-check` means `@ts-check` (which *enables* checking, not suppresses it) is allowed. `minimumDescriptionLength` is irrelevant when no directive uses `'allow-with-description'`. ESLint flat config fully replaces preset rule options, so this override supersedes `@bfra.me/eslint-config`'s default (which currently allows `ts-expect-error` with description).
- **Path resolution in conventions test**: `const REPO_ROOT = resolve(import.meta.dir, '../../..')`. Same pattern as existing tests. Avoids the `bun test` (CWD=package) vs `bun test --recursive` (CWD=repo) divergence.
- **`Bun.Glob` must use `{ dot: true }` for `.github/` scans**. `Bun.Glob` skips dot-prefixed directories by default. Without `dot: true`, globs like `.github/workflows/*.yaml` return zero files and R5/R6/R7/R8 silently pass. Every Glob call that targets or traverses `.github/` must pass `{ dot: true }`. Add a tripwire assertion at the start of the workflow-globbing tests asserting the matched file count is >= 1, so a future refactor that drops `dot: true` fails loudly instead of silently.
- **Conventions test is Bun-native** (`Bun.Glob`, `Bun.file`) plus `yaml` as pure JS. No Node pin needed on the `test` CI job; the existing `bun test --recursive` invocation is sufficient.

## Open Questions

### Resolved During Planning

- YAML parser choice → `yaml` package as direct devDep in `packages/cli/package.json`.
- `ban-ts-comment` option shape → resolved above.
- Cross-org allowlist for R5 → `['marcusrbrown']`.
- R7 regex form → resolved above (supports both version formats the repo actually uses).
- Rule 7 AST vs regex → regex (single-line `uses:` syntax is universal in our workflows).

### Deferred to Implementation

- Exact helper function signatures in `conventions.test.ts` (e.g., whether to extract per-rule predicates or inline assertions) — let the implementation choose what reads best.
- Fro Bot category 3 prompt diff — the exact lines to remove depend on reading the current `SCHEDULE_PROMPT` text alongside the new rule set; let implementation produce the narrowest possible trim.

## Implementation Units

- [ ] **Unit 1: ESLint config tightening for R1-R2**

**Goal:** Flip `@typescript-eslint/no-explicit-any` from off → error and override `ban-ts-comment` to ban all three directives without description carveouts.

**Requirements:** R1, R2

**Dependencies:** None

**Files:**
- Modify: `eslint.config.ts`

**Approach:**
- Add a new named block to the `defineConfig(...)` call (e.g., `name: 'infra-conventions'`) with `rules:` containing the two overrides. Place it after the existing `bun-globals` block so it applies broadly across all TS files; the `files:` key stays unset to apply globally.
- Keep the existing `cli-and-scripts` block untouched (it disables `no-console` for scripts, orthogonal concern).

**Patterns to follow:**
- Existing named blocks in `eslint.config.ts:9-21` (structure: `name`, optional `files`, `rules`).

**Test scenarios:**
- Happy path: `bun run lint` exits 0 on clean main (audit confirmed zero violations today).

**Verification:**
- `bun run lint` stays green.
- `bunx eslint --print-config packages/cli/src/cli.ts | jq '.rules["@typescript-eslint/no-explicit-any"]'` returns `[2]` (error severity, no options).
- `bunx eslint --print-config packages/cli/src/cli.ts | jq '.rules["@typescript-eslint/ban-ts-comment"]'` returns `[2, { "ts-expect-error": true, "ts-ignore": true, "ts-nocheck": true, "ts-check": false }]`.

- [ ] **Unit 2: Conventions test for R3-R9**

**Goal:** A single Bun test file that enforces R3-R9 by reading real repo files. Fails CI on any violation. All checks green on `main` at ship time.

**Requirements:** R3, R4, R5, R6, R7, R8, R9

**Dependencies:** Unit 1 can merge in the same PR but is not a hard prerequisite for this unit.

**Files:**
- Create: `packages/cli/src/conventions.test.ts`
- Modify: `packages/cli/package.json` (add `yaml` to `devDependencies`)
- Modify: `bun.lock` (regenerated by `bun install` after the dep add)

**Approach:**
- File layout: `describe('repo conventions', () => { ... })` wrapping nine `it(...)` blocks, one per rule. Each `it` is independent; failures surface per-rule with rule-specific error messages that include the offending file paths.
- Constants at the top: `REPO_ROOT = resolve(import.meta.dir, '../../..')`, `INTERNAL_ORGS = new Set(['marcusrbrown'])`, `ALLOWED_SHELL_SCRIPTS = new Set(['apps/keeweb/deploy.sh'])`.
- Use Bun's built-in `Glob` (`new Bun.Glob(pattern).scan({cwd, absolute, dot})`) for file discovery. Avoid `process.cwd()`. **Every `.github/`-targeting glob must pass `{ dot: true }`** — Bun.Glob skips dot-prefixed directories otherwise and the rule silently passes on an empty file set.
- **Workflow file tripwire**: at the start of the workflow-globbing rules, compute `const workflowFiles = [...].scanSync({ cwd: REPO_ROOT, absolute: true, dot: true })` once and `expect(workflowFiles.length).toBeGreaterThan(0)`. If a future refactor drops `dot: true`, R5/R6/R7/R8 all fail together with a clear message instead of silently passing.
- R3: glob `**/package.json` (Bun.Glob auto-excludes `node_modules/**`, no `{ dot: true }` needed — no package.json files live under dot-dirs), `JSON.parse`, assert no `bundledDependencies` key.
- R4: `Bun.file(REPO_ROOT/'apps/keeweb/config/config.json').json()`, assert `.settings.dropboxSecret === ''`.
- R5: glob `.github/workflows/*.yaml` with `{ dot: true }`, parse each via `yaml.parse(content, { merge: true })`. Walk `parsed.jobs[*]` — for each job that has a `uses:` value: (a) if `uses` starts with `./` or `../`, skip (local reusable workflow); (b) otherwise extract owner via `uses.split('/')[0]`, and if the owner is not in `INTERNAL_ORGS`, fail if `job.secrets === 'inherit'`. Accumulate violations into a list and `expect(violations).toEqual([])`.
- R6: glob `.github/workflows/*.yaml` with `{ dot: true }`, read each as text, `expect(text).not.toMatch(/\bssh-keyscan\b/)`. Report offending file + line if match.
- R7: glob `.github/workflows/*.yaml` with `{ dot: true }`, regex each line matching `^\s+-?\s*uses:\s+(\S+)@([a-f0-9]{7,})(?:\s+(.*))?$`. If capture group 3 is `undefined` (no trailing content), record violation as `"missing version comment"`. If capture group 3 is defined but doesn't match `/^#\s+(v\d+(?:\.\d+){0,2}|[\w@/-]+@\d+(?:\.\d+){0,2})\s*$/`, record as `"malformed version comment: <captured>"`. The two cases share the same assertion but produce different error messages for diagnostics.
- R8: glob `.github/workflows/*.yml` with `{ dot: true }`, assert returned array is empty. Note: scope is *inside* `.github/workflows/` — `.github/settings.yml` is deliberately exempt.
- R9: glob `**/*.sh` (Bun.Glob auto-excludes `node_modules/**`; additionally filter out `.cache/**`, `dist/**` explicitly), filter by `ALLOWED_SHELL_SCRIPTS`, assert unmatched list is empty.
- Error messages: each `expect(...)` includes a message argument or uses `expect(list).toEqual([])` so the failure output names the offending files. If Bun's built-in assertion output isn't informative enough, build a `list.map(v => \`${file}:${line}: ${reason}\`).join('\n')` string and assert on that.

**Technical design:** *(directional — illustrates the per-rule structure, not implementation)*

```ts
describe('repo conventions', () => {
  it('R3: no bundledDependencies in any package.json', async () => {
    const packageJsons = [...new Bun.Glob('**/package.json').scanSync({ cwd: REPO_ROOT, absolute: true })]
      .filter(p => !p.includes('/node_modules/'))
    const offenders: string[] = []
    for (const file of packageJsons) {
      const json = await Bun.file(file).json()
      if ('bundledDependencies' in json) offenders.push(relative(REPO_ROOT, file))
    }
    expect(offenders).toEqual([])
  })
  // ...one `it` per rule
})
```

**Patterns to follow:**
- Path resolution: `packages/cli/src/cli.test.ts:8`.
- File reading: `packages/cli/src/commands/keeweb/build.test.ts` (uses `Bun.file(...).text()` / `.json()`).
- Test structure (describe + named `it` blocks): any existing test in `packages/cli/src/commands/`.

**Test scenarios:**
- Happy path, R3: real repo's `package.json` tree returns empty offender list. Audit confirmed 0 violations.
- Happy path, R4: `dropboxSecret` is `""` in real file.
- Happy path, R5: real workflows parse cleanly, cross-org check returns empty violation list.
- Happy path, R6: no workflow contains `ssh-keyscan`.
- Happy path, R7: all 37 `uses:` lines match the version-comment regex.
- Happy path, R8: no `.yml` files under `.github/workflows/`.
- Happy path, R9: only `apps/keeweb/deploy.sh` matches the `.sh` glob.
- Edge case, R5: confirm the cross-org walker ignores `secrets: inherit` occurring inside prompt heredoc prose in `fro-bot.yaml` (3 known occurrences). If the walker flags them, the YAML parse or the jobs-only scoping is wrong.
- Error path, R5: construct an inline synthetic workflow YAML string with a cross-org `uses:` + `secrets: inherit` job, pass through the detector function, assert exactly one violation is reported with the correct file/job identification. This is the only non-optional negative test — it's both a regression guard for the walker's core logic and our assurance that the `fro-bot.yaml` 3-prose-match ignoring isn't just luck.
- Edge case, R5 local: inline YAML with `uses: ./.github/workflows/local.yaml` + `secrets: inherit`, assert no violation (local reusable workflows are same-repo and may inherit).
- Edge case, R9: confirm the filter correctly allows the single permitted `.sh` path without false positives on files under excluded directories.

**Verification:**
- `bun test --recursive` passes with the new file in place.
- `bun test packages/cli/src/conventions.test.ts` also passes (tests are independent of CWD).
- Manual validation before merge: temporarily introduce one violation per rule (e.g., add `"bundledDependencies": ["x"]` to a `package.json`; rename one workflow file to `.yml`; remove a version comment from a `uses:` line) and confirm the corresponding test fails with a useful error message. Revert all changes before committing.

- [ ] **Unit 3: Annotate root AGENTS.md**

**Goal:** Append `(enforced)` to each of the 9 rules in root `AGENTS.md` that are now mechanically gated, and narrow the `ssh-keyscan` anti-pattern prose to match the CI-workflow-only scope from R6.

**Requirements:** R10 (covering R1-R9 annotation), R11

**Dependencies:** Soft: Units 1-2 must ship in the same PR so R10's markers remain truthful claims about work that has actually merged. Ordering within the PR: land after Units 1-2.

**Files:**
- Modify: `AGENTS.md`

**Approach:**
- For each of R1-R9, locate the corresponding bullet in root `AGENTS.md` (rules live under `## Conventions` and `## Anti-Patterns (THIS PROJECT)`). Append ` (enforced)` to the end of the bullet text. Nothing else changes.
- Narrow the `ssh-keyscan` bullet: replace `**Never use `ssh-keyscan`** — host keys pinned in `.github/known_hosts`.` with `**Never use `ssh-keyscan` in CI workflows** — host keys are pinned in `.github/known_hosts`. Provisioning scripts may use `ssh-keyscan` locally; `apps/cliproxy/server/provision-droplet.ts` is the current example. (enforced)`.
- No other `AGENTS.md` changes. Unenforced rules stay unannotated — this is the whole signal.

**Patterns to follow:**
- `AGENTS.md` bullet style (no terminating period on short items is inconsistent today; preserve the existing bullet's punctuation when appending).

**Test scenarios:**
- Test expectation: none — pure documentation edit, no behavior change.

**Verification:**
- `rg --hidden -F '(enforced)' AGENTS.md` returns exactly 8 matches. Mapping: R9, R7+R8 (one shared bullet), R5 convention side, R1+R2 (one shared bullet), R4, R6 (narrowed bullet), R5 anti-pattern side, R3. Every rule in R1-R9 is covered by at least one marker; R5 has two (stated in both Conventions and Anti-Patterns sections).
- Visual diff review: the only changes are trailing `(enforced)` appends on the expected bullets and the ssh-keyscan prose narrowing.
- Re-read root `AGENTS.md` end-to-end after edit to confirm the prose still reads naturally with markers appended.

- [ ] **Unit 4: Trim Fro Bot autoheal category 3**

**Goal:** Remove the specific convention-check bullets from `SCHEDULE_PROMPT` category 3 in `.github/workflows/fro-bot.yaml` that are now mechanically gated by Units 1-2, so the daily autoheal run doesn't double-report violations the pre-merge gate already prevented.

**Requirements:** R12

**Dependencies:** None (ordering-only — land with Units 1-2 so the removed bullets are always backed by mechanical enforcement).

**Files:**
- Modify: `.github/workflows/fro-bot.yaml`

**Approach:**
- Locate the `SCHEDULE_PROMPT` env block. Category 3 ("CODE QUALITY & REPO HYGIENE") contains a "Verify convention compliance" bullet list. Drop the sub-bullets whose rules are now enforced by Units 1-2: no `as any` / `@ts-ignore` / `@ts-expect-error` in source (R1+R2), `.yaml` extension (R8), SHA-pin version comments (R7), no `secrets: inherit` cross-org (R5), only `deploy.sh` is bash (R9), `config/config.json` template has empty `dropboxSecret` (R4). Keep AGENTS.md-accuracy drift (judgment-based), build/type-check/stale-TODO scans, and any convention bullet not in R1-R9.
- Also drop R3 (no `bundledDependencies`) and R6 (no `ssh-keyscan`) sub-bullets if category 3 references them explicitly — scan the prompt text and drop whichever sub-bullets match our v1 rule set.
- Use minimal phrasing changes elsewhere. Category 3's section header, intro, build/type-check/TODO scans, and AGENTS.md-accuracy check stay.

**Patterns to follow:**
- Existing multi-line YAML block style in `fro-bot.yaml` `SCHEDULE_PROMPT`. Keep leading-space indentation consistent.

**Test scenarios:**
- Test expectation: none — workflow prompt edit, not executable code under test.

**Verification:**
- YAML parses cleanly (`docker run --rm -i mikefarah/yq '.' < .github/workflows/fro-bot.yaml > /dev/null` — or just open locally; a syntax break would be a lint-time fail).
- Visual diff: bullets removed are exactly the ones R1-R9 cover. Surrounding prompt structure intact.
- Post-merge, verify the next daily autoheal report (`gh issue list --search "Daily Autohealing Report" --limit 1`) doesn't flag any of the now-gated rules as convention drift.

## System-Wide Impact

- **Interaction graph**: `bun test --recursive` now runs one additional test file; `bun run lint` now fails on previously-warn-only patterns; `AGENTS.md` consumed by agents (they parse the new markers, but the value isn't marker-driven); `fro-bot.yaml` consumed daily by the autoheal workflow (reduced scope of category 3 work).
- **Error propagation**: R1-R2 surface via ESLint CI failure at the `lint` job; R3-R9 surface via `bun test --recursive` at the `test` job (already parallel). Both gate the existing `ci.yaml` check on PRs.
- **State lifecycle risks**: None — all checks are read-only against repo state.
- **API surface parity**: No API changes. Published CLI behavior unchanged. `@marcusrbrown/infra` package shape unchanged — `files: ["src/"]` in `packages/cli/package.json` is unmodified. The new `conventions.test.ts` ships in the npm tarball alongside existing `*.test.ts` files (which already publish today); it is not runnable from an installed package because paths resolve to the monorepo root, matching the status quo for every existing test file.
- **Integration coverage**: The conventions test *is* the integration layer. Unit-level checks on individual predicate functions (if extracted) would add nothing — the repo state the test asserts against is the integration fixture.
- **Unchanged invariants**: All 148+ existing tests continue passing. All existing ESLint rules stay active (we're only raising severity on two rules, not disabling anything). Deploy pipeline, CLI commands, Fro Bot's PR-review path, and Renovate workflows are untouched. Category 3 autoheal prompt loses duplicate checks but keeps AGENTS.md-accuracy and build/type/TODO sweeps — the prompt's structural role is preserved.

## Risks & Dependencies

| Risk | Mitigation |
| --- | --- |
| `yaml` package adds a new direct devDep to `packages/cli/` | Small (~50KB), actively maintained, zero runtime cost (test-only). Transitively already installed; this adds one line to `packages/cli/package.json` and regenerates `bun.lock`. |
| ESLint rule changes surface latent `any` or `@ts-ignore` not caught by the grep audit | Audit swept for both explicit forms; zero findings. If one slips through (unlikely) the PR's CI fails before merge, and fix-first policy resolves it in the same PR. |
| R5 YAML walker has a bug and passes silently on a crafted cross-org `secrets: inherit` | Add a small synthetic-YAML unit test as part of Unit 2's implementation (inline YAML string, assert walker flags the violation). Doubles as a regression guard. Brainstorm's audit evidence (3 prose matches in `fro-bot.yaml`) gives us a known-safe case to anti-test the walker against. |
| R7 regex misses an unusual `uses:` form (e.g., multi-line YAML block scalar on `uses:` value) | Current 37 `uses:` lines across 9 workflows are all single-line. If multi-line forms show up later, the regex returns them as violations and the failure mode is loud (caught at PR time, not silent). Noted for potential AST upgrade in a follow-up. |
| Fro Bot category 3 trim removes a bullet that was covering a subtle case the mechanical rule misses | Possible in theory; in practice, category 3 already only lists the same convention patterns our v1 rules cover. The few category-3 items outside R1-R9 (AGENTS.md accuracy, build pass, stale TODOs) stay. Post-merge monitor the first autoheal run after the PR lands. |
| `bun install` after adding `yaml` dep changes `bun.lock` unrelated-ly | Use `bun install --frozen-lockfile` verification in CI (already in use). Review `bun.lock` diff before commit. |

## Documentation / Operational Notes

No runbook, rollout, monitoring, or README updates needed — `AGENTS.md` annotation is the full documentation delta; test failures are the monitoring.

## Sources & References

- **Origin document**: `docs/brainstorms/2026-04-16-executable-conventions-tests-requirements.md`
- Related code: `eslint.config.ts`, `packages/cli/src/cli.test.ts`, `packages/cli/package.json`, `AGENTS.md`, `.github/workflows/fro-bot.yaml`
- Related PRs: none directly; the rules mechanize conventions documented across the project's 150+ merged PRs
- External docs: [`yaml` package](https://eemeli.org/yaml/), [`@typescript-eslint/ban-ts-comment` options](https://typescript-eslint.io/rules/ban-ts-comment/)
- Audit evidence: origin doc's "Audit Result" section (zero violations across all 9 rules on `main` as of 2026-04-16)
