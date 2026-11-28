import {chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  assembleVerdict,
  blockEndMs,
  buildCanary,
  CANARY_CHECK_IDS,
  CANARY_ENVIRONMENT,
  CANARY_GROUP,
  CANARY_ONCE_FLAG,
  CANARY_PLACES,
  canaryOnceOutput,
  checkScope,
  CLICKHOUSE_READER_USER,
  combineLangfuse,
  createReporter,
  ENDPOINTS,
  evaluateAge,
  evaluateCollectorMetrics,
  evaluateDisk,
  evaluateIngestCounts,
  evaluateLangfuseRaw,
  evaluateLangfuseRow,
  evaluateQueues,
  evaluateTempoReadback,
  evaluateVolume,
  EXPECTED_EXPORTERS,
  GROUPS,
  handleDetail,
  handleMetrics,
  handlePublic,
  LANGFUSE_MARKER_LOCATIONS,
  METRIC_NAMES,
  MONITORING_CHECKS,
  OBJECT_STORE,
  objectKeyTime,
  parsePrometheus,
  PATHS,
  PORTS,
  RAW_BATCH_LIMITS,
  rawBatchKey,
  readTempoBlockMetasFrom,
  renderMetrics,
  REQUIRED_CHECKS,
  runCanary,
  SENTINEL_CONTENT,
  TEMPO_DROPPED_PLACES,
  TEMPO_KEPT_PLACES,
  THRESHOLDS,
  usedPercent,
  type Canary,
  type CanaryPlace,
  type CheckResult,
  type LangfuseColumn,
  type ObjectStoreReader,
  type ReporterDeps,
} from './health-report'
import {SENDER_GROUPS, TRACES_SENTINEL_CONTENT} from './host'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0)
const DAY = 86_400_000

const CLICKHOUSE_PASSWORD = 'placeholder-clickhouse-password'
const MINIO_PASSWORD = 'placeholder-minio-password'

/**
 * What Langfuse v4.83.0 writes to `events_full`, written out here on purpose and not read from the source under
 * test: a change to the table in `health-report.ts` must make a test fail. The derivation is documented there.
 */
const ROW_COLUMNS: Partial<Record<CanaryPlace, LangfuseColumn>> = {
  'span-name': 'name',
  'status-message': 'status_message',
  'content-key': 'input',
  'resource-attribute': 'metadata_values',
  'scope-attribute': 'metadata_values',
  'unlisted-attribute': 'metadata_values',
}
const MATERIALISED = Object.keys(ROW_COLUMNS) as CanaryPlace[]
/** Markers Langfuse reads and does not copy into a row: only the raw batch holds them. */
const RAW_ONLY = CANARY_PLACES.filter(place => !MATERIALISED.includes(place))

/** The size cap on a raw batch read; pinned to the exported limit in the tests. */
const RAW_MAX_BYTES = 1_048_576

const RAW_KEY = 'events/otel/project-a/2026/11/20/12/00/0d7c5b0e-3a52-4a56-9c3a-7a1f0e6f2b11.json'

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

// A promise that never settles stands for a dependency that accepted the connection and went silent. It ignores
// the abort signal on purpose: a deadline that relies on the dependency honouring a signal is not a deadline.
const NEVER: Promise<never> = new Promise<never>(() => undefined)

const SMALL = {probeTimeoutMs: 15, runDeadlineMs: 4000} as const

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

/**
 * One `http_server_request_duration_count` series on an authenticated receiver, as collector v0.165.0 exports it:
 * no `http_route` and no `server_port`. A second address stands for another label combination.
 */
function authRequests(status: string, count: number | string, address = '10.0.0.4'): string {
  return `http_server_request_duration_count{http_request_method="POST",http_response_status_code="${status}",network_protocol_name="http",network_protocol_version="1.1",server_address="${address}",url_scheme="http"} ${count}`
}

