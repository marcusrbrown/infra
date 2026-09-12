#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, non-published Fro Bot daily-report reconciler.
 *
 * This script is invoked only by the daily-equivalent branch of
 * `.github/workflows/fro-bot.yaml` (schedule or truly-empty main dispatch). It
 * owns issue identity, label adoption, supersession comments, closure, and
 * final proof; it never creates or rewrites report prose.
 *
 * Every request goes through an injectable native `fetch` boundary and every
 * response is parsed with Zod. All terminal paths return one body-free
 * machine-readable summary; the `import.meta.main` entrypoint prints it.
 * Tokens, report bodies, comment bodies, and secrets are never logged.
 */

import {z} from 'zod'

// ─── Contract constants ──────────────────────────────────────────────────────

export const API_VERSION = '2026-03-10'
export const LABEL_NAME = 'autoheal-report'
export const BOT_LOGIN = 'fro-bot'
export const MANAGED_MARKER = '<!-- fro-bot:autoheal-report:v1 -->'
export const MANAGED_CANDIDATE_CAP = 100
export const PER_PAGE = 100
export const MAX_PAGES = 50

export const REQUIRED_HEADINGS = [
  '### Errored PRs',
  '### Security',
  '### Code Quality & Repo Hygiene',
  '### Workflow Integrity',
  '### Quality Gates',
  '### Developer Experience',
  '### Deploy Pipeline Health',
  '### Live Site Review',
  '### Cross-Project Intelligence (Inbound)',
  '### Progressive Improvement',
  '### Agent-Ready Notes',
  '### Needs Human Attention',
] as const

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const READ_ATTEMPTS = 2
const PROPAGATION_DELAY_MS = 1_000
const MAX_RATE_LIMIT_WAIT_MS = 60_000

// ─── Pure marker helpers ─────────────────────────────────────────────────────

export function dailyReportTitle(date: string): string {
  return `Daily Autohealing Report — ${date}`
}

export function runMarker(runId: string): string {
  return `<!-- fro-bot:autoheal-run:v1 run-id=${runId} -->`
}

export function supersessionMarker(canonicalIssueNumber: number): string {
  return `<!-- fro-bot:autoheal-supersession:v1 canonical-issue-number=${canonicalIssueNumber} -->`
}

export function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null || linkHeader.trim() === '') return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

export function findMissingHeadings(body: string): string[] {
  const lines = new Set(bodyLines(body))
  return REQUIRED_HEADINGS.filter(heading => !lines.has(heading))
}

function bodyLines(body: string): string[] {
  return body.replaceAll('\r\n', '\n').split('\n')
}

export function parseDailyReportTitle(title: string): string | null {
  const prefix = 'Daily Autohealing Report — '
  if (!title.startsWith(prefix)) return null
  const date = title.slice(prefix.length)
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
}

// ─── Zod response schemas ────────────────────────────────────────────────────

const userSchema = z.object({login: z.string(), id: z.number().int()})
const labelSchema = z.union([z.string(), z.object({name: z.string()})])
const issueRecordSchema = z.object({
  number: z.number().int(),
  id: z.number().int(),
  title: z.string(),
  body: z.string().nullish(),
  state: z.string(),
  html_url: z.string(),
  user: userSchema,
  labels: z.array(labelSchema),
  pull_request: z.unknown().optional(),
})
const commentSchema = z.object({
  id: z.number().int(),
  body: z.string().nullish(),
  user: userSchema,
})

const labelObjectSchema = z.object({name: z.string()})

type IssueRecord = z.infer<typeof issueRecordSchema>
type CommentRecord = z.infer<typeof commentSchema>
type LabelRecord = z.infer<typeof labelObjectSchema>

// ─── Error classification ────────────────────────────────────────────────────

