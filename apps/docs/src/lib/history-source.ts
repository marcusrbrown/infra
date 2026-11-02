import type {History, HistorySample} from '@marcusrbrown/infra-shared/status/history-schema'

import {existsSync, readdirSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {APP_IDS, historyAppFileSchema, historyMetaSchema} from '@marcusrbrown/infra-shared/status/history-schema'

export type HistorySourceKind = 'fixture' | 'artifact'

export interface LoadedHistory {
  history: History
  source: HistorySourceKind
}

/** Thrown with a message an operator can act on. The build must fail rather than render empty status. */
export class StatusHistoryError extends Error {
  constructor(message: string) {
    super(`Status history: ${message}`)
    this.name = 'StatusHistoryError'
  }
}

function readJson(path: string, what: string): unknown {
  if (!existsSync(path)) throw new StatusHistoryError(`${what} is missing (${path})`)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new StatusHistoryError(`${what} is not valid JSON (${path})`)
  }
}

/** Read and validate a history directory (`meta.json` plus `apps/<app>.json`) with the shared schemas. */
export function readHistoryDir(dir: string): History {
  const rawMeta = readJson(join(dir, 'meta.json'), 'meta.json')
  if (typeof rawMeta === 'object' && rawMeta !== null && 'schemaVersion' in rawMeta && rawMeta.schemaVersion !== 1) {
    throw new StatusHistoryError('unsupported schemaVersion in meta.json')
  }
  const meta = historyMetaSchema.safeParse(rawMeta)
  if (!meta.success) throw new StatusHistoryError('meta.json does not match the history schema')

  const appsDir = join(dir, 'apps')
  if (!existsSync(appsDir)) throw new StatusHistoryError(`apps/ directory is missing (${appsDir})`)
  const known = new Set<string>(APP_IDS.map(app => `${app}.json`))
  for (const entry of readdirSync(appsDir)) {
    if (!known.has(entry)) throw new StatusHistoryError(`unexpected file apps/${entry}`)
  }

  const apps = {} as Record<(typeof APP_IDS)[number], HistorySample[]>
  let total = 0
  for (const app of APP_IDS) {
    const parsed = historyAppFileSchema.safeParse(readJson(join(appsDir, `${app}.json`), `apps/${app}.json`))
    if (!parsed.success) throw new StatusHistoryError(`apps/${app}.json does not match the history schema`)
    const keys = new Set(parsed.data.map(sample => `${sample.run}:${sample.att}`))
    if (keys.size !== parsed.data.length)
      throw new StatusHistoryError(`apps/${app}.json holds a duplicate run and attempt`)
    apps[app] = parsed.data
    total += parsed.data.length
  }
  if (total === 0) throw new StatusHistoryError('history holds no samples')

  return {meta: meta.data, apps}
}

/**
 * The artifact directory from `STATUS_HISTORY_DIR`, or undefined for a fixture build. With
 * `STATUS_HISTORY_REQUIRED=1` an unset directory throws, so a publishing build can never fall back to the fixture.
 */
export function historyDirFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const dir = env.STATUS_HISTORY_DIR
  if (dir !== undefined && dir !== '') return dir
  if (env.STATUS_HISTORY_REQUIRED === '1') {
    throw new StatusHistoryError('STATUS_HISTORY_REQUIRED is set but STATUS_HISTORY_DIR is not; refusing the fixture')
  }
  return undefined
}

/**
 * `STATUS_HISTORY_DIR` selects the real artifact. Without it the committed fixture is used, so a PR build never
 * depends on an artifact being reachable. Either way an invalid history throws.
 */
export function loadStatusHistory(
  env: Record<string, string | undefined> = process.env,
  cwd: string = process.cwd(),
): LoadedHistory {
  const dir = historyDirFromEnv(env)
  if (dir !== undefined) return {history: readHistoryDir(resolve(cwd, dir)), source: 'artifact'}
  return {history: readHistoryDir(resolve(cwd, 'fixtures/history')), source: 'fixture'}
}
