import type {AppId} from './observation'
import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {DECLARED_OBSERVATIONS} from './declared'
import {
  DEPLOY_STATE_CALL_BUDGET,
  DEPLOY_STATE_CALLS_PER_APP,
  DEPLOY_STATE_ID,
  DEPLOY_STATE_LOOKBACK,
  DEPLOY_STATE_MAX_CALLS_PER_APP,
  mapDeploymentState,
  readDeployStates,
} from './deploy-state'
import {APP_IDS, observationSchema} from './observation'

const NOW = new Date('2026-11-01T23:00:00.000Z')
const TOKEN = 'ghs_test_token_must_never_leak'

interface DeploymentFixture {
  id: number
  ref: string
  created_at: string
}

interface StatusFixture {
  id: number
  state: string
  created_at: string
}

/** One deployment's status history; its id is replaced per app so concurrent reads stay separate. */
interface Sequence {
  deployments: DeploymentFixture[]
  statuses: StatusFixture[]
}

/** Several deployments with their own histories, newest first, as the API lists them. */
interface History {
  deployments: DeploymentFixture[]
  statusesByDeployment: Record<string, StatusFixture[]>
}

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dir, '__fixtures__', `deployments-${name}.json`), 'utf8'))
}

function fixture(name: string): Sequence {
  return readFixture(name) as Sequence
}

function historyFixture(name: string): History {
  return readFixture(name) as History
}

/** A synthetic sequence for a state the live repo has no current example of. */
function sequenceOf(state: string, createdAt = '2026-11-01T22:00:00Z'): Sequence {
  return {
    deployments: [{id: 1, ref: 'main', created_at: '2026-11-01T21:59:00Z'}],
    statuses: [{id: 10, state, created_at: createdAt}],
  }
}

type Route = Sequence | History | {listStatus: number} | {statusesStatus: number} | {throws: true} | {listBody: unknown}

interface Call {
  url: URL
  headers: Headers
}

/**
 * The statuses route has no `environment` parameter, so the fake records which statuses each listed
 * deployment id owns. A `Sequence` gets one fixed id per app, which keeps lookups exact when apps run
 * concurrently; a `History` keeps its real ids. The list route honours the `ref` filter, like the API.
 */
