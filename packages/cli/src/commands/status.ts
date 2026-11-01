import type {goke} from 'goke'

import type {ActionCtx} from '../lib/action-ctx'
import type {AppCollection} from '../status/collect'
import type {CollectorOutcome, ProbeOutcome} from '../status/declared'
import type {
  AppId,
  AppStatus,
  Observation,
  ObservationKind,
  ObservationResult,
  StatusEnvelope,
} from '../status/observation'
import type {ProbeOptions} from '../status/public-probes'

import {z} from 'zod'
import {assembleAppStatus, worstResult} from '../status/declared'
import {APP_IDS, STATUS_SCHEMA_VERSION} from '../status/observation'
import {PUBLIC_PROBES} from '../status/public-probes'
import {getCliproxyStatusSummary} from './cliproxy/status'
import {getDashboardStatusSummary} from './dashboard'
import {getGatewayStatusSummary} from './gateway'
import {getKeewebStatusSummary} from './keeweb/status'
import {getUmamiStatusSummary} from './umami'
import {getVpnStatusSummary} from './vpn'

declare const process: {
  env: Record<string, string | undefined>
}

type PublicProbeMap = Partial<Record<AppId, (options?: ProbeOptions) => Promise<Observation>>>

export interface StatusDependencies {
  getKeewebStatusSummary: () => Promise<AppCollection>
  getCliproxyStatusSummary: (baseUrl: string, key: string) => Promise<AppCollection>
  getGatewayStatusSummary: (host: string) => Promise<AppCollection>
  getUmamiStatusSummary: (host: string) => Promise<AppCollection>
  getDashboardStatusSummary: (host: string) => Promise<AppCollection>
  getVpnStatusSummary: (host: string) => Promise<AppCollection>
  publicProbes: PublicProbeMap
  now: () => Date
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

const defaultDependencies: StatusDependencies = {
  getKeewebStatusSummary,
  getCliproxyStatusSummary,
  getGatewayStatusSummary,
  getUmamiStatusSummary,
  getDashboardStatusSummary,
  getVpnStatusSummary,
  publicProbes: PUBLIC_PROBES,
  now: () => new Date(),
}

const TABLE_COLUMNS: {kind: ObservationKind; label: string}[] = [
  {kind: 'reachability', label: 'Reachability'},
  {kind: 'container-health', label: 'Container'},
  {kind: 'deploy-state', label: 'Deploy'},
  {kind: 'end-to-end', label: 'End-to-end'},
  {kind: 'resource', label: 'Resource'},
]

const RESULT_CELLS: Record<ObservationResult, string> = {
  pass: '✅ pass',
  fail: '❌ fail',
  unknown: '❓ unknown',
  not_measured: '⚪ not measured',
}

/** A kind the app does not declare renders as an em dash. */
const UNDECLARED_CELL = '—'

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

type Collector = {kind: 'run'; run: () => Promise<AppCollection>} | {kind: 'missing-config'} | {kind: 'none'}

function hostCollector(host: string, run: (host: string) => Promise<AppCollection>): Collector {
  return host === '' ? {kind: 'missing-config'} : {kind: 'run', run: () => run(host)}
}

async function collectApp(
  app: AppId,
  probe: (() => Promise<Observation>) | undefined,
  collector: Collector,
  ctx: ActionCtx,
  now: () => Date,
): Promise<AppStatus> {
  const [probeResult, collectorResult] = await Promise.allSettled([
    probe === undefined ? Promise.resolve(undefined) : probe(),
    collector.kind === 'run' ? collector.run() : Promise.resolve(undefined),
  ])

  for (const result of [probeResult, collectorResult]) {
    if (result.status === 'rejected') {
      ctx.console.error(`${app} status check failed: ${describeReason(result.reason)}`)
    }
  }

  let probeOutcome: ProbeOutcome = {kind: 'none'}
  if (probeResult.status === 'rejected') {
    probeOutcome = {kind: 'failed'}
  } else if (probeResult.value !== undefined) {
    probeOutcome = {kind: 'ok', observation: probeResult.value}
  }

  let collectorOutcome: CollectorOutcome = {kind: collector.kind === 'run' ? 'none' : collector.kind}
  if (collectorResult.status === 'rejected') {
    collectorOutcome = {kind: 'failed'}
  } else if (collectorResult.value !== undefined) {
    collectorOutcome = {kind: 'ok', collection: collectorResult.value}
  }

  return assembleAppStatus(app, probeOutcome, collectorOutcome, now())
}

function formatRow(app: AppStatus): string {
  const cells = TABLE_COLUMNS.map(({kind}) => {
    const worst = worstResult(app, kind)
    return worst === undefined ? UNDECLARED_CELL : RESULT_CELLS[worst]
  })

  return `| ${[app.app, ...cells].join(' | ')} |`
}

function formatHeader(): string {
  return `| ${['App', ...TABLE_COLUMNS.map(({label}) => label)].join(' | ')} |`
}

export async function unifiedStatusAction(
  options: {json?: boolean},
  ctx: ActionCtx,
  dependencies: StatusDependencies = defaultDependencies,
): Promise<void> {
  const cliproxyBaseUrl = stripTrailingSlash(process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
  const cliproxyKey = process.env.CLIPROXY_MANAGEMENT_KEY ?? ''
  const gatewayHost = process.env.GATEWAY_HOST ?? ''
  const umamiHost = process.env.UMAMI_DOMAIN ?? ''
  const dashboardHost = process.env.DASHBOARD_DOMAIN ?? ''
  const vpnHost = process.env.VPN_HOST ?? ''

  const collectors: Record<AppId, Collector> = {
    keeweb: {kind: 'run', run: () => dependencies.getKeewebStatusSummary()},
    cliproxy: {kind: 'run', run: () => dependencies.getCliproxyStatusSummary(cliproxyBaseUrl, cliproxyKey)},
    gateway: hostCollector(gatewayHost, dependencies.getGatewayStatusSummary),
    umami: hostCollector(umamiHost, dependencies.getUmamiStatusSummary),
    dashboard: hostCollector(dashboardHost, dependencies.getDashboardStatusSummary),
    vpn: hostCollector(vpnHost, dependencies.getVpnStatusSummary),
    broker: {kind: 'none'},
  }

  const apps = await Promise.all(
    APP_IDS.map(app => {
      const probe = dependencies.publicProbes[app]
      // The cliproxy URL can be overridden for the SSH and management checks, so the probe follows it.
      const probeOptions: ProbeOptions | undefined = app === 'cliproxy' ? {baseUrl: cliproxyBaseUrl} : undefined
      return collectApp(app, probe && (() => probe(probeOptions)), collectors[app], ctx, dependencies.now)
    }),
  )

  if (options.json === true) {
    const envelope: StatusEnvelope = {
      schemaVersion: STATUS_SCHEMA_VERSION,
      generatedAt: dependencies.now().toISOString(),
      apps,
    }
    ctx.console.log(JSON.stringify(envelope))
    return
  }

  ctx.console.log(formatHeader())
  for (const app of apps) {
    ctx.console.log(formatRow(app))
  }
}

export function registerStatus(
  cli: ReturnType<typeof goke>,
  dependencies: StatusDependencies = defaultDependencies,
): void {
  cli
    .command('status', 'Show status of all deployments')
    .option(
      '--json',
      z
        .boolean()
        .describe(
          'Output a schema-versioned JSON envelope: schemaVersion, generatedAt, and one entry per app with typed observations (id, kind, result, observedAt, source) and facts. The gateway workspace memory status is in facts.workspace.',
        ),
    )
    .action((options, ctx) => unifiedStatusAction(options, ctx, dependencies))
}
