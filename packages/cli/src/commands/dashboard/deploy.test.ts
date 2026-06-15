import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {getDashboardDeployEnv, validateDashboardRemotePreconditions} from './deploy'

const repoRoot = resolve(import.meta.dir, '../../../../..')

const envKeys = ['HOME', 'PATH', 'SSH_AUTH_SOCK', 'DASHBOARD_DOMAIN', 'DASHBOARD_SSH_KEY'] as const

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

// ─── getDashboardDeployEnv ────────────────────────────────────────────────────

describe('getDashboardDeployEnv', () => {
  it('returns env object with required keys when all are set', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      DASHBOARD_DOMAIN: 'dashboard.fro.bot',
    })

    const env = getDashboardDeployEnv()

    expect(env.PATH).toBe('/usr/bin:/bin')
    expect(env.HOME).toBe('/home/user')
    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect(env.DASHBOARD_DOMAIN).toBe('dashboard.fro.bot')
  })

  it('throws when PATH is missing', () => {
    setManagedEnv({PATH: undefined, HOME: '/home/user', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'})

    expect(() => getDashboardDeployEnv()).toThrow('PATH is required')
  })

  it('throws when HOME is missing', () => {
    setManagedEnv({PATH: '/usr/bin:/bin', HOME: undefined, SSH_AUTH_SOCK: '/tmp/ssh-agent.sock'})

    expect(() => getDashboardDeployEnv()).toThrow('HOME is required')
  })

  it('throws when SSH_AUTH_SOCK is missing and no DASHBOARD_SSH_KEY either', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: undefined,
      DASHBOARD_SSH_KEY: undefined,
    })

    expect(() => getDashboardDeployEnv()).toThrow('Local deploy needs an SSH context')
  })

  it('succeeds with only SSH_AUTH_SOCK set (no DASHBOARD_SSH_KEY)', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
      DASHBOARD_SSH_KEY: undefined,
    })

    const env = getDashboardDeployEnv()

    expect(env.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    expect('DASHBOARD_SSH_KEY' in env).toBe(false)
  })

  it('succeeds with only DASHBOARD_SSH_KEY set (no SSH_AUTH_SOCK) and includes the key in env', () => {
    setManagedEnv({
      PATH: '/usr/bin:/bin',
      HOME: '/home/user',
      SSH_AUTH_SOCK: undefined,
      DASHBOARD_SSH_KEY: 'ssh-ed25519 AAAA...',
    })

    const env = getDashboardDeployEnv()

    expect(env.DASHBOARD_SSH_KEY).toBe('ssh-ed25519 AAAA...')
    expect('SSH_AUTH_SOCK' in env).toBe(false)
  })
})

// ─── validateDashboardRemotePreconditions ─────────────────────────────────────

describe('validateDashboardRemotePreconditions', () => {
  it('throws a clear error when gh is not available', () => {
    // We cannot reliably mock Bun.which, so we test the function contract:
    // if gh is not installed, it should throw with a helpful message.
    // This test verifies the error message shape by calling with a known-missing binary.
    // In CI where gh IS installed, we skip this test.
    if (Bun.which('gh')) {
      // gh is available — just verify the function does not throw
      expect(() => validateDashboardRemotePreconditions()).not.toThrow()
      return
    }

    expect(() => validateDashboardRemotePreconditions()).toThrow('gh CLI is required')
  })
})

// ─── deploy command (subprocess integration via CLI) ─────────────────────────

describe('deploy command', () => {
  it('dry-run remote mode prints planned gh workflow run command without executing', async () => {
    const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/cli.ts', 'dashboard', 'deploy', '--dry-run'], {
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
    expect(stdout).toContain('Deploy Dashboard')
  })

  it('dry-run local mode prints planned bun command without executing', async () => {
    const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/cli.ts', 'dashboard', 'deploy', '--local', '--dry-run'], {
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
    expect(stdout).toContain('apps/dashboard')
  })
})
