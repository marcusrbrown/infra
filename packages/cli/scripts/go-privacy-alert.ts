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
 * - `restriction`  Posts ONE Discord message when a SUCCESSFUL refresh opened or updated the snapshot PR and that PR
 *             would restrict models the proxy serves (the previous snapshot made them eligible, the new one does not).
 *             The models stay exposed until the PR merges and the gated deploy is approved, so this is a separate step
 *             with its own webhook read. It opens no issue. While the PR stays open the refresh updates it daily and
 *             this posts daily: a reminder, not state. Always exits 0.
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
 * A re-run never updates the alert. A re-run (`github.run_attempt` above 1) replays the first attempt's
 * `needs.refresh.result`, which can be older than the current outage: a replayed success would close a newer outage's
 * issue and post a false recovery. So `issue` makes no API call at all, writes `notify=none` and exits 0 for any
 * attempt that is not exactly 1, including a missing or malformed value (fail safe: do nothing). To update the alert,
 * dispatch a fresh refresh or wait for the next scheduled run. This covers rehearsals too, which are dispatches.
 *
 * Rehearsal (`ALERT_REHEARSE` = `fail` | `clear`, from the dispatch input): the same paths under a separate marker, with
 * every write marked as a rehearsal, so a rehearsal can never absorb a real failure and a real failure never lands on
 * a rehearsal issue. It is owner-only and the workflow skips the real refresh for it. Only the explicit `clear`
 * closes a rehearsal issue; a real success never touches one. `restrict` rehearses the restriction message alone: no
 * issue is touched, the message carries the `[REHEARSAL]` tag and links the repository's PR list. Also owner-only.
 *
 * Environment inputs (names are this script's contract):
 * - `ALERT_REFRESH_RESULT`  `needs.refresh.result`: `success` | `failure` | `cancelled` | `skipped`.
 * - `ALERT_REHEARSE`        `none` | `fail` | `clear`; empty (a scheduled run) reads as `none`.
 * - `ALERT_RUN_ATTEMPT`     `issue` only: `github.run_attempt`. Anything but exactly `1` is a re-run.
 * - `ALERT_NOTIFY`          `notify` only: the previous step's `notify` output.
 * - `ALERT_ISSUE_NUMBER`    `notify` only: the previous step's `issue-number` output.
 * - `ALERT_RESTRICTED`      `restriction` only: the refresh job's `restricted` output, a count. Empty reads as 0; anything
 *                           but 1 to 4 digits is refused. The ids of the models never reach this script.
 * - `ALERT_PR_URL`          `restriction` only: the refresh job's `pr-url` output. Used only when it is exactly this
 *                           repository's pull URL; any other value is dropped for a link to the repository's PR list.
 * - `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`  `notify` and `restriction` only. Missing or blank => skipped.
 * - `ALERT_RUN_ATTEMPT`     also read by `restriction`: only attempt 1 acts.
 * - `GH_TOKEN`              `issue` only, consumed by `gh`.
 * - `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
 *   `GITHUB_REPOSITORY_OWNER`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`: set by the runner.
 */

import {
  AlertFailure,
  blobUrl,
  emitNotify,
  issueUrl,
  oneOf,
  parseAttempt,
  printLine,
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
  type RunContext,
} from './alert-issue'
import {sendDiscordMessage} from './deploy-gate-notify'

// The shared issue-and-Discord types stay importable from here, where they began.
export {AlertFailure}
export type {
  GhResult,
  GhRunner,
  Identity,
  IssueOutcome,
  IssueStepDeps,
  NotifyKind,
  NotifyStepDeps,
  NotifySummary,
  Plan,
} from './alert-issue'

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
const RESTRICTION_RUNBOOK_ANCHOR = 'snapshot-refresh-pr-review'
const EMERGENCY_DISABLE_ANCHOR = 'emergency-disable-without-a-deploy'
const REHEARSAL_RESULT_NOTE = 'rehearsal; no refresh ran'
const ALERT_NAME = 'OpenCode Go privacy alert'

const REFRESH_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const
const REHEARSALS = ['none', 'fail', 'clear', 'restrict'] as const

export type RefreshResult = (typeof REFRESH_RESULTS)[number]
export type Rehearse = (typeof REHEARSALS)[number]

const SPEC: AlertSpec = {
  label: ALERT_LABEL,
  labelColor: LABEL_COLOR,
  labelDescription: LABEL_DESCRIPTION,
  markers: {real: REAL_MARKER, rehearsal: REHEARSAL_MARKER},
  titles: {real: REAL_TITLE, rehearsal: REHEARSAL_TITLE},
  commentOnRepeat: true,
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AlertEnv extends RunContext {
  readonly refreshResult: RefreshResult
  readonly rehearse: Rehearse
  readonly attempt: Attempt
}

// ─── Environment ─────────────────────────────────────────────────────────────

export function readAlertEnv(environment: Readonly<Record<string, string | undefined>>): AlertEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''

  return {
    ...readRunContext(environment),
    refreshResult: oneOf(REFRESH_RESULTS, read('ALERT_REFRESH_RESULT'), 'invalid-refresh-result'),
    rehearse: oneOf(REHEARSALS, read('ALERT_REHEARSE') || 'none', 'invalid-rehearsal'),
    attempt: parseAttempt(read('ALERT_RUN_ATTEMPT')),
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

/**
 * `failure` and `cancelled` alert: GitHub reports a job killed by `timeout-minutes` as `cancelled` (some surfaces say
 * `failure`), and a hand-cancelled run also reads `cancelled`. `success` clears. `skipped` is the refresh job not
 * running (any ref but main) and does nothing. A rehearsal ignores the real result and uses its own identity.
 */
export function planAlert(input: {readonly refreshResult: RefreshResult; readonly rehearse: Rehearse}): Plan {
  // The restriction rehearsal exercises the Discord message only; the issue path has nothing to do.
  if (input.rehearse === 'restrict') return {kind: 'none'}
  const rehearsal = rehearsalPlan(input.rehearse)
  if (rehearsal !== null) return rehearsal
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

function runbookUrl(env: AlertEnv): string {
  return blobUrl(env, RUNBOOK_PATH, RUNBOOK_ANCHOR)
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

function issueBody(env: AlertEnv, identity: Identity): string {
  if (identity === 'rehearsal') {
    return [
      REHEARSAL_MARKER,
      '**Rehearsal.** This tests the refresh alert. No refresh ran and nothing is wrong. It closes when the workflow is dispatched again with `rehearse-alert` set to `clear`.',
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
    identity === 'rehearsal'
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

// ─── Reconciliation ──────────────────────────────────────────────────────────

function contentFor(env: AlertEnv): IssueContent {
  return {
    body: identity => issueBody(env, identity),
    failureComment: identity => failureComment(env, identity),
    recoveryComment: identity => recoveryComment(env, identity),
  }
}

export async function reconcileIssue(env: AlertEnv, gh: GhRunner): Promise<IssueOutcome> {
  return reconcileAlertIssue({context: env, gh, spec: SPEC, content: contentFor(env)}, planAlert(env))
}

/** Never throws. A failure exits 1 with a fixed reason code; no GitHub response text is logged. */
export async function runIssueStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: IssueStepDeps,
): Promise<{readonly exitCode: 0 | 1; readonly outcome: IssueOutcome | null}> {
  return runIssueStepWith({
    alertName: ALERT_NAME,
    rerunHint: 'Dispatch a fresh refresh instead.',
    environment,
    readEnv: readAlertEnv,
    reconcile: env => reconcileIssue(env, deps.gh),
    deps,
  })
}

// ─── Discord ─────────────────────────────────────────────────────────────────

/** Never throws and never fails the job: the issue is the record. */
export async function runNotifyStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyStepDeps,
): Promise<NotifySummary> {
  return runDiscordStepWith({
    alertName: ALERT_NAME,
    environment,
    buildContent: (kind, issueNumber) => buildDiscordContent(kind, readAlertEnv(environment), issueNumber),
    deps,
  })
}

// ─── Restriction notice ──────────────────────────────────────────────────────

const MAX_PR_NUMBER_DIGITS = 10

export interface RestrictionEnv extends AlertEnv {
  /** How many models the snapshot PR would restrict; 0 when the refresh reported none. */
  readonly restricted: number
  /** The refresh job's `pr-url` output as given, unvalidated; empty when no PR was opened or updated. */
  readonly prUrl: string
}

export type RestrictionSkip = 'rerun' | 'rehearsal' | 'refresh-not-successful' | 'nothing-restricted' | 'no-pr'

export type RestrictionPlan =
  | {readonly kind: 'skip'; readonly reason: RestrictionSkip}
  | {
      readonly kind: 'send'
      readonly identity: Identity
      readonly count: number
      /** This repository's pull URL, or the repository's PR list when the value given was anything else. */
      readonly link: string
    }

/** Parse, don't guess: empty is 0 (the refresh did not change the snapshot), a short decimal is a count, the rest throws. */
function parseRestricted(value: string): number {
  if (value === '') return 0
  if (!/^\d{1,4}$/.test(value)) throw new AlertFailure('invalid-restricted')
  return Number(value)
}

export function readRestrictionEnv(environment: Readonly<Record<string, string | undefined>>): RestrictionEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''
  return {
    ...readAlertEnv(environment),
    restricted: parseRestricted(read('ALERT_RESTRICTED')),
    prUrl: read('ALERT_PR_URL'),
  }
}

/** Exactly `<server>/<owner>/<repo>/pull/<digits>`: compared as text, never rendered from a pattern built from input. */
function isOwnPullUrl(env: RestrictionEnv): boolean {
  const prefix = `${env.serverUrl}/${env.repository}/pull/`
  if (!env.prUrl.startsWith(prefix)) return false
  const number = env.prUrl.slice(prefix.length)
  return number.length <= MAX_PR_NUMBER_DIGITS && /^[1-9]\d*$/.test(number)
}

function pullsUrl(env: RestrictionEnv): string {
  return `${env.serverUrl}/${env.repository}/pulls`
}

/**
 * Decision table, first match wins. Only the first attempt acts: a re-run replays an old refresh result. A rehearsal
 * replaces the real inputs and is owner-only. A real notice needs a successful refresh, a count above zero and a PR
 * that this run opened or updated (an empty `pr-url` means the refresh found main already carrying the snapshot).
 *
 * Dedupe: none, on purpose. The refresh updates the same PR every day while it differs from main, so a still-open
 * restricting PR posts once a day. The models stay served until the PR merges and the deploy is approved, so a daily
 * reminder is the right cost, and it needs no stored state.
 */
export function planRestriction(env: RestrictionEnv): RestrictionPlan {
  if (env.attempt !== 'first') return {kind: 'skip', reason: 'rerun'}
  if (env.rehearse === 'restrict') {
    if (env.actor === '' || env.actor !== env.owner) throw new AlertFailure('rehearsal-not-owner')
    return {kind: 'send', identity: 'rehearsal', count: 1, link: pullsUrl(env)}
  }
  if (env.rehearse !== 'none') return {kind: 'skip', reason: 'rehearsal'}
  if (env.refreshResult !== 'success') return {kind: 'skip', reason: 'refresh-not-successful'}
  if (env.restricted === 0) return {kind: 'skip', reason: 'nothing-restricted'}
  if (env.prUrl === '') return {kind: 'skip', reason: 'no-pr'}
  return {kind: 'send', identity: 'real', count: env.restricted, link: isOwnPullUrl(env) ? env.prUrl : pullsUrl(env)}
}

/** Fixed text, the count, and links built from the github context or validated as this repository's own. */
export function buildRestrictionContent(env: RestrictionEnv, plan: Extract<RestrictionPlan, {kind: 'send'}>): string {
  const rehearsal = plan.identity === 'rehearsal'
  const [workflow, run] = detailLines(env, '')
  return [
    `**${rehearsal ? '[REHEARSAL] ' : ''}OpenCode Go privacy refresh PR restricts models**`,
    `${plan.count} model(s) the proxy serves would be restricted. Review the PR, then merge it and approve the cliproxy deploy. The models stay served until a deploy succeeds. If the PR leaves no eligible Go model, the deploy fails its preflight and changes nothing: disable the route instead.`,
    ...(rehearsal ? ['Rehearsal: no refresh ran, no PR was opened and nothing is restricted.'] : []),
    `PR: ${plan.link}`,
    workflow,
    run,
    `Runbook: ${blobUrl(env, RUNBOOK_PATH, RESTRICTION_RUNBOOK_ANCHOR)}`,
    `Emergency disable: ${blobUrl(env, RUNBOOK_PATH, EMERGENCY_DISABLE_ANCHOR)}`,
  ].join('\n')
}

/** Never throws and never fails the job: a missed Discord post is logged, the PR itself is the record. */
export async function runRestrictionStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyStepDeps,
): Promise<NotifySummary> {
  let summary: NotifySummary
  try {
    const env = readRestrictionEnv(environment)
    const plan = planRestriction(env)
    const webhook = environment.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK?.trim() ?? ''
    if (plan.kind === 'skip') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: plan.reason}
    } else if (webhook === '') {
      summary = {outcome: 'skipped', attempts: 0, status: null, reason: 'webhook-unset'}
    } else {
      const result = await sendDiscordMessage({
        webhook,
        content: buildRestrictionContent(env, plan),
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
  emitNotify(`${ALERT_NAME} restriction`, summary, deps)
  return summary
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command === 'issue') {
    const result = await runIssueStep(process.env, realIssueDeps())
    process.exitCode = result.exitCode
    return
  }
  if (command === 'notify') {
    await runNotifyStep(process.env, realNotifyDeps())
    process.exitCode = 0
    return
  }
  if (command === 'restriction') {
    await runRestrictionStep(process.env, realNotifyDeps())
    process.exitCode = 0
    return
  }
  printLine('::error::Usage: go-privacy-alert.ts <issue|notify|restriction>')
  process.exitCode = 2
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // Fixed text only: nothing thrown here may carry a token, a webhook or a response body.
    process.stdout.write('::error::Alert script failed unexpectedly\n')
    process.exitCode = process.argv[2] === 'notify' || process.argv[2] === 'restriction' ? 0 : 1
  }
}
