// Realistic stdout from the workspace probe script, shared by the pure-helper and SSH tests.

export const MIB = 1024 * 1024
export const LIMIT_BYTES = 896 * MIB
export const CONTAINER_ID = '3f2a9c1d8e7b6a5f4e3d2c1b0a9f8e7d6c5b4a39281706f5e4d3c2b1a0f9e8d7'
export const STARTED_AT = '2026-10-23T08:20:18.123456789Z'

export const READY_BODY = '{"ready":true,"opencode":"ready"}'
export const DEGRADED_BODY = '{"ready":false,"opencode":"degraded"}'

export interface WorkspaceStdoutOptions {
  id?: string
  memory?: number
  oomKilled?: boolean
  restartCount?: number
  currentBytes?: number
  maxEvents?: number
  oomKill?: number
  readyz?: string
  /** Print the sentinel the script emits when it deliberately skips the probe, instead of a body. */
  readyzSkipped?: boolean
  omit?: 'id' | 'inspect' | 'cgroup' | 'readyz'
}

// Mirrors what buildWorkspaceProbeScript prints on a live host.
export function workspaceStdout(options: WorkspaceStdoutOptions = {}): string {
  const {
    id = CONTAINER_ID,
    memory = LIMIT_BYTES,
    oomKilled = false,
    restartCount = 0,
    currentBytes = 412 * MIB,
    maxEvents = 0,
    oomKill = 0,
    readyz = READY_BODY,
    readyzSkipped = false,
    omit,
  } = options

  const sections = {
    id: `@@ws-id@@\n${id}\n`,
    inspect: `@@ws-inspect@@\n${memory} ${oomKilled} ${restartCount} ${STARTED_AT}\n`,
    cgroup: `@@ws-cgroup@@\n${currentBytes}\nlow 0\nhigh 0\nmax ${maxEvents}\noom ${oomKill}\noom_kill ${oomKill}\n`,
    readyz: `@@ws-readyz@@\n${readyzSkipped ? '@@ws-readyz-skipped@@\n' : readyz}`,
  }

  return Object.entries(sections)
    .filter(([name]) => name !== omit)
    .map(([, text]) => text)
    .join('')
}
