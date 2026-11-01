import type {AppId} from './observation'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {DECLARED_OBSERVATIONS} from './declared'
import {
  DEPLOY_STATE_CALL_BUDGET,
  DEPLOY_STATE_CALLS_PER_APP,
  DEPLOY_STATE_ID,
  mapDeploymentState,
  readDeployStates,
} from './deploy-state'
import {APP_IDS, observationSchema} from './observation'

const NOW = new Date('2026-11-01T23:00:00.000Z')
const TOKEN = 'ghs_test_token_must_never_leak'

interface Sequence {
  deployments: {id: number; environment: string; created_at: string}[]
  statuses: {id: number; state: string; created_at: string}[]
}

function fixture(name: string): Sequence {
  return JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', `deployments-${name}.json`), 'utf8')) as Sequence
}

/** A synthetic sequence for a state the live repo has no current example of. */
function sequenceOf(state: string, createdAt = '2026-11-01T22:00:00Z'): Sequence {
  return {
    deployments: [{id: 1, environment: 'x', created_at: '2026-11-01T21:59:00Z'}],
    statuses: [{id: 10, state, created_at: createdAt}],
  }
}

type Route = Sequence | {listStatus: number} | {statusesStatus: number} | {throws: true} | {listBody: unknown}

interface Call {
  url: URL
  headers: Headers
}

/**
 * The statuses route has no `environment` parameter, so the fake resolves the app from the deployment id the
 * list route handed out. Using one fixed id per app keeps that lookup exact when apps run concurrently.
 */
function fakeGitHubByApp(routes: Partial<Record<AppId, Route>>, fallback: Route = fixture('broker-success')) {
  const calls: Call[] = []
  const idToApp = new Map<number, AppId>()
  APP_IDS.forEach((app, index) => idToApp.set(1000 + index, app))
  const idOf = (app: AppId) => 1000 + APP_IDS.indexOf(app)

  const fetchFn = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    calls.push({url, headers: new Headers(init?.headers)})
    const perPage = Number(url.searchParams.get('per_page'))

    if (url.pathname === '/repos/marcusrbrown/infra/deployments') {
      const app = url.searchParams.get('environment') as AppId
      const route = routes[app] ?? fallback
      if ('throws' in route) throw new TypeError('connect ECONNREFUSED')
      if ('listStatus' in route) return new Response('{"message":"nope"}', {status: route.listStatus})
      if ('listBody' in route) return Response.json(route.listBody)
      // A `statusesStatus` route still has a deployment to list; only its status read fails.
      const deployments = 'deployments' in route ? route.deployments : fixture('broker-success').deployments
      return Response.json(deployments.slice(0, perPage).map(d => ({...d, id: idOf(app), environment: app})))
    }

    const statusMatch = /^\/repos\/marcusrbrown\/infra\/deployments\/(\d+)\/statuses$/.exec(url.pathname)
    if (statusMatch !== null) {
      const app = idToApp.get(Number(statusMatch[1]))
      if (app === undefined) return new Response('unknown deployment', {status: 404})
      const route = routes[app] ?? fallback
      if ('statusesStatus' in route) return new Response('{"message":"forbidden"}', {status: route.statusesStatus})
      if (!('statuses' in route)) return Response.json([])
      return Response.json(route.statuses.slice(0, perPage))
    }

    return new Response('unexpected', {status: 404})
  }

  return {fetchFn, calls}
}

async function readOne(app: AppId, route: Route) {
  const {fetchFn, calls} = fakeGitHubByApp({[app]: route})
  const observations = await readDeployStates({token: TOKEN, fetch: fetchFn, now: NOW})
  return {observation: observations[app], observations, calls}
}

