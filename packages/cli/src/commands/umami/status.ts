import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {StatusSummary} from '../status'

import {z} from 'zod'

import {validateUmamiHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const COMPOSE_PROJECT_DIR = '/opt/umami'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ComposePsEntry {
  Name: string
  State: string
  Health: string
}

export type HealthStatus = 'healthy' | 'unhealthy' | 'starting' | 'n-a'

export interface ServiceRow {
  service: string
  state: string
  health: HealthStatus
}

export interface UmamiStatusResult {
  ok: boolean
  services: ServiceRow[]
  error?: string
}

export type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

export function parseComposePsOutput(stdoutText: string): ComposePsEntry[] {
  const trimmed = stdoutText.trim()
  if (trimmed.length === 0) return []

  // Legacy compose may emit a single JSON array; current versions emit NDJSON.
  if (trimmed.startsWith('[')) {
    const parsed: unknown = JSON.parse(trimmed)
    return Array.isArray(parsed) ? (parsed as ComposePsEntry[]) : []
  }

  // NDJSON: one JSON object per non-empty line.
  return trimmed
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0)
    .map(line => JSON.parse(line) as ComposePsEntry)
}

function normalizeHealth(raw: string): HealthStatus {
  if (raw === 'healthy' || raw === 'unhealthy' || raw === 'starting') {
    return raw
  }

  return 'n-a'
}

export function parseComposePs(entries: ComposePsEntry[]): ServiceRow[] {
  return entries.map(entry => ({
    service: entry.Name,
    state: entry.State,
    health: normalizeHealth(entry.Health),
  }))
}

export function isAllRunning(rows: ServiceRow[]): boolean {
  return rows.every(row => row.state === 'running' && (row.health === 'healthy' || row.health === 'n-a'))
}

// ─── SSH-backed status fetch ──────────────────────────────────────────────────

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
): ReturnType<SpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<SpawnFn>
}

export async function getUmamiComposeStatus(host: string, spawn: SpawnFn = defaultSpawn): Promise<UmamiStatusResult> {
  validateUmamiHost(host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    `root@${host}`,
    `docker compose --project-directory ${COMPOSE_PROJECT_DIR} ps --format json`,
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode !== 0) {
    return {
      ok: false,
      services: [],
      error: `SSH command failed (exit ${exitCode}): ${stderrText.trim() || 'unknown error'}`,
    }
  }

  let entries: ComposePsEntry[]

  try {
    entries = parseComposePsOutput(stdoutText)
  } catch {
    return {ok: false, services: [], error: `Failed to parse docker compose ps output: ${stdoutText.slice(0, 200)}`}
  }

  const services = parseComposePs(entries)
  const ok = isAllRunning(services)

  return {ok, services}
}

// ─── Unified status aggregator export ────────────────────────────────────────

export async function getUmamiStatusSummary(host: string, spawn?: SpawnFn): Promise<StatusSummary> {
  let result: UmamiStatusResult

  try {
    result = await getUmamiComposeStatus(host, spawn)
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error)
    return {
      app: 'umami',
      http: `ERROR: ${errorMsg}`,
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  // Three-way split: no services → ERROR, services present but degraded → DEGRADED, all healthy → OK
  if (result.services.length === 0) {
    const errorMsg = result.error ?? 'No services reported'
    return {
      app: 'umami',
      http: `ERROR: ${errorMsg}`,
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  const rows = result.services.map(s => `${s.service}:${s.state}/${s.health}`).join(', ')

  if (!result.ok) {
    return {
      app: 'umami',
      http: `DEGRADED: ${rows}`,
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  return {
    app: 'umami',
    http: `OK: ${rows}`,
    lastDeploy: '—',
    version: '—',
    contentHash: '—',
    usageStats: '—',
  }
}

// ─── Action (exported for direct testing) ────────────────────────────────────

export async function umamiStatusAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  spawn?: SpawnFn,
): Promise<void> {
  const hostEnvKey = options.key ?? 'UMAMI_DOMAIN'
  const host = process.env[hostEnvKey]

  if (!host) {
    ctx.console.error('Umami host not set. Export UMAMI_DOMAIN or pass --key <env-name> pointing to a set variable.')
    ctx.process.exit(1)
    return
  }

  ctx.console.log('Umami status')
  ctx.console.log('')

  let result: UmamiStatusResult

  try {
    result = await getUmamiComposeStatus(host, spawn)
  } catch (error) {
    ctx.console.error(`Error: ${error instanceof Error ? error.message : String(error)}`)
    ctx.process.exit(1)
    return
  }

  if (result.services.length === 0) {
    ctx.console.error(`Error: No services reported by docker compose ps`)
    ctx.process.exit(1)
    return
  }

  ctx.console.log('Service          State      Health')
  ctx.console.log('─────────────────────────────────────')

  for (const row of result.services) {
    const svc = row.service.padEnd(16)
    const state = row.state.padEnd(10)
    ctx.console.log(`${svc} ${state} ${row.health}`)
  }

  ctx.console.log('')

  if (result.ok) {
    ctx.console.log('Status: OK')
  } else {
    ctx.console.log('Status: DEGRADED (one or more services not running)')
    ctx.process.exit(1)
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerUmamiStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('umami status', 'Show operational health of the Umami analytics deployment via docker compose ps.')
    .option(
      '--key [key]',
      z
        .string()
        .optional()
        .describe('Environment variable name holding the SSH host. Falls back to UMAMI_DOMAIN when omitted.'),
    )
    .action((options, ctx) => umamiStatusAction(options, ctx))
}
