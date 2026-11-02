import type {goke} from 'goke'

import type {ActionCtx} from '../lib/action-ctx'
import type {AppCollection} from '../status/collect'
import type {CollectorOutcome, ProbeOutcome} from '../status/declared'
import type {FetchLike} from '../status/github-api'
import type {GithubReaders, GithubReads} from '../status/github-reads'
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
import {readDeployStates} from '../status/deploy-state'
import {resolveGithubToken} from '../status/github-api'
import {githubObservationsFor, runGithubReads} from '../status/github-reads'
import {readMonitorState} from '../status/monitor-state'
import {APP_IDS, STATUS_SCHEMA_VERSION} from '../status/observation'
import {PUBLIC_PROBES} from '../status/public-probes'
import {getCliproxyStatusSummary} from './cliproxy/status'
import {getDashboardStatusSummary} from './dashboard'
import {getGatewayStatusSummary} from './gateway'
import {getKeewebStatusSummary} from './keeweb/status'
import {registerStatusHistoryLocate} from './status-history-locate'
import {registerStatusSnapshot} from './status-snapshot'
import {getUmamiStatusSummary} from './umami'
import {getVpnStatusSummary} from './vpn'

declare const process: {
  env: Record<string, string | undefined>
}

export type PublicProbeMap = Partial<Record<AppId, (options?: ProbeOptions) => Promise<Observation>>>

/**
 * Each collector gets a signal that aborts when its deadline fires, so it can kill any child it spawned.
 * The public probes and the two GitHub readers are shared with `status snapshot`.
 */
export interface StatusDependencies extends GithubReaders {
  getKeewebStatusSummary: (signal?: AbortSignal) => Promise<AppCollection>
  getCliproxyStatusSummary: (baseUrl: string, key: string, signal?: AbortSignal) => Promise<AppCollection>
  getGatewayStatusSummary: (host: string, signal?: AbortSignal) => Promise<AppCollection>
  getUmamiStatusSummary: (host: string, signal?: AbortSignal) => Promise<AppCollection>
  getDashboardStatusSummary: (host: string, signal?: AbortSignal) => Promise<AppCollection>
  getVpnStatusSummary: (host: string, signal?: AbortSignal) => Promise<AppCollection>
  publicProbes: PublicProbeMap
  /** Transport for the GitHub readers; defaults to the global `fetch`. */
  fetch?: FetchLike
  now: () => Date
  /** Per-app collector deadline in milliseconds; the public probes have their own timeouts. */
  collectorDeadlineMs: number
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
export const COLLECTOR_DEADLINE_MS = 30_000

const defaultDependencies: StatusDependencies = {
  getKeewebStatusSummary,
  getCliproxyStatusSummary: (baseUrl, key, signal) => getCliproxyStatusSummary(baseUrl, key, undefined, signal),
  getGatewayStatusSummary: (host, signal) => getGatewayStatusSummary(host, undefined, signal),
  getUmamiStatusSummary: (host, signal) => getUmamiStatusSummary(host, undefined, signal),
  getDashboardStatusSummary: (host, signal) => getDashboardStatusSummary(host, undefined, signal),
  getVpnStatusSummary: (host, signal) => getVpnStatusSummary(host, undefined, signal),
  publicProbes: PUBLIC_PROBES,
  readDeployStates,
  readMonitorState,
  now: () => new Date(),
  collectorDeadlineMs: COLLECTOR_DEADLINE_MS,
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

/** `BROKER_DOMAIN` is usually a bare hostname; a value with a scheme is used as given. */
function brokerBaseUrl(domain: string | undefined): string | undefined {
  const trimmed = domain?.trim() ?? ''
  if (trimmed === '') return undefined
  return /^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

function describeReason(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}

type Collector =
  {kind: 'run'; run: (signal: AbortSignal) => Promise<AppCollection>} | {kind: 'missing-config'} | {kind: 'none'}

const TIMED_OUT = Symbol('collector-timed-out')

function hostCollector(host: string, run: (host: string, signal: AbortSignal) => Promise<AppCollection>): Collector {
  return host === '' ? {kind: 'missing-config'} : {kind: 'run', run: signal => run(host, signal)}
}

/**
 * Race a collector against its deadline. When the deadline fires, the signal handed to the collector aborts,
 * which kills any child process it spawned. A collector that settles later is ignored.
 */
async function withDeadline(
  run: Collector & {kind: 'run'},
  deadlineMs: number,
): Promise<AppCollection | typeof TIMED_OUT> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<typeof TIMED_OUT>(resolve => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(TIMED_OUT)
    }, deadlineMs)
  })

  try {
    const work = run.run(controller.signal)
    // A rejection after the deadline has no reader; keep it from surfacing as unhandled.
    work.catch(() => undefined)
    return await Promise.race([work, deadline])
  } finally {
    clearTimeout(timer)
  }
}

