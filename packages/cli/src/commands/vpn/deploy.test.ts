import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {getVpnDeployEnv, validateVpnRemotePreconditions} from './deploy'

const cliDir = resolve(import.meta.dir, '../../..')

const envKeys = ['HOME', 'PATH', 'SSH_AUTH_SOCK', 'VPN_HOST'] as const

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

function setManagedEnv(overrides: Partial<Record<ManagedEnvKey, string | undefined>>): void {
  restoreManagedEnv()
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) {
      delete process.env[key]
      continue
    }
    process.env[key as ManagedEnvKey] = value
  }
}

async function runDeployCommand(
  args: string[],
  envOverrides: Partial<Record<ManagedEnvKey, string | undefined>> = {},
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value
    }
  }

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  if (!Object.prototype.hasOwnProperty.call(envOverrides, 'HOME') && !env.HOME) {
    env.HOME = '/tmp/test-home'
  }

  if (!Object.prototype.hasOwnProperty.call(envOverrides, 'PATH') && !env.PATH) {
    env.PATH = '/usr/bin:/bin'
  }

  if (!Object.prototype.hasOwnProperty.call(envOverrides, 'SSH_AUTH_SOCK') && !env.SSH_AUTH_SOCK) {
    env.SSH_AUTH_SOCK = '/tmp/test-sock'
  }

  env.NO_COLOR = '1'

  const proc = Bun.spawn(['bun', 'src/cli.ts', 'vpn', 'deploy', ...args], {
    cwd: cliDir,
    env,
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

describe('vpn deploy', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  })

  afterEach(() => {
    restoreManagedEnv()
  })

  describe('getVpnDeployEnv', () => {
    it('returns the expected deploy environment when required variables are present', () => {
      setManagedEnv({
        VPN_HOST: '1.2.3.4',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      const env = getVpnDeployEnv()

      expect(env.VPN_HOST).toBe('1.2.3.4')
      expect(env.HOME).toBe('/tmp/test-home')
      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.SSH_AUTH_SOCK).toBe('/tmp/test-sock')
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      setManagedEnv({
        VPN_HOST: '1.2.3.4',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: undefined,
      })

      expect(() => getVpnDeployEnv()).toThrow('SSH_AUTH_SOCK')
    })

    it('throws when PATH is missing', () => {
      setManagedEnv({
        VPN_HOST: '1.2.3.4',
        HOME: '/tmp/test-home',
        PATH: undefined,
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(() => getVpnDeployEnv()).toThrow('PATH')
    })
  })

  describe('validateVpnRemotePreconditions', () => {
    it('throws when gh is not available', () => {
      const spy = spyOn(Bun, 'which').mockReturnValue(null)

      try {
        expect(() => validateVpnRemotePreconditions()).toThrow('gh')
      } finally {
        spy.mockRestore()
      }
    })

    it('does not throw when gh is available', () => {
      const spy = spyOn(Bun, 'which').mockReturnValue('/usr/bin/gh')

      try {
        expect(() => validateVpnRemotePreconditions()).not.toThrow()
      } finally {
        spy.mockRestore()
      }
    })
  })

  describe('--remote (default) dry-run', () => {
    it('prints planned actions without invoking gh', async () => {
      const {stdout, exitCode} = await runDeployCommand(['--dry-run'], {
        HOME: '/tmp/test-home',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Dry run')
      expect(stdout).toContain('Deploy VPN')
    })
  })

  describe('--local --dry-run', () => {
    it('prints planned local actions without spawning bun run', async () => {
      const {stdout, exitCode} = await runDeployCommand(['--local', '--dry-run'], {
        HOME: '/tmp/test-home',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Dry run')
      expect(stdout).toContain('local')
    })

    it('succeeds even when SSH_AUTH_SOCK is unset', async () => {
      const {stdout, exitCode} = await runDeployCommand(['--local', '--dry-run'], {
        HOME: '/tmp/test-home',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_AUTH_SOCK: undefined,
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Dry run')
    })
  })

  describe('--force-server-key --dry-run', () => {
    it('includes --force-server-key in the planned command', async () => {
      const {stdout, exitCode} = await runDeployCommand(['--local', '--force-server-key', '--dry-run'], {
        HOME: '/tmp/test-home',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('--force-server-key')
    })
  })
})
