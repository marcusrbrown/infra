---
title: npm publishing silently failed for nine days from stacked workflow-auth and expired-token causes
date: 2026-08-23
category: integration-issues
module: .github/workflows/release.yaml
problem_type: integration_issue
component: development_workflow
symptoms:
  - "changeset publish fails with E404: Not Found - PUT https://registry.npmjs.org/@marcusrbrown%2finfra"
  - "Versions 0.16.0, 0.17.0, and 0.18.0 never reached the registry while package.json advanced"
  - "Release workflow runs report success on every merge that does not attempt a publish"
  - "The published package remains resolvable, so the 404 looks like a missing-package error"
root_cause: config_error
resolution_type: workflow_improvement
severity: high
related_components:
  - tooling
  - authentication
tags:
  - npm
  - publishing
  - changesets
  - github-actions
  - trusted-publishing
  - oidc
  - release-pipeline
---

# npm publishing silently failed for nine days from stacked workflow-auth and expired-token causes

## Problem

npm publishing for `@marcusrbrown/infra` broke on 2026-08-13 and stayed broken until 2026-08-23. Versions `0.16.0`, `0.17.0`, and `0.18.0` were versioned, tagged in `package.json`, and merged to `main` but never reached the registry — npm continued serving `0.15.4` as `latest` while the repo believed it had shipped three releases.

## Symptoms

```text
No changesets found. Attempting to publish any unpublished packages to npm
[command]/home/runner/.bun/bin/bunx changeset publish
🦋 changeset v3.0.1
These packages will be published as they were not found in the registry:
@marcusrbrown/infra@0.17.0
Some packages failed to publish:
@marcusrbrown/infra@0.17.0
└ E404: Not Found - PUT https://registry.npmjs.org/@marcusrbrown%2finfra - Not found
```

Two properties made this hard to see:

- **The error is non-diagnostic.** npm returns `E404` on `PUT` for anonymous requests, expired tokens, and unauthorized-scope writes alike — never `401` or `403`. The status code carries no information about which failure occurred, and reads as though the package does not exist.
- **The failing path runs rarely.** Only a release-PR merge attempts a publish. Every other Release run took the version path, regenerated the release PR, and reported success. The workflow was green for nine days while publishing was dead.

## What Didn't Work

- **Blaming `changesets/action` v2 alone.** This was a real defect and the fix was necessary, but insufficient — the identical `E404` persisted afterward. Treating a partially-correct diagnosis as complete cost an extra failed release. When a confirmed fix does not change the symptom, the correct inference is a second independent cause, not a bad fix.
- **Suspecting Bun.** `bunx changeset publish` looks like it should route through `bun publish`, which has no OIDC support. It does not. Verified in installed source at `node_modules/.bun/@changesets+cli@3.0.1/node_modules/@changesets/cli/dist/getPublishPlan.mjs`: `getPublishTool()` branches only to pnpm and yarn, and everything else — Bun included — falls through to `return npm_exports`, whose publish calls `exec("npm", ["publish", ...])`. Its `sanitizeEnv` strips only `NPM_CONFIG_OTP`/`npm_config_otp`, so `ACTIONS_ID_TOKEN_REQUEST_*` reach the npm child process intact.
- **Expecting the repair merge to publish.** Merging the fix did not republish the pending version. A changeset was still present on `main`, so the run took the version path and regenerated the release PR instead. Only a merge with no pending changesets reaches the publish path.

## Solution

### Cause 1 — workflow wiring (PR #1163)

