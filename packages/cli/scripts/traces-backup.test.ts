/// <reference types="bun" />

/**
 * Behavior contract for the trace data backup.
 *
 * `fetch`, `gh` and the clock are injected fakes: no test reaches DigitalOcean, GitHub or Discord, and no test runs the
 * script's entrypoint. The fake DigitalOcean keeps real state (droplets, volumes, snapshots), paginates every list with
 * `links.pages.next`, and answers 401 to any request that lacks the placeholder bearer token.
 */

import type {GhResult, GhRunner} from './alert-issue'
import type {FetchLike} from './deploy-gate-notify'
import {describe, expect, it} from 'bun:test'
import {TRACES_DROPLET_NAME, TRACES_VOLUME_NAME} from '../../../apps/traces/src/host'
import {
  ALERT_LABEL,
  API_ORIGIN,
  buildDiscordContent,
  DROPLET_NAME,
  isDaily,
  isFamilyVolume,
  isOurs,
  MAX_DELETES_PER_RUN,
  MAX_NEWEST_AGE_HOURS,
  planBackupAlert,
  readAlertEnv,
  READBACK_ATTEMPTS,
  READBACK_INTERVAL_MS,
  REAL_MARKER,
  REHEARSAL_MARKER,
  RETENTION_DAYS,
  runBackup,
  runIssueStep,
  runNotifyStep,
  selectLiveVolume,
  SNAPSHOT_TAG,
  snapshotName,
  VOLUME_NAME,
  type Snapshot,
  type VolumeScope,
} from './traces-backup'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const TOKEN = 'dop_v1_PLACEHOLDER-do-token-0000'
const WEBHOOK = 'https://discord.example/api/webhooks/1234567890/SECRET-token_value'
const REPO = 'marcusrbrown/infra'
const RUN_URL = `https://github.com/${REPO}/actions/runs/9876543210`
const RUNBOOK_URL = `https://github.com/${REPO}/blob/main/docs/runbooks/trace-collection.md`
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const NOW = new Date('2026-11-20T12:00:00.000Z')
const DROPLET_ID = 4242

const hoursAgo = (hours: number): Date => new Date(NOW.getTime() - hours * HOUR_MS)
const daysAgo = (days: number): Date => new Date(NOW.getTime() - days * DAY_MS)

const LIVE_VOLUME_ID = 'aaaaaaaa-0000-4000-8000-000000000001'
const OTHER_VOLUME_ID = 'bbbbbbbb-0000-4000-8000-000000000002'
const OLD_VOLUME_ID = 'cccccccc-0000-4000-8000-000000000003'

// ─── Fake DigitalOcean ───────────────────────────────────────────────────────

interface FakeVolume {
  id: string
  name: string
  droplet_ids: number[] | null
}

interface FakeSnapshot {
  id: string
  name: string
  created_at: string
  resource_id: string
  resource_type: 'volume' | 'droplet'
  tags: string[] | null
}

interface FakeDoOptions {
  readonly droplets?: {id: number; name: string}[]
  readonly volumes?: FakeVolume[]
  readonly snapshots?: FakeSnapshot[]
  readonly pageSize?: number
  /** A response for a request, to force a failure; otherwise the fake answers. */
  readonly override?: (request: DoRequest) => Response | undefined
  /** Create returns this snapshot instead of adding the real one: a create that never shows up in the listing. */
  readonly createLost?: boolean
}

interface DoRequest {
  readonly method: string
  readonly url: URL
  readonly body: Record<string, unknown> | undefined
  readonly headers: Record<string, string>
}

let snapshotCounter = 0
function snap(name: string, createdAt: Date, overrides: Partial<FakeSnapshot> = {}): FakeSnapshot {
  snapshotCounter += 1
  return {
    id: `dddddddd-0000-4000-8000-${String(snapshotCounter).padStart(12, '0')}`,
    name,
    created_at: createdAt.toISOString(),
    resource_id: LIVE_VOLUME_ID,
    resource_type: 'volume',
    tags: [SNAPSHOT_TAG],
    ...overrides,
  }
}

/** A daily snapshot taken `age` hours before NOW, named as the job names them. */
function daily(ageHours: number, overrides: Partial<FakeSnapshot> = {}): FakeSnapshot {
  const at = hoursAgo(ageHours)
  return snap(snapshotName(at), at, overrides)
}

function liveVolume(overrides: Partial<FakeVolume> = {}): FakeVolume {
  return {id: LIVE_VOLUME_ID, name: 'traces-data', droplet_ids: [DROPLET_ID], ...overrides}
}

function fakeDo(options: FakeDoOptions = {}) {
  const droplets = options.droplets ?? [{id: DROPLET_ID, name: 'traces'}]
  const volumes = options.volumes ?? [liveVolume()]
  const snapshots = options.snapshots ?? []
  const requests: DoRequest[] = []
  const pageSize = options.pageSize ?? 2
  let nextSnapshot = 9000

  function paged(url: URL, key: string, all: unknown[]): Response {
    const page = Number(url.searchParams.get('page') ?? '1')
    const slice = all.slice((page - 1) * pageSize, page * pageSize)
    const hasNext = page * pageSize < all.length
    const next = new URL(url)
    next.searchParams.set('page', String(page + 1))
    return Response.json({
      [key]: slice,
      links: hasNext ? {pages: {next: next.toString()}} : {},
      meta: {total: all.length},
    })
  }

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(String(input))
    const headers = (init?.headers ?? {}) as Record<string, string>
    const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined
    const call: DoRequest = {method: init?.method ?? 'GET', url, body, headers}
    requests.push(call)
    if (headers.authorization !== `Bearer ${TOKEN}`) return Response.json({id: 'unauthorized'}, {status: 401})
    const forced = options.override?.(call)
    if (forced !== undefined) return forced

    if (call.method === 'GET' && url.pathname === '/v2/droplets') {
      const name = url.searchParams.get('name')
      return paged(
        url,
        'droplets',
        droplets.filter(droplet => name === null || droplet.name === name),
      )
    }
    if (call.method === 'GET' && url.pathname === '/v2/volumes') return paged(url, 'volumes', volumes)
    if (call.method === 'GET' && url.pathname === '/v2/snapshots') {
      const type = url.searchParams.get('resource_type')
      return paged(
        url,
        'snapshots',
        snapshots.filter(item => type === null || item.resource_type === type),
      )
    }
    const create = /^\/v2\/volumes\/([^/]+)\/snapshots$/.exec(url.pathname)
    if (call.method === 'POST' && create !== null) {
      nextSnapshot += 1
      const created: FakeSnapshot = {
        id: `eeeeeeee-0000-4000-8000-${String(nextSnapshot).padStart(12, '0')}`,
        name: String(body?.name),
        created_at: NOW.toISOString(),
        resource_id: create[1] ?? '',
        resource_type: 'volume',
        tags: Array.isArray(body?.tags) ? (body.tags as string[]) : [],
      }
      if (options.createLost !== true) snapshots.push(created)
      return Response.json({snapshot: created}, {status: 201})
    }
    const remove = /^\/v2\/volumes\/snapshots\/([^/]+)$/.exec(url.pathname)
    if (call.method === 'DELETE' && remove !== null) {
      const index = snapshots.findIndex(item => item.id === remove[1])
      if (index === -1) return Response.json({id: 'not_found'}, {status: 404})
      snapshots.splice(index, 1)
      return new Response(null, {status: 204})
    }
    return Response.json({id: 'not_found'}, {status: 404})
  }

  return {
    fetch: fetchImpl,
    requests,
    snapshots,
    deletes: () => requests.filter(request => request.method === 'DELETE'),
    creates: () => requests.filter(request => request.method === 'POST'),
    names: () => snapshots.map(item => item.name),
  }
}

interface BackupRun {
  readonly outcome: Awaited<ReturnType<typeof runBackup>>
  readonly outputs: Record<string, string>
  readonly logs: string[]
  /** Every pause the run asked for, in milliseconds. The fake sleep returns at once. */
  readonly sleeps: number[]
}

