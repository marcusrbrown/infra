#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, non-published deploy-gate Discord notifier.
 *
 * Invoked only by the `notify` job of each `.github/workflows/deploy-<app>.yaml`
 * callee, immediately before the environment-gated deploy job. It posts ONE
 * plain-text message naming the app, the trigger, the change waiting to deploy,
 * and the run link. It owns message rendering and delivery only; it never
 * decides whether a deploy proceeds.
 *
 * Safety contract:
 * - ZERO package imports. It must run after checkout + setup-bun WITHOUT
 *   `bun install`, so it uses only Bun built-ins, global `fetch`,
 *   `process.env`, and `node:fs` (step-summary append).
 * - Always exits 0. Every skip/failure becomes a `::warning::`, a step-summary
 *   line, and one body-free JSON summary line. Nothing here may fail or skip a
 *   deploy.
 * - The webhook is read from the environment only and is never written to
 *   stdout, stderr, warnings, the step summary, or the JSON summary. Delivery
 *   failures are reported by fixed reason codes, never by error text (runtime
 *   fetch errors can embed the request URL). The message body is never logged.
 * - Commit text is untrusted: mentions are disabled (`allowed_mentions`),
 *   mention syntax and Discord markdown / masked links are neutralized, and
 *   the total content is bounded below Discord's 2000-character limit.
 *
 * Environment inputs (all strings; names are this script's contract):
 * - `DEPLOY_GATE_DISCORD_WEBHOOK`      Discord webhook URL (https). Missing/empty => `skipped`.
 * - `DEPLOY_GATE_APP`                  App name (keeweb, cliproxy, gateway, ...).
 * - `GITHUB_EVENT_NAME`                `push` | `workflow_dispatch` | ...
 * - `GITHUB_ACTOR`                     Dispatching actor.
 * - `GITHUB_REF_NAME`                  Ref name (branch).
 * - `GITHUB_SHA`                       Commit SHA (shortened to 7 chars).
 * - `DEPLOY_GATE_COMMIT_SUBJECT`       Commit subject, passed by the workflow (no git shell-out here).
 * - `GITHUB_REPOSITORY`                `owner/repo`.
 * - `GITHUB_SERVER_URL`                Defaults to `https://github.com`.
 * - `GITHUB_RUN_ID`                    Run ID, used for the run URL.
 * - `DEPLOY_GATE_DASHBOARD_VERSION`    Optional; dashboard `workflow_dispatch` image-pin version.
 * - `DEPLOY_GATE_DASHBOARD_DIGEST`     Optional; dashboard image digest (shortened for display).
 * - `GITHUB_STEP_SUMMARY`              Optional; one line is appended when set.
 *
 * Delivery mirrors the cliproxy monitor's `sendDiscord` semantics (but shares
 * no code with it): 3 attempts, 10s per-attempt timeout, retry only on 429 /
 * >=500 / network error / timeout, `Retry-After` honored but capped at
 * `MAX_RETRY_AFTER_MS` (2s) so a hostile or broken response can't hold the gate
 * open beyond the notify job's own timeout. A retry may rarely duplicate a
 * message; that is accepted.
 */

import {appendFileSync} from 'node:fs'

// ─── Contract constants ──────────────────────────────────────────────────────

export const DISCORD_CONTENT_LIMIT = 2000
export const MAX_ATTEMPTS = 3
export const REQUEST_TIMEOUT_MS = 10_000
export const MAX_RETRY_AFTER_MS = 2000
export const NETWORK_RETRY_DELAY_MS = 500

/** Total content budget; deliberately below Discord's hard limit. */
const CONTENT_BUDGET = 1900
const SUBJECT_MAX_CHARS = 200
const SHORT_SHA_LENGTH = 7
const SHORT_DIGEST_LENGTH = 12
const DEFAULT_SERVER_URL = 'https://github.com'
const SUBJECT_PLACEHOLDER = 'commit subject unavailable'
const ELLIPSIS = '…'
const ZERO_WIDTH_SPACE = '\u200B'

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// ─── Types ───────────────────────────────────────────────────────────────────

