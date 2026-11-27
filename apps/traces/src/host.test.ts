import {describe, expect, it} from 'bun:test'

import {
  GRAFANA_MCP_USER_ID,
  isSenderGroup,
  READER_GATE_DEADLINE_MS,
  READER_GATE_USER_ID,
  READER_GRAFANA_PLACEHOLDER,
  READER_LANGFUSE_PLACEHOLDER,
  READER_PREVIOUS_SUFFIX,
  READER_STAGED_SUFFIX,
  SENDER_GROUPS,
  TEMPO_USER_ID,
  TRACES_APP_DIR,
  TRACES_CONTAINERD_ROOT,
  TRACES_DEPLOY_MARKER,
  TRACES_DEPLOY_STEP_LOCK,
  TRACES_DOCKER_ROOT,
  TRACES_GRAFANA_MCP_TOKEN_FILE,
  TRACES_INGEST_LOCK,
  TRACES_LOCK_BUSY_SENTINEL,
  TRACES_PENDING_RESTARTS,
  TRACES_READER_DIR,
  TRACES_READER_LANGFUSE_FILE,
  TRACES_READER_LOCK,
  TRACES_READER_TOKEN_FILE,
  TRACES_SENTINEL_PATH,
  TRACES_TOKEN_ROOT,
  TRACES_TOKENS_LOCK,
  TRACES_VOID_TOKEN_PREFIX,
  TRACES_VOLUME_MOUNT,
  tracesTokenDir,
  validateTracesHost,
} from './host'

describe('validateTracesHost', () => {
  it('accepts a hostname, an FQDN and an address', () => {
    expect(validateTracesHost('traces.fro.bot')).toBe('traces.fro.bot')
    expect(validateTracesHost('localhost')).toBe('localhost')
    expect(validateTracesHost('droplet-1.example.invalid')).toBe('droplet-1.example.invalid')
  })

  it('throws on an empty string', () => {
    expect(() => validateTracesHost('')).toThrow(/empty/)
  })

  it('throws on a value starting with a dash (ssh flag injection)', () => {
    expect(() => validateTracesHost('-oProxyCommand=evil')).toThrow(/Invalid TRACES_HOST/)
    expect(() => validateTracesHost('-v')).toThrow(/Invalid TRACES_HOST/)
  })

  it('throws on characters outside the allowed set', () => {
    for (const value of ['host;rm -rf /', 'host name', 'host$(id)', 'a/b', 'a@b', 'a:22', 'ho\nst', '.leading-dot']) {
      expect(() => validateTracesHost(value)).toThrow(/Invalid TRACES_HOST/)
    }
  })

  it('echoes only a short printable excerpt of a bad value', () => {
    let message = ''
    try {
      validateTracesHost(`${'x'.repeat(100)}\u0007;`)
    } catch (error) {
      message = error instanceof Error ? error.message : ''
    }
    expect(message).not.toContain('\u0007')
    expect(message.length).toBeLessThan(150)
  })
})

describe('sender groups', () => {
  it('names exactly the three groups', () => {
    expect([...SENDER_GROUPS]).toEqual(['marcusrbrown', 'fro-bot', 'workstation'])
  })

  it('recognises a group name and nothing else', () => {
    expect(isSenderGroup('fro-bot')).toBe(true)
    expect(isSenderGroup('gateway')).toBe(false)
    expect(isSenderGroup('')).toBe(false)
    expect(isSenderGroup('../marcusrbrown')).toBe(false)
  })
})

describe('host layout', () => {
  it('keeps every content-bearing path under the volume mount', () => {
    for (const path of [
      TRACES_DOCKER_ROOT,
      TRACES_CONTAINERD_ROOT,
      TRACES_APP_DIR,
      TRACES_TOKEN_ROOT,
      TRACES_SENTINEL_PATH,
    ]) {
      expect(path.startsWith(`${TRACES_VOLUME_MOUNT}/`)).toBe(true)
    }
  })

  it('puts each group token directory under the app directory on the volume', () => {
    expect(TRACES_TOKEN_ROOT.startsWith(`${TRACES_APP_DIR}/`)).toBe(true)
    const dirs = SENDER_GROUPS.map(group => tracesTokenDir(group))
    expect(new Set(dirs).size).toBe(SENDER_GROUPS.length)
    for (const dir of dirs) {
      expect(dir.startsWith(`${TRACES_TOKEN_ROOT}/`)).toBe(true)
    }
    expect(tracesTokenDir('fro-bot')).toBe(`${TRACES_TOKEN_ROOT}/fro-bot`)
  })
})