async function backup(
  fake: ReturnType<typeof fakeDo>,
  environment: Record<string, string | undefined> = {TRACES_SNAPSHOT_DO_TOKEN: TOKEN, TRACES_DOMAIN: 'traces.fro.bot'},
  timeoutMs = 50,
): Promise<BackupRun> {
  const outputs: Record<string, string> = {}
  const logs: string[] = []
  const sleeps: number[] = []
  const outcome = await runBackup(environment, {
    fetch: fake.fetch,
    now: () => NOW,
    sleep: async milliseconds => {
      sleeps.push(milliseconds)
    },
    writeOutput: (name, value) => {
      outputs[name] = value
    },
    log: line => logs.push(line),
    appendSummary: line => logs.push(line),
    timeoutMs,
  })
  return {outcome, outputs, logs, sleeps}
}

/** Answers the first `count` snapshot listings (the unpaged request) with `respond`; later ones are the fake's own. */
function firstListings(count: number, respond: () => Response): (request: DoRequest) => Response | undefined {
  let seen = 0
  return request => {
    if (!isSnapshotListing(request)) return undefined
    seen += 1
    return seen <= count ? respond() : undefined
  }
}

function isSnapshotListing(request: DoRequest): boolean {
  return request.method === 'GET' && request.url.pathname === '/v2/snapshots' && !request.url.searchParams.has('page')
}

/** How many times the run listed snapshots from the first page. */
function listingCount(fake: ReturnType<typeof fakeDo>): number {
  return fake.requests.filter(isSnapshotListing).length
}

// ─── Backup ──────────────────────────────────────────────────────────────────

describe('backup: the host constants match the app', () => {
  it('names the droplet and the volume family as apps/traces/src/host.ts does', () => {
    expect(DROPLET_NAME).toBe(TRACES_DROPLET_NAME)
    expect(VOLUME_NAME).toBe(TRACES_VOLUME_NAME)
  })
})

