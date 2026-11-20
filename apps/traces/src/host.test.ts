import {describe, expect, it} from 'bun:test'

import {
  isSenderGroup,
  SENDER_GROUPS,
  TRACES_APP_DIR,
  TRACES_CONTAINERD_ROOT,
  TRACES_DOCKER_ROOT,
  TRACES_SENTINEL_PATH,
  TRACES_TOKEN_ROOT,
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