describe('mapDeploymentState', () => {
  it('maps every GitHub deployment state with the recorded rules', () => {
    expect(mapDeploymentState('success')).toEqual({result: 'pass'})
    expect(mapDeploymentState('failure')).toEqual({result: 'fail'})
    expect(mapDeploymentState('error')).toEqual({result: 'fail'})
    expect(mapDeploymentState('waiting')).toEqual({result: 'unknown', reason: 'at_gate'})
    expect(mapDeploymentState('queued')).toEqual({result: 'unknown', reason: 'running'})
    expect(mapDeploymentState('in_progress')).toEqual({result: 'unknown', reason: 'running'})
    expect(mapDeploymentState('pending')).toEqual({result: 'unknown', reason: 'running'})
    expect(mapDeploymentState('inactive')).toEqual({result: 'unknown', reason: 'inactive'})
  })

  it('fails closed on a state it has never seen', () => {
    expect(mapDeploymentState('exploded')).toEqual({result: 'unknown', reason: 'unknown-state'})
  })
})

describe('readDeployStates', () => {
  it('declares the id and kind the declared observation set expects', () => {
    for (const app of APP_IDS) {
      const declared = DECLARED_OBSERVATIONS[app].find(entry => entry.id === DEPLOY_STATE_ID)
      expect(declared?.kind).toBe('deploy-state')
    }
  })

  it('reads a successful deployment as pass, with the status time as detail.since and the read time as observedAt', async () => {
    const {observation} = await readOne('broker', fixture('broker-success'))

    expect(observation).toEqual({
      id: 'deploy-state',
      kind: 'deploy-state',
      source: 'github-api',
      result: 'pass',
      observedAt: NOW.toISOString(),
      detail: {since: '2026-10-31T18:27:46Z'},
    })
  })

  it('reads all seven apps in 2 calls each, within the stated budget', async () => {
    const {fetchFn, calls} = fakeGitHubByApp({})
    const observations = await readDeployStates({token: TOKEN, fetch: fetchFn, now: NOW})

    expect(Object.keys(observations).toSorted()).toEqual([...APP_IDS].toSorted())
    expect(DEPLOY_STATE_CALLS_PER_APP).toBe(2)
    expect(DEPLOY_STATE_CALL_BUDGET).toBe(14)
    expect(calls).toHaveLength(14)
    for (const app of APP_IDS) {
      expect(observationSchema.safeParse(observations[app]).success).toBe(true)
      expect(observations[app].result).toBe('pass')
    }
  })

  it('asks for exactly the newest deployment and the newest status', async () => {
    const {calls} = await readOne('gateway', fixture('broker-success'))
    const own = calls.filter(call => call.url.searchParams.get('environment') === 'gateway')

    expect(own).toHaveLength(1)
    expect(own[0]?.url.pathname).toBe('/repos/marcusrbrown/infra/deployments')
    expect(own[0]?.url.searchParams.get('per_page')).toBe('1')
    const statusCalls = calls.filter(call => call.url.pathname.endsWith('/statuses'))
    expect(statusCalls.every(call => call.url.searchParams.get('per_page') === '1')).toBe(true)
  })

  it('sends the token only as an Authorization header', async () => {
    const {calls, observations} = await readOne('broker', fixture('broker-success'))

    expect(calls.every(call => call.headers.get('authorization') === `Bearer ${TOKEN}`)).toBe(true)
    expect(calls.some(call => call.url.href.includes(TOKEN))).toBe(false)
    expect(JSON.stringify(observations)).not.toContain(TOKEN)
  })

  describe('rejection and failure (recorded: a gated deploy that is rejected or cancelled ends in error or failure)', () => {
    it('reads the recorded broker error sequence (waiting, waiting, error) as fail', async () => {
      const {observation} = await readOne('broker', fixture('broker-error'))

      expect(observation).toMatchObject({result: 'fail', observedAt: NOW.toISOString()})
      expect(observation?.result === 'fail' && observation.detail).toEqual({since: '2026-10-08T05:42:41Z'})
    })

    it('reads the recorded keeweb failure sequence (waiting, failure) as fail', async () => {
      const {observation} = await readOne('keeweb', fixture('keeweb-failure'))

      expect(observation?.result).toBe('fail')
    })
  })

  describe('at the approval gate', () => {
    it('reads the recorded waiting sequence as unknown / at_gate with waiting-since in detail', async () => {
      const {observation} = await readOne('vpn', fixture('vpn-waiting'))

      expect(observation).toEqual({
        id: 'deploy-state',
        kind: 'deploy-state',
        source: 'github-api',
        result: 'unknown',
        observedAt: NOW.toISOString(),
        detail: {reason: 'at_gate', since: '2026-11-01T22:56:44Z'},
      })
    })
  })

  describe('running', () => {
    it.each(['queued', 'in_progress', 'pending'])('reads %s as unknown / running', async state => {
      const {observation} = await readOne('dashboard', sequenceOf(state))

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'running', since: '2026-11-01T22:00:00Z'}})
    })
  })

  describe('inactive (recorded: only ever follows success, but a newest-deployment read cannot tell)', () => {
    it('reads a superseded deployment whose newest status is inactive as unknown / inactive', async () => {
      const {observation, calls} = await readOne('cliproxy', fixture('cliproxy-inactive-superseded'))

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'inactive'}})
      // The rule needs no history read: still 2 calls per app, 14 in total.
      expect(calls).toHaveLength(DEPLOY_STATE_CALL_BUDGET)
    })

    it('reads a deployment whose only status is inactive the same way', async () => {
      const {observation} = await readOne('umami', fixture('umami-inactive-only'))

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'inactive'}})
    })
  })

  describe('edge cases', () => {
    it('reports an environment with no deployment as not_measured / none', async () => {
      const {observation} = await readOne('vpn', fixture('none'))

      expect(observation).toEqual({
        id: 'deploy-state',
        kind: 'deploy-state',
        source: 'config',
        result: 'not_measured',
        observedAt: null,
        detail: {reason: 'none'},
      })
    })

    it('reports a deployment that has no status yet as unknown / no-status', async () => {
      const route: Sequence = {...sequenceOf('success'), statuses: []}
      const {observation} = await readOne('broker', route)

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'no-status'}})
    })

    it('reports an unrecognized state as unknown / unknown-state', async () => {
      const {observation} = await readOne('broker', sequenceOf('exploded'))

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'unknown-state'}})
    })
  })

  describe('API failures stay local to the app', () => {
    it.each([
      ['a 403 on the deployment list', {listStatus: 403}],
      ['a 500 on the deployment list', {listStatus: 500}],
      ['a 403 on the status read', {statusesStatus: 403}],
      ['a 503 on the status read', {statusesStatus: 503}],
      ['a network error', {throws: true}],
      ['a list body that is not an array', {listBody: {message: 'Not Found'}}],
    ] as [string, Route][])('reports %s as unknown / api-error and leaves other apps alone', async (_label, route) => {
      const {observation, observations} = await readOne('gateway', route)

      expect(observation).toMatchObject({result: 'unknown', source: 'github-api', detail: {reason: 'api-error'}})
      expect(observationSchema.safeParse(observation).success).toBe(true)
      expect(observations.broker.result).toBe('pass')
      expect(observations.vpn.result).toBe('pass')
    })

    it('never copies response text into an observation', async () => {
      const {observations} = await readOne('gateway', {listStatus: 403})

      expect(JSON.stringify(observations.gateway)).not.toContain('nope')
    })

    it('rejects a status with a malformed timestamp instead of passing it through', async () => {
      const route = sequenceOf('success', 'yesterday')
      const {observation} = await readOne('broker', route)

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'api-error'}})
    })
  })

  describe('missing token', () => {
    it.each([undefined, '', '   '])('reports not_measured / config for %p without any request', async token => {
      const {fetchFn, calls} = fakeGitHubByApp({})
      const observations = await readDeployStates({token, fetch: fetchFn, now: NOW})

      expect(calls).toHaveLength(0)
      for (const app of APP_IDS) {
        expect(observations[app]).toEqual({
          id: 'deploy-state',
          kind: 'deploy-state',
          source: 'config',
          result: 'not_measured',
          observedAt: null,
          detail: {reason: 'missing-config'},
        })
        expect(observationSchema.safeParse(observations[app]).success).toBe(true)
      }
    })
  })

  it('rejects a non-ISO since so a stray string cannot ride in detail', () => {
    const parsed = observationSchema.safeParse({
      id: 'deploy-state',
      kind: 'deploy-state',
      source: 'github-api',
      result: 'unknown',
      observedAt: NOW.toISOString(),
      detail: {since: 'a while ago'},
    })

    expect(parsed.success).toBe(false)
  })
})
