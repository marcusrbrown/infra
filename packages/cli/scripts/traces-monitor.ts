#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, non-published monitor for the trace collection stack.
 *
 * Run by `.github/workflows/traces-monitor.yaml` every 15 minutes. Three commands, one per workflow step:
 *
 * - `probe`   The `probe` job. One unauthenticated `GET https://<TRACES_DOMAIN>/healthz`, one look at the served
 *             certificate and one unauthenticated `POST` of `{}` to the ingest path (no redirect followed, short
 *             timeouts). Exits 1 when the stack is unhealthy, so the job's own conclusion is the run's verdict. No secret,
 *             no SSH, no Environment.
 * - `issue`   The `alert` job, first step. Reads the probe job's result and keeps ONE open issue per outage. Holds the
 *             read-only-plus-issues workflow token and no webhook. Writes the step outputs `notify`
 *             (`created` | `recovered` | `none`) and `issue-number`.
 * - `notify`  The `alert` job, second step. Posts ONE Discord message when `notify` is `created` or `recovered`.
 *             Holds the webhook and no token. Always exits 0.
 *
 * What counts as healthy: the endpoint answers 200 within the timeout with a small JSON body
 * `{"ok": true, "at": "<ISO 8601>"}` (extra fields are ignored; the boolean and the timestamp are required),
 * the timestamp is at most 10 minutes old (the reporter recomputes on a timer, so a frozen reporter cannot read as
 * healthy), and the certificate has at least 14 days left. Anything else is unhealthy: 503, any other status, a
 * redirect, a timeout, a TLS error, an unparsable body.
 *
 * The ingest state. The repository variable `TRACES_INGEST_OPEN` says whether ingest is meant to be open: exactly `true`
 * means open; unset or anything else means not open. The probe POSTs `{}` to `/workstation/v1/traces` with no
 * Authorization header and no redirect. Open: 401 is healthy, anything else (a held 503, an off 404, a 200, a timeout)
 * is unhealthy by the two-runs rule below. Not open: 404 or 503 is healthy; 401 or any 2xx means the route is open when
 * it should not be, and ALERTS AT ONCE, without waiting for a second run (the probe's `urgent` output); any other answer
 * is unhealthy by the two-runs rule. An at-once alert needs no history lookup. If an issue is already open (an ordinary
 * outage, or an earlier urgent run), no second issue is opened: the first urgent run appends ONE line to the open
 * issue's body (a later run finds the line and writes nothing), so the condition is announced once, not every 15
 * minutes. Alert text names the failing conditions by a fixed category word only (`health`, `certificate`, `ingest`).
 *
 * Flap control: an alert needs TWO unhealthy runs in a row. Workflows have no memory, so "the previous run" is this
 * workflow's own last completed run, read through the read-only workflow token (`actions: read`): the conclusion of its
 * `probe` JOB, not of the run, so a broken alert step cannot read as an unhealthy probe. A run whose probe was skipped
 * (a rehearsal) or has no conclusion is stepped over; a previous run older than an hour is not consecutive. Recovery
 * closes the issue on the first healthy run. A marker comment on the alert issue could not hold the first strike,
 * because no issue exists until the second.
 *
 * Not deployed yet: when `TRACES_DOMAIN` is unset the probe job exits green with a notice, and the alert job does
 * nothing. The workflow merges before the host exists and must not alert every 15 minutes until then.
 *
 * Safety contract:
 * - ZERO package imports (`node:tls`, `node:fs`, the sibling `alert-issue.ts` and `deploy-gate-notify.ts`): the jobs
 *   run after checkout + setup-bun WITHOUT `bun install`.
 * - Nothing from the endpoint reaches a log, an issue or Discord: no body, no header, no error text. Failures are fixed
 *   reason codes. Issue and message text is fixed strings plus the run link and the runbook path.
 * - A re-run (`github.run_attempt` above 1) makes no API call: it would replay an old probe result.
 *
 * Environment inputs (names are this script's contract):
 * - `TRACES_DOMAIN`                 `probe`: the hostname (repository variable; documented value `traces.fro.bot`).
 * - `TRACES_INGEST_OPEN`            `probe`: repository variable; exactly `true` means ingest is meant to be open.
 * - `ALERT_PROBE_RESULT`            `issue`, `notify`: `needs.probe.result` (`success|failure|cancelled|skipped`).
 * - `ALERT_PROBE_DEPLOYED`          `issue`, `notify`: `needs.probe.outputs.deployed` (`true|false`, empty if unset).
 * - `ALERT_PROBE_URGENT`            `issue`, `notify`: `needs.probe.outputs.urgent` (`true|false`, empty if unset).
 * - `ALERT_PROBE_CATEGORIES`        `issue`, `notify`: `needs.probe.outputs.categories` (comma list of fixed words).
 * - `ALERT_REHEARSE`                `none` | `fail` | `clear`; empty (a scheduled run) reads as `none`.
 * - `ALERT_RUN_ATTEMPT`             `issue`: `github.run_attempt`. Anything but exactly `1` is a re-run.
 * - `ALERT_NOTIFY`, `ALERT_ISSUE_NUMBER`   `notify`: the issue step's outputs.
 * - `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK` `notify` only. Missing or blank => skipped.
 * - `GH_TOKEN`                      `issue` only, consumed by `gh`.
 * - `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
 *   `GITHUB_REPOSITORY_OWNER`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`: set by the runner.
 */

import type {FetchLike} from './deploy-gate-notify'
import tls from 'node:tls'
import {
  AlertFailure,
  appendTo,
  blobUrl,
  ghCall,
  isRecord,
  issueUrl,
  oneOf,
  parseAttempt,
  parseJsonRecord,
  printLine,
  readRehearse,
  readRunContext,
  realIssueDeps,
  realNotifyDeps,
  reconcileAlertIssue,
  rehearsalPlan,
  runDiscordStepWith,
  runIssueStepWith,
  runUrl,
  type AlertSpec,
  type Attempt,
  type GhRunner,
  type Identity,
  type IssueContent,
  type IssueOutcome,
  type IssueStepDeps,
  type NotifyStepDeps,
  type NotifySummary,
  type Plan,
  type Rehearse,
  type RunContext,
} from './alert-issue'

// ─── Contract constants ──────────────────────────────────────────────────────

export const ALERT_LABEL = 'traces-unhealthy'
export const REAL_MARKER = '<!-- traces-monitor-alert:v1 -->'
export const REHEARSAL_MARKER = '<!-- traces-monitor-alert-rehearsal:v1 -->'

/** The file name of `.github/workflows/traces-monitor.yaml`, used to read this workflow's own run history. */
export const WORKFLOW_FILE = 'traces-monitor.yaml'
/** The `name:` of the probe job. The previous-run lookup reads the conclusion of the job with this name. */
export const PROBE_JOB_NAME = 'Probe trace collection'

/** The reporter recomputes on a timer; a timestamp older than this is a frozen reporter, not a healthy one. */
export const HEALTH_MAX_AGE_MS = 10 * 60 * 1000
/** A timestamp this far ahead of the runner clock is not believable. */
export const HEALTH_MAX_FUTURE_MS = 2 * 60 * 1000
export const CERT_MIN_DAYS = 14
/** A previous run older than this is not "the run before this one": scheduled runs are 15 minutes apart. */
export const PREVIOUS_RUN_MAX_AGE_MS = 60 * 60 * 1000

const HEALTH_TIMEOUT_MS = 10_000
const CERT_TIMEOUT_MS = 10_000
/** One sender group's ingest path. A request without a token reaches the route Caddy keeps for that group. */
export const INGEST_PATH = '/workstation/v1/traces'

const HEALTH_BODY_MAX_CHARS = 4096
const DAY_MS = 24 * 60 * 60 * 1000
const PREVIOUS_RUN_CANDIDATES = 5

const LABEL_COLOR = 'b60205'
const LABEL_DESCRIPTION = 'Trace collection stack health monitor'
const REAL_TITLE = 'Trace collection stack is unhealthy'
const REHEARSAL_TITLE = '[Rehearsal] Trace collection stack alert'
const RUNBOOK_PATH = 'docs/runbooks/trace-collection.md'
const ALERT_NAME = 'Trace collection alert'
const REHEARSAL_RESULT_NOTE = 'rehearsal; no probe ran'

const PROBE_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const
const DEPLOYED_VALUES = ['true', 'false', ''] as const
const URGENT_VALUES = ['true', 'false', ''] as const
/** The three conditions the probe checks, named in alert text by these words and nothing else. */
const CATEGORIES = ['health', 'certificate', 'ingest'] as const

export type ProbeResult = (typeof PROBE_RESULTS)[number]
export type Verdict = 'healthy' | 'unhealthy' | 'not-deployed' | 'skipped'
export type PreviousRun = 'healthy' | 'unhealthy' | 'unknown'
export type Category = (typeof CATEGORIES)[number]

/** Fixed reason codes for a failed check. Never error text, never anything the endpoint said. */
export type Reason =
  | 'invalid-domain'
  | 'healthz-timeout'
  | 'healthz-network'
  | 'healthz-503'
  | 'healthz-status'
  | 'healthz-body'
  | 'healthz-unhealthy'
  | 'healthz-stale'
  | 'cert-unreadable'
  | 'cert-expiring'
  | 'ingest-timeout'
  | 'ingest-network'
  | 'ingest-unexpected-status'
  | 'ingest-open-unexpected'

export function categoryOf(reason: Reason): Category {
  if (reason.startsWith('cert-')) return 'certificate'
  if (reason.startsWith('ingest-')) return 'ingest'
  return 'health'
}

const SPEC: AlertSpec = {
  label: ALERT_LABEL,
  labelColor: LABEL_COLOR,
  labelDescription: LABEL_DESCRIPTION,
  markers: {real: REAL_MARKER, rehearsal: REHEARSAL_MARKER},
  titles: {real: REAL_TITLE, rehearsal: REHEARSAL_TITLE},
  // The monitor runs every 15 minutes: an outage comments once, on recovery, not 96 times a day.
  commentOnRepeat: false,
}

// ─── Probe ───────────────────────────────────────────────────────────────────

export interface ProbeDeps {
  readonly fetch: FetchLike
  /** Resolves to the `notAfter` of the certificate the host serves. Rejects when no valid certificate is served. */
  readonly readCertificateExpiry: (host: string) => Promise<Date>
  readonly now: () => Date
  readonly writeOutput: (name: string, value: string) => void
  readonly log: (line: string) => void
  readonly appendSummary: (line: string) => void
  readonly timeoutMs?: number
}

const HOST_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

/** A lowercase DNS name with at least one dot. Anything else is refused before it reaches a URL. */
export function isValidDomain(value: string): boolean {
  return value.length <= 253 && HOST_PATTERN.test(value)
}

/** Checks the health body. The body is parsed, never echoed: the result is a fixed reason or `null`. */
export function checkHealthBody(text: string, now: Date): Reason | null {
  if (text.length > HEALTH_BODY_MAX_CHARS) return 'healthz-body'
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return 'healthz-body'
  }
  if (!isRecord(parsed) || typeof parsed.ok !== 'boolean') return 'healthz-body'
  const stamp = parsed.at
  if (typeof stamp !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(stamp)) return 'healthz-body'
  const checkedAt = Date.parse(stamp)
  if (Number.isNaN(checkedAt)) return 'healthz-body'
  const age = now.getTime() - checkedAt
  if (age < -HEALTH_MAX_FUTURE_MS) return 'healthz-body'
  if (age > HEALTH_MAX_AGE_MS) return 'healthz-stale'
  return parsed.ok ? null : 'healthz-unhealthy'
}

async function checkHealth(host: string, deps: ProbeDeps): Promise<Reason | null> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HEALTH_TIMEOUT_MS)
  try {
    // `redirect: 'manual'`: a redirect is an unexpected answer, not something to follow to another host.
    const response = await deps.fetch(`https://${host}/healthz`, {
      method: 'GET',
      redirect: 'manual',
      headers: {accept: 'application/json'},
      signal: controller.signal,
    })
    if (response.status === 503) return 'healthz-503'
    if (response.status !== 200) return 'healthz-status'
    return checkHealthBody(await response.text(), deps.now())
  } catch {
    // Never surface error text: runtime fetch errors can embed the request URL.
    return controller.signal.aborted ? 'healthz-timeout' : 'healthz-network'
  } finally {
    clearTimeout(timer)
  }
}

