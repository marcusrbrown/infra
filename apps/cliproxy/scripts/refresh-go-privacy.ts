import type {Disagreement, Unmatched} from '@marcusrbrown/infra-shared/opencode-go/build-snapshot'
import type {ModelEntry, PrivacySnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, resolve} from 'node:path'
import {isDeepStrictEqual} from 'node:util'

import {
  buildSnapshot,
  describeDisagreement,
  describeUnmatched,
} from '@marcusrbrown/infra-shared/opencode-go/build-snapshot'
import {
  computeEligibility,
  modelEntrySchema,
  parseSnapshot,
  SNAPSHOT_SOURCE_PATH,
  SNAPSHOT_SOURCE_REPO,
} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {GO_LIVE_MODELS_URL, parseLiveModels} from '@marcusrbrown/infra-shared/opencode-go/live-models'
import {
  parsePrivacyDocsWithOrphans,
  PrivacyTableError,
} from '@marcusrbrown/infra-shared/opencode-go/parse-privacy-table'

// Refreshes packages/shared/opencode-go/privacy-snapshot.json from two sources: anomalyco/opencode
// `console/go.mdx` (retention days, agreement expiry, workspace Global rule) and the live Go models list
// (`training`, `zdr`, `limited_regions` for every model).
//
// It resolves the `dev` head SHA (no token), fetches go.mdx at exactly that SHA and the live models list (no token),
// builds the snapshot with the shared join (most restrictive source wins; fails closed on any row, footnote, model
// or field it cannot account for) and writes the snapshot only when a model's privacy terms changed. The source
// commit alone moving is not a change: otherwise every upstream push would open a PR.
// .github/workflows/opencode-go-privacy.yaml runs this through `bun run refresh:go-privacy`, then opens the PR
// from the body file this script writes. A changed snapshot also gets one patch changeset for the published CLI,
// which inlines the snapshot at build time: merging the PR queues a release through the Version Packages PR.
// Each run names its file after the upstream commit and the workflow run, so it never equals a changeset already
// pending on `main`, whatever snapshot the run proposes.

export const UPSTREAM_BRANCH = 'dev'
export const COMMIT_API_URL = `https://api.github.com/repos/${SNAPSHOT_SOURCE_REPO}/commits/${UPSTREAM_BRANCH}`
export const COMPARE_BASE_URL = `https://github.com/${SNAPSHOT_SOURCE_REPO}/compare`
/** The whole string must be a lowercase 40-hex commit; there is no `m` flag, so a second line cannot ride along. */
export const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/
export const DEFAULT_SNAPSHOT_PATH = resolve(
  import.meta.dir,
  '../../../packages/shared/opencode-go/privacy-snapshot.json',
)
export const DEFAULT_CHANGESET_DIR = resolve(import.meta.dir, '../../../.changeset')
/** The published package that inlines the snapshot. */
export const CHANGESET_PACKAGE = '@marcusrbrown/infra'
const FETCH_TIMEOUT_MS = 30_000

export function goMdxUrl(sha: string): string {
  return `https://raw.githubusercontent.com/${SNAPSHOT_SOURCE_REPO}/${sha}/${SNAPSHOT_SOURCE_PATH}`
}

/** The part of `fetch` this script uses, so a test can pass a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

/** Where the changeset goes and the run that writes it. Both parts are digits only, checked before any write. */
export interface ChangesetTarget extends RunIdentity {
  readonly dir: string
}

export interface RefreshOptions {
  /** The snapshot to compare against and rewrite. Defaults to the tracked file. */
  readonly snapshotPath?: string
  /** Written only when the snapshot changed. */
  readonly bodyPath?: string
  /** Receives one release changeset, only when the snapshot changed. Unset writes none. */
  readonly changeset?: ChangesetTarget
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
  /**
   * Raises the API rate limit on the `dev` lookup: shared runner IPs exhaust the unauthenticated 60/hr. Sent to
   * api.github.com only, never to raw.githubusercontent.com. Unset means an unauthenticated request.
   */
  readonly githubToken?: string
  /** Today for the eligibility check behind the PR warning (an agreement that has expired is not exposed). */
  readonly now?: () => Date
  /** Receives one line per model left out of the snapshot, whether or not a PR opens. Defaults to stdout. */
  readonly log?: (line: string) => void
}

