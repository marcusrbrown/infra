import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

const cliDir = resolve(import.meta.dir, '../../..')

const envKeys = ['CLIPROXY_DOMAIN', 'HOME', 'PATH', 'SSH_AUTH_SOCK'] as const

type ManagedEnvKey = (typeof envKeys)[number]

let originalEnv: Partial<Record<ManagedEnvKey, string | undefined>>

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

async function runLoginCommand(
  args: string[],
  envOverrides: Partial<Record<ManagedEnvKey, string | undefined>> = {},
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const env = {...process.env}

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
      continue
    }

    env[key] = value
  }

  const proc = Bun.spawn(['bun', 'src/cli.ts', 'cliproxy', 'login', ...args], {
    cwd: cliDir,
    env: {
      ...env,
      HOME: env.HOME ?? '/tmp/test-home',
      NO_COLOR: '1',
      PATH: env.PATH ?? '/usr/bin:/bin',
      SSH_AUTH_SOCK: env.SSH_AUTH_SOCK ?? '/tmp/test-sock',
    },
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {stdout, stderr, exitCode}
}

describe('cliproxy login', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  })

  afterEach(() => {
    restoreManagedEnv()
  })

  describe('validation', () => {
    it('rejects unsupported providers', async () => {
      const {stderr, exitCode} = await runLoginCommand(['openai'])
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('Unsupported provider')
      expect(stderr).toContain('only "claude" is supported')
    })

    it('requires interactive terminal (checked before SSH_AUTH_SOCK)', async () => {
      const {stderr, exitCode} = await runLoginCommand(['claude'], {SSH_AUTH_SOCK: undefined})
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('interactive terminal')
    })
  })

  describe('host resolution', () => {
    it('uses CLIPROXY_DOMAIN env var', async () => {
      const {stderr, exitCode} = await runLoginCommand(['claude'], {
        CLIPROXY_DOMAIN: 'custom.host.example',
      })
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('interactive terminal')
    })

    it('uses --host flag', async () => {
      const {stderr, exitCode} = await runLoginCommand(['claude', '--host', 'custom.host.example'])
      expect(exitCode).not.toBe(0)
      expect(stderr).toContain('interactive terminal')
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
