import type {History, HistorySample} from './history'
import type {AppId, Observation} from './observation'
import {chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {notMeasured, observe} from './collect'
import {
  assertHistoryInvariants,
  compactSample,
  HISTORY_MAX_BYTES,
  HISTORY_WINDOW_MS,
  historyAppFileSchema,
  HistoryError,
  historyMetaSchema,
  historySampleSchema,
  loadHistory,
  mergeHistory,
  recordByApp,
  serializeHistory,
  writeHistory,
} from './history'
import {APP_IDS} from './observation'

const NOW = new Date('2026-11-01T12:00:00.000Z')
const HOUR = 3_600_000
const DAY = 24 * HOUR

function iso(offsetMs: number, base: Date = NOW): string {
  return new Date(base.getTime() + offsetMs).toISOString()
}

let runCounter = 0

function sample(offsetMs: number, overrides: Partial<HistorySample> = {}): HistorySample {
  runCounter += 1
  return {t: iso(offsetMs), run: String(1000 + runCounter), att: 1, r: {'public-reachability': 'p'}, ...overrides}
}

function historyOf(samples: (app: AppId) => HistorySample[]): History {
  const apps = recordByApp(samples)
  const all = APP_IDS.flatMap(app => apps[app])
  const newest = all.reduce(
    (max, entry) => (Date.parse(entry.t) > Date.parse(max) ? entry.t : max),
    all[0]?.t ?? iso(0),
  )
  return {meta: {schemaVersion: 1, lastSampleAt: newest}, apps}
}

function incomingFor(run = '9001', att = 1, at: Date = NOW): Record<AppId, HistorySample> {
  return recordByApp(() => ({t: at.toISOString(), run, att, r: {'public-reachability': 'p'}}))
}

function errorCode(run: () => unknown): string {
  try {
    run()
  } catch (error) {
    if (error instanceof HistoryError) return error.code
    throw error
  }
  throw new Error('expected a HistoryError')
}

async function errorCodeAsync(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    if (error instanceof HistoryError) return error.code
    throw error
  }
  throw new Error('expected a HistoryError')
}

/** 10 days of 6-hour samples ending one hour before NOW. */
function tenDays(): History {
  return historyOf(() => Array.from({length: 40}, (_, index) => sample(-HOUR - index * 6 * HOUR)))
}

describe('merge: happy path', () => {
  it('appends exactly one sample per app to 10 days of history and moves meta.lastSampleAt', () => {
    const previous = tenDays()
    const before = APP_IDS.map(app => previous.apps[app].length)

    const merged = mergeHistory({previous, incoming: incomingFor(), now: NOW})

    expect(merged.added).toBe(APP_IDS.length)
    expect(merged.trimmed).toBe(0)
    APP_IDS.forEach((app, index) => {
      expect(merged.history.apps[app]).toHaveLength((before[index] ?? 0) + 1)
      expect(merged.history.apps[app].at(-1)?.run).toBe('9001')
    })
    expect(merged.history.meta).toEqual({schemaVersion: 1, lastSampleAt: NOW.toISOString()})
  })

  it('keeps samples ordered by time when an incoming sample is slightly older than the newest', () => {
    const previous = historyOf(() => [sample(-HOUR), sample(0)])
    const merged = mergeHistory({
      previous,
      incoming: incomingFor('9002', 1, new Date(NOW.getTime() - 60_000)),
      now: NOW,
    })

    const times = merged.history.apps.keeweb.map(entry => Date.parse(entry.t))
    expect(times).toEqual([...times].sort((a, b) => a - b))
    expect(merged.history.meta.lastSampleAt).toBe(NOW.toISOString())
  })

  it('creates the first history from nothing', () => {
    const merged = mergeHistory({previous: undefined, incoming: incomingFor(), now: NOW})

    for (const app of APP_IDS) expect(merged.history.apps[app]).toHaveLength(1)
    expect(merged.added).toBe(APP_IDS.length)
  })
})

