import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  advanceCounter,
  assembleVerdict,
  blockEndMs,
  buildCanary,
  CANARY_GROUP,
  CANARY_PLACES,
  CLICKHOUSE_READER_USER,
  createReporter,
  emptyCounterState,
  ENDPOINTS,
  evaluateAge,
  evaluateCollectorMetrics,
  evaluateDisk,
  evaluateLangfuseReadback,
  evaluateQueues,
  evaluateTempoMetrics,
  evaluateTempoReadback,
  evaluateVolume,
  EXPECTED_EXPORTERS,
  GROUPS,
  handleDetail,
  handlePublic,
  objectKeyTime,
  parsePrometheus,
  PATHS,
  readTempoBlockMetasFrom,
  REQUIRED_CHECKS,
  SENTINEL_CONTENT,
  TEMPO_DROPPED_PLACES,
  TEMPO_KEPT_PLACES,
  THRESHOLDS,
  usedPercent,
  type CanaryPlace,
  type CheckResult,
  type ObjectStoreReader,
  type ReporterDeps,
} from './health-report'
import {SENDER_GROUPS, TRACES_SENTINEL_CONTENT} from './host'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000

const CLICKHOUSE_PASSWORD = 'placeholder-clickhouse-password'
const MINIO_PASSWORD = 'placeholder-minio-password'

type Rec = Record<string, unknown>

function record(value: unknown, label: string): Rec {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error(`${label} is not a mapping`)
  return value as Rec
}

function counter(): (bytes: number) => string {
  let next = 0
  return bytes => {
    next += 1
    return next.toString(16).padStart(bytes * 2, '0')
  }
}

function collectorPage(extra = '', queues: Record<string, [number, number]> = {}): string {
  const lines = ['# HELP otelcol_process_uptime_seconds_total Uptime', 'otelcol_process_uptime_seconds_total 1234']
  for (const exporter of EXPECTED_EXPORTERS) {
    const [size, capacity] = queues[exporter] ?? [0, 1_073_741_824]
    lines.push(
      `otelcol_exporter_queue_size{data_type="traces",exporter="${exporter}"} ${size}`,
      `otelcol_exporter_queue_capacity{data_type="traces",exporter="${exporter}"} ${capacity}`,
    )
  }
  return `${lines.join('\n')}\n${extra}\n`
}

function tempoPage(extra = ''): string {
  return `tempo_build_info{version="3.1.1"} 1\n${extra}\n`
}

function check(detail: string, id: string): CheckResult {
  const parsed = record(JSON.parse(detail), 'detail')
  const found = (parsed.checks as CheckResult[]).find(entry => entry.id === id)
  if (found === undefined) throw new Error(`no check ${id}`)
  return found
}

interface Behaviour {
  collectorHealth: number | 'throw' | 'garbage'
  collectorMetrics: string | number | 'throw'
  tempoReady: number | 'throw'
  tempoMetrics: string | number | 'throw'
  langfuseWeb: number | 'throw'
  langfuseWorker: number | 'throw'
  canaryPost: number | 'throw'
  /** Places Langfuse is missing, or `all` when the trace never arrives. */
  langfuseMissing: readonly CanaryPlace[] | 'all'
  /** Places present in Tempo, or `none` when the trace never arrives. */
  tempoPlaces: readonly CanaryPlace[] | 'none'
  tempoTrace: 'json' | 'garbage' | 500
  clickhouseOldestMs: number | undefined
  clickhouseStatus: number
  objectKeys: string[]
  tempoBlocks: string[]
  volumeUsed: number
  rootUsed: number
  sentinel: string | 'throw'
  secretsMissing: boolean
}

function defaults(): Behaviour {
  return {
    collectorHealth: 200,
    collectorMetrics: collectorPage(),
    tempoReady: 200,
    tempoMetrics: tempoPage(),
    langfuseWeb: 200,
    langfuseWorker: 200,
    canaryPost: 200,
    langfuseMissing: [],
    tempoPlaces: TEMPO_KEPT_PLACES,
    tempoTrace: 'json',
    clickhouseOldestMs: NOW - 2 * DAY,
    clickhouseStatus: 200,
    objectKeys: ['events/otel/project-a/2026/11/18/09/30/batch.json'],
    tempoBlocks: [JSON.stringify({endTime: new Date(NOW - 3 * DAY).toISOString()})],
    volumeUsed: 40,
    rootUsed: 30,
    sentinel: `${SENTINEL_CONTENT}\n`,
    secretsMissing: false,
  }
}

interface Request {
  url: string
  method: string
  headers: Record<string, string>
  body: string
}

function reply(status: number | 'throw', body = ''): Response {
  if (status === 'throw') throw new TypeError('connect ECONNREFUSED internal-detail')
  return new Response(status >= 200 && status < 300 ? body : 'error body', {status})
}