async function checkCertificate(host: string, deps: ProbeDeps): Promise<Reason | null> {
  let expiry: Date
  try {
    expiry = await deps.readCertificateExpiry(host)
  } catch {
    return 'cert-unreadable'
  }
  if (Number.isNaN(expiry.getTime())) return 'cert-unreadable'
  return expiry.getTime() - deps.now().getTime() < CERT_MIN_DAYS * DAY_MS ? 'cert-expiring' : null
}

/**
 * One unauthenticated POST of an empty JSON body to a sender group's ingest path, no redirect followed. What it should
 * answer depends on whether ingest is meant to be open:
 * - open: 401 (the collector refuses a request with no token). Anything else, a held 503, a 404 for an off route, a 200,
 *   a timeout, is unhealthy and follows the two-runs rule.
 * - not open: 404 (off) or 503 (held). A 401 or any 2xx means the route is open when it should not be, which is urgent:
 *   `urgent` is true and the alert does not wait for a second run. Any other answer is unhealthy by the two-runs rule.
 * The request carries no Authorization header, and the response body is never read.
 */
async function checkIngest(
  host: string,
  open: boolean,
  deps: ProbeDeps,
): Promise<{readonly reason: Reason | null; readonly urgent: boolean}> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? HEALTH_TIMEOUT_MS)
  try {
    const response = await deps.fetch(`https://${host}${INGEST_PATH}`, {
      method: 'POST',
      redirect: 'manual',
      headers: {'content-type': 'application/json'},
      body: '{}',
      signal: controller.signal,
    })
    await response.body?.cancel()
    const {status} = response
    if (open) return {reason: status === 401 ? null : 'ingest-unexpected-status', urgent: false}
    if (status === 404 || status === 503) return {reason: null, urgent: false}
    if (status === 401 || (status >= 200 && status < 300)) return {reason: 'ingest-open-unexpected', urgent: true}
    return {reason: 'ingest-unexpected-status', urgent: false}
  } catch {
    // Never surface error text: runtime fetch errors can embed the request URL.
    return {reason: controller.signal.aborted ? 'ingest-timeout' : 'ingest-network', urgent: false}
  } finally {
    clearTimeout(timer)
  }
}