function fakeGitHubByApp(routes: Partial<Record<AppId, Route>>, fallback: Route = fixture('broker-success')) {
  const calls: Call[] = []
  const statusesById = new Map<number, Response | StatusFixture[]>()
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
      const base = 'deployments' in route ? route : fixture('broker-success')
      const ref = url.searchParams.get('ref')
      let listed = base.deployments
      if ('statusesByDeployment' in base) {
        for (const deployment of base.deployments) {
          statusesById.set(deployment.id, base.statusesByDeployment[String(deployment.id)] ?? [])
        }
      } else {
        listed = base.deployments.map(deployment => ({...deployment, id: idOf(app)}))
        statusesById.set(
          idOf(app),
          'statusesStatus' in route ? new Response(null, {status: route.statusesStatus}) : base.statuses,
        )
      }
      listed = listed.filter(deployment => ref === null || deployment.ref === ref)

      return Response.json(listed.slice(0, perPage))
    }

    const statusMatch = /^\/repos\/marcusrbrown\/infra\/deployments\/(\d+)\/statuses$/.exec(url.pathname)
    if (statusMatch !== null) {
      const statuses = statusesById.get(Number(statusMatch[1]))
      if (statuses === undefined) return new Response('unknown deployment', {status: 404})
      if (statuses instanceof Response) return new Response('{"message":"forbidden"}', {status: statuses.status})
      return Response.json(statuses.slice(0, perPage))
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

/** Deployments newest first, each with its own newest-first status history. */
function stack(...entries: [state: string, createdAt: string][]): History {
  const deployments = entries.map(([, createdAt], index) => ({
    id: entries.length - index,
    ref: 'main',
    created_at: createdAt,
  }))
  return {
    deployments,
    statusesByDeployment: Object.fromEntries(
      entries.map(([state, createdAt], index) => [
        String(entries.length - index),
        [{id: 100 + index, state, created_at: createdAt}],
      ]),
    ),
  }
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

  it('reads all eight apps in 2 calls each when the newest deployment is settled, within the stated budget', async () => {
    const {fetchFn, calls} = fakeGitHubByApp({})
    const observations = await readDeployStates({token: TOKEN, fetch: fetchFn, now: NOW})

    expect(Object.keys(observations).toSorted()).toEqual([...APP_IDS].toSorted())
    expect(DEPLOY_STATE_CALLS_PER_APP).toBe(2)
    expect(calls).toHaveLength(APP_IDS.length * DEPLOY_STATE_CALLS_PER_APP)
    expect(calls.length).toBeLessThanOrEqual(DEPLOY_STATE_CALL_BUDGET)
    for (const app of APP_IDS) {
      expect(observationSchema.safeParse(observations[app]).success).toBe(true)
      expect(observations[app].result).toBe('pass')
    }
  })

  it('reads only the apps it is asked for: no request, and no entry, for the rest', async () => {
    const {fetchFn, calls} = fakeGitHubByApp({})
    const observations = await readDeployStates({
      token: TOKEN,
      fetch: fetchFn,
      now: NOW,
      apps: ['keeweb', 'broker'],
    })

    expect(Object.keys(observations).toSorted()).toEqual(['broker', 'keeweb'])
    expect(calls).toHaveLength(2 * DEPLOY_STATE_CALLS_PER_APP)
    const environments = calls.flatMap(call => call.url.searchParams.get('environment') ?? [])
    expect(environments.toSorted()).toEqual(['broker', 'keeweb'])
  })

  it('reports a missing token as not measured for the requested apps only', async () => {
    const {fetchFn, calls} = fakeGitHubByApp({})
    const observations = await readDeployStates({token: undefined, fetch: fetchFn, now: NOW, apps: ['vpn']})

    expect(calls).toHaveLength(0)
    expect(Object.keys(observations)).toEqual(['vpn'])
    expect(observations.vpn?.result).toBe('not_measured')
  })

  it('asks for the newest main deployments in one list call and the newest status of the newest one', async () => {
    const {calls} = await readOne('gateway', fixture('broker-success'))
    const own = calls.filter(call => call.url.searchParams.get('environment') === 'gateway')

    expect(own).toHaveLength(1)
    expect(own[0]?.url.pathname).toBe('/repos/marcusrbrown/infra/deployments')
    expect(own[0]?.url.searchParams.get('ref')).toBe('main')
    expect(own[0]?.url.searchParams.get('per_page')).toBe(String(DEPLOY_STATE_LOOKBACK))
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

    it('reads a failure on main as fail', async () => {
      const {observation} = await readOne('keeweb', sequenceOf('failure'))

      expect(observation).toMatchObject({result: 'fail', detail: {since: '2026-11-01T22:00:00Z'}})
    })
  })

  describe('only main deployments count', () => {
    it('ignores a rejected branch deployment that is the newest overall (recorded keeweb case)', async () => {
      const history = historyFixture('keeweb-branch-rejected')
      // The real newest deployment is a rejected branch dispatch; the unfiltered read would be `fail`.
      expect(history.deployments[0]?.ref).toBe('feat/deploy-gate-notify')
      expect(history.statusesByDeployment[String(history.deployments[0]?.id)]?.[0]?.state).toBe('failure')

      const {observation, calls} = await readOne('keeweb', history)

      expect(observation).toEqual({
        id: 'deploy-state',
        kind: 'deploy-state',
        source: 'github-api',
        result: 'pass',
        observedAt: NOW.toISOString(),
        detail: {since: '2026-04-14T01:48:21Z'},
      })
      expect(calls.filter(call => call.url.searchParams.get('environment') === 'keeweb')).toHaveLength(1)
      expect(calls.some(call => call.url.pathname.includes('/deployments/4359044301/statuses'))).toBe(true)
      expect(calls.some(call => call.url.pathname.includes('/deployments/6927872427/'))).toBe(false)
    })

    it('keeps the typical call count with the ref filter', async () => {
      const {calls} = await readOne('keeweb', historyFixture('keeweb-branch-rejected'))

      expect(calls).toHaveLength(APP_IDS.length * DEPLOY_STATE_CALLS_PER_APP)
    })

    it.each([
      ['a deployment from another ref', [{id: 1, ref: 'feat/x'}]],
      ['a deployment without a ref', [{id: 1}]],
    ])('reads %s, returned despite the filter, as unknown / api-error', async (_label, listBody) => {
      const {observation, observations} = await readOne('keeweb', {listBody})

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'api-error'}})
      expect(observations.broker.result).toBe('pass')
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

  describe('a deployment waiting at its gate in front of settled ones (issue 1992)', () => {
    const GATE = 'newer_at_gate'

    it('reports the failure behind a waiting deployment, and says a newer one waits (the recorded vpn outage)', async () => {
      const {observation, calls} = await readOne(
        'vpn',
        stack(
          ['waiting', '2026-11-17T01:07:00Z'],
          ['failure', '2026-11-16T20:00:00Z'],
          ['failure', '2026-11-15T20:00:00Z'],
        ),
      )

      expect(observation).toEqual({
        id: 'deploy-state',
        kind: 'deploy-state',
        source: 'github-api',
        result: 'fail',
        observedAt: NOW.toISOString(),
        // `since` is when the settled deployment reached its state, not when the newer one began waiting.
        detail: {reason: GATE, since: '2026-11-16T20:00:00Z'},
      })
      // One list, the waiting status, then the next deployment's status: it stops at the first settled one.
      expect(
        calls.filter(call => call.url.pathname.endsWith('/statuses') && call.url.pathname.includes('/deployments/1/')),
      ).toHaveLength(0)
      expect(observationSchema.safeParse(observation).success).toBe(true)
    })

    it('reports a success behind a waiting deployment as pass, with the same marker', async () => {
      const {observation} = await readOne(
        'vpn',
        stack(['waiting', '2026-11-17T01:07:00Z'], ['success', '2026-11-16T20:00:00Z']),
      )

      expect(observation).toMatchObject({result: 'pass', detail: {reason: GATE, since: '2026-11-16T20:00:00Z'}})
    })

    it('treats a rejected gate (error) behind a waiting deployment as fail', async () => {
      const {observation} = await readOne(
        'vpn',
        stack(['waiting', '2026-11-17T01:07:00Z'], ['error', '2026-11-16T20:00:00Z']),
      )

      expect(observation).toMatchObject({result: 'fail', detail: {reason: GATE}})
    })

    it('walks past several waiting deployments to the newest settled one', async () => {
      const {observation} = await readOne(
        'vpn',
        stack(
          ['waiting', '2026-11-18T01:00:00Z'],
          ['waiting', '2026-11-17T01:00:00Z'],
          ['failure', '2026-11-16T20:00:00Z'],
        ),
      )

      expect(observation).toMatchObject({result: 'fail', detail: {reason: GATE, since: '2026-11-16T20:00:00Z'}})
    })

    it('skips a running or inactive deployment behind the gate', async () => {
      const {observation} = await readOne(
        'vpn',
        stack(
          ['waiting', '2026-11-18T01:00:00Z'],
          ['in_progress', '2026-11-17T01:00:00Z'],
          ['inactive', '2026-11-16T22:00:00Z'],
          ['success', '2026-11-16T20:00:00Z'],
        ),
      )

      expect(observation).toMatchObject({result: 'pass', detail: {reason: GATE, since: '2026-11-16T20:00:00Z'}})
    })

    it("keeps today's unknown / at_gate when nothing settled is found, with waiting-since", async () => {
      const {observation} = await readOne('vpn', fixture('vpn-waiting'))

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'at_gate', since: '2026-11-01T22:56:44Z'}})
    })

    it('keeps unknown / at_gate when every deployment inside the look-back is waiting, and stays within the call ceiling', async () => {
      const waiting = Array.from({length: DEPLOY_STATE_LOOKBACK + 2}, (_unused, index): [string, string] => [
        'waiting',
        `2026-11-${String(20 - index).padStart(2, '0')}T01:00:00Z`,
      ])
      const {fetchFn, calls} = fakeGitHubByApp({vpn: stack(...waiting)})
      const observations = await readDeployStates({token: TOKEN, fetch: fetchFn, now: NOW, apps: ['vpn']})

      expect(observations.vpn).toMatchObject({
        result: 'unknown',
        detail: {reason: 'at_gate', since: '2026-11-20T01:00:00Z'},
      })
      expect(calls).toHaveLength(DEPLOY_STATE_MAX_CALLS_PER_APP)
      expect(DEPLOY_STATE_MAX_CALLS_PER_APP).toBe(1 + DEPLOY_STATE_LOOKBACK)
      expect(DEPLOY_STATE_CALL_BUDGET).toBe(APP_IDS.length * DEPLOY_STATE_MAX_CALLS_PER_APP)
    })

    it('does not look behind a deployment that is not waiting: a running newest one stays running', async () => {
      const {observation, calls} = await readOne(
        'vpn',
        stack(['in_progress', '2026-11-17T01:07:00Z'], ['failure', '2026-11-16T20:00:00Z']),
      )

      expect(observation).toMatchObject({result: 'unknown', detail: {reason: 'running'}})
      expect(calls.filter(call => call.url.pathname.includes('/deployments/1/'))).toHaveLength(0)
    })

    it('does not look behind a settled newest deployment either', async () => {
      const {observation, calls} = await readOne(
        'vpn',
        stack(['success', '2026-11-17T01:07:00Z'], ['failure', '2026-11-16T20:00:00Z']),
      )

      expect(observation).toMatchObject({result: 'pass', detail: {since: '2026-11-17T01:07:00Z'}})
      expect(observation?.detail?.reason).toBeUndefined()
      expect(calls.filter(call => call.url.pathname.includes('/deployments/1/'))).toHaveLength(0)
    })

    it('reports an API error while looking behind the gate as unknown / api-error, not as no settled result', async () => {
      const route = stack(['waiting', '2026-11-17T01:07:00Z'], ['failure', '2026-11-16T20:00:00Z'])
      const {fetchFn} = fakeGitHubByApp({vpn: route})
      const failingBehind: typeof fetchFn = async (input, init) =>
        input.includes('/deployments/1/statuses')
          ? new Response('{"message":"x"}', {status: 502})
          : fetchFn(input, init)

      const observations = await readDeployStates({token: TOKEN, fetch: failingBehind, now: NOW, apps: ['vpn']})

      expect(observations.vpn).toMatchObject({result: 'unknown', detail: {reason: 'api-error'}})
    })

    it('fails closed when a deployment behind the gate is not from main', async () => {
      const route = stack(['waiting', '2026-11-17T01:07:00Z'], ['failure', '2026-11-16T20:00:00Z'])
      const older = route.deployments[1]
      if (older === undefined) throw new Error('fixture')
      older.ref = 'feat/x'
      const {fetchFn} = fakeGitHubByApp({
        vpn: {deployments: route.deployments, statusesByDeployment: route.statusesByDeployment},
      })
      // The fake honours the ref filter, so serve the unfiltered list the way a misbehaving API could.
      const unfiltered: typeof fetchFn = async (input, init) => {
        if (new URL(input).pathname === '/repos/marcusrbrown/infra/deployments') {
          await fetchFn(input, init)
          return Response.json(route.deployments)
        }
        return fetchFn(input, init)
      }

      const observations = await readDeployStates({token: TOKEN, fetch: unfiltered, now: NOW, apps: ['vpn']})

      expect(observations.vpn).toMatchObject({result: 'unknown', detail: {reason: 'api-error'}})
    })

    it('leaves other apps alone', async () => {
      const {observations} = await readOne(
        'vpn',
        stack(['waiting', '2026-11-17T01:07:00Z'], ['failure', '2026-11-16T20:00:00Z']),
      )

      expect(observations.broker.result).toBe('pass')
      expect(observations.broker.detail?.reason).toBeUndefined()
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
      // The rule needs no history read: still 2 calls per app.
      expect(calls).toHaveLength(APP_IDS.length * DEPLOY_STATE_CALLS_PER_APP)
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
