// ─── Health reporter ──────────────────────────────────────────────────────────
//
// One verdict for the whole trace stack, produced on the host. A timer runs every check, then publishes
// the result. Two listeners serve it:
//
//   0.0.0.0:8080   GET /healthz   200 or 503, and a body of `{ok, at}`: one boolean and one timestamp.
//                                 Caddy routes this path publicly, so nothing else may ever be in it.
//   127.0.0.1:8081 GET /detail    every check with its status and numbers, and the ingest counts
//                  GET /live      the process is up (the compose healthcheck)
//                                 The second listener is bound to the container's own loopback, so only
//                                 `docker compose exec` reaches it; `traces status` reads it over SSH.
//
// Rules every check follows:
//   - Fail closed. An unreachable dependency, a non-2xx, an unparsable body or a missing metric is
//     `unknown` or `fail`, never a pass. The verdict passes only when every required check is `pass` or `warn`.
//   - `/healthz` and `/detail` read the cached verdict. They never start a probe, so neither can be used to
//     load the stack.
//   - A verdict older than two intervals reads as failing, so a reporter whose timer has stopped cannot
//     keep reporting its last good answer.
//
// The checks are pure functions over fetched inputs. All I/O goes through `ReporterDeps`, so the tests run
// without a network, a clock or a disk. The file imports only Node and Bun built-ins: it runs from a bind
// mount with no install step. The constants repeated from `host.ts` are pinned there by a test.

import {readdir, statfs} from 'node:fs/promises'

// ─── Thresholds and fixed names ───────────────────────────────────────────────

/** Every limit the verdict depends on, in one place. */
export const THRESHOLDS = {
  /** Time between runs. */
  intervalMs: 300_000,
  /** A verdict older than this many intervals reads as failing. */
  staleAfterIntervals: 2,
  /** Per request, and per read of a file, a filesystem or the object store. */
  probeTimeoutMs: 10_000,
  /**
   * Per run, from the first probe to the verdict. It is shorter than the interval, so a run that a probe's
   * own deadline did not catch still frees the single-flight guard before the next tick.
   */
  runDeadlineMs: 240_000,
  /** An exporter queue at or above this fraction of its byte capacity fails: it is close to answering 503. */
  queueFullFraction: 0.8,
  /** Used share of a filesystem, in percent. At or above `warn` the check warns; at or above `fail` it fails. */
  volumeWarnPercent: 70,
  volumeFailPercent: 85,
  rootWarnPercent: 70,
  rootFailPercent: 85,
  /** Oldest data in any store, in days. Retention is 30; older than this fails the verdict. */
  maxDataAgeDays: 31,
  /** A loss counter that rose keeps the verdict failing this long, so a half-hourly monitor cannot miss it. */
  lossLatchMs: 30 * 60_000,
  /** How long the canary may take to appear in both backends. */
  canaryDeadlineMs: 60_000,
  canaryPollMs: 3000,
} as const

export const PORTS = {public: 8080, detail: 8081} as const
export const HEALTH_PATH = '/healthz'
export const DETAIL_PATH = '/detail'
export const LIVE_PATH = '/live'

/** Sender groups; pinned to `SENDER_GROUPS` in `host.ts` by a test. */
export const GROUPS = ['marcusrbrown', 'fro-bot', 'workstation'] as const

/** The group label the collector stamps on canary traces, so they can be filtered out. */
export const CANARY_GROUP = 'canary'

/**
 * The Langfuse environment the canary lands in, so the operator can filter it out in the UI. Langfuse v4.83.0 reads it
 * from the span attribute `langfuse.environment` (OtelIngestionProcessor `extractEnvironment`); `canary` is valid
 * under its name rules (lowercase `[a-z0-9-_]`, at most 40 characters, no leading `langfuse`). The readback never
 * filters on environment: it finds the row by `trace_id`.
 */
export const CANARY_ENVIRONMENT = 'canary'

/** First line of the volume's sentinel file; pinned to `TRACES_SENTINEL_CONTENT` in `host.ts` by a test. */
export const SENTINEL_CONTENT = 'traces-volume-v1'

/** Every collector exporter, pinned to the exporters in `config/otelcol.yaml` by a test. */
export const EXPECTED_EXPORTERS = [
  'otlp_http/langfuse-marcusrbrown',
  'otlp_http/langfuse-fro-bot',
  'otlp_http/langfuse-workstation',
  'otlp_http/langfuse-canary',
  'otlp_http/tempo',
] as const

/**
 * Langfuse's trace tables in ClickHouse. The retention TTL is set on these two and each holds the span
 * start time that the age check reads.
 */
export const TRACE_TABLES = ['events_full', 'events_core'] as const

export const CLICKHOUSE_DATABASE = 'default'

/** The read-only ClickHouse user; pinned to `config/clickhouse-users/traces-reader.xml` by a test. */
export const CLICKHOUSE_READER_USER = 'traces_reader'

export const OBJECT_STORE = {bucket: 'langfuse', prefix: 'events/otel/', user: 'minio'} as const

export const ENDPOINTS = {
  collectorHealth: 'http://collector:13133/',
  collectorMetrics: 'http://collector:8888/metrics',
  canaryReceiver: 'http://collector:4414/canary/v1/traces',
  tempoReady: 'http://tempo:3200/ready',
  tempoMetrics: 'http://tempo:3200/metrics',
  tempoTraceBase: 'http://tempo:3200/api/traces/',
  langfuseWeb: 'http://langfuse-web:3000/api/public/health',
  langfuseWorker: 'http://langfuse-worker:3030/api/health',
  clickhouse: 'http://clickhouse:8123/',
  objectStore: 'http://minio:9000',
} as const

export const PATHS = {
  clickhousePasswordFile: '/run/secrets/reporter/clickhouse-password',
  objectStorePasswordFile: '/run/secrets/reporter/minio-password',
  /** The volume's sentinel file, bind-mounted: its filesystem is the encrypted volume. */
  volumeSentinel: '/host/volume-sentinel',
  /** A directory on the root filesystem, bind-mounted read-only. */
  rootProbe: '/host/root',
  /** Tempo's data directory, mounted read-only. Completed blocks are `blocks/<tenant>/<block>/meta.json`. */
  tempoBlocks: '/var/tempo/blocks',
} as const

// ─── Types ────────────────────────────────────────────────────────────────────

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'unknown'

export interface CheckResult {
  id: string
  status: CheckStatus
  /** Short, and never carries a response body or a credential. Numbers and names only. */
  detail: string
}

export interface Verdict {
  ok: boolean
  /** When the run finished, in epoch milliseconds. */
  at: number
  checks: CheckResult[]
}

/** The checks every verdict must carry. A verdict missing one cannot pass. */
export const REQUIRED_CHECKS = [
  'collector-health',
  'collector-queues',
  'collector-failures',
  'collector-refused',
  'tempo-ready',
  'tempo-discards',
  'tempo-truncation',
  'langfuse-web',
  'langfuse-worker',
  'volume-space',
  'root-space',
  'data-age-clickhouse',
  'data-age-object-store',
  'data-age-tempo',
  'canary-send',
  'canary-langfuse',
  'canary-tempo',
] as const

export type Probe<T> = {ok: true; value: T} | {ok: false; reason: string}

export interface Sample {
  name: string
  labels: Record<string, string>
  value: number
}

/** Counter values from the previous run, and when each last rose. */
export interface CounterState {
  values: Record<string, number>
  lastRise: Record<string, number>
}

export function emptyCounterState(): CounterState {
  return {values: {}, lastRise: {}}
}

// ─── Small helpers ────────────────────────────────────────────────────────────

