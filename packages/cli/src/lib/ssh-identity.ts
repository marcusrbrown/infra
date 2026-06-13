import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

/**
 * A materialized private-key file plus a best-effort cleanup callback.
 * The cleanup removes the temp directory containing the key file.
 */
export interface MaterializedIdentity {
  path: string
  cleanup: () => void
}

// NOTE: This intentionally duplicates the key-materialization logic in
// packages/shared/server/droplet-helpers.ts. The published CLI must not depend
// on @marcusrbrown/infra-shared (that dep breaks npm install for external users).

/**
 * Writes a private key to a 0600 temp file (with a guaranteed single trailing
 * newline) and returns its path plus an idempotent best-effort cleanup callback.
 *
 * The trailing newline guards against env/secret injection stripping it
 * (OpenSSH rejects keys without it). Empty/whitespace-key guards live in
 * `buildIdentityArgs`; this function materializes whatever key bytes it receives.
 */
export function materializeIdentityFile(privateKey: string): MaterializedIdentity {
  const dir = mkdtempSync(join(tmpdir(), 'infra-ssh-key-'))
  const path = join(dir, 'id')

  const cleanup = (): void => {
    try {
      rmSync(dir, {recursive: true, force: true})
    } catch {
      // Best-effort: a missing temp dir (already cleaned) is fine.
    }
  }

  try {
    const contents = privateKey.endsWith('\n') ? privateKey : `${privateKey}\n`
    writeFileSync(path, contents, {mode: 0o600})
    chmodSync(path, 0o600)
  } catch (error) {
    // Don't leave a partial 0600 key (or its temp dir) behind on write failure.
    cleanup()
    throw error
  }

  return {path, cleanup}
}

/**
 * Result of `buildIdentityArgs` — the SSH argv fragment plus a cleanup callback.
 * When the key is absent/empty, `args` is empty and `cleanup` is a no-op.
 */
export interface IdentityArgs {
  /** SSH argv fragment: `['-i', '<path>', '-o', 'IdentitiesOnly=yes']` or `[]`. */
  args: string[]
  /** Removes the temp key file. Idempotent and safe to call multiple times. */
  cleanup: () => void
}

/**
 * Builds the `-i <keyfile> -o IdentitiesOnly=yes` SSH argv fragment from an
 * optional private key string.
 *
 * When `privateKey` is absent, empty, or whitespace-only, returns empty args
 * and a no-op cleanup so callers fall back to ssh-agent behaviour unchanged.
 */
export function buildIdentityArgs(privateKey: string | undefined): IdentityArgs {
  if (!privateKey?.trim()) {
    return {args: [], cleanup: () => undefined}
  }

  const {path, cleanup} = materializeIdentityFile(privateKey)
  return {args: ['-i', path, '-o', 'IdentitiesOnly=yes'], cleanup}
}
