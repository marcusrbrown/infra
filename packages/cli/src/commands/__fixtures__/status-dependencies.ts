import type {AppCollection} from '../../status/collect'
import type {AppId, Observation} from '../../status/observation'
import type {WorkspaceMemoryStatus} from '../gateway/workspace-memory'
import type {StatusDependencies} from '../status'

import {observe} from '../../status/collect'
import {declaredObservation} from '../../status/declared'
import {APP_IDS} from '../../status/observation'
import {LIMIT_BYTES, MIB, STARTED_AT} from '../gateway/__fixtures__/workspace-probe'

export const FIXED_NOW = new Date('2026-11-01T12:00:00.000Z')

export const okWorkspace: WorkspaceMemoryStatus = {
  status: 'ok',
  limitBytes: LIMIT_BYTES,
  currentBytes: 412 * MIB,
  maxEvents: 0,
  oomKills: 0,
  oomKilled: false,
  restartCount: 0,
  startedAt: STARTED_AT,
  opencode: 'ready',
}

const runningService = {service: 'app', state: 'running', health: 'healthy'}

function compose(app: 'gateway' | 'umami' | 'dashboard'): Observation {
  return observe(declaredObservation(app, 'compose-services'), 'pass', {now: FIXED_NOW})
}

export const healthyKeeweb: AppCollection = {
  observations: [],
  facts: {lastDeploy: '2026-04-12T10:00:00Z', contentHash: 'match'},
}

export const healthyCliproxy: AppCollection = {
  observations: [observe(declaredObservation('cliproxy', 'container-running'), 'pass', {now: FIXED_NOW})],
  facts: {
    runningVersion: 'v1.2.3',
    latestVersion: 'v1.2.4',
    usage: {recent: 12, errors: 0},
    managementAccess: 'ok',
  },
}

export const healthyGateway: AppCollection = {
  observations: [
    compose('gateway'),
    observe(declaredObservation('gateway', 'workspace-memory'), 'pass', {now: FIXED_NOW}),
  ],
  facts: {services: [runningService], workspace: {...okWorkspace}},
}

export const healthyUmami: AppCollection = {observations: [compose('umami')], facts: {services: [runningService]}}

export const healthyDashboard: AppCollection = {
  observations: [compose('dashboard')],
  facts: {services: [runningService]},
}

export const healthyVpn: AppCollection = {
  observations: [observe(declaredObservation('vpn', 'wireguard-interface'), 'pass', {now: FIXED_NOW})],
  facts: {peerCount: 1, serverPublicKey: 'TESTKEY=='},
}

const DEPLOY_STATE = {id: 'deploy-state', kind: 'deploy-state', source: 'github-api'} as const

export function deployObservation(
  result: 'pass' | 'fail' | 'unknown' = 'pass',
  detail?: Observation['detail'],
): Observation {
  return observe(DEPLOY_STATE, result, {now: FIXED_NOW, ...(detail === undefined ? {} : {detail})})
}

export function routeObservation(
  result: 'pass' | 'fail' | 'unknown' = 'pass',
  detail?: Observation['detail'],
): Observation {
  return observe(declaredObservation('cliproxy', 'provider-route'), result, {
    now: FIXED_NOW,
    ...(detail === undefined ? {} : {detail}),
  })
}

export function goRouteObservation(
  result: 'pass' | 'fail' | 'unknown' = 'pass',
  detail?: Observation['detail'],
): Observation {
  return observe(declaredObservation('cliproxy', 'provider-route-go'), result, {
    now: FIXED_NOW,
    ...(detail === undefined ? {} : {detail}),
  })
}

export function probeObservation(result: 'pass' | 'fail' | 'unknown' = 'pass'): Observation {
  return observe({id: 'public-reachability', kind: 'reachability', source: 'http'}, result, {
    detail: {statusCode: 200, durationMs: 42},
    now: FIXED_NOW,
  })
}

/** Deterministic dependencies where every app is healthy. Override pieces per test. */
export function makeStatusDependencies(overrides: Partial<StatusDependencies> = {}): StatusDependencies {
  const probe = async () => probeObservation()
  const publicProbes: StatusDependencies['publicProbes'] = {
    keeweb: probe,
    cliproxy: probe,
    gateway: probe,
    umami: probe,
    dashboard: probe,
    broker: probe,
  }

  return {
    getKeewebStatusSummary: async () => healthyKeeweb,
    getCliproxyStatusSummary: async () => healthyCliproxy,
    getGatewayStatusSummary: async () => healthyGateway,
    getUmamiStatusSummary: async () => healthyUmami,
    getDashboardStatusSummary: async () => healthyDashboard,
    getVpnStatusSummary: async () => healthyVpn,
    publicProbes,
    readDeployStates: async () => Object.fromEntries(APP_IDS.map(app => [app, deployObservation()])),
    readMonitorState: async () => [routeObservation(), goRouteObservation()],
    now: () => FIXED_NOW,
    collectorDeadlineMs: 5000,
    ...overrides,
  }
}

export const STATUS_ENV_KEYS = [
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'GATEWAY_HOST',
  'UMAMI_DOMAIN',
  'DASHBOARD_DOMAIN',
  'VPN_HOST',
  'CLIPROXY_URL',
  'BROKER_DOMAIN',
  'BROKER_HOST',
] as const

/** Set every host variable the unified status command reads so host-keyed collectors run. */
export function withStatusEnv<T>(run: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>(STATUS_ENV_KEYS.map(key => [key, process.env[key]]))
  process.env.GATEWAY_HOST = 'gateway.example.com'
  process.env.UMAMI_DOMAIN = 'umami.example.com'
  process.env.DASHBOARD_DOMAIN = 'dashboard.example.com'
  process.env.VPN_HOST = 'vpn.example.com'
  delete process.env.GITHUB_TOKEN
  delete process.env.GH_TOKEN
  delete process.env.CLIPROXY_URL
  delete process.env.BROKER_DOMAIN
  delete process.env.BROKER_HOST

  return run().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
}

export const EXPECTED_OBSERVATION_IDS: Record<AppId, string[]> = {
  keeweb: ['public-reachability', 'deploy-state'],
  cliproxy: ['public-reachability', 'container-running', 'deploy-state', 'provider-route', 'provider-route-go'],
  gateway: ['public-reachability', 'compose-services', 'workspace-memory', 'deploy-state'],
  umami: ['public-reachability', 'compose-services', 'deploy-state'],
  dashboard: ['public-reachability', 'compose-services', 'deploy-state'],
  vpn: ['public-reachability', 'wireguard-interface', 'deploy-state', 'egress-route'],
  broker: ['public-reachability', 'deploy-state'],
}
