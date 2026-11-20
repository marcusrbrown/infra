#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, non-published alert for the OpenCode Go privacy refresh.
 *
 * Run by the `alert` job of `.github/workflows/opencode-go-privacy.yaml`, which runs after the `refresh` job whatever
 * its result. Two commands, run as two workflow steps so the webhook and the issue token never share a step:
 *
 * - `issue`   Reads the refresh result and keeps ONE open issue per outage. A failed (or cancelled) refresh creates the
 *             issue, or comments on the open one; a successful refresh comments on it and closes it. Writes the step
 *             outputs `notify` (`created` | `recovered` | `none`) and `issue-number`. Any API failure exits 1, so a
 *             broken alert path is a red run.
 * - `notify`  Posts ONE Discord message when `notify` is `created` or `recovered`: on the first failing run of an
 *             outage and on recovery, never on every failing day. Always exits 0: Discord is a courtesy, the issue is
 *             the record.
 *
 * Safety contract:
 * - ZERO package imports. It runs after checkout + setup-bun WITHOUT `bun install` (Bun built-ins, `node:fs` and the
 *   sibling `deploy-gate-notify.ts`, which is itself import-free).
 * - Everything written (issue, comment, Discord message, log) is built from fixed strings and values of the `github`
 *   context. No text from the refresh script, its log, upstream documents or any PR reaches it. The inputs are a
 *   four-value result enum and a three-value rehearsal enum; anything else is refused.
 * - The webhook is read by `notify` only, from the environment, and is never written anywhere. Delivery failures are
 *   reported by fixed reason codes (`http-<status>`, `timeout`, `network`, `invalid-webhook`), never by error text.
 * - Issue lookups need the label AND the hidden marker in the body, on a real issue (not a pull request). A labelled
 *   issue without the marker is not ours: it is ignored, and ours is created beside it. A closed issue is never reopened.
 *
 * Rehearsal (`ALERT_REHEARSE` = `fail` | `clear`, from the dispatch input): the same paths under a separate marker, with
 * every write marked as a rehearsal, so a rehearsal can never absorb a real failure and a real failure never lands on
 * a rehearsal issue. It is owner-only and the workflow skips the real refresh for it.
 *
 * Environment inputs (names are this script's contract):
 * - `ALERT_REFRESH_RESULT`  `needs.refresh.result`: `success` | `failure` | `cancelled` | `skipped`.
 * - `ALERT_REHEARSE`        `none` | `fail` | `clear`; empty (a scheduled run) reads as `none`.
 * - `ALERT_NOTIFY`          `notify` only: the previous step's `notify` output.
 * - `ALERT_ISSUE_NUMBER`    `notify` only: the previous step's `issue-number` output.
 * - `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`  `notify` only. Missing or blank => skipped.
 * - `GH_TOKEN`              `issue` only, consumed by `gh`.
 * - `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
 *   `GITHUB_REPOSITORY_OWNER`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`: set by the runner.
 */

import {appendFileSync} from 'node:fs'
import {sendDiscordMessage, type FetchLike} from './deploy-gate-notify'

// ─── Contract constants ──────────────────────────────────────────────────────

export const ALERT_LABEL = 'opencode-go-privacy-failure'
export const REAL_MARKER = '<!-- opencode-go-privacy-alert:v1 -->'
export const REHEARSAL_MARKER = '<!-- opencode-go-privacy-alert-rehearsal:v1 -->'

const LABEL_COLOR = 'b60205'
const LABEL_DESCRIPTION = 'OpenCode Go privacy refresh failures'
const REAL_TITLE = 'OpenCode Go privacy refresh is failing'
const REHEARSAL_TITLE = '[Rehearsal] OpenCode Go privacy refresh alert'
const RUNBOOK_PATH = 'docs/runbooks/cliproxy-opencode-go.md'
const RUNBOOK_ANCHOR = 'the-scheduled-refresh-is-failing'
const DEFAULT_SERVER_URL = 'https://github.com'
const WORKFLOW_NAME_MAX_CHARS = 64
const REHEARSAL_RESULT_NOTE = 'rehearsal; no refresh ran'

const REFRESH_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const
const REHEARSALS = ['none', 'fail', 'clear'] as const

export type RefreshResult = (typeof REFRESH_RESULTS)[number]
export type Rehearse = (typeof REHEARSALS)[number]
export type Identity = 'real' | 'rehearsal'
export type NotifyKind = 'none' | 'created' | 'recovered'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface GhResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs `gh <args>`; `stdin` is a JSON request body for `gh api --input -`. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<GhResult>

export interface AlertEnv {
  readonly repository: string
  readonly serverUrl: string
  readonly runId: string
  readonly workflow: string
  readonly actor: string
  readonly owner: string
  readonly refreshResult: RefreshResult
  readonly rehearse: Rehearse
}

export type Plan = {readonly kind: 'none'} | {readonly kind: 'alert' | 'clear'; readonly identity: Identity}

export interface IssueOutcome {
  readonly action: 'none' | 'created' | 'commented' | 'closed'
  readonly notify: NotifyKind
  readonly issueNumber: number | null
}

export interface IssueStepDeps {
  readonly gh: GhRunner
  readonly writeOutput: (name: string, value: string) => void
  readonly log: (line: string) => void
  readonly appendSummary: (line: string) => void
}

export interface NotifyStepDeps {
  readonly fetch: FetchLike
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly log: (line: string) => void
  readonly appendSummary: (line: string) => void
  readonly timeoutMs?: number
}

export interface NotifySummary {
  readonly outcome: 'sent' | 'skipped' | 'failed'
  readonly attempts: number
  readonly status: number | null
  /** A fixed reason code; never error text. */
  readonly reason: string | null
}

/** A failure with a fixed reason code. Its message is that code and nothing else. */
export class AlertFailure extends Error {
  readonly reason: string

  constructor(reason: string) {
    super(reason)
    this.name = 'AlertFailure'
    this.reason = reason
  }
}

// ─── Environment ─────────────────────────────────────────────────────────────

function oneOf<T extends string>(values: readonly T[], value: string, reason: string): T {
  const found = values.find(candidate => candidate === value)
  if (found === undefined) throw new AlertFailure(reason)
  return found
}

export function readAlertEnv(environment: Readonly<Record<string, string | undefined>>): AlertEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''

  const repository = read('GITHUB_REPOSITORY')
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new AlertFailure('invalid-repository')
  const runId = read('GITHUB_RUN_ID')
  if (!/^\d{1,20}$/.test(runId)) throw new AlertFailure('invalid-run-id')
  const serverUrl = (read('GITHUB_SERVER_URL') || DEFAULT_SERVER_URL).replace(/\/+$/, '')
  if (!/^https:\/\/[\w.-]+(?::\d{1,5})?$/.test(serverUrl)) throw new AlertFailure('invalid-server-url')

  return {
    repository,
    serverUrl,
    runId,
    // A workflow name is free text from the workflow file; keep it to plain characters.
    workflow:
      read('GITHUB_WORKFLOW')
        .replaceAll(/[^\w .-]/g, '')
        .slice(0, WORKFLOW_NAME_MAX_CHARS)
        .trim() || 'workflow',
    actor: read('GITHUB_ACTOR'),
    owner: read('GITHUB_REPOSITORY_OWNER'),
    refreshResult: oneOf(REFRESH_RESULTS, read('ALERT_REFRESH_RESULT'), 'invalid-refresh-result'),
    rehearse: oneOf(REHEARSALS, read('ALERT_REHEARSE') || 'none', 'invalid-rehearsal'),
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

/**
 * `failure` and `cancelled` alert: GitHub reports a job killed by `timeout-minutes` as `cancelled` (some surfaces say
 * `failure`), and a hand-cancelled run also reads `cancelled`. `success` clears. `skipped` is the refresh job not
 * running (any ref but main) and does nothing. A rehearsal ignores the real result and uses its own identity.
 */
export function planAlert(input: {readonly refreshResult: RefreshResult; readonly rehearse: Rehearse}): Plan {
  if (input.rehearse === 'fail') return {kind: 'alert', identity: 'rehearsal'}
  if (input.rehearse === 'clear') return {kind: 'clear', identity: 'rehearsal'}
  switch (input.refreshResult) {
    case 'failure':
    case 'cancelled':
      return {kind: 'alert', identity: 'real'}
    case 'success':
      return {kind: 'clear', identity: 'real'}
    case 'skipped':
      return {kind: 'none'}
  }
}

// ─── Content ─────────────────────────────────────────────────────────────────

function runUrl(env: AlertEnv): string {
  return `${env.serverUrl}/${env.repository}/actions/runs/${env.runId}`
}

function runbookUrl(env: AlertEnv): string {
  return `${env.serverUrl}/${env.repository}/blob/main/${RUNBOOK_PATH}#${RUNBOOK_ANCHOR}`
}

function issueUrl(env: AlertEnv, number: number): string {
  return `${env.serverUrl}/${env.repository}/issues/${number}`
}

function resultText(env: AlertEnv): string {
  if (env.rehearse === 'fail') return `failure (${REHEARSAL_RESULT_NOTE})`
  if (env.rehearse === 'clear') return `success (${REHEARSAL_RESULT_NOTE})`
  return env.refreshResult
}

function detailLines(env: AlertEnv, prefix: string): string[] {
  return [
    `${prefix}Workflow: ${env.workflow}`,
    `${prefix}Run: ${runUrl(env)}`,
    `${prefix}Refresh job result: ${resultText(env)}`,
    `${prefix}Runbook: ${runbookUrl(env)}`,
  ]
}

const EXPOSURE_SENTENCE =
  'Until a refresh succeeds the snapshot cannot change, so a model whose terms upstream has tightened stays exposed.'

function issueTitle(identity: Identity): string {
  return identity === 'rehearsal' ? REHEARSAL_TITLE : REAL_TITLE
}

function markerOf(identity: Identity): string {
  return identity === 'rehearsal' ? REHEARSAL_MARKER : REAL_MARKER
}

function issueBody(env: AlertEnv, identity: Identity): string {
  if (identity === 'rehearsal') {
    return [
      REHEARSAL_MARKER,
      '**Rehearsal.** This tests the refresh alert. No refresh ran and nothing is wrong. It closes when the workflow is dispatched again with `rehearse-alert` set to `clear`, or when a scheduled refresh succeeds.',
      '',
      ...detailLines(env, '- '),
    ].join('\n')
  }
  return [
    REAL_MARKER,
    `The scheduled refresh of the OpenCode Go privacy snapshot failed. ${EXPOSURE_SENTENCE} Check upstream now: see "The scheduled refresh is failing" in the runbook.`,
    '',
    ...detailLines(env, '- '),
    '',
    'This issue closes when a refresh succeeds.',
  ].join('\n')
}

function failureComment(env: AlertEnv, identity: Identity): string {
  const lead = identity === 'rehearsal' ? '**Rehearsal.** The alert was triggered again.' : 'The refresh failed again.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

function recoveryComment(env: AlertEnv, identity: Identity): string {
  const lead =
    identity === 'rehearsal' && env.rehearse === 'clear'
      ? '**Rehearsal.** Cleared by a rehearsal dispatch, so this issue is closed.'
      : 'The refresh succeeded, so this issue is closed.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

/** The Discord message. Plain text built from fixed strings and the github context; embeds are suppressed on send. */
export function buildDiscordContent(kind: 'created' | 'recovered', env: AlertEnv, issueNumber: number | null): string {
  const rehearsal = env.rehearse !== 'none'
  const tag = rehearsal ? '[REHEARSAL] ' : ''
  const [workflow, run, result, runbook] = detailLines(env, '')
  const issue = issueNumber === null ? [] : [`Issue: ${issueUrl(env, issueNumber)}`]
  const lines =
    kind === 'created'
      ? [
          `**${tag}OpenCode Go privacy refresh failed**`,
          'Until it succeeds the snapshot cannot change, so a model whose terms upstream has tightened stays exposed. Check upstream now.',
          ...(rehearsal ? ['Rehearsal: no refresh ran and nothing is wrong.'] : []),
        ]
      : [
          `**${tag}OpenCode Go privacy refresh recovered**`,
          'The refresh succeeded. The alert issue is closed.',
          ...(rehearsal ? ['Rehearsal: no refresh ran and nothing is wrong.'] : []),
        ]
  return [...lines, workflow, run, result, ...issue, runbook].join('\n')
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

interface OpenIssue {
  readonly number: number
  readonly body: string
  readonly labels: readonly string[]
  readonly isPullRequest: boolean
  readonly state: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parses `gh api --paginate --slurp` output (an array of pages) strictly; anything else is a failure. */
function parseIssuePages(stdout: string): OpenIssue[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    throw new AlertFailure('github-api:list-issues-malformed')
  }
  if (!Array.isArray(parsed)) throw new AlertFailure('github-api:list-issues-malformed')
  const items: unknown[] = parsed.flatMap((page: unknown) => (Array.isArray(page) ? page : [page]))
  return items.map(item => {
    if (!isRecord(item) || !Number.isInteger(item.number) || typeof item.state !== 'string') {
      throw new AlertFailure('github-api:list-issues-malformed')
    }
    const labels = Array.isArray(item.labels)
      ? item.labels.flatMap((label: unknown) => (isRecord(label) && typeof label.name === 'string' ? [label.name] : []))
      : []
    return {
      number: item.number as number,
      body: typeof item.body === 'string' ? item.body : '',
      labels,
      isPullRequest: item.pull_request !== undefined && item.pull_request !== null,
      state: item.state,
    }
  })
}

async function ghCall(gh: GhRunner, stage: string, args: readonly string[], payload?: unknown): Promise<string> {
  const result = await gh(args, payload === undefined ? undefined : JSON.stringify(payload))
  // The failure names the stage only: the response text and the request body are never echoed.
  if (result.code !== 0) throw new AlertFailure(`github-api:${stage}`)
  return result.stdout
}

function parseJsonRecord(text: string, stage: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // Falls through to the fixed failure below.
  }
  throw new AlertFailure(`github-api:${stage}-malformed`)
}

async function listOpenIssues(env: AlertEnv, gh: GhRunner): Promise<OpenIssue[]> {
  const endpoint = `repos/${env.repository}/issues?state=open&labels=${encodeURIComponent(ALERT_LABEL)}&per_page=100`
  const stdout = await ghCall(gh, 'list-issues', ['api', '--paginate', '--slurp', endpoint])
  return parseIssuePages(stdout)
}

function ownIssues(issues: readonly OpenIssue[], identity: Identity): OpenIssue[] {
  const marker = markerOf(identity)
  return issues
    .filter(
      issue =>
        issue.state === 'open' &&
        !issue.isPullRequest &&
        issue.labels.includes(ALERT_LABEL) &&
        issue.body.includes(marker),
    )
    .sort((left, right) => left.number - right.number)
}

/** Creates the label when it is missing: the settings sync can delete it, so a run must not depend on it existing. */
async function ensureLabel(env: AlertEnv, gh: GhRunner): Promise<void> {
  const probe = await gh([
    'api',
    '--include',
    '--silent',
    `repos/${env.repository}/labels/${encodeURIComponent(ALERT_LABEL)}`,
  ])
  if (probe.code === 0) return
  if (!/^HTTP\/[\d.]+\s+404\b|\(HTTP 404\)/m.test(`${probe.stdout}\n${probe.stderr}`)) {
    throw new AlertFailure('github-api:probe-label')
  }
  await ghCall(gh, 'create-label', ['api', '--method', 'POST', '--input', '-', `repos/${env.repository}/labels`], {
    name: ALERT_LABEL,
    color: LABEL_COLOR,
    description: LABEL_DESCRIPTION,
  })
}

async function createIssue(env: AlertEnv, gh: GhRunner, identity: Identity): Promise<number> {
  await ensureLabel(env, gh)
  const stdout = await ghCall(
    gh,
    'create-issue',
    ['api', '--method', 'POST', '--input', '-', `repos/${env.repository}/issues`],
    {
      title: issueTitle(identity),
      body: issueBody(env, identity),
      labels: [ALERT_LABEL],
    },
  )
  const created = parseJsonRecord(stdout, 'create-issue')
  if (!Number.isInteger(created.number) || typeof created.html_url !== 'string') {
    throw new AlertFailure('github-api:create-issue-malformed')
  }
  return created.number as number
}

async function addComment(env: AlertEnv, gh: GhRunner, number: number, body: string): Promise<void> {
  const stdout = await ghCall(
    gh,
    'comment',
    ['api', '--method', 'POST', '--input', '-', `repos/${env.repository}/issues/${number}/comments`],
    {body},
  )
  if (!Number.isInteger(parseJsonRecord(stdout, 'comment').id)) throw new AlertFailure('github-api:comment-malformed')
}

async function closeIssue(env: AlertEnv, gh: GhRunner, number: number): Promise<void> {
  const stdout = await ghCall(
    gh,
    'close-issue',
    ['api', '--method', 'PATCH', '--input', '-', `repos/${env.repository}/issues/${number}`],
    {state: 'closed', state_reason: 'completed'},
  )
  // The response is the write's readback: the issue must report closed.
  if (parseJsonRecord(stdout, 'close-issue').state !== 'closed')
    throw new AlertFailure('github-api:close-not-confirmed')
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

const NOTHING: IssueOutcome = {action: 'none', notify: 'none', issueNumber: null}

export async function reconcileIssue(env: AlertEnv, gh: GhRunner): Promise<IssueOutcome> {
  const plan = planAlert(env)
  if (plan.kind === 'none') return NOTHING
  // A rehearsal writes to the real tracker: only the owner may start one, and nothing is read or written before this.
  if (env.rehearse !== 'none' && (env.actor === '' || env.actor !== env.owner)) {
    throw new AlertFailure('rehearsal-not-owner')
  }

  const open = await listOpenIssues(env, gh)
  const own = ownIssues(open, plan.identity)

  if (plan.kind === 'alert') {
    const existing = own[0]
    if (existing !== undefined) {
      await addComment(env, gh, existing.number, failureComment(env, plan.identity))
      return {action: 'commented', notify: 'none', issueNumber: existing.number}
    }
    const number = await createIssue(env, gh, plan.identity)
    return {action: 'created', notify: 'created', issueNumber: number}
  }

  // A successful scheduled refresh also closes an open rehearsal issue, quietly: a rehearsal alone never asks for Discord.
  const swept = plan.identity === 'real' ? ownIssues(open, 'rehearsal') : []
  for (const issue of own) {
    await addComment(env, gh, issue.number, recoveryComment(env, plan.identity))
    await closeIssue(env, gh, issue.number)
  }
  for (const issue of swept) {
    await addComment(env, gh, issue.number, recoveryComment(env, 'rehearsal'))
    await closeIssue(env, gh, issue.number)
  }
  const first = own[0] ?? swept[0]
  if (first === undefined) return NOTHING
  return {action: 'closed', notify: own.length > 0 ? 'recovered' : 'none', issueNumber: first.number}
}

/** Never throws. A failure exits 1 with a fixed reason code; no GitHub response text is logged. */
export async function runIssueStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: IssueStepDeps,
): Promise<{readonly exitCode: 0 | 1; readonly outcome: IssueOutcome | null}> {
  try {
    const env = readAlertEnv(environment)
    const outcome = await reconcileIssue(env, deps.gh)
    deps.writeOutput('notify', outcome.notify)
    if (outcome.issueNumber !== null) deps.writeOutput('issue-number', String(outcome.issueNumber))
    deps.appendSummary(
      `- OpenCode Go privacy alert: ${outcome.action}${outcome.issueNumber === null ? '' : ` #${outcome.issueNumber}`}`,
    )
    return {exitCode: 0, outcome}
  } catch (error) {
    const reason = error instanceof AlertFailure ? error.reason : 'internal-error'
    deps.log(`::error::Alert issue step failed: ${reason}`)
    return {exitCode: 1, outcome: null}
  }
}

// ─── Discord ─────────────────────────────────────────────────────────────────

/** Never throws and never fails the job: the issue is the record. */
export async function runNotifyStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyStepDeps,
): Promise<NotifySummary> {
  let summary: NotifySummary
  try {
    const kind = environment.ALERT_NOTIFY?.trim() ?? ''
    const webhook = environment.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK?.trim() ?? ''
    if (kind !== 'created' && kind !== 'recovered') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: 'nothing-to-send'}
    } else if (webhook === '') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: 'webhook-unset'}
    } else {
      const env = readAlertEnv(environment)
      const rawNumber = environment.ALERT_ISSUE_NUMBER?.trim() ?? ''
      const issueNumber = /^\d{1,10}$/.test(rawNumber) ? Number(rawNumber) : null
      const result = await sendDiscordMessage({
        webhook,
        content: buildDiscordContent(kind, env, issueNumber),
        fetch: deps.fetch,
        sleep: deps.sleep,
        timeoutMs: deps.timeoutMs,
      })
      summary = {outcome: result.outcome, attempts: result.attempts, status: result.status, reason: result.reason}
    }
  } catch (error) {
    summary = {
      outcome: 'failed',
      attempts: 0,
      status: null,
      reason: error instanceof AlertFailure ? error.reason : 'internal-error',
    }
  }
  emitNotify(summary, deps)
  return summary
}

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Output sinks must never break the always-exit-0 contract.
  }
}

