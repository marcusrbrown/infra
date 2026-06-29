---
title: 'Release pipeline flakes on changeset changelog GraphQL fetch (ERR_STREAM_PREMATURE_CLOSE)'
date: 2026-06-28
category: workflow-issues
module: tooling
problem_type: workflow_issue
component: development_workflow
symptoms:
  - "Release job fails in changeset version with FetchError: Premature close"
  - "errno ERR_STREAM_PREMATURE_CLOSE thrown at Gunzip in node-fetch/lib/index.js"
  - Fails only when a changeset is pending; release runs with nothing to version pass
root_cause: config_error
resolution_type: dependency_update
severity: high
tags:
  - changesets
  - release-pipeline
  - node-fetch
  - graphql
  - gzip
  - bun-patch
  - github-actions
related_components:
  - tooling
---

# Release pipeline flakes on changeset changelog GraphQL fetch (ERR_STREAM_PREMATURE_CLOSE)

## Problem

The GitHub Actions Release job (`changesets/action` → `changeset version`) intermittently failed during changelog generation, blocking every release that carried a pending changeset. Three identical failures landed across a ~5.5-hour window while GitHub reported "All Systems Operational".

## Symptoms

- `changeset version` aborts with:
  ```
  The following error was encountered while generating changelog entries
  We have escaped applying the changesets, and no files should have been affected
  🦋  error FetchError: Invalid response body while trying to fetch https://api.github.com/graphql: Premature close
      at Gunzip.<anonymous> (node_modules/.bun/node-fetch@2.7.0/node_modules/node-fetch/lib/index.js:217:52)
    errno: 'ERR_STREAM_PREMATURE_CLOSE', code: 'ERR_STREAM_PREMATURE_CLOSE'
  ```
- Fails **only when a changeset is pending** — release runs with nothing to version pass cleanly (no changelog GraphQL call happens).

## What Didn't Work

- **"It's transient, just rerun it."** Wrong — it failed three times across hours with GitHub fully operational. Rerunning is not a fix; the third identical failure disproved the transient framing.
- **Switching the version step from Bun to Node** (`bun run version-changesets` → `npm run version-changesets`). The original hypothesis was that `node-fetch@2` mishandles the gzipped response specifically under the Bun runtime. One post-switch release succeeded, but the very next changeset-bearing release failed with the **identical** `ERR_STREAM_PREMATURE_CLOSE` and the same `node_modules/.bun/node-fetch@2.7.0` stack — this time under `/opt/hostedtoolcache/node/24.17.0/x64/bin/npm`. The failure is **runtime-independent**; the single success was luck (n=2). This change was reverted.

## Solution

Patch the offending dependency with `bun patch` to (1) request an uncompressed response and (2) retry transient transport errors.

`@changesets/get-github-info` makes a single, unretried `node-fetch@2` POST to `https://api.github.com/graphql` to associate each changeset's commit with its PR. node-fetch requests a gzipped response by default; GitHub Actions intermittently truncates that stream before zlib finishes, so `Gunzip` throws.

```bash
bun patch '@changesets/get-github-info@0.6.0'
# edit both dist entries (CJS + ESM), then:
bun patch --commit 'node_modules/@changesets/get-github-info'
```

The patch wraps the fetch in both dist entries (`changesets-get-github-info.cjs.js`, `changesets-get-github-info.esm.js`) with `compress: false` plus a bounded retry:

```js
const data = await (async () => {
  let lastErr;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch("https://api.github.com/graphql", {
        method: "POST",
        headers: { Authorization: `Token ${process.env.GITHUB_TOKEN}` },
        body: JSON.stringify({ query: makeQuery(repos) }),
        compress: false,
      });
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < 3) {
        await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        continue;
      }
    }
  }
  throw lastErr;
})();
```

`bun patch --commit` writes `patches/@changesets%2Fget-github-info@0.6.0.patch` and wires `patchedDependencies` into `package.json`. The patch auto-applies under `bun install --frozen-lockfile` (CI install mode). PR/author links in the generated changelog are preserved.

## Why This Works

`compress: false` makes node-fetch send `Accept-Encoding: identity`, so the response is never gzipped and the `Gunzip` decompression path that throws is removed entirely — this is the actual fix. The retry is a safety net for any other transient transport error. The cause is below the application/query/token layer (the exact GraphQL query returns valid data via `gh api graphql`, and `changeset version` runs clean locally), so neither a token change, a query change, nor a runtime swap addresses it.

Verification: with the patch live, `bun run version-changesets` exits 0 and the generated `packages/cli/CHANGELOG.md` entry retains its `([#NNN](…))` PR link — proof the patched GraphQL call ran successfully — and the patch re-applies in a clean `bun install --frozen-lockfile` clone.

## Prevention

- **A reproducible CI failure is not transient.** If GitHub status is green and the same error recurs, stop rerunning and reproduce the exact failing call locally before forming a fix.
- **Don't anchor a transport bug on the runtime without isolating it.** The same `node-fetch@2` gzip stack failed under both Bun and Node 24. Confirm runtime-independence before claiming "switch runtimes" as the fix.
- **Renovate footgun:** a Renovate bump of `@changesets/get-github-info` off `0.6.0` drops the patch (the patch is version-pinned). Re-run `bun patch` against the new version on bump, or the flake returns. The `@svitejs/changesets-changelog-github-compact` plugin's dep range is `^0.6.0`.
- Alternative durable fix if PR links are ever dispensable: swap the changelog generator to the no-network `@changesets/changelog-git`, which deletes the failure class entirely (loses auto PR/author links).

## Related Issues

- `docs/solutions/workflow-issues/renovate-changesets-monorepo-targeting-2026-04-15.md` — adjacent changesets/release-pipeline configuration.
