import type {ModelEntry, PrivacySnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {
  modelEntrySchema,
  parseSnapshot,
  SNAPSHOT_SOURCE_PATH,
  SNAPSHOT_SOURCE_REPO,
} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {parsePrivacyTable, PrivacyTableError} from '@marcusrbrown/infra-shared/opencode-go/parse-privacy-table'

// Refreshes packages/shared/opencode-go/privacy-snapshot.json from anomalyco/opencode `console/go.mdx`.
//
// It resolves the `dev` head SHA (no token), fetches go.mdx at exactly that SHA, parses it with the shared parser
// (which fails closed on any row or footnote it cannot map) and writes the snapshot only when a model's privacy terms
// changed. The source commit alone moving is not a change: otherwise every upstream push would open a PR.
// .github/workflows/opencode-go-privacy.yaml runs this through `bun run refresh:go-privacy`, then opens the PR
// from the body file this script writes.

export const UPSTREAM_BRANCH = 'dev'
export const COMMIT_API_URL = `https://api.github.com/repos/${SNAPSHOT_SOURCE_REPO}/commits/${UPSTREAM_BRANCH}`
export const COMPARE_BASE_URL = `https://github.com/${SNAPSHOT_SOURCE_REPO}/compare`
/** The whole string must be a lowercase 40-hex commit; there is no `m` flag, so a second line cannot ride along. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
export const DEFAULT_SNAPSHOT_PATH = resolve(
  import.meta.dir,
  '../../../packages/shared/opencode-go/privacy-snapshot.json',
)
const FETCH_TIMEOUT_MS = 30_000

export function goMdxUrl(sha: string): string {
  return `https://raw.githubusercontent.com/${SNAPSHOT_SOURCE_REPO}/${sha}/${SNAPSHOT_SOURCE_PATH}`
}

/** The part of `fetch` this script uses, so a test can pass a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface RefreshOptions {
  /** The snapshot to compare against and rewrite. Defaults to the tracked file. */
  readonly snapshotPath?: string
  /** Written only when the snapshot changed. */
  readonly bodyPath?: string
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
  /**
   * Raises the API rate limit on the `dev` lookup: shared runner IPs exhaust the unauthenticated 60/hr. Sent to
   * api.github.com only, never to raw.githubusercontent.com. Unset means an unauthenticated request.
   */
  readonly githubToken?: string
}

export interface RefreshResult {
  readonly changed: boolean
  readonly sourceCommit: string
}

export interface SnapshotDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** The exact bytes the file holds: two-space JSON, parser key order, one trailing newline. */
export function serializeSnapshot(snapshot: PrivacySnapshot): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`
}

async function getText(fetchImpl: FetchLike, url: string, headers: Record<string, string>): Promise<string> {
  const response = await fetchImpl(url, {headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)})
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`.trimEnd())
  return response.text()
}

/** Resolves the current `dev` head. The SHA is validated before it reaches the raw-content URL. */
export async function resolveDevSha(fetchImpl: FetchLike, githubToken?: string): Promise<string> {
  const text = await getText(fetchImpl, COMMIT_API_URL, {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'marcusrbrown-infra-refresh-go-privacy',
    ...(githubToken ? {Authorization: `Bearer ${githubToken}`} : {}),
  })
  let sha: unknown
  try {
    const body: unknown = JSON.parse(text)
    sha = typeof body === 'object' && body !== null && 'sha' in body ? body.sha : undefined
  } catch {
    throw new Error(`GET ${COMMIT_API_URL} returned a body that is not JSON`)
  }
  if (typeof sha !== 'string' || !COMMIT_SHA_PATTERN.test(sha)) {
    throw new Error(`GET ${COMMIT_API_URL} did not return a 40-hex commit SHA`)
  }
  return sha
}

export function diffSnapshots(
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, ModelEntry>>,
): SnapshotDiff {
  const added = Object.keys(after).filter(id => !(id in before))
  const removed = Object.keys(before).filter(id => !(id in after))
  const changed = Object.keys(after).filter(id => id in before && !isDeepStrictEqual(before[id], after[id]))
  return {added: added.sort(), removed: removed.sort(), changed: changed.sort()}
}

const describeEntry = (entry: ModelEntry): string =>
  [
    `zero retention: ${entry.zeroRetention ? 'yes' : 'no'}`,
    `trains on data: ${entry.trainsOnData ? 'yes' : 'no'}`,
    `region-gated: ${entry.regionGated ? 'yes' : 'no'}`,
    `agreement expiry: ${entry.agreementExpiry ?? 'none'}`,
  ].join(', ')