describe('deploy state and locks', () => {
  it('pins the contract paths to their exact values', () => {
    expect(TRACES_DEPLOY_MARKER).toBe('/mnt/traces/app/.deploy-in-progress')
    expect(TRACES_DEPLOY_STEP_LOCK).toBe('/mnt/traces/app/.deploy-step.lock')
    expect(TRACES_PENDING_RESTARTS).toBe('/mnt/traces/app/.pending-restarts')
    expect(TRACES_INGEST_LOCK).toBe('/mnt/traces/app/.ingest.lock')
    expect(TRACES_TOKENS_LOCK).toBe('/mnt/traces/app/tokens/.lock')
    expect(TRACES_LOCK_BUSY_SENTINEL).toBe('LOCK_BUSY')
  })

  it('keeps them on the volume, under the app directory', () => {
    for (const path of [
      TRACES_DEPLOY_MARKER,
      TRACES_DEPLOY_STEP_LOCK,
      TRACES_PENDING_RESTARTS,
      TRACES_INGEST_LOCK,
      TRACES_TOKENS_LOCK,
    ]) {
      expect(path.startsWith(`${TRACES_APP_DIR}/`)).toBe(true)
    }
    // The tokens lock sits inside the token root, where only the sender-token commands write.
    expect(TRACES_TOKENS_LOCK.startsWith(`${TRACES_TOKEN_ROOT}/`)).toBe(true)
    expect(
      new Set([
        TRACES_DEPLOY_MARKER,
        TRACES_DEPLOY_STEP_LOCK,
        TRACES_PENDING_RESTARTS,
        TRACES_INGEST_LOCK,
        TRACES_TOKENS_LOCK,
      ]).size,
    ).toBe(5)
  })
})

describe('token files', () => {
  it('pins the void token prefix', () => {
    expect(TRACES_VOID_TOKEN_PREFIX).toBe('trc_void_')
  })
})

describe('reader files and users', () => {
  it('pins the contract paths to their exact values', () => {
    expect(TRACES_READER_DIR).toBe('/mnt/traces/app/readers')
    expect(TRACES_READER_TOKEN_FILE).toBe('/mnt/traces/app/readers/token')
    expect(TRACES_READER_LOCK).toBe('/mnt/traces/app/readers/.lock')
    expect(TRACES_READER_LANGFUSE_FILE).toBe('/mnt/traces/app/secrets/reader-gate/langfuse-basic')
    expect(TRACES_GRAFANA_MCP_TOKEN_FILE).toBe('/mnt/traces/app/secrets/grafana-mcp/token')
    expect(READER_STAGED_SUFFIX).toBe('.staged')
    expect(READER_PREVIOUS_SUFFIX).toBe('.previous')
  })

  it('keeps the reader store outside the sender token root, which the collector mounts', () => {
    expect(TRACES_READER_DIR.startsWith(`${TRACES_APP_DIR}/`)).toBe(true)
    expect(TRACES_READER_DIR.startsWith(`${TRACES_TOKEN_ROOT}/`)).toBe(false)
    expect(TRACES_READER_TOKEN_FILE.startsWith(`${TRACES_READER_DIR}/`)).toBe(true)
    expect(TRACES_READER_LOCK.startsWith(`${TRACES_READER_DIR}/`)).toBe(true)
    expect(TRACES_READER_LOCK).not.toBe(TRACES_TOKENS_LOCK)
    for (const path of [TRACES_READER_LANGFUSE_FILE, TRACES_GRAFANA_MCP_TOKEN_FILE]) {
      expect(path.startsWith(`${TRACES_APP_DIR}/secrets/`)).toBe(true)
    }
  })

  it('pins the placeholders, which are never a working credential', () => {
    expect(READER_LANGFUSE_PLACEHOLDER).toBe('pk-lf-unset:sk-lf-unset')
    expect(READER_GRAFANA_PLACEHOLDER).toBe('glsa_unset')
  })

  it('gives the gate and the Grafana MCP server their own ids, apart from the other stack users', () => {
    expect(READER_GATE_USER_ID).toBe(10_003)
    expect(GRAFANA_MCP_USER_ID).toBe(1000)
    expect(new Set([READER_GATE_USER_ID, GRAFANA_MCP_USER_ID, TEMPO_USER_ID]).size).toBe(3)
  })

  it('pins the gate deadline: Caddy timeouts must stay above it', () => {
    expect(READER_GATE_DEADLINE_MS).toBe(60_000)
  })
})
