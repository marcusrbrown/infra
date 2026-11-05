import type {
  AppId,
  History,
  HistorySample,
  ResultCode,
  SampleDetail,
} from '@marcusrbrown/infra-shared/status/history-schema'

import {APP_IDS, HISTORY_WINDOW_MS, OBSERVATION_KINDS_BY_ID} from '@marcusrbrown/infra-shared/status/history-schema'

/**
 * Pure view model for the status pages: what the latest sample proves, how many samples passed, how much of
 * the window is covered, and where the gaps are. It never computes an uptime percentage: coverage is a count
 * of samples recorded against about how many a 30-minute cadence would have produced.
 */

/** Consecutive samples further apart than this leave a gap. Tuned against measured jitter after a week of data. */
export const GAP_THRESHOLD_MS = 45 * 60_000
/** The page warns when `generatedAt` is older than this. */
export const STALE_THRESHOLD_MS = 90 * 60_000
/** The snapshot cadence, used only to work out how many samples a window should hold. */
export const SAMPLE_INTERVAL_MS = 30 * 60_000

export type Result = 'pass' | 'fail' | 'unknown' | 'not_measured'

const RESULT_BY_CODE: Record<ResultCode, Result> = {p: 'pass', f: 'fail', u: 'unknown', n: 'not_measured'}
const SEVERITY: Record<Result, number> = {pass: 0, not_measured: 1, unknown: 2, fail: 3}

/**
 * The kinds the public snapshot can prove. Container health and resources need SSH, which the snapshot does not
 * use, so they are never published (CLI and dashboard only).
 */
export const PROOF_KINDS = ['reachability', 'deploy-state', 'end-to-end'] as const
export type ProofKind = (typeof PROOF_KINDS)[number]

export const PROOF_LABELS: Record<ProofKind, string> = {
  reachability: 'Reachability',
  'deploy-state': 'Deploy state',
  'end-to-end': 'End-to-end',
}

/** Symbol plus word, so a result never depends on colour. */
export const RESULT_DISPLAY: Record<Result, {symbol: string; word: string}> = {
  pass: {symbol: '✅', word: 'Pass'},
  fail: {symbol: '❌', word: 'Fail'},
  unknown: {symbol: '❓', word: 'Unknown'},
  not_measured: {symbol: '⚪', word: 'Not measured'},
}

/**
 * Apps whose snapshot can never show them fully healthy, however green the rest is. The gateway's model
 * calls are not probed; the VPN has no external probe at all.
 */
const CAVEATS: Partial<Record<AppId, string>> = {
  gateway: 'Reachable; model route not measured',
  vpn: 'Deploy state only; live health not measured',
}

export interface Counts {
  total: number
  passed: number
  failed: number
  unknown: number
  notMeasured: number
}

export interface ObservationView {
  id: string
  kind: ProofKind
  /** The proof label, for example "Reachability". */
  proof: string
  latest: Result
  detail: SampleDetail | undefined
  counts: Counts
}

export interface Gap {
  from: string
  to: string
  minutes: number
}

export interface Coverage {
  recorded: number
  expected: number
  windowStart: string
  windowEnd: string
}

export type DeployStateName = 'succeeded' | 'failed' | 'at_gate' | 'running' | 'none' | 'unknown' | 'not_measured'

export interface DeployView {
  state: DeployStateName
  /** Plain-words state, for example "Waiting at the approval gate". */
  label: string
  /** When the deployment reached this state; present for `at_gate` and the settled states. */
  since: string | undefined
}

export interface EndToEndView {
  result: Result
  measured: boolean
  probeAt: string | undefined
  /** Minutes between the probe and the sample that carried it. */
  probeAgeMinutes: number | undefined
  stale: boolean
}

export interface Cell {
  result: Result
  note: string | undefined
}

export type Verdict = 'fail' | 'unknown' | 'partial' | 'pass'