function describeBefore(entry: unknown): string {
  const parsed = modelEntrySchema.safeParse(entry)
  return parsed.success ? describeEntry(parsed.data) : 'invalid entry'
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The PR body: model changes with their privacy fields, and the upstream compare link to review them against. */
export function renderPrBody(
  previousCommit: string,
  next: PrivacySnapshot,
  diff: SnapshotDiff,
  before: Readonly<Record<string, unknown>>,
): string {
  const lines: string[] = [
    '## OpenCode Go privacy snapshot refresh',
    '',
    `Source: \`${SNAPSHOT_SOURCE_REPO}\` @ \`${next.source.commit}\` (\`${SNAPSHOT_SOURCE_PATH}\`)`,
    '',
    `Compare: ${COMPARE_BASE_URL}/${previousCommit}...${next.source.commit}`,
    '',
    'Check each change below against the upstream table before merging. Merging triggers the gated cliproxy deploy; ' +
      'a model that is added here is exposed only after that deploy is approved.',
  ]

  const section = (title: string, items: readonly string[]): void => {
    lines.push('', `### ${title} (${items.length})`, '')
    if (items.length === 0) lines.push('None.')
    else lines.push(...items)
  }
  const after = (id: string): string => describeBefore(next.models[id])

  section(
    'Added',
    diff.added.map(id => `- \`${id}\`: ${after(id)}`),
  )
  section(
    'Removed',
    diff.removed.map(id => `- \`${id}\`: was ${describeBefore(before[id])}`),
  )
  section(
    'Changed',
    diff.changed.map(id => `- \`${id}\`: was ${describeBefore(before[id])}; now ${after(id)}`),
  )
  return `${lines.join('\n')}\n`
}

function writeAtomic(target: string, content: string): void {
  const temp = `${target}.${process.pid}.tmp`
  mkdirSync(dirname(target), {recursive: true})
  try {
    writeFileSync(temp, content)
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, {force: true})
    throw error
  }
}

/**
 * Fetches, parses and compares. Writes the snapshot (and the PR body when `bodyPath` is set) only when a model's
 * privacy terms changed. Any failure throws before anything is written, so the existing snapshot stays untouched.
 */
export async function refreshGoPrivacy({
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  bodyPath,
  fetch: fetchImpl = globalThis.fetch,
  githubToken,
}: RefreshOptions = {}): Promise<RefreshResult> {
  let rawBefore: unknown
  try {
    rawBefore = JSON.parse(readFileSync(snapshotPath, 'utf8'))
  } catch (error) {
    throw new Error(`cannot read the current snapshot at ${snapshotPath}: ${errorText(error)}`, {cause: error})
  }
  // Throws when the envelope is malformed; per-entry problems stay visible in the diff instead.
  const previous = parseSnapshot(rawBefore)
  const beforeModels = isRecord(rawBefore) && isRecord(rawBefore.models) ? rawBefore.models : {}

  const sha = await resolveDevSha(fetchImpl, githubToken)
  const url = goMdxUrl(sha)
  const mdx = await getText(fetchImpl, url, {'User-Agent': 'marcusrbrown-infra-refresh-go-privacy'})
  if (mdx.trim() === '') throw new Error(`GET ${url} returned an empty body`)

  const next = parsePrivacyTable(mdx, sha)
  if (Object.keys(next.models).length === 0) throw new PrivacyTableError('parsed zero models')

  const diff = diffSnapshots(beforeModels, next.models)
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return {changed: false, sourceCommit: sha}
  }

  if (bodyPath !== undefined) writeAtomic(bodyPath, renderPrBody(previous.source.commit, next, diff, beforeModels))
  writeAtomic(snapshotPath, serializeSnapshot(next))
  return {changed: true, sourceCommit: sha}
}

if (import.meta.main) {
  try {
    const result = await refreshGoPrivacy({
      snapshotPath: process.env.GO_PRIVACY_SNAPSHOT_PATH || undefined,
      bodyPath: process.argv[2] ?? (process.env.GO_PRIVACY_PR_BODY_PATH || undefined),
      githubToken: process.env.GITHUB_TOKEN || undefined,
    })
    const outputFile = process.env.GITHUB_OUTPUT
    if (outputFile) appendFileSync(outputFile, `changed=${result.changed}\n`)
    process.stdout.write(
      result.changed
        ? `snapshot changed (source ${result.sourceCommit})\n`
        : `snapshot unchanged (source ${result.sourceCommit})\n`,
    )
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    process.exit(1)
  }
}