describe('merge: window and duplicates', () => {
  it('trims samples older than 90 days and the invariants allow exactly that drop', () => {
    const previous = historyOf(() => [
      sample(-91 * DAY),
      sample(-HISTORY_WINDOW_MS - 1),
      sample(-HISTORY_WINDOW_MS),
      sample(-DAY),
    ])

    const merged = mergeHistory({previous, incoming: incomingFor(), now: NOW})

    // The sample exactly on the boundary is inside the window; one millisecond earlier is not.
    expect(merged.trimmed).toBe(2 * APP_IDS.length)
    for (const app of APP_IDS) {
      expect(merged.history.apps[app].map(entry => entry.t)).toEqual([
        iso(-HISTORY_WINDOW_MS),
        iso(-DAY),
        NOW.toISOString(),
      ])
    }
  })

  it('treats a rerun of the same run and attempt as a no-op', () => {
    const first = mergeHistory({previous: tenDays(), incoming: incomingFor('9001', 1), now: NOW})
    const rerun = mergeHistory({previous: first.history, incoming: incomingFor('9001', 1), now: NOW})

    expect(rerun.added).toBe(0)
    expect(rerun.trimmed).toBe(0)
    expect(rerun.history).toEqual(first.history)
  })

  it('treats a new attempt of the same run as a new sample, and a rerun with a later clock as a no-op', () => {
    const first = mergeHistory({previous: tenDays(), incoming: incomingFor('9001', 1), now: NOW})
    const retry = mergeHistory({previous: first.history, incoming: incomingFor('9001', 2), now: NOW})
    const later = new Date(NOW.getTime() + 60_000)
    const rerun = mergeHistory({previous: first.history, incoming: incomingFor('9001', 1, later), now: later})

    expect(retry.added).toBe(APP_IDS.length)
    expect(rerun.added).toBe(0)
    expect(rerun.history.apps.keeweb.at(-1)?.t).toBe(NOW.toISOString())
  })
})

describe('invariants (merge rejects, nothing is returned)', () => {
  it('rejects a merged history that drops a sample inside the window', () => {
    const previous = tenDays()
    const next: History = {
      ...previous,
      apps: {...previous.apps, gateway: previous.apps.gateway.slice(1)},
    }

    expect(errorCode(() => assertHistoryInvariants({previous, next, now: NOW}))).toBe('sample-dropped')
  })

  it('allows dropping only samples older than the window', () => {
    const old = sample(-100 * DAY)
    const recent = sample(-DAY)
    const previous = historyOf(() => [old, recent])
    const next = historyOf(() => [recent])

    expect(() => assertHistoryInvariants({previous, next, now: NOW})).not.toThrow()
  })

  it('rejects an input history whose last sample is newer than the merged result (stale read)', () => {
    const previous = tenDays()
    // The meta file claims a newer sample than any app file holds, and the new sample is older than the claim.
    const stale: History = {...previous, meta: {schemaVersion: 1, lastSampleAt: iso(-60_000)}}

    const code = errorCode(() =>
      mergeHistory({previous: stale, incoming: incomingFor('9001', 1, new Date(NOW.getTime() - 2 * HOUR)), now: NOW}),
    )

    expect(code).toBe('newest-regressed')
  })

  it('rejects a merged result whose meta.lastSampleAt is older than the previous one', () => {
    const previous = tenDays()
    const next: History = {...previous, meta: {schemaVersion: 1, lastSampleAt: iso(-30 * DAY)}}

    expect(errorCode(() => assertHistoryInvariants({previous, next, now: NOW}))).toBe('newest-regressed')
  })

  it('rejects an unknown app id', () => {
    const base = tenDays()
    const apps = {...base.apps, bogus: base.apps.keeweb}

    expect(
      errorCode(() => assertHistoryInvariants({previous: undefined, next: {meta: base.meta, apps}, now: NOW})),
    ).toBe('unknown-app')
  })

  it('rejects a sample dated more than 5 minutes in the future and accepts exactly 5 minutes', () => {
    const tooFar = historyOf(() => [sample(5 * 60_000 + 1)])
    const edge = historyOf(() => [sample(5 * 60_000)])

    expect(errorCode(() => assertHistoryInvariants({previous: undefined, next: tooFar, now: NOW}))).toBe(
      'future-sample',
    )
    expect(() => assertHistoryInvariants({previous: undefined, next: edge, now: NOW})).not.toThrow()
  })

  it('rejects a previous history that already holds a future sample', () => {
    const previous = historyOf(app => [sample(app === 'broker' ? 10 * 60_000 : -HOUR)])

    expect(errorCode(() => mergeHistory({previous, incoming: incomingFor(), now: NOW}))).toBe('future-sample')
  })

  it('rejects duplicate run and attempt pairs inside one app', () => {
    const duplicate = sample(-HOUR)
    const next = historyOf(app => (app === 'vpn' ? [duplicate, {...duplicate, t: iso(-2 * HOUR)}] : [sample(-HOUR)]))

    expect(errorCode(() => assertHistoryInvariants({previous: undefined, next, now: NOW}))).toBe('duplicate-sample')
  })

  it('caps the whole history at 10 MB uncompressed, exactly at the limit', () => {
    expect(HISTORY_MAX_BYTES).toBe(10 * 1024 * 1024)
    const next = tenDays()
    const {bytes} = serializeHistory(next)

    expect(() => assertHistoryInvariants({previous: undefined, next, now: NOW, maxBytes: bytes})).not.toThrow()
    expect(errorCode(() => assertHistoryInvariants({previous: undefined, next, now: NOW, maxBytes: bytes - 1}))).toBe(
      'too-large',
    )
  })

  it('rejects a history over the real 10 MB cap', () => {
    const next = historyOf(() =>
      Array.from({length: 15_000}, (_, index) =>
        sample(-index * 60_000, {r: {'public-reachability': 'p', 'deploy-state': 'p'}}),
      ),
    )

    expect(serializeHistory(next).bytes).toBeGreaterThan(HISTORY_MAX_BYTES)
    expect(errorCode(() => assertHistoryInvariants({previous: undefined, next, now: NOW}))).toBe('too-large')
  })
})

