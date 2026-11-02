import type {AppId, Observation, ObservationResult} from './observation'
import {randomUUID} from 'node:crypto'
import {mkdir, readdir, readFile, rename, rm, stat, writeFile} from 'node:fs/promises'
import {join} from 'node:path'

import {z} from 'zod'
import {APP_IDS, observationDetailSchema} from './observation'

/**
 * The 90-day public status history: `meta.json` plus one `apps/<app>.json` list per app.
 *
 * A sample is compact on purpose (the whole history stays under the cap at 48 samples a day):
 * `{t, run, att, r: {<obsId>: 'p'|'f'|'u'|'n'}, d?: {<obsId>: <bounded detail>}}`. Gaps and availability are
 * computed at render time, not stored.
 *
 * Merging enforces the invariants below. A violation throws a `HistoryError` before anything is written, so
 * published history can only grow within the window, never shrink or go blank:
 * - no sample inside the window is dropped
 * - the newest sample time never moves backwards (a stale read looks like this)
 * - duplicates are dropped, keyed on run id and attempt
 * - app ids are known
 * - no sample is dated more than 5 minutes after `now`
 * - the whole history stays under 10 MB uncompressed
 */

export const HISTORY_SCHEMA_VERSION = 1 as const
export const HISTORY_WINDOW_DAYS = 90
export const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60_000
export const HISTORY_MAX_BYTES = 10 * 1024 * 1024
export const MAX_FUTURE_SKEW_MS = 5 * 60_000
/** Most observations one sample can carry; the largest app declares four. */
const MAX_OBSERVATIONS_PER_SAMPLE = 32

const MESSAGES = {
  'missing-history': 'history not found; pass --bootstrap to create it',
  'history-exists': 'history already exists; refusing to bootstrap over it',
  'unsupported-schema': 'unsupported history schemaVersion',
  malformed: 'history is malformed',
  'unknown-app': 'history holds an unknown app',
  'duplicate-sample': 'history holds a duplicate run and attempt',
  'future-sample': 'a sample is dated more than 5 minutes in the future',
  'sample-dropped': 'merge would drop a sample inside the 90-day window',
  'newest-regressed': 'newest sample time would move backwards',
  'too-large': 'history exceeds the 10 MB cap',
  'invalid-sample': 'snapshot sample is invalid',
  'invalid-run': 'GITHUB_RUN_ID or GITHUB_RUN_ATTEMPT is invalid',
  'invalid-now': '--now must be a UTC ISO timestamp',
} as const

export type HistoryErrorCode = keyof typeof MESSAGES

/** Messages are fixed text plus an app id: never a path, URL, host or underlying error text. */
export class HistoryError extends Error {
  readonly code: HistoryErrorCode
  readonly app: string | undefined

  constructor(code: HistoryErrorCode, app?: string) {
    super(app === undefined ? MESSAGES[code] : `${MESSAGES[code]} (${app})`)
    this.name = 'HistoryError'
    this.code = code
    this.app = app
  }
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const RESULT_CODES = {pass: 'p', fail: 'f', unknown: 'u', not_measured: 'n'} as const satisfies Record<
  ObservationResult,
  string
>
const resultCodeSchema = z.enum(['p', 'f', 'u', 'n'])
export type ResultCode = z.infer<typeof resultCodeSchema>

const observationIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)

/** The detail keys a public sample may carry; `durationMs` is noise and stays out. */
const SAMPLE_DETAIL_KEYS = ['statusCode', 'reason', 'contractVersion', 'since', 'probeAt'] as const
const sampleDetailSchema = observationDetailSchema.pick({
  statusCode: true,
  reason: true,
  contractVersion: true,
  since: true,
  probeAt: true,
})
export type SampleDetail = z.infer<typeof sampleDetailSchema>