class ReconcilerAbort extends Error {
  readonly code: string
  readonly reason: string

  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`)
    this.name = 'ReconcilerAbort'
    this.code = code
    this.reason = reason
  }
}

class NetworkError extends Error {}

// ─── Public types ────────────────────────────────────────────────────────────

export interface ReconcilerOptions {
  readonly token: string
  readonly repository: string
  readonly date: string
  readonly runId: string
  readonly fetch: FetchLike
  readonly apiBaseUrl?: string
  readonly log?: (message: string) => void
  readonly sleep?: (milliseconds: number) => Promise<void>
}

export interface ReconcilerSummary {
  readonly workflow_run_id: string | null
  readonly canonical_issue_id: number | null
  readonly canonical_issue_number: number | null
  readonly eligible: number
  readonly adopted: number
  readonly commented: number
  readonly closed: number
  readonly untrusted_collisions: number
  readonly final_open_managed: number
  readonly phase: string
  readonly status: 'succeeded' | 'aborted'
  readonly failure_code: string | null
  readonly failure_reason: string | null
}

interface ClassifiedIssue {
  number: number
  id: number
  date: string | null
  managed: boolean
  adoptable: boolean
  untrusted: boolean
  runMarked: boolean
  record: IssueRecord
}

interface DiscoverySnapshot {
  eligible: {number: number; id: number; managed: boolean}[]
  untrusted: {number: number; id: number}[]
}

// ─── Pure classification helpers ─────────────────────────────────────────────

function labelNames(record: IssueRecord): string[] {
  return record.labels.map(label => (typeof label === 'string' ? label : label.name))
}

function isPullRequest(record: IssueRecord): boolean {
  return record.pull_request !== undefined && record.pull_request !== null
}

function classifyIssue(record: IssueRecord, botId: number, activeRunId: string): ClassifiedIssue {
  const date = parseDailyReportTitle(record.title)
  const base: ClassifiedIssue = {
    number: record.number,
    id: record.id,
    date,
    managed: false,
    adoptable: false,
    untrusted: false,
    runMarked: false,
    record,
  }
  if (date === null) return base
  const trustedAuthor = record.user.login === BOT_LOGIN && record.user.id === botId
  const lines = bodyLines(record.body ?? '')
  const hasManagedMarker = lines[0] === MANAGED_MARKER
  const runMarked = lines[1] === runMarker(activeRunId)
  if (!trustedAuthor || !hasManagedMarker) return {...base, untrusted: true}
  const labelled = labelNames(record).includes(LABEL_NAME)
  return {...base, managed: labelled, adoptable: !labelled, runMarked}
}

function buildSnapshot(classified: ClassifiedIssue[]): DiscoverySnapshot {
  return {
    eligible: classified
      .filter(candidate => candidate.managed || candidate.adoptable)
      .map(candidate => ({number: candidate.number, id: candidate.id, managed: candidate.managed}))
      .sort((a, b) => a.number - b.number),
    untrusted: classified
      .filter(candidate => candidate.untrusted)
      .map(candidate => ({number: candidate.number, id: candidate.id}))
      .sort((a, b) => a.number - b.number),
  }
}

function assertTarget(record: IssueRecord, expected: {number: number; id: number}): void {
  if (record.number !== expected.number || record.id !== expected.id) {
    throw new ReconcilerAbort('target_identity_mismatch', `expected issue ${expected.number}/${expected.id}`)
  }
  if (isPullRequest(record)) {
    throw new ReconcilerAbort('target_pull_request', `issue ${record.number} is pull-request-shaped`)
  }
}

function hasSupersessionMarker(comment: CommentRecord, marker: string, botId: number): boolean {
  return comment.user.id === botId && comment.user.login === BOT_LOGIN && bodyLines(comment.body ?? '').includes(marker)
}

function parseLabelPayload(json: unknown, code: string): LabelRecord {
  const parsed = labelObjectSchema.safeParse(json)
  if (!parsed.success || parsed.data.name !== LABEL_NAME) {
    throw new ReconcilerAbort(code, 'label response did not match the canonical name')
  }
  return parsed.data
}

function resolveNextLink(linkHeader: string | null, baseUrl: string, failureCode: string): string | null {
  const candidate = nextLink(linkHeader)
  if (candidate === null) return null
  let resolved: URL
  try {
    resolved = new URL(candidate, baseUrl)
  } catch {
    throw new ReconcilerAbort(failureCode, 'unparseable pagination link')
  }
  if (resolved.origin !== new URL(baseUrl).origin) {
    throw new ReconcilerAbort(failureCode, 'pagination link origin mismatch')
  }
  return resolved.href
}

function rateLimitDelayMs(headers: Headers, now: number): number | null {
  const retryAfter = headers.get('retry-after')
  if (retryAfter !== null && retryAfter.trim() !== '') {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
    const at = Date.parse(retryAfter)
    if (!Number.isNaN(at)) return Math.max(0, at - now)
  }
  const remaining = headers.get('x-ratelimit-remaining')
  const reset = headers.get('x-ratelimit-reset')
  if (remaining === '0' && reset !== null) {
    const resetSeconds = Number(reset)
    if (Number.isFinite(resetSeconds)) return Math.max(0, resetSeconds * 1000 - now)
  }
  return null
}

// ─── Reconciler ──────────────────────────────────────────────────────────────

export async function reconcileAutohealReports(options: ReconcilerOptions): Promise<ReconcilerSummary> {
  const base = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const repository = options.repository
  const date = options.date
  const runId = options.runId
  const fetcher = options.fetch
  const sleep =
    options.sleep ?? ((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)))
  const log = options.log ?? (() => {})

  let phase = 'init'
  const workflowRunId: string | null = runId.length > 0 ? runId : null
  let canonicalIssueId: number | null = null
  let canonicalIssueNumber: number | null = null
  let eligible = 0
  let untrustedCollisions = 0
  let adopted = 0
  let commented = 0
  let closed = 0
  let finalOpenManaged = 0

  const defaultHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'fro-bot-autoheal-reconciler',
  }

  interface RawResponse {
    status: number
    headers: Headers
    json: unknown
  }

  async function request(method: string, urlOrPath: string, body?: unknown): Promise<RawResponse> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : `${base}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`
    const init: RequestInit = {
      method,
      headers: body === undefined ? {...defaultHeaders} : {...defaultHeaders, 'content-type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    }
    let response: Response
    try {
      response = await fetcher(url, init)
    } catch {
      throw new NetworkError('network request failed')
    }
    const text = await response.text().catch(() => '')
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return {status: response.status, headers: response.headers, json}
  }

  async function readWithRetry<T>(schema: z.ZodType<T>, path: string, failureCode = 'readback_failed'): Promise<T> {
    let lastCode = failureCode
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      let result: RawResponse
      try {
        result = await request('GET', path)
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        lastCode = failureCode
        if (attempt + 1 < READ_ATTEMPTS) {
          await sleep(PROPAGATION_DELAY_MS)
          continue
        }
        throw new ReconcilerAbort(failureCode, 'network error during readback')
      }
      if (result.status === 200) {
        const parsed = schema.safeParse(result.json)
        if (parsed.success) return parsed.data
        lastCode = failureCode
      } else if (result.status === 403 || result.status === 429) {
        const delay = rateLimitDelayMs(result.headers, Date.now())
        if (delay === null || delay > MAX_RATE_LIMIT_WAIT_MS) {
          throw new ReconcilerAbort('rate_limit', `status ${result.status} without usable retry guidance`)
        }
        if (attempt + 1 < READ_ATTEMPTS) {
          await sleep(delay)
          continue
        }
        throw new ReconcilerAbort('rate_limit', `status ${result.status} persisted`)
      } else {
        lastCode = failureCode
      }
      if (attempt + 1 < READ_ATTEMPTS) {
        await sleep(PROPAGATION_DELAY_MS)
        continue
      }
    }
    throw new ReconcilerAbort(lastCode, 'readback budget exhausted')
  }

  async function readPageWithRetry(next: string, failureCode: string): Promise<RawResponse> {
    let last = 'no response'
    for (let attempt = 0; attempt < READ_ATTEMPTS; attempt++) {
      let result: RawResponse
      try {
        result = await request('GET', next)
      } catch (error) {
        if (!(error instanceof NetworkError)) throw error
        last = 'network error'
        if (attempt + 1 < READ_ATTEMPTS) {
          await sleep(PROPAGATION_DELAY_MS)
          continue
        }
        throw new ReconcilerAbort(failureCode, 'network error reading page')
      }
      if (result.status === 200) return result
      if (result.status === 403 || result.status === 429) {
        const delay = rateLimitDelayMs(result.headers, Date.now())
        if (delay === null || delay > MAX_RATE_LIMIT_WAIT_MS) {
          throw new ReconcilerAbort(failureCode, `status ${result.status} without usable retry guidance`)
        }
        if (attempt + 1 < READ_ATTEMPTS) {
          await sleep(delay)
          continue
        }
        throw new ReconcilerAbort(failureCode, `status ${result.status} persisted`)
      }
      last = `unexpected status ${result.status}`
      if (attempt + 1 < READ_ATTEMPTS) {
        await sleep(PROPAGATION_DELAY_MS)
        continue
      }
      throw new ReconcilerAbort(failureCode, `unexpected status ${result.status}`)
    }
    throw new ReconcilerAbort(failureCode, last)
  }

  interface MutationPlan {
    readonly preflight?: () => Promise<void>
    readonly send: () => Promise<RawResponse | null>
    readonly prove: () => Promise<boolean>
    readonly networkRetry: boolean
    readonly rateLimitRetry: boolean
    readonly rateLimitedCode: string
    readonly ambiguousCode: string
  }

  async function proveSafely(prove: () => Promise<boolean>): Promise<boolean> {
    try {
      return await prove()
    } catch {
      return false
    }
  }

  /**
   * Applies a single non-GET mutation with bounded 403/429 recovery.
   *
   * A rate-limit response is never retried blindly: it is only ever settled
   * after a postcondition readback. A proven side effect continues without a
   * resend; a proven-absent, retry-safe write may resend exactly once across
   * all paths; and persisting rate limits or ambiguous retries fail closed
   * without a second resend. Network ambiguity keeps its per-class policy.
   */
  async function performMutation(plan: MutationPlan): Promise<RawResponse | 'recovered'> {
    let resends = 0
    // Reassert trust immediately before every write attempt, including retries.
    // A preflight abort propagates and prevents the guarded send.
    const guardedSend = async (): Promise<RawResponse | null> => {
      if (plan.preflight !== undefined) await plan.preflight()
      return plan.send()
    }
    let response = await guardedSend()
    if (response === null) {
      if (await proveSafely(plan.prove)) return 'recovered'
      if (!plan.networkRetry) {
        throw new ReconcilerAbort(plan.ambiguousCode, 'mutation not proven after ambiguous write')
      }
      resends += 1
      response = await guardedSend()
      if (response === null) {
        if (await proveSafely(plan.prove)) return 'recovered'
        throw new ReconcilerAbort(plan.ambiguousCode, 'mutation not proven after retry')
      }
    }

    if (response.status !== 403 && response.status !== 429) return response

    const delay = rateLimitDelayMs(response.headers, Date.now())
    if (delay === null || delay > MAX_RATE_LIMIT_WAIT_MS) {
      throw new ReconcilerAbort(plan.rateLimitedCode, `status ${response.status} without usable retry guidance`)
    }
    await sleep(delay)
    if (await proveSafely(plan.prove)) return 'recovered'
    if (!plan.rateLimitRetry || resends >= 1) {
      throw new ReconcilerAbort(plan.rateLimitedCode, `status ${response.status} not proven after bounded wait`)
    }
    resends += 1
    const retry = await guardedSend()
    if (retry === null) {
      if (await proveSafely(plan.prove)) return 'recovered'
      throw new ReconcilerAbort(plan.ambiguousCode, 'mutation not proven after rate-limit retry')
    }
    if (retry.status === 403 || retry.status === 429) {
      if (await proveSafely(plan.prove)) return 'recovered'
      throw new ReconcilerAbort(plan.rateLimitedCode, `status ${retry.status} persisted after bounded wait`)
    }
    return retry
  }

  async function discoverIssues(): Promise<IssueRecord[]> {
    const collected: IssueRecord[] = []
    let next: string | null = `/repos/${repository}/issues?state=open&per_page=${PER_PAGE}`
    let pageNumber = 0
    while (next !== null) {
      pageNumber += 1
      if (pageNumber > MAX_PAGES) throw new ReconcilerAbort('pagination_incomplete', 'page limit exceeded')
      const failureCode = pageNumber > 1 ? 'pagination_incomplete' : 'discovery_failed'
      const result = await readPageWithRetry(next, failureCode)
      const parsed = z.array(issueRecordSchema).safeParse(result.json)
      if (!parsed.success) throw new ReconcilerAbort(failureCode, 'invalid issue page')
      for (const record of parsed.data) {
        if (!isPullRequest(record)) collected.push(record)
      }
      next = resolveNextLink(result.headers.get('link'), base, 'pagination_origin_mismatch')
    }
    return collected
  }

  function classifyAll(records: IssueRecord[], botId: number): ClassifiedIssue[] {
    return records.map(record => classifyIssue(record, botId, runId))
  }

  async function readTarget(expected: {number: number; id: number}): Promise<IssueRecord> {
    const record = await readWithRetry(issueRecordSchema, `/repos/${repository}/issues/${expected.number}`)
    assertTarget(record, expected)
    return record
  }

  /**
   * Reclassifies a fresh exact-resource read immediately before a write attempt
   * and aborts unless the target still carries the expected trust
   * classification. Reasserts numeric identity/number, non-PR shape, exact
   * title/date, bot actor ID, first-line managed marker, expected run-marker
   * state, and the required managed/adoptable state; a lost classification
   * aborts before any write.
   */
  async function readTrustedTarget(
    candidate: ClassifiedIssue,
    botId: number,
    require: 'managed' | 'adoptable',
  ): Promise<IssueRecord> {
    const record = await readTarget(candidate)
    const fresh = classifyIssue(record, botId, runId)
    const trusted = !fresh.untrusted && fresh.date !== null && fresh.date === candidate.date
    const stateMatches = require === 'managed' ? fresh.managed : fresh.adoptable
    const runMarkerMatches = fresh.runMarked === candidate.runMarked
    if (!trusted || !stateMatches || !runMarkerMatches) {
      throw new ReconcilerAbort('target_untrusted', `issue ${candidate.number} lost ${require} trust before write`)
    }
    return record
  }

  function readLabel(): Promise<LabelRecord> {
    return readWithRetry(labelObjectSchema, `/repos/${repository}/labels/${LABEL_NAME}`, 'label_readback_failed')
  }

  async function ensureLabel(): Promise<void> {
    let probe = await request('GET', `/repos/${repository}/labels/${LABEL_NAME}`)
    if (probe.status === 403 || probe.status === 429) {
      const delay = rateLimitDelayMs(probe.headers, Date.now())
      if (delay !== null && delay <= MAX_RATE_LIMIT_WAIT_MS) {
        await sleep(delay)
        probe = await request('GET', `/repos/${repository}/labels/${LABEL_NAME}`)
      }
    }
    if (probe.status === 200) {
      parseLabelPayload(probe.json, 'label_probe_failed')
      return
    }
    if (probe.status !== 404) throw new ReconcilerAbort('label_probe_failed', `status ${probe.status}`)
    const outcome = await performMutation({
      send: async () => {
        try {
          return await request('POST', `/repos/${repository}/labels`, {
            name: LABEL_NAME,
            color: '0e8a16',
            description: 'Trusted daily autohealing report',
          })
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error
          return null
        }
      },
      prove: async () => (await readLabel()).name === LABEL_NAME,
      networkRetry: false,
      rateLimitRetry: true,
      rateLimitedCode: 'label_create_rate_limited',
      ambiguousCode: 'label_create_ambiguous',
    })
    if (outcome === 'recovered') return
    if (outcome.status < 200 || outcome.status >= 300) {
      throw new ReconcilerAbort('label_create_failed', `unexpected status ${outcome.status}`)
    }
    parseLabelPayload(outcome.json, 'label_create_failed')
    const readback = await readLabel()
    if (readback.name !== LABEL_NAME) {
      throw new ReconcilerAbort('label_readback_failed', 'label name mismatch after create')
    }
  }

  async function adoptLabel(candidate: ClassifiedIssue, botId: number): Promise<void> {
    const outcome = await performMutation({
      preflight: async () => {
        await readTrustedTarget(candidate, botId, 'adoptable')
      },
      send: async () => {
        try {
          return await request('POST', `/repos/${repository}/issues/${candidate.number}/labels`, {
            labels: [LABEL_NAME],
          })
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error
          return null
        }
      },
      prove: async () => labelNames(await readTarget(candidate)).includes(LABEL_NAME),
      networkRetry: true,
      rateLimitRetry: true,
      rateLimitedCode: 'label_apply_rate_limited',
      ambiguousCode: 'label_apply_readback_failed',
    })
    if (outcome !== 'recovered' && (outcome.status < 200 || outcome.status >= 300)) {
      throw new ReconcilerAbort('label_apply_failed', `unexpected status ${outcome.status}`)
    }
    const readback = await readTarget(candidate)
    if (labelNames(readback).includes(LABEL_NAME)) return
    throw new ReconcilerAbort('label_apply_readback_failed', `label not visible on issue ${candidate.number}`)
  }

  async function listComments(issueNumber: number): Promise<CommentRecord[]> {
    const collected: CommentRecord[] = []
    let next: string | null = `/repos/${repository}/issues/${issueNumber}/comments?per_page=${PER_PAGE}`
    let pageNumber = 0
    while (next !== null) {
      pageNumber += 1
      if (pageNumber > MAX_PAGES) throw new ReconcilerAbort('pagination_incomplete', 'comment page limit exceeded')
      const result = await readPageWithRetry(next, 'comment_list_failed')
      const parsed = z.array(commentSchema).safeParse(result.json)
      if (!parsed.success) throw new ReconcilerAbort('comment_list_failed', 'invalid comment page')
      collected.push(...parsed.data)
      next = resolveNextLink(result.headers.get('link'), base, 'pagination_origin_mismatch')
    }
    return collected
  }

  async function findSupersessionMarker(issueNumber: number, marker: string, botId: number): Promise<boolean> {
    const first = await listComments(issueNumber)
    if (first.some(comment => hasSupersessionMarker(comment, marker, botId))) return true
    await sleep(PROPAGATION_DELAY_MS)
    const second = await listComments(issueNumber)
    return second.some(comment => hasSupersessionMarker(comment, marker, botId))
  }

  async function createSupersessionComment(
    candidate: ClassifiedIssue,
    canonicalNumber: number,
    marker: string,
    botId: number,
  ): Promise<CommentRecord | null> {
    const issueNumber = candidate.number
    const body = `Superseded by #${canonicalNumber} — current daily report.\n\n${marker}`
    const outcome = await performMutation({
      preflight: async () => {
        await readTrustedTarget(candidate, botId, 'managed')
      },
      send: async () => {
        try {
          return await request('POST', `/repos/${repository}/issues/${issueNumber}/comments`, {body})
        } catch (error) {
          if (!(error instanceof NetworkError)) throw error
          return null
        }
      },
      prove: () => findSupersessionMarker(issueNumber, marker, botId),
      networkRetry: false,
      rateLimitRetry: true,
      rateLimitedCode: 'comment_create_rate_limited',
      ambiguousCode: 'comment_create_ambiguous',
    })
    if (outcome === 'recovered') return null
    if (outcome.status !== 200 && outcome.status !== 201) {
      throw new ReconcilerAbort('comment_create_failed', `unexpected status ${outcome.status}`)
    }
    const parsed = commentSchema.safeParse(outcome.json)
    if (!parsed.success) throw new ReconcilerAbort('comment_create_failed', 'invalid comment response')
    return parsed.data
  }

  function readComment(commentId: number): Promise<CommentRecord> {
    return readWithRetry(commentSchema, `/repos/${repository}/issues/comments/${commentId}`)
  }

  async function run(): Promise<void> {
    phase = 'auth'
    const userResult = await request('GET', '/user')
    if (userResult.status !== 200) throw new ReconcilerAbort('auth_failed', `status ${userResult.status}`)
    const userParsed = userSchema.safeParse(userResult.json)
    if (!userParsed.success) throw new ReconcilerAbort('auth_response_invalid', 'invalid /user response')
    if (userParsed.data.login !== BOT_LOGIN) {
      throw new ReconcilerAbort('auth_login_mismatch', `authenticated as ${userParsed.data.login}`)
    }
    const botId = userParsed.data.id

    phase = 'label'
    await ensureLabel()

    phase = 'discovery'
    const classified = classifyAll(await discoverIssues(), botId)
    const eligibleList = classified.filter(candidate => candidate.managed || candidate.adoptable)
    if (eligibleList.length > MANAGED_CANDIDATE_CAP) {
      throw new ReconcilerAbort(
        'candidate_cap_exceeded',
        `${eligibleList.length} candidates exceed ${MANAGED_CANDIDATE_CAP}`,
      )
    }
    eligible = eligibleList.length
    untrustedCollisions = classified.filter(candidate => candidate.untrusted).length

    phase = 'validation'
    const current = eligibleList.filter(candidate => candidate.date === date && candidate.runMarked)
    if (current.length === 0) throw new ReconcilerAbort('current_report_missing', 'no current-date run-marked report')
    if (current.length > 1) {
      throw new ReconcilerAbort('current_report_ambiguous', `${current.length} current-date run-marked reports`)
    }
    const canonical = current.at(0)
    if (canonical === undefined) throw new ReconcilerAbort('current_report_missing', 'canonical unavailable')
    canonicalIssueId = canonical.id
    canonicalIssueNumber = canonical.number
    const missing = findMissingHeadings(canonical.record.body ?? '')
    if (missing.length > 0) throw new ReconcilerAbort('heading_missing', `missing headings: ${missing.join(', ')}`)

    phase = 'precommit-revalidation'
    const snapshot = buildSnapshot(classified)
    const freshClassified = classifyAll(await discoverIssues(), botId)
    if (JSON.stringify(snapshot) !== JSON.stringify(buildSnapshot(freshClassified))) {
      throw new ReconcilerAbort('snapshot_diverged', 'candidate set changed before mutation')
    }
    const freshCanonical = freshClassified.find(
      candidate => candidate.id === canonical.id && candidate.number === canonical.number,
    )
    if (
      freshCanonical === undefined ||
      freshCanonical.date !== date ||
      !freshCanonical.runMarked ||
      !(freshCanonical.managed || freshCanonical.adoptable)
    ) {
      throw new ReconcilerAbort('snapshot_diverged', 'canonical identity or run marker changed before mutation')
    }

    phase = 'mutation'
    if (!freshCanonical.managed) {
      await adoptLabel(freshCanonical, botId)
      adopted += 1
    }

    const noncanonical = freshClassified
      .filter(candidate => (candidate.managed || candidate.adoptable) && candidate.number !== canonical.number)
      .sort((a, b) => a.number - b.number)
    for (const target of noncanonical) {
      const record = await readTarget(target)
      if (record.state === 'closed') continue
      if (target.adoptable) {
        await adoptLabel(target, botId)
        adopted += 1
      }
      const marker = supersessionMarker(canonical.number)
      if (!(await findSupersessionMarker(target.number, marker, botId))) {
        const created = await createSupersessionComment(target, canonical.number, marker, botId)
        if (created !== null) {
          const readback = await readComment(created.id)
          if (readback.user.id !== botId || !bodyLines(readback.body ?? '').includes(marker)) {
            throw new ReconcilerAbort('comment_readback_failed', `comment ${created.id} missing marker`)
          }
        }
        commented += 1
      }
      // Trust is reasserted inside performMutation immediately before the close
      // write (and before any retry), requiring the target to remain managed.
      const closeOutcome = await performMutation({
        preflight: async () => {
          await readTrustedTarget(target, botId, 'managed')
        },
        send: async () => {
          try {
            return await request('PATCH', `/repos/${repository}/issues/${target.number}`, {
              state: 'closed',
              state_reason: 'not_planned',
            })
          } catch (error) {
            if (!(error instanceof NetworkError)) throw error
            return null
          }
        },
        prove: async () => (await readTarget(target)).state === 'closed',
        networkRetry: true,
        rateLimitRetry: true,
        rateLimitedCode: 'close_rate_limited',
        ambiguousCode: 'close_ambiguous',
      })
      if (closeOutcome !== 'recovered' && closeOutcome.status !== 200) {
        throw new ReconcilerAbort('close_failed', `unexpected status ${closeOutcome.status}`)
      }
      const closeReadback = await readTarget(target)
      if (closeReadback.state !== 'closed') {
        throw new ReconcilerAbort(
          closeOutcome === 'recovered' ? 'close_ambiguous' : 'close_readback_failed',
          `issue ${target.number} still ${closeReadback.state}`,
        )
      }
      closed += 1
    }

    phase = 'final-proof'
    const finalClassified = classifyAll(await discoverIssues(), botId)
    const finalEligible = finalClassified.filter(candidate => candidate.managed || candidate.adoptable)
    finalOpenManaged = finalEligible.length
    if (finalEligible.length !== 1) {
      throw new ReconcilerAbort('final_proof_failed', `${finalEligible.length} open managed reports remain`)
    }
    const finalCanonical = finalEligible.at(0)
    if (
      finalCanonical === undefined ||
      finalCanonical.id !== canonical.id ||
      finalCanonical.number !== canonical.number ||
      finalCanonical.date !== date ||
      !finalCanonical.runMarked ||
      !finalCanonical.managed
    ) {
      throw new ReconcilerAbort('final_proof_failed', 'final canonical identity mismatch')
    }
    if (findMissingHeadings(finalCanonical.record.body ?? '').length > 0) {
      throw new ReconcilerAbort('final_proof_failed', 'final heading contract mismatch')
    }
    const finalUntrusted = buildSnapshot(finalClassified).untrusted
    if (JSON.stringify(finalUntrusted) !== JSON.stringify(snapshot.untrusted)) {
      throw new ReconcilerAbort('final_proof_failed', 'untrusted collisions changed')
    }
    phase = 'complete'
  }

  try {
    await run()
    log(`autoheal reconcile succeeded: eligible=${eligible} adopted=${adopted} commented=${commented} closed=${closed}`)
    return {
      workflow_run_id: workflowRunId,
      canonical_issue_id: canonicalIssueId,
      canonical_issue_number: canonicalIssueNumber,
      eligible,
      adopted,
      commented,
      closed,
      untrusted_collisions: untrustedCollisions,
      final_open_managed: finalOpenManaged,
      phase,
      status: 'succeeded',
      failure_code: null,
      failure_reason: null,
    }
  } catch (error) {
    const code = error instanceof ReconcilerAbort ? error.code : 'internal_error'
    const reason = error instanceof ReconcilerAbort ? error.reason : 'unexpected failure'
    log(`autoheal reconcile aborted in phase ${phase}: ${code}`)
    return {
      workflow_run_id: workflowRunId,
      canonical_issue_id: canonicalIssueId,
      canonical_issue_number: canonicalIssueNumber,
      eligible,
      adopted,
      commented,
      closed,
      untrusted_collisions: untrustedCollisions,
      final_open_managed: finalOpenManaged,
      phase,
      status: 'aborted',
      failure_code: code,
      failure_reason: reason,
    }
  }
}

