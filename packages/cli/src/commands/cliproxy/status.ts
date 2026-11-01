import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {AppCollection} from '../../status/collect'
import type {JsonValue} from '../../status/observation'

import {HTTP_TIMEOUT_MS, managementHeaders} from '@marcusrbrown/infra-shared/cliproxy/management'
import {z} from 'zod'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {redactHost} from '../../lib/redact'
import {buildIdentityArgs} from '../../lib/ssh-identity'
import {observe} from '../../status/collect'
import {declaredObservation} from '../../status/declared'
import {httpGet} from '../../status/public-probes'
import {validateCliproxyHost} from './host'

/** Minimal ctx surface consumed by cliproxy status actions. Satisfied by both GokeExecutionContext and CapturedCtx. */
// ActionCtx imported from lib/action-ctx — single source of truth for action ctx shape

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

type CheckLevel = 'ok' | 'warning' | 'error'

interface CheckResult {
  title: string
  level: CheckLevel
  summary: string
  details?: string[]
}

export type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'; signal?: AbortSignal},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'; signal?: AbortSignal},
): ReturnType<SpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<SpawnFn>
}

export function levelLabel(level: CheckLevel): string {
  if (level === 'ok') {
    return 'OK'
  }

  if (level === 'warning') {
    return 'WARN'
  }

  return 'ERROR'
}

export function formatDurationMs(durationMs: number): string {
  return `${Math.max(0, Math.round(durationMs))}ms`
}

export function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

async function parseJsonResponse(response: Response): Promise<unknown> {
  try {
    return await response.json()
  } catch {
    return null
  }
}

export function toNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

export async function checkHttpReachability(url: string, verbose: boolean): Promise<CheckResult> {
  // Operator-facing text: the shared GET primitive keeps the raw error so this summary can include it.
  // The typed, public-safe observation lives in probeCliproxy (status/public-probes).
  const attempt = await httpGet(url, {timeoutMs: HTTP_TIMEOUT_MS})

  if (attempt.kind === 'response') {
    const {response} = attempt
    const details: string[] = []

    if (verbose) {
      details.push(`URL: ${url}`)
      details.push(`Status text: ${response.statusText || '(none)'}`)
      if (response.headers.get('content-type')) {
        details.push(`Content-Type: ${response.headers.get('content-type')}`)
      }
    }

    return {
      title: 'HTTP reachability',
      level: attempt.ok ? 'ok' : 'error',
      summary: `GET ${url} → ${attempt.status} (${formatDurationMs(attempt.durationMs)})`,
      details,
    }
  }

  const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error)

  return {
    title: 'HTTP reachability',
    level: 'error',
    summary: `Request failed after ${formatDurationMs(attempt.durationMs)}: ${message}`,
    details: verbose ? [`URL: ${url}`, `Timeout: ${HTTP_TIMEOUT_MS}ms`] : undefined,
  }
}

/** Count records in a usage-queue array that look like errors/failures. Defensive: only counts when a recognizable field exists. */
function countQueueErrors(records: unknown[]): number {
  let count = 0
  for (const record of records) {
    if (record === null || typeof record !== 'object') {
      continue
    }

    const rec = record as Record<string, unknown>

    // Status field >= 400 indicates an HTTP-level error
    const status = toNumber(rec.status)
    if (status !== null && status >= 400) {
      count++
      continue
    }

    // Explicit error/failure markers
    if (rec.error !== undefined || rec.failed === true || rec.failure === true) {
      count++
    }
  }

  return count
}

