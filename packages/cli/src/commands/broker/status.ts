import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {StatusSummary} from '../status'

import {z} from 'zod'

import {httpGet, PUBLIC_PROBE_TIMEOUT_MS} from '../../status/public-probes'
import {validateBrokerHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const DEFAULT_BROKER_URL = 'https://broker.fro.bot'

// ─── HTTP health check ────────────────────────────────────────────────────────

export async function checkBrokerHealth(baseUrl: string): Promise<{ok: boolean; summary: string}> {
  const url = `${baseUrl}/healthz`
  // Operator-facing text: the shared GET primitive keeps the raw error so this summary can include it.
  // The typed, public-safe observation lives in probeBroker (status/public-probes).
  const attempt = await httpGet(url, {timeoutMs: PUBLIC_PROBE_TIMEOUT_MS})
  const elapsedMs = Math.max(0, Math.round(attempt.durationMs))

  if (attempt.kind === 'response') {
    return {
      ok: attempt.ok,
      summary: `GET ${url} → ${attempt.status} (${elapsedMs}ms)`,
    }
  }

  const message = attempt.error instanceof Error ? attempt.error.message : String(attempt.error)
  return {
    ok: false,
    summary: `Request failed after ${elapsedMs}ms: ${message}`,
  }
}

// ─── Unified status summary ───────────────────────────────────────────────────

export async function getBrokerStatusSummary(host: string): Promise<StatusSummary> {
  if (!host) {
    return {
      app: 'broker',
      http: '— (host not set)',
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  const baseUrl = `https://${host}`
  const health = await checkBrokerHealth(baseUrl)

  return {
    app: 'broker',
    http: health.ok ? `OK: ${health.summary}` : `ERROR: ${health.summary}`,
    lastDeploy: '—',
    version: '—',
    contentHash: '—',
    usageStats: '—',
  }
}

// ─── Status action ────────────────────────────────────────────────────────────

export interface BrokerStatusOptions {
  url?: string
  key?: string
  verbose?: boolean
}

export async function brokerStatusAction(options: BrokerStatusOptions, ctx: ActionCtx): Promise<void> {
  let errorCount = 0

  try {
    // --key selects which env var to read the host from; default is BROKER_HOST.
    const hostEnvKey = options.key ?? 'BROKER_HOST'
    const hostFromEnv = process.env[hostEnvKey] ?? process.env.BROKER_DOMAIN ?? process.env.BROKER_HOST
    const baseUrl = options.url ?? hostFromEnv ?? DEFAULT_BROKER_URL

    if (!options.url && !hostFromEnv) {
      ctx.console.log('Broker status')
      ctx.console.log('')
      ctx.console.error(
        '[WARN] Broker host not set. Export BROKER_DOMAIN or BROKER_HOST, or pass --url. Skipping health check.',
      )
      ctx.process.exit(1)
      return
    }

    // Validate the host portion before making any requests
    try {
      const urlObj = new URL(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`)
      validateBrokerHost(urlObj.hostname)
    } catch (error) {
      ctx.console.error(error instanceof Error ? error.message : String(error))
      ctx.process.exit(1)
      return
    }

    ctx.console.log('Broker status')
    ctx.console.log('')

    const health = await checkBrokerHealth(baseUrl.startsWith('http') ? baseUrl : `https://${baseUrl}`)

    if (health.ok) {
      ctx.console.log(`[OK] HTTP reachability`)
      ctx.console.log(`  ${health.summary}`)
    } else {
      ctx.console.log(`[ERROR] HTTP reachability`)
      ctx.console.log(`  ${health.summary}`)
      errorCount++
    }

    ctx.console.log('')
    ctx.console.log(`Summary: 1 check, ${errorCount} errors, 0 warnings`)
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

// ─── Command registration ─────────────────────────────────────────────────────

export function registerBrokerStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('broker status', 'Show operational health of the credential broker.')
    .option(
      '--url [url]',
      z
        .string()
        .describe(
          'Base URL for broker health checks. Falls back to BROKER_DOMAIN, BROKER_HOST, or https://broker.fro.bot.',
        ),
    )
    .option(
      '--key [key]',
      z
        .string()
        .describe('Environment variable name holding the broker host. Falls back to BROKER_DOMAIN when omitted.'),
    )
    .option('--verbose', 'Enable verbose output for all commands')
    .action(brokerStatusAction)
}
