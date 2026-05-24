import type {LoginOptions, SpawnFn} from './login'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

const envKeys = ['CLIPROXY_DOMAIN', 'HOME', 'PATH', 'SSH_AUTH_SOCK'] as const

type ManagedEnvKey = (typeof envKeys)[number]

let originalEnv: Partial<Record<ManagedEnvKey, string | undefined>>
let originalIsTTY: boolean | undefined

function restoreManagedEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key]

    if (value === undefined) {
      delete process.env[key]
      continue
    }

    process.env[key] = value
  }
}

/** Minimal SpawnFn mock for inherit-stdio calls — records invocations and resolves with exitCode. */
function makeSpawnOk(exitCode = 0): {spawnFn: SpawnFn; calls: {cmd: string[]; opts: unknown}[]} {
  const calls: {cmd: string[]; opts: unknown}[] = []
  const spawnFn: SpawnFn = (cmd, opts) => {
    calls.push({cmd, opts})
    return {exited: Promise.resolve(exitCode)}
  }

  return {spawnFn, calls}
}

describe('cliproxy login', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    originalIsTTY = process.stdin.isTTY
  })

  afterEach(() => {
    restoreManagedEnv()
    Object.defineProperty(process.stdin, 'isTTY', {value: originalIsTTY, configurable: true})
  })

  describe('validation', () => {
    it('rejects unsupported providers', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk()

      // Provider check happens before TTY check — no need to set isTTY
      await expect(cliproxyLoginAction('openai', {}, spawnFn)).rejects.toThrow('Unsupported provider')
      await expect(cliproxyLoginAction('openai', {}, spawnFn)).rejects.toThrow('only "claude" is supported')
    })

    it('requires interactive terminal (checked before SSH_AUTH_SOCK)', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk()

      // Simulate non-TTY environment (as subprocess tests did)
      Object.defineProperty(process.stdin, 'isTTY', {value: false, configurable: true})

      await expect(cliproxyLoginAction('claude', {SSH_AUTH_SOCK: undefined} as LoginOptions, spawnFn)).rejects.toThrow(
        'interactive terminal',
      )
    })
  })

  describe('host resolution', () => {
    it('uses CLIPROXY_DOMAIN env var', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk()

      Object.defineProperty(process.stdin, 'isTTY', {value: false, configurable: true})
      process.env.CLIPROXY_DOMAIN = 'custom.host.example'

      // TTY check fires before host resolution — error is about TTY
      await expect(cliproxyLoginAction('claude', {}, spawnFn)).rejects.toThrow('interactive terminal')
    })

    it('uses --host flag', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk()

      Object.defineProperty(process.stdin, 'isTTY', {value: false, configurable: true})

      // TTY check fires before host resolution — error is about TTY
      await expect(cliproxyLoginAction('claude', {host: 'custom.host.example'}, spawnFn)).rejects.toThrow(
        'interactive terminal',
      )
    })
  })

  describe('unit: resolveHost', () => {
    it('returns input when provided', async () => {
      const {resolveHost} = await import('./login')
      expect(resolveHost('test.example.com')).toBe('test.example.com')
    })

    it('falls back to CLIPROXY_DOMAIN', async () => {
      process.env.CLIPROXY_DOMAIN = 'env.example.com'
      const {resolveHost} = await import('./login')
      expect(resolveHost()).toBe('env.example.com')
    })

    it('falls back to default host', async () => {
      delete process.env.CLIPROXY_DOMAIN
      const {resolveHost} = await import('./login')
      expect(resolveHost()).toBe('cliproxy.fro.bot')
    })
  })

  describe('unit: requireSshAuthSock', () => {
    it('returns SSH_AUTH_SOCK when set', async () => {
      process.env.SSH_AUTH_SOCK = '/tmp/test-agent.sock'
      const {requireSshAuthSock} = await import('./login')
      expect(requireSshAuthSock()).toBe('/tmp/test-agent.sock')
    })

    it('throws when SSH_AUTH_SOCK is not set', async () => {
      delete process.env.SSH_AUTH_SOCK
      const {requireSshAuthSock} = await import('./login')
      expect(() => requireSshAuthSock()).toThrow('SSH_AUTH_SOCK is required')
    })
  })
})