function emitNotify(summary: NotifySummary, deps: NotifyStepDeps): void {
  const reason = summary.reason ?? 'unknown'
  if (summary.outcome === 'skipped' && summary.reason === 'webhook-unset') {
    safely(() => deps.log('::notice::Discord notification skipped: the webhook secret is not set'))
  } else if (summary.outcome === 'failed') {
    safely(() =>
      deps.log(
        `::warning::Discord notification failed: ${reason} after ${summary.attempts} attempt(s); the alert issue is unaffected`,
      ),
    )
  }
  const detail = summary.outcome === 'sent' ? '' : ` (${reason})`
  safely(() => deps.appendSummary(`- OpenCode Go privacy alert Discord notification: ${summary.outcome}${detail}`))
  safely(() => deps.log(JSON.stringify(summary)))
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function spawnGh(args: readonly string[], stdin?: string): Promise<GhResult> {
  const proc = Bun.spawn(['gh', ...args], {
    stdin: stdin === undefined ? 'ignore' : new Blob([stdin]),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
    timeout: 60_000,
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return {code, stdout, stderr}
}

function appendTo(path: string | undefined, line: string): void {
  if (path !== undefined && path !== '') appendFileSync(path, `${line}\n`)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const log = (line: string): void => {
    process.stdout.write(`${line}\n`)
  }
  const appendSummary = (line: string): void => appendTo(process.env.GITHUB_STEP_SUMMARY, line)

  if (command === 'issue') {
    const result = await runIssueStep(process.env, {
      gh: spawnGh,
      writeOutput: (name, value) => appendTo(process.env.GITHUB_OUTPUT, `${name}=${value}`),
      log,
      appendSummary,
    })
    process.exitCode = result.exitCode
    return
  }
  if (command === 'notify') {
    await runNotifyStep(process.env, {
      fetch: globalThis.fetch.bind(globalThis),
      sleep: milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
      log,
      appendSummary,
    })
    process.exitCode = 0
    return
  }
  log('::error::Usage: go-privacy-alert.ts <issue|notify>')
  process.exitCode = 2
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // Fixed text only: nothing thrown here may carry a token, a webhook or a response body.
    process.stdout.write('::error::Alert script failed unexpectedly\n')
    process.exitCode = process.argv[2] === 'notify' ? 0 : 1
  }
}