export interface AppView {
  app: AppId
  latestSampleAt: string | undefined
  observations: ObservationView[]
  cells: Record<ProofKind, Cell>
  coverage: Coverage
  gaps: Gap[]
  deploy: DeployView
  endToEnd: EndToEndView
  verdict: Verdict
  verdictLabel: string
  /** The latest contract version the app reported, when it reports one. */
  contractVersion: string | undefined
}

/**
 * Observations the history records but the site does not publish yet. The Go route is recorded for status and
 * history, but it is its own signal: it must not widen the Claude cell, verdict or stale flag, and Phase 1 shows no
 * Go row. The end-to-end view is therefore built from `provider-route` by id and nothing else in its kind.
 */
const UNPUBLISHED_IDS: ReadonlySet<string> = new Set(['provider-route-go'])

const sampleMs = (sample: HistorySample): number => Date.parse(sample.t)
const isProofKind = (kind: string): kind is ProofKind => (PROOF_KINDS as readonly string[]).includes(kind)

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`

export const passLabel = (counts: Counts): string =>
  `${counts.passed} of ${plural(counts.total, 'sample', 'samples')} passed`

/** The non-pass outcomes, kept apart: "1 failed, 2 unknown, 1 not measured". Empty when every sample passed. */
export function breakdownLabel(counts: Counts): string {
  return [
    counts.failed > 0 ? `${counts.failed} failed` : '',
    counts.unknown > 0 ? `${counts.unknown} unknown` : '',
    counts.notMeasured > 0 ? `${counts.notMeasured} not measured` : '',
  ]
    .filter(part => part !== '')
    .join(', ')
}

export const coverageLabel = (coverage: Coverage): string =>
  `${plural(coverage.recorded, 'sample', 'samples')} recorded of about ${coverage.expected} expected`

export const isStale = (lastSampleAt: string, now: Date): boolean =>
  now.getTime() - Date.parse(lastSampleAt) > STALE_THRESHOLD_MS

/** "2026-11-02 02:43 UTC": the no-JavaScript rendering of a timestamp. */
export const formatUtc = (iso: string): string => `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`

/** "5 minutes ago", "3 hours ago", "2 days ago". */
export function ageLabel(iso: string, now: Date): string {
  const minutes = Math.max(0, Math.round((now.getTime() - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${plural(minutes, 'minute', 'minutes')} ago`
  if (minutes < 48 * 60) return `${plural(Math.round(minutes / 60), 'hour', 'hours')} ago`
  return `${plural(Math.round(minutes / (24 * 60)), 'day', 'days')} ago`
}

function countResults(results: readonly Result[]): Counts {
  return {
    total: results.length,
    passed: results.filter(result => result === 'pass').length,
    failed: results.filter(result => result === 'fail').length,
    unknown: results.filter(result => result === 'unknown').length,
    notMeasured: results.filter(result => result === 'not_measured').length,
  }
}

function findGaps(samples: readonly HistorySample[]): Gap[] {
  const gaps: Gap[] = []
  for (let index = 1; index < samples.length; index += 1) {
    const previous = samples[index - 1]
    const current = samples[index]
    if (previous === undefined || current === undefined) continue
    const elapsed = sampleMs(current) - sampleMs(previous)
    if (elapsed > GAP_THRESHOLD_MS) gaps.push({from: previous.t, to: current.t, minutes: Math.round(elapsed / 60_000)})
  }
  return gaps
}

function deployView(observation: ObservationView | undefined): DeployView {
  const detail = observation?.detail
  const since = detail?.since
  switch (observation?.latest) {
    case 'pass':
      return {state: 'succeeded', label: 'Last deploy succeeded', since}
    case 'fail':
      return {state: 'failed', label: 'Last deploy failed', since}
    case 'unknown':
      if (detail?.reason === 'at_gate') return {state: 'at_gate', label: 'Waiting at the approval gate', since}
      if (detail?.reason === 'running') return {state: 'running', label: 'Deploy running', since}
      return {state: 'unknown', label: 'Deploy state unknown', since: undefined}
    case 'not_measured':
      if (detail?.reason === 'none') return {state: 'none', label: 'No deployment recorded', since: undefined}
      return {state: 'not_measured', label: 'Deploy state not measured', since: undefined}
    default:
      return {state: 'not_measured', label: 'Deploy state not measured', since: undefined}
  }
}

