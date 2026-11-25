/// <reference types="bun" />

/**
 * Shared issue-and-Discord transition logic for the repo-local, non-published alert scripts
 * (`go-privacy-alert.ts`, `traces-monitor.ts`, `traces-backup.ts`).
 *
 * Each script keeps ONE open issue per outage, found by a label AND a hidden marker in the body. A failing run
 * creates the issue or (optionally) comments on the open one; a healthy run comments on and closes it. Discord hears
 * about the two transitions only: the issue was created, the issue was closed. The scripts run as two workflow steps so
 * the issue token and the webhook never share a step.
 *
 * Safety contract:
 * - ZERO package imports: the jobs run after checkout + setup-bun WITHOUT `bun install` (Bun built-ins, `node:fs` and
 *   the import-free `deploy-gate-notify.ts`).
 * - Everything written is built by the calling script from fixed strings and values of the `github` context. This
 *   module never echoes a GitHub response, a request body or an error message: failures carry a fixed reason code.
 * - The webhook is read by the Discord step only, from the environment, and is never written anywhere.
 * - A re-run (`github.run_attempt` above 1) replays an old result, so the issue step makes no API call for any attempt
 *   that is not exactly 1, including a missing or malformed value.
 */

import {appendFileSync} from 'node:fs'
import {sendDiscordMessage, type FetchLike} from './deploy-gate-notify'

// ─── Types ───────────────────────────────────────────────────────────────────

export type Identity = 'real' | 'rehearsal'
export type NotifyKind = 'none' | 'created' | 'recovered'
export type Rehearse = 'none' | 'fail' | 'clear'
/** `first` only for the exact attempt `1`; `rerun` for a later attempt; `invalid` for a missing or malformed value. */
export type Attempt = 'first' | 'rerun' | 'invalid'

export type Plan = {readonly kind: 'none'} | {readonly kind: 'alert' | 'clear'; readonly identity: Identity}

export interface GhResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** Runs `gh <args>`; `stdin` is a JSON request body for `gh api --input -`. */
export type GhRunner = (args: readonly string[], stdin?: string) => Promise<GhResult>

export interface IssueOutcome {
  readonly action: 'none' | 'created' | 'commented' | 'annotated' | 'closed'
  readonly notify: NotifyKind
  readonly issueNumber: number | null
}

export interface RunContext {
  readonly repository: string
  readonly serverUrl: string
  readonly runId: string
  readonly workflow: string
  readonly actor: string
  readonly owner: string
}

/** What identifies one alert's issues, and how it behaves while an outage continues. */
export interface AlertSpec {
  readonly label: string
  readonly labelColor: string
  readonly labelDescription: string
  readonly markers: Readonly<Record<Identity, string>>
  readonly titles: Readonly<Record<Identity, string>>
  /**
   * Real alerts only. `true` comments on the open issue every time the outage is seen again; `false` leaves it alone
   * (a monitor that runs every 15 minutes must not add 96 comments a day). A rehearsal always comments, so a
   * rehearsal exercises the comment path.
   */
  readonly commentOnRepeat: boolean
}

/** The text of one alert. Built by the caller from fixed strings and the github context. */
export interface IssueContent {
  readonly body: (identity: Identity) => string
  readonly failureComment: (identity: Identity) => string
  readonly recoveryComment: (identity: Identity) => string
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

const DEFAULT_SERVER_URL = 'https://github.com'
const WORKFLOW_NAME_MAX_CHARS = 64

export function oneOf<T extends string>(values: readonly T[], value: string, reason: string): T {
  const found = values.find(candidate => candidate === value)
  if (found === undefined) throw new AlertFailure(reason)
  return found
}

/** Parse, don't guess: only a positive integer is an attempt number, and only 1 is the first attempt. */
export function parseAttempt(value: string): Attempt {
  if (!/^[1-9]\d{0,3}$/.test(value)) return 'invalid'
  return Number(value) === 1 ? 'first' : 'rerun'
}

/** Validates the values of the `github` context that every alert links to. Throws on anything malformed. */
export function readRunContext(environment: Readonly<Record<string, string | undefined>>): RunContext {
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
  }
}

/** `none` is the scheduled value (an empty input); anything else outside the three is refused. */
export function readRehearse(value: string | undefined): Rehearse {
  return oneOf(['none', 'fail', 'clear'] as const, value?.trim() || 'none', 'invalid-rehearsal')
}

/** A rehearsal replaces whatever the real result was: its own identity, its own marker. */
export function rehearsalPlan(rehearse: Rehearse): Plan | null {
  if (rehearse === 'fail') return {kind: 'alert', identity: 'rehearsal'}
  if (rehearse === 'clear') return {kind: 'clear', identity: 'rehearsal'}
  return null
}

// ─── Links ───────────────────────────────────────────────────────────────────