// ─── Environment + entrypoint ────────────────────────────────────────────────

export interface ReconcilerEnv {
  token: string
  repository: string
  date: string
  runId: string
}

export function readReconcilerEnv(environment: Record<string, string | undefined>): ReconcilerEnv | null {
  const token = environment.GH_TOKEN
  const repository = environment.GITHUB_REPOSITORY
  const date = environment.AUTOHEAL_DATE
  const runId = environment.AUTOHEAL_RUN_ID
  if (
    token === undefined ||
    repository === undefined ||
    date === undefined ||
    runId === undefined ||
    token === '' ||
    repository === '' ||
    date === '' ||
    runId === ''
  ) {
    return null
  }
  return {token, repository, date, runId}
}

export function summaryLine(summary: ReconcilerSummary): string {
  return JSON.stringify(summary)
}

function abortedSummary(runId: string | null, code: string, reason: string): ReconcilerSummary {
  return {
    workflow_run_id: runId,
    canonical_issue_id: null,
    canonical_issue_number: null,
    eligible: 0,
    adopted: 0,
    commented: 0,
    closed: 0,
    untrusted_collisions: 0,
    final_open_managed: 0,
    phase: 'init',
    status: 'aborted',
    failure_code: code,
    failure_reason: reason,
  }
}

async function main(): Promise<void> {
  const env = readReconcilerEnv(process.env)
  if (env === null) {
    const summary = abortedSummary(
      process.env.AUTOHEAL_RUN_ID ?? null,
      'missing_env',
      'required environment input is missing',
    )
    process.stdout.write(`${summaryLine(summary)}\n`)
    process.exitCode = 1
    return
  }
  const summary = await reconcileAutohealReports({...env, fetch: globalThis.fetch.bind(globalThis)})
  process.stdout.write(`${summaryLine(summary)}\n`)
  process.exitCode = summary.status === 'succeeded' ? 0 : 1
}

if (import.meta.main) {
  await main()
}