function endToEndView(observation: ObservationView | undefined, sampleAt: string | undefined): EndToEndView {
  const result = observation?.latest ?? 'not_measured'
  const probeAt = observation?.detail?.probeAt
  const probeAgeMinutes =
    probeAt === undefined || sampleAt === undefined
      ? undefined
      : Math.max(0, Math.round((Date.parse(sampleAt) - Date.parse(probeAt)) / 60_000))
  const stale =
    result !== 'not_measured' &&
    (observation?.detail?.reason === 'stale' ||
      (probeAgeMinutes !== undefined && probeAgeMinutes * 60_000 > GAP_THRESHOLD_MS))
  return {result, measured: result !== 'not_measured', probeAt, probeAgeMinutes, stale}
}

function cellFor(
  kind: ProofKind,
  observations: readonly ObservationView[],
  deploy: DeployView,
  e2e: EndToEndView,
): Cell {
  const ofKind = observations.filter(observation => observation.kind === kind)
  let result: Result = 'not_measured'
  let first = true
  for (const observation of ofKind) {
    if (first || SEVERITY[observation.latest] > SEVERITY[result]) result = observation.latest
    first = false
  }

  if (
    kind === 'deploy-state' &&
    (deploy.state === 'at_gate' || deploy.state === 'running' || deploy.state === 'none')
  ) {
    return {
      result,
      note: deploy.state === 'at_gate' ? 'at approval gate' : deploy.state === 'running' ? 'running' : 'no deployment',
    }
  }
  if (kind === 'end-to-end' && e2e.stale) return {result, note: 'stale probe'}
  return {result, note: undefined}
}

function verdictFor(
  app: AppId,
  cells: Record<ProofKind, Cell>,
  deploy: DeployView,
  e2e: EndToEndView,
  hasSample: boolean,
): {verdict: Verdict; label: string} {
  if (!hasSample) return {verdict: 'unknown', label: 'No samples recorded'}

  const failing = PROOF_KINDS.filter(kind => cells[kind].result === 'fail')
  if (failing.length > 0)
    return {verdict: 'fail', label: `Failing: ${failing.map(kind => PROOF_LABELS[kind]).join(', ')}`}

  // A deploy waiting at the gate or running reads as `unknown` in the data, but it is progress, not a fault.
  const unknownKinds = PROOF_KINDS.filter(
    kind =>
      (cells[kind].result === 'unknown' &&
        !(kind === 'deploy-state' && (deploy.state === 'at_gate' || deploy.state === 'running'))) ||
      (kind === 'end-to-end' && e2e.stale),
  )
  if (unknownKinds.length > 0) {
    return {verdict: 'unknown', label: `Unknown: ${unknownKinds.map(kind => PROOF_LABELS[kind]).join(', ')}`}
  }

  const caveat = CAVEATS[app]
  if (caveat !== undefined) return {verdict: 'partial', label: caveat}
  if (cells.reachability.result !== 'pass') return {verdict: 'partial', label: 'Reachability not measured'}
  if (
    OBSERVATION_KINDS_BY_ID[app] !== undefined &&
    Object.values(OBSERVATION_KINDS_BY_ID[app]).includes('end-to-end') &&
    !e2e.measured
  ) {
    return {verdict: 'partial', label: 'Reachable; model route not measured'}
  }
  if (deploy.state === 'at_gate') return {verdict: 'partial', label: 'Reachable; deploy waiting at the approval gate'}
  if (deploy.state === 'running') return {verdict: 'partial', label: 'Reachable; deploy running'}
  if (deploy.state === 'none') return {verdict: 'partial', label: 'Reachable; no deployment recorded'}
  // Past this point only a recorded success may claim a deploy; anything else is honest about what is missing.
  if (deploy.state !== 'succeeded') return {verdict: 'partial', label: 'Reachable; deploy state not measured'}
  if (e2e.measured) return {verdict: 'pass', label: 'Reachable; last deploy succeeded; model route healthy'}
  return {verdict: 'pass', label: 'Reachable; last deploy succeeded'}
}

