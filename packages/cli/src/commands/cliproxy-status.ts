import type {goke} from 'goke'

import {z} from 'zod'

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const HTTP_TIMEOUT_MS = 10_000

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

function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('authorization', `Bearer ${key}`)
  headers.set('x-management-key', key)
  return headers
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
    const record = payload && typeof payload === 'object' ? payload : {}
    const totalRequests = toNumber((record as Record<string, unknown>).total_requests)
    const failureCount = toNumber((record as Record<string, unknown>).failure_count)

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
        title: 'Current version',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      }
    }

    if (!response.ok) {
      return {
        title: 'Current version',
        level: 'error',
        summary: `GET /v0/management/latest-version failed with HTTP ${response.status}`,
      }
    }

    const payload = await parseJsonResponse(response)

    if (typeof payload === 'string' && payload.length > 0) {
      return {
        title: 'Current version',
        level: 'ok',
        summary: payload,
      }
    }

    if (payload && typeof payload === 'object') {
      const version = (payload as Record<string, unknown>).version
      if (typeof version === 'string' && version.length > 0) {
        return {
          title: 'Current version',
          level: 'ok',
          summary: version,
        }
      }
    }

    return {
      title: 'Current version',
      level: 'warning',
      summary: 'Management version payload did not include a usable version string.',
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      title: 'Current version',
      level: 'error',
      summary: `Unable to read current version: ${message}`,
    }
  }
}

function printCheckResult(result: CheckResult): void {
  console.log(`[${levelLabel(result.level)}] ${result.title}`)
  console.log(`  ${result.summary}`)

  if (result.details && result.details.length > 0) {
    for (const detail of result.details) {
      console.log(`  - ${detail}`)
    }
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
      z.string().describe('Management API bearer token. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .action(async options => {
      const verbose = options.verbose === true
      const baseUrl = stripTrailingSlash(options.url ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
      const managementKey = options.key ?? process.env.CLIPROXY_MANAGEMENT_KEY

      console.log('CLIProxyAPI status')
      console.log('')

      const results: CheckResult[] = [await checkHttpReachability(baseUrl, verbose)]

      if (managementKey) {
        const [usageResult, versionResult] = await Promise.all([
          checkUsageStats(baseUrl, managementKey),
          checkVersion(baseUrl, managementKey),
        ])

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
        printCheckResult(result)
        console.log('')
      }

      const errorCount = results.filter(result => result.level === 'error').length
      const warningCount = results.filter(result => result.level === 'warning').length

      console.log(`Summary: ${results.length} checks, ${errorCount} errors, ${warningCount} warnings`)

      if (errorCount > 0) {
        process.exitCode = 1
      }
    })
}
