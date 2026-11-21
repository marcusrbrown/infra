import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {AppCollection} from '../../status/collect'
import type {RemoteDeps, RemoteResult, SpawnFn} from './remote'

import {z} from 'zod'

import {servicesFact} from '../../status/collect'
import {resolveTracesHost} from './host'
import {DETAIL_SENTINEL, REMOTE_COMMANDS, runRemote, withRemoteSession} from './remote'

declare const process: {
  env: Record<string, string | undefined>
}

// ─── Compose state ────────────────────────────────────────────────────────────

interface ComposePsEntry {
  Name?: string
  Service?: string
  State: string
  Health: string
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'n-a'

export interface ServiceRow {
  service: string
  state: string
  health: HealthStatus
}

export interface TracesComposeResult {
  ok: boolean
  services: ServiceRow[]
  error?: string
}

function normalizeHealth(raw: string): HealthStatus {
  return raw === 'healthy' || raw === 'unhealthy' || raw === 'starting' ? raw : 'n-a'
}

/** `docker compose ps --format json`: one JSON array (old compose) or one object per line (current). */
export function parseComposePsOutput(stdoutText: string): ComposePsEntry[] {
  const trimmed = stdoutText.trim()
  if (trimmed.length === 0) return []
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as ComposePsEntry[]) : []
  }
  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as ComposePsEntry)
}

export function parseComposePs(entries: ComposePsEntry[]): ServiceRow[] {
  return entries.map(entry => ({
    service: entry.Service ?? entry.Name ?? 'unknown',
    state: entry.State,
    health: normalizeHealth(entry.Health),
  }))
}

export function isAllRunning(rows: ServiceRow[]): boolean {
  return rows.every(row => row.state === 'running' && (row.health === 'healthy' || row.health === 'n-a'))
}

export async function getTracesComposeStatus(
  host: string,
  remote: RemoteDeps = {},
  signal?: AbortSignal,
): Promise<TracesComposeResult> {
  const result = await runRemote(host, REMOTE_COMMANDS.composePs, {...remote, signal})

  if (result.exitCode !== 0) {
    return {
      ok: false,
      services: [],
      error: `SSH command failed (exit ${result.exitCode}): ${result.stderr || 'unknown error'}`,
    }
  }

  let entries: ComposePsEntry[]
  try {
    entries = parseComposePsOutput(result.stdout)
  } catch {
    return {ok: false, services: [], error: 'Failed to parse docker compose ps output'}
  }

  const services = parseComposePs(entries)
  return {ok: services.length > 0 && isAllRunning(services), services}
}

// ─── The reporter's detail ────────────────────────────────────────────────────

const detailSchema = z.object({
  schemaVersion: z.literal(1),
  generatedAt: z.string(),
  intervalMs: z.number(),
  ran: z.boolean(),
  stale: z.boolean(),
  ok: z.boolean(),
  at: z.string().nullable(),
  checks: z.array(
    z.object({
      id: z.string(),
      status: z.enum(['pass', 'warn', 'fail', 'unknown']),
      detail: z.string(),
    }),
  ),
})

export type ReporterDetail = z.infer<typeof detailSchema>

export type DetailOutcome = {ok: true; detail: ReporterDetail} | {ok: false; reason: 'ssh-failed' | 'unreadable'}

/**
 * Read the reporter's answer out of the remote output. It needs exit 0, the sentinel line that proves the
 * command ran to its end, and a body that matches the schema. Anything else is a failure to read, never a
 * passing verdict.
 */
export function parseDetailOutput(result: RemoteResult): DetailOutcome {
  if (result.exitCode !== 0) return {ok: false, reason: 'ssh-failed'}

  const lines = result.stdout.split('\n')
  const end = lines.findIndex(line => line.trim() === DETAIL_SENTINEL)
  if (end === -1) return {ok: false, reason: 'unreadable'}

  let json: unknown
  try {
    json = JSON.parse(lines.slice(0, end).join('\n'))
  } catch {
    return {ok: false, reason: 'unreadable'}
  }

  const parsed = detailSchema.safeParse(json)
  return parsed.success ? {ok: true, detail: parsed.data} : {ok: false, reason: 'unreadable'}
}

export async function getReporterDetail(
  host: string,
  remote: RemoteDeps = {},
  signal?: AbortSignal,
): Promise<DetailOutcome> {
  const result = await runRemote(host, REMOTE_COMMANDS.reporterDetail, {...remote, signal})
  return parseDetailOutput(result)
}

/** True only for a verdict that ran, is fresh and passed. Everything else, including a stale pass, is not passing. */
export function isPassing(detail: ReporterDetail): boolean {
  return detail.ran && !detail.stale && detail.ok
}