export function runUrl(context: RunContext): string {
  return `${context.serverUrl}/${context.repository}/actions/runs/${context.runId}`
}

export function issueUrl(context: RunContext, number: number): string {
  return `${context.serverUrl}/${context.repository}/issues/${number}`
}

export function blobUrl(context: RunContext, path: string, anchor?: string): string {
  return `${context.serverUrl}/${context.repository}/blob/main/${path}${anchor === undefined ? '' : `#${anchor}`}`
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

interface OpenIssue {
  readonly number: number
  readonly body: string
  readonly labels: readonly string[]
  readonly isPullRequest: boolean
  readonly state: string
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Parses `gh api --paginate --slurp` output (an array of pages) strictly: an entry that lacks a field read below, or has
 * one of the wrong type, fails the whole lookup. A guessed default (an empty list for a missing `labels`) would hide an
 * open alert issue and open a duplicate; a failed lookup takes no action instead.
 *
 * Hand-written rather than Zod on purpose: these scripts import no package, so the alert jobs run without `bun install`.
 * It validates exactly the fields read: `number`, `state`, `body` (a string, or null for an empty body), `labels` (an
 * array of objects with a string `name`) and `pull_request` (absent, null or an object).
 */
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
    const malformed = (): AlertFailure => new AlertFailure('github-api:list-issues-malformed')
    if (!isRecord(item) || !Number.isInteger(item.number) || typeof item.state !== 'string') throw malformed()
    if (item.body !== null && typeof item.body !== 'string') throw malformed()
    if (item.pull_request !== undefined && item.pull_request !== null && !isRecord(item.pull_request)) throw malformed()
    if (!Array.isArray(item.labels)) throw malformed()
    const labels = (item.labels as unknown[]).map(label => {
      if (!isRecord(label) || typeof label.name !== 'string') throw malformed()
      return label.name
    })
    return {
      number: item.number as number,
      body: typeof item.body === 'string' ? item.body : '',
      labels,
      isPullRequest: item.pull_request !== undefined && item.pull_request !== null,
      state: item.state,
    }
  })
}

/** Runs one `gh` call. The failure names the stage only: the response text and the request body are never echoed. */
export async function ghCall(gh: GhRunner, stage: string, args: readonly string[], payload?: unknown): Promise<string> {
  const result = await gh(args, payload === undefined ? undefined : JSON.stringify(payload))
  if (result.code !== 0) throw new AlertFailure(`github-api:${stage}`)
  return result.stdout
}

export function parseJsonRecord(text: string, stage: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // Falls through to the fixed failure below.
  }
  throw new AlertFailure(`github-api:${stage}-malformed`)
}

async function listOpenIssues(repository: string, spec: AlertSpec, gh: GhRunner): Promise<OpenIssue[]> {
  const endpoint = `repos/${repository}/issues?state=open&labels=${encodeURIComponent(spec.label)}&per_page=100`
  const stdout = await ghCall(gh, 'list-issues', ['api', '--paginate', '--slurp', endpoint])
  return parseIssuePages(stdout)
}

function ownIssues(issues: readonly OpenIssue[], spec: AlertSpec, identity: Identity): OpenIssue[] {
  const marker = spec.markers[identity]
  return issues
    .filter(
      issue =>
        issue.state === 'open' &&
        !issue.isPullRequest &&
        issue.labels.includes(spec.label) &&
        issue.body.includes(marker),
    )
    .sort((left, right) => left.number - right.number)
}

/** Creates the label when it is missing: the settings sync can delete it, so a run must not depend on it existing. */
async function ensureLabel(repository: string, spec: AlertSpec, gh: GhRunner): Promise<void> {
  const probe = await gh([
    'api',
    '--include',
    '--silent',
    `repos/${repository}/labels/${encodeURIComponent(spec.label)}`,
  ])
  if (probe.code === 0) return
  if (!/^HTTP\/[\d.]+\s+404\b|\(HTTP 404\)/m.test(`${probe.stdout}\n${probe.stderr}`)) {
    throw new AlertFailure('github-api:probe-label')
  }
  await ghCall(gh, 'create-label', ['api', '--method', 'POST', '--input', '-', `repos/${repository}/labels`], {
    name: spec.label,
    color: spec.labelColor,
    description: spec.labelDescription,
  })
}

async function createIssue(
  repository: string,
  spec: AlertSpec,
  gh: GhRunner,
  identity: Identity,
  body: string,
): Promise<number> {
  await ensureLabel(repository, spec, gh)
  const stdout = await ghCall(
    gh,
    'create-issue',
    ['api', '--method', 'POST', '--input', '-', `repos/${repository}/issues`],
    {title: spec.titles[identity], body, labels: [spec.label]},
  )
  const created = parseJsonRecord(stdout, 'create-issue')
  if (!Number.isInteger(created.number) || typeof created.html_url !== 'string') {
    throw new AlertFailure('github-api:create-issue-malformed')
  }
  return created.number as number
}

