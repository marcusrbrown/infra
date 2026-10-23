import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {StatusSummary} from '../status'
import {z} from 'zod'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {redactHost} from '../../lib/redact'
import {buildIdentityArgs} from '../../lib/ssh-identity'
// ─── Minimal ctx interface (subset of GokeExecutionContext used by this action) ─
import {validateGatewayHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

const COMPOSE_PROJECT_DIR = '/opt/gateway/deploy'

const MIB = 1024 * 1024

/** One timeout bounds the whole extra workspace SSH call so a hung probe can't stall `gateway status`. */
export const WORKSPACE_PROBE_TIMEOUT_MS = 10_000

/**
 * The supervisor `/readyz` probe is skipped when the workspace is this close to its memory limit,
 * so the probe itself can't push the container into an OOM kill.
 */
export const READYZ_PROBE_HEADROOM_BYTES = 64 * MIB

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
  kill?: () => void
}

export const OPENCODE_STATES = ['starting', 'ready', 'down', 'degraded'] as const

export type OpencodeState = (typeof OPENCODE_STATES)[number] | 'unknown'

export interface WorkspaceMemoryReport {
  status: 'ok'
  /** `HostConfig.Memory` in bytes; 0 means no limit is set. */
  limitBytes: number
  currentBytes: number
  /** `max` from `memory.events`: times usage hit the limit. */
  maxEvents: number
  /** `oom_kill` from `memory.events`; the counter resets whenever the container is recreated or restarted. */
  oomKills: number
  oomKilled: boolean
  restartCount: number
  startedAt: string
  opencode: OpencodeState
}

export type WorkspaceMemoryStatus = WorkspaceMemoryReport | {status: 'unknown'; reason: string}

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

// ─── Workspace memory probe (pure helpers) ───────────────────────────────────

const SECTION_MARKERS = {
  id: '@@ws-id@@',
  inspect: '@@ws-inspect@@',
  cgroup: '@@ws-cgroup@@',
  readyz: '@@ws-readyz@@',
} as const

const READYZ_URL = 'http://127.0.0.1:9100/readyz'

/** Prints the body whatever the HTTP status: a 503 covers starting, degraded and down. */
export function buildReadyzProbeSnippet(url: string = READYZ_URL): string {
  return `fetch("${url}",{signal:AbortSignal.timeout(3000)}).then(r=>r.text()).then(t=>process.stdout.write(t)).catch(()=>{})`
}

/**
 * Single remote script printing delimited sections. The container is always addressed by the ID that
 * `docker compose ps -q workspace` resolves, never by a literal container name.
 */
export function buildWorkspaceProbeScript(): string {
  return [
    `id=$(docker compose --project-directory ${COMPOSE_PROJECT_DIR} ps -q workspace)`,
    `echo ${SECTION_MARKERS.id}`,
    'echo "$id"',
    `echo ${SECTION_MARKERS.inspect}`,
    `docker inspect --format '{{.HostConfig.Memory}} {{.State.OOMKilled}} {{.RestartCount}} {{.State.StartedAt}}' "$id"`,
    `echo ${SECTION_MARKERS.cgroup}`,
    'docker exec "$id" cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events',
    `echo ${SECTION_MARKERS.readyz}`,
    `limit=$(docker inspect --format '{{.HostConfig.Memory}}' "$id")`,
    'cur=$(docker exec "$id" cat /sys/fs/cgroup/memory.current)',
    // Fail closed: run the exec only when both reads are digit strings and headroom is strictly above the margin.
    'run=no',
    `case "$limit" in ''|*[!0-9]*) ;; *)`,
    `  case "$cur" in ''|*[!0-9]*) ;; *)`,
    `    if [ "$limit" -gt 0 ] && [ $(( limit - cur )) -gt ${READYZ_PROBE_HEADROOM_BYTES} ]; then run=yes; fi ;;`,
    '  esac ;;',
    'esac',
    'if [ "$run" = yes ]; then',
    `  docker exec "$id" node -e '${buildReadyzProbeSnippet()}'`,
    'fi',
    'exit 0',
  ].join('\n')
}

function splitSections(stdoutText: string): Map<string, string[]> | undefined {
  const markers = new Set<string>(Object.values(SECTION_MARKERS))
  const sections = new Map<string, string[]>()
  let current: string[] | undefined

  for (const line of stdoutText.split('\n')) {
    const trimmed = line.trim()
    if (markers.has(trimmed)) {
      if (sections.has(trimmed)) return undefined
      current = []
      sections.set(trimmed, current)
    } else if (current !== undefined) {
      current.push(trimmed)
    }
  }

  return sections
}