export const historySampleSchema = z
  .strictObject({
    /** When the snapshot ran. */
    t: z.iso.datetime(),
    /** `GITHUB_RUN_ID`, or `local-<ISO time>` for a run outside Actions (bare `local` is the legacy form). */
    run: z.string().regex(/^(?:\d{1,20}|local(?:-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)$/),
    /** `GITHUB_RUN_ATTEMPT`. */
    att: z.number().int().min(1).max(10_000),
    r: z.record(observationIdSchema, resultCodeSchema),
    d: z.record(observationIdSchema, sampleDetailSchema).optional(),
  })
  .refine(sample => {
    const count = Object.keys(sample.r).length
    return count >= 1 && count <= MAX_OBSERVATIONS_PER_SAMPLE
  }, 'r must hold 1 to 32 results')
  .refine(sample => Object.keys(sample.d ?? {}).every(id => id in sample.r), 'd may only describe ids present in r')

export type HistorySample = z.infer<typeof historySampleSchema>

export const historyMetaSchema = z.strictObject({
  schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
  lastSampleAt: z.iso.datetime(),
})

export type HistoryMeta = z.infer<typeof historyMetaSchema>

export const historyAppFileSchema = z.array(historySampleSchema)

export interface History {
  meta: HistoryMeta
  apps: Record<AppId, HistorySample[]>
}

export interface RunIdentity {
  run: string
  att: number
}

/** A record with one entry per known app, in `APP_IDS` order. */
export function recordByApp<T>(build: (app: AppId) => T): Record<AppId, T> {
  return {
    keeweb: build('keeweb'),
    cliproxy: build('cliproxy'),
    gateway: build('gateway'),
    umami: build('umami'),
    dashboard: build('dashboard'),
    vpn: build('vpn'),
    broker: build('broker'),
  }
}

// ─── Building a sample ────────────────────────────────────────────────────────

function pickDetail(detail: Observation['detail']): SampleDetail | undefined {
  if (detail === undefined) return undefined

  const picked = Object.fromEntries(
    SAMPLE_DETAIL_KEYS.flatMap(key => (detail[key] === undefined ? [] : [[key, detail[key]] as const])),
  )
  if (Object.keys(picked).length === 0) return undefined

  const parsed = sampleDetailSchema.safeParse(picked)
  if (!parsed.success) throw new HistoryError('invalid-sample')
  return parsed.data
}

/** One app's observations as a compact sample. Only allowlisted detail keys pass through. */
export function compactSample(observations: readonly Observation[], identity: RunIdentity, now: Date): HistorySample {
  const r: Record<string, ResultCode> = {}
  const d: Record<string, SampleDetail> = {}
  for (const observation of observations) {
    r[observation.id] = RESULT_CODES[observation.result]
    const detail = pickDetail(observation.detail)
    if (detail !== undefined) d[observation.id] = detail
  }

  const parsed = historySampleSchema.safeParse({
    t: now.toISOString(),
    run: identity.run,
    att: identity.att,
    r,
    ...(Object.keys(d).length === 0 ? {} : {d}),
  })
  if (!parsed.success) throw new HistoryError('invalid-sample')
  return parsed.data
}

// ─── Serialization ────────────────────────────────────────────────────────────

export interface SerializedFile {
  /** Relative to the history directory. */
  path: string
  content: string
}

/** Compact JSON, app files first and `meta.json` last, with the total uncompressed size. */
export function serializeHistory(history: History): {files: SerializedFile[]; bytes: number} {
  const files: SerializedFile[] = [
    ...APP_IDS.map(app => ({path: `apps/${app}.json`, content: JSON.stringify(history.apps[app])})),
    {path: 'meta.json', content: JSON.stringify(history.meta)},
  ]
  const encoder = new TextEncoder()
  return {files, bytes: files.reduce((total, file) => total + encoder.encode(file.content).length, 0)}
}

// ─── Invariants and merge ─────────────────────────────────────────────────────

const sampleKey = (sample: HistorySample): string => `${sample.run}:${sample.att}`
const sampleTime = (sample: HistorySample): number => Date.parse(sample.t)

const KNOWN_APPS: readonly string[] = APP_IDS

function isAppId(value: string): value is AppId {
  return KNOWN_APPS.includes(value)
}

export interface InvariantInput {
  /** The history that was read, or undefined for a bootstrap. */
  previous: History | undefined
  next: History
  now: Date
  /** Overrides the 10 MB cap; tests use it to pin the boundary. */
  maxBytes?: number
}

/** Throws a `HistoryError` for the first violated invariant. Independent of how `next` was computed. */
export function assertHistoryInvariants({previous, next, now, maxBytes = HISTORY_MAX_BYTES}: InvariantInput): void {
  const nowMs = now.getTime()
  const cutoff = nowMs - HISTORY_WINDOW_MS
  const futureLimit = nowMs + MAX_FUTURE_SKEW_MS

  for (const app of Object.keys(next.apps)) {
    if (!isAppId(app)) throw new HistoryError('unknown-app')
  }
  if (Date.parse(next.meta.lastSampleAt) > futureLimit) throw new HistoryError('future-sample')

  let newest = Number.NEGATIVE_INFINITY
  for (const app of APP_IDS) {
    const keys = new Set<string>()
    for (const sample of next.apps[app]) {
      if (sampleTime(sample) > futureLimit) throw new HistoryError('future-sample', app)
      const key = sampleKey(sample)
      if (keys.has(key)) throw new HistoryError('duplicate-sample', app)
      keys.add(key)
      newest = Math.max(newest, sampleTime(sample))
    }

    const before = previous?.apps[app] ?? []
    const insideWindow = before.filter(sample => sampleTime(sample) >= cutoff)
    const outsideWindow = before.length - insideWindow.length
    if (
      next.apps[app].length < before.length - outsideWindow ||
      insideWindow.some(sample => !keys.has(sampleKey(sample)))
    ) {
      throw new HistoryError('sample-dropped', app)
    }
  }

  if (previous !== undefined) {
    // A previous newest that has aged out of the window cannot be regressed from: trimming removed it.
    const floor = Date.parse(previous.meta.lastSampleAt)
    if (floor >= cutoff && (newest < floor || Date.parse(next.meta.lastSampleAt) < floor)) {
      throw new HistoryError('newest-regressed')
    }
  }

  if (serializeHistory(next).bytes > maxBytes) throw new HistoryError('too-large')
}

export interface MergeResult {
  history: History
  /** Samples appended across all apps; 0 for a rerun of the same run and attempt. */
  added: number
  /** Samples removed for being older than the window. */
  trimmed: number
}

/**
 * Append one sample per app (dropping any whose run and attempt are already present), trim to the 90-day
 * window using the single `now`, and verify the invariants against the history that was read.
 */
export function mergeHistory(input: {
  previous: History | undefined
  incoming: Record<AppId, HistorySample>
  now: Date
  maxBytes?: number
}): MergeResult {
  const {previous, incoming, now} = input
  const cutoff = now.getTime() - HISTORY_WINDOW_MS

  let added = 0
  let trimmed = 0
  let newest: HistorySample | undefined
  const apps = {} as Record<AppId, HistorySample[]>

  for (const app of APP_IDS) {
    const existing = previous?.apps[app] ?? []
    const known = new Set(existing.map(sampleKey))
    const fresh = incoming[app]
    const appended = known.has(sampleKey(fresh)) ? [] : [fresh]
    const candidates = [...existing, ...appended]
    const kept = candidates.filter(sample => sampleTime(sample) >= cutoff).sort((a, b) => sampleTime(a) - sampleTime(b))

    added += appended.length
    trimmed += candidates.length - kept.length
    apps[app] = kept
    for (const sample of kept) {
      if (newest === undefined || sampleTime(sample) > sampleTime(newest)) newest = sample
    }
  }

  const history: History = {
    meta: {schemaVersion: HISTORY_SCHEMA_VERSION, lastSampleAt: newest?.t ?? now.toISOString()},
    apps,
  }
  assertHistoryInvariants({
    previous,
    next: history,
    now,
    ...(input.maxBytes === undefined ? {} : {maxBytes: input.maxBytes}),
  })

  return {history, added, trimmed}
}

// ─── Disk ─────────────────────────────────────────────────────────────────────

function isNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch (error) {
    if (isNotFound(error)) return false
    throw error
  }
}

