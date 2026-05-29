import type {goke} from 'goke'

import type {ActionCtx} from '../lib/action-ctx'

import {z} from 'zod'

import {getCliproxyStatusSummary} from './cliproxy/status'
import {getGatewayStatusSummary} from './gateway'
import {getKeewebStatusSummary} from './keeweb/status'
import {getUmamiStatusSummary} from './umami'

declare const process: {
  env: Record<string, string | undefined>
}

export interface StatusSummary {
  app: 'keeweb' | 'cliproxy' | 'gateway' | 'umami'
  http: string
  lastDeploy: string
  version: string
  contentHash: string
  usageStats: string
}

type AppName = StatusSummary['app']

interface StatusDependencies {
  getKeewebStatusSummary: (verbose: boolean) => Promise<StatusSummary>
  getCliproxyStatusSummary: (baseUrl: string, key: string, verbose: boolean) => Promise<StatusSummary>
  getGatewayStatusSummary: (host: string) => Promise<StatusSummary>
  getUmamiStatusSummary: (host: string) => Promise<StatusSummary>
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const ERROR_PREFIX = '❌'
const TABLE_COLUMNS: {key: keyof StatusSummary; label: string}[] = [
  {key: 'app', label: 'App'},
  {key: 'http', label: 'HTTP'},
  {key: 'lastDeploy', label: 'Last Deploy'},
  {key: 'version', label: 'Version'},
  {key: 'contentHash', label: 'Content Hash'},
  {key: 'usageStats', label: 'Usage Stats'},
]

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function errorSummary(app: AppName, reason: unknown): StatusSummary {
  const message = reason instanceof Error ? reason.message : String(reason)
  const errorCell = `${ERROR_PREFIX} ${message}`

  return {
    app,
    http: errorCell,
    lastDeploy: errorCell,
    version: errorCell,
    contentHash: errorCell,
    usageStats: errorCell,
  }
}

function toJsonPayload(rows: StatusSummary[]): Record<AppName, StatusSummary> {
  return {
    keeweb: rows.find(row => row.app === 'keeweb') ?? errorSummary('keeweb', 'missing result'),
    cliproxy: rows.find(row => row.app === 'cliproxy') ?? errorSummary('cliproxy', 'missing result'),
    gateway: rows.find(row => row.app === 'gateway') ?? errorSummary('gateway', 'missing result'),
    umami: rows.find(row => row.app === 'umami') ?? errorSummary('umami', 'missing result'),
  }
}

function formatRow(row: StatusSummary): string {
  const values = TABLE_COLUMNS.map(({key}) => row[key])
  return `| ${values.join(' | ')} |`
}

export async function unifiedStatusAction(
  options: {json?: boolean; verbose?: boolean},
  ctx: ActionCtx,
  dependencies: StatusDependencies = {
    getKeewebStatusSummary,
    getCliproxyStatusSummary,
    getGatewayStatusSummary,
    getUmamiStatusSummary,
  },
): Promise<void> {
  const verbose = options.verbose === true
  const cliproxyBaseUrl = stripTrailingSlash(process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
  const cliproxyKey = process.env.CLIPROXY_MANAGEMENT_KEY ?? ''
  const gatewayHost = process.env.GATEWAY_HOST ?? ''
  const umamiHost = process.env.UMAMI_DOMAIN ?? ''

  const results = await Promise.allSettled([
    dependencies.getKeewebStatusSummary(verbose),
    dependencies.getCliproxyStatusSummary(cliproxyBaseUrl, cliproxyKey, verbose),
    dependencies.getGatewayStatusSummary(gatewayHost),
    dependencies.getUmamiStatusSummary(umamiHost),
  ])

  const appNames: AppName[] = ['keeweb', 'cliproxy', 'gateway', 'umami']
  const rows: StatusSummary[] = results.map((result, index) => {
    const app = appNames[index] ?? 'keeweb'
    if (result.status === 'fulfilled') {
      return result.value
    }
    const reason = result.reason
    const message = reason instanceof Error ? reason.message : String(reason)
    ctx.console.error(`${app} status check failed: ${message}`)
    return errorSummary(app, reason)
  })

  if (options.json === true) {
    ctx.console.log(JSON.stringify(toJsonPayload(rows)))
    return
  }

  ctx.console.log('| App | HTTP | Last Deploy | Version | Content Hash | Usage Stats |')
  for (const row of rows) {
    ctx.console.log(formatRow(row))
  }
}

export function registerStatus(
  cli: ReturnType<typeof goke>,
  dependencies: StatusDependencies = {
    getKeewebStatusSummary,
    getCliproxyStatusSummary,
    getGatewayStatusSummary,
    getUmamiStatusSummary,
  },
): void {
  cli
    .command('status', 'Show status of all deployments')
    .option(
      '--json',
      z.boolean().describe('Output machine-readable JSON with keeweb, cliproxy, gateway, and umami summary objects.'),
    )
    .option(
      '--verbose',
      z.boolean().describe('Include verbose per-app health check details when building the summary rows.'),
    )
    .action((options, ctx) => unifiedStatusAction(options, ctx, dependencies))
}