export async function checkUsageStats(baseUrl: string, key: string): Promise<CheckResult> {
  const endpoint = `${baseUrl}/v0/management/usage-queue?count=50`

  try {
    const response = await fetch(endpoint, {
      headers: managementHeaders(key),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (response.status === 429) {
      return {
        title: 'Usage stats',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      }
    }

    if (!response.ok) {
      return {
        title: 'Usage stats',
        level: 'error',
        summary: `GET /v0/management/usage-queue failed with HTTP ${response.status}`,
      }
    }

    const payload = await parseJsonResponse(response)

    if (!Array.isArray(payload)) {
      return {
        title: 'Usage stats',
        level: 'warning',
        summary: 'Usage-queue response was not an array — cannot parse recent activity.',
      }
    }

    const total = payload.length
    const errors = countQueueErrors(payload)

    if (total === 0) {
      return {
        title: 'Usage stats',
        level: 'ok',
        summary: 'recent: 0 (idle)',
      }
    }

    return {
      title: 'Usage stats',
      level: errors > 0 ? 'warning' : 'ok',
      summary: errors > 0 ? `recent: ${total}, errors: ${errors}` : `recent: ${total}`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      title: 'Usage stats',
      level: 'error',
      summary: `Unable to read usage stats: ${message}`,
    }
  }
}

export async function checkVersion(baseUrl: string, key: string): Promise<CheckResult> {
  const endpoint = `${baseUrl}/v0/management/latest-version`

  try {
    const response = await fetch(endpoint, {
      headers: managementHeaders(key),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (response.status === 429) {
      return {
        title: 'Latest available version',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      }
    }

    if (!response.ok) {
      return {
        title: 'Latest available version',
        level: 'error',
        summary: `GET /v0/management/latest-version failed with HTTP ${response.status}`,
      }
    }

    const payload = await parseJsonResponse(response)

    if (payload && typeof payload === 'object') {
      const version = (payload as Record<string, unknown>)['latest-version']
      if (typeof version === 'string' && version.length > 0) {
        return {title: 'Latest available version', level: 'ok', summary: version}
      }
    }

    return {
      title: 'Latest available version',
      level: 'warning',
      summary: 'Response did not include a latest-version string.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {title: 'Latest available version', level: 'error', summary: `Unable to check latest version: ${message}`}
  }
}

export type RunningContainer =
  {kind: 'running'; version: string} | {kind: 'none'} | {kind: 'unavailable'; summary: string}

/** Ask the host which CLIProxyAPI image is running. Never throws: SSH problems come back as `unavailable`. */
export async function inspectRunningContainer(
  host: string,
  spawn: SpawnFn = defaultSpawn,
  signal?: AbortSignal,
): Promise<RunningContainer> {
  let cleanup: () => void = () => undefined

  try {
    validateCliproxyHost(host)

    const knownHostsArgs = buildKnownHostsArgs()
    const identity = buildIdentityArgs(process.env.CLIPROXY_SSH_KEY)
    cleanup = identity.cleanup

    const sshCmd = [
      'ssh',
      '-o',
      'BatchMode=yes',
      '-o',
      'ConnectTimeout=10',
      '-o',
      'StrictHostKeyChecking=yes',
      ...knownHostsArgs,
      ...identity.args,
      `root@${host}`,
      `docker ps --format '{{.Image}}'`,
    ]

    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      HOME: process.env.HOME ?? '/tmp',
      ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
    }

    const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe', ...(signal === undefined ? {} : {signal})})
    const [stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])

    if (exitCode !== 0) {
      return {
        kind: 'unavailable',
        summary: `SSH command failed (exit ${exitCode}): ${redactHost(stderrText.trim(), host) || 'unknown error'}`,
      }
    }

    const imageMatch = /(?:^|\s)eceasy\/cli-proxy-api:([^\s@]+)/m.exec(stdoutText)
    return imageMatch ? {kind: 'running', version: imageMatch[1] ?? 'unknown'} : {kind: 'none'}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {kind: 'unavailable', summary: `Unable to check running version via SSH: ${message}`}
  } finally {
    cleanup()
  }
}

export async function checkRunningVersion(host: string, spawn: SpawnFn = defaultSpawn): Promise<CheckResult> {
  const container = await inspectRunningContainer(host, spawn)

  if (container.kind === 'running') {
    return {title: 'Running version', level: 'ok', summary: container.version}
  }

  if (container.kind === 'none') {
    return {title: 'Running version', level: 'warning', summary: 'No running eceasy/cli-proxy-api container found.'}
  }

  return {title: 'Running version', level: 'warning', summary: container.summary}
}

const DEFAULT_PROVIDER_MODEL = 'claude-sonnet-4-6'

export interface ProviderAuthOptions {
  model?: string
  verbose?: boolean
}

export type ProviderAuthState = 'healthy' | 'dead' | 'unknown'

export type ProviderAuthReason =
  'ok' | 'auth-401' | 'auth-unavailable-503' | 'provider-missing' | 'unrelated-http' | 'timeout' | 'network'

export interface ProviderAuthClassification {
  state: ProviderAuthState
  reason: ProviderAuthReason
}

interface ProviderAuthProbeResult {
  classification: ProviderAuthClassification
  human: CheckResult
}

async function readBodyText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

const PROVIDER_MISSING_MESSAGE = /unknown provider for model/i

/**
 * A 400 means the provider is not registered when the body carries `error.code === 'model_not_found'`
 * or the "unknown provider for model" message. Non-JSON bodies fall back to the message regex on raw text.
 */
function isProviderMissingBody(bodyText: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(bodyText)
  } catch {
    return PROVIDER_MISSING_MESSAGE.test(bodyText)
  }
  if (typeof parsed === 'object' && parsed !== null && 'error' in parsed) {
    const {error} = parsed
    if (typeof error === 'object' && error !== null) {
      if ('code' in error && error.code === 'model_not_found') return true
      if ('message' in error && typeof error.message === 'string') return PROVIDER_MISSING_MESSAGE.test(error.message)
    }
  }
  return PROVIDER_MISSING_MESSAGE.test(bodyText)
}

/**
 * Probe the upstream provider auth by sending a minimal chat completion request.
 * Returns a CheckResult — never throws.
 *
 * - 200 → ok
 * - 401 OR (503 with auth-unavailable body markers) → error with remediation hint
 * - 400 with model_not_found / "unknown provider for model" (provider not registered) → error with remediation hint
 * - other non-2xx → warning (don't fail status on unrelated upstream issues)
 * - fetch throw (timeout/network) → warning (flaky probe should not fail status)
 *
 * The apiKey is NEVER included in summary or details output.
 */
async function runProviderAuthProbe(
  baseUrl: string,
  apiKey: string,
  options?: ProviderAuthOptions,
): Promise<ProviderAuthProbeResult> {
  const model = options?.model ?? DEFAULT_PROVIDER_MODEL
  const verbose = options?.verbose === true
  const endpoint = `${baseUrl}/v1/chat/completions`

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [{role: 'user', content: 'ping'}],
        max_tokens: 1,
      }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    const details: string[] = []
    if (verbose) {
      details.push(`URL: ${endpoint}`)
      details.push(`Model: ${model}`)
      details.push(`Status: ${response.status}`)
    }

    if (response.ok) {
      return {
        classification: {state: 'healthy', reason: 'ok'},
        human: {
          title: 'Upstream provider auth (anthropic)',
          level: 'ok',
          summary: `anthropic route OK (${model})`,
          details: details.length > 0 ? details : undefined,
        },
      }
    }

    // 401 is always an auth failure
    if (response.status === 401) {
      return {
        classification: {state: 'dead', reason: 'auth-401'},
        human: {
          title: 'Upstream provider auth (anthropic)',
          level: 'error',
          summary: `Anthropic upstream auth unavailable (${response.status}) — run: cliproxy login claude`,
          details: details.length > 0 ? details : undefined,
        },
      }
    }

    // The body is read at most once: only 400 and 503 consult it, and each is a distinct status.
    // 400 model_not_found: the proxy has no provider registered for the model (e.g. credential lost)
    if (response.status === 400) {
      const bodyText = await readBodyText(response)

      if (isProviderMissingBody(bodyText)) {
        return {
          classification: {state: 'dead', reason: 'provider-missing'},
          human: {
            title: 'Upstream provider auth (anthropic)',
            level: 'error',
            summary: `Anthropic provider not registered for ${model} (HTTP ${response.status}) — check /v1/models; run: cliproxy login claude`,
            details: details.length > 0 ? details : undefined,
          },
        }
      }
    }

    // 503 may be auth_unavailable — check body for known markers
    if (response.status === 503) {
      const bodyText = await readBodyText(response)

      const isAuthUnavailable = /auth_unavailable|no auth available|providers=claude/i.test(bodyText)

      if (isAuthUnavailable) {
        return {
          classification: {state: 'dead', reason: 'auth-unavailable-503'},
          human: {
            title: 'Upstream provider auth (anthropic)',
            level: 'error',
            summary: `Anthropic upstream auth unavailable (${response.status}) — run: cliproxy login claude`,
            details: details.length > 0 ? details : undefined,
          },
        }
      }
    }

    // Any other non-2xx: warning (don't fail status on unrelated upstream issues)
    return {
      classification: {state: 'unknown', reason: 'unrelated-http'},
      human: {
        title: 'Upstream provider auth (anthropic)',
        level: 'warning',
        summary: `Anthropic probe returned HTTP ${response.status}`,
        details: details.length > 0 ? details : undefined,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const errorName = error instanceof Error ? error.name : ''
    const isTimeout = /timeout|timed out|aborted/i.test(`${errorName} ${message}`)
    return {
      classification: {state: 'unknown', reason: isTimeout ? 'timeout' : 'network'},
      human: {
        title: 'Upstream provider auth (anthropic)',
        level: 'warning',
        summary: `Anthropic probe failed: ${message}`,
        details: verbose ? [`URL: ${endpoint}`, `Model: ${model}`] : undefined,
      },
    }
  }
}

export async function checkProviderAuthState(
  baseUrl: string,
  apiKey: string,
  options?: ProviderAuthOptions,
): Promise<ProviderAuthClassification> {
  const probe = await runProviderAuthProbe(baseUrl, apiKey, options)
  return probe.classification
}

export async function checkProviderAuth(
  baseUrl: string,
  apiKey: string,
  options?: ProviderAuthOptions,
): Promise<CheckResult> {
  const probe = await runProviderAuthProbe(baseUrl, apiKey, options)
  return probe.human
}

export type ManagementAccess = 'ok' | 'no-key' | 'denied' | 'rate-limited' | 'unavailable'

interface ManagementAuthFailure {
  access: Exclude<ManagementAccess, 'ok' | 'no-key'>
  result: CheckResult
}

/**
 * Probe the management API with a cheap auth check before issuing parallel calls.
 * Returns null on success, or the failure with its `managementAccess` class: 401/403 `denied`, 429
 * `rate-limited`, anything else (5xx, other statuses, network errors) `unavailable`.
 * Never throws.
 */
async function probeManagementAuth(baseUrl: string, key: string): Promise<ManagementAuthFailure | null> {
  const endpoint = `${baseUrl}/v0/management/config`

  try {
    const response = await fetch(endpoint, {
      headers: managementHeaders(key),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (response.ok) {
      return null
    }

    if (response.status === 403) {
      // Could be an IP ban — inspect body for ban-ish markers
      const payload = await parseJsonResponse(response)
      const isBanBody =
        payload !== null &&
        typeof payload === 'object' &&
        Object.values(payload as Record<string, unknown>).some(
          v => typeof v === 'string' && /\b(?:ip[- ]?)?bann?ed\b/i.test(v),
        )

      if (isBanBody) {
        return {
          access: 'denied',
          result: {
            title: 'Management access',
            level: 'error',
            summary: 'IP banned — stop retrying for ~30 min. Management checks skipped.',
          },
        }
      }

      return {
        access: 'denied',
        result: {
          title: 'Management access',
          level: 'error',
          summary: 'Management API returned HTTP 403. Management checks skipped.',
        },
      }
    }

    if (response.status === 401) {
      return {
        access: 'denied',
        result: {
          title: 'Management access',
          level: 'error',
          summary: 'Management API returned HTTP 401 (invalid key). Management checks skipped.',
        },
      }
    }

    return {
      access: response.status === 429 ? 'rate-limited' : 'unavailable',
      result: {
        title: 'Management access',
        level: 'warning',
        summary: `Management auth probe returned HTTP ${response.status}. Management checks skipped.`,
      },
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      access: 'unavailable',
      result: {
        title: 'Management access',
        level: 'error',
        summary: `Management auth probe failed: ${message}`,
      },
    }
  }
}

type ManagementChecks =
  | {kind: 'no-key'}
  | {kind: 'auth-failure'; result: CheckResult; access: ManagementAuthFailure['access']}
  | {kind: 'checks'; usage: CheckResult; version: CheckResult}

/**
 * Run management checks with single probe + parallel data fetches.
 * Returns a discriminated union so callers handle no-key, auth-failure, and success distinctly.
 */
async function runManagementChecks(baseUrl: string, key: string | undefined): Promise<ManagementChecks> {
  if (!key) {
    return {kind: 'no-key'}
  }

  const authFailure = await probeManagementAuth(baseUrl, key)
  if (authFailure !== null) {
    return {kind: 'auth-failure', result: authFailure.result, access: authFailure.access}
  }

  const [usage, version] = await Promise.all([checkUsageStats(baseUrl, key), checkVersion(baseUrl, key)])
  return {kind: 'checks', usage, version}
}

function printCheckResult(result: CheckResult, ctx: ActionCtx): void {
  ctx.console.log(`[${levelLabel(result.level)}] ${result.title}`)
  ctx.console.log(`  ${result.summary}`)

  if (result.details && result.details.length > 0) {
    for (const detail of result.details) {
      ctx.console.log(`  - ${detail}`)
    }
  }
}

const RUNNING_VERSION_NOT_CHECKED_SUMMARY = 'Not checked for explicit URL override.'

function getRunningVersionNotChecked(host: string): CheckResult {
  try {
    validateCliproxyHost(host)
    return {title: 'Running version', level: 'warning', summary: RUNNING_VERSION_NOT_CHECKED_SUMMARY}
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {title: 'Running version', level: 'warning', summary: `Unable to validate running-version host: ${message}`}
  }
}

/** Read the recent-window counts back out of a `checkUsageStats` summary (`recent: N` / `recent: N, errors: M`). */
function parseUsageCounts(result: CheckResult): {recent: number; errors: number} | null {
  const recentMatch = /recent:\s*(\d+)/.exec(result.summary)
  if (!recentMatch) {
    return null
  }
  const errorMatch = /errors:\s*(\d+)/.exec(result.summary)
  return {recent: Number(recentMatch[1]), errors: errorMatch ? Number(errorMatch[1]) : 0}
}

export function formatUsageSummaryLine(result: CheckResult): string | null {
  const counts = parseUsageCounts(result)
  if (counts === null) {
    return null
  }
  return `Recent requests: ${counts.recent}${counts.errors > 0 ? `, ${counts.errors} errors` : ''}`
}

/**
 * Unified-status collector. Reachability comes from the shared public probe, so this supplies the SSH
 * container observation plus facts: the running and latest versions and recent usage (null when the
 * management API could not say; `managementAccess` says why).
 */
export async function getCliproxyStatusSummary(
  baseUrl: string,
  key: string,
  spawn: SpawnFn = defaultSpawn,
  signal?: AbortSignal,
): Promise<AppCollection> {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl)
  const host = new URL(normalizedBaseUrl).hostname
  const [mgmt, running] = await Promise.all([
    runManagementChecks(normalizedBaseUrl, key || undefined),
    inspectRunningContainer(host, spawn, signal),
  ])

  const spec = declaredObservation('cliproxy', 'container-running')
  let container
  if (running.kind === 'running') {
    container = observe(spec, 'pass')
  } else if (running.kind === 'none') {
    container = observe(spec, 'fail', {detail: {reason: 'not-running'}})
  } else {
    container = observe(spec, 'unknown', {detail: {reason: 'ssh-failed'}})
  }

  let managementAccess: ManagementAccess = 'ok'
  let latestVersion: string | null = null
  let usage: JsonValue = null
  if (mgmt.kind === 'no-key') {
    managementAccess = 'no-key'
  } else if (mgmt.kind === 'auth-failure') {
    managementAccess = mgmt.access
  } else {
    latestVersion = mgmt.version.level === 'ok' ? mgmt.version.summary : null
    usage = parseUsageCounts(mgmt.usage)
  }

  return {
    observations: [container],
    facts: {
      runningVersion: running.kind === 'running' ? running.version : null,
      latestVersion,
      usage,
      managementAccess,
    },
  }
}

export interface StatusOptions {
  url?: string
  key?: string
  /** Downstream API key (bearer) for the upstream provider-auth probe. Maps from --api-key CLI flag. */
  apiKey?: string
  verbose?: boolean
}

export async function cliproxyStatusAction(
  options: StatusOptions,
  ctx: ActionCtx,
  spawn: SpawnFn = defaultSpawn,
): Promise<void> {
  let errorCount = 0
  try {
    const verbose = options.verbose === true
    const baseUrl = stripTrailingSlash(options.url ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)

    // Trusted URL: the canonical configured/default host, trailing-slash-normalized.
    // Ambient env keys must ONLY follow to this trusted destination to prevent
    // secret exfiltration when an agent passes an attacker-controlled --url.
    const trustedUrl = stripTrailingSlash(process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
    const urlIsExplicitlyOverridden = options.url !== undefined && baseUrl !== trustedUrl

    // An explicit --key is always honored (operator knows what they're doing).
    // An ambient env key is only forwarded when the resolved baseUrl is trusted.
    const managementKey = options.key ?? (urlIsExplicitlyOverridden ? undefined : process.env.CLIPROXY_MANAGEMENT_KEY)

    // Provider (downstream) API key for the upstream provider-auth probe.
    // Same trusted-URL guard: ambient CLIPROXY_API_KEY only follows to the trusted URL.
    const providerKey = options.apiKey ?? (urlIsExplicitlyOverridden ? undefined : process.env.CLIPROXY_API_KEY)

    ctx.console.log('CLIProxyAPI status')
    ctx.console.log('')

    const host = new URL(baseUrl).hostname
    const runningCheck = urlIsExplicitlyOverridden
      ? Promise.resolve(getRunningVersionNotChecked(host))
      : checkRunningVersion(host, spawn)
    const [httpResult, runningResult] = await Promise.all([
      checkHttpReachability(`${baseUrl}/healthz`, verbose),
      runningCheck,
    ])
    const results: CheckResult[] = [httpResult, runningResult]

    let capturedUsageResult: CheckResult | undefined

    const mgmt = await runManagementChecks(baseUrl, managementKey)

    if (mgmt.kind === 'no-key') {
      results.push({
        title: 'Management checks',
        level: 'warning',
        summary:
          'CLIPROXY_MANAGEMENT_KEY is not set. Skipping usage stats and version checks. Provide --key or set env var.',
      })
    } else if (mgmt.kind === 'auth-failure') {
      results.push(mgmt.result)
    } else {
      capturedUsageResult = mgmt.usage
      results.push(mgmt.usage, mgmt.version)
    }

    // Upstream provider-auth probe — only when a downstream API key is available.
    if (providerKey) {
      results.push(await checkProviderAuth(baseUrl, providerKey, {verbose}))
    } else {
      results.push({
        title: 'Upstream provider auth',
        level: 'warning',
        summary: 'CLIPROXY_API_KEY not set — skipping upstream provider probe.',
      })
    }

    for (const result of results) {
      printCheckResult(result, ctx)
      ctx.console.log('')
    }

    errorCount = results.filter(result => result.level === 'error').length
    const warningCount = results.filter(result => result.level === 'warning').length

    ctx.console.log(`Summary: ${results.length} checks, ${errorCount} errors, ${warningCount} warnings`)

    if (capturedUsageResult) {
      const usageLine = formatUsageSummaryLine(capturedUsageResult)
      if (usageLine) {
        ctx.console.log(usageLine)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
    return
  }

  if (errorCount > 0) {
    ctx.process.exit(1)
  }
}

export function registerCliproxyStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy status', 'Show operational health of CLIProxyAPI and its management endpoints.')
    .option(
      '--url [url]',
      z
        .string()
        .describe('Base URL for CLIProxyAPI health checks. Falls back to CLIPROXY_URL or https://cliproxy.fro.bot.'),
    )
    .option(
      '--key [key]',
      z.string().describe('Management API key. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .option(
      '--api-key [key]',
      z
        .string()
        .describe(
          'Downstream API key (bearer) for the upstream provider-auth probe. Falls back to CLIPROXY_API_KEY. Skipped when absent.',
        ),
    )
    .option('--verbose', 'Enable verbose output for all commands')
    .action(cliproxyStatusAction)
}
