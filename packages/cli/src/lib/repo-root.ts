import {existsSync, readFileSync} from 'node:fs'
import {dirname, join} from 'node:path'

const WORKSPACE_MARKER_NAME = '@marcusrbrown/infra-workspace'

/**
 * Walk up the directory tree from `start` to find the monorepo workspace root.
 *
 * The workspace root is identified by a `package.json` whose `name` field is
 * `@marcusrbrown/infra-workspace`. Intermediate `package.json` files with
 * different names are skipped — the walk continues until the marker is found
 * or the filesystem root is reached.
 *
 * These commands are source-checkout-only. The published CLI never calls this
 * helper; it is intentionally absent from the bundled dist.
 *
 * @param start - Directory to start the walk from. Defaults to `import.meta.dir`
 *   (the directory containing this file). Pass a custom path in tests.
 * @returns Absolute path to the workspace root directory.
 * @throws Error if no workspace root marker is found in any ancestor directory.
 */
export function findRepoRoot(start?: string): string {
  let current = start ?? import.meta.dir

  while (true) {
    const candidate = join(current, 'package.json')
    if (existsSync(candidate)) {
      try {
        const pkg = JSON.parse(readFileSync(candidate, 'utf-8')) as {name?: string}
        if (pkg.name === WORKSPACE_MARKER_NAME) {
          return current
        }
      } catch {
        // Malformed package.json — skip and keep walking up
      }
    }

    const parent = dirname(current)
    if (parent === current) {
      // Reached the filesystem root without finding the marker
      break
    }

    current = parent
  }

  throw new Error(
    `Workspace root not found: could not locate a package.json with name "${WORKSPACE_MARKER_NAME}" ` +
      `in any ancestor of "${start ?? import.meta.dir}". ` +
      `These commands require a source checkout of the marcusrbrown/infra monorepo.`,
  )
}
