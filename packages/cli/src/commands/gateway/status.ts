import type {goke} from 'goke'
import type {StatusSummary} from '../status'

import {z} from 'zod'

import {validateGatewayHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const COMPOSE_PROJECT_DIR = '/opt/gateway/deploy'

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

export interface GatewayStatusResult {
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
    // Workspace has no upstream healthcheck in v1; health will upgrade automatically
    // when upstream adds one and docker compose ps starts reporting it.
    health: normalizeHealth(entry.Health),
  }))
}

export function isAllRunning(rows: ServiceRow[]): boolean {
  return rows.every(row => row.state === 'running')
}

// ─── SSH-backed status fetch ──────────────────────────────────────────────────

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
): ReturnType<SpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<SpawnFn>
}

export async function getGatewayComposeStatus(
  host: string,
  spawn: SpawnFn = defaultSpawn,
): Promise<GatewayStatusResult> {
  validateGatewayHost(host)

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

export async function getGatewayStatusSummary(host: string): Promise<StatusSummary> {
  const result = await getGatewayComposeStatus(host)

  if (!result.ok || result.services.length === 0) {
    const errorMsg = result.error ?? 'No services reported'
    return {
      app: 'gateway',
      http: `ERROR: ${errorMsg}`,
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  const rows = result.services.map(s => `${s.service}:${s.state}/${s.health}`).join(', ')

  return {
    app: 'gateway',
    http: `OK: ${rows}`,
    lastDeploy: '—',
    version: '—',
    contentHash: '—',
    usageStats: '—',
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerGatewayStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('gateway status', 'Show operational health of the gateway deployment via docker compose ps.')
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to GATEWAY_HOST when omitted.'),
    )
    .action(async options => {
      const hostEnvKey = options.key ?? 'GATEWAY_HOST'
      const host = process.env[hostEnvKey]

      if (!host) {
        console.error(`Gateway host not set. Export ${hostEnvKey} or pass --key <env-name> pointing to a set variable.`)
        process.exitCode = 1
        return
      }

      console.log('Gateway status')
      console.log('')

      const result = await getGatewayComposeStatus(host)

      if (!result.ok && result.services.length === 0) {
        console.error(`Error: ${result.error ?? 'Unknown error'}`)
        process.exitCode = 1
        return
      }

      console.log('Service          State      Health')
      console.log('─────────────────────────────────────')

      for (const row of result.services) {
        const svc = row.service.padEnd(16)
        const state = row.state.padEnd(10)
        console.log(`${svc} ${state} ${row.health}`)
      }

      console.log('')

      if (result.ok) {
        console.log('Status: OK')
      } else {
        console.log('Status: DEGRADED (one or more services not running)')
        process.exitCode = 1
      }
    })
}