describe('backup: create, confirm, prune', () => {
  it('creates one tagged snapshot, confirms it from the read-back, and succeeds', async () => {
    const fake = fakeDo({snapshots: [daily(25)]})
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, deployed: true, created: true, failures: [], deleted: 0})
    expect(run.outputs).toEqual({deployed: 'true'})
    expect(fake.creates()).toHaveLength(1)
    expect(fake.creates()[0]?.url.pathname).toBe(`/v2/volumes/${LIVE_VOLUME_ID}/snapshots`)
    expect(fake.creates()[0]?.body).toEqual({name: 'traces-20261120-1200', tags: [SNAPSHOT_TAG]})
    expect(run.outcome.newestAgeHours).toBe(0)
  })

  it('names the snapshot traces-<yyyymmdd>-<hhmm> in UTC', () => {
    expect(snapshotName(new Date('2026-01-02T03:04:59.000Z'))).toBe('traces-20260102-0304')
    expect(snapshotName(new Date('2026-12-31T23:59:00.000Z'))).toBe('traces-20261231-2359')
  })

  it('sends the bearer token to api.digitalocean.com only, and follows no redirect', async () => {
    const fake = fakeDo({snapshots: [daily(25)]})
    await backup(fake)

    for (const request of fake.requests) {
      expect(request.url.origin).toBe(API_ORIGIN)
      expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`)
    }
  })

  // The plan's scenario: snapshots aged 1 to 10 days; the 9- and 10-day-old ones go.
  it('with snapshots aged 1 to 10 days, creates one and deletes the 9- and 10-day-old ones', async () => {
    const aged = Array.from({length: 10}, (_unused, index) => {
      const at = daysAgo(index + 1)
      return snap(snapshotName(at), at)
    })
    const fake = fakeDo({snapshots: aged})
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, deleted: 2})
    const remaining = fake.snapshots.map(item => item.name)
    expect(remaining).not.toContain(snapshotName(daysAgo(9)))
    expect(remaining).not.toContain(snapshotName(daysAgo(10)))
    expect(remaining).toContain(snapshotName(daysAgo(8)))
    expect(remaining).toHaveLength(9)
  })

  it('keeps a snapshot exactly 8 days old and deletes one a minute past it', async () => {
    const edge = daysAgo(RETENTION_DAYS)
    const past = new Date(edge.getTime() - 60_000)
    const fake = fakeDo({snapshots: [snap(snapshotName(edge), edge), snap(snapshotName(past), past)]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(1)
    expect(fake.names()).toContain(snapshotName(edge))
    expect(fake.names()).not.toContain(snapshotName(past))
  })

  it('deletes the oldest first and at most 10 a run, so a backlog converges and a bad clock cannot wipe history', async () => {
    const old = Array.from({length: 14}, (_unused, index) => {
      const at = daysAgo(9 + index)
      return snap(snapshotName(at), at)
    })
    const fake = fakeDo({snapshots: [daily(2), ...old]})
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, deleted: MAX_DELETES_PER_RUN})
    // The four most recent expired snapshots (9 to 12 days old) survive for the next run.
    expect(fake.names()).toContain(snapshotName(daysAgo(9)))
    expect(fake.names()).toContain(snapshotName(daysAgo(12)))
    expect(fake.names()).not.toContain(snapshotName(daysAgo(22)))
  })

  it('deletes by the volume-snapshot endpoint, one DELETE per snapshot', async () => {
    const fake = fakeDo({snapshots: [daily(30), snap(snapshotName(daysAgo(9)), daysAgo(9))]})
    await backup(fake)

    const doomed = fake.deletes()
    expect(doomed).toHaveLength(1)
    expect(doomed[0]?.url.pathname).toMatch(/^\/v2\/volumes\/snapshots\/[\w-]+$/)
  })
})

describe('backup: which snapshots may be deleted', () => {
  const old = (name: string, overrides: Partial<FakeSnapshot> = {}): FakeSnapshot =>
    snap(name, daysAgo(12), {...overrides})

  // Mutation target: widening isOurs (deleting without the job's mark) fails these.
  it('never deletes a snapshot of another existing volume, named like ours, tagged or not', async () => {
    const untagged = old('traces-20261108-0300', {resource_id: OTHER_VOLUME_ID, tags: null})
    const tagged = old('traces-20261107-0300', {resource_id: OTHER_VOLUME_ID})
    const fake = fakeDo({
      volumes: [liveVolume(), {id: OTHER_VOLUME_ID, name: 'umami-data', droplet_ids: [1]}],
      snapshots: [daily(3), untagged, tagged],
    })
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(0)
    expect(fake.names()).toEqual(expect.arrayContaining(['traces-20261108-0300', 'traces-20261107-0300']))
    expect(fake.deletes()).toEqual([])
  })

  it('never deletes a snapshot of the live volume that is neither named nor marked as ours', async () => {
    const manual = old('before-the-big-change', {tags: null})
    const other = old('traces-notes', {tags: null})
    const droplet = old('traces-20261108-0300', {resource_type: 'droplet', tags: null})
    const fake = fakeDo({snapshots: [daily(3), manual, other, droplet]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(0)
    expect(fake.names()).toEqual(expect.arrayContaining(['before-the-big-change', 'traces-notes']))
  })

  it('never deletes a tagged snapshot whose name is not one of ours', async () => {
    const odd = old('keep-me', {tags: [SNAPSHOT_TAG]})
    const fake = fakeDo({snapshots: [daily(3), odd]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(0)
    expect(fake.names()).toContain('keep-me')
  })

  it('never deletes an untagged snapshot of a volume that no longer exists: with no tag and no family there is no mark', async () => {
    const orphan = old('traces-20261108-0300', {resource_id: OLD_VOLUME_ID, tags: null})
    const fake = fakeDo({snapshots: [daily(3), orphan]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(0)
    expect(fake.names()).toContain('traces-20261108-0300')
  })

  it('deletes a snapshot of a volume that no longer exists when this job tagged it', async () => {
    const orphan = old('traces-20261108-0300', {resource_id: OLD_VOLUME_ID})
    const fake = fakeDo({snapshots: [daily(3), orphan]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(1)
    expect(fake.names()).not.toContain('traces-20261108-0300')
  })

  it('deletes an old untagged manual pre-upgrade snapshot of the family under the same 8-day rule', async () => {
    const preUpgrade = old('traces-pre-collector-1-2', {tags: null})
    const young = snap('traces-pre-grafana-13', daysAgo(2), {tags: null})
    const fake = fakeDo({snapshots: [daily(3), preUpgrade, young]})
    const run = await backup(fake)

    expect(run.outcome.deleted).toBe(1)
    expect(fake.names()).not.toContain('traces-pre-collector-1-2')
    expect(fake.names()).toContain('traces-pre-grafana-13')
  })

  it('prunes a snapshot of the restored volume: the family includes traces-data-restore-<date>', async () => {
    const restored = 'dddddddd-1111-4000-8000-000000000009'
    const fake = fakeDo({
      volumes: [liveVolume({name: 'traces-data-restore-20261118', id: restored})],
      snapshots: [daily(3, {resource_id: restored}), old('traces-20261108-0300', {resource_id: restored, tags: null})],
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, deleted: 1})
  })

  it('classifies with isOurs and isDaily directly', () => {
    const family: VolumeScope = {family: new Set([LIVE_VOLUME_ID]), others: new Set(['umami'])}
    const base: Snapshot = {
      id: 'x',
      name: 'traces-20261108-0300',
      createdAt: 0,
      resourceId: LIVE_VOLUME_ID,
      resourceType: 'volume',
      tags: [],
    }
    expect(isOurs(base, family)).toBe(true)
    expect(isOurs({...base, resourceId: 'gone'}, family)).toBe(false)
    expect(isOurs({...base, resourceId: 'gone', tags: [SNAPSHOT_TAG]}, family)).toBe(true)
    expect(isOurs({...base, resourceId: 'umami', tags: [SNAPSHOT_TAG]}, family)).toBe(false)
    expect(isOurs({...base, name: 'traces-20261108-0300-x'}, family)).toBe(false)
    expect(isOurs({...base, name: 'Traces-20261108-0300'}, family)).toBe(false)
    expect(isOurs({...base, resourceType: 'droplet'}, family)).toBe(false)
    expect(isDaily(base, family)).toBe(true)
    expect(isDaily({...base, name: 'traces-pre-x'}, family)).toBe(false)
    expect(isOurs({...base, name: 'traces-pre-x'}, family)).toBe(true)
  })
})

describe('backup: a broken backup never erases history', () => {
  // Mutation target: pruning regardless of the newest snapshot's age fails these.
  it('fails and deletes nothing when the newest daily snapshot is 40 hours old and the create failed', async () => {
    const fake = fakeDo({
      snapshots: [daily(40), snap(snapshotName(daysAgo(12)), daysAgo(12))],
      override: request => (request.method === 'POST' ? Response.json({}, {status: 500}) : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(1)
    expect(run.outcome.failures).toEqual(['do-api:create-snapshot:http-500', 'newest-snapshot-too-old'])
    expect(fake.deletes()).toEqual([])
    expect(run.outcome.newestAgeHours).toBe(40)
  })

  it('fails the run when the newest snapshot is older than 36 hours after the create step', async () => {
    const fake = fakeDo({snapshots: [daily(40)], createLost: true})
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(1)
    expect(run.outcome.failures).toContain('newest-snapshot-too-old')
    expect(run.outcome.failures).toContain('created-snapshot-not-listed')
  })

  it('still treats a 30-hour-old newest snapshot as fresh: the threshold is 36 hours, not a day and a bit', async () => {
    const fake = fakeDo({
      snapshots: [daily(30), snap(snapshotName(daysAgo(9)), daysAgo(9))],
      override: request => (request.method === 'POST' ? Response.json({}, {status: 500}) : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toEqual(['do-api:create-snapshot:http-500'])
    expect(run.outcome.deleted).toBe(1)
  })

  it('pins the threshold at 36 hours', () => {
    expect(MAX_NEWEST_AGE_HOURS).toBe(36)
  })

  it('treats exactly 36 hours as fresh and a minute more as stale', async () => {
    const fresh = fakeDo({
      snapshots: [daily(MAX_NEWEST_AGE_HOURS)],
      override: r => (r.method === 'POST' ? Response.json({}, {status: 500}) : undefined),
    })
    expect((await backup(fresh)).outcome.failures).toEqual(['do-api:create-snapshot:http-500'])

    const at = new Date(hoursAgo(MAX_NEWEST_AGE_HOURS).getTime() - 60_000)
    const stale = fakeDo({
      snapshots: [snap(snapshotName(at), at)],
      override: r => (r.method === 'POST' ? Response.json({}, {status: 500}) : undefined),
    })
    expect((await backup(stale)).outcome.failures).toContain('newest-snapshot-too-old')
  })

  it('still prunes old snapshots when the create failed but the newest is fresh, and still fails the run', async () => {
    const fake = fakeDo({
      snapshots: [daily(20), snap(snapshotName(daysAgo(9)), daysAgo(9)), snap(snapshotName(daysAgo(10)), daysAgo(10))],
      override: request => (request.method === 'POST' ? Response.json({message: 'boom'}, {status: 422}) : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 1, created: false, deleted: 2})
    expect(run.outcome.failures).toEqual(['do-api:create-snapshot:http-422'])
  })

  it('counts only daily snapshots as the newest: a fresh manual snapshot cannot hide a dead daily job', async () => {
    const preUpgrade = snap('traces-pre-collector-9', hoursAgo(1), {tags: null})
    const fake = fakeDo({
      snapshots: [daily(60), preUpgrade, snap(snapshotName(daysAgo(12)), daysAgo(12))],
      override: request => (request.method === 'POST' ? Response.json({}, {status: 500}) : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toContain('newest-snapshot-too-old')
    expect(fake.deletes()).toEqual([])
  })

  it('fails when the created snapshot is not the newest daily snapshot', async () => {
    const future = new Date(NOW.getTime() + HOUR_MS)
    const fake = fakeDo({snapshots: [snap(snapshotName(future), future)]})
    const run = await backup(fake)

    expect(run.outcome.failures).toEqual(['created-snapshot-not-newest'])
  })

  it('fails on a first run with no snapshots at all only if the create also failed', async () => {
    const ok = await backup(fakeDo())
    expect(ok.outcome).toMatchObject({exitCode: 0, created: true})

    const bad = await backup(
      fakeDo({override: r => (r.method === 'POST' ? Response.json({}, {status: 500}) : undefined)}),
    )
    expect(bad.outcome.failures).toContain('newest-snapshot-too-old')
    expect(bad.outcome.newestAgeHours).toBeNull()
  })

  it('records a failed delete, keeps deleting the rest, and fails the run', async () => {
    const a = snap(snapshotName(daysAgo(9)), daysAgo(9))
    const b = snap(snapshotName(daysAgo(10)), daysAgo(10))
    const fake = fakeDo({
      snapshots: [daily(2), a, b],
      override: request =>
        request.method === 'DELETE' && request.url.pathname.endsWith(a.id)
          ? Response.json({}, {status: 500})
          : undefined,
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 1, deleted: 1})
    expect(run.outcome.failures).toEqual(['do-api:delete-snapshot:http-500'])
    expect(fake.names()).not.toContain(b.name)
  })
})

const createFails = (request: DoRequest): Response | undefined =>
  request.method === 'POST' ? Response.json({}, {status: 500}) : undefined

describe('backup: the read-back after a create is retried while the listing catches up', () => {
  it('pins the bounds: 6 attempts, 5 seconds apart', () => {
    expect(READBACK_ATTEMPTS).toBe(6)
    expect(READBACK_INTERVAL_MS).toBe(5000)
  })

  // Mutation target: removing the retry fails this and the next one.
  it('succeeds when the created snapshot is missing from the first listing and present in the second', async () => {
    const fake = fakeDo({
      snapshots: [daily(30)],
      override: firstListings(1, () => Response.json({snapshots: [], links: {}})),
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, failures: []})
    expect(listingCount(fake)).toBe(2)
    expect(run.sleeps).toEqual([READBACK_INTERVAL_MS])
    expect(fake.creates()).toHaveLength(1)
  })

  it('succeeds when the first listing is malformed and the second is well-formed, without a second create', async () => {
    const fake = fakeDo({
      snapshots: [daily(30)],
      override: firstListings(1, () => Response.json({snapshots: [{id: 'x'}], links: {}})),
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, failures: []})
    expect(listingCount(fake)).toBe(2)
    expect(run.sleeps).toEqual([READBACK_INTERVAL_MS])
    expect(fake.creates()).toHaveLength(1)
  })

  it('keeps trying through several bad listings and succeeds on the last allowed attempt', async () => {
    const fake = fakeDo({
      override: firstListings(READBACK_ATTEMPTS - 1, () => new Response('<html>', {status: 200})),
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, failures: []})
    expect(listingCount(fake)).toBe(READBACK_ATTEMPTS)
    expect(run.sleeps).toHaveLength(READBACK_ATTEMPTS - 1)
  })

  it('fails after the bounded attempts when the listing stays malformed, names the part, and deletes nothing', async () => {
    const expired = snap(snapshotName(daysAgo(12)), daysAgo(12))
    const fake = fakeDo({
      snapshots: [daily(2), expired],
      override: firstListings(100, () => Response.json({snapshots: [{id: 'x'}], links: {}})),
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 1, created: true, deleted: 0})
    expect(run.outcome.failures).toEqual(['do-api:list-snapshots:malformed:item.name'])
    expect(listingCount(fake)).toBe(READBACK_ATTEMPTS)
    expect(run.sleeps).toEqual(Array.from({length: READBACK_ATTEMPTS - 1}, () => READBACK_INTERVAL_MS))
    expect(fake.deletes()).toEqual([])
  })

  it('fails after the bounded attempts when the created snapshot never appears, and prunes nothing behind a stale newest', async () => {
    const fake = fakeDo({
      snapshots: [daily(40), snap(snapshotName(daysAgo(12)), daysAgo(12))],
      createLost: true,
    })
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(1)
    expect(run.outcome.failures).toEqual(['created-snapshot-not-listed', 'newest-snapshot-too-old'])
    expect(listingCount(fake)).toBe(READBACK_ATTEMPTS)
    expect(run.sleeps).toHaveLength(READBACK_ATTEMPTS - 1)
    expect(fake.deletes()).toEqual([])
  })

  it('makes no retry and no pause when nothing was created: one listing, as before', async () => {
    const badListing = firstListings(100, () => new Response('<html>'))
    const fake = fakeDo({
      snapshots: [daily(20)],
      override: request => createFails(request) ?? badListing(request),
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toEqual([
      'do-api:create-snapshot:http-500',
      'do-api:list-snapshots:malformed:not-json',
    ])
    expect(listingCount(fake)).toBe(1)
    expect(run.sleeps).toEqual([])

    const clean = fakeDo({snapshots: [daily(20)], override: createFails})
    const cleanRun = await backup(clean)
    expect(cleanRun.outcome.failures).toEqual(['do-api:create-snapshot:http-500'])
    expect(listingCount(clean)).toBe(1)
    expect(cleanRun.sleeps).toEqual([])
  })

  it('does not retry an HTTP or network failure of the read-back: those keep their existing handling', async () => {
    const http = fakeDo({
      override: request => (isSnapshotListing(request) ? Response.json({}, {status: 503}) : undefined),
    })
    const httpRun = await backup(http)
    expect(httpRun.outcome.failures).toEqual(['do-api:list-snapshots:http-503'])
    expect(listingCount(http)).toBe(1)
    expect(httpRun.sleeps).toEqual([])

    const inner = fakeDo()
    let listings = 0
    const flaky = {
      ...inner,
      fetch: (async (input, init) => {
        if (new URL(String(input)).pathname === '/v2/snapshots') {
          listings += 1
          throw new TypeError(`connect ECONNREFUSED SECRET-${TOKEN}`)
        }
        return inner.fetch(input, init)
      }) satisfies FetchLike,
    }
    const networkRun = await backup(flaky)
    expect(networkRun.outcome.failures).toEqual(['do-api:list-snapshots:network'])
    expect(listings).toBe(1)
    expect(networkRun.sleeps).toEqual([])
  })

  it('never deletes anything behind a listing with a malformed item, when nothing was created either', async () => {
    const expired = snap(snapshotName(daysAgo(12)), daysAgo(12))
    const fake = fakeDo({
      snapshots: [daily(2), expired],
      override: request =>
        createFails(request) ??
        (isSnapshotListing(request)
          ? Response.json({snapshots: [{...daily(2), id: 7}, expired], links: {}})
          : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toEqual(['do-api:create-snapshot:http-500', 'do-api:list-snapshots:malformed:item.id'])
    expect(fake.deletes()).toEqual([])
  })
})

describe('backup: a malformed response names the part that was wrong, from a closed set', () => {
  const good = daily(2)
  const without = (field: keyof FakeSnapshot): Record<string, unknown> => {
    const {[field]: _omitted, ...rest} = good
    return rest
  }

  // The create fails so the read-back is a single listing and the reason is the whole failure list.
  it.each<[string, () => Response, string]>([
    ['a body that is not JSON', () => new Response('<html>SECRET</html>'), 'not-json'],
    ['an empty body', () => new Response(''), 'not-json'],
    ['a JSON array', () => Response.json([good]), 'not-an-object'],
    ['JSON null', () => Response.json(null), 'not-an-object'],
    ['a snapshots key that is a string', () => Response.json({snapshots: 'SECRET'}), 'snapshots-not-a-list'],
    ['a missing snapshots key', () => Response.json({links: {}}), 'snapshots-not-a-list'],
    ['a snapshots key that is null', () => Response.json({snapshots: null}), 'snapshots-not-a-list'],
    ['an item that is a string', () => Response.json({snapshots: ['SECRET']}), 'item-not-an-object'],
    ['an item that is an array', () => Response.json({snapshots: [[]]}), 'item-not-an-object'],
    ['an item without id', () => Response.json({snapshots: [without('id')]}), 'item.id'],
    ['an item with a numeric id', () => Response.json({snapshots: [{...good, id: 7}]}), 'item.id'],
    ['an item without name', () => Response.json({snapshots: [without('name')]}), 'item.name'],
    ['an item without resource_id', () => Response.json({snapshots: [without('resource_id')]}), 'item.resource_id'],
    [
      'an item with a null resource_type',
      () => Response.json({snapshots: [{...good, resource_type: null}]}),
      'item.resource_type',
    ],
    ['an item without created_at', () => Response.json({snapshots: [without('created_at')]}), 'item.created_at'],
    [
      'an item with an unparseable created_at',
      () => Response.json({snapshots: [{...good, created_at: 'SECRET-not-a-date'}]}),
      'item.created_at',
    ],
    [
      'an item with a numeric created_at',
      () => Response.json({snapshots: [{...good, created_at: 1_700_000_000}]}),
      'item.created_at',
    ],
  ])('reports %s as a fixed malformed code, with nothing of the body in it', async (_label, respond, part) => {
    const fake = fakeDo({
      snapshots: [good],
      override: request => createFails(request) ?? (isSnapshotListing(request) ? respond() : undefined),
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toEqual(['do-api:create-snapshot:http-500', `do-api:list-snapshots:malformed:${part}`])
    expect(JSON.stringify(run)).not.toContain('SECRET')
    expect(fake.deletes()).toEqual([])
  })

  it('names the part for the other lists and for the create response too', async () => {
    const volumes = (body: () => Response) =>
      backup(fakeDo({override: r => (r.url.pathname === '/v2/volumes' ? body() : undefined)}))
    expect((await volumes(() => Response.json({volumes: [{id: 1, name: 'x'}]}))).outcome.failures).toContain(
      'do-api:list-volumes:malformed:item.id',
    )
    expect((await volumes(() => Response.json({volumes: [{id: 'x'}]}))).outcome.failures).toContain(
      'do-api:list-volumes:malformed:item.name',
    )
    expect((await volumes(() => Response.json({volumes: ['x']}))).outcome.failures).toContain(
      'do-api:list-volumes:malformed:item-not-an-object',
    )

    const droplets = await backup(
      fakeDo({override: r => (r.url.pathname === '/v2/droplets' ? Response.json({droplets: 'x'}) : undefined)}),
    )
    expect(droplets.outcome.failures).toContain('do-api:list-droplets:malformed:droplets-not-a-list')

    const noSnapshot = await backup(
      fakeDo({override: r => (r.method === 'POST' ? Response.json({}, {status: 201}) : undefined)}),
    )
    expect(noSnapshot.outcome.failures).toContain('do-api:create-snapshot:malformed:snapshot')
    const noId = await backup(
      fakeDo({override: r => (r.method === 'POST' ? Response.json({snapshot: {}}, {status: 201}) : undefined)}),
    )
    expect(noId.outcome.failures).toContain('do-api:create-snapshot:malformed:snapshot.id')
  })
})

describe('backup: finding the live volume', () => {
  // Mutation target: picking one of two candidates silently fails these.
  it('fails and takes no snapshot when two volumes of the family are attached to the droplet', async () => {
    const fake = fakeDo({
      volumes: [liveVolume(), liveVolume({id: OTHER_VOLUME_ID, name: 'traces-data-restore-20261118'})],
      snapshots: [daily(3)],
    })
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(1)
    expect(run.outcome.failures).toContain('volume-ambiguous')
    expect(run.outcome.created).toBe(false)
    expect(fake.creates()).toEqual([])
  })

  it('fails when no volume of the family is attached to the droplet', async () => {
    const fake = fakeDo({
      volumes: [liveVolume({droplet_ids: []}), liveVolume({id: OTHER_VOLUME_ID, name: 'umami-data'})],
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toContain('volume-not-found')
    expect(fake.creates()).toEqual([])
  })

  it('ignores a family volume attached to some other droplet, and a volume of another name on this one', async () => {
    const fake = fakeDo({
      volumes: [
        liveVolume({id: OTHER_VOLUME_ID, name: 'traces-data-restore-scratch', droplet_ids: [999]}),
        liveVolume({id: OLD_VOLUME_ID, name: 'traces-database', droplet_ids: [DROPLET_ID]}),
        liveVolume({name: 'traces-data-restore-20261118', droplet_ids: [DROPLET_ID]}),
      ],
      snapshots: [daily(3)],
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true})
    expect(fake.creates()[0]?.url.pathname).toBe(`/v2/volumes/${LIVE_VOLUME_ID}/snapshots`)
  })

  it('finds the restored volume by name family, never by a fixed id', async () => {
    const restored = 'ffffffff-0000-4000-8000-00000000000f'
    const fake = fakeDo({volumes: [liveVolume({id: restored, name: 'traces-data-restore-20261118'})]})
    await backup(fake)

    expect(fake.creates()[0]?.url.pathname).toBe(`/v2/volumes/${restored}/snapshots`)
  })

  it('fails when the droplet is missing or there are two of that name', async () => {
    expect((await backup(fakeDo({droplets: []}))).outcome.failures).toContain('droplet-not-found')
    const two = await backup(
      fakeDo({
        droplets: [
          {id: 1, name: 'traces'},
          {id: 2, name: 'traces'},
        ],
      }),
    )
    expect(two.outcome.failures).toContain('droplet-ambiguous')
  })

  it('does not match a droplet whose name only starts with traces', async () => {
    // The API filters by name already; the client must not rely on it.
    const fake = fakeDo({
      override: request =>
        request.url.pathname === '/v2/droplets'
          ? Response.json({droplets: [{id: DROPLET_ID, name: 'traces-scratch'}], links: {}})
          : undefined,
    })
    const run = await backup(fake)
    expect(run.outcome.failures).toContain('droplet-not-found')
    expect(fake.creates()).toEqual([])
  })

  it('selects with selectLiveVolume directly', () => {
    const volumes = [{id: 'v1', name: 'traces-data', dropletIds: [5]}]
    expect(selectLiveVolume(volumes, [{id: 5}]).id).toBe('v1')
    expect(() => selectLiveVolume(volumes, [{id: 6}])).toThrow()
    expect(() => selectLiveVolume(volumes, [])).toThrow()
    expect(isFamilyVolume('traces-data')).toBe(true)
    expect(isFamilyVolume('traces-data-restore-20261118')).toBe(true)
    expect(isFamilyVolume('traces-database')).toBe(false)
    expect(isFamilyVolume('traces')).toBe(false)
  })
})

describe('backup: pagination', () => {
  it('follows links.pages.next across a two-page listing of volumes, snapshots and droplets', async () => {
    // Page size 2: the live volume is on the second page, and so are the expired snapshots.
    const fake = fakeDo({
      pageSize: 2,
      volumes: [
        liveVolume({id: OTHER_VOLUME_ID, name: 'umami-data', droplet_ids: [1]}),
        liveVolume({id: OLD_VOLUME_ID, name: 'gateway-data', droplet_ids: [2]}),
        liveVolume(),
      ],
      snapshots: [
        daily(3),
        daily(5, {name: 'traces-20261115-0700'}),
        snap(snapshotName(daysAgo(9)), daysAgo(9)),
        snap(snapshotName(daysAgo(11)), daysAgo(11)),
      ],
    })
    const run = await backup(fake)

    expect(run.outcome).toMatchObject({exitCode: 0, created: true, deleted: 2})
    const pages = fake.requests
      .filter(request => request.method === 'GET')
      .map(request => request.url.searchParams.get('page'))
    expect(pages).toContain('2')
  })

  it('refuses a next link that leaves api.digitalocean.com and never sends the token there', async () => {
    const fake = fakeDo({
      override: request =>
        request.url.pathname === '/v2/volumes'
          ? Response.json({volumes: [], links: {pages: {next: 'https://evil.example/v2/volumes?page=2'}}})
          : undefined,
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toContain('do-api:list-volumes:bad-next-link')
    expect(fake.requests.every(request => request.url.hostname === 'api.digitalocean.com')).toBe(true)
  })

  it.each(['http://api.digitalocean.com/v2/volumes?page=2', 'https://api.digitalocean.com/other?page=2', 'not a url'])(
    'refuses the next link %s',
    async next => {
      const fake = fakeDo({
        override: request =>
          request.url.pathname === '/v2/volumes' ? Response.json({volumes: [], links: {pages: {next}}}) : undefined,
      })
      const run = await backup(fake)
      expect(run.outcome.failures).toContain('do-api:list-volumes:bad-next-link')
    },
  )

  it('stops a listing that never ends', async () => {
    const fake = fakeDo({
      override: request =>
        request.url.pathname === '/v2/volumes'
          ? Response.json({
              volumes: [],
              links: {pages: {next: 'https://api.digitalocean.com/v2/volumes?page=2'}},
            })
          : undefined,
    })
    const run = await backup(fake)
    expect(run.outcome.failures).toContain('do-api:list-volumes:too-many-pages')
  })
})

describe('backup: API failures name the stage and the status, nothing else', () => {
  it.each([
    [401, 'http-401'],
    [403, 'http-403'],
    [429, 'http-429'],
    [500, 'http-500'],
  ])('reports a %i on the volume listing as %s', async (status, detail) => {
    const fake = fakeDo({
      override: request =>
        request.url.pathname === '/v2/volumes' ? Response.json({message: 'SECRET detail'}, {status}) : undefined,
    })
    const run = await backup(fake)

    expect(run.outcome.exitCode).toBe(1)
    expect(run.outcome.failures).toContain(`do-api:list-volumes:${detail}`)
  })

  it('reports a malformed body, a network error and a timeout as fixed codes', async () => {
    const malformed = await backup(
      fakeDo({override: r => (r.url.pathname === '/v2/volumes' ? new Response('<html>', {status: 200}) : undefined)}),
    )
    expect(malformed.outcome.failures).toContain('do-api:list-volumes:malformed:not-json')

    const wrongShape = await backup(
      fakeDo({override: r => (r.url.pathname === '/v2/volumes' ? Response.json({volumes: 'x'}) : undefined)}),
    )
    expect(wrongShape.outcome.failures).toContain('do-api:list-volumes:malformed:volumes-not-a-list')

    const down: FetchLike = async () => {
      throw new TypeError(`connect ECONNREFUSED api.digitalocean.com SECRET-${TOKEN}`)
    }
    const network = await backup({...fakeDo(), fetch: down})
    expect(network.outcome.failures).toContain('do-api:list-volumes:network')

    const hung: FetchLike = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')))
      })
    const slow = await backup({...fakeDo(), fetch: hung}, undefined, 20)
    expect(slow.outcome.failures).toContain('do-api:list-volumes:timeout')
  })

  it('treats a redirect as a failure rather than following it', async () => {
    const fake = fakeDo({
      override: request =>
        request.url.pathname === '/v2/volumes'
          ? new Response(null, {status: 302, headers: {location: 'https://evil.example/'}})
          : undefined,
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toContain('do-api:list-volumes:http-302')
    expect(fake.requests.every(request => request.url.hostname === 'api.digitalocean.com')).toBe(true)
  })

  it('never writes the token, a response body, a volume id or an error message to any log line', async () => {
    const runs = [
      await backup(fakeDo({snapshots: [daily(3)]})),
      await backup(
        fakeDo({
          override: r =>
            r.url.pathname === '/v2/volumes' ? Response.json({message: 'SECRET detail'}, {status: 500}) : undefined,
        }),
      ),
      await backup(fakeDo({volumes: [liveVolume(), liveVolume({id: OTHER_VOLUME_ID})]})),
      await backup({
        ...fakeDo(),
        fetch: async () => {
          throw new TypeError(`ECONNREFUSED ${TOKEN}`)
        },
      }),
    ]
    for (const run of runs) {
      const text = run.logs.join('\n')
      expect(text).not.toContain(TOKEN)
      expect(text).not.toContain('SECRET')
      expect(text).not.toContain('ECONNREFUSED')
      expect(text).not.toContain(LIVE_VOLUME_ID)
      expect(text).not.toContain(OTHER_VOLUME_ID)
      expect(text).not.toMatch(/[\da-f]{8}-[\da-f]{4}-/)
    }
  })

  it('refuses an id that is not a plain identifier before it reaches a URL', async () => {
    const fake = fakeDo({
      volumes: [liveVolume({id: '../../account'})],
    })
    const run = await backup(fake)

    expect(run.outcome.failures).toContain('do-api:create-snapshot:bad-id')
    expect(fake.creates()).toEqual([])
  })
})

describe('backup: not deployed yet', () => {
  // Only an unset TRACES_DOMAIN means "not deployed". Mutation target: reading a missing token as not deployed passes
  // the green case below and fails the red one.
  it.each([
    [{TRACES_SNAPSHOT_DO_TOKEN: TOKEN, TRACES_DOMAIN: ''}],
    [{TRACES_SNAPSHOT_DO_TOKEN: TOKEN, TRACES_DOMAIN: '  '}],
    [{TRACES_SNAPSHOT_DO_TOKEN: TOKEN, TRACES_DOMAIN: undefined}],
    [{TRACES_SNAPSHOT_DO_TOKEN: undefined, TRACES_DOMAIN: undefined}],
    [{}],
  ])('exits green with a notice and calls nothing when the domain is unset: %j', async environment => {
    const fake = fakeDo({snapshots: [daily(40)]})
    const run = await backup(fake, environment)

    expect(run.outcome).toMatchObject({exitCode: 0, deployed: false, failures: [], created: false})
    expect(run.outputs).toEqual({deployed: 'false'})
    expect(fake.requests).toEqual([])
    expect(
      run.logs.some(
        line => line.startsWith('::notice::') && line.includes('TRACES_DOMAIN') && line.includes('not deployed'),
      ),
    ).toBe(true)
    expect(run.logs.some(line => line.includes('::error::'))).toBe(false)
  })
})

describe('backup: the snapshot token is missing after deployment', () => {
  it.each([
    [{TRACES_SNAPSHOT_DO_TOKEN: undefined, TRACES_DOMAIN: 'traces.fro.bot'}],
    [{TRACES_SNAPSHOT_DO_TOKEN: '', TRACES_DOMAIN: 'traces.fro.bot'}],
    [{TRACES_SNAPSHOT_DO_TOKEN: '  ', TRACES_DOMAIN: 'traces.fro.bot'}],
  ])('fails with a fixed reason, calls nothing and says the stack is deployed: %j', async environment => {
    const fake = fakeDo({snapshots: [daily(40)]})
    const run = await backup(fake, environment)

    expect(run.outcome).toMatchObject({
      exitCode: 1,
      deployed: true,
      failures: ['snapshot-token-missing'],
      created: false,
      deleted: 0,
    })
    expect(run.outputs).toEqual({deployed: 'true'})
    expect(fake.requests).toEqual([])
    expect(run.logs.some(line => line.startsWith('::error::') && line.includes('TRACES_SNAPSHOT_DO_TOKEN'))).toBe(true)
    expect(run.logs.some(line => line.includes('::notice::'))).toBe(false)
  })

  it('opens the alert: the failed result of this run maps to a real alert, not to nothing', async () => {
    const run = await backup(fakeDo({}), {TRACES_SNAPSHOT_DO_TOKEN: undefined, TRACES_DOMAIN: 'traces.fro.bot'})
    const result = run.outcome.exitCode === 0 ? 'success' : 'failure'
    const deployed = run.outputs.deployed === 'true' ? 'true' : 'false'

    expect(planBackupAlert({backupResult: result, deployed, rehearse: 'none'})).toEqual({
      kind: 'alert',
      identity: 'real',
    })
  })
})

// ─── Alert ───────────────────────────────────────────────────────────────────

function details(result: string, prefix = '- '): string[] {
  return [
    `${prefix}Workflow: Traces Backup`,
    `${prefix}Run: ${RUN_URL}`,
    `${prefix}Backup job result: ${result}`,
    `${prefix}Runbook: ${RUNBOOK_URL}`,
  ]
}

function discordDetails(result: string, issue: number): string[] {
  const [workflow, run, outcome, runbook] = details(result, '')
  return [workflow ?? '', run ?? '', outcome ?? '', `Issue: https://github.com/${REPO}/issues/${issue}`, runbook ?? '']
}

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    GITHUB_REPOSITORY: REPO,
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '9876543210',
    GITHUB_WORKFLOW: 'Traces Backup',
    GITHUB_ACTOR: 'marcusrbrown',
    GITHUB_REPOSITORY_OWNER: 'marcusrbrown',
    ALERT_BACKUP_RESULT: 'failure',
    ALERT_BACKUP_DEPLOYED: 'true',
    ALERT_REHEARSE: 'none',
    ALERT_RUN_ATTEMPT: '1',
    ...overrides,
  }
}

