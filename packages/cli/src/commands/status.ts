import type {goke} from 'goke'

import {z} from 'zod'

import {getCliproxyStatusSummary} from './cliproxy/status'
import {getKeewebStatusSummary} from './keeweb/status'

declare const process: {
  env: Record<string, string | undefined>
}

export interface StatusSummary {
  app: 'keeweb' | 'cliproxy'
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
  }
}

function formatRow(row: StatusSummary): string {
  const values = TABLE_COLUMNS.map(({key}) => row[key])
  return `| ${values.join(' | ')} |`
}

export function registerStatus(
  cli: ReturnType<typeof goke>,
  dependencies: StatusDependencies = {
    getKeewebStatusSummary,
    getCliproxyStatusSummary,
  },
): void {
  cli
    .command('status', 'Show status of all deployments')
    .option('--json', z.boolean().describe('Output machine-readable JSON with keeweb and cliproxy summary objects.'))
    .option(
      '--verbose',
      z.boolean().describe('Include verbose per-app health check details when building the summary rows.'),
    )
    .action(async options => {
      const verbose = options.verbose === true
      const cliproxyBaseUrl = stripTrailingSlash(process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
      const cliproxyKey = process.env.CLIPROXY_MANAGEMENT_KEY ?? ''

      const results = await Promise.allSettled([
        dependencies.getKeewebStatusSummary(verbose),
        dependencies.getCliproxyStatusSummary(cliproxyBaseUrl, cliproxyKey, verbose),
      ])

      const rows: StatusSummary[] = results.map((result, index) => {
        const app: AppName = index === 0 ? 'keeweb' : 'cliproxy'
        return result.status === 'fulfilled' ? result.value : errorSummary(app, result.reason)
      })

      if (options.json === true) {
        console.log(JSON.stringify(toJsonPayload(rows)))
        return
      }

      console.log('| App | HTTP | Last Deploy | Version | Content Hash | Usage Stats |')
      for (const row of rows) {
        console.log(formatRow(row))
      }
    })
}
