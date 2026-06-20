---
title: bun build publish step to remove the packages/cli → packages/shared boundary
date: 2026-06-20
status: draft
owner: marcusrbrown
related:
  - packages/cli/package.json
  - packages/cli/src/cli.ts
  - packages/cli/src/lib/known-hosts.ts
  - packages/cli/src/lib/ssh-identity.ts
  - packages/shared/server/droplet-helpers.ts
---

# bun build publish step to remove the packages/cli → packages/shared boundary

## Problem

The published `@marcusrbrown/infra` package (`packages/cli`) ships **raw TypeScript** and is run directly under Bun (`bin: src/cli.ts`, `files: ["src/"]`, no build step). Because of this, `packages/cli` cannot import the private workspace package `@marcusrbrown/infra-shared` (`workspace:*`): doing so breaks external `npm install`/`bunx`, because a `workspace:*` dependency cannot resolve outside the monorepo. This was proven by the published 0.10.0 regression, and `packages/cli/src/lib/ssh-identity.ts` exists today as a deliberate duplicate of a `packages/shared` helper solely to avoid the dependency.

The result is forced duplication of any logic shared between the published CLI and `packages/shared`, and it blocks DRY designs (e.g. the upcoming cliproxy model-aliasing feature wants a shared management helper).

## Goal

Add a `bun build` publish step so the published package ships a bundled `dist/` artifact that **inlines** `infra-shared` while keeping the real npm dependencies external. This permanently removes the `packages/cli ↛ packages/shared` boundary and enables DRY code reuse repo-wide. The driver is durable infrastructure, not a single feature.

## Decisions

- **Bundler:** Bun's built-in `bun build` (no tsup/esbuild). `target: bun` (preserves Bun APIs and `import.meta.main`), `format: esm`, output to `dist/`. **Pin the Bun version** used for build/publish (build is otherwise sensitive to Bun bundler-semantics drift across versions — entrypoint resolution, banner/shebang, multi-entry layout) and exercise the packed artifact under that exact version in CI.
- **Dependency treatment:** the 5 public deps (`goke`, `@clack/prompts`, `@goke/mcp`, `string-dedent`, `zod`) stay **external** (remain in `dependencies`, resolved from `node_modules` at runtime). `@marcusrbrown/infra-shared` is **inlined** into the bundle. Inlining is **not** automatic from a bare package specifier — the build must resolve `infra-shared` as workspace **source** so Bun bundles it (use explicit `--external` per public dep, not `--packages=external` which is too blunt and would externalize `infra-shared` too). The build must **assert** the result: `dist/` contains no `@marcusrbrown/infra-shared` import and the 5 public deps remain external imports.
- **Entrypoints:** two — `src/cli.ts` (the `bin`) and `src/commands/vpn/peers.ts` (the `./vpn/peers` subpath export). MCP needs no separate entry (it is a subcommand registered in `cli.ts`).
- **Asset & path handling (highest-risk).** The full audit found `import.meta.dir`-relative reads split into two categories that bundling breaks differently. Research (official Bun + Node docs) established that tsconfig `paths` / package `imports` are **import-specifier resolution only** and cannot fix runtime filesystem reads — so the fix is Bun's file-asset loader for the packaged asset, and runtime repo-root discovery for source-only paths.
  - **Category A — packaged asset (`known_hosts`), ships in the tarball, must resolve in a clean install.** Use Bun's file-asset import idiom — `import knownHostsPath from './resources/known_hosts' with {type: 'file'}` — so `bun build` copies the asset to `dist/` and rewrites the path automatically. This **eliminates** the manual copy step and the `import.meta.dir` arithmetic for the asset. `resolveKnownHostsPath` keeps Layout 1 (repo `.github/known_hosts`) for source runs and uses the file-asset path for the installed package.
    - **Fail-closed must hold (security crux):** resolution must **throw** when the pinned asset is missing and must **never** fall back to `~/.ssh/known_hosts` or omit `UserKnownHostsFile`. A regression here silently disables host-key pinning. A negative test must prove the throw.
    - **Drift guard is byte-equality, fail-on-mismatch:** the test pipeline compares the shipped packaged `known_hosts` bytes against `.github/known_hosts` and fails on mismatch (the shipped pin cannot drift or be tampered).
  - **Category B — source-only monorepo-reaching paths** (`apps/vpn/config/peers.json`, `apps/vpn/clients`, `apps/keeweb/deploy.sh`, `apps/keeweb/dist/index.html`, `apps/cliproxy/src/deploy.ts`, the keeweb status source marker). These are monorepo-operator-only commands; the files **do not exist** in a published install (no aliasing helps). Replace the brittle hardcoded `resolve(import.meta.dir, '../../../../', ...)` depth-counting with **one runtime repo-root-discovery helper** (walk up to a marker such as the workspace root) — depth-independent, so it survives the bundle and any future layout change. These commands remain source-checkout-only by design.
  - **Full audit is the basis:** the plan enumerates every `import.meta.dir`/relative-read site (the audit found ~7 across known-hosts, vpn/client, keeweb/status, keeweb/deploy, cliproxy/deploy) and routes each to Category A or B.