interface FakeIssue {
  number: number
  title: string
  body: string | null
  state: 'open' | 'closed'
  labels: string[]
  pull_request?: unknown
}

interface GhCall {
  readonly args: readonly string[]
  readonly method: string
  readonly stdin: string | undefined
}

function fakeGh(
  initial: FakeIssue[],
  options: {labels?: readonly string[]; fail?: (call: GhCall) => GhResult | undefined} = {},
) {
  const issues = [...initial]
  const labels = new Set(options.labels ?? [])
  const calls: GhCall[] = []
  let nextNumber = Math.max(100, ...issues.map(issue => issue.number + 1))
  let nextId = 5000
  const ok = (stdout: string): GhResult => ({code: 0, stdout, stderr: ''})

  const gh: GhRunner = async (args, stdin) => {
    const methodIndex = args.indexOf('--method')
    const method = methodIndex === -1 ? 'GET' : (args[methodIndex + 1] ?? 'GET')
    const call: GhCall = {args, method, stdin}
    calls.push(call)
    const forced = options.fail?.(call)
    if (forced !== undefined) return forced

    const path = args.at(-1) ?? ''
    const body = stdin === undefined ? {} : (JSON.parse(stdin) as Record<string, unknown>)

    if (method === 'GET' && args.includes('--paginate')) {
      const query = new URLSearchParams(path.split('?')[1] ?? '')
      const state = query.get('state') ?? 'open'
      const label = query.get('labels')
      const matched = issues.filter(
        issue => (state === 'all' || issue.state === state) && (label === null || issue.labels.includes(label)),
      )
      const pages: FakeIssue[][] = []
      for (let index = 0; index < matched.length; index += 2) pages.push(matched.slice(index, index + 2))
      const api = (issue: FakeIssue): unknown => ({
        number: issue.number,
        body: issue.body,
        state: issue.state,
        labels: issue.labels.map(name => ({name})),
        ...(issue.pull_request === undefined ? {} : {pull_request: issue.pull_request}),
      })
      return ok(JSON.stringify(pages.length === 0 ? [[]] : pages.map(page => page.map(api))))
    }
    const labelProbe = /^repos\/[^/]+\/[^/]+\/labels\/(.+)$/.exec(path)
    if (method === 'GET' && labelProbe !== null) {
      return labels.has(decodeURIComponent(labelProbe[1] ?? ''))
        ? ok('HTTP/2.0 200 OK\n')
        : {code: 1, stdout: 'HTTP/2.0 404 Not Found\n', stderr: 'gh: Not Found (HTTP 404)'}
    }
    if (method === 'POST' && /\/labels$/.test(path)) {
      labels.add(String(body.name))
      return ok(JSON.stringify({id: nextId++, name: body.name}))
    }
    if (method === 'POST' && /\/issues$/.test(path)) {
      const number = nextNumber++
      issues.push({
        number,
        title: String(body.title),
        body: String(body.body),
        state: 'open',
        labels: Array.isArray(body.labels) ? body.labels.map(String) : [],
      })
      return ok(
        JSON.stringify({number, id: nextId++, state: 'open', html_url: `https://github.com/${REPO}/issues/${number}`}),
      )
    }
    if (method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) return ok(JSON.stringify({id: nextId++}))
    const patch = /\/issues\/(\d+)$/.exec(path)
    if (method === 'PATCH' && patch !== null) {
      const issue = issues.find(candidate => candidate.number === Number(patch[1]))
      if (issue === undefined) return {code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)'}
      issue.state = body.state === 'closed' ? 'closed' : 'open'
      return ok(JSON.stringify({number: issue.number, state: issue.state}))
    }
    return {code: 1, stdout: '', stderr: `unexpected gh call: ${args.join(' ')}`}
  }

  return {
    gh,
    calls,
    issues,
    labels,
    writes: () => calls.filter(call => call.method !== 'GET'),
    payloads: () => calls.flatMap(call => (call.stdin === undefined ? [] : [call.stdin])),
    comments: () =>
      calls
        .filter(call => /\/comments$/.test(call.args.at(-1) ?? ''))
        .map(call => ({
          issue: Number(/issues\/(\d+)\/comments$/.exec(call.args.at(-1) ?? '')?.[1]),
          body: String((JSON.parse(call.stdin ?? '{}') as {body?: unknown}).body),
        })),
  }
}

function realIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return {
    number: 7,
    title: 'Trace data backup is failing',
    body: `${REAL_MARKER}\nolder text`,
    state: 'open',
    labels: [ALERT_LABEL],
    ...overrides,
  }
}

function rehearsalIssue(overrides: Partial<FakeIssue> = {}): FakeIssue {
  return realIssue({
    number: 8,
    title: '[Rehearsal] Trace data backup alert',
    body: `${REHEARSAL_MARKER}\nolder rehearsal`,
    ...overrides,
  })
}

interface IssueRun {
  readonly exitCode: number
  readonly outputs: Record<string, string>
  readonly logs: string[]
}

async function issueStep(
  overrides: Record<string, string | undefined>,
  fake: ReturnType<typeof fakeGh>,
): Promise<IssueRun> {
  const outputs: Record<string, string> = {}
  const logs: string[] = []
  const result = await runIssueStep(baseEnv(overrides), {
    gh: fake.gh,
    writeOutput: (name, value) => {
      outputs[name] = value
    },
    log: line => logs.push(line),
    appendSummary: line => logs.push(line),
  })
  return {exitCode: result.exitCode, outputs, logs}
}

async function notifyStep(
  overrides: Record<string, string | undefined>,
  responder: () => Response = () => new Response(null, {status: 204}),
) {
  const calls: {url: string; body: string}[] = []
  const logs: string[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({url: String(input), body: String(init?.body ?? '')})
    return responder()
  }
  const summary = await runNotifyStep(
    baseEnv({
      ALERT_NOTIFY: 'created',
      ALERT_ISSUE_NUMBER: '101',
      CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      ...overrides,
    }),
    {
      fetch: fetchImpl,
      sleep: async () => {},
      log: line => logs.push(line),
      appendSummary: line => logs.push(line),
      timeoutMs: 20,
    },
  )
  return {calls, logs, summary}
}