/** The same family on the canary receiver, whose series carries the route and the port. */
function canaryRequests(status: string, count: number): string {
  return `http_server_request_duration_count{http_request_method="POST",http_response_status_code="${status}",http_route="/canary/v1/traces",network_protocol_name="http",network_protocol_version="1.1",server_address="10.0.0.4",server_port="4414",url_scheme="http"} ${count}`
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
  langfuseWeb: number | 'throw'
  langfuseWorker: number | 'throw'
  grafana: number | 'throw'
  prometheus: number | 'throw'
  embedder: number | 'throw'
  /** The reader gate's `/healthz`: the answer it gives, or how the request fails. */
  reader: 'ok' | 'langfuse-down' | 'grafana-down' | 'both-down' | 'ok-false-on-200' | 'garbage' | 500 | 'throw'
  canaryPost: number | 'throw'
  /** Places absent from the ClickHouse row, or `all` when the trace never arrives. Only materialised places can be absent. */
  rowMissing: readonly CanaryPlace[] | 'all'
  /** Places absent from the raw OTLP batch in the object store. */
  rawMissing: readonly CanaryPlace[]
  /** What the row names as the raw batch's key. */
  blobPath: 'valid' | 'empty' | 'malformed' | 'other-prefix'
  /** What the object store returns for that key. */
  rawObject: 'ok' | 'absent' | 'throw' | 'not-json' | 'not-array' | 'gzip' | 'oversize'
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
    langfuseWeb: 200,
    langfuseWorker: 200,
    grafana: 200,
    prometheus: 200,
    embedder: 200,
    reader: 'ok',
    canaryPost: 200,
    rowMissing: [],
    rawMissing: [],
    blobPath: 'valid',
    rawObject: 'ok',
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

/** The gate answers 503 with the same JSON body when an upstream is down, so the detail survives a non-2xx answer. */
function readerReply(mode: Behaviour['reader']): Response {
  const body = (langfuse: boolean, grafana: boolean): string =>
    JSON.stringify({ok: langfuse && grafana, langfuse, grafana})
  switch (mode) {
    case 'ok':
      return new Response(body(true, true), {status: 200})
    case 'langfuse-down':
      return new Response(body(false, true), {status: 503})
    case 'grafana-down':
      return new Response(body(true, false), {status: 503})
    case 'both-down':
      return new Response(body(false, false), {status: 503})
    case 'ok-false-on-200':
      return new Response(body(false, true), {status: 200})
    case 'garbage':
      return new Response('<html>hi</html>', {status: 200})
    case 500:
      return new Response('error body', {status: 500})
    case 'throw':
      throw new TypeError('connect ECONNREFUSED internal-detail')
  }
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
    if (url === ENDPOINTS.langfuseWeb) return reply(behaviour.langfuseWeb, '{"status":"OK"}')
    if (url === ENDPOINTS.langfuseWorker) return reply(behaviour.langfuseWorker, '{"status":"ok"}')
    if (url === ENDPOINTS.grafanaHealth) return reply(behaviour.grafana, '{"database":"ok"}')
    if (url === ENDPOINTS.prometheusReady) return reply(behaviour.prometheus, 'Prometheus Server is Ready.')
    if (url === ENDPOINTS.embedderHealth) return reply(behaviour.embedder, '')
    if (url === ENDPOINTS.readerHealth) return readerReply(behaviour.reader)
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
      if (body.includes('trace_id = {tid')) {
        if (state.posted === undefined || behaviour.rowMissing === 'all') return new Response('', {status: 200})
        return new Response(JSON.stringify(rowFor(behaviour.rowMissing)), {status: 200})
      }
    }
    throw new Error(`unexpected request ${url}`)
  }

  /** One `events_full` row as the JSONEachRow format prints it: only the markers that Langfuse materialises. */
  function rowFor(missing: readonly CanaryPlace[]): Rec {
    const markers = markersPosted()
    const row: {[column: string]: unknown} = {
      trace_id: 'canary-trace',
      name: 'a span',
      status_message: '',
      input: '{"messages":[]}',
      metadata_values: ['health-reporter-canary'],
      blob_storage_file_path: {
        valid: RAW_KEY,
        empty: '',
        malformed: '../../etc/passwd',
        'other-prefix': 'media/x.json',
      }[behaviour.blobPath],
    }
    for (const [place, column] of Object.entries(ROW_COLUMNS)) {
      if (missing.includes(place as CanaryPlace)) continue
      const marker = markers[place as CanaryPlace]
      if (column === 'metadata_values') (row.metadata_values as string[]).push(marker)
      else row[column] = `text around ${marker}`
    }
    return row
  }

  function markersPosted(): Record<CanaryPlace, string> {
    const found = Object.fromEntries(
      [...(state.posted ?? '').matchAll(/canary-([a-z-]+?)-[\da-f]{8}/g)].map(match => [match[1], match[0]]),
    )
    return found as Record<CanaryPlace, string>
  }

  /** The object Langfuse stored: a JSON array of resourceSpans, with the markers it still holds. */
  function rawBytes(): Uint8Array {
    const text = JSON.stringify([
      {scopeSpans: [{spans: [{text: textFor(CANARY_PLACES.filter(place => !behaviour.rawMissing.includes(place)))}]}]},
    ])
    if (behaviour.rawObject === 'not-json') return new TextEncoder().encode('<html>no</html>')
    if (behaviour.rawObject === 'not-array') return new TextEncoder().encode(JSON.stringify({text}))
    if (behaviour.rawObject === 'gzip') return Uint8Array.from([0x1f, 0x8b, 8, 0, 0, 0, 0, 0])
    if (behaviour.rawObject === 'oversize') return new Uint8Array(RAW_MAX_BYTES + 1).fill(32)
    return new TextEncoder().encode(text)
  }

  const objectStore = (password: string): ObjectStoreReader => {
    requests.push({url: 'object-store', method: 'LIST', headers: {password}, body: ''})
    return {
      childPrefixes: async () => (behaviour.objectKeys.length > 0 ? ['events/otel/project-a/'] : []),
      firstKey: async () => behaviour.objectKeys[0],
      read: async (key, maxBytes) => {
        requests.push({url: 'object-store-read', method: 'GET', headers: {key, maxBytes: String(maxBytes)}, body: ''})
        if (behaviour.rawObject === 'throw') throw new Error('connect ECONNREFUSED minio-internal')
        if (behaviour.rawObject === 'absent') return undefined
        return rawBytes()
      },
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

/** The canary alone, through the same function `--canary-once` runs. */
async function canaryRun(overrides: Partial<Behaviour> = {}) {
  const world = harness(overrides)
  const checks = await runCanary(world.deps)
  const byId = (id: string): CheckResult => {
    const found = checks.find(entry => entry.id === id)
    if (found === undefined) throw new Error(`no check ${id}`)
    return found
  }
  return {...world, checks, byId}
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
  it('returns the queue check alone: loss detection belongs to the Grafana rules, not the reporter', () => {
    const out = evaluateCollectorMetrics(collectorPage())
    expect(out.results.map(entry => [entry.id, entry.status])).toEqual([['collector-queues', 'pass']])
  })

  it('is unknown when the page is not the collector (no uptime sentinel)', () => {
    for (const text of ['', '<html></html>', 'otelcol_exporter_queue_size{exporter="otlp_http/tempo"} 0\n']) {
      const out = evaluateCollectorMetrics(text)
      expect(out.results.map(entry => [entry.id, entry.status])).toEqual([['collector-queues', 'unknown']])
      expect(out.ingest).toBeNull()
    }
  })

  it('does not read the loss counters: failures, refusals and 503s leave the result as it was', () => {
    const lossy = collectorPage(
      [
        'otelcol_exporter_enqueue_failed_spans{exporter="otlp_http/langfuse-fro-bot"} 12',
        'otelcol_exporter_send_failed_spans_total{exporter="otlp_http/tempo"} 3',
        'otelcol_exporter_send_failed_spans{exporter="otlp_http/tempo"} not-a-number',
        receiverCounters('workstation', 10, 5000),
        authRequests('503', 40),
      ].join('\n'),
    )
    expect(evaluateCollectorMetrics(lossy).results).toEqual(evaluateCollectorMetrics(collectorPage()).results)
  })

  it('passes a collector that has served only the private canary, and shows no authenticated requests', () => {
    const canaryOnly = collectorPage([receiverCounters('canary', 1, 0), canaryRequests('200', 1)].join('\n'))
    const out = evaluateCollectorMetrics(canaryOnly)
    expect(out.results.map(entry => entry.status)).toEqual(['pass'])
    expect(out.ingest?.requests).toEqual({})
    expect(out.ingest?.groups.workstation).toEqual({acceptedSpans: 0, refusedSpans: 0})
  })
})

// ─── Ingest counts ──────────────────────────────────────────────────────────────

/** The receiver counters of one group, in the shape collector v0.165.0 exports them. */
function receiverCounters(group: string, accepted: number, refused: number): string {
  return [
    `otelcol_receiver_accepted_spans{receiver="otlp/${group}",transport="http"} ${accepted}`,
    `otelcol_receiver_refused_spans{receiver="otlp/${group}",transport="http"} ${refused}`,
  ].join('\n')
}

describe('evaluateIngestCounts', () => {
  const page = [
    receiverCounters('marcusrbrown', 10, 1),
    receiverCounters('fro-bot', 200, 3),
    receiverCounters('workstation', 0, 0),
    receiverCounters('canary', 50, 0),
    authRequests('401', 31),
    authRequests('401', 4, '10.0.0.5'),
    authRequests('200', 13),
    authRequests('200', 2, '10.0.0.5'),
    authRequests('415', 1),
    authRequests('429', 6),
    authRequests('503', 2),
    canaryRequests('200', 72),
    canaryRequests('503', 9),
  ].join('\n')
  const counts = () => evaluateIngestCounts(parsePrometheus(collectorPage(page)))

  it('reads accepted and refused spans for each group, and leaves the canary receiver out', () => {
    expect(counts()?.groups).toEqual({
      marcusrbrown: {acceptedSpans: 10, refusedSpans: 1},
      'fro-bot': {acceptedSpans: 200, refusedSpans: 3},
      workstation: {acceptedSpans: 0, refusedSpans: 0},
    })
  })

  it('sums the request counts per status across label combinations and leaves the canary route out', () => {
    expect(counts()?.requests).toEqual({'200': 15, '401': 35, '415': 1, '429': 6, '503': 2})
  })

  it('carries a fixed note: counters since collector start, and the monitor probe inside the 401 total', () => {
    const note = counts()?.note ?? ''
    expect(note).toContain('since collector start')
    expect(note).toContain('not rates')
    expect(note).toContain('401')
    expect(note).toContain('every 15 minutes')
    expect(note).toContain('429')
    expect(note).toContain('503')
  })

  it('reads a group with no series as zero, and no request series as an empty map', () => {
    const out = evaluateIngestCounts(parsePrometheus(collectorPage(receiverCounters('fro-bot', 5, 0))))
    expect(out?.groups.workstation).toEqual({acceptedSpans: 0, refusedSpans: 0})
    expect(out?.requests).toEqual({})
  })

  it('is absent when a count is not a number, so garbage is never shown as a count', () => {
    const bad = collectorPage([receiverCounters('fro-bot', 5, 0), authRequests('200', 'abc')].join('\n'))
    expect(evaluateIngestCounts(parsePrometheus(bad))).toBeNull()
  })

  it('comes with the evaluation, and is null when the page is not the collector', () => {
    expect(evaluateCollectorMetrics(collectorPage(page)).ingest?.requests['401']).toBe(35)
    expect(evaluateCollectorMetrics('<html></html>').ingest).toBeNull()
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

  // Langfuse v4.83.0 reads the environment from the span attribute `langfuse.environment` first (then the resource's,
  // then `deployment.environment(.name)`); `normalizeEnvironment` lowercases it, strips a leading `langfuse`, cuts it
  // to 40 characters and falls back to `default` unless it matches [a-z0-9-_]+. `canary` passes all of that.
  it('lands in its own Langfuse environment, `canary`, set on the span where Langfuse reads it first', () => {
    const body = record(canary.body, 'body')
    const resourceSpan = record((body.resourceSpans as Rec[])[0], 'rs')
    const scopeSpans = record((resourceSpan.scopeSpans as Rec[])[0], 'ss')
    const span = record((scopeSpans.spans as Rec[])[0], 'span')
    const attributes = span.attributes as {key: string; value: {stringValue: string}}[]
    const environments = attributes.filter(attribute => attribute.key === 'langfuse.environment')
    expect(environments).toEqual([{key: 'langfuse.environment', value: {stringValue: 'canary'}}])
    expect(CANARY_ENVIRONMENT).toBe('canary')
    // Valid under Langfuse's environment-name rules, so it is stored as `canary` and not replaced by `default`.
    expect(CANARY_ENVIRONMENT).toMatch(/^[a-z0-9_-]+$/)
    expect(CANARY_ENVIRONMENT.length).toBeLessThanOrEqual(40)
    expect(CANARY_ENVIRONMENT.startsWith('langfuse')).toBe(false)
    // No other attribute that Langfuse reads for the environment, which could make another value win.
    expect(JSON.stringify(resourceSpan.resource)).not.toMatch(/langfuse\.environment|deployment\.environment/)
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

// ─── The Langfuse half of the canary ──────────────────────────────────────────

/** One `events_full` row as the readback query returns it, holding the markers of the places not in `missing`. */
function rowText(canary: Canary, missing: readonly CanaryPlace[] = [], overrides: Rec = {}): string {
  const row: Rec = {
    trace_id: canary.traceId,
    name: 'a span',
    status_message: '',
    input: '',
    metadata_values: ['health-reporter-canary'],
    blob_storage_file_path: RAW_KEY,
  }
  for (const [place, column] of Object.entries(ROW_COLUMNS)) {
    if (missing.includes(place as CanaryPlace)) continue
    const marker = canary.markers[place as CanaryPlace]
    if (column === 'metadata_values') (row.metadata_values as string[]).push(marker)
    else row[column] = `text around ${marker}`
  }
  return JSON.stringify({...row, ...overrides})
}

/** The raw batch as Langfuse stores it: a JSON array of resourceSpans holding the markers of `places`. */
function rawText(canary: Canary, places: readonly CanaryPlace[] = CANARY_PLACES): string {
  return JSON.stringify([{scopeSpans: [{spans: [{text: places.map(place => canary.markers[place]).join(' ')}]}]}])
}

describe('the marker table (what Langfuse v4.83.0 keeps of each place)', () => {
  it('names the ClickHouse column of exactly the six materialised places, and no other', () => {
    const columns = Object.fromEntries(
      CANARY_PLACES.flatMap(place => {
        const column = LANGFUSE_MARKER_LOCATIONS[place].column
        return column === undefined ? [] : [[place, column]]
      }),
    )
    expect(columns).toEqual(ROW_COLUMNS)
    expect(CANARY_PLACES.filter(place => LANGFUSE_MARKER_LOCATIONS[place].column === undefined).sort()).toEqual(
      [...RAW_ONLY].sort(),
    )
    expect([...RAW_ONLY].sort()).toEqual(['event-attribute', 'exception-message', 'link-attribute'])
  })

  it('names the upstream file and tag it was derived from', async () => {
    const source = await Bun.file(new URL('./health-report.ts', import.meta.url)).text()
    expect(source).toContain('OtelIngestionProcessor.ts')
    expect(source).toContain('v4.83.0')
  })

  it('pins the size cap on a raw batch read', () => {
    expect(RAW_BATCH_LIMITS.maxBytes).toBe(RAW_MAX_BYTES)
    expect(RAW_KEY.startsWith(OBJECT_STORE.prefix)).toBe(true)
  })
})

describe('Langfuse part 1: delivery and materialisation (the ClickHouse row)', () => {
  const canary = buildCanary(NOW, counter())

  it('passes when the row holds exactly the materialised markers', () => {
    const out = evaluateLangfuseRow(rowText(canary), canary)
    expect(out.status).toBe('pass')
    expect(out.detail).toContain('6')
  })

  it.each(MATERIALISED)('fails and names the place and the column when the %s marker is missing', place => {
    const out = evaluateLangfuseRow(rowText(canary, [place]), canary)
    expect(out.status).toBe('fail')
    expect(out.detail).toContain(place)
    expect(out.detail).toContain(ROW_COLUMNS[place] as string)
  })

  it.each(RAW_ONLY)('does not fail when the %s marker is absent from the row: Langfuse never copies it', place => {
    const row = JSON.parse(rowText(canary)) as Rec
    expect(JSON.stringify(row)).not.toContain(canary.markers[place])
    expect(evaluateLangfuseRow(JSON.stringify(row), canary).status).toBe('pass')
  })

  it('requires a marker in the column Langfuse fills for it, not anywhere in the row', () => {
    const misplaced = rowText(canary, ['status-message'], {name: canary.markers['status-message']})
    const out = evaluateLangfuseRow(misplaced, canary)
    expect(out.status).toBe('fail')
    expect(out.detail).toContain('status-message')
  })

  it('reads a marker in any of several rows, and fails on a row it cannot parse', () => {
    const split = [rowText(canary, ['span-name']), rowText(canary, MATERIALISED, {name: canary.markers['span-name']})]
    expect(evaluateLangfuseRow(split.join('\n'), canary).status).toBe('pass')
    expect(evaluateLangfuseRow(`${rowText(canary)}\nnot json`, canary).status).toBe('fail')
  })

  it('fails when no row is found', () => {
    expect(evaluateLangfuseRow(undefined, canary).status).toBe('fail')
    expect(evaluateLangfuseRow('  \n', canary).status).toBe('fail')
  })
})

describe('Langfuse part 2: whole-trace fidelity (the raw batch in the object store)', () => {
  const canary = buildCanary(NOW, counter())
  const key = (value: string): string => rowText(canary, [], {blob_storage_file_path: value})

  it('takes the key from the row when it is a Langfuse OTLP batch key, and the first one when there are several', () => {
    expect(rawBatchKey(rowText(canary))).toEqual({ok: true, value: RAW_KEY})
    expect(rawBatchKey(`${rowText(canary)}\n${rowText(canary)}`)).toEqual({ok: true, value: RAW_KEY})
    const other = RAW_KEY.replace('0d7c5b0e', '00000001')
    expect(rawBatchKey(`${rowText(canary)}\n${key(other)}`)).toEqual({ok: true, value: RAW_KEY})
  })

  it.each([
    ['empty: the row was written by the dual-write path', ''],
    ['a path outside the OTLP prefix', 'media/2026/11/20/12/00/0d7c5b0e-3a52-4a56-9c3a-7a1f0e6f2b11.json'],
    ['a path with dot segments', 'events/otel/../../x/2026/11/20/12/00/0d7c5b0e-3a52-4a56-9c3a-7a1f0e6f2b11.json'],
    ['no minute directory', 'events/otel/project-a/0d7c5b0e-3a52-4a56-9c3a-7a1f0e6f2b11.json'],
    ['a query string', `${RAW_KEY}?versionId=1`],
  ])('refuses a row that names %s', (_label, value) => {
    expect(rawBatchKey(key(value)).ok).toBe(false)
  })

  it('refuses rows with no key at all, and rows it cannot parse', () => {
    expect(rawBatchKey('').ok).toBe(false)
    expect(rawBatchKey('not json').ok).toBe(false)
  })

  it('refuses a row set where any row names an unrecognised key, even if another names a good one', () => {
    expect(rawBatchKey(`${rowText(canary)}\n${key('media/x.json')}`).ok).toBe(false)
  })

  it('passes with all nine markers in a JSON array', () => {
    const out = evaluateLangfuseRaw(rawText(canary), canary)
    expect(out.status).toBe('pass')
    expect(out.detail).toContain('9')
  })

  it.each(CANARY_PLACES)('fails and names the place when the raw batch lacks the %s marker', place => {
    const out = evaluateLangfuseRaw(
      rawText(
        canary,
        CANARY_PLACES.filter(candidate => candidate !== place),
      ),
      canary,
    )
    expect(out.status).toBe('fail')
    expect(out.detail).toContain(place)
  })

  it('fails when the object is missing, is not JSON, or is not an array of resourceSpans', () => {
    expect(evaluateLangfuseRaw(undefined, canary).status).toBe('fail')
    expect(evaluateLangfuseRaw('<html>nope</html>', canary).status).toBe('fail')
    expect(evaluateLangfuseRaw(JSON.stringify({text: rawText(canary)}), canary).status).toBe('fail')
  })

  it('joins the two parts: it passes only when both pass, and a failure of either is named', () => {
    const pass = evaluateLangfuseRow(rowText(canary), canary)
    const rawPass = evaluateLangfuseRaw(rawText(canary), canary)
    const rowFail = evaluateLangfuseRow(rowText(canary, ['span-name']), canary)
    const rawFail = evaluateLangfuseRaw(rawText(canary, []), canary)
    expect(combineLangfuse(pass, rawPass).status).toBe('pass')
    const onlyRow = combineLangfuse(rowFail, rawPass)
    expect(onlyRow.status).toBe('fail')
    expect(onlyRow.detail).toContain('row')
    expect(onlyRow.detail).not.toContain('raw batch')
    const onlyRaw = combineLangfuse(pass, rawFail)
    expect(onlyRaw.status).toBe('fail')
    expect(onlyRaw.detail).toContain('raw batch')
    const both = combineLangfuse(rowFail, rawFail)
    expect(both.detail).toContain('row')
    expect(both.detail).toContain('raw batch')
    const unknown = combineLangfuse(pass, {id: 'canary-langfuse', status: 'unknown', detail: 'x'})
    expect(unknown.status).toBe('unknown')
    expect(combineLangfuse(rowFail, {id: 'canary-langfuse', status: 'unknown', detail: 'x'}).status).toBe('fail')
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

  it('sends no canary and requires none: the verdict carries no canary check', async () => {
    const out = await runOnce()
    const ids = (record(JSON.parse(out.detail), 'detail').checks as CheckResult[]).map(entry => entry.id)
    expect(ids.filter(id => id.startsWith('canary'))).toEqual([])
    expect(REQUIRED_CHECKS.filter(id => id.startsWith('canary'))).toEqual([])
    expect(out.requests.some(entry => entry.url === ENDPOINTS.canaryReceiver)).toBe(false)
    expect(out.requests.some(entry => entry.url.startsWith(ENDPOINTS.tempoTraceBase))).toBe(false)
    expect(out.requests.some(entry => entry.url === 'object-store-read')).toBe(false)
    expect(out.requests.some(entry => entry.body.includes('trace_id = {tid'))).toBe(false)
  })

  it('stays passing and sends no canary on later runs, and never sleeps for one', async () => {
    const world = harness()
    const reporter = createReporter(world.deps)
    await reporter.runOnce()
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(reporter.health().status).toBe(200)
    expect(world.requests.filter(entry => entry.url === ENDPOINTS.canaryReceiver)).toHaveLength(0)
    expect(world.state.now).toBe(NOW + THRESHOLDS.intervalMs)
  })

  it('reads ClickHouse with the read-only user for the age check', async () => {
    const {requests} = await runOnce()
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
    expect(passwords.length).toBeGreaterThan(0)
    for (const password of passwords) expect(password).toBe(MINIO_PASSWORD)
  })

  it('does not leak a probe error message into the detail', async () => {
    const out = await runOnce({langfuseWorker: 'throw'})
    expect(out.detail).not.toContain('ECONNREFUSED')
    expect(out.detail).not.toContain('internal-detail')
  })
})

describe('error paths name the failing check and fail the verdict', () => {
  it('worker health fails while web answers: the verdict fails and names the worker', async () => {
    const out = await runOnce({langfuseWorker: 503})
    expect(check(out.detail, 'langfuse-worker')).toMatchObject({status: 'fail'})
    expect(check(out.detail, 'langfuse-worker').detail).toContain('worker')
    expect(check(out.detail, 'langfuse-web').status).toBe('pass')
    expect(out.reporter.health().status).toBe(503)
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
    expect(out.reporter.health().status).toBe(503)
  })

  it('an empty store is not an age failure', async () => {
    const out = await runOnce({clickhouseOldestMs: undefined, objectKeys: [], tempoBlocks: []})
    expect(check(out.detail, 'data-age-clickhouse').status).toBe('pass')
    expect(check(out.detail, 'data-age-object-store').status).toBe('pass')
    expect(check(out.detail, 'data-age-tempo').status).toBe('pass')
  })
})

// The canary is the deploy gate's proof, run on demand through `--canary-once`. These tests run `runCanary`
// directly: the same code, with the same injected fetch and object store.
describe('the canary check results', () => {
  it('sends one canary to the private receiver as JSON and reads Langfuse with the read-only user', async () => {
    const out = await canaryRun()
    expect(out.checks.map(entry => entry.id)).toEqual(['canary-send', 'canary-langfuse', 'canary-tempo'])
    for (const entry of out.checks) expect(entry.status).toBe('pass')
    const posts = out.requests.filter(entry => entry.url === ENDPOINTS.canaryReceiver)
    expect(posts).toHaveLength(1)
    expect(posts[0]?.method).toBe('POST')
    expect(posts[0]?.headers['content-type']).toBe('application/json')
    const reads = out.requests.filter(entry => entry.url.startsWith(ENDPOINTS.clickhouse))
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      expect(read.headers['x-clickhouse-user']).toBe(CLICKHOUSE_READER_USER)
      expect(read.headers['x-clickhouse-key']).toBe(CLICKHOUSE_PASSWORD)
    }
  })

  it('canary missing from Langfuse: the Langfuse branch fails, Tempo stays healthy', async () => {
    const out = await canaryRun({rowMissing: 'all'})
    expect(out.byId('canary-langfuse')).toMatchObject({status: 'fail'})
    expect(out.byId('canary-langfuse').detail).toContain('Langfuse')
    expect(out.byId('canary-tempo').status).toBe('pass')
    expect(out.byId('canary-send').status).toBe('pass')
  })

  it('materialised markers missing from the Langfuse row: names them and the column', async () => {
    const out = await canaryRun({rowMissing: ['status-message', 'scope-attribute']})
    const entry = out.byId('canary-langfuse')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain('status-message')
    expect(entry.detail).toContain('status_message')
    expect(entry.detail).toContain('scope-attribute')
  })

  it.each(TEMPO_DROPPED_PLACES)('a %s marker found in Tempo fails and names the place', async place => {
    const out = await canaryRun({tempoPlaces: [...TEMPO_KEPT_PLACES, place]})
    const entry = out.byId('canary-tempo')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain(place)
    expect(out.byId('canary-langfuse').status).toBe('pass')
  })

  it('canary never reaches Tempo: fails after the deadline, with the clock advancing only by sleeping', async () => {
    const out = await canaryRun({tempoPlaces: 'none'})
    expect(out.byId('canary-tempo').status).toBe('fail')
    expect(out.state.now - NOW).toBeGreaterThanOrEqual(THRESHOLDS.canaryDeadlineMs)
  })

  it('the collector will not take the canary: send fails and the readbacks are unknown, not passing', async () => {
    const out = await canaryRun({canaryPost: 503})
    expect(out.byId('canary-send').status).toBe('fail')
    expect(out.byId('canary-langfuse').status).toBe('unknown')
    expect(out.byId('canary-tempo').status).toBe('unknown')
    expect(out.requests.some(entry => entry.url.startsWith(ENDPOINTS.tempoTraceBase))).toBe(false)
  })

  it('a canary post that cannot connect fails the send', async () => {
    expect((await canaryRun({canaryPost: 'throw'})).byId('canary-send').status).toBe('fail')
  })

  it.each([
    ['tempo trace read 500', {tempoTrace: 500}],
    ['tempo trace read unparsable', {tempoTrace: 'garbage'}],
  ] as const)('%s never passes the Tempo check', async (_label, overrides) => {
    expect((await canaryRun(overrides)).byId('canary-tempo').status).not.toBe('pass')
  })

  it('a missing secret file makes the Langfuse readback unknown, never passing', async () => {
    expect((await canaryRun({secretsMissing: true})).byId('canary-langfuse').status).toBe('unknown')
  })

  it('a ClickHouse that answers 404 never passes the Langfuse readback', async () => {
    expect((await canaryRun({clickhouseStatus: 404})).byId('canary-langfuse').status).not.toBe('pass')
  })

  // Each row hangs one dependency and names the check that must not be passing afterwards.
  const hangs: [string, (url: string, body: string) => boolean, string][] = [
    ['the canary post', url => url === ENDPOINTS.canaryReceiver, 'canary-send'],
    [
      'the ClickHouse canary read',
      (url, body) => url.startsWith(ENDPOINTS.clickhouse) && body.includes('trace_id = {tid'),
      'canary-langfuse',
    ],
    ['the Tempo trace read', url => url.startsWith(ENDPOINTS.tempoTraceBase), 'canary-tempo'],
  ]

  it.each(hangs)('%s that never settles fails its check within the bound', async (_label, matches, id) => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      fetch: (url, init) =>
        matches(url, typeof init?.body === 'string' ? init.body : '') ? NEVER : world.deps.fetch(url, init),
    }
    const started = performance.now()
    const checks = await runCanary(deps)
    expect(performance.now() - started).toBeLessThan(3500)
    const entry = checks.find(candidate => candidate.id === id)
    expect(entry?.status).not.toBe('pass')
    expect(entry?.detail).toContain('timeout')
  })
})

describe('the canary-once mode', () => {
  const parse = (text: string) => record(JSON.parse(text), 'output')
  const ids = (text: string) => (parse(text).checks as CheckResult[]).map(entry => entry.id)

  it('prints one JSON document with exactly the three canary checks, and sends one canary', async () => {
    const world = harness()
    const text = await canaryOnceOutput(world.deps)
    expect(parse(text).schemaVersion).toBe(1)
    expect(ids(text)).toEqual([...CANARY_CHECK_IDS])
    for (const entry of parse(text).checks as CheckResult[]) expect(entry.status).toBe('pass')
    expect(world.requests.filter(entry => entry.url === ENDPOINTS.canaryReceiver)).toHaveLength(1)
  })

  it('reports a failing readback as a failing check, in the same document', async () => {
    const text = await canaryOnceOutput(harness({rowMissing: 'all'}).deps)
    const checks = parse(text).checks as CheckResult[]
    expect(checks.find(entry => entry.id === 'canary-langfuse')?.status).toBe('fail')
    expect(checks.find(entry => entry.id === 'canary-tempo')?.status).toBe('pass')
  })

  it('a canary that throws is three unknown checks, never a crash and never a pass', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      randomHex: () => {
        throw new Error('no entropy')
      },
    }
    const checks = parse(await canaryOnceOutput(deps)).checks as CheckResult[]
    expect(checks.map(entry => [entry.id, entry.status])).toEqual(CANARY_CHECK_IDS.map(id => [id, 'unknown']))
  })

  it('a canary that overruns the run deadline is three unknown checks', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: {probeTimeoutMs: 1000, runDeadlineMs: 40},
      fetch: () => NEVER,
    }
    const started = performance.now()
    const checks = parse(await canaryOnceOutput(deps)).checks as CheckResult[]
    expect(performance.now() - started).toBeLessThan(1500)
    expect(checks.map(entry => entry.status)).toEqual(['unknown', 'unknown', 'unknown'])
  })

  it('the mode flag and the check ids are the ones the deploy gate relies on', () => {
    expect(CANARY_ONCE_FLAG).toBe('--canary-once')
    expect([...CANARY_CHECK_IDS]).toEqual(['canary-send', 'canary-langfuse', 'canary-tempo'])
  })
})

describe('the Langfuse half of the canary', () => {
  it('a correctly delivered trace passes: the row holds only the materialised markers, the raw batch all nine', async () => {
    const out = await canaryRun()
    expect(out.byId('canary-langfuse').status).toBe('pass')
  })

  it('reads exactly the object the row names, with a size cap, and never lists the bucket for it', async () => {
    const world = harness({objectKeys: []})
    const calls = {childPrefixes: 0, firstKey: 0}
    const deps: ReporterDeps = {
      ...world.deps,
      objectStore: password => {
        const store = world.deps.objectStore(password)
        return {
          ...store,
          childPrefixes: prefix => {
            calls.childPrefixes += 1
            return store.childPrefixes(prefix)
          },
          firstKey: prefix => {
            calls.firstKey += 1
            return store.firstKey(prefix)
          },
        }
      },
    }
    const checks = await runCanary(deps)
    const reads = world.requests.filter(entry => entry.url === 'object-store-read')
    expect(reads.length).toBeGreaterThan(0)
    for (const read of reads) {
      expect(read.headers.key).toBe(RAW_KEY)
      expect(Number(read.headers.maxBytes)).toBe(RAW_BATCH_LIMITS.maxBytes)
    }
    expect(calls).toEqual({childPrefixes: 0, firstKey: 0})
    expect(checks.find(entry => entry.id === 'canary-langfuse')?.status).toBe('pass')
  })

  it.each(CANARY_PLACES)('a raw batch without the %s marker fails and names the place', async place => {
    const out = await canaryRun({rawMissing: [place]})
    const entry = out.byId('canary-langfuse')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain(place)
    expect(entry.detail).toContain('raw batch')
    expect(out.byId('canary-tempo').status).toBe('pass')
  })

  it('link, event and exception markers that Langfuse never copies into a row do not fail the row part', async () => {
    const out = await canaryRun({rowMissing: [], rawMissing: []})
    const entry = out.byId('canary-langfuse')
    expect(entry.status).toBe('pass')
    expect(entry.detail).not.toContain('link-attribute')
  })

  it('a raw batch that is not in the object store fails after the deadline, not at the first try', async () => {
    const out = await canaryRun({rawObject: 'absent'})
    const entry = out.byId('canary-langfuse')
    expect(entry.status).toBe('fail')
    expect(entry.detail).toContain('raw batch')
    expect(out.state.now - NOW).toBeGreaterThanOrEqual(THRESHOLDS.canaryDeadlineMs)
  })

  it.each(['not-json', 'not-array', 'gzip', 'oversize'] as const)(
    'a raw batch that is %s fails closed and never passes',
    async rawObject => {
      const out = await canaryRun({rawObject})
      expect(out.byId('canary-langfuse').status).toBe('fail')
    },
  )

  it('an object store that refuses the read is unknown, never a pass, and its error text stays out of the checks', async () => {
    const out = await canaryRun({rawObject: 'throw'})
    expect(out.byId('canary-langfuse').status).toBe('unknown')
    expect(JSON.stringify(out.checks)).not.toContain('ECONNREFUSED')
    expect(JSON.stringify(out.checks)).not.toContain('minio-internal')
  })

  it.each(['empty', 'malformed', 'other-prefix'] as const)(
    'a row whose raw batch key is %s fails without reading any object',
    async blobPath => {
      const out = await canaryRun({blobPath})
      const entry = out.byId('canary-langfuse')
      expect(entry.status).toBe('fail')
      expect(entry.detail).toContain('raw batch')
      expect(out.requests.some(request => request.url === 'object-store-read')).toBe(false)
    },
  )

  it('a raw batch read that never settles is bounded and fails the check', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      objectStore: password => ({...world.deps.objectStore(password), read: () => NEVER}),
    }
    const started = performance.now()
    const checks = await runCanary(deps)
    expect(performance.now() - started).toBeLessThan(3500)
    const entry = checks.find(candidate => candidate.id === 'canary-langfuse')
    expect(entry?.status).not.toBe('pass')
    expect(entry?.detail).toContain('timeout')
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
    ['langfuse web down', {langfuseWeb: 'throw'}],
    ['langfuse worker 500', {langfuseWorker: 500}],
    ['clickhouse 500', {clickhouseStatus: 500}],
  ]

  it.each(breakages)('%s', async (_label, overrides) => {
    const out = await runOnce(overrides)
    expect(out.reporter.health().status).toBe(503)
    expect(record(JSON.parse(out.detail), 'detail').ok).toBe(false)
    expect(record(JSON.parse(out.detail), 'detail').healthy).toBe(false)
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

// ─── Point-in-time checks only ────────────────────────────────────────────────

// Ongoing loss detection (failed exports, 503s, Tempo discards and truncation) belongs to the Grafana rules in
// `config/grafana/alerting/rules.yaml`. The reporter keeps only what is true of the stack right now.
describe('the reporter judges current state only', () => {
  const REMOVED = ['collector-failures', 'collector-refused', 'tempo-discards', 'tempo-truncation'] as const

  it('requires exactly the point-in-time ingest checks', () => {
    expect([...REQUIRED_CHECKS]).toEqual([
      'collector-health',
      'collector-queues',
      'tempo-ready',
      'langfuse-web',
      'langfuse-worker',
      'volume-space',
      'root-space',
      'data-age-clickhouse',
      'data-age-object-store',
      'data-age-tempo',
    ])
  })

  it('a run carries none of the four loss checks, and does not read the Tempo metrics page', async () => {
    const out = await runOnce()
    const ids = (record(JSON.parse(out.detail), 'detail').checks as CheckResult[]).map(entry => entry.id)
    for (const id of REMOVED) expect(ids).not.toContain(id)
    expect(ids.sort()).toEqual([...REQUIRED_CHECKS, ...MONITORING_CHECKS].sort())
    expect(out.requests.some(entry => entry.url === 'http://tempo:3200/metrics')).toBe(false)
  })

  it('loss counters that rise between two runs leave the verdict passing', async () => {
    let n = 0
    const world = harness()
    const reporter = createReporter({
      ...world.deps,
      fetch: async (url, init) =>
        url === ENDPOINTS.collectorMetrics
          ? new Response(
              collectorPage(
                [
                  `otelcol_exporter_enqueue_failed_spans{exporter="otlp_http/langfuse-fro-bot"} ${n}`,
                  `otelcol_exporter_send_failed_spans{exporter="otlp_http/tempo"} ${n}`,
                  authRequests('503', n),
                ].join('\n'),
              ),
              {status: 200},
            )
          : world.deps.fetch(url, init),
    })
    await reporter.runOnce()
    n = 40
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(record(JSON.parse(reporter.detail()), 'detail').ok).toBe(true)
    expect(reporter.health().status).toBe(200)
  })

  it('an id nobody classified still fails closed, a removed loss id included', () => {
    const passing: CheckResult[] = [...REQUIRED_CHECKS, ...MONITORING_CHECKS].map(id => ({
      id,
      status: 'pass',
      detail: 'ok',
    }))
    expect(assembleVerdict(passing, NOW).ok).toBe(true)
    for (const id of [...REMOVED, 'a-check-nobody-classified']) {
      expect(checkScope(id)).toBe('ingest')
      const verdict = assembleVerdict([...passing, {id, status: 'unknown', detail: 'stray'}], NOW)
      expect(verdict.ok).toBe(false)
      expect(verdict.checks.map(entry => entry.id)).toContain(id)
    }
  })
})

// ─── Deadlines ────────────────────────────────────────────────────────────────

describe('every probe has a deadline', () => {
  it('the run deadline is shorter than the interval, so a stuck run cannot hold the guard past the next tick', () => {
    expect(THRESHOLDS.runDeadlineMs).toBeLessThan(THRESHOLDS.intervalMs)
    expect(THRESHOLDS.probeTimeoutMs).toBeLessThan(THRESHOLDS.runDeadlineMs)
  })

  it('an object-store listing that never settles fails that check within the bound and nothing else', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      objectStore: () => ({childPrefixes: () => NEVER, firstKey: () => NEVER, read: () => NEVER}),
    }
    const reporter = createReporter(deps)
    const started = performance.now()
    await reporter.runOnce()
    expect(performance.now() - started).toBeLessThan(2000)

    const entry = check(reporter.detail(), 'data-age-object-store')
    expect(entry.status).not.toBe('pass')
    expect(entry.detail).toContain('timeout')
    expect(check(reporter.detail(), 'data-age-clickhouse').status).toBe('pass')
    expect(reporter.health().status).toBe(503)
  })

  it('a first-key read that never settles is bounded too', async () => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      objectStore: () => ({
        childPrefixes: async () => ['events/otel/project-a/'],
        firstKey: () => NEVER,
        read: () => NEVER,
      }),
    }
    const reporter = createReporter(deps)
    await reporter.runOnce()
    const entry = check(reporter.detail(), 'data-age-object-store')
    expect(entry.status).not.toBe('pass')
    expect(entry.detail).toContain('timeout')
  })

  // Each row hangs one dependency and names the checks that must not be passing afterwards.
  const hangs: [string, (url: string, body: string) => boolean, string[]][] = [
    ['the collector health read', url => url === ENDPOINTS.collectorHealth, ['collector-health']],
    ['the collector metrics read', url => url === ENDPOINTS.collectorMetrics, ['collector-queues']],
    ['the Tempo readiness read', url => url === ENDPOINTS.tempoReady, ['tempo-ready']],
    ['the Langfuse web read', url => url === ENDPOINTS.langfuseWeb, ['langfuse-web']],
    ['the Langfuse worker read', url => url === ENDPOINTS.langfuseWorker, ['langfuse-worker']],
    [
      'the ClickHouse age query',
      (url, body) => url.startsWith(ENDPOINTS.clickhouse) && body.includes('count() AS n'),
      ['data-age-clickhouse'],
    ],
  ]

  it.each(hangs)('%s that never settles fails its check within the bound', async (_label, matches, ids) => {
    const world = harness()
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      fetch: (url, init) =>
        matches(url, typeof init?.body === 'string' ? init.body : '') ? NEVER : world.deps.fetch(url, init),
    }
    const reporter = createReporter(deps)
    const started = performance.now()
    await reporter.runOnce()
    expect(performance.now() - started).toBeLessThan(3500)
    for (const id of ids) {
      const entry = check(reporter.detail(), id)
      expect(entry.status).not.toBe('pass')
      expect(entry.detail).toContain('timeout')
    }
    expect(reporter.health().status).toBe(503)
  })

  it('a response whose body never arrives is bounded too', async () => {
    const world = harness()
    const stalled = new Response(new ReadableStream({start: () => undefined}), {status: 200})
    const deps: ReporterDeps = {
      ...world.deps,
      limits: SMALL,
      fetch: (url, init) => (url === ENDPOINTS.tempoReady ? Promise.resolve(stalled) : world.deps.fetch(url, init)),
    }
    const reporter = createReporter(deps)
    await reporter.runOnce()
    expect(check(reporter.detail(), 'tempo-ready').status).not.toBe('pass')
    expect(check(reporter.detail(), 'tempo-ready').detail).toContain('timeout')
  })

  it.each([
    ['a secret file read', {readText: () => NEVER}, 'data-age-clickhouse'],
    ['the volume statfs', {statfs: () => NEVER}, 'volume-space'],
    ['the Tempo block listing', {readTempoBlockMetas: () => NEVER}, 'data-age-tempo'],
  ] as const)('%s that never settles fails its check', async (_label, override, id) => {
    const world = harness()
    const deps: ReporterDeps = {...world.deps, limits: SMALL, ...override}
    const reporter = createReporter(deps)
    await reporter.runOnce()
    expect(check(reporter.detail(), id).status).not.toBe('pass')
    expect(reporter.health().status).toBe(503)
  })
})

