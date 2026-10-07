/**
 * The key layout is intentionally versioned with the consuming action. Do not
 * widen this table to make an unverified action ref provision successfully.
 *
 * v0.118.2 is the only currently admitted action ref. Its session tree is
 * `${prefix}/github/<owner>/<repo>/` (sessions, artifacts, and metadata,
 * including review-delivery receipts). The Action coordinates through the exact
 * `${prefix}/coordination/<owner>/<repo>/locks/action.json` object
 * (`ACTION_LOCK_SCOPE` in `src/harness/phases/acquire-lock.ts`); the sibling
 * `locks/repo.json` is the gateway's shared-checkout lock
 * (`LOCK_OBJECT_NAMES` in `packages/runtime/src/coordination/lock.ts`). These
 * paths are the pinned contract and must be re-verified before adding another
 * action version here.
 */
export const KEY_LAYOUT_VERSION = 'fro-bot/agent@v0.118.2' as const
export const AGENT_ACTION_LAYOUT_VERSION = KEY_LAYOUT_VERSION

const PINNED_ACTION_REF = 'v0.118.2'
const PINNED_ACTION_SHA = '77f2bad7d68ac38279cd0fa28f38b26a0cd15dfb'

export interface AgentKeyLayout {
  actionVersion: typeof KEY_LAYOUT_VERSION
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
 * Returns the only action ref whose object-key contract has been verified.
 * Unknown refs throw before the provisioner creates or mutates any resource.
 */
export function assertKnownKeyLayout(actionVersion: string): typeof KEY_LAYOUT_VERSION {
  const normalized = actionVersion.trim()
  if (
    normalized !== KEY_LAYOUT_VERSION &&
    normalized !== PINNED_ACTION_REF &&
    normalized !== PINNED_ACTION_SHA &&
    normalized !== `fro-bot/agent@${PINNED_ACTION_SHA}`
  ) {
    throw new Error(
      `Unknown or unverified fro-bot/agent key layout ${normalized || '<empty>'}; refusing to widen S3 access`,
    )
  }
  return KEY_LAYOUT_VERSION
}

/** Builds the canonical, delimiter-bounded key layout for one repository. */
export function buildAgentKeyLayout(
  owner: string,
  repo: string,
  prefix: string,
  actionVersion: string = KEY_LAYOUT_VERSION,
): AgentKeyLayout {
  const verifiedVersion = assertKnownKeyLayout(actionVersion)
  const ownerSegment = assertPathSegment(owner, 'Agent repository owner')
  const repoSegment = assertPathSegment(repo, 'Agent repository name')
  const normalizedPrefix = canonicalizePrefix(prefix)
  const sessionPrefix = `${normalizedPrefix}github/${ownerSegment}/${repoSegment}/`
  const lockPrefix = `${normalizedPrefix}coordination/${ownerSegment}/${repoSegment}/locks/`
  const lockKey = `${lockPrefix}repo.json`
  const actionLockKey = `${lockPrefix}action.json`

  return {
    actionVersion: verifiedVersion,
    sessionPrefix,
    lockKey,
    actionLockKey,
    lockPrefix,
    listBucketPrefixes: [sessionPrefix, lockPrefix],
  }
}