/** The checks that keep a verdict from passing, as `id: detail` lines. */
export function failingLines(detail: ReporterDetail): string[] {
  const lines = detail.checks
    .filter(entry => entry.status === 'fail' || entry.status === 'unknown')
    .map(entry => `${entry.id}: ${entry.detail}`)
  if (!detail.ran) lines.push('the reporter has not finished a run yet')
  else if (detail.stale) lines.push('the last run is older than two intervals')
  return lines
}

// ─── Unified status aggregator export ────────────────────────────────────────

/** The compose state and the reporter's verdict, read side by side over one connection. */
function readBoth(
  host: string,
  spawn: SpawnFn | undefined,
  signal?: AbortSignal,
): Promise<[TracesComposeResult, DetailOutcome]> {
  return withRemoteSession(spawn, session =>
    Promise.all([
      getTracesComposeStatus(host, {spawn, session}, signal),
      getReporterDetail(host, {spawn, session}, signal),
    ]),
  )
}

/**
 * Facts for the unified `status` command: the compose services and a summary of the reporter's verdict.
 * The public observations for this app (the `/healthz` probe and the deploy state) come from the shared
 * probe and the GitHub reader; this collector adds what only SSH can see and declares no observation, so the
 * public status history never carries container or check detail.
 */
export async function getTracesStatusSummary(
  host: string,
  spawn?: SpawnFn,
  signal?: AbortSignal,
): Promise<AppCollection> {
  const [compose, detail] = await readBoth(host, spawn, signal)

  return {
    observations: [],
    facts: {
      services: servicesFact(compose.services),
      health: detail.ok
        ? {
            ok: isPassing(detail.detail),
            stale: detail.detail.stale,
            at: detail.detail.at,
            failing: detail.detail.checks
              .filter(entry => entry.status === 'fail' || entry.status === 'unknown')
              .map(entry => entry.id),
          }
        : {ok: false, unreadable: true},
    },
  }
}

// ─── Action (exported for direct testing) ────────────────────────────────────

export async function tracesStatusAction(
  options: {key?: string | undefined; json?: boolean | undefined},
  ctx: ActionCtx,
  spawn?: SpawnFn,
): Promise<void> {
  const json = options.json === true

  let host: string
  try {
    host = resolveTracesHost(process.env, options.key)
  } catch (error) {
    ctx.console.error(error instanceof Error ? error.message : String(error))
    ctx.process.exit(1)
    return
  }

  // The connection is closed when the reads are done; the exits below come after it, because an exit skips clean-up.
  const [compose, detail] = await readBoth(host, spawn)

  if (compose.services.length === 0 && !detail.ok) {
    ctx.console.error(`Error: ${compose.error ?? 'No services reported by docker compose ps'}`)
    ctx.process.exit(1)
    return
  }

  const passing = detail.ok && isPassing(detail.detail)
  const allOk = compose.ok && passing

  if (json) {
    ctx.console.log(JSON.stringify({ok: allOk, services: compose.services, health: detail.ok ? detail.detail : null}))
    if (!allOk) ctx.process.exit(1)
    return
  }

  ctx.console.log('Traces status')
  ctx.console.log('')
  ctx.console.log('Service          State      Health')
  ctx.console.log('─────────────────────────────────────')
  for (const row of compose.services) {
    ctx.console.log(`${row.service.padEnd(16)} ${row.state.padEnd(10)} ${row.health}`)
  }
  ctx.console.log('')

  if (detail.ok) {
    ctx.console.log(`Health verdict: ${passing ? 'PASSING' : 'FAILING'} (last run ${detail.detail.at ?? 'never'})`)
    ctx.console.log('Check                  Status   Detail')
    ctx.console.log('───────────────────────────────────────────────────────────')
    for (const entry of detail.detail.checks) {
      ctx.console.log(`${entry.id.padEnd(22)} ${entry.status.padEnd(8)} ${entry.detail}`)
    }
    if (!passing) {
      for (const line of failingLines(detail.detail)) ctx.console.error(`not passing: ${line}`)
    }
  } else {
    ctx.console.log(
      `Health verdict: UNKNOWN (reporter ${detail.reason === 'ssh-failed' ? 'could not be reached' : 'answered something unreadable'})`,
    )
  }

  ctx.console.log('')
  if (allOk) {
    ctx.console.log('Status: OK')
  } else {
    ctx.console.log('Status: DEGRADED (a service is not running, or the health verdict is not passing)')
    ctx.process.exit(1)
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerTracesStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces status',
      'Show operational health of the trace stack: compose service states and the health reporter verdict, read over SSH.',
    )
    .option(
      '--key [key]',
      z
        .string()
        .optional()
        .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.'),
    )
    .option('--json', z.boolean().describe('Output one JSON object with ok, services and the reporter detail.'))
    .action((options, ctx) => tracesStatusAction(options, ctx))
}
