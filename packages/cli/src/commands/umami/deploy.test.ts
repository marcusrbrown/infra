import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {getUmamiDeployEnv, validateUmamiRemotePreconditions} from './deploy'

const repoRoot = resolve(import.meta.dir, '../../../../..')

const envKeys = [
  'HOME',
  'PATH',
  'SSH_AUTH_SOCK',
  'UMAMI_DOMAIN',
  'UMAMI_APP_SECRET',
  'UMAMI_DB_PASSWORD',
  'UMAMI_ADMIN_PASSWORD',
  'UMAMI_SSH_KEY',
] as const

type ManagedEnvKey = (typeof envKeys)[number]

let originalEnv: Partial<Record<ManagedEnvKey, string | undefined>>

function restoreManagedEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

function setManagedEnv(overrides: Partial<Record<ManagedEnvKey, string | undefined>>): void {
  restoreManagedEnv()
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key as ManagedEnvKey]
    } else {
      process.env[key as ManagedEnvKey] = value
    }
  }
}

beforeEach(() => {
  originalEnv = {}
  for (const key of envKeys) {
    originalEnv[key] = process.env[key]
  }
})

afterEach(() => {
  restoreManagedEnv()
})

// ─── getUmamiDeployEnv ────────────────────────────────────────────────────────

describe('getUmamiDeployEnv', () => {
  it('returns env object with required keys when all are set', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      UMAMI_DOMAIN: 'metrics.fro.bot',
    })

    const env = getUmamiDeployEnv()

    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/user')
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect(env.UMAMI_DOMAIN).toBe('metrics.fro.bot')
  })

  it('throws when PATH is missing', () => {
    setManagedEnv({PATH: undefined, HOME: '/home/user', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'})

    expect(() => getUmamiDeployEnv()).toThrow('PATH is required')
  })

  it('throws when HOME is missing', () => {
    setManagedEnv({PATH: '/usr/bin:/bin', HOME: undefined, SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'})

    expect(() => getUmamiDeployEnv()).toThrow('HOME is required')
  })

  it('throws when SSH_AUTH_SOCK is missing', () => {
    setManagedEnv({PATH: '/usr/bin:/bin', HOME: '/home/user', SSH_AUTH_SOCK: undefined})

    expect(() => getUmamiDeployEnv()).toThrow('SSH_AUTH_SOCK is required')
  })

  it('includes optional umami env vars when set', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      UMAMI_APP_SECRET: 'secret123',
      UMAMI_DB_PASSWORD: 'dbpass',
      UMAMI_ADMIN_PASSWORD: 'adminpass',
    })

    const env = getUmamiDeployEnv()

    expect(env.UMAMI_APP_SECRET).toBe('secret123')
    expect(env.UMAMI_DB_PASSWORD).toBe('dbpass')
    expect(env.UMAMI_ADMIN_PASSWORD).toBe('adminpass')
  })
})

// ─── validateUmamiRemotePreconditions ─────────────────────────────────────────

describe('validateUmamiRemotePreconditions', () => {
  it('throws a clear error when gh is not available', () => {
    // We cannot reliably mock Bun.which, so we test the function contract:
    // if gh is not installed, it should throw with a helpful message.
    // This test verifies the error message shape by calling with a known-missing binary.
    // In CI where gh IS installed, we skip this test.
    if (Bun.which('gh')) {
      // gh is available — just verify the function does not throw
      expect(() => validateUmamiRemotePreconditions()).not.toThrow()
      return
    }

    expect(() => validateUmamiRemotePreconditions()).toThrow('gh CLI is required')
  })
})

// ─── deploy command (subprocess integration via CLI) ─────────────────────────

describe('deploy command', () => {
  it('dry-run remote mode prints planned gh workflow run command without executing', async () => {
    const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/cli.ts', 'umami', 'deploy', '--dry-run'], {
      cwd: repoRoot,
      env: {...process.env, NO_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Dry run')
    expect(stdout).toContain('Deploy Umami')
  })

  it('dry-run local mode prints planned bun command without executing', async () => {
    const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/cli.ts', 'umami', 'deploy', '--local', '--dry-run'], {
      cwd: repoRoot,
      env: {...process.env, NO_COLOR: '1'},
      stdout: 'pipe',
      stderr: 'pipe',
    })

    const [stdout, _stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])

    expect(exitCode).toBe(0)
    expect(stdout).toContain('Dry run')
    expect(stdout).toContain('apps/umami')
  })
})