describe('schemas', () => {
  const valid = {t: NOW.toISOString(), run: '1', att: 1, r: {'public-reachability': 'p'}}

  it('accepts the compact sample shape with and without detail', () => {
    expect(historySampleSchema.safeParse(valid).success).toBe(true)
    expect(
      historySampleSchema.safeParse({...valid, d: {'public-reachability': {statusCode: 200, reason: 'ok'}}}).success,
    ).toBe(true)
  })

  it('rejects unexpected keys, bad result codes, free-text runs and detail for unmeasured ids', () => {
    expect(historySampleSchema.safeParse({...valid, extra: 1}).success).toBe(false)
    expect(historySampleSchema.safeParse({...valid, r: {'public-reachability': 'x'}}).success).toBe(false)
    expect(historySampleSchema.safeParse({...valid, run: 'https://example.invalid'}).success).toBe(false)
    expect(historySampleSchema.safeParse({...valid, r: {}}).success).toBe(false)
    expect(historySampleSchema.safeParse({...valid, d: {other: {reason: 'ok'}}}).success).toBe(false)
    expect(historySampleSchema.safeParse({...valid, d: {'public-reachability': {durationMs: 5}}}).success).toBe(false)
    expect(
      historySampleSchema.safeParse({...valid, d: {'public-reachability': {url: 'https://x.invalid'}}}).success,
    ).toBe(false)
  })

  it('pins schemaVersion 1 in meta and requires the app file to be a list', () => {
    expect(historyMetaSchema.safeParse({schemaVersion: 1, lastSampleAt: NOW.toISOString()}).success).toBe(true)
    expect(historyMetaSchema.safeParse({schemaVersion: 2, lastSampleAt: NOW.toISOString()}).success).toBe(false)
    expect(historyAppFileSchema.safeParse({}).success).toBe(false)
    expect(historyAppFileSchema.safeParse([valid]).success).toBe(true)
  })
})