function harness(overrides: Partial<Behaviour> = {}) {
  const behaviour = {...defaults(), ...overrides}
  const requests: Request[] = []
  const state = {now: NOW, posted: undefined as string | undefined}

  /** The text that stands for the canary in a backend, built from the posted body and a set of places. */
  function textFor(places: readonly CanaryPlace[]): string {
    const posted = state.posted ?? ''
    const found: string[] = []
    for (const match of posted.matchAll(/canary-([a-z-]+?)-[\da-f]{8}/g)) {
      const place = match[1] as CanaryPlace
      if (places.includes(place)) found.push(match[0])
    }
    return found.join(' ')
  }

  const fetcher = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
    const body = typeof init?.body === 'string' ? init.body : ''
    requests.push({url, method: init?.method ?? 'GET', headers, body})

    if (url === ENDPOINTS.collectorHealth) {
      if (behaviour.collectorHealth === 'garbage') return new Response('<html>hi</html>', {status: 200})
      return reply(behaviour.collectorHealth, '{"status":"Server available"}')
    }
    if (url === ENDPOINTS.collectorMetrics)
      return reply(
        typeof behaviour.collectorMetrics === 'string' ? 200 : behaviour.collectorMetrics,
        String(behaviour.collectorMetrics),
      )
    if (url === ENDPOINTS.tempoReady) return reply(behaviour.tempoReady, 'ready')
    if (url === ENDPOINTS.tempoMetrics)
      return reply(
        typeof behaviour.tempoMetrics === 'string' ? 200 : behaviour.tempoMetrics,
        String(behaviour.tempoMetrics),
      )
    if (url === ENDPOINTS.langfuseWeb) return reply(behaviour.langfuseWeb, '{"status":"OK"}')
    if (url === ENDPOINTS.langfuseWorker) return reply(behaviour.langfuseWorker, '{"status":"ok"}')
    if (url === ENDPOINTS.canaryReceiver) {
      state.posted = body
      return reply(behaviour.canaryPost, '{}')
    }
    if (url.startsWith(ENDPOINTS.tempoTraceBase)) {
      if (state.posted === undefined || behaviour.tempoPlaces === 'none') return new Response('', {status: 404})
      if (behaviour.tempoTrace === 500) return new Response('x', {status: 500})
      if (behaviour.tempoTrace === 'garbage') return new Response('not json', {status: 200})
      return new Response(JSON.stringify({batches: [textFor(behaviour.tempoPlaces)]}), {status: 200})
    }
    if (url.startsWith(ENDPOINTS.clickhouse)) {
      if (behaviour.clickhouseStatus !== 200) return new Response('boom', {status: behaviour.clickhouseStatus})
      if (body.includes('count() AS n')) {
        const oldest = behaviour.clickhouseOldestMs
        return new Response(
          oldest === undefined ? '{"n":"0","oldest":0}' : `{"n":"7","oldest":${Math.floor(oldest / 1000)}}`,
          {status: 200},
        )
      }
      if (body.includes('SELECT * FROM')) {
        if (state.posted === undefined || behaviour.langfuseMissing === 'all') return new Response('', {status: 200})
        const places = CANARY_PLACES.filter(
          place => !(behaviour.langfuseMissing as readonly CanaryPlace[]).includes(place),
        )
        return new Response(JSON.stringify({text: textFor(places)}), {status: 200})
      }
    }
    throw new Error(`unexpected request ${url}`)
  }

  const objectStore = (password: string): ObjectStoreReader => {
    requests.push({url: 'object-store', method: 'LIST', headers: {password}, body: ''})
    return {
      childPrefixes: async () => (behaviour.objectKeys.length > 0 ? ['events/otel/project-a/'] : []),
      firstKey: async () => behaviour.objectKeys[0],
    }
  }

  const fsFor = (used: number) => ({blocks: 1000, bfree: 1000 - used * 10, bavail: 1000 - used * 10})

  const deps: ReporterDeps = {
    fetch: fetcher,
    now: () => state.now,
    sleep: async ms => {
      state.now += ms
    },
    randomHex: counter(),
    statfs: async path => {
      if (path === PATHS.volumeSentinel) return fsFor(behaviour.volumeUsed)
      if (path === PATHS.rootProbe) return fsFor(behaviour.rootUsed)
      throw new Error('unexpected path')
    },
    readText: async path => {
      if (path === PATHS.volumeSentinel) {
        if (behaviour.sentinel === 'throw') throw new Error('gone')
        return behaviour.sentinel
      }
      if (behaviour.secretsMissing) throw new Error('ENOENT')
      if (path === PATHS.clickhousePasswordFile) return `${CLICKHOUSE_PASSWORD}\n`
      if (path === PATHS.objectStorePasswordFile) return `${MINIO_PASSWORD}\n`
      throw new Error('unexpected path')
    },
    readTempoBlockMetas: async () => behaviour.tempoBlocks,
    objectStore,
  }

  return {deps, requests, state, behaviour}
}

async function runOnce(overrides: Partial<Behaviour> = {}) {
  const world = harness(overrides)
  const reporter = createReporter(world.deps)
  await reporter.runOnce()
  return {...world, reporter, detail: reporter.detail()}
}

// ─── Prometheus text ──────────────────────────────────────────────────────────

describe('parsePrometheus', () => {
  it('reads names, labels and values, and skips comments, blanks and timestamps', () => {
    const samples = parsePrometheus(
      ['# HELP x help', '', 'a_total{k="v",other="o,p"} 3 1700000000000', 'b 2.5', 'c{} 0'].join('\n'),
    )
    expect(samples).toEqual([
      {name: 'a_total', labels: {k: 'v', other: 'o,p'}, value: 3},
      {name: 'b', labels: {}, value: 2.5},
      {name: 'c', labels: {}, value: 0},
    ])
  })

  it('yields nothing for a page that is not metrics, and keeps a non-number as NaN', () => {
    expect(parsePrometheus('<html><body>hi there</body></html>')).toEqual([])
    expect(Number.isNaN(parsePrometheus('a NaNish')[0]?.value)).toBe(true)
  })
})

// ─── Counters ─────────────────────────────────────────────────────────────────

describe('advanceCounter', () => {
  it('sets a baseline on the first reading and counts growth after it', () => {
    const first = advanceCounter(emptyCounterState(), 'k', 12, 1000)
    expect(first.growth).toBe(0)
    const second = advanceCounter(first.state, 'k', 15, 2000)
    expect(second.growth).toBe(3)
    expect(second.state.lastRise.k).toBe(2000)
  })

  it('treats a lower value as a restarted process and counts the whole new value', () => {
    const base = advanceCounter(emptyCounterState(), 'k', 50, 1000).state
    expect(advanceCounter(base, 'k', 4, 2000).growth).toBe(4)
    expect(advanceCounter(base, 'k', 0, 2000).growth).toBe(0)
  })
})