`changesets/action` v2.0.0 (upstream PR #695, commit `469993c`) removed its `.npmrc` handling:

> Removed `.npmrc` handling when the `NPM_TOKEN` environment variable is set. Authentication should be handled via Trusted Publishing instead. If a token is still needed, use `actions/setup-node` … via the `registry-url` option.

v1 wrote the npmrc itself, so `NPM_TOKEN` alone sufficed. This repo adopted v2 at commit `92b7ee2` (2026-08-15) and kept passing `NPM_TOKEN`, which v2 ignores. With `actions/setup-node` + `registry-url`, the generated npmrc is `//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}` — that variable was never set, so it interpolated empty and every publish went out anonymous.

### Cause 2 — expired credential

The npm granular token behind the `NPM_TOKEN` secret expired in the same window, with no trusted publisher configured as a fallback. Rotating it was operator-side work; nothing in the repo could detect or report it.

Recovery once both were addressed — `workflow_dispatch` is supported, so no empty commit is needed:

```bash
gh workflow run release.yaml --ref main
```

This published `0.19.0`.

### Eliminating the credential (PR #1171)

Restoring token auth left the same failure scheduled to recur at the next expiry. The durable fix was migrating to npm Trusted Publishing over GitHub OIDC, which removes the long-lived credential entirely:

```diff
       - id: changesets
         name: Create Release Pull Request or Publish
         uses: changesets/action@8488615a623b1b9c987934bb89eae8af6a946ac1 # v2.1.1
-        env:
-          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
         with:
           github-token: ${{ steps.get-app-token.outputs.token }}
```

The root `.npmrc` was **deleted**, not just emptied of its value:

```diff
-//registry.npmjs.org/:_authToken=${NODE_AUTH_TOKEN}
```

Both removals are mandatory. npm silently stays on the token path and skips OIDC entirely if it finds any auth token configuration, so a leftover npmrc would have produced a confusing partial migration that still depended on a credential.

Preconditions, all already satisfied by the existing workflow: job-level `id-token: write`, Node ≥ 22.14.0 (repo uses 24), npm ≥ 11.5.1 (Node 24 bundles npm 11), and `actions/setup-node` with `registry-url`. The npm-side Trusted Publisher is registered against `marcusrbrown/infra`, workflow `release.yaml`, no environment — the workflow filename and the absence of an `environment:` key must match exactly.

## Why This Works

Two independent faults produced one indistinguishable symptom, and each masked the other: correcting the wiring still hit the dead token, and rotating the token alone would still have interpolated into an unset variable. Because `E404` is npm's response to every authentication and authorization failure, the error text could not partition the causes — and the natural reading of "404 on a package that exists" points at the wrong subsystem entirely.

Registry metadata is what separated them:

```bash
curl -s https://registry.npmjs.org/@marcusrbrown%2Finfra
```

`0.15.4` showed a successful publish on 2026-08-13 with `_npmUser: marcusrbrown` and intact provenance attestations — under the same workflow shape that was now failing. A workflow-only defect could not explain a version that had published cleanly days earlier, which moved the credential from "unlikely" to "primary suspect".

The same technique proved the OIDC migration rather than trusting a green check:

|                    | `0.19.0` (token)               | `0.20.0` (OIDC)                                 |
| ------------------ | ------------------------------ | ----------------------------------------------- |
| `_npmUser`         | `marcusrbrown <npm@mrbro.dev>` | `GitHub Actions <npm-oidc-no-reply@github.com>` |
| `trustedPublisher` | absent                         | `id: github`, `oidcConfigId: oidc:…`            |
| Provenance         | present                        | present (SLSA v1)                               |

The publisher identity changing to GitHub Actions with a `trustedPublisher` record is registry-side proof the OIDC path executed — not a token publish that happened to succeed.

`npm/cli#8976` (open since 2026-02-12) reports scoped package + OIDC + changesets failing with this exact `E404`. That is this repository's configuration and it did not reproduce, so the upstream bug is narrower than its title suggests.

## Prevention

- **Encode the auth contract as a test.** `packages/cli/src/conventions.test.ts` has `release workflow uses tokenless npm trusted publishing`, which asserts the changesets step carries neither `NODE_AUTH_TOKEN` nor `NPM_TOKEN`, that the job grants `id-token: write`, that `actions/setup-node` sets `registry-url`, and — critically — globs _every_ `.npmrc` outside `node_modules` and fails on any `_authToken` line. Guarding only the root path would miss a reintroduction one directory away.
- **Read registry metadata before reading logs.** On any publish failure, compare `_npmUser`, version presence, `trustedPublisher`, and attestations against the last known-good release. This distinguishes a wiring change from a credential change in one request; workflow logs cannot.
- **Treat `E404` on `PUT` as an auth failure until proven otherwise.** It never means the package is missing.
- **Do not stop at the first confirmed cause.** A verified fix that leaves the symptom unchanged is evidence of a second independent fault, not of a bad fix.
- **A failure signal nobody watches is not a signal.** This ran nine days because failed Release runs surfaced nowhere anyone looked. The structural fix is removing the failure mode — OIDC has no credential to expire — rather than adding another alarm to an unwatched channel.
- **Verify rare paths after changing shared workflow dependencies.** A `changesets/action` major bump only manifests on the publish path, which most merges never touch. Assume a green pipeline has not exercised it.

## Related Issues

- [`docs/solutions/workflow-issues/release-changeset-graphql-premature-close-2026-06-28.md`](../workflow-issues/release-changeset-graphql-premature-close-2026-06-28.md) — same changesets release lane, different failure class.
- [`docs/solutions/best-practices/cli-bun-build-publish-model-2026-06-20.md`](../best-practices/cli-bun-build-publish-model-2026-06-20.md) — how the published CLI is bundled; adjacent packaging boundary.
- [`docs/solutions/workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md`](../workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md) — same release-automation family.
- [`docs/solutions/integration-issues/cliproxy-claude-oauth-refresh-expiry-2026-06-20.md`](./cliproxy-claude-oauth-refresh-expiry-2026-06-20.md) — credential-expiry analogue in a different subsystem.
- Upstream: `changesets/action` PR #695 (removed npmrc handling), `npm/cli#8976` (scoped + OIDC + changesets `E404`).
