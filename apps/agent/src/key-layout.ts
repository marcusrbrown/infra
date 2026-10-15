/**
 * The S3 key contract the Fro Bot Action uses for durable storage; it is not tied
 * to an Action version. The session tree is `${prefix}github/<owner>/<repo>/`.
 * The Action coordinates through the exact `${prefix}coordination/<owner>/<repo>/locks/action.json`
 * object; `locks/repo.json` is the gateway's shared-checkout lock.
 *
 * When upstream changes this contract, the daily storage run fails with AccessDenied.
 * That is the signal to update this layout, bump the label, and re-provision.
 * Never widen it to wildcards.
 */
export const KEY_LAYOUT_VERSION = 'fro-bot-agent-s3-layout/1' as const

/**
 * Handoff manifests written before the layout had its own label carry the Action ref
 * they were verified against. These refs describe the same layout, so teardown still
 * accepts them. Keep in sync with packages/cli/src/commands/agent/key-layout.ts.
 */
const LEGACY_KEY_LAYOUT_LABELS: ReadonlySet<string> = new Set(['fro-bot/agent@v0.118.2', 'fro-bot/agent@v0.119.2'])

export interface AgentKeyLayout {
  layoutVersion: typeof KEY_LAYOUT_VERSION
  sessionPrefix: string
  /** Exact shared-checkout lock object (`locks/repo.json`). */
  lockKey: string
  /** Exact Action lock object (`locks/action.json`) the Action acquires, renews, and releases. */
  actionLockKey: string
  lockPrefix: string
  listBucketPrefixes: readonly string[]
}

function assertPathSegment(value: string, label: string): string {
  const segment = value.trim()
  if (
    segment.length === 0 ||
    segment.includes('/') ||
    segment.includes('*') ||
    segment.includes('?') ||
    segment === '.' ||
    segment === '..'
  ) {
    throw new Error(`${label} must be a single path segment without wildcard characters`)
  }
  return segment
}

function canonicalizePrefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) throw new Error('S3 key-layout prefixes must not be empty')
  if (trimmed.includes('*') || trimmed.includes('?')) {
    throw new Error('S3 key-layout prefixes must not contain wildcard characters')
  }

  const segments = trimmed.replace(/^\/+/, '').replace(/\/+$/, '').split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('S3 key-layout prefixes must contain non-empty, non-relative path segments')
  }
  return `${segments.join('/')}/`
}

/**
 * Validates a handoff manifest's `key_layout_version`. Unknown labels throw before the
 * provisioner mutates any resource.
 */
export function assertKnownKeyLayout(label: string): typeof KEY_LAYOUT_VERSION {
  const normalized = label.trim()
  if (normalized !== KEY_LAYOUT_VERSION && !LEGACY_KEY_LAYOUT_LABELS.has(normalized)) {
    throw new Error(`Unknown key layout ${normalized || '<empty>'}; refusing to widen S3 access`)
  }
  return KEY_LAYOUT_VERSION
}

/** Builds the canonical, delimiter-bounded key layout for one repository. */
export function buildAgentKeyLayout(owner: string, repo: string, prefix: string): AgentKeyLayout {
  const ownerSegment = assertPathSegment(owner, 'Agent repository owner')
  const repoSegment = assertPathSegment(repo, 'Agent repository name')
  const normalizedPrefix = canonicalizePrefix(prefix)
  const sessionPrefix = `${normalizedPrefix}github/${ownerSegment}/${repoSegment}/`
  const lockPrefix = `${normalizedPrefix}coordination/${ownerSegment}/${repoSegment}/locks/`
  const lockKey = `${lockPrefix}repo.json`
  const actionLockKey = `${lockPrefix}action.json`

  return {
    layoutVersion: KEY_LAYOUT_VERSION,
    sessionPrefix,
    lockKey,
    actionLockKey,
    lockPrefix,
    listBucketPrefixes: [sessionPrefix, lockPrefix],
  }
}
