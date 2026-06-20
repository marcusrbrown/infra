---
title: Bundling the published CLI with bun build to reuse private workspace code
date: 2026-06-20
category: best-practices
module: packages/cli
problem_type: architecture_pattern
component: tooling
severity: high
applies_when:
  - "Adding a build/bundle step to a published package that runs raw TypeScript today"
  - "A published package needs to reuse a private workspace package without breaking external installs"
  - "Bundling a CLI that reads packaged assets or reaches monorepo-relative paths at runtime"
tags: [bun-build, packaging, monorepo, workspace, dist, known-hosts, exports]
---

# Bundling the published CLI with bun build to reuse private workspace code

## Context

`packages/cli` (`@marcusrbrown/infra`) shipped **raw TypeScript** run directly under Bun (`bin: src/cli.ts`, `files: ["src/"]`, no build step). That made it impossible to import the private workspace package `@marcusrbrown/infra-shared`: a `workspace:*` runtime dependency cannot resolve outside the monorepo, which broke external `npm install`/`bunx` (the published 0.10.0 regression — `src/lib/ssh-identity.ts` existed only as a hand-maintained copy of a shared helper to avoid the dependency).

The fix was a `bun build` publish step (run at `prepack`) that emits a bundled `dist/` with the public deps left external and `infra-shared` **inlined**, removing the `packages/cli ↛ packages/shared` boundary. Doing this safely surfaced several non-obvious traps.

## Guidance

**Bundle only what must be bundled — keep library subpath exports as source.**
The bin (`src/cli.ts`) is bundled because it imports `infra-shared`, which must inline for external installs. But a library subpath export like `./vpn/peers` should ship as **raw source**, not from `dist/`. In-repo consumers and `bun test --recursive` resolve the workspace package through its `exports` map **at runtime**, and CI runs `bun install --frozen-lockfile --ignore-scripts`, which skips `prepack` so `dist/` is never built. Pointing `exports.default` at `dist/` therefore breaks every in-repo consumer with `Cannot find module`. Point the export at `src/...`, list that one source file in `files`, and only bundle the bin.

```jsonc
// packages/cli/package.json
"exports": {
  "./vpn/peers": {
    "types": "./src/commands/vpn/peers.ts",   // in-repo TS consumer (moduleResolution: Bundler reads exports)
    "default": "./src/commands/vpn/peers.ts"  // ship as source — NOT ./dist/...
  }
},
"bin": { "infra": "./dist/cli.js" },           // only the bin is bundled
"files": ["dist", "src/commands/vpn/peers.ts"],
"scripts": { "prepack": "bun run build" },
"devDependencies": { "@marcusrbrown/infra-shared": "workspace:*" }  // build-time only, inlined — NEVER a runtime dependency
```

**Inline the private dep explicitly; keep public deps external.** Use `bun build` with `target: bun`, `format: esm`, and an explicit `external: [...]` list of the real npm deps. Do **not** use `--packages=external` — it externalizes `infra-shared` too, defeating the purpose. Assert in a test that `dist/cli.js` has no `infra-shared` import and retains the external dep specifiers.

**Resolve packaged assets with Bun's file-asset loader, not `import.meta.dir` arithmetic.** A flat bundle changes `import.meta.dir`, breaking relative asset paths. `import x from './resources/known_hosts' with {type: 'file'}` makes `bun build` copy the asset to `dist/` (content-hashed) and rewrite the path automatically. Keep the fail-closed contract — resolution must throw if the asset is missing, never fall back to a system file. Byte-compare the shipped copy against the source-of-truth in a drift-guard test.

**Path mapping does not fix runtime file reads.** `tsconfig paths` and package `imports` are import-*specifier* resolution only; they cannot compute a runtime filesystem path for `Bun.file`/`readFile`. For monorepo-relative reads in source-only commands (deploy/client commands that never run in a published install), replace brittle `resolve(import.meta.dir, '../../../', ...)` with one repo-root-discovery helper that walks up to a workspace marker — depth-independent, so it survives bundling.

**Verify the bundle on every merge, not just the first release.** Because CI and contributors run raw `src/` while releases ship `dist/`, the bundle is a code path source runs never exercise — a "works locally, broken when published" drift class. Add a CI job that builds → `bun pm pack` → installs the tarball in an isolated dir → runs `infra --help` AND a real command that resolves the packaged asset (proves the asset ships and resolves outside the monorepo). Pin the Bun version so bundler-semantics drift can't silently change `dist/`.

## Why This Matters

The publish model had already broken external installs once (0.10.0). Each trap here re-introduces that class of failure in a way the normal `bun test` / `tsc` gate does **not** catch:

- The `dist/` export trap failed only in CI's `--ignore-scripts` environment (local runs had `dist/` built), so it passed local gates and Fro Bot caught it on the PR.
- The asset-resolution trap would fail-closed on a clean install only — `infra --help` alone wouldn't surface it; you must run a command that resolves the asset.
- Capturing it means the next person adding shared code to the published CLI imports from `@marcusrbrown/infra-shared` and it just inlines, instead of re-deriving the boundary the hard way.

## When to Apply

- Adding a build step to a package that currently publishes raw source.
- Deciding whether a subpath export should ship bundled or as source (rule: bundle the bin that needs inlined deps; ship libraries consumed in-repo as source).
- Shipping a non-JS asset that code resolves at runtime through a bundle.
- Replacing `import.meta.dir` depth arithmetic that a bundle would break.

## Examples

**Broken (CI Test failure):** `exports["./vpn/peers"].default = "./dist/commands/vpn/peers.js"` → `apps/vpn` and `bun test --recursive` fail with `Cannot find module '@marcusrbrown/infra/vpn/peers'` because CI never builds `dist/`.

**Fixed:** export points at `./src/commands/vpn/peers.ts`, `files` includes that one source file, only the bin is bundled. Verified: `rm -rf packages/cli/dist && bun test --recursive` passes (the CI condition), and a clean-room `bun add <tarball>` + `npm install -g` both run `infra --help` and reach the `known_hosts` path with no fail-closed error and no `infra-shared` in the install.

## Related

- `docs/solutions/integration-issues/ssh-agent-too-many-authentication-failures-2026-06-13.md` — the same `packages/cli` cannot-import-`infra-shared` constraint forced a CLI-local duplicate (`ssh-identity.ts`); this lesson removes that constraint.
- `docs/solutions/workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md` — adjacent published-package/release-pipeline boundary concerns.
- Shipped in PR #624 / `@marcusrbrown/infra@0.13.2`.