export interface ProbeOutcome {
  readonly exitCode: 0 | 1
  readonly verdict: 'healthy' | 'unhealthy' | 'not-deployed'
  readonly reasons: Reason[]
  /** The ingest route answered a request without a token when ingest is not meant to be open. */
  readonly urgent: boolean
  readonly categories: Category[]
}

/** Never throws. Exit 1 means unhealthy (or a bad hostname); the probe job's conclusion is the run's verdict. */
export async function runProbe(
  environment: Readonly<Record<string, string | undefined>>,
  deps: ProbeDeps,
): Promise<ProbeOutcome> {
  const host = environment.TRACES_DOMAIN?.trim() ?? ''
  const finish = (outcome: Omit<ProbeOutcome, 'categories'>): ProbeOutcome => {
    const categories = CATEGORIES.filter(category => outcome.reasons.some(reason => categoryOf(reason) === category))
    deps.writeOutput('urgent', outcome.urgent ? 'true' : 'false')
    deps.writeOutput('categories', categories.join(','))
    return {...outcome, categories}
  }

  if (host === '') {
    deps.writeOutput('deployed', 'false')
    deps.log(
      '::notice::TRACES_DOMAIN is not set, so the trace collection stack is treated as not deployed yet. Nothing was probed.',
    )
    deps.appendSummary('- Trace collection probe: not deployed yet (TRACES_DOMAIN is not set)')
    return finish({exitCode: 0, verdict: 'not-deployed', reasons: [], urgent: false})
  }
  deps.writeOutput('deployed', 'true')
  if (!isValidDomain(host)) {
    deps.log('::error::Trace collection probe unhealthy: invalid-domain')
    deps.appendSummary('- Trace collection probe: unhealthy (invalid-domain)')
    return finish({exitCode: 1, verdict: 'unhealthy', reasons: ['invalid-domain'], urgent: false})
  }

  // Only the exact value `true` means open; unset, empty or anything else means not open.
  const ingestOpen = environment.TRACES_INGEST_OPEN?.trim() === 'true'
  const [health, certificate, ingest] = await Promise.all([
    checkHealth(host, deps),
    checkCertificate(host, deps),
    checkIngest(host, ingestOpen, deps),
  ])
  const reasons = [health, certificate, ingest.reason].filter((reason): reason is Reason => reason !== null)
  if (reasons.length === 0) {
    deps.appendSummary('- Trace collection probe: healthy')
    return finish({exitCode: 0, verdict: 'healthy', reasons, urgent: false})
  }
  deps.log(`::error::Trace collection probe unhealthy: ${reasons.join(', ')}${ingest.urgent ? ' (urgent)' : ''}`)
  deps.appendSummary(
    `- Trace collection probe: unhealthy (${reasons.join(', ')})${ingest.urgent ? ' (alert at once)' : ''}`,
  )
  return finish({exitCode: 1, verdict: 'unhealthy', reasons, urgent: ingest.urgent})
}