describe('a run has an overall deadline', () => {
  it('a stuck run is cut off with a failing verdict, and the next scheduled run starts and recovers', async () => {
    const world = harness()
    let stuck = true
    // The collector health read hangs for longer than the run deadline, so no per-probe deadline covers it: only the
    // run deadline can free the single-flight guard.
    const deps: ReporterDeps = {
      ...world.deps,
      limits: {probeTimeoutMs: 1000, runDeadlineMs: 60},
      fetch: (url, init) => (stuck && url === ENDPOINTS.collectorHealth ? NEVER : world.deps.fetch(url, init)),
    }
    const reporter = createReporter(deps)

    const started = performance.now()
    await reporter.runOnce()
    expect(performance.now() - started).toBeLessThan(1500)
    expect(reporter.health().status).toBe(503)
    const verdict = record(JSON.parse(reporter.detail()), 'detail')
    expect(verdict.ran).toBe(true)
    expect(verdict.ok).toBe(false)
    expect(check(reporter.detail(), 'run-deadline').status).toBe('fail')

    // The guard is free: the next run starts a fresh probe round and the verdict recovers.
    const before = world.requests.length
    stuck = false
    await reporter.runOnce()
    expect(world.requests.length).toBeGreaterThan(before)
    expect(reporter.health().status).toBe(200)
    expect(reporter.detail()).not.toContain('run-deadline')
  })

  it('overlapping callers still share one run while it is in flight', async () => {
    const world = harness()
    const reporter = createReporter({...world.deps, limits: SMALL})
    const first = reporter.runOnce()
    const second = reporter.runOnce()
    expect(second).toBe(first)
    await first
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
    expect(world.requests.filter(entry => entry.url === ENDPOINTS.collectorHealth)).toHaveLength(1)
  })
})