function parseCount(raw: string | undefined): number | undefined {
  if (raw === undefined || !/^\d+$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isSafeInteger(value) ? value : undefined
}

/** `undefined` means the body was present but not JSON; an empty body or unrecognised field is `unknown`. */
function parseOpencodeState(body: string): OpencodeState | undefined {
  if (body.length === 0) return 'unknown'

  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return undefined
  }

  if (typeof parsed !== 'object' || parsed === null || !('opencode' in parsed)) return 'unknown'

  return OPENCODE_STATES.find(state => state === parsed.opencode) ?? 'unknown'
}

const unknownWorkspace = (reason: string): WorkspaceMemoryStatus => ({status: 'unknown', reason})

/**
 * Fail-closed parser for the probe script's stdout. A missing or malformed section makes the whole block
 * `unknown`; only an empty or unrecognised supervisor body degrades just the `opencode` field.
 */
export function parseWorkspaceProbeOutput(stdoutText: string): WorkspaceMemoryStatus {
  const sections = splitSections(stdoutText)
  const idLines = sections?.get(SECTION_MARKERS.id)
  const inspectLines = sections?.get(SECTION_MARKERS.inspect)
  const cgroupLines = sections?.get(SECTION_MARKERS.cgroup)
  const readyzLines = sections?.get(SECTION_MARKERS.readyz)

  if (!idLines || !inspectLines || !cgroupLines || !readyzLines) return unknownWorkspace('incomplete probe output')

  const ids = idLines.filter(line => line.length > 0)
  if (ids.length !== 1 || !/^[\da-f]{12,64}$/i.test(ids[0] ?? '')) {
    return unknownWorkspace('workspace container not found')
  }

  const inspectFields = inspectLines
    .filter(line => line.length > 0)
    .join(' ')
    .split(/\s+/)
  const [memoryRaw, oomKilledRaw, restartRaw, startedAt] = inspectFields
  const limitBytes = parseCount(memoryRaw)
  const restartCount = parseCount(restartRaw)
  if (
    inspectFields.length !== 4 ||
    limitBytes === undefined ||
    restartCount === undefined ||
    (oomKilledRaw !== 'true' && oomKilledRaw !== 'false') ||
    startedAt === undefined ||
    !/^\d{4}-\d\d-\d\dT/.test(startedAt)
  ) {
    return unknownWorkspace('unparsable docker inspect output')
  }

  const cgroup = cgroupLines.filter(line => line.length > 0)
  const currentBytes = parseCount(cgroup[0])
  const events = new Map<string, string>()
  for (const line of cgroup.slice(1)) {
    const [key, value] = line.split(/\s+/)
    if (key !== undefined && value !== undefined) events.set(key, value)
  }
  const maxEvents = parseCount(events.get('max'))
  const oomKills = parseCount(events.get('oom_kill'))
  if (currentBytes === undefined || maxEvents === undefined || oomKills === undefined) {
    return unknownWorkspace('unparsable cgroup memory output')
  }

  // Re-check headroom here as well so a probe body from a near-limit container is never trusted.
  const probeAllowed = limitBytes > 0 && limitBytes - currentBytes > READYZ_PROBE_HEADROOM_BYTES
  const opencode = probeAllowed ? parseOpencodeState(readyzLines.join('').trim()) : 'unknown'
  if (opencode === undefined) return unknownWorkspace('unparsable readyz body')

  return {
    status: 'ok',
    limitBytes,
    currentBytes,
    maxEvents,
    oomKills,
    oomKilled: oomKilledRaw === 'true',
    restartCount,
    startedAt,
    opencode,
  }
}

const formatMiB = (bytes: number): string => `${Math.round(bytes / MIB)}`

/** Human-readable lines for `gateway status`. */
export function formatWorkspaceMemory(status: WorkspaceMemoryStatus): string[] {
  if (status.status === 'unknown') return [`Workspace memory: unknown (${status.reason})`]

  return [
    'Workspace memory',
    `  Limit:       ${status.limitBytes === 0 ? 'none' : `${formatMiB(status.limitBytes)} MiB`}`,
    `  Usage:       ${formatMiB(status.currentBytes)} MiB`,
    `  Max events:  ${status.maxEvents}`,
    `  OOM kills:   ${status.oomKills} (counted since the container last started)`,
    `  Restarts:    ${status.restartCount} (started ${status.startedAt})`,
    `  OOMKilled:   ${status.oomKilled}`,
    `  OpenCode:    ${status.opencode}`,
  ]
}