function result(id: string, status: CheckStatus, detail: string): CheckResult {
  return {id, status, detail}
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`
}

const DAY_MS = 86_400_000

function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error.name === 'TimeoutError' || error.name === 'AbortError')
  )
}

/** A short slug for a failed probe; never the error text, which can echo a URL or a header. */
function failureReason(error: unknown): string {
  return isTimeout(error) ? 'timeout' : 'unreachable'
}

// ─── Deadlines ─────────────────────────────────────────────────────────────────
//
// A dependency that accepts a connection and never answers leaves its promise pending forever, and an abort
// signal only helps when the dependency honours it. `bounded` stops waiting for the promise itself, so every
// probe ends within its limit whatever the dependency does.

class DeadlineError extends Error {
  constructor() {
    super('deadline exceeded')
    this.name = 'TimeoutError'
  }
}

/** Settle with `work`, or reject with a `TimeoutError` after `ms`. The late result of `work` is discarded. */
function bounded<T>(work: () => Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new DeadlineError()), ms)
    let pending: Promise<T>
    try {
      pending = work()
    } catch (error) {
      clearTimeout(timer)
      reject(error)
      return
    }
    pending.then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function probeLimit(deps: ReporterDeps): number {
  return deps.limits?.probeTimeoutMs ?? THRESHOLDS.probeTimeoutMs
}

function runLimit(deps: ReporterDeps): number {
  return deps.limits?.runDeadlineMs ?? THRESHOLDS.runDeadlineMs
}

// ─── Prometheus text ──────────────────────────────────────────────────────────

const SAMPLE_LINE = /^([A-Z_:][\w:]*)(?:\{(.*)\})?\s+(\S+)(?:\s+-?\d+)?$/i
const LABEL_PAIR = /([A-Z_]\w*)="((?:[^"\\]|\\.)*)"/gi

/**
 * Parse the Prometheus text format into samples. Comment and blank lines are skipped; a line that is not a
 * sample is skipped too, so a page of HTML yields no samples. A value that is not a number is kept as NaN
 * and every reader rejects it.
 */
export function parsePrometheus(text: string): Sample[] {
  const samples: Sample[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const match = SAMPLE_LINE.exec(trimmed)
    if (match === null) continue
    const [, name, rawLabels = '', rawValue = ''] = match
    const labels: Record<string, string> = {}
    for (const pair of rawLabels.matchAll(LABEL_PAIR)) {
      const [, key, value] = pair
      if (key !== undefined && value !== undefined) labels[key] = value
    }
    if (name !== undefined) samples.push({name, labels, value: Number(rawValue)})
  }
  return samples
}

/** The names a counter can carry: the OpenTelemetry Go exporter adds `_total` for counters, older builds do not. */
function counterNames(base: string): string[] {
  return [base, `${base}_total`]
}

function matching(samples: readonly Sample[], base: string, labels: Record<string, string> = {}): Sample[] {
  const names = counterNames(base)
  return samples.filter(
    sample =>
      names.includes(sample.name) && Object.entries(labels).every(([key, value]) => sample.labels[key] === value),
  )
}

// ─── Counters ─────────────────────────────────────────────────────────────────

/**
 * Advance one counter. The growth since the last run is the difference; a value below the last one means the
 * process restarted, so the growth is the whole new value. The first reading of a counter has nothing to
 * compare with and only sets its baseline. That is deliberate: the reporter restarts on every deploy, and a
 * collector or Tempo that outlived it carries old counts that are not new losses.
 */
export function advanceCounter(
  state: CounterState,
  key: string,
  current: number,
  nowMs: number,
): {growth: number; state: CounterState} {
  const previous = state.values[key]
  const growth = previous === undefined ? 0 : current >= previous ? current - previous : current
  return {
    growth,
    state: {
      values: {...state.values, [key]: current},
      lastRise: growth > 0 ? {...state.lastRise, [key]: nowMs} : state.lastRise,
    },
  }
}

/** The counters whose growth keeps a check failing: anything that rose inside the latch window. */
function recentlyRisen(state: CounterState, prefix: string, nowMs: number): string[] {
  return Object.entries(state.lastRise)
    .filter(([key, at]) => key.startsWith(prefix) && nowMs - at <= THRESHOLDS.lossLatchMs)
    .map(([key]) => key.slice(prefix.length))
    .sort()
}

interface CounterSpec {
  /** Check id, which is also the key prefix. */
  id: string
  /** Metric base name. */
  metric: string
  /** The label that names what the counter counts per. */
  label: string
  /** The values of that label to read. */
  values: readonly string[]
}

/**
 * Read a set of counters and report which rose recently. A counter that has never been incremented is not
 * exported by the OpenTelemetry SDK or by Tempo, so an absent series is zero. That is only believed when
 * `present` shows the page really came from the service (its always-present sentinel metric), which the
 * caller checks first.
 */
function readCounters(
  samples: readonly Sample[],
  spec: CounterSpec,
  state: CounterState,
  nowMs: number,
): {state: CounterState; invalid: string | undefined} {
  let next = state
  for (const value of spec.values) {
    const found = matching(samples, spec.metric, {[spec.label]: value})
    if (found.some(sample => !Number.isFinite(sample.value) || sample.value < 0)) {
      return {state: next, invalid: `${spec.metric} ${value} is not a count`}
    }
    const current = found.reduce((sum, sample) => sum + sample.value, 0)
    next = advanceCounter(next, `${spec.id}:${value}`, current, nowMs).state
  }
  return {state: next, invalid: undefined}
}

// ─── Collector metrics ────────────────────────────────────────────────────────

const HTTP_REQUESTS = 'http_server_request_duration_count'

/** The canary receiver's path: its series is the only one that carries `http_route`, and it is not ingest. */
const CANARY_ROUTE = new URL(ENDPOINTS.canaryReceiver).pathname

/**
 * The note that travels with the counts. They are totals since the collector started, so a reader must not take
 * them for rates, and the 401 total holds requests that are not senders'.
 */
export const INGEST_NOTE =
  'Counters since collector start, not rates. refusedSpans counts spans answered 429 (byte limiter) or 503 (full queue). ' +
  'The 401 total includes the unauthenticated probe the public monitor sends every 15 minutes, and deploy-gate probes.'

export interface IngestCounts {
  /** Spans per sender group, from the receiver's own counters. */
  groups: Record<string, {acceptedSpans: number; refusedSpans: number}>
  /** Requests per HTTP status code on the authenticated receivers, summed over every label combination. */
  requests: Record<string, number>
  note: string
}

function isCount(value: number): boolean {
  return Number.isFinite(value) && value >= 0
}

function total(samples: readonly Sample[]): number {
  return samples.reduce((sum, sample) => sum + sample.value, 0)
}

/**
 * The collector's HTTP request counts, without the canary route's. The three authenticated receivers export no
 * `http_route` and no `server_port`, so their series cannot be told apart by group; the canary's series carries both.
 */
function ingestRequests(samples: readonly Sample[]): Sample[] {
  return samples.filter(sample => sample.name === HTTP_REQUESTS && sample.labels.http_route !== CANARY_ROUTE)
}

/**
 * Counts for the operator: spans accepted and refused per group, and requests per status code. Absent series are
 * zero, as everywhere in this file (the caller has already shown the page is the collector's). A value that is
 * not a count makes the whole block `null`: a figure that cannot be believed is not shown.
 */
export function evaluateIngestCounts(samples: readonly Sample[]): IngestCounts | null {
  const groups: IngestCounts['groups'] = {}
  for (const group of GROUPS) {
    const receiver = `otlp/${group}`
    const accepted = matching(samples, 'otelcol_receiver_accepted_spans', {receiver})
    const refused = matching(samples, 'otelcol_receiver_refused_spans', {receiver})
    if (![...accepted, ...refused].every(sample => isCount(sample.value))) return null
    groups[group] = {acceptedSpans: total(accepted), refusedSpans: total(refused)}
  }

  const requests: Record<string, number> = {}
  for (const sample of ingestRequests(samples)) {
    if (!isCount(sample.value)) return null
    const status = sample.labels.http_response_status_code
    if (status !== undefined) requests[status] = (requests[status] ?? 0) + sample.value
  }
  return {groups, requests, note: INGEST_NOTE}
}

/** True when any OTLP receiver has accepted or refused a span, so the collector has served requests. */
function hasServedSpans(samples: readonly Sample[]): boolean {
  return ['otelcol_receiver_accepted_spans', 'otelcol_receiver_refused_spans'].some(metric =>
    matching(samples, metric).some(sample => sample.labels.receiver?.startsWith('otlp/') === true && sample.value > 0),
  )
}

/**
 * Only a 503 fails: it means a queue is full and the collector is shedding data. A 429 is the byte limiter doing
 * its job and passes. The receivers' own `refused_spans` counter rises for both, so it cannot tell them apart;
 * the HTTP request count by status code can.
 *
 * A counter that was never incremented is not exported, so an absent 503 series is zero. That is believed only
 * while the request metric is exported at all: spans served and no request series anywhere (the canary's own
 * included) means a renamed or switched-off metric, and the check is `unknown` rather than a pass. A collector that has served nothing has
 * nothing to report, so it passes.
 */
function evaluateUnavailable(
  samples: readonly Sample[],
  state: CounterState,
  nowMs: number,
): {state: CounterState; result: CheckResult} {
  const requests = ingestRequests(samples)
  if (!requests.every(sample => isCount(sample.value))) {
    return {state, result: result('collector-refused', 'unknown', `${HTTP_REQUESTS} is not a count`)}
  }
  // Presence is tested on the whole family, the canary's series included: they prove the metric is exported even
  // when the canary is the only traffic (after a restart with ingest held or off). Only the 503 total and the
  // displayed counts leave the canary out.
  const exported = samples.some(sample => sample.name === HTTP_REQUESTS)
  if (!exported && hasServedSpans(samples)) {
    return {
      state,
      result: result('collector-refused', 'unknown', `spans were served but ${HTTP_REQUESTS} is not exported`),
    }
  }
  const unavailable = total(requests.filter(sample => sample.labels.http_response_status_code === '503'))
  const next = advanceCounter(state, 'http503:all', unavailable, nowMs).state
  return {
    state: next,
    result:
      recentlyRisen(next, 'http503:', nowMs).length > 0
        ? result('collector-refused', 'fail', 'ingest answered 503 recently: an exporter queue was full')
        : result('collector-refused', 'pass', 'no 503 answers on ingest'),
  }
}

const COLLECTOR_SENTINEL = 'otelcol_process_uptime'

function isCollectorPage(samples: readonly Sample[]): boolean {
  return samples.some(sample => sample.name.startsWith(COLLECTOR_SENTINEL))
}

/** Each exporter queue against its byte capacity. */
export function evaluateQueues(samples: readonly Sample[]): CheckResult {
  const rows: string[] = []
  let worst = 0
  const problems: string[] = []
  const missing: string[] = []

  for (const exporter of EXPECTED_EXPORTERS) {
    const size_ = samples.find(
      sample => sample.name === 'otelcol_exporter_queue_size' && sample.labels.exporter === exporter,
    )
    const capacity_ = samples.find(
      sample => sample.name === 'otelcol_exporter_queue_capacity' && sample.labels.exporter === exporter,
    )
    const size = size_?.value
    const capacity = capacity_?.value
    if (size === undefined || capacity === undefined || !Number.isFinite(size) || !Number.isFinite(capacity)) {
      missing.push(exporter)
      continue
    }
    if (capacity <= 0 || size < 0) {
      problems.push(`${exporter} has capacity ${capacity}`)
      continue
    }
    const fraction = size / capacity
    worst = Math.max(worst, fraction)
    rows.push(`${exporter} ${percent(fraction * 100)}`)
    if (fraction >= THRESHOLDS.queueFullFraction) {
      problems.push(`${exporter} queue ${percent(fraction * 100)} full (${size} of ${capacity} bytes)`)
    }
  }

  if (missing.length > 0) return result('collector-queues', 'unknown', `no queue metric for ${missing.join(', ')}`)
  if (problems.length > 0) return result('collector-queues', 'fail', problems.join('; '))
  return result('collector-queues', 'pass', `fullest queue ${percent(worst * 100)}`)
}

/**
 * Evaluate everything the collector's metrics say. Returns the results, the counter state for the next run and the
 * ingest counts for the detail. A page that is not the collector's, or that lacks its sentinel, makes every metric
 * check `unknown` and carries no counts.
 */
export function evaluateCollectorMetrics(
  text: string,
  state: CounterState,
  nowMs: number,
): {results: CheckResult[]; state: CounterState; ingest: IngestCounts | null} {
  const samples = parsePrometheus(text)
  if (!isCollectorPage(samples)) {
    const why = 'collector metrics unreadable'
    return {
      results: [
        result('collector-queues', 'unknown', why),
        result('collector-failures', 'unknown', why),
        result('collector-refused', 'unknown', why),
      ],
      state,
      ingest: null,
    }
  }

  const queues = evaluateQueues(samples)
  let next = state

  const failureSpecs: CounterSpec[] = [
    {id: 'enqueue', metric: 'otelcol_exporter_enqueue_failed_spans', label: 'exporter', values: EXPECTED_EXPORTERS},
    {id: 'send', metric: 'otelcol_exporter_send_failed_spans', label: 'exporter', values: EXPECTED_EXPORTERS},
  ]

  const invalid: string[] = []
  for (const spec of failureSpecs) {
    const read = readCounters(samples, spec, next, nowMs)
    next = read.state
    if (read.invalid !== undefined) invalid.push(read.invalid)
  }

  const failed = [
    ...recentlyRisen(next, 'enqueue:', nowMs).map(name => `${name} enqueue failed`),
    ...recentlyRisen(next, 'send:', nowMs).map(name => `${name} send failed`),
  ]

  const unavailable = evaluateUnavailable(samples, next, nowMs)
  next = unavailable.state

  return {
    results: [
      queues,
      invalid.length > 0
        ? result('collector-failures', 'unknown', invalid.join('; '))
        : failed.length > 0
          ? result('collector-failures', 'fail', `spans lost recently: ${failed.join(', ')}`)
          : result('collector-failures', 'pass', 'no enqueue or send failures'),
      unavailable.result,
    ],
    state: next,
    ingest: evaluateIngestCounts(samples),
  }
}

// ─── Tempo metrics ────────────────────────────────────────────────────────────

/** Any metric in Tempo's own namespace proves the page is Tempo's registry (a page of HTML yields no samples at all). */
const TEMPO_NAMESPACE = 'tempo_'

/**
 * Tempo answers 200 to a trace it has cut down, so the only evidence is in its counters: spans discarded
 * (a trace over the size limit, a rate limit) and attributes truncated at 2,048 bytes. Both series are absent
 * until first used.
 *
 * Discarded spans are lost data and fail. Truncation is the documented effect of Tempo's default attribute
 * limit on long free-text fields (an error message can be long), and it warns rather than fails.
 */
export function evaluateTempoMetrics(
  text: string,
  state: CounterState,
  nowMs: number,
): {results: CheckResult[]; state: CounterState} {
  const samples = parsePrometheus(text)
  if (!samples.some(sample => sample.name.startsWith(TEMPO_NAMESPACE))) {
    const why = 'tempo metrics unreadable'
    return {results: [result('tempo-discards', 'unknown', why), result('tempo-truncation', 'unknown', why)], state}
  }

  // Discards are keyed by reason, which Tempo labels itself.
  const reasons = [
    ...new Set(matching(samples, 'tempo_discarded_spans').map(sample => sample.labels.reason ?? 'unlabelled')),
  ]
  let next = state
  let invalid: string | undefined
  const discards = readCounters(
    samples,
    {id: 'discard', metric: 'tempo_discarded_spans', label: 'reason', values: reasons},
    next,
    nowMs,
  )
  next = discards.state
  invalid ??= discards.invalid

  const truncated = matching(samples, 'tempo_distributor_attributes_truncated')
  if (truncated.some(sample => !Number.isFinite(sample.value) || sample.value < 0)) {
    invalid ??= 'tempo_distributor_attributes_truncated is not a count'
  }
  const truncatedTotal = truncated.reduce((sum, sample) => sum + sample.value, 0)
  next = advanceCounter(next, 'truncate:all', truncatedTotal, nowMs).state

  const discarded = recentlyRisen(next, 'discard:', nowMs)
  const truncatedRecently = recentlyRisen(next, 'truncate:', nowMs).length > 0

  return {
    results: [
      invalid === undefined
        ? discarded.length > 0
          ? result('tempo-discards', 'fail', `spans discarded recently: ${discarded.join(', ')}`)
          : result('tempo-discards', 'pass', 'no spans discarded')
        : result('tempo-discards', 'unknown', invalid),
      invalid === undefined
        ? truncatedRecently
          ? result('tempo-truncation', 'warn', 'attributes were truncated at the default limit')
          : result('tempo-truncation', 'pass', 'no attributes truncated')
        : result('tempo-truncation', 'unknown', invalid),
    ],
    state: next,
  }
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

export interface FsStats {
  /** Total blocks, free blocks and blocks available to an unprivileged user, as `statfs` reports them. */
  blocks: number
  bfree: number
  bavail: number
}

/** Used share as `df` computes it: used / (used + available). */
export function usedPercent(stats: FsStats): number | undefined {
  const values = [stats.blocks, stats.bfree, stats.bavail]
  if (!values.every(Number.isFinite) || stats.blocks <= 0) return undefined
  const used = stats.blocks - stats.bfree
  const total = used + stats.bavail
  return total <= 0 ? undefined : (used / total) * 100
}

export function evaluateDisk(
  id: string,
  label: string,
  stats: Probe<FsStats>,
  limits: {warn: number; fail: number},
): CheckResult {
  if (!stats.ok) return result(id, 'unknown', `${label} usage unreadable (${stats.reason})`)
  const used = usedPercent(stats.value)
  if (used === undefined) return result(id, 'unknown', `${label} usage unreadable (bad statfs)`)
  if (used >= limits.fail) return result(id, 'fail', `${label} ${percent(used)} used (fails at ${limits.fail}%)`)
  if (used >= limits.warn) return result(id, 'warn', `${label} ${percent(used)} used (warns at ${limits.warn}%)`)
  return result(id, 'pass', `${label} ${percent(used)} used`)
}

/** The volume check also requires the sentinel to carry its recognised first line. */
export function evaluateVolume(stats: Probe<FsStats>, sentinel: Probe<string>): CheckResult {
  if (!sentinel.ok) return result('volume-space', 'fail', `volume sentinel unreadable (${sentinel.reason})`)
  if (sentinel.value.split('\n')[0]?.trim() !== SENTINEL_CONTENT) {
    return result('volume-space', 'fail', 'volume sentinel has unexpected content')
  }
  return evaluateDisk('volume-space', 'volume', stats, {
    warn: THRESHOLDS.volumeWarnPercent,
    fail: THRESHOLDS.volumeFailPercent,
  })
}

// ─── Age of the oldest data ───────────────────────────────────────────────────

/** `oldestMs` is undefined for a store that holds nothing yet, which is legitimate on a new stack. */
export function evaluateAge(id: string, label: string, oldest: Probe<number | undefined>, nowMs: number): CheckResult {
  if (!oldest.ok) return result(id, 'unknown', `${label} age unreadable (${oldest.reason})`)
  if (oldest.value === undefined) return result(id, 'pass', `${label} is empty`)
  if (!Number.isFinite(oldest.value)) return result(id, 'unknown', `${label} age unreadable (bad time)`)
  const days = (nowMs - oldest.value) / DAY_MS
  const shown = `${label} oldest data is ${days.toFixed(1)} days old`
  return days > THRESHOLDS.maxDataAgeDays
    ? result(id, 'fail', `${shown} (limit ${THRESHOLDS.maxDataAgeDays})`)
    : result(id, 'pass', shown)
}

/** Time of the oldest object from a key of the form `events/otel/<project>/YYYY/MM/DD/HH/MM/<id>.json`. */
export function objectKeyTime(key: string): number | undefined {
  const match = /\/(\d{4})\/(\d{2})\/(\d{2})\/(\d{2})\/(\d{2})\//.exec(key)
  if (match === null) return undefined
  const [, year, month, day, hour, minute] = match.map(Number)
  if ([year, month, day, hour, minute].includes(undefined)) return undefined
  return Date.UTC(year as number, (month as number) - 1, day as number, hour as number, minute as number)
}

/** The end time of a Tempo block, from its `meta.json`. Tempo retention is measured on the block's end time. */
export function blockEndMs(text: string): number | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || !('endTime' in parsed)) return undefined
  const end = typeof parsed.endTime === 'string' ? Date.parse(parsed.endTime) : Number.NaN
  return Number.isFinite(end) ? end : undefined
}

// ─── Canary ───────────────────────────────────────────────────────────────────

/** One place OTLP can hold text. The canary writes a different marker into each. */
export const CANARY_PLACES = [
  'content-key',
  'unlisted-attribute',
  'resource-attribute',
  'scope-attribute',
  'event-attribute',
  'link-attribute',
  'status-message',
  'exception-message',
  'span-name',
] as const

export type CanaryPlace = (typeof CANARY_PLACES)[number]

/** Where Tempo keeps text: span names, status and exception messages, and (unfiltered) link attributes. */
export const TEMPO_KEPT_PLACES: readonly CanaryPlace[] = [
  'status-message',
  'exception-message',
  'span-name',
  'link-attribute',
]

export const TEMPO_DROPPED_PLACES: readonly CanaryPlace[] = CANARY_PLACES.filter(
  place => !TEMPO_KEPT_PLACES.includes(place),
)

// ─── Where Langfuse keeps each marker ─────────────────────────────────────────
//
// THE ONE PLACE TO RE-CHECK ON A LANGFUSE UPGRADE. Langfuse does not store a trace as it received it. It writes
// the whole OTLP batch to the object store (the raw batch, below) and projects each span into one ClickHouse
// row. Only some of what the canary sends survives the projection, so the readback is in two parts:
//
//   1. the ClickHouse row (`events_full`) holds each marker in the column named here, for the six places Langfuse
//      materialises. It proves delivery to the worker and the projection;
//   2. the raw batch holds all nine markers. It proves nothing was cut on the way in, including the places the
//      projection drops.
//
// Derived from langfuse/langfuse at tag v4.83.0. Re-read these when the pinned Langfuse tag changes:
//   - packages/shared/src/server/otel/OtelIngestionProcessor.ts, `processToEvent()` and `extractInputAndOutput()`
//     (the direct-write path: the worker's defaults LANGFUSE_MIGRATION_V4_WRITE_MODE=events_only and
//     LANGFUSE_MIGRATION_V4_NATIVE_OTEL_BEHAVIOUR=direct send every batch down it; the compose sets neither);
//   - worker/src/services/IngestionService/index.ts, `createEventRecord()` (the column mapping, and
//     `blob_storage_file_path: fileKey`, the raw batch's key);
//   - packages/shared/src/server/otel/OtelIngestionProcessor.ts, `publishToOtelIngestionQueue()` and
//     web/src/server/otel/processOtelIngestion.ts (the raw batch: `JSON.stringify(resourceSpans)`, plain JSON,
//     key `events/otel/<project>/YYYY/MM/DD/HH/MM/<uuid>.json`, no compression, no content encoding).
//
//   span-name           name             the span name (`extractName` falls back to it)
//   status-message      status_message   `span.status.message`
//   content-key         input            `gen_ai.input.messages` becomes the observation input, reshaped to
//                                        {messages, tools}; the text is kept (measured byte-exact up to 4 MB)
//   resource-attribute  metadata_values  metadata.resourceAttributes.* flattened into metadata_names/values
//   scope-attribute     metadata_values  metadata.scope.attributes.*, the same way
//   unlisted-attribute  metadata_values  metadata.attributes.* (span attributes not consumed as input/output)
//   event-attribute     (none)           a span event is read only when its name is a recognised GenAI event
//                                        (gen_ai.*.message, gen_ai.choice, gen_ai.content.*,
//                                        gen_ai.client.inference.operation.details); `canary-event` is not
//   exception-message   (none)           an `exception` span event is not a recognised GenAI event either
//   link-attribute      (none)           `span.links` is never read
//
// Measured on the 2026-11-20 probe of this exact stack and version: name, input, metadata `attributes.*` and
// `resourceAttributes.*` read back as above (through Langfuse's own observation API, which reads this table).
// Not measured: status_message, `scope.attributes.*`, `blob_storage_file_path` row contents, and the absence of the
// three unmaterialised places. Those come from the source and are first confirmed on the real host.
export type LangfuseColumn = 'name' | 'status_message' | 'input' | 'metadata_values'

export const LANGFUSE_MARKER_LOCATIONS: Readonly<Record<CanaryPlace, {readonly column: LangfuseColumn | undefined}>> = {
  'content-key': {column: 'input'},
  'unlisted-attribute': {column: 'metadata_values'},
  'resource-attribute': {column: 'metadata_values'},
  'scope-attribute': {column: 'metadata_values'},
  'event-attribute': {column: undefined},
  'link-attribute': {column: undefined},
  'status-message': {column: 'status_message'},
  'exception-message': {column: undefined},
  'span-name': {column: 'name'},
}

/**
 * Bounds on the raw batch read. The key comes from the ClickHouse row, so one object is read and nothing is
 * listed. The canary is a few kilobytes, so the cap is far above any real canary batch; a larger object fails.
 */
export const RAW_BATCH_LIMITS = {maxBytes: 1_048_576} as const

/** The key layout Langfuse writes (see the table above): nothing else is ever read as a raw batch. */
export const RAW_BATCH_KEY =
  /^events\/otel\/[\w-]+\/\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}\.json$/

export interface Canary {
  traceId: string
  markers: Record<CanaryPlace, string>
  /** The OTLP JSON request body. */
  body: unknown
}

function stringAttribute(key: string, value: string): {key: string; value: {stringValue: string}} {
  return {key, value: {stringValue: value}}
}

/**
 * Build one small OTLP JSON trace with a unique marker in each place OTLP can hold text.
 * `randomHex(n)` returns n random bytes as 2n hex characters.
 */
export function buildCanary(nowMs: number, randomHex: (bytes: number) => string): Canary {
  const run = randomHex(4)
  const marker = (place: CanaryPlace): string => `canary-${place}-${run}`
  const markers = Object.fromEntries(CANARY_PLACES.map(place => [place, marker(place)])) as Record<CanaryPlace, string>

  const traceId = randomHex(16)
  const nanos = (ms: number): string => (BigInt(ms) * 1_000_000n).toString()

  const body = {
    resourceSpans: [
      {
        resource: {
          attributes: [
            stringAttribute('service.name', 'health-reporter-canary'),
            stringAttribute('sender.group', CANARY_GROUP),
            stringAttribute('canary.resource', markers['resource-attribute']),
          ],
        },
        scopeSpans: [
          {
            scope: {
              name: 'health-reporter-canary',
              version: '1',
              attributes: [stringAttribute('canary.scope', markers['scope-attribute'])],
            },
            spans: [
              {
                traceId,
                spanId: randomHex(8),
                name: markers['span-name'],
                kind: 1,
                startTimeUnixNano: nanos(nowMs - 1000),
                endTimeUnixNano: nanos(nowMs),
                attributes: [
                  stringAttribute('gen_ai.operation.name', 'invoke_agent'),
                  stringAttribute('langfuse.session.id', `canary-session-${run}`),
                  stringAttribute('langfuse.environment', CANARY_ENVIRONMENT),
                  stringAttribute(
                    'gen_ai.input.messages',
                    JSON.stringify([{role: 'user', parts: [{type: 'text', content: markers['content-key']}]}]),
                  ),
                  stringAttribute('canary.unlisted', markers['unlisted-attribute']),
                ],
                events: [
                  {
                    timeUnixNano: nanos(nowMs - 500),
                    name: 'canary-event',
                    attributes: [stringAttribute('canary.event', markers['event-attribute'])],
                  },
                  {
                    timeUnixNano: nanos(nowMs - 400),
                    name: 'exception',
                    attributes: [
                      stringAttribute('exception.type', 'CanaryError'),
                      stringAttribute('exception.message', markers['exception-message']),
                    ],
                  },
                ],
                links: [
                  {
                    traceId: randomHex(16),
                    spanId: randomHex(8),
                    attributes: [stringAttribute('canary.link', markers['link-attribute'])],
                  },
                ],
                status: {code: 2, message: markers['status-message']},
              },
            ],
          },
        ],
      },
    ],
  }

  return {traceId, markers, body}
}

function present(text: string, canary: Canary, places: readonly CanaryPlace[]): CanaryPlace[] {
  return places.filter(place => text.includes(canary.markers[place]))
}

type Row = Record<string, unknown>

/** The rows of a `JSONEachRow` answer, or undefined when any line is not a JSON object. */
function parseRows(text: string): Row[] | undefined {
  const rows: Row[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      return undefined
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
    rows.push(Object.fromEntries(Object.entries(parsed)))
  }
  return rows
}

function columnHolds(row: Row, column: LangfuseColumn, marker: string): boolean {
  const value = row[column]
  if (typeof value === 'string') return value.includes(marker)
  return Array.isArray(value) && value.some(item => typeof item === 'string' && item.includes(marker))
}

/** Every place Langfuse materialises, with its column. The places it drops are not here. */
function materialisedPlaces(): {place: CanaryPlace; column: LangfuseColumn}[] {
  return CANARY_PLACES.flatMap(place => {
    const {column} = LANGFUSE_MARKER_LOCATIONS[place]
    return column === undefined ? [] : [{place, column}]
  })
}

/** The columns the readback selects: the marker columns, the trace id and the raw batch's key. */
const LANGFUSE_ROW_COLUMNS: readonly string[] = [
  'trace_id',
  ...new Set(materialisedPlaces().map(entry => entry.column)),
  'blob_storage_file_path',
]

/**
 * Part 1, delivery and materialisation. The canary's row is in ClickHouse and each place Langfuse materialises
 * holds its marker in the column the table names. A marker Langfuse does not copy into a row is not required.
 */
export function evaluateLangfuseRow(rows: string | undefined, canary: Canary): CheckResult {
  if (rows === undefined || rows.trim() === '')
    return result('canary-langfuse', 'fail', 'canary trace not found in Langfuse')
  const parsed = parseRows(rows)
  if (parsed === undefined || parsed.length === 0) return result('canary-langfuse', 'fail', 'Langfuse row unreadable')
  const required = materialisedPlaces()
  const missing = required.filter(
    ({place, column}) => !parsed.some(row => columnHolds(row, column, canary.markers[place])),
  )
  return missing.length === 0
    ? result(
        'canary-langfuse',
        'pass',
        `canary trace found with all ${required.length} materialised markers in ClickHouse`,
      )
    : result(
        'canary-langfuse',
        'fail',
        `markers missing in the ClickHouse row: ${missing.map(entry => `${entry.place} (${entry.column})`).join(', ')}`,
      )
}

/**
 * The raw batch's key, from the canary's row. Langfuse writes it into `blob_storage_file_path`; an empty value
 * (the dual-write path) or any value that is not the key layout fails closed, so nothing outside the batch
 * prefix is ever read.
 */
export function rawBatchKey(rows: string): Probe<string> {
  const parsed = parseRows(rows)
  if (parsed === undefined) return {ok: false, reason: 'rows-unreadable'}
  let key: string | undefined
  for (const row of parsed) {
    const path = row.blob_storage_file_path
    if (typeof path !== 'string' || path === '') continue
    if (!RAW_BATCH_KEY.test(path)) return {ok: false, reason: 'unrecognised-key'}
    key ??= path
  }
  return key === undefined ? {ok: false, reason: 'no-key'} : {ok: true, value: key}
}

/**
 * Part 2, whole-trace fidelity. The raw batch is a JSON array of `resourceSpans`, and it holds all nine markers:
 * Langfuse's own copy of what the collector sent, before any projection.
 */
export function evaluateLangfuseRaw(text: string | undefined, canary: Canary): CheckResult {
  if (text === undefined) return result('canary-langfuse', 'fail', 'batch not found in the object store')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return result('canary-langfuse', 'fail', 'batch is not JSON')
  }
  if (!Array.isArray(parsed)) return result('canary-langfuse', 'fail', 'batch is not a resourceSpans array')
  const missing = CANARY_PLACES.filter(place => !text.includes(canary.markers[place]))
  return missing.length === 0
    ? result('canary-langfuse', 'pass', `all ${CANARY_PLACES.length} markers found`)
    : result('canary-langfuse', 'fail', `markers missing: ${missing.join(', ')}`)
}

/** One answer from the two parts: it passes only when both do, and every part that did not pass is named. */
export function combineLangfuse(row: CheckResult, raw: CheckResult): CheckResult {
  if (row.status === 'pass' && raw.status === 'pass') {
    return result('canary-langfuse', 'pass', `${row.detail}; raw batch: ${raw.detail}`)
  }
  const parts = [
    ...(row.status === 'pass' ? [] : [`row: ${row.detail}`]),
    ...(raw.status === 'pass' ? [] : [`raw batch: ${raw.detail}`]),
  ]
  const failed = row.status === 'fail' || raw.status === 'fail'
  return result('canary-langfuse', failed ? 'fail' : 'unknown', parts.join('; '))
}

/**
 * Tempo must hold the span name, status message, exception message and link attribute, and none of the
 * others. A marker found where it must not be fails and names its place.
 */
export function evaluateTempoReadback(body: string | undefined, canary: Canary): CheckResult {
  if (body === undefined || body.trim() === '') return result('canary-tempo', 'fail', 'canary trace not found in Tempo')
  const leaked = present(body, canary, TEMPO_DROPPED_PLACES)
  if (leaked.length > 0) return result('canary-tempo', 'fail', `content reached Tempo: ${leaked.join(', ')}`)
  const kept = present(body, canary, TEMPO_KEPT_PLACES)
  const lost = TEMPO_KEPT_PLACES.filter(place => !kept.includes(place))
  return lost.length === 0
    ? result('canary-tempo', 'pass', 'canary trace found in Tempo with only the kept markers')
    : result('canary-tempo', 'fail', `kept markers missing in Tempo: ${lost.join(', ')}`)
}

// ─── Dependencies (all I/O) ───────────────────────────────────────────────────

export interface ObjectStoreReader {
  /** The first key under a prefix, in key order, or undefined when there is none. */
  firstKey: (prefix: string) => Promise<string | undefined>
  /** The immediate sub-prefixes under a prefix. */
  childPrefixes: (prefix: string) => Promise<string[]>
  /**
   * The first `maxBytes + 1` bytes of one object, or undefined when it does not exist. One byte more than the
   * cap tells the caller the object is too large without reading it all.
   */
  read: (key: string, maxBytes: number) => Promise<Uint8Array | undefined>
}

/** The only part of `fetch` the reporter uses, so a test can supply one function. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface ReporterDeps {
  fetch: FetchLike
  now: () => number
  sleep: (ms: number) => Promise<void>
  randomHex: (bytes: number) => string
  /** Filesystem stats of the filesystem holding `path`. */
  statfs: (path: string) => Promise<FsStats>
  /** UTF-8 contents of a small file. */
  readText: (path: string) => Promise<string>
  /** The `meta.json` contents of every completed Tempo block. */
  readTempoBlockMetas: () => Promise<string[]>
  objectStore: (password: string) => ObjectStoreReader
  /** Deadlines in milliseconds; the defaults are in `THRESHOLDS`. A test shortens them. */
  limits?: {probeTimeoutMs?: number; runDeadlineMs?: number}
}

async function probeText(
  deps: ReporterDeps,
  url: string,
  init: RequestInit = {},
): Promise<Probe<{status: number; text: string}>> {
  const limit = probeLimit(deps)
  try {
    return await bounded(async () => {
      const response = await deps.fetch(url, {...init, signal: AbortSignal.timeout(limit)})
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined)
        return {ok: false, reason: `http-${response.status}`} as const
      }
      return {ok: true, value: {status: response.status, text: await response.text()}} as const
    }, limit)
  } catch (error) {
    return {ok: false, reason: failureReason(error)}
  }
}

function isJsonObject(text: string): boolean {
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
  } catch {
    return false
  }
}

async function readSecret(deps: ReporterDeps, path: string): Promise<Probe<string>> {
  try {
    const value = (await bounded(() => deps.readText(path), probeLimit(deps))).trim()
    return value === '' ? {ok: false, reason: 'empty-secret'} : {ok: true, value}
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'timeout' : 'secret-unreadable'}
  }
}

// ─── Simple HTTP health checks ────────────────────────────────────────────────

export async function checkCollectorHealth(deps: ReporterDeps): Promise<CheckResult> {
  const probe = await probeText(deps, ENDPOINTS.collectorHealth)
  if (!probe.ok) return result('collector-health', 'fail', `collector health check failed (${probe.reason})`)
  return isJsonObject(probe.value.text)
    ? result('collector-health', 'pass', 'collector reports healthy')
    : result('collector-health', 'unknown', 'collector health answer unreadable')
}

export async function checkTempoReady(deps: ReporterDeps): Promise<CheckResult> {
  const probe = await probeText(deps, ENDPOINTS.tempoReady)
  return probe.ok
    ? result('tempo-ready', 'pass', 'tempo is ready')
    : result('tempo-ready', 'fail', `tempo is not ready (${probe.reason})`)
}

/** Langfuse web answers 200 while its worker is down, so the two are separate checks and the worker is named. */
export async function checkLangfuse(deps: ReporterDeps): Promise<CheckResult[]> {
  const [web, worker] = await Promise.all([
    probeText(deps, ENDPOINTS.langfuseWeb),
    probeText(deps, ENDPOINTS.langfuseWorker),
  ])
  return [
    web.ok
      ? result('langfuse-web', 'pass', 'langfuse web is healthy')
      : result('langfuse-web', 'fail', `langfuse web is unhealthy (${web.reason})`),
    worker.ok
      ? result('langfuse-worker', 'pass', 'langfuse worker is healthy')
      : result('langfuse-worker', 'fail', `langfuse worker is unhealthy (${worker.reason})`),
  ]
}

// ─── ClickHouse (read-only user) ──────────────────────────────────────────────

async function queryClickHouse(
  deps: ReporterDeps,
  password: string,
  sql: string,
  params: Record<string, string> = {},
): Promise<Probe<string>> {
  const url = new URL(ENDPOINTS.clickhouse)
  for (const [key, value] of Object.entries(params)) url.searchParams.set(`param_${key}`, value)
  const probe = await probeText(deps, url.toString(), {
    method: 'POST',
    headers: {'x-clickhouse-user': CLICKHOUSE_READER_USER, 'x-clickhouse-key': password},
    body: sql,
  })
  return probe.ok ? {ok: true, value: probe.value.text} : probe
}

/** The oldest span start across the trace tables. A table that cannot be read fails the whole check: it is not skipped. */
export async function oldestClickHouseSpan(deps: ReporterDeps): Promise<Probe<number | undefined>> {
  const password = await readSecret(deps, PATHS.clickhousePasswordFile)
  if (!password.ok) return password

  let oldest: number | undefined
  for (const table of TRACE_TABLES) {
    const answer = await queryClickHouse(
      deps,
      password.value,
      `SELECT count() AS n, toUnixTimestamp(min(start_time)) AS oldest FROM ${CLICKHOUSE_DATABASE}.${table} FORMAT JSONEachRow`,
    )
    if (!answer.ok) return {ok: false, reason: `${table}: ${answer.reason}`}
    let row: unknown
    try {
      row = JSON.parse(answer.value.trim())
    } catch {
      return {ok: false, reason: `${table}: unparsable`}
    }
    if (typeof row !== 'object' || row === null || !('n' in row) || !('oldest' in row)) {
      return {ok: false, reason: `${table}: unexpected shape`}
    }
    const count = Number(row.n)
    const seconds = Number(row.oldest)
    if (!Number.isFinite(count) || !Number.isFinite(seconds)) return {ok: false, reason: `${table}: unexpected shape`}
    if (count === 0) continue
    const ms = seconds * 1000
    oldest = oldest === undefined ? ms : Math.min(oldest, ms)
  }
  return {ok: true, value: oldest}
}

/** The canary trace's rows in `events_full`, as `JSONEachRow` text, or undefined when there are none yet. */
async function readLangfuseRows(deps: ReporterDeps, canary: Canary): Promise<Probe<string | undefined>> {
  const password = await readSecret(deps, PATHS.clickhousePasswordFile)
  if (!password.ok) return password
  const answer = await queryClickHouse(
    deps,
    password.value,
    `SELECT ${LANGFUSE_ROW_COLUMNS.join(', ')} FROM ${CLICKHOUSE_DATABASE}.events_full WHERE trace_id = {tid:String} LIMIT 20 FORMAT JSONEachRow`,
    {tid: canary.traceId},
  )
  if (!answer.ok) return answer
  return {ok: true, value: answer.value.trim() === '' ? undefined : answer.value}
}

function decodeRawBatch(bytes: Uint8Array): Probe<string> {
  if (bytes.length > RAW_BATCH_LIMITS.maxBytes) {
    return {ok: false, reason: `larger than ${RAW_BATCH_LIMITS.maxBytes} bytes`}
  }
  // Langfuse v4.83.0 uploads plain JSON. A gzip header means an upgrade changed that: fail, and name it.
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) return {ok: false, reason: 'compressed'}
  try {
    return {ok: true, value: new TextDecoder('utf-8', {fatal: true}).decode(bytes)}
  } catch {
    return {ok: false, reason: 'not UTF-8'}
  }
}

/**
 * Part 2: read the one object the canary's row names, and look for every marker in it. A read that cannot be done
 * is `unknown`; an object that is missing or unusable is `fail`.
 */
async function checkRawBatch(deps: ReporterDeps, rows: string, canary: Canary): Promise<CheckResult> {
  const key = rawBatchKey(rows)
  if (!key.ok) return result('canary-langfuse', 'fail', `the row names no usable batch (${key.reason})`)
  const password = await readSecret(deps, PATHS.objectStorePasswordFile)
  if (!password.ok) return result('canary-langfuse', 'unknown', `object store could not be read (${password.reason})`)
  let bytes: Uint8Array | undefined
  try {
    const store = deps.objectStore(password.value)
    bytes = await bounded(() => store.read(key.value, RAW_BATCH_LIMITS.maxBytes), probeLimit(deps))
  } catch (error) {
    return result('canary-langfuse', 'unknown', `object store could not be read (${failureReason(error)})`)
  }
  if (bytes === undefined) return evaluateLangfuseRaw(undefined, canary)
  const text = decodeRawBatch(bytes)
  if (!text.ok) return result('canary-langfuse', 'fail', `batch unusable (${text.reason})`)
  return evaluateLangfuseRaw(text.value, canary)
}

/** The Langfuse half of the canary: the ClickHouse row (part 1) and the raw batch it names (part 2). */
async function checkLangfuseCanary(deps: ReporterDeps, canary: Canary): Promise<CheckResult> {
  const rows = await readLangfuseRows(deps, canary)
  if (!rows.ok) return result('canary-langfuse', 'unknown', `Langfuse could not be read (${rows.reason})`)
  if (rows.value === undefined) return result('canary-langfuse', 'fail', 'canary trace not found in Langfuse')
  return combineLangfuse(evaluateLangfuseRow(rows.value, canary), await checkRawBatch(deps, rows.value, canary))
}

// ─── Object store and Tempo age ───────────────────────────────────────────────

export async function oldestObjectBatch(deps: ReporterDeps): Promise<Probe<number | undefined>> {
  const password = await readSecret(deps, PATHS.objectStorePasswordFile)
  if (!password.ok) return password
  const limit = probeLimit(deps)
  try {
    const store = deps.objectStore(password.value)
    const projects = await bounded(() => store.childPrefixes(OBJECT_STORE.prefix), limit)
    let oldest: number | undefined
    for (const project of projects) {
      const key = await bounded(() => store.firstKey(project), limit)
      if (key === undefined) continue
      const time = objectKeyTime(key)
      if (time === undefined) return {ok: false, reason: 'unrecognised-key'}
      oldest = oldest === undefined ? time : Math.min(oldest, time)
    }
    return {ok: true, value: oldest}
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'object-store-timeout' : 'object-store-unreachable'}
  }
}

export async function oldestTempoBlock(deps: ReporterDeps): Promise<Probe<number | undefined>> {
  try {
    const metas = await bounded(() => deps.readTempoBlockMetas(), probeLimit(deps))
    let oldest: number | undefined
    for (const text of metas) {
      const end = blockEndMs(text)
      if (end === undefined) return {ok: false, reason: 'unreadable-block'}
      oldest = oldest === undefined ? end : Math.min(oldest, end)
    }
    return {ok: true, value: oldest}
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'blocks-timeout' : 'blocks-unreadable'}
  }
}

// ─── Canary run ───────────────────────────────────────────────────────────────

async function readTempoCanary(deps: ReporterDeps, canary: Canary): Promise<Probe<string | undefined>> {
  const limit = probeLimit(deps)
  try {
    return await bounded(async (): Promise<Probe<string | undefined>> => {
      const response = await deps.fetch(`${ENDPOINTS.tempoTraceBase}${canary.traceId}`, {
        headers: {accept: 'application/json'},
        signal: AbortSignal.timeout(limit),
      })
      if (response.status === 404) {
        response.body?.cancel().catch(() => undefined)
        return {ok: true, value: undefined}
      }
      if (!response.ok) {
        response.body?.cancel().catch(() => undefined)
        return {ok: false, reason: `http-${response.status}`}
      }
      const text = await response.text()
      return isJsonObject(text) ? {ok: true, value: text} : {ok: false, reason: 'unparsable'}
    }, limit)
  } catch (error) {
    return {ok: false, reason: failureReason(error)}
  }
}

/**
 * Send the canary through the collector's private receiver, then wait for it in both backends. The send, the
 * Langfuse readback and the Tempo readback are three checks, so one failing backend is named and the other
 * stays green. A canary that cannot be confirmed in both by the deadline fails.
 */
export async function runCanary(deps: ReporterDeps): Promise<CheckResult[]> {
  const canary = buildCanary(deps.now(), deps.randomHex)

  const sent = await probeText(deps, ENDPOINTS.canaryReceiver, {
    method: 'POST',
    headers: {'content-type': 'application/json'},
    body: JSON.stringify(canary.body),
  })
  if (!sent.ok) {
    const why = `canary was not accepted by the collector (${sent.reason})`
    return [
      result('canary-send', 'fail', why),
      result('canary-langfuse', 'unknown', 'canary was not sent'),
      result('canary-tempo', 'unknown', 'canary was not sent'),
    ]
  }

  const deadline = deps.now() + THRESHOLDS.canaryDeadlineMs
  let langfuse: CheckResult | undefined
  let tempo: CheckResult | undefined
  let langfuseLast = result('canary-langfuse', 'fail', 'canary trace not found in Langfuse')
  let tempoLast = result('canary-tempo', 'fail', 'canary trace not found in Tempo')

  for (;;) {
    if (langfuse === undefined) {
      langfuseLast = await checkLangfuseCanary(deps, canary)
      if (langfuseLast.status === 'pass') langfuse = langfuseLast
    }
    if (tempo === undefined) {
      const body = await readTempoCanary(deps, canary)
      if (!body.ok) {
        tempoLast = result('canary-tempo', 'unknown', `Tempo could not be read (${body.reason})`)
      } else if (body.value === undefined) {
        tempoLast = result('canary-tempo', 'fail', 'canary trace not found in Tempo')
      } else {
        // The trace is in Tempo: its content is final, so the answer does not change by waiting.
        tempo = evaluateTempoReadback(body.value, canary)
      }
    }
    if (langfuse !== undefined && tempo !== undefined) break
    if (deps.now() >= deadline) break
    await deps.sleep(THRESHOLDS.canaryPollMs)
  }

  return [
    result('canary-send', 'pass', 'canary accepted by the collector'),
    langfuse ?? langfuseLast,
    tempo ?? tempoLast,
  ]
}

// ─── One full run ─────────────────────────────────────────────────────────────

/** Run one check; a check that throws is `unknown`, never a pass and never a crash. */
async function guarded(ids: readonly string[], run: () => Promise<CheckResult[]>): Promise<CheckResult[]> {
  try {
    return await run()
  } catch {
    return ids.map(id => result(id, 'unknown', 'check could not run'))
  }
}

export interface RunOutcome {
  verdict: Verdict
  counters: CounterState
  /** The ingest counts from this run's scrape, or null when the scrape failed or could not be read. */
  ingest: IngestCounts | null
}

/**
 * Assemble a verdict from check results. It passes only when every required check is present and is `pass` or
 * `warn`. A missing check, an unknown one or a failed one fails the verdict.
 */
export function assembleVerdict(results: readonly CheckResult[], at: number): Verdict {
  const byId = new Map(results.map(entry => [entry.id, entry]))
  const checks = REQUIRED_CHECKS.map(id => byId.get(id) ?? result(id, 'unknown', 'check did not run'))
  const required: readonly string[] = REQUIRED_CHECKS
  const extras = results.filter(entry => !required.includes(entry.id))
  const all = [...checks, ...extras]
  return {ok: all.every(entry => entry.status === 'pass' || entry.status === 'warn'), at, checks: all}
}

const COLLECTOR_COUNTER_PREFIXES = ['enqueue:', 'send:', 'http503:'] as const
const TEMPO_COUNTER_PREFIXES = ['discard:', 'truncate:'] as const

function pick<T>(record: Record<string, T>, prefixes: readonly string[]): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => prefixes.some(prefix => key.startsWith(prefix))))
}

/** The collector and Tempo checks run at the same time, so each advances only its own counters. */
function mergeCounters(base: CounterState, collector: CounterState, tempo: CounterState): CounterState {
  return {
    values: {
      ...base.values,
      ...pick(collector.values, COLLECTOR_COUNTER_PREFIXES),
      ...pick(tempo.values, TEMPO_COUNTER_PREFIXES),
    },
    lastRise: {
      ...base.lastRise,
      ...pick(collector.lastRise, COLLECTOR_COUNTER_PREFIXES),
      ...pick(tempo.lastRise, TEMPO_COUNTER_PREFIXES),
    },
  }
}

async function probeFs(deps: ReporterDeps, path: string): Promise<Probe<FsStats>> {
  try {
    return {ok: true, value: await bounded(() => deps.statfs(path), probeLimit(deps))}
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'timeout' : 'statfs-failed'}
  }
}

export async function runChecks(deps: ReporterDeps, counters: CounterState): Promise<RunOutcome> {
  const startedAt = deps.now()
  let collectorState = counters
  let tempoState = counters
  let ingest: IngestCounts | null = null

  const [collector, tempo, langfuse, disk, ages, canary] = await Promise.all([
    guarded(['collector-health', 'collector-queues', 'collector-failures', 'collector-refused'], async () => {
      const [health, metrics] = await Promise.all([
        checkCollectorHealth(deps),
        probeText(deps, ENDPOINTS.collectorMetrics),
      ])
      if (!metrics.ok) {
        const why = `collector metrics unreadable (${metrics.reason})`
        return [
          health,
          result('collector-queues', 'unknown', why),
          result('collector-failures', 'unknown', why),
          result('collector-refused', 'unknown', why),
        ]
      }
      const evaluated = evaluateCollectorMetrics(metrics.value.text, counters, startedAt)
      collectorState = evaluated.state
      ingest = evaluated.ingest
      return [health, ...evaluated.results]
    }),
    guarded(['tempo-ready', 'tempo-discards', 'tempo-truncation'], async () => {
      const [ready, metrics] = await Promise.all([checkTempoReady(deps), probeText(deps, ENDPOINTS.tempoMetrics)])
      if (!metrics.ok) {
        const why = `tempo metrics unreadable (${metrics.reason})`
        return [ready, result('tempo-discards', 'unknown', why), result('tempo-truncation', 'unknown', why)]
      }
      const evaluated = evaluateTempoMetrics(metrics.value.text, counters, startedAt)
      tempoState = evaluated.state
      return [ready, ...evaluated.results]
    }),
    guarded(['langfuse-web', 'langfuse-worker'], () => checkLangfuse(deps)),
    guarded(['volume-space', 'root-space'], async () => {
      const [sentinel, volume, root] = await Promise.all([
        readFileText(deps, PATHS.volumeSentinel),
        probeFs(deps, PATHS.volumeSentinel),
        probeFs(deps, PATHS.rootProbe),
      ])
      return [
        evaluateVolume(volume, sentinel),
        evaluateDisk('root-space', 'root disk', root, {
          warn: THRESHOLDS.rootWarnPercent,
          fail: THRESHOLDS.rootFailPercent,
        }),
      ]
    }),
    guarded(['data-age-clickhouse', 'data-age-object-store', 'data-age-tempo'], async () => {
      const [clickhouse, objects, blocks] = await Promise.all([
        oldestClickHouseSpan(deps),
        oldestObjectBatch(deps),
        oldestTempoBlock(deps),
      ])
      const now = deps.now()
      return [
        evaluateAge('data-age-clickhouse', 'ClickHouse', clickhouse, now),
        evaluateAge('data-age-object-store', 'object store', objects, now),
        evaluateAge('data-age-tempo', 'Tempo', blocks, now),
      ]
    }),
    guarded(['canary-send', 'canary-langfuse', 'canary-tempo'], () => runCanary(deps)),
  ])

  return {
    verdict: assembleVerdict([...collector, ...tempo, ...langfuse, ...disk, ...ages, ...canary], deps.now()),
    counters: mergeCounters(counters, collectorState, tempoState),
    ingest,
  }
}

async function readFileText(deps: ReporterDeps, path: string): Promise<Probe<string>> {
  try {
    return {ok: true, value: await bounded(() => deps.readText(path), probeLimit(deps))}
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'timeout' : 'unreadable'}
  }
}

// ─── Reporter: cached verdict and the two answers ─────────────────────────────

export interface HealthAnswer {
  status: 200 | 503
  /** `{"ok":boolean,"at":string|null}` and nothing else. */
  body: string
}

export interface Reporter {
  /** Run every check now and cache the verdict. Overlapping calls share one run. */
  runOnce: () => Promise<void>
  /** The public answer. Reads the cache only; never starts a probe. */
  health: () => HealthAnswer
  /** The operator's detail. Reads the cache only. */
  detail: () => string
}

export function createReporter(deps: ReporterDeps): Reporter {
  let verdict: Verdict | undefined
  let ingest: IngestCounts | null = null
  let counters = emptyCounterState()
  let running: Promise<void> | undefined

  const isFresh = (): boolean =>
    verdict !== undefined && deps.now() - verdict.at <= THRESHOLDS.staleAfterIntervals * THRESHOLDS.intervalMs

  const runOnce = (): Promise<void> => {
    running ??= (async () => {
      try {
        const outcome = await bounded(() => runChecks(deps, counters), runLimit(deps))
        counters = outcome.counters
        verdict = outcome.verdict
        ingest = outcome.ingest
      } catch (error) {
        // A run that dies leaves the old verdict to go stale; it never turns into a pass. A run that overran its
        // deadline publishes a failing verdict now, instead of letting the old one age out: its late result is
        // discarded, the single-flight guard is freed below, and the next run starts on schedule.
        if (isTimeout(error)) {
          verdict = assembleVerdict(
            [result('run-deadline', 'fail', `the run did not finish within ${Math.round(runLimit(deps) / 1000)} s`)],
            deps.now(),
          )
          ingest = null
        }
      } finally {
        running = undefined
      }
    })()
    return running
  }

  return {
    runOnce,
    health: () => {
      const ok = verdict?.ok === true && isFresh()
      return {
        status: ok ? 200 : 503,
        body: JSON.stringify({ok, at: verdict === undefined ? null : new Date(verdict.at).toISOString()}),
      }
    },
    detail: () =>
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date(deps.now()).toISOString(),
        intervalMs: THRESHOLDS.intervalMs,
        ran: verdict !== undefined,
        stale: verdict === undefined ? true : !isFresh(),
        ok: verdict?.ok === true && isFresh(),
        at: verdict === undefined ? null : new Date(verdict.at).toISOString(),
        checks: verdict?.checks ?? [],
        ingest,
      }),
  }
}

// ─── HTTP handlers ────────────────────────────────────────────────────────────

const JSON_HEADERS = {'content-type': 'application/json', 'cache-control': 'no-store'} as const

/** The public listener: `GET /healthz` and nothing else. */
export function handlePublic(reporter: Reporter, request: Request): Response {
  const {pathname} = new URL(request.url)
  if (pathname !== HEALTH_PATH) return new Response('not found', {status: 404})
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('method not allowed', {status: 405})
  const answer = reporter.health()
  return new Response(request.method === 'HEAD' ? null : answer.body, {status: answer.status, headers: JSON_HEADERS})
}

/** The loopback listener: the detail and the liveness answer. */
export function handleDetail(reporter: Reporter, request: Request): Response {
  const {pathname} = new URL(request.url)
  if (request.method !== 'GET') return new Response('method not allowed', {status: 405})
  if (pathname === DETAIL_PATH) return new Response(reporter.detail(), {status: 200, headers: JSON_HEADERS})
  if (pathname === LIVE_PATH) return new Response('live', {status: 200})
  return new Response('not found', {status: 404})
}

// ─── Real dependencies and entry point ────────────────────────────────────────

async function realStatfs(path: string): Promise<FsStats> {
  const stats = await statfs(path)
  return {blocks: Number(stats.blocks), bfree: Number(stats.bfree), bavail: Number(stats.bavail)}
}

/**
 * The `meta.json` of every completed block under a Tempo blocks directory. A directory that does not exist
 * yet is a stack that has not flushed a block, so it holds nothing; any other read error propagates and the
 * check is `unknown`.
 */
export async function readTempoBlockMetasFrom(root: string): Promise<string[]> {
  const metas: string[] = []
  // Tempo keeps files beside the tenant directories (`work.json`), and its compactor removes block directories
  // while this runs. Only directories are entered, and one that has gone since it was listed is skipped. Any
  // other failure (for example no permission) still throws, and the caller reports the store as unreadable.
  const directories = async (path: string): Promise<string[]> => {
    try {
      const entries = await readdir(path, {withFileTypes: true})
      return entries.filter(entry => entry.isDirectory()).map(entry => entry.name)
    } catch (error) {
      if (isGone(error)) return []
      throw error
    }
  }
  for (const tenant of await directories(root)) {
    for (const block of await directories(`${root}/${tenant}`)) {
      const file = Bun.file(`${root}/${tenant}/${block}/meta.json`)
      try {
        // A block directory without meta.json is mid-write or compacted away.
        if (await file.exists()) metas.push(await file.text())
      } catch (error) {
        if (!isGone(error)) throw error
      }
    }
  }
  return metas
}

function isGone(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

function realObjectStore(password: string): ObjectStoreReader {
  const client = new Bun.S3Client({
    endpoint: ENDPOINTS.objectStore,
    bucket: OBJECT_STORE.bucket,
    accessKeyId: OBJECT_STORE.user,
    secretAccessKey: password,
    region: 'auto',
  })
  return {
    firstKey: async prefix => (await client.list({prefix, maxKeys: 1})).contents?.[0]?.key,
    childPrefixes: async prefix =>
      ((await client.list({prefix, delimiter: '/', maxKeys: 100})).commonPrefixes ?? []).map(entry => entry.prefix),
    read: async (key, maxBytes) => {
      const file = client.file(key)
      if (!(await file.exists())) return undefined
      // A range read: an object larger than the cap is never fetched whole.
      return new Uint8Array(await file.slice(0, maxBytes + 1).arrayBuffer())
    },
  }
}

export function realDeps(): ReporterDeps {
  return {
    fetch: (url, init) => fetch(url, init),
    now: () => Date.now(),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    randomHex: bytes =>
      Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join(''),
    statfs: realStatfs,
    readText: path => Bun.file(path).text(),
    readTempoBlockMetas: () => readTempoBlockMetasFrom(PATHS.tempoBlocks),
    objectStore: realObjectStore,
  }
}

function log(message: string): void {
  process.stderr.write(`${new Date().toISOString()} ${message}\n`)
}

/** Start both listeners and the timer. Called only when this file is the entry point. */
export function start(deps: ReporterDeps = realDeps()): void {
  const reporter = createReporter(deps)
  Bun.serve({port: PORTS.public, hostname: '0.0.0.0', fetch: request => handlePublic(reporter, request)})
  Bun.serve({port: PORTS.detail, hostname: '127.0.0.1', fetch: request => handleDetail(reporter, request)})

  const tick = (): void => {
    reporter
      .runOnce()
      .then(() => {
        const answer = reporter.health()
        log(`run finished: ${answer.status === 200 ? 'passing' : 'failing'}`)
      })
      .catch(() => log('run failed'))
  }
  tick()
  setInterval(tick, THRESHOLDS.intervalMs)
}

if (import.meta.main) {
  start()
}
