import {existsSync} from 'node:fs'
import {isAbsolute, join, resolve} from 'node:path'

// File-asset import: at source-run time Bun resolves this to the real
// src/resources/known_hosts path. Under `bun build`, the bundler copies the
// asset into the output directory and rewrites this constant to the dist-relative
// path — so the packaged binary always finds the file regardless of where dist/
// lands relative to the original source tree.
import knownHostsAssetPath from '../resources/known_hosts' with {type: 'file'}

const FAIL_CLOSED_ERROR =
  'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout'

/**
 * Resolve the path to the repo-pinned `.github/known_hosts` file.
 *
 * SSH commands in this CLI use `StrictHostKeyChecking=yes` but the invoking
 * user's `~/.ssh/known_hosts` may not contain the pinned host keys for
 * `metrics.fro.bot`, `gateway.fro.bot`, etc. The repo ships authoritative
 * host keys in `.github/known_hosts`. When that file exists, SSH commands
 * should use it via `UserKnownHostsFile=<path>` so host verification succeeds
 * without weakening `StrictHostKeyChecking`.
 *
 * @param repoRoot - Optional override for the repo root directory. Defaults to
 *   the actual repo root resolved relative to this file's location. Pass a
 *   custom path in tests to avoid touching the real filesystem.
 * @returns Absolute path to `.github/known_hosts` if it exists, otherwise null.
 */
export function resolveRepoKnownHostsPath(repoRoot?: string): string | null {
  // This file lives at packages/cli/src/lib/known-hosts.ts
  // Repo root is 4 levels up: lib → src → cli → packages → repo root
  const base = repoRoot ?? resolve(import.meta.dir, '..', '..', '..', '..')
  const candidate = join(base, '.github', 'known_hosts')
  return existsSync(candidate) ? candidate : null
}

/**
 * Resolve the pinned known_hosts file from either layout:
 *
 * 1. Repo checkout: `.github/known_hosts` at the monorepo root (4 levels up
 *    from `src/lib/`).
 * 2. Installed/bundled package: the file-asset import `knownHostsAssetPath`
 *    — at source-run time this is `src/resources/known_hosts`; under
 *    `bun build` the bundler copies the asset to `dist/` and rewrites the
 *    path so the bundle always resolves correctly.
 *
 * Prefers the repo checkout layout when both exist. Throws a clear error if
 * neither is found — fail-closed, never silently falls back to user
 * `~/.ssh/known_hosts`.
 *
 * @param libDir - Override for the directory containing this file (for tests).
 *   Defaults to `import.meta.dir`. Only affects Layout 1 (repo checkout walk-up).
 * @returns Absolute path to the pinned known_hosts file.
 * @throws Error if no pinned known_hosts file is found.
 */
export function resolveKnownHostsPath(libDir?: string): string {
  const dir = libDir ?? import.meta.dir

  // Layout 1: repo checkout — walk up 4 levels from src/lib to repo root
  const repoRoot = resolve(dir, '..', '..', '..', '..')
  const repoCandidate = join(repoRoot, '.github', 'known_hosts')
  if (existsSync(repoCandidate)) return repoCandidate

  // Layout 2: installed/bundled package — use the file-asset import path.
  // At source-run time Bun returns an absolute path. Under `bun build`, the
  // bundler returns a relative filename for the asset emitted beside the
  // bundle, so resolve it relative to this module rather than process.cwd().
  const assetPath = isAbsolute(knownHostsAssetPath)
    ? knownHostsAssetPath
    : resolve(import.meta.dir, knownHostsAssetPath)
  if (existsSync(assetPath)) return assetPath

  throw new Error(FAIL_CLOSED_ERROR)
}

/**
 * Build the SSH `-o UserKnownHostsFile=<path>` argument pair for the
 * repo-pinned known_hosts file.
 *
 * Returns `['-o', 'UserKnownHostsFile=<path>']` when the file is found.
 * Throws a clear error if no pinned known_hosts file is available — fail-closed,
 * never silently omits `UserKnownHostsFile` for SSH commands that rely on
 * pinned verification.
 *
 * @param libDir - Override for the directory containing this file (for tests).
 */
export function buildKnownHostsArgs(libDir?: string): string[] {
  const path = resolveKnownHostsPath(libDir)
  return ['-o', `UserKnownHostsFile=${path}`]
}