describe('planBackupAlert', () => {
  it.each([
    ['failure', 'true', {kind: 'alert', identity: 'real'}],
    ['cancelled', '', {kind: 'alert', identity: 'real'}],
    ['success', 'true', {kind: 'clear', identity: 'real'}],
    ['success', 'false', {kind: 'none'}],
    ['skipped', '', {kind: 'none'}],
  ] as const)('maps a %s backup with deployed=%j to %j', (backupResult, deployed, expected) => {
    expect(planBackupAlert({backupResult, deployed, rehearse: 'none'})).toEqual(expected)
  })

  it('refuses a green backup that did not say whether it took a backup', () => {
    expect(() => planBackupAlert({backupResult: 'success', deployed: '', rehearse: 'none'})).toThrow()
  })

  it('uses the rehearsal identity whatever the backup did', () => {
    for (const backupResult of ['failure', 'success', 'skipped'] as const) {
      expect(planBackupAlert({backupResult, deployed: '', rehearse: 'fail'})).toEqual({
        kind: 'alert',
        identity: 'rehearsal',
      })
      expect(planBackupAlert({backupResult, deployed: '', rehearse: 'clear'})).toEqual({
        kind: 'clear',
        identity: 'rehearsal',
      })
    }
  })
})

describe('readAlertEnv', () => {
  it('rejects values outside the known sets and reads an empty rehearsal as none', () => {
    expect(() => readAlertEnv(baseEnv({ALERT_BACKUP_RESULT: 'timed_out'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({ALERT_BACKUP_DEPLOYED: 'yes'}))).toThrow()
    expect(() => readAlertEnv(baseEnv({ALERT_REHEARSE: 'maybe'}))).toThrow()
    expect(readAlertEnv(baseEnv({ALERT_REHEARSE: ''})).rehearse).toBe('none')
  })
})

describe('issue step', () => {
  it('opens one labelled, marked issue on the first failing run and asks for one Discord message', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.issues).toHaveLength(1)
    expect(fake.issues[0]?.labels).toEqual([ALERT_LABEL])
    expect(fake.issues[0]?.title).toBe('Trace data backup is failing')
    expect(fake.issues[0]?.body).toBe(
      [
        REAL_MARKER,
        'The daily snapshot of the trace data volume failed, or the newest snapshot is older than 36 hours. Until a run succeeds the trace data is not backed up. Open the run for which step failed, then follow the runbook (docs/runbooks/trace-collection.md).',
        '',
        ...details('failure'),
        '',
        'This issue closes when a backup run succeeds.',
      ].join('\n'),
    )
    expect(run.outputs).toEqual({notify: 'created', 'issue-number': '100'})
  })

  it('comments on the open issue of the same outage, daily, and asks for no Discord message', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(fake.comments()).toEqual([
      {issue: 7, body: ['The backup failed again.', '', ...details('failure')].join('\n')},
    ])
    expect(run.outputs).toEqual({notify: 'none', 'issue-number': '7'})
  })

  it('treats a cancelled backup (the reported result of a timeout) like a failure', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'cancelled', ALERT_BACKUP_DEPLOYED: ''}, fake)

    expect(run.outputs.notify).toBe('created')
  })

  it('comments, closes and asks for one recovery message when the backup succeeds', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'success'}, fake)

    expect(fake.comments()).toEqual([
      {issue: 7, body: ['The backup succeeded, so this issue is closed.', '', ...details('success')].join('\n')},
    ])
    expect(fake.issues[0]?.state).toBe('closed')
    expect(run.outputs).toEqual({notify: 'recovered', 'issue-number': '7'})
  })

  it('does nothing, and writes nothing, when the backup succeeds and no issue is open', async () => {
    const fake = fakeGh([realIssue({state: 'closed'})], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'success'}, fake)

    expect(fake.writes()).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  // Mutation target: treating `deployed=false` (the domain is unset) as a failure makes this alert every day.
  it('does nothing at all when the backup reports the stack is not deployed yet', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'success', ALERT_BACKUP_DEPLOYED: 'false'}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })

  it('does nothing when the backup was skipped', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'skipped', ALERT_BACKUP_DEPLOYED: ''}, fake)

    expect(fake.calls).toEqual([])
    expect(run.outputs.notify).toBe('none')
  })

  it('does not treat a labelled issue without the marker, a pull request or a closed issue as ours', async () => {
    const fake = fakeGh(
      [
        realIssue({number: 3, body: 'by hand'}),
        realIssue({number: 4, pull_request: {url: 'x'}}),
        realIssue({number: 5, state: 'closed'}),
      ],
      {labels: [ALERT_LABEL]},
    )
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })

  // Mutation target: reading a missing or malformed `labels` as an empty list hides the open issue, and a duplicate is
  // opened. The shared parse is covered field by field in go-privacy-alert.test.ts.
  it.each([
    ['labels missing', {number: 7, state: 'open', body: REAL_MARKER}],
    ['labels not an array', {number: 7, state: 'open', body: REAL_MARKER, labels: ALERT_LABEL}],
    ['a label without a string name', {number: 7, state: 'open', body: REAL_MARKER, labels: [{name: 5}]}],
  ])('fails the lookup and takes no action when the listing has %s', async (_name, entry) => {
    for (const result of ['failure', 'success']) {
      const fake = fakeGh([], {
        labels: [ALERT_LABEL],
        fail: call =>
          call.args.includes('--paginate') ? {code: 0, stdout: JSON.stringify([[entry]]), stderr: ''} : undefined,
      })
      const run = await issueStep({ALERT_BACKUP_RESULT: result}, fake)

      expect(run.exitCode).toBe(1)
      expect(run.outputs).toEqual({notify: 'none'})
      expect(fake.writes()).toEqual([])
    }
  })

  it('creates the label on first use', async () => {
    const fake = fakeGh([])
    await issueStep({}, fake)
    expect(fake.labels.has(ALERT_LABEL)).toBe(true)
  })

  it('fails the job when the issue API fails, naming the stage and not the response', async () => {
    const fake = fakeGh([], {
      labels: [ALERT_LABEL],
      fail: call => (call.method === 'POST' ? {code: 1, stdout: '', stderr: 'gh: Server Error (HTTP 500)'} : undefined),
    })
    const run = await issueStep({}, fake)

    expect(run.exitCode).toBe(1)
    expect(run.logs.join('\n')).not.toContain('Server Error')
  })

  it.each(['2', '3', undefined, '', 'x'])('makes no API call on run attempt %j', async attempt => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_BACKUP_RESULT: 'success', ALERT_RUN_ATTEMPT: attempt}, fake)

    expect(run.exitCode).toBe(0)
    expect(fake.calls).toEqual([])
    expect(run.outputs).toEqual({notify: 'none'})
  })
})

