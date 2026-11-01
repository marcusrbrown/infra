import type {ProviderAuthReason, ProviderAuthState} from '../commands/cliproxy/status'
import type {FetchLike, GitHubReadOptions} from './github-api'
import type {Observation} from './observation'
import {z} from 'zod'

import {notMeasured, observe} from './collect'
import {GITHUB_REPOSITORY, githubGetJson, githubGetLogText, hasToken} from './github-api'

/**
 * End-to-end state for cliproxy, read from the auth monitor's own probe line.
 *
 * The monitor prints `CLIProxy auth monitor probe: probe=<state> reason=<slug> at <ISO>` right after its
 * probe resolves (before issue or Discord reconciliation), so a dead route stays readable from a failed run.
 * This reader takes the newest `schedule`-event run on `main` (dispatches, which include synthetic runs, are
 * excluded by the API filter and re-checked on the response), reads its single job log and parses exactly one
 * such line. It copies `probe`, `reason` and `at` only, never log text, issue fields, URLs or Discord fields.
 *
 * Fail-closed: anything it cannot positively parse is `unknown` with a slug reason, never `pass`.
 */

export const MONITOR_OBSERVATION_ID = 'provider-route'
export const MONITOR_WORKFLOW_FILE = 'cliproxy-auth-monitor.yaml'
export const PROBE_LINE_PREFIX = 'CLIProxy auth monitor probe:'

/**
 * Call budget for one read: the run list, the job list and the log request are 3 API calls. The log request
 * answers with a redirect to a signed storage URL, which is the second half of the same call. An empty log is
 * retried once (the log request again), so the ceiling is 3 + 1 API calls.
 */
export const MONITOR_API_CALL_BUDGET = 3
export const MONITOR_LOG_RETRY_BUDGET = 1
/** A probe older than this at read time is `stale`: the monitor runs every 15 minutes. */
export const MONITOR_STALE_AFTER_MS = 45 * 60_000
/** Clock-skew allowance for a probe time ahead of the read time. */
const MAX_FUTURE_SKEW_MS = 5 * 60_000

const SPEC = {id: MONITOR_OBSERVATION_ID, kind: 'end-to-end', source: 'monitor'} as const

/**
 * Every reason the cliproxy classifier emits and the one state it belongs to. Keyed on the reason union, so
 * adding a reason to `ProviderAuthReason` fails type-check here until it is classified.
 */
export const PROBE_REASON_STATE: Record<ProviderAuthReason, ProviderAuthState> = {
  ok: 'healthy',
  'auth-401': 'dead',
  'auth-unavailable-503': 'dead',
  'provider-missing': 'dead',
  'unrelated-http': 'unknown',
  timeout: 'unknown',
  network: 'unknown',
}

const runsSchema = z.object({
  workflow_runs: z.array(
    z.object({
      id: z.number().int().positive(),
      event: z.string(),
      head_branch: z.string().nullable(),
      status: z.string(),
    }),
  ),
})
const jobsSchema = z.object({jobs: z.array(z.object({id: z.number().int().positive()}))})
const isoSchema = z.iso.datetime()

export type ProbeParse =
  | {kind: 'probe'; state: ProviderAuthState; reason: ProviderAuthReason; at: string}
  | {kind: 'none'}
  | {kind: 'multiple'}
  | {kind: 'malformed'}

const RUNNER_PREFIX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z /
const PROBE_LINE = /^CLIProxy auth monitor probe: probe=([a-z]+) reason=([a-z0-9-]+) at (\S+)$/

function isReason(value: string): value is ProviderAuthReason {
  return Object.keys(PROBE_REASON_STATE).includes(value)
}