// ─── Collector metrics ────────────────────────────────────────────────────────

describe('evaluateQueues', () => {
  const sizes = (size: number) => parsePrometheus(collectorPage('', {'otlp_http/tempo': [size, 100]}))

  it('passes below the threshold', () => {
    expect(evaluateQueues(sizes(79)).status).toBe('pass')
  })

  it('fails at the threshold and names the exporter and the fill', () => {
    const out = evaluateQueues(sizes(80))
    expect(out.status).toBe('fail')
    expect(out.detail).toContain('otlp_http/tempo')
    expect(out.detail).toContain('80.0%')
  })

  it('is unknown when an expected exporter has no queue metric', () => {
    const samples = parsePrometheus(collectorPage()).filter(sample => sample.labels.exporter !== 'otlp_http/tempo')
    const out = evaluateQueues(samples)
    expect(out.status).toBe('unknown')
    expect(out.detail).toContain('otlp_http/tempo')
  })

  it('does not trust a zero or negative capacity', () => {
    expect(evaluateQueues(parsePrometheus(collectorPage('', {'otlp_http/tempo': [0, 0]}))).status).toBe('fail')
  })
})

describe('evaluateCollectorMetrics', () => {
  const growth = (
    n: number,
    exporter = 'otlp_http/langfuse-fro-bot',
    metric = 'otelcol_exporter_enqueue_failed_spans',
  ) => collectorPage(`${metric}{exporter="${exporter}"} ${n}`)

  it('passes with zero failures when the counters are absent, which is how an unused counter looks', () => {
    const out = evaluateCollectorMetrics(collectorPage(), emptyCounterState(), NOW)
    expect(out.results.map(entry => [entry.id, entry.status])).toEqual([
      ['collector-queues', 'pass'],
      ['collector-failures', 'pass'],
      ['collector-refused', 'pass'],
    ])
  })

  it('is unknown for everything when the page is not the collector (no uptime sentinel)', () => {
    for (const text of ['', '<html></html>', 'otelcol_exporter_queue_size{exporter="otlp_http/tempo"} 0\n']) {
      const out = evaluateCollectorMetrics(text, emptyCounterState(), NOW)
      expect(out.results.map(entry => entry.status)).toEqual(['unknown', 'unknown', 'unknown'])
    }
  })

  it('fails when an enqueue-failure counter rose since the last run, naming the exporter', () => {
    const first = evaluateCollectorMetrics(growth(0), emptyCounterState(), NOW)
    const second = evaluateCollectorMetrics(growth(12), first.state, NOW + 1000)
    const failures = second.results.find(entry => entry.id === 'collector-failures')
    expect(failures?.status).toBe('fail')
    expect(failures?.detail).toContain('otlp_http/langfuse-fro-bot enqueue failed')
  })

  it('fails on a send-failure counter, with and without the _total suffix', () => {
    for (const metric of ['otelcol_exporter_send_failed_spans', 'otelcol_exporter_send_failed_spans_total']) {
      const first = evaluateCollectorMetrics(growth(0, 'otlp_http/tempo', metric), emptyCounterState(), NOW)
      const second = evaluateCollectorMetrics(growth(3, 'otlp_http/tempo', metric), first.state, NOW + 1000)
      expect(second.results.find(entry => entry.id === 'collector-failures')?.status).toBe('fail')
    }
  })

  it('names the group whose spans were refused', () => {
    const page = (n: number) =>
      collectorPage(`otelcol_receiver_refused_spans{receiver="otlp/workstation",transport="http"} ${n}`)
    const first = evaluateCollectorMetrics(page(0), emptyCounterState(), NOW)
    const second = evaluateCollectorMetrics(page(5), first.state, NOW + 1000)
    const refused = second.results.find(entry => entry.id === 'collector-refused')
    expect(refused?.status).toBe('fail')
    expect(refused?.detail).toContain('workstation')
  })

  it('keeps failing for the latch window after the counter stops rising, then clears', () => {
    const first = evaluateCollectorMetrics(growth(0), emptyCounterState(), NOW)
    const risen = evaluateCollectorMetrics(growth(4), first.state, NOW + 1000)
    const stillLatched = evaluateCollectorMetrics(growth(4), risen.state, NOW + 1000 + THRESHOLDS.lossLatchMs - 1)
    expect(stillLatched.results.find(entry => entry.id === 'collector-failures')?.status).toBe('fail')
    const cleared = evaluateCollectorMetrics(growth(4), stillLatched.state, NOW + 2000 + THRESHOLDS.lossLatchMs)
    expect(cleared.results.find(entry => entry.id === 'collector-failures')?.status).toBe('pass')
  })

  it('does not count a counter that was already above zero on the first reading', () => {
    const out = evaluateCollectorMetrics(growth(99), emptyCounterState(), NOW)
    expect(out.results.find(entry => entry.id === 'collector-failures')?.status).toBe('pass')
  })

  it('is unknown for a counter that is not a number', () => {
    const out = evaluateCollectorMetrics(growth(-1), emptyCounterState(), NOW)
    expect(out.results.find(entry => entry.id === 'collector-failures')?.status).toBe('unknown')
    const nan = collectorPage('otelcol_receiver_refused_spans{receiver="otlp/fro-bot"} abc')
    expect(
      evaluateCollectorMetrics(nan, emptyCounterState(), NOW).results.find(entry => entry.id === 'collector-refused')
        ?.status,
    ).toBe('unknown')
  })
})

// ─── Tempo metrics ────────────────────────────────────────────────────────────