describe('issue step: rehearsal', () => {
  it('is owner-only and refuses before any API call', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const run = await issueStep({ALERT_REHEARSE: 'fail', GITHUB_ACTOR: 'someone-else'}, fake)

    expect(run.exitCode).toBe(1)
    expect(fake.calls).toEqual([])
  })

  it('opens, comments on and closes a marked rehearsal issue, one Discord request at each transition, without touching a real one', async () => {
    const fake = fakeGh([realIssue()], {labels: [ALERT_LABEL]})
    const skipped = {ALERT_BACKUP_RESULT: 'skipped', ALERT_BACKUP_DEPLOYED: ''}

    const opened = await issueStep({...skipped, ALERT_REHEARSE: 'fail'}, fake)
    expect(opened.outputs).toEqual({notify: 'created', 'issue-number': '100'})
    expect(fake.issues.find(issue => issue.number === 100)?.body?.startsWith(`${REHEARSAL_MARKER}\n`)).toBe(true)
    expect(fake.issues.find(issue => issue.number === 100)?.title).toBe('[Rehearsal] Trace data backup alert')

    const again = await issueStep({...skipped, ALERT_REHEARSE: 'fail'}, fake)
    expect(again.outputs).toEqual({notify: 'none', 'issue-number': '100'})
    expect(fake.comments().filter(comment => comment.issue === 100)).toHaveLength(1)

    const cleared = await issueStep({...skipped, ALERT_REHEARSE: 'clear'}, fake)
    expect(cleared.outputs).toEqual({notify: 'recovered', 'issue-number': '100'})
    expect(fake.issues.find(issue => issue.number === 100)?.state).toBe('closed')
    expect(fake.issues.find(issue => issue.number === 7)?.state).toBe('open')
  })

  it('never lets an open rehearsal issue absorb a real failure', async () => {
    const fake = fakeGh([rehearsalIssue()], {labels: [ALERT_LABEL]})
    const run = await issueStep({}, fake)

    expect(run.outputs.notify).toBe('created')
    expect(fake.comments()).toEqual([])
  })
})