export interface NotifyEnv {
  /** `null` when the webhook is missing, empty, or whitespace-only. */
  readonly webhook: string | null
  readonly app: string
  readonly eventName: string
  readonly actor: string
  readonly refName: string
  readonly sha: string
  readonly subject: string
  readonly repository: string
  readonly serverUrl: string
  readonly runId: string
  readonly dashboardVersion: string
  readonly dashboardDigest: string
}

export interface SendResult {
  readonly outcome: 'sent' | 'failed'
  readonly attempts: number
  readonly status: number | null
  /** Fixed reason code (`http-<status>`, `timeout`, `network`, `invalid-webhook`); never error text. */
  readonly reason: string | null
}

export interface NotifySummary {
  readonly app: string
  readonly event: string
  readonly outcome: 'sent' | 'skipped' | 'failed'
  readonly attempts: number
  readonly status: number | null
  readonly reason: string | null
}

export interface NotifyIo {
  /** Writes one line to stdout. */
  readonly stdout: (line: string) => void
  /** Writes one full workflow-command line (already `::warning::`-prefixed) to stdout. */
  readonly warn: (line: string) => void
  /** Appends one line to the step summary. */
  readonly appendSummary: (line: string) => void
}

export interface SendOptions {
  readonly webhook: string
  readonly content: string
  readonly fetch: FetchLike
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly timeoutMs?: number
}

export interface NotifyDeps {
  readonly fetch: FetchLike
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly io: NotifyIo
  readonly timeoutMs?: number
  readonly buildMessage?: (env: NotifyEnv) => string
}

// ─── Environment ─────────────────────────────────────────────────────────────

/**
 * The workflow passes the FULL commit message (subject, blank line, body,
 * trailers). Only the first line is the subject; an empty first line yields ''
 * so the message falls back to the neutral placeholder instead of leaking the body.
 */
function firstLine(message: string): string {
  return (message.split(/\r?\n/, 1)[0] ?? '').trim()
}

export function readNotifyEnv(environment: Readonly<Record<string, string | undefined>>): NotifyEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''
  const webhook = read('DEPLOY_GATE_DISCORD_WEBHOOK')
  return {
    webhook: webhook === '' ? null : webhook,
    app: read('DEPLOY_GATE_APP'),
    eventName: read('GITHUB_EVENT_NAME'),
    actor: read('GITHUB_ACTOR'),
    refName: read('GITHUB_REF_NAME'),
    sha: read('GITHUB_SHA'),
    subject: firstLine(environment.DEPLOY_GATE_COMMIT_SUBJECT ?? ''),
    repository: read('GITHUB_REPOSITORY'),
    serverUrl: read('GITHUB_SERVER_URL') || DEFAULT_SERVER_URL,
    runId: read('GITHUB_RUN_ID'),
    dashboardVersion: read('DEPLOY_GATE_DASHBOARD_VERSION'),
    dashboardDigest: read('DEPLOY_GATE_DASHBOARD_DIGEST'),
  }
}

// ─── Plain-text rendering ────────────────────────────────────────────────────

/**
 * Renders untrusted text inert in a Discord message: collapses whitespace,
 * neutralizes mention syntax (`@everyone`, `@here`, `<@id>`, `<@&id>`, `<#id>`)
 * and masked links with zero-width spaces, and backslash-escapes markdown
 * metacharacters and a leading dash. Raw `http(s)://` text is left alone.
 */