describe('compactSample', () => {
  const at = NOW
  const pass = (id: string, detail?: Observation['detail']): Observation =>
    observe({id, kind: 'reachability', source: 'http'}, 'pass', {now: at, ...(detail === undefined ? {} : {detail})})

  it('maps results to short codes in observation order', () => {
    const compact = compactSample(
      [
        pass('public-reachability'),
        observe({id: 'deploy-state', kind: 'deploy-state', source: 'github-api'}, 'fail', {now: at}),
        observe({id: 'provider-route', kind: 'end-to-end', source: 'monitor'}, 'unknown', {now: at}),
        notMeasured({id: 'egress', kind: 'end-to-end'}, 'missing-config'),
      ],
      {run: '77', att: 2},
      at,
    )

    expect(compact).toEqual({
      t: at.toISOString(),
      run: '77',
      att: 2,
      r: {'public-reachability': 'p', 'deploy-state': 'f', 'provider-route': 'u', egress: 'n'},
      d: {egress: {reason: 'missing-config'}},
    })
    expect(Object.keys(compact.r)).toEqual(['public-reachability', 'deploy-state', 'provider-route', 'egress'])
  })

  it('drops detail keys outside the allowlist, including durationMs and any unexpected key', () => {
    const detail = {
      statusCode: 200,
      durationMs: 42,
      contractVersion: '2.4.0',
      reason: 'ok',
      body: 'secret',
      url: 'https://internal.example.invalid/x',
    }
    const compact = compactSample([pass('public-reachability', detail)], {run: '1', att: 1}, at)

    expect(compact.d).toEqual({'public-reachability': {statusCode: 200, contractVersion: '2.4.0', reason: 'ok'}})
    expect(JSON.stringify(compact)).not.toContain('secret')
    expect(JSON.stringify(compact)).not.toContain('internal')
  })

  it('keeps since and probeAt and omits d when nothing survives', () => {
    const since = '2026-11-01T11:00:00Z'
    const probeAt = '2026-11-01T11:55:00.000Z'
    const withTimes = compactSample(
      [pass('deploy-state', {since}), pass('provider-route', {probeAt})],
      {run: '1', att: 1},
      at,
    )
    const bare = compactSample([pass('public-reachability', {durationMs: 3})], {run: '1', att: 1}, at)

    expect(withTimes.d).toEqual({'deploy-state': {since}, 'provider-route': {probeAt}})
    expect('d' in bare).toBe(false)
  })

  it('rejects an invalid run id or attempt', () => {
    expect(errorCode(() => compactSample([pass('public-reachability')], {run: 'not a run', att: 1}, at))).toBe(
      'invalid-sample',
    )
    expect(errorCode(() => compactSample([pass('public-reachability')], {run: '1', att: 0}, at))).toBe('invalid-sample')
    expect(errorCode(() => compactSample([], {run: '1', att: 1}, at))).toBe('invalid-sample')
  })
})

