import {materializeIdentityFile as sharedMaterializeIdentityFile} from '@marcusrbrown/infra-shared/server/droplet-helpers'

/**
 * A materialized private-key file plus a best-effort cleanup callback.
 * The cleanup removes the temp directory containing the key file.
 */
export interface MaterializedIdentity {
  path: string
  cleanup: () => void
}

/**
 * Writes a private key to a 0600 temp file (with a guaranteed single trailing
 * newline) and returns its path plus an idempotent best-effort cleanup callback.
 *
 * The trailing newline guards against env/secret injection stripping it
 * (OpenSSH rejects keys without it). Empty/whitespace-key guards live in
 * `buildIdentityArgs`; this function materializes whatever key bytes it receives.
 *
 * Delegates to the shared implementation in @marcusrbrown/infra-shared, which is
 * inlined by `bun build` — no workspace:* dep reaches the published package.
 */
export function materializeIdentityFile(privateKey: string): MaterializedIdentity {
  return sharedMaterializeIdentityFile(privateKey)
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