/** Reads the `notAfter` of the certificate `host` serves on 443. A certificate the runner does not trust rejects. */
export function readCertificateExpiry(host: string): Promise<Date> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({host, port: 443, servername: host, rejectUnauthorized: true}, () => {
      const validTo = socket.getPeerCertificate().valid_to
      socket.end()
      const expiry = new Date(validTo)
      if (Number.isNaN(expiry.getTime())) reject(new Error('unreadable'))
      else resolve(expiry)
    })
    socket.setTimeout(CERT_TIMEOUT_MS, () => {
      socket.destroy()
      reject(new Error('timeout'))
    })
    socket.on('error', reject)
  })
}

// ─── Environment ─────────────────────────────────────────────────────────────

export interface MonitorEnv extends RunContext {
  readonly probeResult: ProbeResult
  readonly deployed: (typeof DEPLOYED_VALUES)[number]
  /** The probe saw the ingest route open when it should not be: alert at once. Only read for an unhealthy probe. */
  readonly urgent: boolean
  /** The conditions that failed, from the probe's job output. Empty when the probe did not report any. */
  readonly categories: readonly Category[]
  readonly rehearse: Rehearse
  readonly attempt: Attempt
}

function readCategories(value: string): Category[] {
  if (value === '') return []
  return value.split(',').map(word => oneOf(CATEGORIES, word, 'invalid-probe-categories'))
}

