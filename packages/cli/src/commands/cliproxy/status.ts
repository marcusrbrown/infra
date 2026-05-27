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

export async function checkUsageStats(baseUrl: string, key: string): Promise<CheckResult> {
  const endpoint = `${baseUrl}/v0/management/usage`

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
        summary: `GET /v0/management/usage failed with HTTP ${response.status}`,
      }
    }

    const payload = await parseJsonResponse(response)
    const top = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
    const usage = top.usage && typeof top.usage === 'object' ? (top.usage as Record<string, unknown>) : top
    const totalRequests = toNumber(usage.total_requests)
    const failureCount = toNumber(usage.failure_count)

    if (totalRequests === null || failureCount === null) {
      return {
        title: 'Usage stats',
        level: 'warning',
        summary: 'Management usage payload is missing expected numeric fields.',
      }
    }

    return {
      title: 'Usage stats',
      level: failureCount > 0 ? 'warning' : 'ok',
      summary:
        failureCount > 0
          ? `total_requests=${totalRequests}, failure_count=${failureCount} (token refresh likely needed)`
          : `total_requests=${totalRequests}, failure_count=${failureCount}`,
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
  const totalMatch = /total_requests=(\d+)/.exec(result.summary)
  const failureMatch = /failure_count=(\d+)/.exec(result.summary)

  if (!totalMatch || !failureMatch) {
    return null
  }

  const total = Number(totalMatch[1])
  const failed = Number(failureMatch[1])
  const failureRate = total === 0 ? 0 : (failed / total) * 100

  return `Requests: ${total} total, ${failed} failed (${failureRate.toFixed(1)}% failure rate)`
}

export async function getCliproxyStatusSummary(baseUrl: string, key: string, verbose: boolean): Promise<StatusSummary> {
  const normalizedBaseUrl = stripTrailingSlash(baseUrl)
  const httpPromise = checkHttpReachability(normalizedBaseUrl, verbose)
  const managementResultsPromise = key
    ? Promise.all([checkUsageStats(normalizedBaseUrl, key), checkVersion(normalizedBaseUrl, key)])
    : Promise.resolve(null)

  const [httpResult, managementResults] = await Promise.all([httpPromise, managementResultsPromise])
  const [usageResult, versionResult] = managementResults ?? [null, null]

  return {
    app: 'cliproxy',
    http: formatCheckSummary(httpResult),
    lastDeploy: '—',
    version: versionResult ? formatCheckSummary(versionResult) : '— (no key)',
    contentHash: '—',
    usageStats: usageResult ? formatCheckSummary(usageResult) : '— (no key)',
  }
}

export interface StatusOptions {
  url?: string
  key?: string
  verbose?: boolean
}

export async function cliproxyStatusAction(options: StatusOptions, ctx: ActionCtx): Promise<void> {
  let errorCount = 0
  try {
    const verbose = options.verbose === true
    const baseUrl = stripTrailingSlash(options.url ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
    const managementKey = options.key ?? process.env.CLIPROXY_MANAGEMENT_KEY

    ctx.console.log('CLIProxyAPI status')
    ctx.console.log('')

    const results: CheckResult[] = [await checkHttpReachability(baseUrl, verbose)]

    let capturedUsageResult: CheckResult | undefined

    if (managementKey) {
      const [usageResult, versionResult] = await Promise.all([
        checkUsageStats(baseUrl, managementKey),
        checkVersion(baseUrl, managementKey),
      ])

      capturedUsageResult = usageResult
      results.push(usageResult, versionResult)
    } else {
      results.push({
        title: 'Management checks',
        level: 'warning',
        summary:
          'CLIPROXY_MANAGEMENT_KEY is not set. Skipping usage stats and version checks. Provide --key or set env var.',
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
    .option('--verbose', 'Enable verbose output for all commands')
    .action(cliproxyStatusAction)
}
