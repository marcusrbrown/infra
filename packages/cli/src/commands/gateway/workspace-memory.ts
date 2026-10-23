export const COMPOSE_PROJECT_DIR = '/opt/gateway/deploy'

const MIB = 1024 * 1024

/**
 * The supervisor `/readyz` probe is skipped when the workspace is this close to its memory limit,
 * so the probe itself can't push the container into an OOM kill.
 */
export const READYZ_PROBE_HEADROOM_BYTES = 64 * MIB

export const OPENCODE_STATES = ['starting', 'ready', 'down', 'degraded'] as const

/**
 * `skipped`: the probe was deliberately not run (no limit, or too close to it).
 * `unknown`: the probe ran, or its outcome can't be established, and gave no usable answer.
 */
export type OpencodeState = (typeof OPENCODE_STATES)[number] | 'skipped' | 'unknown'

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

// ─── Workspace memory probe (pure helpers) ───────────────────────────────────

const SECTION_MARKERS = {
  id: '@@ws-id@@',
  inspect: '@@ws-inspect@@',
  cgroup: '@@ws-cgroup@@',
  readyz: '@@ws-readyz@@',
} as const

// Printed in the readyz section when the script decides not to run the probe.
const READYZ_SKIPPED_SENTINEL = '@@ws-readyz-skipped@@'

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
    'else',
    `  echo ${READYZ_SKIPPED_SENTINEL}`,
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

export const unknownWorkspace = (reason: string): WorkspaceMemoryStatus => ({status: 'unknown', reason})

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

  // The script's own sentinel says the probe was not run. Without it, headroom is re-checked here so a probe
  // body from a near-limit container is never trusted.
  const probeAllowed = limitBytes > 0 && limitBytes - currentBytes > READYZ_PROBE_HEADROOM_BYTES
  let opencode: OpencodeState | undefined
  if (readyzLines.includes(READYZ_SKIPPED_SENTINEL)) opencode = 'skipped'
  else if (probeAllowed) opencode = parseOpencodeState(readyzLines.join('').trim())
  else opencode = 'unknown'
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

function formatOpencode(status: WorkspaceMemoryReport): string {
  if (status.opencode !== 'skipped') return status.opencode
  if (status.limitBytes === 0) return 'skipped (no limit)'
  if (status.limitBytes - status.currentBytes <= READYZ_PROBE_HEADROOM_BYTES) {
    return `skipped (within ${READYZ_PROBE_HEADROOM_BYTES / MIB} MiB of the limit)`
  }
  return 'skipped (memory read unavailable)'
}

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
    `  OpenCode:    ${formatOpencode(status)}`,
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