describe('evaluateTempoMetrics', () => {
  const discard = (n: number, reason = 'trace_too_large') =>
    tempoPage(`tempo_discarded_spans_total{reason="${reason}"} ${n}`)

  it('passes when the counters are absent', () => {
    const out = evaluateTempoMetrics(tempoPage(), emptyCounterState(), NOW)
    expect(out.results.map(entry => entry.status)).toEqual(['pass', 'pass'])
  })

  it('is unknown when the page holds no Tempo metric at all', () => {
    for (const text of ['# nothing\n', '<html></html>', 'go_goroutines 12\n']) {
      const out = evaluateTempoMetrics(text, emptyCounterState(), NOW)
      expect(out.results.map(entry => entry.status)).toEqual(['unknown', 'unknown'])
    }
  })

  it('fails when spans were discarded since the last run, naming the reason', () => {
    const first = evaluateTempoMetrics(discard(0), emptyCounterState(), NOW)
    const second = evaluateTempoMetrics(discard(24), first.state, NOW + 1000)
    const discards = second.results.find(entry => entry.id === 'tempo-discards')
    expect(discards?.status).toBe('fail')
    expect(discards?.detail).toContain('trace_too_large')
  })

  it('warns, and does not fail, when attributes were truncated', () => {
    const page = (n: number) =>
      tempoPage(`tempo_distributor_attributes_truncated_total{scope="span",tenant="single-tenant"} ${n}`)
    const first = evaluateTempoMetrics(page(0), emptyCounterState(), NOW)
    const second = evaluateTempoMetrics(page(9), first.state, NOW + 1000)
    expect(second.results.find(entry => entry.id === 'tempo-truncation')?.status).toBe('warn')
    expect(second.results.find(entry => entry.id === 'tempo-discards')?.status).toBe('pass')
  })
})

// ─── Disk ─────────────────────────────────────────────────────────────────────

describe('disk checks', () => {
  const limits = {warn: THRESHOLDS.volumeWarnPercent, fail: THRESHOLDS.volumeFailPercent}
  const stats = (used: number) => ({
    ok: true as const,
    value: {blocks: 1000, bfree: 1000 - used * 10, bavail: 1000 - used * 10},
  })

  it('computes the used share as df does', () => {
    expect(usedPercent({blocks: 1000, bfree: 300, bavail: 250})).toBeCloseTo((700 / 950) * 100)
    expect(usedPercent({blocks: 0, bfree: 0, bavail: 0})).toBeUndefined()
    expect(usedPercent({blocks: Number.NaN, bfree: 0, bavail: 0})).toBeUndefined()
  })

  it('passes below 70, warns from 70, fails from 85, and always gives the percentage', () => {
    expect(evaluateDisk('volume-space', 'volume', stats(69.9), limits)).toMatchObject({status: 'pass'})
    expect(evaluateDisk('volume-space', 'volume', stats(70), limits)).toMatchObject({status: 'warn'})
    const failing = evaluateDisk('volume-space', 'volume', stats(85), limits)
    expect(failing.status).toBe('fail')
    expect(failing.detail).toContain('85.0%')
    expect(evaluateDisk('volume-space', 'volume', stats(12.34), limits).detail).toContain('12.3%')
  })

  it('is unknown when statfs fails or reports nonsense', () => {
    expect(evaluateDisk('root-space', 'root disk', {ok: false, reason: 'statfs-failed'}, limits).status).toBe('unknown')
    expect(
      evaluateDisk('root-space', 'root disk', {ok: true, value: {blocks: 0, bfree: 0, bavail: 0}}, limits).status,
    ).toBe('unknown')
  })

  it('fails the volume check when the sentinel is missing or has other content', () => {
    expect(evaluateVolume(stats(10), {ok: false, reason: 'unreadable'}).status).toBe('fail')
    expect(evaluateVolume(stats(10), {ok: true, value: 'something-else\n'}).status).toBe('fail')
    expect(evaluateVolume(stats(10), {ok: true, value: `${SENTINEL_CONTENT}\nextra`}).status).toBe('pass')
  })
})

// ─── Age ──────────────────────────────────────────────────────────────────────

describe('evaluateAge', () => {
  const age = (days: number) =>
    evaluateAge('data-age-clickhouse', 'ClickHouse', {ok: true, value: NOW - days * DAY}, NOW)

  it('passes within 31 days and fails beyond, with the age in the detail', () => {
    expect(age(30).status).toBe('pass')
    expect(age(31).status).toBe('pass')
    const failing = age(32)
    expect(failing.status).toBe('fail')
    expect(failing.detail).toContain('32.0 days')
  })

  it('passes for an empty store and is unknown for an unreadable one', () => {
    expect(evaluateAge('x', 'store', {ok: true, value: undefined}, NOW).status).toBe('pass')
    expect(evaluateAge('x', 'store', {ok: false, reason: 'timeout'}, NOW).status).toBe('unknown')
    expect(evaluateAge('x', 'store', {ok: true, value: Number.NaN}, NOW).status).toBe('unknown')
  })

  it('reads an object key and a block file, and rejects what it cannot read', () => {
    expect(objectKeyTime('events/otel/p1/2026/10/01/04/05/abc.json')).toBe(Date.UTC(2026, 9, 1, 4, 5))
    expect(objectKeyTime('events/otel/p1/latest.json')).toBeUndefined()
    expect(blockEndMs('{"endTime":"2026-10-01T04:05:06Z"}')).toBe(Date.UTC(2026, 9, 1, 4, 5, 6))
    expect(blockEndMs('{"endTime":"not a date"}')).toBeUndefined()
    expect(blockEndMs('not json')).toBeUndefined()
    expect(blockEndMs('{}')).toBeUndefined()
  })
})

// ─── Canary ───────────────────────────────────────────────────────────────────

