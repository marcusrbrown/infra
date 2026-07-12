---
title: "refactor: bun build publish step for @marcusrbrown/infra (remove packages/cli → packages/shared boundary)"
type: refactor
status: completed
date: 2026-06-20
origin: docs/brainstorms/2026-06-20-cli-bun-build-publish-requirements.md
---

# refactor: bun build publish step for @marcusrbrown/infra

## Overview

`packages/cli` (published as `@marcusrbrown/infra`) ships **raw TypeScript** run directly under Bun (`bin: src/cli.ts`, `files: ["src/"]`, no build step). That forbids importing the private workspace package `@marcusrbrown/infra-shared` (`workspace:*` can't resolve outside the monorepo — the published 0.10.0 regression; `src/lib/ssh-identity.ts` is a deliberate duplicate to avoid it).

Add a `bun build` publish step that emits a bundled `dist/` artifact: the 5 public deps stay **external**, `infra-shared` is **inlined**. This removes the `packages/cli ↛ packages/shared` boundary for good (driver: DRY repo-wide), proven by de-duping `ssh-identity.ts`. (see origin: docs/brainstorms/2026-06-20-cli-bun-build-publish-requirements.md)

## Problem Frame

The published CLI must stay self-contained (no `workspace:*` runtime dep). Today that forces duplication of anything shared with `packages/shared`. A bundle that inlines `infra-shared` at publish removes the constraint without making `infra-shared` public. Research (Bun + Node docs) established the key facts: explicit `--external` per public dep (not `--packages=external`); `target: bun` preserves Bun APIs + `import.meta.main`; tsconfig `paths`/package `imports` are import-specifier-only and **cannot** fix runtime filesystem reads; Bun's `with {type:'file'}` asset loader is the idiom for a packaged data file that survives bundling.

## Requirements Trace

- R1. `bun run --cwd packages/cli build` produces `dist/` with the bundled CLI entry and the `./vpn/peers` export, TS transpiled to JS, shebang + executable on the bin.
- R2. The 5 public deps (`goke`, `@clack/prompts`, `@goke/mcp`, `string-dedent`, `zod`) stay external (in `dependencies`); `infra-shared` is inlined (no `infra-shared` import in `dist/`, no `workspace:` in published `dependencies`).
- R3. A clean-room install (packed tarball, no monorepo) runs `infra --help` (exit 0) **and** a real `status` path that triggers `known_hosts` resolution without ENOENT.
- R4. The packaged `known_hosts` ships and resolves in the installed package via Bun's file-asset path; fail-closed (throws if missing, never falls back to system known_hosts); byte-equal to `.github/known_hosts` (drift guard).
- R5. Every `import.meta.dir`/relative-read site is audited and routed: Category A (packaged asset) via file-asset loader; Category B (source-only monorepo paths) via one runtime repo-root-discovery helper — depth-independent, source-checkout-only by design.
- R6. The build runs at `prepack` so `changeset publish` → `npm publish` ships the built artifact; a CI job builds+packs+clean-room-tests on every merge.
- R7. `import.meta.main` (entry guard) and the package-version display (`import ../package.json with {type:'json'}`) still work from the bundle.
- R8. `apps/vpn` still resolves `@marcusrbrown/infra/vpn/peers`; its tests pass.

## Scope Boundaries

- No CLI behavior/flag/output change.
- `infra-shared` stays private (inlined, never published).
- The only shared-logic move is `ssh-identity.ts` (the proof); broader extraction is later.
- No change to how `apps/*` deploy/provision scripts run (source execution unaffected).
- The Bun version used for build/publish is pinned (avoid bundler-semantics drift).

### Deferred to Separate Tasks

- cliproxy model aliasing using shared management helpers: `docs/plans/2026-06-20-001-feat-cliproxy-model-aliasing-plan.md` (Plan B — depends on this).
- Broader `packages/shared` extraction of other duplicated logic: incremental, after this lands.

## Context & Research

### Relevant Code and Patterns

- `packages/cli/package.json` — `bin: src/cli.ts`, `exports["./vpn/peers"]: src/commands/vpn/peers.ts`, `files: ["src/"]`, deps: goke/@clack/prompts/@goke/mcp/string-dedent/zod. No build/prepack.
- `packages/cli/src/cli.ts` — bin entry; `import pkg from '../package.json' with {type:'json'}`; `registerMcp` (subcommand, no separate entry); `import.meta.main` guard.
- `packages/cli/src/lib/known-hosts.ts` — `resolveKnownHostsPath`: Layout 1 repo `.github/known_hosts` (walk up 4 from `src/lib`), Layout 2 installed `../resources/known_hosts`; fail-closed throw.
- `packages/cli/src/resources/known_hosts` — Category A packaged asset.
- `packages/cli/src/lib/ssh-identity.ts` — deliberate duplicate of `packages/shared` `materializeIdentityFile`; de-dup target.
- **Category B sites (audit result):** `commands/vpn/client.ts` (`apps/vpn/config/peers.json`, `apps/vpn/clients`), `commands/keeweb/deploy.ts` (`apps/keeweb/deploy.sh`, `apps/keeweb/dist/index.html`), `commands/keeweb/status.ts` (source marker), `commands/cliproxy/deploy.ts` (`apps/cliproxy/src/deploy.ts`).
- `apps/keeweb/src/build.ts` — Bun build-script style reference (logging, `Bun.build`/`Bun.write`, error handling).
- `.github/workflows/ci.yaml` — where the new build+pack+clean-room job goes. `.github/workflows/release.yaml` — `bunx changeset publish`.

### Institutional Learnings

- 0.10.0 regression: `workspace:*` infra-shared dep broke external install → clean-room verification mandatory, must exercise a real status path (not just `--help`).
- `apps/vpn` Changesets coupling: keep `infra-shared` un-versioned/ignored; don't add it to runtime `dependencies`.

### External References

- Bun bundler: multi-entry `entrypoints`/`outdir`, `target: bun`, `format: esm`, explicit `--external <pkg>`, `--banner` for shebang, `with {type:'file'}` file-asset loader (copies asset to outdir + rewrites path), JSON imports inlined, `prepack`/`prepublishOnly` run on `npm publish`.
- tsconfig `paths` / package `imports` are import-specifier resolution only — do **not** use for runtime file reads.

## Key Technical Decisions

- **`bun build`, `target: bun`, `format: esm`, two entrypoints** (`src/cli.ts`, `src/commands/vpn/peers.ts`); MCP is a subcommand (no entry). Pin the Bun version for build/publish.
- **Explicit `--external` for the 5 public deps; inline `infra-shared`** (resolved as workspace source). Assert in tests: no `infra-shared` import in `dist/`, 5 deps external.
- **Category A asset via `with {type:'file'}`** — `import knownHostsPath from './resources/known_hosts' with {type:'file'}`; Bun copies + rewrites. Removes manual copy + `import.meta.dir` arithmetic for the asset. `resolveKnownHostsPath` keeps Layout 1 for source, uses the file-asset path for installed; stays fail-closed.
- **Category B via one repo-root-discovery helper** — walk up from a stable anchor to a marker (workspace root) instead of hardcoded `../../../` depth. Depth-independent; survives bundle + future layout change. These commands remain source-checkout-only.
- **Drift guard = byte-equality, fail-on-mismatch** between `.github/known_hosts` and the shipped packaged copy.
- **Publish wiring:** `bin → dist/cli.js`, `exports["./vpn/peers"] → dist/.../peers.js`, `files: ["dist"]`, `prepack = bun run build`; `infra-shared` in `devDependencies` only (build-time inline), never runtime `dependencies`. `dist/` gitignored.
- **CI verifies the bundle every merge** (build+pack+clean-room+real-status-path) — the bundle is a code path source runs never exercise.
- **Rollback = forward-fix patch release** (not unpublish); raw-`src/` is the conceptual fallback only if the approach is abandoned.

## Open Questions

### Resolved During Planning

- Bundler: `bun build`. Dep treatment: explicit external + inline shared. Asset: `with {type:'file'}`. Path mapping: rejected (import-specifier only). Category B: repo-root discovery. Build trigger: prepack + CI-every-merge.

### Deferred to Implementation

- Exact build invocation: a small `packages/cli/scripts/build.ts` using `Bun.build` (cleaner for asserts/shebang) vs a `bun build` package script — implementer's call.
- The repo-root marker (`package.json` with the workspace name, or a sentinel) and the helper's home (`packages/cli/src/lib/repo-root.ts`).
- Whether `with {type:'file'}` needs a companion runtime check, or fully replaces `resolveKnownHostsPath`'s Layout 2.
- Final `dist/` nesting for the `peers` export (preserve `commands/vpn/` vs flat) — pick what keeps the `exports` path stable for `apps/vpn`.

## Implementation Units

- [ ] **Unit 1: Repo-root discovery helper for Category B paths**

**Goal:** Replace brittle `import.meta.dir` depth-counting in source-only commands with one depth-independent repo-root resolver.

**Requirements:** R5

**Dependencies:** None

**Files:**
- Create: `packages/cli/src/lib/repo-root.ts`
- Create: `packages/cli/src/lib/repo-root.test.ts`
- Modify: `commands/vpn/client.ts`, `commands/keeweb/deploy.ts`, `commands/keeweb/status.ts`, `commands/cliproxy/deploy.ts`

**Approach:**
- `findRepoRoot(start = import.meta.dir): string` — walk up to the workspace-root marker (root `package.json` with `name: @marcusrbrown/infra-workspace`); throw a clear error if not found (these commands are source-checkout-only).
- Rewrite each Category B site to resolve via `findRepoRoot()` + a repo-relative path (e.g. `join(findRepoRoot(), 'apps/vpn/config/peers.json')`), removing the `../../../` chains.

**Patterns to follow:**
- Existing `resolveKnownHostsPath` Layout 1 walk-up + `existsSync` style.

**Test scenarios:**
- Happy path: from a nested source dir, `findRepoRoot` returns the workspace root (marker found).
- Error path: from a dir with no marker ancestor → throws.
- Happy path: each rewritten site resolves the same absolute path it did before (regression: compare against the known repo-relative target).

**Verification:**
- `bun test packages/cli/src/lib/repo-root.test.ts` + the touched command tests pass; `bun test apps/vpn` (peers path) still passes.

- [ ] **Unit 2: Category A asset via Bun file-asset loader + fail-closed resolution**

**Goal:** Ship + resolve `known_hosts` through the bundle via `with {type:'file'}`, keeping source-run + fail-closed behavior.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `packages/cli/src/lib/known-hosts.ts`
- Modify: `packages/cli/src/lib/known-hosts.test.ts`

**Approach:**
- Add `import knownHostsAssetPath from '../resources/known_hosts' with {type: 'file'}`. `resolveKnownHostsPath`: Layout 1 (repo `.github/known_hosts`) for source runs; otherwise use `knownHostsAssetPath` (the file-asset path, which Bun rewrites to the dist-copied asset). Preserve fail-closed throw (never fall back to `~/.ssh/known_hosts`).

**Execution note:** preserve the fail-closed contract; add the negative test first.

**Patterns to follow:**
- Existing two-layout `resolveKnownHostsPath` + fail-closed `FAIL_CLOSED_ERROR`.

**Test scenarios:**
- Happy path: repo layout resolves `.github/known_hosts` (unchanged).
- Happy path: installed/asset layout resolves the file-asset path when the repo file is absent.
- Error path (security): neither available → throws; never returns a system known_hosts path.
- Drift guard: shipped packaged `known_hosts` bytes == `.github/known_hosts` (fail on mismatch).

**Verification:**
- `bun test packages/cli/src/lib/known-hosts.test.ts` passes both layouts + negative + drift.

- [ ] **Unit 3: Build script (entrypoints, externals, asset, shebang) + assertions**

**Goal:** Produce a correct `dist/` bundle: shared inlined, deps external, asset present, bin executable.

**Requirements:** R1, R2, R7

**Dependencies:** Unit 2 (file-asset import must exist for the build to copy it)

**Files:**
- Create: `packages/cli/scripts/build.ts`
- Create: `packages/cli/scripts/build.test.ts` (or assert within an existing test)
- Modify: `packages/cli/package.json` (`scripts.build`)

**Approach:**
- `Bun.build({entrypoints: [src/cli.ts, src/commands/vpn/peers.ts], outdir: dist, target: 'bun', format: 'esm', external: [the 5 deps]})`; ensure the file-asset (`known_hosts`) lands in `dist/`; banner/shebang `#!/usr/bin/env bun` on `dist/cli.js` + chmod +x.

**Patterns to follow:**
- `apps/keeweb/src/build.ts` (Bun build-script logging/error style).

**Test scenarios:**
- Happy path: build produces `dist/cli.js` (shebang, executable), the peers output, and the copied `known_hosts` asset.
- Edge: `dist/cli.js` has no `@marcusrbrown/infra-shared` import; retains external imports for the 5 deps.
- Edge: version still displays (JSON import inlined); `import.meta.main` still gates.

**Verification:**
- `bun run --cwd packages/cli build` succeeds; `bun dist/cli.js --help` prints help; asset present.

- [ ] **Unit 4: Publish wiring (dist/, prepack, gitignore) + de-dup ssh-identity + clean-room verification**

**Goal:** Ship `dist/`, build at publish, prove the boundary is gone via the shared import and a clean-room install.

**Requirements:** R2, R3, R6, R8

**Dependencies:** Unit 1-3

**Files:**
- Modify: `packages/cli/package.json` (`bin`/`exports`/`files`→dist, `prepack`, `infra-shared` in `devDependencies`)
- Modify: `.gitignore` (`packages/cli/dist/`)
- Modify: `packages/cli/src/lib/ssh-identity.ts` (import shared `materializeIdentityFile`; drop the "can't depend" comment)
- Modify: `.github/workflows/ci.yaml` (build+pack+clean-room job)
- Modify: tests touching `ssh-identity` as needed

**Approach:**
- Point publish surface at `dist/`; `prepack = bun run build`.
- Replace `ssh-identity.ts`'s duplicated body with the shared import (inlined by the build), public surface stable.
- CI job: build → `bun pm pack` → install tarball in temp dir → `infra --help` + a real status path that hits `resolveKnownHostsPath`; assert tarball has `dist/` (incl. asset), no `src/`, no `infra-shared`/`workspace:` reference.

**Patterns to follow:**
- 0.10.1 clean-room verification (`bun add <tarball>` in temp dir, run the binary).

**Test scenarios:**
- Integration: clean-room `infra --help` exit 0; status path reaches known_hosts without ENOENT.
- Edge: packed tarball contains no `infra-shared` reference / no `workspace:` specifier; contains `dist/resources/known_hosts`.
- Regression: `ssh-identity` behavior unchanged (its tests pass).

**Verification:**
- Clean-room install + run succeeds; `bun test apps/vpn` passes (peers export); full `bun test` green; `tsc`/lint clean.

## System-Wide Impact

- **Interaction graph:** changes the published artifact + path-resolution internals; in-repo source execution unchanged.
- **Error propagation:** `resolveKnownHostsPath` + `findRepoRoot` stay fail-closed; build fails loudly on missing entry/asset.
- **State lifecycle risks:** none; `dist/` is gitignored build output.
- **API surface parity:** `bin` + `./vpn/peers` export preserved; `apps/vpn` import path verified.
- **Unchanged invariants:** CLI behavior/flags/output; 5 deps external; `infra-shared` private; the `.github/known_hosts` ↔ packaged drift guard; host-key pinning fail-closed.

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Bundle breaks `known_hosts` resolution → status fail-closed on clean install (0.10.0 class) | `with {type:'file'}` (Bun-managed path) + clean-room test exercising a real status path |
| `bun build` inlines/externalizes the wrong dep | Unit 3 asserts `infra-shared` absent + 5 deps external in `dist/` |
| Category B path silently resolves wrong after depth change | Unit 1 repo-root discovery is depth-independent + regression tests compare resolved paths |
| Source/dist drift ("works locally, broken when published") | CI builds+packs+clean-room-tests every merge (not just first release) |
| `apps/vpn` `./vpn/peers` import breaks if export path moves | Keep export path stable; `bun test apps/vpn` in Unit 4 |
| Bun bundler-semantics drift across versions | Pin the Bun version for build/publish; CI exercises the packed artifact under it |
| Shebang/exec bit lost → `bunx` fails | Unit 3 banner + chmod; Unit 4 runs the binary from the packed tarball |

## Documentation / Operational Notes

- Update `packages/cli/README.md` / AGENTS.md if they describe the "ships raw src/" model.
- First release after landing: verify `bunx @marcusrbrown/infra@<new>` clean-room post-publish (release-verify gate).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-06-20-cli-bun-build-publish-requirements.md](docs/brainstorms/2026-06-20-cli-bun-build-publish-requirements.md)
- Related code: `packages/cli/package.json`, `packages/cli/src/cli.ts`, `packages/cli/src/lib/known-hosts.ts`, `packages/cli/src/lib/ssh-identity.ts`, `packages/shared/server/droplet-helpers.ts`, `apps/keeweb/src/build.ts`
- Related plan: `docs/plans/2026-06-20-001-feat-cliproxy-model-aliasing-plan.md` (Plan B — depends on this)
- Prior regression: published 0.10.0 broke external install via `workspace:*` infra-shared dep (clean-room verification mandatory)