export function escapeDiscordText(text: string): string {
  const collapsed = text
    .replaceAll(/[\p{Cc}\s]+/gu, ' ')
    .trim()
    .replaceAll('](', `]${ZERO_WIDTH_SPACE}(`)
    .replaceAll('@', `@${ZERO_WIDTH_SPACE}`)
    .replaceAll('<', `<${ZERO_WIDTH_SPACE}`)
  return collapsed.replaceAll(/[\\*_~`|>#[\]]/g, String.raw`\$&`).replace(/^-/, String.raw`\-`)
}

function truncate(text: string, maxChars: number): string {
  const chars = [...text]
  if (chars.length <= maxChars) return text
  return `${chars.slice(0, Math.max(0, maxChars - 1)).join('')}${ELLIPSIS}`
}

/** Escapes a bounded field (raw text is truncated before escaping so escapes can't be cut in half). */
function field(text: string, maxChars: number): string {
  return escapeDiscordText(truncate(text.trim(), maxChars))
}

function shortSha(sha: string): string {
  return field(sha.slice(0, SHORT_SHA_LENGTH), SHORT_SHA_LENGTH) || 'unknown'
}

function shortDigest(digest: string): string {
  const trimmed = digest.trim()
  const prefixed = /^sha256:/i.exec(trimmed)
  const prefix = prefixed === null ? '' : 'sha256:'
  const hex = prefixed === null ? trimmed : trimmed.slice(prefixed[0].length)
  return field(`${prefix}${hex.slice(0, SHORT_DIGEST_LENGTH)}`, 80)
}

/** URL parts come from GitHub context; keep them link-safe rather than markdown-escaped. */
function urlPart(text: string, maxChars: number): string {
  return text.replaceAll(/[^\w./:%+~-]/g, '').slice(0, maxChars)
}

function runUrl(env: NotifyEnv): string {
  const repository = urlPart(env.repository, 200)
  const runId = urlPart(env.runId, 30)
  if (repository === '' || runId === '') return 'unavailable'
  const server = urlPart(env.serverUrl, 200).replace(/\/+$/, '') || DEFAULT_SERVER_URL
  return `${server}/${repository}/actions/runs/${runId}`
}

function isDashboardDispatch(env: NotifyEnv): boolean {
  return env.eventName === 'workflow_dispatch' && env.dashboardVersion !== ''
}

function triggerLine(env: NotifyEnv): string {
  const event = env.eventName
  if (event === 'push') return `push to ${field(env.refName, 100) || 'unknown ref'}`
  if (event === 'workflow_dispatch') return `manual dispatch by ${field(env.actor, 64) || 'unknown actor'}`
  return `${field(event, 64) || 'unknown event'} on ${field(env.refName, 100) || 'unknown ref'}`
}

function changeLine(env: NotifyEnv, subjectMaxChars: number): string {
  if (isDashboardDispatch(env)) {
    const digest = env.dashboardDigest === '' ? 'digest not provided' : `digest ${shortDigest(env.dashboardDigest)}`
    return `${field(env.dashboardVersion, 100)} (${digest})`
  }
  const sha = shortSha(env.sha)
  if (env.eventName === 'push') {
    const subject = field(env.subject, subjectMaxChars) || SUBJECT_PLACEHOLDER
    return `${subject} (${sha})`
  }
  return `${field(env.refName, 100) || 'unknown ref'} @ ${sha}`
}

function render(env: NotifyEnv, subjectMaxChars: number): string {
  return [
    `**Deploy awaiting approval: ${field(env.app, 64) || 'unknown app'}**`,
    `Trigger: ${triggerLine(env)}`,
    `Change: ${changeLine(env, subjectMaxChars)}`,
    `Run: ${runUrl(env)}`,
  ].join('\n')
}

/**
 * Builds the gate message. The subject is the only unbounded field; it is
 * truncated first (with an ellipsis), then every other field is capped, and a
 * final hard slice guarantees the Discord limit even for pathological input.
 */
export function buildGateMessage(env: NotifyEnv): string {
  let subjectMax = SUBJECT_MAX_CHARS
  let content = render(env, subjectMax)
  while (content.length > CONTENT_BUDGET && subjectMax > 0) {
    subjectMax = Math.floor(subjectMax / 2)
    content = render(env, subjectMax)
  }
  return content.length > CONTENT_BUDGET ? `${content.slice(0, CONTENT_BUDGET - 1)}${ELLIPSIS}` : content
}

// ─── Delivery ────────────────────────────────────────────────────────────────

function isHttpsUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

function retryAfterMs(response: Response): number {
  const seconds = Number(response.headers.get('retry-after') ?? '0')
  if (!Number.isFinite(seconds) || seconds < 0) return 0
  return Math.min(MAX_RETRY_AFTER_MS, seconds * 1000)
}

export async function sendDiscordMessage(options: SendOptions): Promise<SendResult> {
  if (!isHttpsUrl(options.webhook)) {
    return {outcome: 'failed', attempts: 0, status: null, reason: 'invalid-webhook'}
  }
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS
  const body = JSON.stringify({content: options.content, allowed_mentions: {parse: []}})
  let status: number | null = null
  let reason = 'network'

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let delay = NETWORK_RETRY_DELAY_MS
    try {
      const response = await options.fetch(options.webhook, {
        method: 'POST',
        headers: {'content-type': 'application/json'},
        body,
        signal: controller.signal,
      })
      status = response.status
      if (response.ok) return {outcome: 'sent', attempts: attempt, status, reason: null}
      reason = `http-${response.status}`
      if (response.status !== 429 && response.status < 500) {
        return {outcome: 'failed', attempts: attempt, status, reason}
      }
      delay = retryAfterMs(response)
    } catch {
      // Never surface error text: runtime fetch errors can embed the request URL.
      status = null
      reason = controller.signal.aborted ? 'timeout' : 'network'
    } finally {
      clearTimeout(timer)
    }
    if (attempt < MAX_ATTEMPTS) await options.sleep(delay)
  }
  return {outcome: 'failed', attempts: MAX_ATTEMPTS, status, reason}
}

// ─── Orchestration ───────────────────────────────────────────────────────────

export function summaryLine(summary: NotifySummary): string {
  return JSON.stringify(summary)
}

/** Restricts a value to a short, workflow-command-safe label. */
function safeLabel(value: string): string {
  return value.slice(0, 64).replaceAll(/[^\w.-]/g, '_') || 'unknown'
}

function safely(action: () => void): void {
  try {
    action()
  } catch {
    // Output sinks must never break the always-exit-0 contract.
  }
}

function emit(summary: NotifySummary, io: NotifyIo): void {
  const label = safeLabel(summary.app)
  if (summary.outcome === 'skipped') {
    safely(() =>
      io.warn(`::warning::Deploy gate notification skipped for ${label}: DEPLOY_GATE_DISCORD_WEBHOOK is not set`),
    )
  } else if (summary.outcome === 'failed') {
    safely(() =>
      io.warn(
        `::warning::Deploy gate notification failed for ${label}: ${summary.reason ?? 'unknown'} after ${summary.attempts} attempt(s); the deploy is unaffected`,
      ),
    )
  }
  const detail = summary.outcome === 'sent' ? '' : ` (${summary.reason ?? 'unknown'})`
  safely(() => io.appendSummary(`- Deploy gate notification for ${label}: ${summary.outcome}${detail}`))
  safely(() => io.stdout(summaryLine(summary)))
}

/** Never throws. Returns the same body-free summary it prints. */
export async function runDeployGateNotify(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyDeps,
): Promise<NotifySummary> {
  let app = 'unknown'
  let event = 'unknown'
  let summary: NotifySummary
  try {
    const env = readNotifyEnv(environment)
    app = env.app.slice(0, 64) || 'unknown'
    event = env.eventName.slice(0, 64) || 'unknown'
    if (env.webhook === null) {
      summary = {app, event, outcome: 'skipped', attempts: 0, status: null, reason: 'webhook-unset'}
    } else {
      const content = (deps.buildMessage ?? buildGateMessage)(env)
      const result = await sendDiscordMessage({
        webhook: env.webhook,
        content,
        fetch: deps.fetch,
        sleep: deps.sleep,
        timeoutMs: deps.timeoutMs,
      })
      summary = {
        app,
        event,
        outcome: result.outcome,
        attempts: result.attempts,
        status: result.status,
        reason: result.reason,
      }
    }
  } catch {
    summary = {app, event, outcome: 'failed', attempts: 0, status: null, reason: 'internal-error'}
  }
  emit(summary, deps.io)
  return summary
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

function defaultIo(): NotifyIo {
  const stepSummary = process.env.GITHUB_STEP_SUMMARY
  return {
    stdout: line => {
      process.stdout.write(`${line}\n`)
    },
    warn: line => {
      process.stdout.write(`${line}\n`)
    },
    appendSummary: line => {
      if (stepSummary !== undefined && stepSummary !== '') appendFileSync(stepSummary, `${line}\n`)
    },
  }
}

async function main(): Promise<void> {
  try {
    await runDeployGateNotify(process.env, {
      fetch: globalThis.fetch.bind(globalThis),
      sleep: milliseconds => new Promise<void>(resolve => setTimeout(resolve, milliseconds)),
      io: defaultIo(),
    })
  } catch {
    process.stdout.write('::warning::Deploy gate notification failed: unexpected error; the deploy is unaffected\n')
  }
  process.exitCode = 0
}

if (import.meta.main) {
  await main()
}
