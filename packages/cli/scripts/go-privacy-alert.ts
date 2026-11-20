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
 * A re-run never updates the alert. A re-run (`github.run_attempt` above 1) replays the first attempt's
 * `needs.refresh.result`, which can be older than the current outage: a replayed success would close a newer outage's
 * issue and post a false recovery. So `issue` makes no API call at all, writes `notify=none` and exits 0 for any
 * attempt that is not exactly 1, including a missing or malformed value (fail safe: do nothing). To update the alert,
 * dispatch a fresh refresh or wait for the next scheduled run. This covers rehearsals too, which are dispatches.
 *
 * Rehearsal (`ALERT_REHEARSE` = `fail` | `clear`, from the dispatch input): the same paths under a separate marker, with
 * every write marked as a rehearsal, so a rehearsal can never absorb a real failure and a real failure never lands on
 * a rehearsal issue. It is owner-only and the workflow skips the real refresh for it. Only the explicit `clear`
 * closes a rehearsal issue; a real success never touches one.
 *
 * Environment inputs (names are this script's contract):
 * - `ALERT_REFRESH_RESULT`  `needs.refresh.result`: `success` | `failure` | `cancelled` | `skipped`.
 * - `ALERT_REHEARSE`        `none` | `fail` | `clear`; empty (a scheduled run) reads as `none`.
 * - `ALERT_RUN_ATTEMPT`     `issue` only: `github.run_attempt`. Anything but exactly `1` is a re-run.
 * - `ALERT_NOTIFY`          `notify` only: the previous step's `notify` output.
 * - `ALERT_ISSUE_NUMBER`    `notify` only: the previous step's `issue-number` output.
 * - `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK`  `notify` only. Missing or blank => skipped.
 * - `GH_TOKEN`              `issue` only, consumed by `gh`.
 * - `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
 *   `GITHUB_REPOSITORY_OWNER`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`: set by the runner.
 */

import {
  AlertFailure,
  blobUrl,
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
const REHEARSAL_RESULT_NOTE = 'rehearsal; no refresh ran'
const ALERT_NAME = 'OpenCode Go privacy alert'

const REFRESH_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const
const REHEARSALS = ['none', 'fail', 'clear'] as const

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
  printLine('::error::Usage: go-privacy-alert.ts <issue|notify>')
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