describe('notify step', () => {
  it('posts nothing when no message was asked for', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'none'})
    expect(run.calls).toEqual([])
  })

  it('posts the failure message once, with mentions off and embeds suppressed', async () => {
    const run = await notifyStep({})

    expect(run.calls).toHaveLength(1)
    expect(run.calls[0]?.url).toBe(WEBHOOK)
    const payload = JSON.parse(run.calls[0]?.body ?? '{}') as Record<string, unknown>
    expect(payload.allowed_mentions).toEqual({parse: []})
    expect(payload.flags).toBe(4)
    expect(payload.content).toBe(
      [
        '**Trace data backup failed**',
        'Until a backup run succeeds the trace data is not backed up. Check it now.',
        ...discordDetails('failure', 101),
      ].join('\n'),
    )
  })

  it('posts the recovery message', async () => {
    const run = await notifyStep({ALERT_NOTIFY: 'recovered', ALERT_BACKUP_RESULT: 'success', ALERT_ISSUE_NUMBER: '7'})
    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content

    expect(content).toBe(
      [
        '**Trace data backup recovered**',
        'A backup run succeeded. The alert issue is closed.',
        ...discordDetails('success', 7),
      ].join('\n'),
    )
  })

  it('marks a rehearsal message', async () => {
    const run = await notifyStep({ALERT_REHEARSE: 'fail'})
    const content = (JSON.parse(run.calls[0]?.body ?? '{}') as {content: string}).content

    expect(content.startsWith('**[REHEARSAL] Trace data backup failed**')).toBe(true)
    expect(content).toContain('Rehearsal: no backup ran and nothing is wrong.')
  })

  it('skips, and does not fail, when the webhook is unset or blank', async () => {
    for (const webhook of [undefined, '', '   ']) {
      const run = await notifyStep({CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: webhook})
      expect(run.calls).toEqual([])
      expect(run.summary).toMatchObject({outcome: 'skipped', reason: 'webhook-unset'})
    }
  })

  it('never writes the webhook or the response text to any log line', async () => {
    const outcomes = [await notifyStep({}), await notifyStep({}, () => new Response(`echo ${WEBHOOK}`, {status: 500}))]
    for (const run of outcomes) {
      const text = run.logs.join('\n')
      expect(text).not.toContain(WEBHOOK)
      expect(text).not.toContain('SECRET-token_value')
      expect(text).not.toContain('echo')
    }
  })
})

describe('content is built from fixed strings and the github context only', () => {
  it('carries no token, id or API text: nothing from the backup step can reach it', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    await issueStep(
      {
        TRACES_SNAPSHOT_DO_TOKEN: TOKEN,
        GH_TOKEN: 'ghs_secrettoken',
        BACKUP_ERROR: `volume ${LIVE_VOLUME_ID} do-api:list-volumes:http-403`,
        CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK: WEBHOOK,
      },
      fake,
    )
    const delivered = await notifyStep({})

    const written = [...fake.payloads(), ...delivered.calls.map(call => call.body)].join('\n')
    for (const forbidden of [TOKEN, 'ghs_secrettoken', LIVE_VOLUME_ID, 'http-403', 'SECRET-token_value']) {
      expect(written).not.toContain(forbidden)
    }
    expect(written).toContain('docs/runbooks/trace-collection.md')
  })

  it('keeps mention, markup and link characters in the free-text workflow name out of every message', () => {
    const env = readAlertEnv(baseEnv({GITHUB_WORKFLOW: 'Traces Backup @everyone <@1234> [x](http://evil.example)'}))
    for (const kind of ['created', 'recovered'] as const) {
      const content = buildDiscordContent(kind, env, 12)
      expect(content).not.toMatch(/[@<>[\]()]/)
      expect(content).not.toContain('://evil')
    }
  })
})

describe('one outage, end to end', () => {
  it('posts to Discord twice across a three-day outage: on creation and on recovery', async () => {
    const fake = fakeGh([], {labels: [ALERT_LABEL]})
    const posts: string[] = []

    async function day(result: string): Promise<void> {
      const issue = await issueStep({ALERT_BACKUP_RESULT: result}, fake)
      const delivered = await notifyStep({
        ALERT_BACKUP_RESULT: result,
        ALERT_NOTIFY: issue.outputs.notify,
        ALERT_ISSUE_NUMBER: issue.outputs['issue-number'],
      })
      posts.push(...delivered.calls.map(call => call.body))
    }

    await day('failure')
    await day('failure')
    await day('cancelled')
    expect(posts).toHaveLength(1)
    expect(fake.issues).toHaveLength(1)
    expect(fake.comments()).toHaveLength(2)

    await day('success')
    expect(posts).toHaveLength(2)
    expect(fake.issues[0]?.state).toBe('closed')

    await day('success')
    expect(posts).toHaveLength(2)
  })
})
