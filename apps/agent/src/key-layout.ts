/**
 * The key layout is intentionally versioned with the consuming action. Do not
 * widen this table to make an unverified action ref provision successfully.
 *
 * v0.96.0 is the only currently admitted action ref. Its session and
 * coordination paths below are the plan's pinned contract and must be
 * re-verified before adding another action version here.
 */
export const KEY_LAYOUT_VERSION = 'fro-bot/agent@v0.96.0' as const
export const AGENT_ACTION_LAYOUT_VERSION = KEY_LAYOUT_VERSION

const PINNED_ACTION_REF = 'v0.96.0'
const PINNED_ACTION_SHA = 'c29ac295b8da06768b140c32e5bd0ae3aff45dc6'

export interface AgentKeyLayout {
  actionVersion: typeof KEY_LAYOUT_VERSION
  sessionPrefix: string
  lockKey: string
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
  const repositorySegment = `${ownerSegment}-${repoSegment}`
  const sessionPrefix = `${normalizedPrefix}github/${repositorySegment}/storage/`
  const lockPrefix = `${normalizedPrefix}coordination/github/${repositorySegment}/locks/`
  const lockKey = `${lockPrefix}storage.lock`

  return {
    actionVersion: verifiedVersion,
    sessionPrefix,
    lockKey,
    lockPrefix,
    listBucketPrefixes: [sessionPrefix, lockPrefix],
  }
}