async function readBounded(path: string, budget: {remaining: number}, app?: string): Promise<string> {
  let size: number
  try {
    size = (await stat(path)).size
  } catch (error) {
    if (isNotFound(error)) throw new HistoryError('malformed', app)
    throw error
  }
  budget.remaining -= size
  if (budget.remaining < 0) throw new HistoryError('too-large')
  return readFile(path, 'utf8')
}

function parseJson(text: string, app?: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new HistoryError('malformed', app)
  }
}

export type LoadMode = 'existing' | 'bootstrap'

/**
 * `existing`: read and validate the history; a missing `meta.json` is an error (scheduled runs never create
 * history). `bootstrap`: require that no history exists and return `undefined`.
 */
export async function loadHistory(
  dir: string,
  mode: LoadMode,
  options: {maxBytes?: number} = {},
): Promise<History | undefined> {
  const metaPath = join(dir, 'meta.json')
  const appsDir = join(dir, 'apps')
  const hasMeta = await pathExists(metaPath)

  if (mode === 'bootstrap') {
    const hasApps = (await pathExists(appsDir)) && (await readdir(appsDir)).length > 0
    if (hasMeta || hasApps) throw new HistoryError('history-exists')
    return undefined
  }
  if (!hasMeta) throw new HistoryError('missing-history')

  const budget = {remaining: options.maxBytes ?? HISTORY_MAX_BYTES}
  const rawMeta = parseJson(await readBounded(metaPath, budget))
  if (typeof rawMeta === 'object' && rawMeta !== null && 'schemaVersion' in rawMeta && rawMeta.schemaVersion !== 1) {
    throw new HistoryError('unsupported-schema')
  }
  const meta = historyMetaSchema.safeParse(rawMeta)
  if (!meta.success) throw new HistoryError('malformed')

  let entries: string[]
  try {
    entries = await readdir(appsDir)
  } catch (error) {
    if (isNotFound(error)) throw new HistoryError('malformed')
    throw error
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json') || !isAppId(entry.slice(0, -'.json'.length))) throw new HistoryError('unknown-app')
  }

  const apps = {} as Record<AppId, HistorySample[]>
  for (const app of APP_IDS) {
    const parsed = historyAppFileSchema.safeParse(
      parseJson(await readBounded(join(appsDir, `${app}.json`), budget, app), app),
    )
    if (!parsed.success) throw new HistoryError('malformed', app)
    const keys = new Set(parsed.data.map(sampleKey))
    if (keys.size !== parsed.data.length) throw new HistoryError('duplicate-sample', app)
    apps[app] = parsed.data
  }

  return {meta: meta.data, apps}
}

/**
 * Write every file to a temp name first, then rename into place (app files first, `meta.json` last). Any
 * failure while staging removes the temp files and leaves the existing history as it was.
 */
export async function writeHistory(dir: string, history: History): Promise<void> {
  const {files} = serializeHistory(history)
  const staged: {temp: string; final: string}[] = []

  try {
    await mkdir(join(dir, 'apps'), {recursive: true})
    for (const file of files) {
      const final = join(dir, file.path)
      const temp = `${final}.${randomUUID()}.tmp`
      staged.push({temp, final})
      await writeFile(temp, file.content, {flag: 'wx'})
    }
    for (const {temp, final} of staged) await rename(temp, final)
  } catch (error) {
    await Promise.all(staged.map(({temp}) => rm(temp, {force: true})))
    throw error
  }
}