/** Tagged suffix for the unified status table; must not contain `|`, which is the table delimiter. */
export function formatWorkspaceSummary(status: WorkspaceMemoryStatus): string {
  if (status.status === 'unknown') return 'workspace=unknown'

  const mem =
    status.limitBytes === 0
      ? `mem=${formatMiB(status.currentBytes)}MiB limit=none`
      : `mem=${formatMiB(status.currentBytes)}/${formatMiB(status.limitBytes)}MiB`

  return `workspace ${mem} oom_kills=${status.oomKills} opencode=${status.opencode}`
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

  const knownHostsArgs = buildKnownHostsArgs()
  const {args: identityArgs, cleanup} = buildIdentityArgs(process.env.GATEWAY_SSH_KEY)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...knownHostsArgs,
    ...identityArgs,
    `root@${host}`,
    `docker compose --project-directory ${COMPOSE_PROJECT_DIR} ps --format json`,
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  let stdoutText: string
  let stderrText: string
  let exitCode: number

  try {
    const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})
    ;[stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } finally {
    cleanup()
  }

  if (exitCode !== 0) {
    const redacted = redactHost(stderrText.trim(), host) || 'unknown error'
    return {
      ok: false,
      services: [],
      error: `SSH command failed (exit ${exitCode}): ${redacted}`,
    }
  }

  let entries: ComposePsEntry[]

  try {
    entries = parseComposePsOutput(stdoutText)
  } catch {
    return {
      ok: false,
      services: [],
      error: `Failed to parse docker compose ps output: ${redactHost(stdoutText.slice(0, 200), host)}`,
    }
  }

  const services = parseComposePs(entries)
  const ok = isAllRunning(services)

  return {ok, services}
}

/**
 * Second SSH call: workspace memory, cgroup kill counters and supervisor state. Remote failures never throw;
 * a failure, timeout or unparsable section yields an `unknown` block so compose output is unaffected.
 */
export async function getGatewayWorkspaceStatus(
  host: string,
  spawn: SpawnFn = defaultSpawn,
  timeoutMs: number = WORKSPACE_PROBE_TIMEOUT_MS,
): Promise<WorkspaceMemoryStatus> {
  validateGatewayHost(host)

  const knownHostsArgs = buildKnownHostsArgs()
  const {args: identityArgs, cleanup} = buildIdentityArgs(process.env.GATEWAY_SSH_KEY)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...knownHostsArgs,
    ...identityArgs,
    `root@${host}`,
    buildWorkspaceProbeScript(),
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  let timer: ReturnType<typeof setTimeout> | undefined
  const timedOut = new Promise<'timeout'>(resolve => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })

  try {
    const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})
    const collected = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    // A killed child may reject the pending reads after the race is already decided.
    collected.catch(() => undefined)

    const outcome = await Promise.race([collected, timedOut])
    if (outcome === 'timeout') {
      child.kill?.()
      return unknownWorkspace(`timed out after ${Math.round(timeoutMs / 1000)}s`)
    }

    const [stdoutText, , exitCode] = outcome
    if (exitCode !== 0) return unknownWorkspace(`SSH command failed (exit ${exitCode})`)

    return parseWorkspaceProbeOutput(stdoutText)
  } catch {
    return unknownWorkspace('SSH command could not run')
  } finally {
    clearTimeout(timer)
    cleanup()
  }
}

// ─── Unified status aggregator export ────────────────────────────────────────

export async function getGatewayStatusSummary(host: string, spawn?: SpawnFn): Promise<StatusSummary> {
  const result = await getGatewayComposeStatus(host, spawn)

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
  const workspace = await getGatewayWorkspaceStatus(host, spawn)

  return {
    app: 'gateway',
    http: `OK: ${rows}; ${formatWorkspaceSummary(workspace)}`,
    lastDeploy: '—',
    version: '—',
    contentHash: '—',
    usageStats: '—',
  }
}

// ─── Action (exported for direct testing) ────────────────────────────────────

export async function gatewayStatusAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  spawn?: SpawnFn,
  workspaceTimeoutMs?: number,
): Promise<void> {
  const hostEnvKey = options.key ?? 'GATEWAY_HOST'
  const host = process.env[hostEnvKey]

  if (!host) {
    ctx.console.error(`Gateway host not set. Export ${hostEnvKey} or pass --key <env-name> pointing to a set variable.`)
    ctx.process.exit(1)
    return
  }

  ctx.console.log('Gateway status')
  ctx.console.log('')

  const result = await getGatewayComposeStatus(host, spawn)

  if (!result.ok && result.services.length === 0) {
    ctx.console.error(`Error: ${result.error ?? 'Unknown error'}`)
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

  // Display-only: the workspace block never influences the status line or the exit code below.
  const workspace = await getGatewayWorkspaceStatus(host, spawn, workspaceTimeoutMs)
  for (const line of formatWorkspaceMemory(workspace)) {
    ctx.console.log(line)
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

export function registerGatewayStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('gateway status', 'Show operational health of the gateway deployment via docker compose ps.')
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to GATEWAY_HOST when omitted.'),
    )
    .action((options, ctx) => gatewayStatusAction(options, ctx))
}
