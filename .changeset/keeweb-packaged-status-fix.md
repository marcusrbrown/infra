---
"@marcusrbrown/infra": patch
---

Fix `keeweb status` content hash check emitting a degraded warning when running from a packaged install (bunx, npm global, unpacked tarball).

Previously, `checkContentHash` returned `level: 'warning'` for non-source-checkout environments, making packaged CLI and MCP status look degraded even though the content hash comparison is a source-only local operation.

Now detects the install layout by checking for a source-only marker file (`apps/keeweb/src/build.ts`) that is never shipped in the CLI package. When the marker is absent (packaged/unpacked install), the check returns `level: 'info'` with a clean, actionable message: `Content hash not available: local KeeWeb dist is only present in a source checkout`. This avoids exposing raw temp or node_modules paths and does not count toward the warning total in the status summary.

Source checkout behavior is unchanged: missing dist still shows the actionable build hint at `level: 'warning'`; matching or mismatched hashes return `ok` or `warning` respectively.