describe('history on disk', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'status-history-'))
  })

  afterEach(async () => {
    await chmod(join(dir, 'apps'), 0o700).catch(() => undefined)
    await rm(dir, {recursive: true, force: true})
  })

  async function seed(history: History = tenDays()): Promise<History> {
    await writeHistory(dir, history)
    return history
  }

  async function snapshotDir(): Promise<Record<string, string>> {
    const out: Record<string, string> = {}
    for (const entry of await readdir(dir, {recursive: true})) {
      if (entry.endsWith('.json') || entry.endsWith('.tmp')) out[entry] = await readFile(join(dir, entry), 'utf8')
    }
    return out
  }

  it('round-trips a history through writeHistory and loadHistory', async () => {
    const history = await seed()

    expect(await loadHistory(dir, 'existing')).toEqual(history)
    expect((await readdir(join(dir, 'apps'))).sort()).toEqual(APP_IDS.map(app => `${app}.json`).sort())
    expect(Object.keys(await snapshotDir()).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it('serializes compactly with the contract field names', async () => {
    await seed(
      historyOf(() => [
        {t: iso(0), run: '5', att: 1, r: {'public-reachability': 'p'}, d: {'public-reachability': {statusCode: 200}}},
      ]),
    )

    expect(await readFile(join(dir, 'apps', 'keeweb.json'), 'utf8')).toBe(
      `[{"t":"${iso(0)}","run":"5","att":1,"r":{"public-reachability":"p"},"d":{"public-reachability":{"statusCode":200}}}]`,
    )
    expect(await readFile(join(dir, 'meta.json'), 'utf8')).toBe(`{"schemaVersion":1,"lastSampleAt":"${iso(0)}"}`)
  })

  it('refuses to load a missing history without bootstrap', async () => {
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('missing-history')
    expect(await errorCodeAsync(() => loadHistory(join(dir, 'nope'), 'existing'))).toBe('missing-history')
  })

  it('bootstraps from an empty or missing directory and refuses an existing history', async () => {
    expect(await loadHistory(dir, 'bootstrap')).toBeUndefined()
    expect(await loadHistory(join(dir, 'new', 'deeper'), 'bootstrap')).toBeUndefined()

    await seed()
    expect(await errorCodeAsync(() => loadHistory(dir, 'bootstrap'))).toBe('history-exists')
  })

  it('refuses to bootstrap over app files that have no meta.json', async () => {
    await mkdir(join(dir, 'apps'))
    await writeFile(join(dir, 'apps', 'keeweb.json'), '[]')

    expect(await errorCodeAsync(() => loadHistory(dir, 'bootstrap'))).toBe('history-exists')
  })

  it('rejects an unsupported schemaVersion, a malformed meta and malformed app files', async () => {
    await seed()
    const meta = join(dir, 'meta.json')

    await writeFile(meta, JSON.stringify({schemaVersion: 2, lastSampleAt: NOW.toISOString()}))
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('unsupported-schema')

    await writeFile(meta, '{not json')
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('malformed')

    await writeFile(meta, JSON.stringify({schemaVersion: 1, lastSampleAt: NOW.toISOString()}))
    await writeFile(join(dir, 'apps', 'gateway.json'), '{"not":"a list"}')
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('malformed')

    await writeFile(join(dir, 'apps', 'gateway.json'), JSON.stringify([{t: 'yesterday'}]))
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('malformed')
  })

  it('rejects a missing app file and an unknown app file', async () => {
    await seed()
    await rm(join(dir, 'apps', 'vpn.json'))
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('malformed')

    await writeFile(join(dir, 'apps', 'vpn.json'), '[]')
    await writeFile(join(dir, 'apps', 'bogus.json'), '[]')
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('unknown-app')
  })

  it('rejects a duplicate run and attempt inside a stored app file', async () => {
    await seed()
    const duplicate = sample(-HOUR)
    await writeFile(join(dir, 'apps', 'umami.json'), JSON.stringify([duplicate, {...duplicate, t: iso(-2 * HOUR)}]))

    expect(await errorCodeAsync(() => loadHistory(dir, 'existing'))).toBe('duplicate-sample')
  })

  it('rejects stored history larger than the cap before parsing it', async () => {
    const history = await seed()
    const {bytes} = serializeHistory(history)

    expect(await loadHistory(dir, 'existing', {maxBytes: bytes})).toEqual(history)
    expect(await errorCodeAsync(() => loadHistory(dir, 'existing', {maxBytes: bytes - 1}))).toBe('too-large')
  })

  it('leaves the existing history and the directory untouched when a write fails', async () => {
    await seed()
    const before = await snapshotDir()
    // A read-only apps directory makes the first temp file fail.
    await chmod(join(dir, 'apps'), 0o500)

    const failure = await writeHistory(dir, tenDays()).then(
      () => undefined,
      (error: unknown) => error,
    )
    await chmod(join(dir, 'apps'), 0o700)

    if (process.getuid?.() === 0) return // root ignores directory modes
    expect(failure).toBeInstanceOf(Error)
    expect(await snapshotDir()).toEqual(before)
  })
})