describe('buildCanary', () => {
  const canary = buildCanary(NOW, counter())
  const text = JSON.stringify(canary.body)

  it('carries one distinct marker in each of the nine places, each exactly once', () => {
    expect(CANARY_PLACES).toHaveLength(9)
    const markers = Object.values(canary.markers)
    expect(new Set(markers).size).toBe(9)
    for (const marker of markers) expect(text.split(marker).length - 1).toBe(1)
  })

  it('puts each marker in the position its place names', () => {
    const body = record(canary.body, 'body')
    const resource = record((body.resourceSpans as Rec[])[0], 'rs')
    const resourceAttrs = JSON.stringify(record(resource.resource, 'r').attributes)
    expect(resourceAttrs).toContain(canary.markers['resource-attribute'])
    const scopeSpans = record((resource.scopeSpans as Rec[])[0], 'ss')
    expect(JSON.stringify(record(scopeSpans.scope, 'scope').attributes)).toContain(canary.markers['scope-attribute'])
    const span = record((scopeSpans.spans as Rec[])[0], 'span')
    expect(span.name).toBe(canary.markers['span-name'])
    expect(record(span.status, 'status').message).toBe(canary.markers['status-message'])
    expect(JSON.stringify(span.attributes)).toContain(canary.markers['content-key'])
    expect(JSON.stringify(span.attributes)).toContain(canary.markers['unlisted-attribute'])
    expect(JSON.stringify(span.links)).toContain(canary.markers['link-attribute'])
    const events = span.events as Rec[]
    expect(JSON.stringify(events[0])).toContain(canary.markers['event-attribute'])
    expect(JSON.stringify(events[1])).toContain(canary.markers['exception-message'])
    expect(events[1]?.name).toBe('exception')
  })

  it('is labelled as a canary, so it can be filtered out', () => {
    expect(text).toContain('"sender.group"')
    expect(text).toContain(`"stringValue":"${CANARY_GROUP}"`)
    expect(CANARY_GROUP).toBe('canary')
  })

  it('is unique per call', () => {
    const random = counter()
    const a = buildCanary(NOW, random)
    const b = buildCanary(NOW, random)
    expect(a.traceId).not.toBe(b.traceId)
    expect(a.markers['span-name']).not.toBe(b.markers['span-name'])
  })

  it('splits the places so the Tempo expectation is the keep-list behaviour', () => {
    expect([...TEMPO_KEPT_PLACES, ...TEMPO_DROPPED_PLACES].sort()).toEqual([...CANARY_PLACES].sort())
    expect([...TEMPO_KEPT_PLACES].sort()).toEqual([
      'exception-message',
      'link-attribute',
      'span-name',
      'status-message',
    ])
  })
})

describe('canary readback evaluators', () => {
  const canary = buildCanary(NOW, counter())
  const textOf = (places: readonly CanaryPlace[]) => places.map(place => canary.markers[place]).join(' ')

  it('Langfuse: passes with all nine, fails naming each missing place, fails when nothing is found', () => {
    expect(evaluateLangfuseReadback(textOf(CANARY_PLACES), canary).status).toBe('pass')
    for (const place of CANARY_PLACES) {
      const without = CANARY_PLACES.filter(candidate => candidate !== place)
      const out = evaluateLangfuseReadback(textOf(without), canary)
      expect(out.status).toBe('fail')
      expect(out.detail).toContain(place)
    }
    expect(evaluateLangfuseReadback(undefined, canary).status).toBe('fail')
    expect(evaluateLangfuseReadback('   ', canary).status).toBe('fail')
  })

  it('Tempo: passes with exactly the four kept places', () => {
    expect(evaluateTempoReadback(textOf(TEMPO_KEPT_PLACES), canary).status).toBe('pass')
  })

  it.each(TEMPO_DROPPED_PLACES)('Tempo: fails and names the place when the %s marker is found', place => {
    const out = evaluateTempoReadback(textOf([...TEMPO_KEPT_PLACES, place]), canary)
    expect(out.status).toBe('fail')
    expect(out.detail).toContain(place)
  })

  it.each(TEMPO_KEPT_PLACES)('Tempo: fails and names the place when the kept %s marker is missing', place => {
    const out = evaluateTempoReadback(textOf(TEMPO_KEPT_PLACES.filter(candidate => candidate !== place)), canary)
    expect(out.status).toBe('fail')
    expect(out.detail).toContain(place)
  })

  it('Tempo: fails when the trace is not found', () => {
    expect(evaluateTempoReadback(undefined, canary).status).toBe('fail')
  })
})

// ─── Pins to the files these constants repeat ────────────────────────────────

describe('constants match the stack definition', async () => {
  const collectorConfig = record(
    Bun.YAML.parse(await Bun.file(new URL('../config/otelcol.yaml', import.meta.url)).text()),
    'otelcol',
  )

  it('GROUPS and the sentinel match host.ts', () => {
    expect([...GROUPS] as string[]).toEqual([...SENDER_GROUPS])
    expect(SENTINEL_CONTENT).toBe(TRACES_SENTINEL_CONTENT)
  })

  it('EXPECTED_EXPORTERS are exactly the collector exporters', () => {
    const exporters = Object.keys(record(collectorConfig.exporters, 'exporters')).sort()
    expect([...EXPECTED_EXPORTERS].sort() as string[]).toEqual(exporters)
  })

  it('the canary receiver and path match the collector config', () => {
    const receivers = record(collectorConfig.receivers, 'receivers')
    const canary = record(record(record(receivers['otlp/canary'], 'canary').protocols, 'p').http, 'http')
    expect(String(ENDPOINTS.canaryReceiver)).toBe(
      `http://collector:${String(canary.endpoint).split(':').pop()}${String(canary.traces_url_path)}`,
    )
    const extensions = record(collectorConfig.extensions, 'extensions')
    expect(String(ENDPOINTS.collectorHealth)).toBe(
      `http://collector:${String(record(extensions.health_check, 'hc').endpoint).split(':').pop()}/`,
    )
  })

  it('canary text positions behave as the keep-list says: kept keys listed, dropped keys not', () => {
    const redaction = record(record(collectorConfig.processors, 'processors')['redaction/tempo'], 'redaction')
    const allowed = redaction.allowed_keys as string[]
    // The exception message is a kept span-event attribute; the content key and the canary's own keys are not.
    expect(allowed).toContain('exception.message')
    expect(allowed).not.toContain('gen_ai.input.messages')
    for (const key of ['canary.unlisted', 'canary.resource', 'canary.scope', 'canary.event']) {
      expect(allowed).not.toContain(key)
    }
    // The canary's own structural keys are kept, so the trace is recognisable in Grafana.
    expect(allowed).toContain('sender.group')
    expect(allowed).toContain('gen_ai.operation.name')
  })

  it('the ClickHouse reader user matches the users file', async () => {
    const xml = await Bun.file(new URL('../config/clickhouse-users/traces-reader.xml', import.meta.url)).text()
    expect(xml).toContain(`<${CLICKHOUSE_READER_USER}>`)
    expect(xml).toContain('<readonly>1</readonly>')
    expect(xml).toContain('GRANT SELECT ON default.events_full')
    expect(xml).toContain('GRANT SELECT ON default.events_core')
  })
})