export function readMonitorEnv(environment: Readonly<Record<string, string | undefined>>): MonitorEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''
  return {
    ...readRunContext(environment),
    probeResult: oneOf(PROBE_RESULTS, read('ALERT_PROBE_RESULT'), 'invalid-probe-result'),
    deployed: oneOf(DEPLOYED_VALUES, read('ALERT_PROBE_DEPLOYED'), 'invalid-probe-deployed'),
    urgent: oneOf(URGENT_VALUES, read('ALERT_PROBE_URGENT'), 'invalid-probe-urgent') === 'true',
    categories: readCategories(read('ALERT_PROBE_CATEGORIES')),
    rehearse: readRehearse(environment.ALERT_REHEARSE),
    attempt: parseAttempt(read('ALERT_RUN_ATTEMPT')),
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

/**
 * What the probe job reported. `failure` and `cancelled` are unhealthy: GitHub reports a job killed by
 * `timeout-minutes` as `cancelled`, and a probe that never finished is not a healthy one. A green probe says whether
 * it probed anything: `deployed=false` is the stack not existing yet, which is neither healthy nor unhealthy. A green
 * probe without that output is a wiring fault and fails the alert step rather than being guessed at.
 */
export function verdictOf(env: Pick<MonitorEnv, 'probeResult' | 'deployed'>): Verdict {
  switch (env.probeResult) {
    case 'failure':
    case 'cancelled':
      return 'unhealthy'
    case 'skipped':
      return 'skipped'
    case 'success':
      if (env.deployed === 'true') return 'healthy'
      if (env.deployed === 'false') return 'not-deployed'
      throw new AlertFailure('invalid-probe-deployed')
  }
}

/**
 * The plan for one run. A rehearsal ignores the probe and uses its own identity. Healthy clears. Unhealthy alerts only
 * when the run before this one was unhealthy too; a first strike does nothing. An urgent unhealthy run (the ingest route
 * open when it should not be) alerts at once, with no second run. Not deployed and skipped do nothing: an open issue is
 * left as it is.
 */
export function planMonitor(
  input: {readonly verdict: Verdict; readonly rehearse: Rehearse; readonly urgent?: boolean},
  previous: PreviousRun,
): Plan {
  const rehearsal = rehearsalPlan(input.rehearse)
  if (rehearsal !== null) return rehearsal
  switch (input.verdict) {
    case 'healthy':
      return {kind: 'clear', identity: 'real'}
    case 'unhealthy':
      return input.urgent === true || previous === 'unhealthy' ? {kind: 'alert', identity: 'real'} : {kind: 'none'}
    case 'not-deployed':
    case 'skipped':
      return {kind: 'none'}
  }
}

// ─── Previous run ────────────────────────────────────────────────────────────

function conclusionToHealth(conclusion: unknown): PreviousRun | null {
  if (conclusion === 'success') return 'healthy'
  if (conclusion === 'failure' || conclusion === 'cancelled' || conclusion === 'timed_out') return 'unhealthy'
  // skipped (a rehearsal), neutral, null (still running) and anything new: this run says nothing about health.
  return null
}

/**
 * The health of the most recent completed run before this one that actually probed, from the conclusion of its
 * `probe` job. `unknown` when there is none, when it is more than an hour old, or when the history holds nothing
 * decisive. Any API failure fails the step, so a broken lookup is a red run, not a silent "healthy".
 */
export async function lookupPreviousRun(context: RunContext, gh: GhRunner, now: Date): Promise<PreviousRun> {
  const currentId = Number(context.runId)
  const listing = parseJsonRecord(
    await ghCall(gh, 'list-runs', [
      'api',
      `repos/${context.repository}/actions/workflows/${WORKFLOW_FILE}/runs?status=completed&branch=main&per_page=10`,
    ]),
    'list-runs',
  )
  const runs = Array.isArray(listing.workflow_runs) ? (listing.workflow_runs as unknown[]) : null
  if (runs === null) throw new AlertFailure('github-api:list-runs-malformed')

  const candidates = runs
    .flatMap(run => {
      if (!isRecord(run) || !Number.isInteger(run.id) || typeof run.updated_at !== 'string') return []
      if (run.event !== 'schedule' && run.event !== 'workflow_dispatch') return []
      return (run.id as number) < currentId ? [{id: run.id as number, updatedAt: Date.parse(run.updated_at)}] : []
    })
    .sort((left, right) => right.id - left.id)
    .slice(0, PREVIOUS_RUN_CANDIDATES)

  for (const candidate of candidates) {
    // Older runs are older still: nothing past a stale run is "the run before".
    if (Number.isNaN(candidate.updatedAt) || now.getTime() - candidate.updatedAt > PREVIOUS_RUN_MAX_AGE_MS) {
      return 'unknown'
    }
    const jobs = parseJsonRecord(
      await ghCall(gh, 'list-jobs', [
        'api',
        `repos/${context.repository}/actions/runs/${candidate.id}/jobs?per_page=30`,
      ]),
      'list-jobs',
    )
    if (!Array.isArray(jobs.jobs)) throw new AlertFailure('github-api:list-jobs-malformed')
    const probeJob = (jobs.jobs as unknown[]).find(job => isRecord(job) && job.name === PROBE_JOB_NAME)
    const health = isRecord(probeJob) ? conclusionToHealth(probeJob.conclusion) : null
    if (health !== null) return health
  }
  return 'unknown'
}

// ─── Content ─────────────────────────────────────────────────────────────────

function resultText(env: MonitorEnv): string {
  if (env.rehearse === 'fail') return `failure (${REHEARSAL_RESULT_NOTE})`
  if (env.rehearse === 'clear') return `success (${REHEARSAL_RESULT_NOTE})`
  return env.probeResult
}

function detailLines(env: MonitorEnv, prefix: string): string[] {
  return [
    `${prefix}Workflow: ${env.workflow}`,
    `${prefix}Run: ${runUrl(env)}`,
    `${prefix}Probe job result: ${resultText(env)}`,
    `${prefix}Runbook: ${blobUrl(env, RUNBOOK_PATH)}`,
  ]
}

/** The probe's failing conditions by their fixed category words, or no lines when the probe reported none. */
function categoryLines(env: MonitorEnv, prefix: string): string[] {
  return env.categories.length === 0 ? [] : [`${prefix}Failing checks: ${env.categories.join(', ')}`]
}

const URGENT_SENTENCE =
  'The ingest route answered a request that carried no token while ingest is not meant to be open. This alert was raised at once, without waiting for a second run.'

/** True only for a real run whose probe failed and reported the ingest route open when it should not be. */
function isUrgent(env: MonitorEnv): boolean {
  return env.rehearse === 'none' && env.urgent && verdictOf(env) === 'unhealthy'
}

/** The line appended once to an issue that is already open when the urgent condition starts during the outage. */
const URGENT_PREFIX = '- Ingest open unexpectedly'
function urgentAnnotation(env: MonitorEnv): string {
  return `${URGENT_PREFIX}: first seen in ${runUrl(env)}`
}

function issueBody(env: MonitorEnv, identity: Identity): string {
  if (identity === 'rehearsal') {
    return [
      REHEARSAL_MARKER,
      '**Rehearsal.** This tests the trace collection alert. Nothing was probed and nothing is wrong. It closes when the workflow is dispatched again with `rehearse-alert` set to `clear`.',
      '',
      ...detailLines(env, '- '),
    ].join('\n')
  }
  return [
    REAL_MARKER,
    isUrgent(env)
      ? `${URGENT_SENTENCE} Follow the runbook (${RUNBOOK_PATH}).`
      : `The trace collection stack failed its health probe on two runs in a row. Senders may be losing traces. Open the run for which check failed, then follow the runbook (${RUNBOOK_PATH}).`,
    '',
    ...detailLines(env, '- '),
    ...categoryLines(env, '- '),
    // An issue created by an urgent run already says so, so a later urgent run need not annotate it.
    ...(isUrgent(env) ? [urgentAnnotation(env)] : []),
    '',
    'This issue closes when a probe is healthy again.',
  ].join('\n')
}

function failureComment(env: MonitorEnv, identity: Identity): string {
  const lead =
    identity === 'rehearsal' ? '**Rehearsal.** The alert was triggered again.' : 'The health probe is still failing.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

function recoveryComment(env: MonitorEnv, identity: Identity): string {
  const lead =
    identity === 'rehearsal'
      ? '**Rehearsal.** Cleared by a rehearsal dispatch, so this issue is closed.'
      : 'The health probe is healthy again, so this issue is closed.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

/** The Discord message. Plain text built from fixed strings and the github context; embeds are suppressed on send. */
export function buildDiscordContent(
  kind: 'created' | 'recovered',
  env: MonitorEnv,
  issueNumber: number | null,
): string {
  const rehearsal = env.rehearse !== 'none'
  const tag = rehearsal ? '[REHEARSAL] ' : ''
  const [workflow, run, result, runbook] = detailLines(env, '')
  const issue = issueNumber === null ? [] : [`Issue: ${issueUrl(env, issueNumber)}`]
  const failing = categoryLines(env, '')
  const lines =
    kind === 'created'
      ? [
          `**${tag}Trace collection stack unhealthy**`,
          isUrgent(env)
            ? `${URGENT_SENTENCE} Check it now.`
            : 'The health probe failed on two runs in a row. Senders may be losing traces. Check it now.',
          ...(rehearsal ? ['Rehearsal: nothing was probed and nothing is wrong.'] : []),
        ]
      : [
          `**${tag}Trace collection stack recovered**`,
          'The health probe is healthy again. The alert issue is closed.',
          ...(rehearsal ? ['Rehearsal: nothing was probed and nothing is wrong.'] : []),
        ]
  return [
    ...lines,
    workflow,
    run,
    result,
    ...(kind === 'created' && !rehearsal ? failing : []),
    ...issue,
    runbook,
  ].join('\n')
}

function contentFor(env: MonitorEnv): IssueContent {
  return {
    body: identity => issueBody(env, identity),
    failureComment: identity => failureComment(env, identity),
    recoveryComment: identity => recoveryComment(env, identity),
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export async function reconcileMonitor(
  env: MonitorEnv,
  deps: {readonly gh: GhRunner; readonly now: () => Date; readonly log: (line: string) => void},
): Promise<IssueOutcome> {
  const verdict = verdictOf(env)
  // The history is read only when it can matter: an unhealthy probe, outside a rehearsal.
  // An urgent run alerts at once, so it does not need the run before it either.
  const previous: PreviousRun =
    env.rehearse === 'none' && verdict === 'unhealthy' && !isUrgent(env)
      ? await lookupPreviousRun(env, deps.gh, deps.now())
      : 'unknown'
  const urgent = isUrgent(env)
  const plan = planMonitor({verdict, rehearse: env.rehearse, urgent}, previous)
  if (plan.kind === 'none' && verdict === 'unhealthy') {
    deps.log('::notice::The probe is unhealthy, but the run before it was not. An alert needs two in a row.')
  }
  return reconcileAlertIssue(
    {
      context: env,
      gh: deps.gh,
      spec: SPEC,
      content: contentFor(env),
      // An urgent condition that starts while an issue is already open is added to that issue once, never a second issue.
      annotate: urgent ? {prefix: URGENT_PREFIX, line: urgentAnnotation(env)} : undefined,
    },
    plan,
  )
}

export async function runIssueStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: IssueStepDeps & {readonly now: () => Date},
): Promise<{readonly exitCode: 0 | 1; readonly outcome: IssueOutcome | null}> {
  return runIssueStepWith({
    alertName: ALERT_NAME,
    rerunHint: 'Wait for the next scheduled probe instead.',
    environment,
    readEnv: readMonitorEnv,
    reconcile: env => reconcileMonitor(env, deps),
    deps,
  })
}

// ─── Discord ─────────────────────────────────────────────────────────────────

export async function runNotifyStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyStepDeps,
): Promise<NotifySummary> {
  return runDiscordStepWith({
    alertName: ALERT_NAME,
    environment,
    buildContent: (kind, issueNumber) => buildDiscordContent(kind, readMonitorEnv(environment), issueNumber),
    deps,
  })
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command === 'probe') {
    const result = await runProbe(process.env, {
      fetch: globalThis.fetch.bind(globalThis),
      readCertificateExpiry,
      now: () => new Date(),
      writeOutput: (name, value) => appendTo(process.env.GITHUB_OUTPUT, `${name}=${value}`),
      log: printLine,
      appendSummary: line => appendTo(process.env.GITHUB_STEP_SUMMARY, line),
    })
    process.exitCode = result.exitCode
    return
  }
  if (command === 'issue') {
    const result = await runIssueStep(process.env, {...realIssueDeps(), now: () => new Date()})
    process.exitCode = result.exitCode
    return
  }
  if (command === 'notify') {
    await runNotifyStep(process.env, realNotifyDeps())
    process.exitCode = 0
    return
  }
  printLine('::error::Usage: traces-monitor.ts <probe|issue|notify>')
  process.exitCode = 2
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // Fixed text only: nothing thrown here may carry a token, a webhook or a response body.
    process.stdout.write('::error::Monitor script failed unexpectedly\n')
    process.exitCode = process.argv[2] === 'notify' ? 0 : 1
  }
}