describe('the ingest block in the detail', () => {
  const metrics = collectorPage(
    [
      receiverCounters('marcusrbrown', 10, 1),
      receiverCounters('fro-bot', 200, 3),
      receiverCounters('workstation', 0, 0),
      authRequests('401', 31),
      authRequests('200', 13),
      canaryRequests('200', 72),
    ].join('\n'),
  )

  it('carries the counts, and sits beside the checks only in the loopback detail', async () => {
    const out = await runOnce({collectorMetrics: metrics})
    const ingest = record(record(JSON.parse(out.detail), 'detail').ingest, 'ingest')
    expect(ingest.groups).toEqual({
      marcusrbrown: {acceptedSpans: 10, refusedSpans: 1},
      'fro-bot': {acceptedSpans: 200, refusedSpans: 3},
      workstation: {acceptedSpans: 0, refusedSpans: 0},
    })
    expect(ingest.requests).toEqual({'200': 13, '401': 31})
    expect(typeof ingest.note).toBe('string')
    const response = handleDetail(out.reporter, new Request('http://localhost:8081/detail'))
    expect(record(record(JSON.parse(await response.text()), 'detail').ingest, 'ingest').requests).toEqual({
      '200': 13,
      '401': 31,
    })
  })

  it('never reaches the public answer', async () => {
    const out = await runOnce({collectorMetrics: metrics})
    const publicAnswer = out.reporter.health().body
    expect(Object.keys(record(JSON.parse(publicAnswer), 'body')).sort()).toEqual(['at', 'ok'])
    for (const word of ['ingest', 'acceptedSpans', 'refusedSpans', 'requests', '401', 'marcusrbrown']) {
      expect(publicAnswer).not.toContain(word)
    }
    const response = handlePublic(out.reporter, new Request('http://traces/healthz'))
    expect(await response.text()).toBe(publicAnswer)
  })

  it('is null before the first run', () => {
    const reporter = createReporter(harness().deps)
    expect(record(JSON.parse(reporter.detail()), 'detail').ingest).toBeNull()
  })

  it('is null when the metrics scrape fails, and the verdict is what it was without the block', async () => {
    for (const collectorMetrics of ['throw', 500, '<html>nope</html>'] as const) {
      const out = await runOnce({collectorMetrics})
      expect(record(JSON.parse(out.detail), 'detail').ingest).toBeNull()
      expect(check(out.detail, 'collector-queues').status).toBe('unknown')
      expect(out.reporter.health().status).toBe(503)
    }
  })

  it('does not keep the last counts when a later scrape fails', async () => {
    let page: string | undefined = metrics
    const world = harness()
    const reporter = createReporter({
      ...world.deps,
      fetch: async (url, init) =>
        url === ENDPOINTS.collectorMetrics
          ? new Response(page ?? 'down', {status: page === undefined ? 500 : 200})
          : world.deps.fetch(url, init),
    })
    await reporter.runOnce()
    expect(record(JSON.parse(reporter.detail()), 'detail').ingest).not.toBeNull()
    page = undefined
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(record(JSON.parse(reporter.detail()), 'detail').ingest).toBeNull()
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
    expect(handleDetail(out.reporter, new Request('http://localhost:8081/metrics')).status).toBe(404)
    expect(handleDetail(out.reporter, new Request('http://localhost:8081/detail', {method: 'POST'})).status).toBe(405)
  })
})