// ─── A whole run ──────────────────────────────────────────────────────────────

describe('a passing run', () => {
  it('yields a passing verdict, 200, and every required check', async () => {
    const out = await runOnce()
    const detail = record(JSON.parse(out.detail), 'detail')
    expect(detail.ok).toBe(true)
    const ids = (detail.checks as CheckResult[]).map(entry => entry.id)
    for (const id of REQUIRED_CHECKS) expect(ids).toContain(id)
    for (const entry of detail.checks as CheckResult[]) expect(['pass', 'warn']).toContain(entry.status)
    expect(out.reporter.health().status).toBe(200)
  })

  it('sends the canary to the private receiver as JSON and reads Langfuse with the read-only user', async () => {
    const {requests} = await runOnce()
    const post = requests.find(entry => entry.url === ENDPOINTS.canaryReceiver)
    expect(post?.method).toBe('POST')
    expect(post?.headers['content-type']).toBe('application/json')
    const reads = requests.filter(entry => entry.url.startsWith(ENDPOINTS.clickhouse))
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      expect(read.headers['x-clickhouse-user']).toBe(CLICKHOUSE_READER_USER)
      expect(read.headers['x-clickhouse-key']).toBe(CLICKHOUSE_PASSWORD)
      expect(read.url).not.toContain(CLICKHOUSE_PASSWORD)
    }
  })

  it('never puts a credential into the detail or the public answer', async () => {
    const out = await runOnce()
    for (const text of [out.detail, out.reporter.health().body]) {
      expect(text).not.toContain(CLICKHOUSE_PASSWORD)
      expect(text).not.toContain(MINIO_PASSWORD)
    }
    const passwords = out.requests.filter(entry => entry.url === 'object-store').map(entry => entry.headers.password)
    expect(passwords).toEqual([MINIO_PASSWORD])
  })

  it('does not leak a probe error message into the detail', async () => {
    const out = await runOnce({langfuseWorker: 'throw'})
    expect(out.detail).not.toContain('ECONNREFUSED')
    expect(out.detail).not.toContain('internal-detail')
  })
})

