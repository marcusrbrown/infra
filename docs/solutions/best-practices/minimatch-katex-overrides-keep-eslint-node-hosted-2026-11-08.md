---
title: "Root minimatch and katex overrides cross majors: keep ESLint Node-hosted"
date: 2026-11-08
module: package.json
problem_type: tooling_decision
component: tooling
severity: low
applies_when:
  - "Running ESLint under Bun, or importing the ESLint API from a Bun script"
  - "Bumping @eslint/config-array, eslint-plugin-import-x or other ESLint plugins"
  - "Removing or changing the root package.json overrides block"
tags: [bun, eslint, minimatch, katex, overrides, scorecard, dependencies]
---

# Root minimatch and katex overrides cross majors: keep ESLint Node-hosted

## Context

Scorecard alert #30 flagged two dev-dependency advisories: one in the ESLint toolchain and one in the Markdown math dependency chain.

- minimatch 10.2.6 (GHSA-g3hv-75wg-m249, fixed in 11.0.1)
- katex 0.16.47 (GHSA-238p-pmpm-9mq7, fixed in 0.18.2)

Their parents pin `minimatch` `^10` and `katex` `^0.16.0`, and were already at their latest releases. So the lockfile can't reach the fixes without a root override (PR #1819).

## Guidance

The root `package.json` forces the patched majors:

```json
"overrides": {
  "katex": "0.18.11",
  "minimatch": "11.0.5"
},
```

Keep ESLint hosted by Node. `bun run lint`, `bun run fix` and lint-staged run the `eslint` bin through its `node` shebang, and CI pins Node. Don't run ESLint in process under Bun (`bun --bun eslint`, or `import {ESLint} from 'eslint'` in a Bun script). minimatch 11 dropped the `makeRe` export, and the ESM build of `eslint-plugin-import-x` still imports it. In the PR #1819 review, Bun-hosted ESLint failed with `Export named 'makeRe' not found`.

**Exit condition:** remove the block once every consumer's own range admits a patched release without a forced major. Today these still declare minimatch `^10` or older in `bun.lock`:

- `eslint`
- `@eslint/config-array`
- `@typescript-eslint/typescript-estree`
- `eslint-plugin-import-x`
- `eslint-plugin-json-schema-validator`

After you remove the block, update `bun.lock` and review the change. Then run a frozen install, `bun run lint`, and a smoke check with ESLint running under Bun.

## Why This Matters

The overrides cross major-version boundaries. Bun-hosted ESLint fails because `eslint-plugin-import-x` imports an export removed in minimatch 11. Nothing in the repo runs that path today.

## When to Apply

- Before adding a Bun-hosted lint or tooling script.
- When a Renovate bump touches the ESLint plugin chain.
- When the Scorecard vulnerability alert for either package reopens.

## Examples

`bun why minimatch` currently shows a single `minimatch@11.0.5`. If another version appears, find its consumers and check each resolved version against the advisory's affected range.