// ─── Monitoring checks and the split verdict ──────────────────────────────────

describe('the monitoring checks', () => {
  const monitoringBreakages: [string, Partial<Behaviour>, string][] = [
    ['grafana unreachable', {grafana: 'throw'}, 'grafana-health'],
    ['grafana 503', {grafana: 503}, 'grafana-health'],
    ['grafana 500', {grafana: 500}, 'grafana-health'],
    ['prometheus unreachable', {prometheus: 'throw'}, 'prometheus-health'],
    ['prometheus not ready (503)', {prometheus: 503}, 'prometheus-health'],
    ['embedder unreachable', {embedder: 'throw'}, 'embedder-health'],
    ['embedder still loading its model (503)', {embedder: 503}, 'embedder-health'],
    ['reader gate unreachable', {reader: 'throw'}, 'reader-health'],
    ['reader gate: Langfuse unreachable from it (503)', {reader: 'langfuse-down'}, 'reader-health'],
    ['reader gate: Grafana MCP unreachable from it (503)', {reader: 'grafana-down'}, 'reader-health'],
    ['reader gate: neither upstream reachable (503)', {reader: 'both-down'}, 'reader-health'],
    ['reader gate answers 200 with ok false', {reader: 'ok-false-on-200'}, 'reader-health'],
    ['reader gate answers 500', {reader: 500}, 'reader-health'],
  ]

  it('are Grafana, Prometheus, the Topics embedder and the reader gate, each probed at the endpoint it serves, and are not ingest checks', async () => {
    expect([...MONITORING_CHECKS]).toEqual(['grafana-health', 'prometheus-health', 'embedder-health', 'reader-health'])
    for (const id of MONITORING_CHECKS) expect((REQUIRED_CHECKS as readonly string[]).includes(id)).toBe(false)
    expect(ENDPOINTS.grafanaHealth).toBe('http://grafana:3000/api/health')
    expect(ENDPOINTS.prometheusReady).toBe('http://prometheus:9090/-/ready')
    expect(ENDPOINTS.embedderHealth).toBe('http://embedder:8080/health')
    expect(ENDPOINTS.readerHealth).toBe('http://reader-gate:8091/healthz')
    const out = await runOnce()
    expect(check(out.detail, 'grafana-health').status).toBe('pass')
    expect(check(out.detail, 'prometheus-health').status).toBe('pass')
    expect(check(out.detail, 'embedder-health').status).toBe('pass')
    expect(check(out.detail, 'reader-health').status).toBe('pass')
    expect(out.requests.some(entry => entry.url === ENDPOINTS.embedderHealth)).toBe(true)
    expect(out.requests.some(entry => entry.url === ENDPOINTS.readerHealth)).toBe(true)
    expect(out.requests.some(entry => entry.url === ENDPOINTS.grafanaHealth)).toBe(true)
    expect(out.requests.some(entry => entry.url === ENDPOINTS.prometheusReady)).toBe(true)
  })

  it('gives every check its scope in /detail, and defaults an unknown id to ingest, so it fails closed', async () => {
    const out = await runOnce()
    const checks = record(JSON.parse(out.detail), 'detail').checks as (CheckResult & {scope: string})[]
    for (const entry of checks) {
      expect({id: entry.id, scope: entry.scope}).toEqual({
        id: entry.id,
        scope: (MONITORING_CHECKS as readonly string[]).includes(entry.id) ? 'monitoring' : 'ingest',
      })
    }
    expect(checks.filter(entry => entry.scope === 'monitoring').map(entry => entry.id)).toEqual([...MONITORING_CHECKS])
    expect(checkScope('canary-send')).toBe('ingest')
    expect(checkScope('run-deadline')).toBe('ingest')
    expect(checkScope('something-new')).toBe('ingest')
  })

  // The ingest verdict is what `ingest open` and the deploy gate read (`ok`). `/healthz` is the whole (`healthy`).
  it.each(monitoringBreakages)(
    '%s: /healthz fails, the ingest verdict stays passing and names the monitoring check',
    async (_label, overrides, id) => {
      const out = await runOnce(overrides)
      const detail = record(JSON.parse(out.detail), 'detail')
      expect(check(out.detail, id).status).toBe('fail')
      expect(detail.ok).toBe(true)
      expect(detail.monitoringOk).toBe(false)
      expect(detail.healthy).toBe(false)
      expect(out.reporter.health().status).toBe(503)
      expect(JSON.parse(out.reporter.health().body)).toEqual({ok: false, at: new Date(NOW).toISOString()})
    },
  )

  it('an ingest failure fails both the ingest verdict and /healthz, and leaves monitoring passing', async () => {
    const out = await runOnce({langfuseWeb: 503})
    const detail = record(JSON.parse(out.detail), 'detail')
    expect(detail.ok).toBe(false)
    expect(detail.monitoringOk).toBe(true)
    expect(detail.healthy).toBe(false)
    expect(out.reporter.health().status).toBe(503)
  })

  it('both passing: ok, monitoringOk, healthy and /healthz agree', async () => {
    const out = await runOnce()
    const detail = record(JSON.parse(out.detail), 'detail')
    expect([detail.ok, detail.monitoringOk, detail.healthy]).toEqual([true, true, true])
    expect(out.reporter.health().status).toBe(200)
  })

  it('a stale verdict is neither ok, monitoring ok nor healthy', async () => {
    const world = harness()
    const reporter = createReporter(world.deps)
    await reporter.runOnce()
    world.state.now += THRESHOLDS.staleAfterIntervals * THRESHOLDS.intervalMs + 1
    const detail = record(JSON.parse(reporter.detail()), 'detail')
    expect([detail.ok, detail.monitoringOk, detail.healthy]).toEqual([false, false, false])
    expect(reporter.health().status).toBe(503)
  })

  it('before the first run: nothing is ok', () => {
    const reporter = createReporter(harness().deps)
    const detail = record(JSON.parse(reporter.detail()), 'detail')
    expect([detail.ok, detail.monitoringOk, detail.healthy]).toEqual([false, false, false])
  })

  it('assembleVerdict splits the two: a missing monitoring check fails monitoring only', () => {
    const ingest: CheckResult[] = REQUIRED_CHECKS.map(id => ({id, status: 'pass', detail: 'ok'}))
    const monitoring: CheckResult[] = MONITORING_CHECKS.map(id => ({id, status: 'pass', detail: 'ok'}))
    expect(assembleVerdict([...ingest, ...monitoring], NOW)).toMatchObject({ok: true, monitoringOk: true})
    expect(assembleVerdict(ingest, NOW)).toMatchObject({ok: true, monitoringOk: false})
    expect(assembleVerdict([...ingest.slice(1), ...monitoring], NOW)).toMatchObject({ok: false, monitoringOk: true})
    expect(assembleVerdict([...ingest, ...monitoring.slice(1)], NOW)).toMatchObject({ok: true, monitoringOk: false})
    const warned = monitoring.map(entry => ({...entry, status: 'warn' as const}))
    expect(assembleVerdict([...ingest, ...warned], NOW).monitoringOk).toBe(true)
    const unknown = monitoring.map(entry => ({...entry, status: 'unknown' as const}))
    expect(assembleVerdict([...ingest, ...unknown], NOW).monitoringOk).toBe(false)
  })

  // Topics is an insight feature: its embedder going down says so on /healthz and in Grafana, and never reaches the
  // ingest verdict that the deploy gate and `traces ingest open` read.
  it('an embedder that is down fails monitoring and /healthz only, and its gauge reads 0', async () => {
    const out = await runOnce({embedder: 'throw'})
    const detail = record(JSON.parse(out.detail), 'detail')
    expect([detail.ok, detail.monitoringOk, detail.healthy]).toEqual([true, false, false])
    expect(check(out.detail, 'embedder-health').detail).toBe('embedder is unhealthy (unreachable)')
    expect(out.reporter.health().status).toBe(503)
    const samples = exposition(out.reporter.metrics())
    expect(samples[`${METRIC_NAMES.probeUp}{target="embedder"}`]).toBe(0)
    expect(samples[`${METRIC_NAMES.probeUp}{target="grafana"}`]).toBe(1)
  })

  it('does not leak a probe error into the detail', async () => {
    const out = await runOnce({grafana: 'throw', prometheus: 'throw', embedder: 'throw', reader: 'throw'})
    expect(out.detail).not.toContain('ECONNREFUSED')
  })

  // The reader gate serves agents' reads, not ingest: a dead gate says so on /healthz and in Grafana and never reaches
  // the ingest verdict that the deploy gate and `traces ingest open` read.
  it('a reader gate that is down fails monitoring and /healthz only, and its gauge reads 0', async () => {
    const out = await runOnce({reader: 'throw'})
    const detail = record(JSON.parse(out.detail), 'detail')
    expect([detail.ok, detail.monitoringOk, detail.healthy]).toEqual([true, false, false])
    expect(check(out.detail, 'reader-health').detail).toBe('reader gate is unhealthy (unreachable)')
    expect(check(out.detail, 'reader-health')).toMatchObject({status: 'fail'})
    expect(out.reporter.health().status).toBe(503)
    const samples = exposition(out.reporter.metrics())
    expect(samples[`${METRIC_NAMES.probeUp}{target="reader-gate"}`]).toBe(0)
    expect(samples[`${METRIC_NAMES.probeUp}{target="grafana"}`]).toBe(1)
  })

  it('names which upstream the gate cannot reach, from its 503 answer', async () => {
    const cases: [Partial<Behaviour>, string][] = [
      [{reader: 'langfuse-down'}, 'reader gate is unhealthy (langfuse down, grafana up)'],
      [{reader: 'grafana-down'}, 'reader gate is unhealthy (langfuse up, grafana down)'],
      [{reader: 'both-down'}, 'reader gate is unhealthy (langfuse down, grafana down)'],
      [{reader: 'ok-false-on-200'}, 'reader gate is unhealthy (langfuse down, grafana up)'],
      [{reader: 500}, 'reader gate is unhealthy (http-500)'],
    ]
    for (const [overrides, detail] of cases) {
      const out = await runOnce(overrides)
      expect(check(out.detail, 'reader-health')).toMatchObject({status: 'fail', detail})
    }
    expect(check((await runOnce()).detail, 'reader-health').detail).toBe(
      'reader gate is healthy (langfuse up, grafana up)',
    )
  })

  it('reads an answer it cannot parse as unknown, which fails monitoring and not ingest', async () => {
    const out = await runOnce({reader: 'garbage'})
    const detail = record(JSON.parse(out.detail), 'detail')
    expect(check(out.detail, 'reader-health').status).toBe('unknown')
    expect([detail.ok, detail.monitoringOk]).toEqual([true, false])
    expect(exposition(out.reporter.metrics())[`${METRIC_NAMES.probeUp}{target="reader-gate"}`]).toBe(0)
  })

  it('a reader gate that hangs ends within the probe limit and fails monitoring only', async () => {
    const world = harness()
    const reporter = createReporter({
      ...world.deps,
      limits: {probeTimeoutMs: 20},
      fetch: (url, init) =>
        url === ENDPOINTS.readerHealth ? new Promise<Response>(() => {}) : world.deps.fetch(url, init),
    })
    await reporter.runOnce()
    const detail = record(JSON.parse(reporter.detail()), 'detail')
    expect(check(reporter.detail(), 'reader-health').detail).toBe('reader gate is unhealthy (timeout)')
    expect([detail.ok, detail.monitoringOk]).toEqual([true, false])
  })

  it('a monitoring failure still exports every gauge, and Grafana reads 0 on the probe gauge', async () => {
    const samples = exposition((await runOnce({grafana: 500, prometheus: 503})).reporter.metrics())
    expect(samples[`${METRIC_NAMES.probeUp}{target="grafana"}`]).toBe(0)
    expect(samples[`${METRIC_NAMES.probeUp}{target="langfuse-web"}`]).toBe(1)
    expect(samples[`${METRIC_NAMES.diskUsedRatio}{mount="volume"}`]).toBe(0.4)
  })
})