describe('error paths name the failing check and fail the verdict', () => {
  it('canary missing from Langfuse: the Langfuse branch fails, Tempo stays healthy', async () => {
    const out = await runOnce({langfuseMissing: 'all'})
    expect(check(out.detail, 'canary-langfuse')).toMatchObject({status: 'fail'})
    expect(check(out.detail, 'canary-langfuse').detail).toContain('Langfuse')
    expect(check(out.detail, 'canary-tempo').status).toBe('pass')
    expect(check(out.detail, 'canary-send').status).toBe('pass')
    expect(out.reporter.health().status).toBe(503)
  })

  it('canary markers partly missing from Langfuse: names them', async () => {
    const out = await runOnce({langfuseMissing: ['link-attribute', 'scope-attribute']})
    const entry = check(out.detail, 'canary-langfuse')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain('link-attribute')
    expect(entry.detail).toContain('scope-attribute')
  })

  it('worker health fails while web answers: the verdict fails and names the worker', async () => {
    const out = await runOnce({langfuseWorker: 503})
    expect(check(out.detail, 'langfuse-worker')).toMatchObject({status: 'fail'})
    expect(check(out.detail, 'langfuse-worker').detail).toContain('worker')
    expect(check(out.detail, 'langfuse-web').status).toBe('pass')
    expect(out.reporter.health().status).toBe(503)
  })

  it.each(TEMPO_DROPPED_PLACES)('a %s marker found in Tempo fails the verdict and names the place', async place => {
    const out = await runOnce({tempoPlaces: [...TEMPO_KEPT_PLACES, place]})
    const entry = check(out.detail, 'canary-tempo')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain(place)
    expect(check(out.detail, 'canary-langfuse').status).toBe('pass')
    expect(out.reporter.health().status).toBe(503)
  })

  it('canary never reaches Tempo: fails after the deadline, with the clock advancing only by sleeping', async () => {
    const out = await runOnce({tempoPlaces: 'none'})
    expect(check(out.detail, 'canary-tempo').status).toBe('fail')
    expect(out.state.now - NOW).toBeGreaterThanOrEqual(THRESHOLDS.canaryDeadlineMs)
  })

  it('the collector will not take the canary: send fails and the readbacks are unknown, not passing', async () => {
    const out = await runOnce({canaryPost: 503})
    expect(check(out.detail, 'canary-send').status).toBe('fail')
    expect(check(out.detail, 'canary-langfuse').status).toBe('unknown')
    expect(check(out.detail, 'canary-tempo').status).toBe('unknown')
    expect(out.requests.some(entry => entry.url.startsWith(ENDPOINTS.tempoTraceBase))).toBe(false)
  })

  it('the oldest ClickHouse span is 32 days old: the verdict fails', async () => {
    const out = await runOnce({clickhouseOldestMs: NOW - 32 * DAY})
    expect(check(out.detail, 'data-age-clickhouse')).toMatchObject({status: 'fail'})
    expect(out.reporter.health().status).toBe(503)
  })

  it('the oldest object batch or Tempo block is over 31 days old: the verdict fails', async () => {
    const objects = await runOnce({objectKeys: ['events/otel/project-a/2026/10/01/00/00/old.json']})
    expect(check(objects.detail, 'data-age-object-store').status).toBe('fail')
    const blocks = await runOnce({tempoBlocks: [JSON.stringify({endTime: new Date(NOW - 40 * DAY).toISOString()})]})
    expect(check(blocks.detail, 'data-age-tempo').status).toBe('fail')
  })

  it('a table that cannot be read fails the age check rather than being skipped', async () => {
    const out = await runOnce({clickhouseStatus: 404})
    expect(check(out.detail, 'data-age-clickhouse').status).toBe('unknown')
    expect(check(out.detail, 'canary-langfuse').status).not.toBe('pass')
    expect(out.reporter.health().status).toBe(503)
  })

  it('free space below the threshold fails, with the percentage in the detail', async () => {
    const volume = await runOnce({volumeUsed: 86})
    expect(check(volume.detail, 'volume-space').status).toBe('fail')
    expect(check(volume.detail, 'volume-space').detail).toContain('86.0%')
    const root = await runOnce({rootUsed: 91.5})
    expect(check(root.detail, 'root-space').status).toBe('fail')
    expect(check(root.detail, 'root-space').detail).toContain('91.5%')
  })

  it('a warning level does not fail the verdict', async () => {
    const out = await runOnce({volumeUsed: 75})
    expect(check(out.detail, 'volume-space').status).toBe('warn')
    expect(out.reporter.health().status).toBe(200)
  })

  it('an unreadable sentinel fails the volume check', async () => {
    const out = await runOnce({sentinel: 'throw'})
    expect(check(out.detail, 'volume-space').status).toBe('fail')
  })

  it('a missing secret file makes the checks that need it unknown, never passing', async () => {
    const out = await runOnce({secretsMissing: true})
    expect(check(out.detail, 'data-age-clickhouse').status).toBe('unknown')
    expect(check(out.detail, 'data-age-object-store').status).toBe('unknown')
    expect(check(out.detail, 'canary-langfuse').status).toBe('unknown')
    expect(out.reporter.health().status).toBe(503)
  })

  it('an empty store is not an age failure', async () => {
    const out = await runOnce({clickhouseOldestMs: undefined, objectKeys: [], tempoBlocks: []})
    expect(check(out.detail, 'data-age-clickhouse').status).toBe('pass')
    expect(check(out.detail, 'data-age-object-store').status).toBe('pass')
    expect(check(out.detail, 'data-age-tempo').status).toBe('pass')
  })
})

describe('every probe fails closed', () => {
  // Each dependency, broken three ways. A failed probe must never leave the verdict passing.
  const breakages: [string, Partial<Behaviour>][] = [
    ['collector health unreachable', {collectorHealth: 'throw'}],
    ['collector health 500', {collectorHealth: 500}],
    ['collector health unparsable', {collectorHealth: 'garbage'}],
    ['collector metrics unreachable', {collectorMetrics: 'throw'}],
    ['collector metrics 500', {collectorMetrics: 500}],
    ['collector metrics unparsable', {collectorMetrics: '<html>nope</html>'}],
    ['collector metrics without a queue', {collectorMetrics: 'otelcol_process_uptime_seconds_total 5\n'}],
    ['tempo not ready', {tempoReady: 503}],
    ['tempo unreachable', {tempoReady: 'throw'}],
    ['tempo metrics unreachable', {tempoMetrics: 'throw'}],
    ['tempo metrics 500', {tempoMetrics: 500}],
    ['tempo metrics unparsable', {tempoMetrics: 'garbage'}],
    ['langfuse web down', {langfuseWeb: 'throw'}],
    ['langfuse worker 500', {langfuseWorker: 500}],
    ['canary post unreachable', {canaryPost: 'throw'}],
    ['tempo trace read 500', {tempoTrace: 500}],
    ['tempo trace read unparsable', {tempoTrace: 'garbage'}],
    ['clickhouse 500', {clickhouseStatus: 500}],
  ]

  it.each(breakages)('%s', async (_label, overrides) => {
    const out = await runOnce(overrides)
    expect(out.reporter.health().status).toBe(503)
    expect(record(JSON.parse(out.detail), 'detail').ok).toBe(false)
  })

  it('a dependency that throws inside a check is unknown, not a crash and not a pass', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      statfs: async () => {
        throw new Error('disk gone')
      },
      readTempoBlockMetas: async () => {
        throw new Error('blocks gone')
      },
    }
    const reporter = createReporter(deps)
    await reporter.runOnce()
    expect(check(reporter.detail(), 'volume-space').status).toBe('unknown')
    expect(check(reporter.detail(), 'data-age-tempo').status).toBe('unknown')
    expect(reporter.health().status).toBe(503)
  })

  it('a verdict missing a required check cannot pass', () => {
    const results: CheckResult[] = REQUIRED_CHECKS.map(id => ({id, status: 'pass', detail: 'ok'}))
    expect(assembleVerdict(results, NOW).ok).toBe(true)
    expect(assembleVerdict(results.slice(1), NOW).ok).toBe(false)
    expect(assembleVerdict([], NOW).ok).toBe(false)
  })
})

// ─── Counters across runs ─────────────────────────────────────────────────────