async function addComment(repository: string, gh: GhRunner, number: number, body: string): Promise<void> {
  const stdout = await ghCall(
    gh,
    'comment',
    ['api', '--method', 'POST', '--input', '-', `repos/${repository}/issues/${number}/comments`],
    {body},
  )
  if (!Number.isInteger(parseJsonRecord(stdout, 'comment').id)) throw new AlertFailure('github-api:comment-malformed')
}

/** Appends one line to the body of an open issue. The response is the write's readback. */
async function appendToBody(
  repository: string,
  gh: GhRunner,
  issue: {readonly number: number; readonly body: string},
  line: string,
): Promise<void> {
  const stdout = await ghCall(
    gh,
    'annotate-issue',
    ['api', '--method', 'PATCH', '--input', '-', `repos/${repository}/issues/${issue.number}`],
    {body: `${issue.body}\n${line}`},
  )
  if (!Number.isInteger(parseJsonRecord(stdout, 'annotate-issue').number)) {
    throw new AlertFailure('github-api:annotate-issue-malformed')
  }
}

async function closeIssue(repository: string, gh: GhRunner, number: number): Promise<void> {
  const stdout = await ghCall(
    gh,
    'close-issue',
    ['api', '--method', 'PATCH', '--input', '-', `repos/${repository}/issues/${number}`],
    {state: 'closed', state_reason: 'completed'},
  )
  // The response is the write's readback: the issue must report closed.
  if (parseJsonRecord(stdout, 'close-issue').state !== 'closed')
    throw new AlertFailure('github-api:close-not-confirmed')
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export const NOTHING: IssueOutcome = {action: 'none', notify: 'none', issueNumber: null}

/**
 * Applies one plan to the tracker.
 *
 * - A rehearsal writes to the real tracker: only the owner may start one, and nothing is read or written before this
 *   check.
 * - Issues are looked up by label AND marker, on a real issue (not a pull request). A labelled issue without the marker
 *   is not ours: it is ignored, and ours is created beside it. A closed issue is never reopened.
 * - Only this identity's issues close: a real success never touches a rehearsal issue, and `clear` never a real one.
 */
export async function reconcileAlertIssue(
  input: {
    readonly context: RunContext
    readonly gh: GhRunner
    readonly spec: AlertSpec
    readonly content: IssueContent
    /**
     * For a real alert that stays quiet while an outage continues (`commentOnRepeat: false`): when the open issue's body
     * does not yet contain `prefix`, append `line` to it once. A later run finds the prefix and writes nothing, so a
     * second condition that starts during an outage is announced once, not on every run.
     */
    readonly annotate?: {readonly prefix: string; readonly line: string}
  },
  plan: Plan,
): Promise<IssueOutcome> {
  if (plan.kind === 'none') return NOTHING
  const {context, gh, spec, content} = input
  if (plan.identity === 'rehearsal' && (context.actor === '' || context.actor !== context.owner)) {
    throw new AlertFailure('rehearsal-not-owner')
  }

  const open = await listOpenIssues(context.repository, spec, gh)
  const own = ownIssues(open, spec, plan.identity)

  if (plan.kind === 'alert') {
    const existing = own[0]
    if (existing !== undefined) {
      if (plan.identity === 'real' && !spec.commentOnRepeat) {
        const {annotate} = input
        if (annotate !== undefined && !existing.body.includes(annotate.prefix)) {
          await appendToBody(context.repository, gh, existing, annotate.line)
          return {action: 'annotated', notify: 'none', issueNumber: existing.number}
        }
        return {action: 'none', notify: 'none', issueNumber: existing.number}
      }
      await addComment(context.repository, gh, existing.number, content.failureComment(plan.identity))
      return {action: 'commented', notify: 'none', issueNumber: existing.number}
    }
    const number = await createIssue(context.repository, spec, gh, plan.identity, content.body(plan.identity))
    return {action: 'created', notify: 'created', issueNumber: number}
  }

  for (const issue of own) {
    await addComment(context.repository, gh, issue.number, content.recoveryComment(plan.identity))
    await closeIssue(context.repository, gh, issue.number)
  }
  const first = own[0]
  if (first === undefined) return NOTHING
  return {action: 'closed', notify: 'recovered', issueNumber: first.number}
}

// ─── Issue step ──────────────────────────────────────────────────────────────

/**
 * The issue step of an alert job. Never throws. A failure exits 1 with a fixed reason code; no GitHub response text is
 * logged. A re-run changes nothing (see the header).
 *
 * `readEnv` parses the step's environment and may throw an `AlertFailure`; `reconcile` decides and applies.
 */
export async function runIssueStepWith<Env extends {readonly attempt: Attempt}>(options: {
  /** Human name of the alert, used in log and summary lines. */
  readonly alertName: string
  /** What to do instead of re-running, e.g. `Dispatch a fresh refresh instead.` */
  readonly rerunHint: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly readEnv: (environment: Readonly<Record<string, string | undefined>>) => Env
  readonly reconcile: (env: Env) => Promise<IssueOutcome>
  readonly deps: IssueStepDeps
}): Promise<{readonly exitCode: 0 | 1; readonly outcome: IssueOutcome | null}> {
  const {alertName, rerunHint, deps} = options
  try {
    const env = options.readEnv(options.environment)
    if (env.attempt !== 'first') {
      // Checked before any API call, so a replayed result can neither close nor open anything.
      deps.log(
        env.attempt === 'rerun'
          ? `::notice::A re-run does not update the ${alertName}. ${rerunHint}`
          : `::warning::The run attempt value is missing or invalid, so the ${alertName} is left unchanged (treated as a re-run). ${rerunHint}`,
      )
      deps.writeOutput('notify', 'none')
      deps.appendSummary(`- ${alertName}: unchanged (re-run)`)
      return {exitCode: 0, outcome: NOTHING}
    }
    const outcome = await options.reconcile(env)
    deps.writeOutput('notify', outcome.notify)
    if (outcome.issueNumber !== null) deps.writeOutput('issue-number', String(outcome.issueNumber))
    deps.appendSummary(
      `- ${alertName}: ${outcome.action}${outcome.issueNumber === null ? '' : ` #${outcome.issueNumber}`}`,
    )
    return {exitCode: 0, outcome}
  } catch (error) {
    const reason = error instanceof AlertFailure ? error.reason : 'internal-error'
    deps.log(`::error::Alert issue step failed: ${reason}`)
    // Said explicitly, so the Discord step never reads an absent output as a transition.
    safely(() => deps.writeOutput('notify', 'none'))
    return {exitCode: 1, outcome: null}
  }
}

// ─── Discord step ────────────────────────────────────────────────────────────

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Output sinks must never break the always-exit-0 contract.
  }
}