- **Proof the boundary is gone:** de-dup `ssh-identity.ts` as the single real consumer — replace its duplicated materializer body with an import of the shared `materializeIdentityFile` from `infra-shared` (inlined by the build), keeping its public surface stable.
- **Publish wiring:** `bin → dist/cli.js`, `exports["./vpn/peers"] → dist/...peers.js`, `files: ["dist"]`, build runs at `prepack`/`prepublishOnly` (so `changeset publish` → `npm publish` builds automatically). `infra-shared` is **not** added to runtime `dependencies`.
- **Source stays runnable in-repo:** `bun run src/cli.ts` and `apps/*` source execution are unaffected (repo-checkout layout preserved). The build only changes the published artifact.

## Constraints

- **Published install must stay self-contained.** No `workspace:*` in the published `dependencies`; a clean external install must not reference `infra-shared`.
- **Clean-room verification is mandatory and must exercise a real `status` path** (which triggers `resolveKnownHostsPath`), not just `infra --help` — that is the only way to catch the asset/path hazard. Pattern: `bun pm pack` → install the tarball in a temp dir with no monorepo → run the binary.
- **Verify the bundle on every merge, not just the first release.** Because CI and contributors run raw `src/` while releases ship `dist/`, the bundle is a distinct code path that source runs never exercise — a "works locally, broken when published" drift class. A CI job must build → `bun pm pack` → clean-room install → run the real status path, gating merges. (The first post-landing release is a final confirmation, not the primary gate.)
- **Rollback path defined:** if a bundled release ships broken, the recovery is to publish a fixed patch release (forward-fix), not unpublish; the raw-`src/` model is the conceptual fallback only if the build approach is abandoned. State this so a release break has a known response.
- **No CLI behavior change.** Commands, flags, output, and the `./vpn/peers` export contract are preserved (`apps/vpn` imports `@marcusrbrown/infra/vpn/peers`).
- **`infra-shared` stays private** — inlined, never published to npm.
- **No `as any`/suppressions;** update the affected `known-hosts` + drift-guard tests for the new layout.
- **`dist/` is build output** — gitignored, not committed.

## Success criteria

1. `bun run --cwd packages/cli build` produces `dist/cli.js` (with `#!/usr/bin/env bun` shebang, executable), the `./vpn/peers` export output, and `dist/resources/known_hosts`.
2. The bundle inlines `infra-shared` (no `@marcusrbrown/infra-shared` import in `dist/`) and keeps the 5 public deps external.
3. A clean-room install of the packed tarball runs `infra --help` (exit 0) **and** a real `status` command path reaches `known_hosts` resolution without ENOENT.
4. The packed tarball contains `dist/` (incl. the resource) and no `src/`, no `workspace:` specifier, no `infra-shared` reference.
5. `ssh-identity.ts` imports the shared materializer; its behavior/tests are unchanged.
6. `apps/vpn` still resolves `@marcusrbrown/infra/vpn/peers` (exact bundled export path confirmed to exist); its tests pass.
7. The package-version display still works from the bundle (the `import ../package.json with {type:'json'}` version is correctly inlined).
8. A CI job builds + packs + clean-room-installs + runs a real status path on every merge.
9. The first release after this lands verifies clean-room post-publish (`bunx @marcusrbrown/infra@<new>`).

## Out of scope

- Broader extraction of shared logic into `packages/shared` (incremental, later).
- The cliproxy model-aliasing feature's shared management helpers — `docs/plans/2026-06-20-001-feat-cliproxy-model-aliasing-plan.md` (depends on this).
- Publishing `infra-shared` to npm.
- Any change to how `apps/*` deploy/provision scripts run.

## Risks

- **Bundled layout breaks `known_hosts` resolution** → status commands fail-closed on a clean install (the subtle 0.10.0-class break). Mitigation: bundled-layout branch + clean-room test that exercises a real status path.
- **`bun build` inlines/externalizes the wrong dep.** Mitigation: assert `infra-shared` absent from `dist/` imports and the 5 public deps present as external imports.
- **Shebang/executable bit lost** → `bunx` fails. Mitigation: `--banner` + chmod; run the binary from the packed tarball in verification.
- **`prepack` doesn't run under `changeset publish`.** Mitigation: it does (publish delegates to `npm publish`); `bun pm pack` in verification also runs prepack.
- **`./vpn/peers` export path moves** and breaks `apps/vpn`. Mitigation: keep the export path stable; run `apps/vpn` tests.

## Notes

- @librarian (official Bun docs) confirmed: multi-entry `bun build`, explicit `--external` per dep (not `--packages=external`), `target: bun` preserves Bun APIs + `import.meta.main` + marks output `// @bun`, `--banner` for shebang, JSON imports inlined, `prepack`/`prepublishOnly` run on `npm publish`.
- Sequencing: this is Plan A (land + release-verify first). The cliproxy aliasing plan (Plan B) will be revised to depend on it (shared management helpers in `packages/shared` used by both deploy and the CLI).