describe('counters across runs', () => {
  it('a counter that rose between two runs fails the second verdict', async () => {
    let metrics = collectorPage('otelcol_exporter_enqueue_failed_spans{exporter="otlp_http/langfuse-fro-bot"} 0')
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      fetch: async (url, init) =>
        url === ENDPOINTS.collectorMetrics ? new Response(metrics, {status: 200}) : world.deps.fetch(url, init),
    }
    const reporter = createReporter(deps)
    await reporter.runOnce()
    expect(reporter.health().status).toBe(200)

    metrics = collectorPage('otelcol_exporter_enqueue_failed_spans{exporter="otlp_http/langfuse-fro-bot"} 12')
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(check(reporter.detail(), 'collector-failures')).toMatchObject({status: 'fail'})
    expect(reporter.health().status).toBe(503)
  })

  it('a Tempo discard between two runs fails the second verdict', async () => {
    let metrics = tempoPage('tempo_discarded_spans_total{reason="trace_too_large"} 0')
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      fetch: async (url, init) =>
        url === ENDPOINTS.tempoMetrics ? new Response(metrics, {status: 200}) : world.deps.fetch(url, init),
    }
    const reporter = createReporter(deps)
    await reporter.runOnce()
    metrics = tempoPage('tempo_discarded_spans_total{reason="trace_too_large"} 3')
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(check(reporter.detail(), 'tempo-discards').status).toBe('fail')
    expect(reporter.health().status).toBe(503)
  })
})

// ─── The public answer ────────────────────────────────────────────────────────

describe('/healthz', () => {
  it('answers 503 with a null timestamp before the first run', () => {
    const reporter = createReporter(harness().deps)
    expect(reporter.health()).toEqual({status: 503, body: '{"ok":false,"at":null}'})
  })

  it('answers 200 when the last run passed within two intervals and 503 beyond', async () => {
    const out = await runOnce()
    expect(out.reporter.health().status).toBe(200)
    out.state.now += 2 * THRESHOLDS.intervalMs
    expect(out.reporter.health().status).toBe(200)
    out.state.now += 1
    expect(out.reporter.health().status).toBe(503)
    expect(out.reporter.detail()).toContain('"stale":true')
  })

  it('has a body of exactly a boolean and a timestamp, with nothing from the detail', async () => {
    for (const overrides of [{}, {langfuseWorker: 503}, {volumeUsed: 90}] as Partial<Behaviour>[]) {
      const out = await runOnce(overrides)
      const answer = out.reporter.health()
      const body = record(JSON.parse(answer.body), 'body')
      expect(Object.keys(body).sort()).toEqual(['at', 'ok'])
      expect(typeof body.ok).toBe('boolean')
      expect(typeof body.at).toBe('string')
      for (const entry of record(JSON.parse(out.detail), 'detail').checks as CheckResult[]) {
        expect(answer.body).not.toContain(entry.id)
        expect(answer.body).not.toContain(entry.detail)
      }
      const response = handlePublic(out.reporter, new Request('http://traces/healthz'))
      expect(await response.text()).toBe(answer.body)
      expect(response.status).toBe(answer.status)
      expect(response.headers.get('cache-control')).toBe('no-store')
    }
  })

  it('serves nothing else on the public listener', async () => {
    const out = await runOnce()
    for (const path of ['/detail', '/live', '/', '/healthz/', '/metrics', '/healthz/detail']) {
      expect(handlePublic(out.reporter, new Request(`http://traces${path}`)).status).toBe(404)
    }
    expect(handlePublic(out.reporter, new Request('http://traces/healthz', {method: 'POST'})).status).toBe(405)
  })

  it('never starts a probe, however often it is asked', async () => {
    const out = await runOnce()
    const before = out.requests.length
    for (let index = 0; index < 500; index += 1) {
      handlePublic(out.reporter, new Request('http://traces/healthz'))
      handleDetail(out.reporter, new Request('http://localhost/detail'))
      out.reporter.health()
    }
    expect(out.requests.length).toBe(before)
  })

  it('shares one run between overlapping calls', async () => {
    const world = harness()
    const reporter = createReporter(world.deps)
    await Promise.all([reporter.runOnce(), reporter.runOnce(), reporter.runOnce()])
    expect(world.requests.filter(entry => entry.url === ENDPOINTS.canaryReceiver)).toHaveLength(1)
  })
})

describe('the detail listener', () => {
  it('serves the detail and liveness on the loopback listener only', async () => {
    const out = await runOnce()
    const detail = handleDetail(out.reporter, new Request('http://localhost:8081/detail'))
    expect(detail.status).toBe(200)
    expect(record(JSON.parse(await detail.text()), 'detail').schemaVersion).toBe(1)
    expect(handleDetail(out.reporter, new Request('http://localhost:8081/live')).status).toBe(200)
    expect(handleDetail(out.reporter, new Request('http://localhost:8081/healthz')).status).toBe(404)
    expect(handleDetail(out.reporter, new Request('http://localhost:8081/detail', {method: 'POST'})).status).toBe(405)
  })
})

// ─── Real file readers ────────────────────────────────────────────────────────

describe('Tempo block files', () => {
  it('reads meta.json under blocks/<tenant>/<block>, skipping a block with none', async () => {
    const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
    try {
      mkdirSync(join(root, 'single-tenant', 'block-a'), {recursive: true})
      mkdirSync(join(root, 'single-tenant', 'block-b'), {recursive: true})
      writeFileSync(join(root, 'single-tenant', 'block-a', 'meta.json'), '{"endTime":"2026-11-01T00:00:00Z"}')
      expect(await readTempoBlockMetasFrom(root)).toEqual(['{"endTime":"2026-11-01T00:00:00Z"}'])
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })

  it('treats a directory that does not exist yet as empty, and any other failure as an error', async () => {
    const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
    try {
      expect(await readTempoBlockMetasFrom(join(root, 'absent'))).toEqual([])
      writeFileSync(join(root, 'plain-file'), 'x')
      await expect(readTempoBlockMetasFrom(join(root, 'plain-file'))).rejects.toThrow()
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })
})