/**
 * The Discord step of an alert job. Never throws and never fails the job: the issue is the record. It reads the
 * webhook and the previous step's two outputs from the environment (`CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`,
 * `ALERT_NOTIFY`, `ALERT_ISSUE_NUMBER`); `buildContent` builds the message and may throw an `AlertFailure`.
 */
export async function runDiscordStepWith(options: {
  readonly alertName: string
  readonly environment: Readonly<Record<string, string | undefined>>
  readonly buildContent: (kind: 'created' | 'recovered', issueNumber: number | null) => string
  readonly deps: NotifyStepDeps
}): Promise<NotifySummary> {
  const {alertName, environment, deps} = options
  let summary: NotifySummary
  try {
    const kind = environment.ALERT_NOTIFY?.trim() ?? ''
    const webhook = environment.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK?.trim() ?? ''
    if (kind !== 'created' && kind !== 'recovered') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: 'nothing-to-send'}
    } else if (webhook === '') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: 'webhook-unset'}
    } else {
      const rawNumber = environment.ALERT_ISSUE_NUMBER?.trim() ?? ''
      const issueNumber = /^\d{1,10}$/.test(rawNumber) ? Number(rawNumber) : null
      const result = await sendDiscordMessage({
        webhook,
        content: options.buildContent(kind, issueNumber),
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
  emitNotify(alertName, summary, deps)
  return summary
}

export function emitNotify(alertName: string, summary: NotifySummary, deps: NotifyStepDeps): void {
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
  safely(() => deps.appendSummary(`- ${alertName} Discord notification: ${summary.outcome}${detail}`))
  safely(() => deps.log(JSON.stringify(summary)))
}

// ─── Entrypoint helpers ──────────────────────────────────────────────────────

export async function spawnGh(args: readonly string[], stdin?: string): Promise<GhResult> {
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

export function appendTo(path: string | undefined, line: string): void {
  if (path !== undefined && path !== '') appendFileSync(path, `${line}\n`)
}

export function printLine(line: string): void {
  process.stdout.write(`${line}\n`)
}

/** The issue and Discord steps' dependencies, wired to the real runner. Only the entrypoints call this. */
export function realIssueDeps(): IssueStepDeps {
  return {
    gh: spawnGh,
    writeOutput: (name, value) => appendTo(process.env.GITHUB_OUTPUT, `${name}=${value}`),
    log: printLine,
    appendSummary: line => appendTo(process.env.GITHUB_STEP_SUMMARY, line),
  }
}

export function realNotifyDeps(): NotifyStepDeps {
  return {
    fetch: globalThis.fetch.bind(globalThis),
    sleep: milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
    log: printLine,
    appendSummary: line => appendTo(process.env.GITHUB_STEP_SUMMARY, line),
  }
}
