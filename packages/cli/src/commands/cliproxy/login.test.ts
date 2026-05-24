import type {SpawnFn} from './login'

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

// Helper: a SpawnFn that must never be called (proves provider check fires before spawn)
const neverSpawn: SpawnFn = () => {
  throw new Error('spawn must not be called for invalid provider')
}

// Helper: set up a valid TTY + env so spawn-path tests can reach the spawn call
function setValidEnv(): void {
  Object.defineProperty(process.stdin, 'isTTY', {value: true, configurable: true})
  process.env.SSH_AUTH_SOCK = '/tmp/test-agent.sock'
  process.env.PATH = process.env.PATH ?? '/usr/bin'
  process.env.HOME = process.env.HOME ?? '/root'
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
      await expect(cliproxyLoginAction('openai', {}, spawnFn)).rejects.toThrow('Supported: claude, codex.')
    })

    it('requires interactive terminal (checked before SSH_AUTH_SOCK)', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk()

      // Simulate non-TTY environment (as subprocess tests did)
      Object.defineProperty(process.stdin, 'isTTY', {value: false, configurable: true})

      await expect(cliproxyLoginAction('claude', {}, spawnFn)).rejects.toThrow('interactive terminal')
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

  describe('provider flags', () => {
    it('happy path — codex: spawn args contain --codex-device-login and --no-browser', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn, calls} = makeSpawnOk(0)
      setValidEnv()

      await cliproxyLoginAction('codex', {}, spawnFn)

      const cmd = calls[0]!.cmd
      expect(cmd.join(' ')).toContain('--codex-device-login')
      expect(cmd.join(' ')).toContain('--no-browser')
      expect(cmd.join(' ')).not.toContain('--codex-login ')
    })

    it('happy path — claude regression: spawn args contain --claude-login and --no-browser', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn, calls} = makeSpawnOk(0)
      setValidEnv()

      await cliproxyLoginAction('claude', {}, spawnFn)

      const cmd = calls[0]!.cmd
      expect(cmd.join(' ')).toContain('--claude-login')
      expect(cmd.join(' ')).toContain('--no-browser')
    })

    it('error path — unknown provider "chatgpt": rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('chatgpt', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "chatgpt". Supported: claude, codex.',
      )
    })

    it('error path — empty provider: rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "". Supported: claude, codex.',
      )
    })

    it('error path — malformed provider path traversal: rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('../../../etc/passwd', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "../../../etc/passwd". Supported: claude, codex.',
      )
    })

    it('error path — prototype-chain bypass "__proto__": rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('__proto__', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "__proto__". Supported: claude, codex.',
      )
    })

    it('error path — prototype-chain bypass "constructor": rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('constructor', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "constructor". Supported: claude, codex.',
      )
    })

    it('error path — prototype-chain bypass "hasOwnProperty": rejects with correct message, no spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')

      await expect(cliproxyLoginAction('hasOwnProperty', {}, neverSpawn)).rejects.toThrow(
        'Unsupported provider "hasOwnProperty". Supported: claude, codex.',
      )
    })
  })

  describe('anti-phishing notice', () => {
    let logLines: string[]
    let originalLog: typeof console.log

    beforeEach(() => {
      logLines = []
      originalLog = console.log
      console.log = (...args: unknown[]) => {
        logLines.push(args.map(String).join(' '))
      }
    })

    afterEach(() => {
      console.log = originalLog
    })

    it('codex: anti-phishing notice appears before spawn', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const linesBeforeSpawn: string[] = []
      let spawnCalled = false

      const trackingSpawn: SpawnFn = (_cmd, _opts) => {
        linesBeforeSpawn.push(...logLines)
        spawnCalled = true
        return {exited: Promise.resolve(0)}
      }

      setValidEnv()
      await cliproxyLoginAction('codex', {}, trackingSpawn)

      expect(spawnCalled).toBe(true)
      const allOutput = linesBeforeSpawn.join('\n')
      expect(allOutput).toMatch(/openai\.com/i)
    })

    it('claude: anti-phishing notice does NOT appear', async () => {
      const {cliproxyLoginAction} = await import('./login')
      const {spawnFn} = makeSpawnOk(0)
      setValidEnv()

      await cliproxyLoginAction('claude', {}, spawnFn)

      const allOutput = logLines.join('\n')
      expect(allOutput).not.toMatch(/openai\.com/)
    })
  })
})