/** Strict parse of the one probe line in a job log. Pure; exported for tests. */
export function parseProbeLine(log: string): ProbeParse {
  const lines = log
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map(line => line.replace(/\r$/, '').replace(RUNNER_PREFIX, ''))
    .filter(line => line.startsWith(PROBE_LINE_PREFIX))

  if (lines.length === 0) return {kind: 'none'}
  if (lines.length > 1) return {kind: 'multiple'}

  const match = PROBE_LINE.exec(lines[0] ?? '')
  if (match === null) return {kind: 'malformed'}

  const [, state, reason, at] = match
  if (state === undefined || reason === undefined || at === undefined) return {kind: 'malformed'}
  if (!isReason(reason) || PROBE_REASON_STATE[reason] !== state || !isoSchema.safeParse(at).success) {
    return {kind: 'malformed'}
  }

  return {kind: 'probe', state: PROBE_REASON_STATE[reason], reason, at}
}

function unknown(reason: string, now: Date): Observation {
  return observe(SPEC, 'unknown', {detail: {reason}, now})
}

/** Read the single job log, retrying once when it comes back empty. */
async function readLog(
  fetchFn: FetchLike,
  token: string,
  jobId: number,
): Promise<{kind: 'log'; text: string} | {kind: 'empty'} | {kind: 'error'}> {
  for (let attempt = 0; attempt <= MONITOR_LOG_RETRY_BUDGET; attempt += 1) {
    const log = await githubGetLogText(fetchFn, token, `/repos/${GITHUB_REPOSITORY}/actions/jobs/${jobId}/logs`)
    if (!log.ok) return {kind: 'error'}
    if (log.data.trim() !== '') return {kind: 'log', text: log.data}
  }

  return {kind: 'empty'}
}

/** The cliproxy `provider-route` observation. Without a token nothing is requested: `not_measured`. */
export async function readMonitorState(options: GitHubReadOptions): Promise<Observation> {
  const now = options.now ?? new Date()
  const {token} = options
  if (!hasToken(token)) return notMeasured(SPEC, 'missing-config')

  const fetchFn: FetchLike = options.fetch ?? fetch

  const runs = await githubGetJson(
    fetchFn,
    token,
    `/repos/${GITHUB_REPOSITORY}/actions/workflows/${MONITOR_WORKFLOW_FILE}/runs?event=schedule&branch=main&per_page=1`,
    runsSchema,
  )
  if (!runs.ok) return unknown('api-error', now)

  const run = runs.data.workflow_runs[0]
  // Re-check what the API filter promised: a synthetic or off-branch run must never decide the route state.
  if (run === undefined || run.event !== 'schedule' || run.head_branch !== 'main') return unknown('no-run', now)
  if (run.status !== 'completed') return unknown('running', now)

  const jobs = await githubGetJson(
    fetchFn,
    token,
    `/repos/${GITHUB_REPOSITORY}/actions/runs/${run.id}/jobs?per_page=2`,
    jobsSchema,
  )
  if (!jobs.ok) return unknown('api-error', now)
  const [job, ...extra] = jobs.data.jobs
  if (job === undefined || extra.length > 0) return unknown('job-missing', now)

  const log = await readLog(fetchFn, token, job.id)
  if (log.kind === 'error') return unknown('api-error', now)
  if (log.kind === 'empty') return unknown('log-empty', now)

  const parsed = parseProbeLine(log.text)
  switch (parsed.kind) {
    case 'none':
      return unknown('no-probe-line', now)
    case 'multiple':
      return unknown('multiple-probe-lines', now)
    case 'malformed':
      return unknown('malformed-probe-line', now)
    case 'probe':
      break
  }

  const age = now.getTime() - Date.parse(parsed.at)
  if (age < -MAX_FUTURE_SKEW_MS) return unknown('malformed-probe-line', now)
  if (age > MONITOR_STALE_AFTER_MS) {
    return observe(SPEC, 'unknown', {detail: {reason: 'stale', probeAt: parsed.at}, now})
  }

  const result = parsed.state === 'healthy' ? 'pass' : parsed.state === 'dead' ? 'fail' : 'unknown'
  return observe(SPEC, result, {detail: {reason: parsed.reason, probeAt: parsed.at}, now})
}
