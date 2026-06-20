import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {StatusSummary} from '../status'

import {z} from 'zod'

import {HTTP_TIMEOUT_MS, managementHeaders} from './shared'

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
  const startedAt = performance.now()

  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })
    const elapsedMs = performance.now() - startedAt
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
      level: response.ok ? 'ok' : 'error',
      summary: `GET ${url} → ${response.status} (${formatDurationMs(elapsedMs)})`,
      details,
    }
  } catch (error) {
    const elapsedMs = performance.now() - startedAt
    const message = error instanceof Error ? error.message : String(error)

    return {
      title: 'HTTP reachability',
      level: 'error',
      summary: `Request failed after ${formatDurationMs(elapsedMs)}: ${message}`,
      details: verbose ? [`URL: ${url}`, `Timeout: ${HTTP_TIMEOUT_MS}ms`] : undefined,
    }
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
        title: 'Latest version',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      }
    }

    if (!response.ok) {
      return {
        title: 'Latest version',
        level: 'error',
        summary: `GET /v0/management/latest-version failed with HTTP ${response.status}`,
      }
    }

    const payload = await parseJsonResponse(response)

    if (payload && typeof payload === 'object') {
      const version = (payload as Record<string, unknown>)['latest-version']
      if (typeof version === 'string' && version.length > 0) {
        return {title: 'Latest version', level: 'ok', summary: version}
      }
    }

    return {
      title: 'Latest version',
      level: 'warning',
      summary: 'Response did not include a latest-version string.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {title: 'Latest version', level: 'error', summary: `Unable to check latest version: ${message}`}
  }
}

const DEFAULT_PROVIDER_MODEL = 'claude-sonnet-4-6'

export interface ProviderAuthOptions {
  model?: string
  verbose?: boolean
}

/**
 * Probe the upstream provider auth by sending a minimal chat completion request.
 * Returns a CheckResult — never throws.
 *
 * - 200 → ok
 * - 401 OR (503 with auth-unavailable body markers) → error with remediation hint
 * - other non-2xx → warning (don't fail status on unrelated upstream issues)
 * - fetch throw (timeout/network) → warning (flaky probe should not fail status)
 *
 * The apiKey is NEVER included in summary or details output.
 */
export async function checkProviderAuth(
  baseUrl: string,
  apiKey: string,
  options?: ProviderAuthOptions,
): Promise<CheckResult> {
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
        title: 'Upstream provider auth (anthropic)',
        level: 'ok',
        summary: `anthropic route OK (${model})`,
        details: details.length > 0 ? details : undefined,
      }
    }

    // 401 is always an auth failure
    if (response.status === 401) {
      return {
        title: 'Upstream provider auth (anthropic)',
        level: 'error',
        summary: `Anthropic upstream auth unavailable (${response.status}) — run: cliproxy login claude`,
        details: details.length > 0 ? details : undefined,
      }
    }

    // 503 may be auth_unavailable — check body for known markers
    if (response.status === 503) {
      let bodyText = ''
      try {
        bodyText = await response.text()
      } catch {
        // ignore body read failure
      }

      const isAuthUnavailable = /auth_unavailable|no auth available|providers=claude/i.test(bodyText)

      if (isAuthUnavailable) {
        return {
          title: 'Upstream provider auth (anthropic)',
          level: 'error',
          summary: `Anthropic upstream auth unavailable (${response.status}) — run: cliproxy login claude`,
          details: details.length > 0 ? details : undefined,
        }
      }
    }

    // Any other non-2xx: warning (don't fail status on unrelated upstream issues)
    return {
      title: 'Upstream provider auth (anthropic)',
      level: 'warning',
      summary: `Anthropic probe returned HTTP ${response.status}`,
      details: details.length > 0 ? details : undefined,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      title: 'Upstream provider auth (anthropic)',
      level: 'warning',
      summary: `Anthropic probe failed: ${message}`,
      details: verbose ? [`URL: ${endpoint}`, `Model: ${model}`] : undefined,
    }
  }
}

/**
 * Probe the management API with a cheap auth check before issuing parallel calls.
 * Returns null on success, or a CheckResult describing the auth failure.
 * Never throws.
 */
async function probeManagementAuth(baseUrl: string, key: string): Promise<CheckResult | null> {
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
          title: 'Management access',
          level: 'error',
          summary: 'IP banned — stop retrying for ~30 min. Management checks skipped.',
        }
      }

      return {
        title: 'Management access',
        level: 'error',
        summary: 'Management API returned HTTP 403. Management checks skipped.',
      }
    }

    if (response.status === 401) {
      return {
        title: 'Management access',
        level: 'error',
        summary: 'Management API returned HTTP 401 (invalid key). Management checks skipped.',
      }
    }

    return {
      title: 'Management access',
      level: 'warning',
      summary: `Management auth probe returned HTTP ${response.status}. Management checks skipped.`,
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      title: 'Management access',
      level: 'error',
      summary: `Management auth probe failed: ${message}`,
    }
  }
}

type ManagementChecks =
  | {kind: 'no-key'}
  | {kind: 'auth-failure'; result: CheckResult}
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
    return {kind: 'auth-failure', result: authFailure}
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

function formatCheckSummary(result: CheckResult): string {
  return `${levelLabel(result.level)}: ${result.summary}`
}

export function formatUsageSummaryLine(result: CheckResult): string | null {
  // v7 recent-window format: "recent: N" or "recent: N, errors: M"
  const recentMatch = /recent:\s*(\d+)/.exec(result.summary)
  if (!recentMatch) {
    return null
  }
  const total = Number(recentMatch[1])
  const errorMatch = /errors:\s*(\d+)/.exec(result.summary)
  const errors = errorMatch ? Number(errorMatch[1]) : 0
  return `Recent requests: ${total}${errors > 0 ? `, ${errors} errors` : ''}`
}

export async function getCliproxyStatusSummary(baseUrl: string, key: string, verbose: boolean): Promise<StatusSummary> {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl)
  const [httpResult, mgmt] = await Promise.all([
    checkHttpReachability(`${normalizedBaseUrl}/healthz`, verbose),
    runManagementChecks(normalizedBaseUrl, key || undefined),
  ])

  let version: string
  let usageStats: string

  if (mgmt.kind === 'no-key') {
    version = '— (no key)'
    usageStats = '— (no key)'
  } else if (mgmt.kind === 'auth-failure') {
    const authSummary = formatCheckSummary(mgmt.result)
    version = authSummary
    usageStats = authSummary
  } else {
    version = formatCheckSummary(mgmt.version)
    usageStats = formatCheckSummary(mgmt.usage)
  }

  return {
    app: 'cliproxy',
    http: formatCheckSummary(httpResult),
    lastDeploy: '—',
    version,
    contentHash: '—',
    usageStats,
  }
}

export interface StatusOptions {
  url?: string
  key?: string
  /** Downstream API key (bearer) for the upstream provider-auth probe. Maps from --api-key CLI flag. */
  apiKey?: string
  verbose?: boolean
}

export async function cliproxyStatusAction(options: StatusOptions, ctx: ActionCtx): Promise<void> {
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

    const results: CheckResult[] = [await checkHttpReachability(`${baseUrl}/healthz`, verbose)]

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