// ─── The metrics listener ─────────────────────────────────────────────────────

/** The samples of an exposition, keyed `name{labels}` for the tests to read. */
function exposition(text: string): Record<string, number> {
  return Object.fromEntries(
    parsePrometheus(text).map(sample => {
      const labels = Object.entries(sample.labels)
        .map(([key, value]) => `${key}="${value}"`)
        .join(',')
      return [labels === '' ? sample.name : `${sample.name}{${labels}}`, sample.value]
    }),
  )
}

describe('the metrics listener', () => {
  it('is a third port, distinct from the public and the loopback detail ports', () => {
    expect(PORTS.metrics).toBe(8082)
    expect(new Set(Object.values(PORTS)).size).toBe(Object.keys(PORTS).length)
  })

  it('exports no sample before the first run finishes', async () => {
    const world = harness()
    const reporter = createReporter(world.deps)
    expect(reporter.metrics()).toBe('')
    expect(renderMetrics(undefined)).toBe('')
    const response = handleMetrics(reporter, new Request('http://reporter:8082/metrics'))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')
  })

  it('exports the probe, disk, data-age and last-run gauges from the latest run', async () => {
    const out = await runOnce()
    const samples = exposition(out.reporter.metrics())
    expect(samples).toEqual({
      [`${METRIC_NAMES.probeUp}{target="langfuse-web"}`]: 1,
      [`${METRIC_NAMES.probeUp}{target="langfuse-worker"}`]: 1,
      [`${METRIC_NAMES.probeUp}{target="grafana"}`]: 1,
      [`${METRIC_NAMES.probeUp}{target="embedder"}`]: 1,
      [`${METRIC_NAMES.probeUp}{target="reader-gate"}`]: 1,
      [`${METRIC_NAMES.diskUsedRatio}{mount="volume"}`]: 0.4,
      [`${METRIC_NAMES.diskUsedRatio}{mount="root"}`]: 0.3,
      [`${METRIC_NAMES.oldestDataAge}{store="clickhouse"}`]: 2 * 86_400,
      [`${METRIC_NAMES.oldestDataAge}{store="object-store"}`]: (NOW - Date.UTC(2026, 10, 18, 9, 30)) / 1000,
      [`${METRIC_NAMES.oldestDataAge}{store="tempo"}`]: 3 * 86_400,
      [METRIC_NAMES.lastRun]: NOW / 1000,
    })
  })

  it('reports a probe that fails as 0, whichever of the five it is', async () => {
    const cases: [Partial<Behaviour>, string][] = [
      [{langfuseWeb: 503}, 'langfuse-web'],
      [{langfuseWorker: 'throw'}, 'langfuse-worker'],
      [{grafana: 500}, 'grafana'],
      [{embedder: 503}, 'embedder'],
      [{reader: 'both-down'}, 'reader-gate'],
    ]
    for (const [overrides, target] of cases) {
      const samples = exposition((await runOnce(overrides)).reporter.metrics())
      for (const name of ['langfuse-web', 'langfuse-worker', 'grafana', 'embedder', 'reader-gate']) {
        expect(samples[`${METRIC_NAMES.probeUp}{target="${name}"}`]).toBe(name === target ? 0 : 1)
      }
    }
  })

  it('leaves out a reading it could not take, and a store that holds nothing', async () => {
    const world = harness({clickhouseOldestMs: undefined, objectKeys: [], tempoBlocks: []})
    const reporter = createReporter({
      ...world.deps,
      statfs: async path => {
        if (path === PATHS.rootProbe) throw new Error('gone')
        return world.deps.statfs(path)
      },
    })
    await reporter.runOnce()
    const samples = exposition(reporter.metrics())
    expect(Object.keys(samples).filter(key => key.startsWith(METRIC_NAMES.oldestDataAge))).toEqual([])
    expect(samples[`${METRIC_NAMES.diskUsedRatio}{mount="root"}`]).toBeUndefined()
    expect(samples[`${METRIC_NAMES.diskUsedRatio}{mount="volume"}`]).toBe(0.4)
    expect(samples[METRIC_NAMES.lastRun]).toBe(NOW / 1000)
  })

  it('does not export the volume ratio when the sentinel is not the recognised one', async () => {
    for (const sentinel of ['not the volume\n', 'throw'] as const) {
      const samples = exposition((await runOnce({sentinel})).reporter.metrics())
      expect(samples[`${METRIC_NAMES.diskUsedRatio}{mount="volume"}`]).toBeUndefined()
      expect(samples[`${METRIC_NAMES.diskUsedRatio}{mount="root"}`]).toBe(0.3)
    }
  })

  it('moves the last-run timestamp with each finished run, and keeps the old gauges when a run overruns its deadline', async () => {
    const world = harness()
    let stuck = false
    const reporter = createReporter({
      ...world.deps,
      limits: {probeTimeoutMs: 1000, runDeadlineMs: 60},
      fetch: (url, init) => (stuck && url === ENDPOINTS.collectorHealth ? NEVER : world.deps.fetch(url, init)),
    })
    await reporter.runOnce()
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(exposition(reporter.metrics())[METRIC_NAMES.lastRun]).toBe((NOW + THRESHOLDS.intervalMs) / 1000)

    stuck = true
    world.state.now += THRESHOLDS.intervalMs
    await reporter.runOnce()
    expect(exposition(reporter.metrics())[METRIC_NAMES.lastRun]).toBe((NOW + THRESHOLDS.intervalMs) / 1000)
  })

  it('carries fixed labels and numbers only: nothing a probe read ever reaches the page', async () => {
    const out = await runOnce({
      clickhouseOldestMs: NOW - 5 * DAY,
      tempoPlaces: 'none',
      langfuseWeb: 'throw',
      collectorMetrics: collectorPage('secret_content{text="prompt text"} 1'),
    })
    const line = /^(?:# (?:HELP|TYPE) [a-z_]+ .*|[a-z_]+(?:\{[a-z]+="[a-z-]+"\})? -?[\d.]+(?:e[+-]?\d+)?)$/
    for (const row of out.reporter.metrics().trimEnd().split('\n')) {
      expect({row, valid: line.test(row)}).toEqual({row, valid: true})
    }
    expect(out.reporter.metrics()).not.toContain('prompt text')
    expect(out.reporter.metrics()).not.toContain('ECONNREFUSED')
    expect(out.reporter.metrics().endsWith('\n')).toBe(true)
  })

  it('answers GET /metrics only, in the Prometheus text format, and is not the public or the detail listener', async () => {
    const out = await runOnce()
    const response = handleMetrics(out.reporter, new Request('http://reporter:8082/metrics'))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toContain('text/plain')
    expect(response.headers.get('content-type')).toContain('version=0.0.4')
    expect(await response.text()).toBe(out.reporter.metrics())
    for (const path of ['/', '/healthz', '/detail', '/live', '/metrics/', '/metricsx']) {
      expect(handleMetrics(out.reporter, new Request(`http://reporter:8082${path}`)).status).toBe(404)
    }
    expect(handleMetrics(out.reporter, new Request('http://reporter:8082/metrics', {method: 'POST'})).status).toBe(405)
  })

  it('never starts a probe: a scrape reads the cache only', async () => {
    const out = await runOnce()
    const before = out.requests.length
    for (let scrape = 0; scrape < 3; scrape += 1) {
      handleMetrics(out.reporter, new Request('http://reporter:8082/metrics'))
    }
    expect(out.requests.length).toBe(before)
  })

  it('keeps /metrics off the public listener, where Caddy proxies /healthz', async () => {
    const source = await Bun.file(new URL('health-report.ts', import.meta.url)).text()
    expect(source).toContain("port: PORTS.public, hostname: '0.0.0.0', fetch: request => handlePublic(")
    expect(source).toContain("port: PORTS.metrics, hostname: '0.0.0.0', fetch: request => handleMetrics(")
    const out = await runOnce()
    expect(handlePublic(out.reporter, new Request('http://traces/metrics')).status).toBe(404)
  })
})

// ─── Real file readers ────────────────────────────────────────────────────────

/** The Tempo age check of a whole run whose block listing reads a real directory. */
async function tempoAge(root: string): Promise<CheckResult> {
  const world = harness()
  const reporter = createReporter({...world.deps, readTempoBlockMetas: () => readTempoBlockMetasFrom(root)})
  await reporter.runOnce()
  return check(reporter.detail(), 'data-age-tempo')
}

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

  // The layout seen on the host: `work.json` beside the tenant directory, a compacted block with only
  // `meta.compacted.json`, and stray files inside the tenant directory.
  it('ignores files beside the tenant and block directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
    try {
      mkdirSync(join(root, 'single-tenant', 'live'), {recursive: true})
      mkdirSync(join(root, 'single-tenant', 'compacted'), {recursive: true})
      writeFileSync(join(root, 'work.json'), '{}')
      writeFileSync(join(root, 'single-tenant', 'index.json.gz'), 'x')
      writeFileSync(join(root, 'single-tenant', 'live', 'meta.json'), '{"endTime":"2026-11-02T00:00:00Z"}')
      writeFileSync(
        join(root, 'single-tenant', 'compacted', 'meta.compacted.json'),
        '{"endTime":"2026-10-01T00:00:00Z"}',
      )
      expect(await readTempoBlockMetasFrom(root)).toEqual(['{"endTime":"2026-11-02T00:00:00Z"}'])
    } finally {
      rmSync(root, {recursive: true, force: true})
    }
  })

  // A new host has no blocks: Tempo has not flushed one yet. The age check is then a pass, as it is for an empty ClickHouse
  // or object store, never `unknown`: an unknown check fails the verdict and ingest could never open.
  describe('on a new host', () => {
    it.each([
      ['blocks/ exists and is empty', (_root: string) => undefined],
      ['blocks/ does not exist yet', (root: string) => rmSync(root, {recursive: true})],
      ['blocks/<tenant>/ is empty', (root: string) => mkdirSync(join(root, 'single-tenant'))],
      [
        'blocks/<tenant>/ holds only the tenant index, which is a file and not a block',
        (root: string) => {
          mkdirSync(join(root, 'single-tenant'))
          writeFileSync(join(root, 'single-tenant', 'index.json.gz'), 'x')
        },
      ],
      [
        'blocks/<tenant>/ holds a block with no meta.json yet',
        (root: string) => mkdirSync(join(root, 'single-tenant', 'block-a'), {recursive: true}),
      ],
    ])('passes as "Tempo is empty" when %s', async (_name, arrange) => {
      const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
      try {
        arrange(root)
        expect(await tempoAge(root)).toMatchObject({status: 'pass', detail: 'Tempo is empty'})
      } finally {
        rmSync(root, {recursive: true, force: true})
      }
    })

    it('reports the age of the oldest block when blocks are there', async () => {
      const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
      try {
        for (const [block, days] of [
          ['block-a', 3],
          ['block-b', 1],
        ] as const) {
          mkdirSync(join(root, 'single-tenant', block), {recursive: true})
          writeFileSync(
            join(root, 'single-tenant', block, 'meta.json'),
            JSON.stringify({endTime: new Date(NOW - days * DAY).toISOString()}),
          )
        }
        expect(await tempoAge(root)).toMatchObject({status: 'pass', detail: 'Tempo oldest data is 3.0 days old'})
      } finally {
        rmSync(root, {recursive: true, force: true})
      }
    })

    // The failure seen on the first deploy: Tempo's directories are 0700, so another user cannot list them.
    it.skipIf(process.getuid?.() === 0)('is unknown, never a pass, when blocks/ cannot be listed', async () => {
      const root = mkdtempSync(join(tmpdir(), 'traces-blocks-'))
      try {
        mkdirSync(join(root, 'blocks'), {mode: 0o000})
        expect(await tempoAge(join(root, 'blocks'))).toMatchObject({
          status: 'unknown',
          detail: 'Tempo age unreadable (blocks-unreadable)',
        })
      } finally {
        chmodSync(join(root, 'blocks'), 0o700)
        rmSync(root, {recursive: true, force: true})
      }
    })
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