/** One app's view at `now`. Only samples inside the 90-day window count. */
export function buildAppView(app: AppId, samples: readonly HistorySample[], now: Date): AppView {
  const floor = now.getTime() - HISTORY_WINDOW_MS
  const inWindow = samples.filter(sample => sampleMs(sample) >= floor).toSorted((a, b) => sampleMs(a) - sampleMs(b))
  const latest = inWindow.at(-1)

  const observations: ObservationView[] = Object.entries(OBSERVATION_KINDS_BY_ID[app]).flatMap(([id, kind]) => {
    if (!isProofKind(kind) || UNPUBLISHED_IDS.has(id)) return []
    const carried = inWindow.filter(sample => id in sample.r)
    const latestCode = latest?.r[id]
    return [
      {
        id,
        kind,
        proof: PROOF_LABELS[kind],
        // Declared but absent from the newest sample (the snapshot never measures it): not measured.
        latest: latestCode === undefined ? 'not_measured' : RESULT_BY_CODE[latestCode],
        detail: latest?.d?.[id],
        counts: countResults(carried.map(sample => RESULT_BY_CODE[sample.r[id] ?? 'n'])),
      },
    ]
  })

  const deploy = deployView(observations.find(observation => observation.kind === 'deploy-state'))
  const endToEnd = endToEndView(
    observations.find(observation => observation.kind === 'end-to-end'),
    latest?.t,
  )
  const cells = Object.fromEntries(
    PROOF_KINDS.map(kind => [kind, cellFor(kind, observations, deploy, endToEnd)]),
  ) as Record<ProofKind, Cell>

  const first = inWindow[0]
  const windowStart = Math.max(first === undefined ? floor : sampleMs(first), floor)
  const windowEnd = Math.max(now.getTime(), windowStart)
  const {verdict, label} = verdictFor(app, cells, deploy, endToEnd, latest !== undefined)

  return {
    app,
    latestSampleAt: latest?.t,
    observations,
    cells,
    coverage: {
      recorded: inWindow.length,
      // The window opens on a sample, so it holds one more than the whole intervals that fit in it.
      expected: 1 + Math.round((windowEnd - windowStart) / SAMPLE_INTERVAL_MS),
      windowStart: new Date(windowStart).toISOString(),
      windowEnd: new Date(windowEnd).toISOString(),
    },
    gaps: findGaps(inWindow),
    deploy,
    endToEnd,
    verdict,
    verdictLabel: label,
    contractVersion: observations.find(observation => observation.detail?.contractVersion !== undefined)?.detail
      ?.contractVersion,
  }
}

export function buildHistoryView(history: History, now: Date): Record<AppId, AppView> {
  return Object.fromEntries(APP_IDS.map(app => [app, buildAppView(app, history.apps[app], now)])) as Record<
    AppId,
    AppView
  >
}

export const VERDICT_DISPLAY: Record<Verdict, {symbol: string; word: string}> = {
  pass: {symbol: '✅', word: 'Checks passed'},
  partial: {symbol: '⚠️', word: 'Partly measured'},
  unknown: {symbol: '❓', word: 'Unknown'},
  fail: {symbol: '❌', word: 'Failing'},
}

/** Bounded detail as short text: only the closed set of scalar fields a sample can carry. */
export function detailText(detail: SampleDetail | undefined): string {
  if (detail === undefined) return ''
  return [
    detail.statusCode === undefined ? '' : `HTTP ${detail.statusCode}`,
    detail.contractVersion === undefined ? '' : `contract ${detail.contractVersion}`,
    detail.reason === undefined ? '' : `reason: ${detail.reason}`,
    detail.since === undefined ? '' : `since ${formatUtc(detail.since)}`,
    detail.probeAt === undefined ? '' : `probe ran ${formatUtc(detail.probeAt)}`,
  ]
    .filter(part => part !== '')
    .join('; ')
}