export interface RunIdentity {
  /** `GITHUB_RUN_ID` in CI. */
  readonly runId: string
  /** `GITHUB_RUN_ATTEMPT` in CI: a re-run of the same run id gets the next attempt. */
  readonly runAttempt: string
}

export type RefreshResult =
  | {readonly changed: false; readonly sourceCommit: string; readonly changesetFile?: undefined}
  | {
      readonly changed: true
      readonly sourceCommit: string
      /** How many models the previous snapshot made eligible and this one does not (see `restrictedModels`). */
      readonly restricted: number
      /** The bare name of the changeset written into the target directory; absent when none was written. */
      readonly changesetFile?: string
    }

export interface SnapshotDiff {
  readonly added: readonly string[]
  readonly removed: readonly string[]
  readonly changed: readonly string[]
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertCommitSha(sha: string): void {
  if (!COMMIT_SHA_PATTERN.test(sha)) throw new Error('a changeset needs a 40-hex upstream commit SHA')
}

const RUN_ID_PATTERN = /^\d{1,20}$/
const RUN_ATTEMPT_PATTERN = /^\d{1,4}$/

function assertRunIdentity({runId, runAttempt}: RunIdentity): void {
  if (!RUN_ID_PATTERN.test(runId) || !RUN_ATTEMPT_PATTERN.test(runAttempt)) {
    throw new Error('the changeset run identity must be a run id and an attempt number, digits only')
  }
}

/**
 * The identity of this run: `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` in CI, unique per run and per re-run without a
 * clock. Off CI (neither set) it is the UTC time to the second as 14 digits plus attempt 1: digits only, so it passes
 * the same check, and unique enough for a person running the script by hand (a real run id has fewer digits). One set
 * without the other is a broken environment and throws.
 */
export function runIdentityFromEnv(env: Readonly<Record<string, string | undefined>>, now: Date): RunIdentity {
  const runId = env.GITHUB_RUN_ID || undefined
  const runAttempt = env.GITHUB_RUN_ATTEMPT || undefined
  if (runId === undefined && runAttempt === undefined) {
    return {runId: now.toISOString().replaceAll(/\D/g, '').slice(0, 14), runAttempt: '1'}
  }
  if (runId === undefined || runAttempt === undefined) {
    throw new Error('the changeset run identity needs both GITHUB_RUN_ID and GITHUB_RUN_ATTEMPT, or neither')
  }
  return {runId, runAttempt}
}

/**
 * A new name for every run, so a run's changeset is never a file `main` already holds. The docs commit is only for
 * the eye. The name is safe in a path: it holds hex from a validated SHA and digits that passed the pattern checks.
 */
export function changesetFileName(sha: string, run: RunIdentity): string {
  assertCommitSha(sha)
  assertRunIdentity(run)
  return `opencode-go-privacy-${sha.slice(0, 7)}-${run.runId}-${run.runAttempt}.md`
}

/** A patch bump for the CLI and one plain sentence for its release notes. */
export function renderChangeset(sha: string): string {
  assertCommitSha(sha)
  return `---\n'${CHANGESET_PACKAGE}': patch\n---\n\nRefresh the bundled OpenCode Go privacy snapshot to upstream commit \`${sha.slice(0, 7)}\` of \`${SNAPSHOT_SOURCE_REPO}\`.\n`
}

/**
 * The `$GITHUB_OUTPUT` lines for one run. `changeset` is a bare file name, present only when one was written.
 * `restricted` is a count and nothing else: model ids are upstream text and never reach the workflow.
 */
export function workflowOutputs(result: RefreshResult): string {
  if (!result.changed) return 'changed=false\n'
  const changeset = result.changesetFile === undefined ? '' : `changeset=${result.changesetFile}\n`
  return `changed=true\n${changeset}restricted=${result.restricted}\n`
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

/** The Go models list, tokenless. Parsing it strictly is `parseLiveModels`'s job; here it is only fetched and decoded. */
async function fetchLiveModels(fetchImpl: FetchLike): Promise<unknown> {
  const text = await getText(fetchImpl, GO_LIVE_MODELS_URL, {
    Accept: 'application/json',
    'User-Agent': 'marcusrbrown-infra-refresh-go-privacy',
  })
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`GET ${GO_LIVE_MODELS_URL} returned a body that is not JSON`)
  }
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

/**
 * Models the previous snapshot made eligible that `next` does not: what the gated deploy would stop serving once the
 * PR merges. Covers zero retention lost, training on, newly region-gated, an expired agreement and removal. A model
 * that was already ineligible, or that is added or relaxed, is not restricted. Same eligibility rule as the deploy.
 */
export function restrictedModels(
  previouslyEligible: ReadonlySet<string>,
  next: PrivacySnapshot,
  liveIds: readonly string[],
  todayUtc: string,
): string[] {
  const stillEligible = new Set(computeEligibility({...next, invalid: []}, liveIds, todayUtc).eligible)
  return [...previouslyEligible].filter(id => !stillEligible.has(id)).sort()
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** The PR body: model changes with their privacy fields, and the upstream compare link to review them against. */
export function renderPrBody(
  previousCommit: string,
  next: PrivacySnapshot,
  diff: SnapshotDiff,
  before: Readonly<Record<string, unknown>>,
  disagreements: readonly Disagreement[] = [],
  unmatched: readonly Unmatched[] = [],
  previouslyEligible: ReadonlySet<string> = new Set(),
): string {
  // Models the previous snapshot made eligible (listed, zero retention, no training, no region gate, agreement in
  // date, live) and upstream published no privacy fields for: this PR takes a working model away. A model that was
  // listed but already ineligible is only a snapshot tidy-up, so it gets no warning.
  const droppedExposed = unmatched
    .filter(item => item.missing === 'privacy' && item.id !== null && previouslyEligible.has(item.id))
    .map(item => `\`${item.id}\``)
  const lines: string[] = [
    '## OpenCode Go privacy snapshot refresh',
    '',
    ...(droppedExposed.length === 0
      ? []
      : [
          `**Warning: upstream published no privacy fields for ${droppedExposed.length} model(s) that were eligible under the previous snapshot (${droppedExposed.join(', ')}), so this PR removes them. Check that the live models list is not degraded before merging: removing a model is the safe direction for privacy but takes it away from agents.**`,
          '',
        ]),
    `Source: \`${SNAPSHOT_SOURCE_REPO}\` @ \`${next.source.commit}\` (\`${SNAPSHOT_SOURCE_PATH}\`)`,
    '',
    `Compare: ${COMPARE_BASE_URL}/${previousCommit}...${next.source.commit}`,
    '',
    `Live models: \`${GO_LIVE_MODELS_URL}\` (read at refresh time; not recorded in the snapshot)`,
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

  lines.push(
    '',
    'The snapshot takes the more restrictive value of the two sources for every fact. The two lists below are where ' +
      'the sources differ, so you can check which one is right. The Global-region rule and agreement expiry are ' +
      'stated on the page only (the API field means something else), so they are never listed here.',
  )
  section(
    'Sources disagree',
    disagreements.filter(d => d.kind === 'conflict').map(d => `- ${describeDisagreement(d)}`),
  )
  section(
    'API-only restrictions',
    disagreements.filter(d => d.kind === 'api-only').map(d => `- ${describeDisagreement(d)}`),
  )

  lines.push(
    '',
    'A model that only one source knows, or that has no privacy fields upstream, gets no entry, so it is not exposed. ' +
      'Each one below is either a model the page has not caught up with (or the API has not), a name the join could ' +
      'not match, or a model the API listed without its `go` privacy object: if an entry here is a model that is ' +
      'currently exposed, it drops out of the snapshot in this PR.',
  )
  section(
    'Left out of the snapshot',
    unmatched.map(item => `- ${describeUnmatched(item)}`),
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
 * Fetches, parses and compares. Writes the snapshot (and the PR body when `bodyPath` is set, and the release
 * changeset when `changeset` is set) only when a model's privacy terms changed. Any failure throws before the
 * snapshot is written, so the existing snapshot stays untouched.
 */
export async function refreshGoPrivacy({
  snapshotPath = DEFAULT_SNAPSHOT_PATH,
  bodyPath,
  changeset,
  fetch: fetchImpl = globalThis.fetch,
  githubToken,
  now = () => new Date(),
  log = line => process.stdout.write(`${line}\n`),
}: RefreshOptions = {}): Promise<RefreshResult> {
  // First, so a bad identity stops the run before any request or write.
  if (changeset !== undefined) assertRunIdentity(changeset)
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

  const livePayload = await fetchLiveModels(fetchImpl)

  const {models: liveModels, noPrivacy} = parseLiveModels(livePayload)
  // The footnotes the page gives no row are checked against the live list inside `buildSnapshot`.
  const {rows, orphanFootnotes} = parsePrivacyDocsWithOrphans(mdx)
  const {snapshot: next, disagreements, unmatched} = buildSnapshot(rows, liveModels, sha, {noPrivacy, orphanFootnotes})
  if (Object.keys(next.models).length === 0) throw new PrivacyTableError('built zero models')
  // Logged before the change test: a left-out model must show in the workflow log even when no PR opens.
  for (const item of unmatched) log(`left out: ${describeUnmatched(item)}`)

  const diff = diffSnapshots(beforeModels, next.models)
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    return {changed: false, sourceCommit: sha}
  }

  // Real exposure: what the previous snapshot would serve today against the list upstream publishes now.
  const liveIds = [...liveModels.map(model => model.id), ...noPrivacy.map(item => item.id)]
  const today = now().toISOString().slice(0, 10)
  const previouslyEligible = new Set(computeEligibility(previous, liveIds, today).eligible)
  const restricted = restrictedModels(previouslyEligible, next, liveIds, today).length

  if (bodyPath !== undefined) {
    writeAtomic(
      bodyPath,
      renderPrBody(previous.source.commit, next, diff, beforeModels, disagreements, unmatched, previouslyEligible),
    )
  }
  // Before the snapshot, so a failed changeset write leaves the snapshot as it was.
  const content = serializeSnapshot(next)
  let changesetFile: string | undefined
  if (changeset !== undefined) {
    changesetFile = changesetFileName(sha, changeset)
    writeAtomic(resolve(changeset.dir, changesetFile), renderChangeset(sha))
  }
  writeAtomic(snapshotPath, content)
  return changesetFile === undefined
    ? {changed: true, sourceCommit: sha, restricted}
    : {changed: true, sourceCommit: sha, restricted, changesetFile}
}

if (import.meta.main) {
  try {
    const result = await refreshGoPrivacy({
      snapshotPath: process.env.GO_PRIVACY_SNAPSHOT_PATH || undefined,
      bodyPath: process.argv[2] ?? (process.env.GO_PRIVACY_PR_BODY_PATH || undefined),
      changeset: {
        dir: process.env.GO_PRIVACY_CHANGESET_DIR || DEFAULT_CHANGESET_DIR,
        ...runIdentityFromEnv(process.env, new Date()),
      },
      githubToken: process.env.GITHUB_TOKEN || undefined,
    })
    const outputFile = process.env.GITHUB_OUTPUT
    if (outputFile) appendFileSync(outputFile, workflowOutputs(result))
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