/** Failure detail goes to stderr only in table mode; in JSON mode it is already inside the observation. */
async function collectApp(
  app: AppId,
  probe: (() => Promise<Observation>) | undefined,
  collector: Collector,
  options: {ctx: ActionCtx; now: () => Date; deadlineMs: number; json: boolean; githubReads: Promise<GithubReads>},
): Promise<AppStatus> {
  const {ctx, now, deadlineMs, json, githubReads} = options
  const [probeResult, collectorResult] = await Promise.allSettled([
    probe === undefined ? Promise.resolve(undefined) : probe(),
    collector.kind === 'run' ? withDeadline(collector, deadlineMs) : Promise.resolve(undefined),
  ])

  const logFailure = (message: string): void => {
    if (!json) ctx.console.error(`${app} ${message}`)
  }

  let probeOutcome: ProbeOutcome = {kind: 'none'}
  if (probeResult.status === 'rejected') {
    logFailure(`status check failed: ${describeReason(probeResult.reason)}`)
    probeOutcome = {kind: 'failed'}
  } else if (probeResult.value !== undefined) {
    probeOutcome = {kind: 'ok', observation: probeResult.value}
  }

  let collectorOutcome: CollectorOutcome = {kind: collector.kind === 'run' ? 'none' : collector.kind}
  if (collectorResult.status === 'rejected') {
    logFailure(`status check failed: ${describeReason(collectorResult.reason)}`)
    collectorOutcome = {kind: 'failed'}
  } else if (collectorResult.value === TIMED_OUT) {
    logFailure(`status check timed out after ${deadlineMs}ms`)
    collectorOutcome = {kind: 'timeout'}
  } else if (collectorResult.value !== undefined) {
    collectorOutcome = {kind: 'ok', collection: collectorResult.value}
  }

  // The readers started before the collectors, so this wait is only for whatever is still outstanding.
  return assembleAppStatus(
    app,
    probeOutcome,
    collectorOutcome,
    now(),
    githubObservationsFor(app, await githubReads, now()),
  )
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
    keeweb: {kind: 'run', run: signal => dependencies.getKeewebStatusSummary(signal)},
    cliproxy: {
      kind: 'run',
      run: signal => dependencies.getCliproxyStatusSummary(cliproxyBaseUrl, cliproxyKey, signal),
    },
    gateway: hostCollector(gatewayHost, dependencies.getGatewayStatusSummary),
    umami: hostCollector(umamiHost, dependencies.getUmamiStatusSummary),
    dashboard: hostCollector(dashboardHost, dependencies.getDashboardStatusSummary),
    vpn: hostCollector(vpnHost, dependencies.getVpnStatusSummary),
    broker: {kind: 'none'},
  }

  // The cliproxy URL can be overridden for the SSH and management checks, so its probe follows it.
  // BROKER_HOST is the SSH host or IP and would fail TLS, so only BROKER_DOMAIN selects the broker target.
  const probeBaseUrls: Partial<Record<AppId, string>> = {
    cliproxy: cliproxyBaseUrl,
    broker: brokerBaseUrl(process.env.BROKER_DOMAIN),
  }
  const json = options.json === true

  // Without a token the readers make no request and report `not_measured` (missing-config).
  const githubReads = runGithubReads(dependencies, {
    token: resolveGithubToken(process.env),
    now: dependencies.now(),
    ...(dependencies.fetch === undefined ? {} : {fetch: dependencies.fetch}),
  })

  const apps = await Promise.all(
    APP_IDS.map(app => {
      const probe = dependencies.publicProbes[app]
      const baseUrl = probeBaseUrls[app]
      const probeOptions: ProbeOptions | undefined = baseUrl === undefined ? undefined : {baseUrl}
      return collectApp(app, probe && (() => probe(probeOptions)), collectors[app], {
        ctx,
        now: dependencies.now,
        deadlineMs: dependencies.collectorDeadlineMs,
        json,
        githubReads,
      })
    }),
  )

  if (json) {
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

  registerStatusSnapshot(cli, dependencies)
  registerStatusHistoryLocate(cli, dependencies)
}
