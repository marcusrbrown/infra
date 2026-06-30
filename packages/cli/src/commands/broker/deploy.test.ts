import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {getLocalDeployEnv, resolveLocalDeployScriptPath, validateRemotePreconditions} from './deploy'

const cliDir = resolve(import.meta.dir, '../../..')

const envKeys = ['BROKER_DOMAIN', 'BROKER_HOST', 'HOME', 'PATH', 'SSH_AUTH_SOCK'] as const

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
  const env = {...process.env}

  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
      continue
    }

    env[key] = value
  }

  const proc = Bun.spawn(['bun', 'src/cli.ts', 'broker', 'deploy', ...args], {
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

describe('broker deploy', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  })

  afterEach(() => {
    restoreManagedEnv()
  })

  describe('resolveLocalDeployScriptPath', () => {
    it('returns a string path containing deploy.ts', () => {
      const deployScriptPath = resolveLocalDeployScriptPath()

      expect(typeof deployScriptPath).toBe('string')
      expect(deployScriptPath).toContain('deploy.ts')
    })
  })

  describe('getLocalDeployEnv', () => {
    it('returns the expected deploy environment when required variables are present', () => {
      setManagedEnv({
        BROKER_DOMAIN: 'broker.example.com',
        BROKER_HOST: '',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(getLocalDeployEnv()).toEqual({
        BROKER_DOMAIN: 'broker.example.com',
        BROKER_HOST: '',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })
    })

    it('throws when PATH is missing', () => {
      setManagedEnv({
        HOME: '/tmp/test-home',
        PATH: undefined,
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(() => getLocalDeployEnv()).toThrow(/PATH/)
    })

    it('throws when HOME is missing', () => {
      setManagedEnv({
        HOME: undefined,
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(() => getLocalDeployEnv()).toThrow(/HOME/)
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      setManagedEnv({
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: undefined,
      })

      expect(() => getLocalDeployEnv()).toThrow(/SSH_AUTH_SOCK/)
    })
  })

  describe('validateRemotePreconditions', () => {
    it('does not throw when gh is available', () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue('/opt/homebrew/bin/gh')

      expect(() => validateRemotePreconditions()).not.toThrow()

      whichSpy.mockRestore()
    })

    it('throws when gh is unavailable', () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue(null)

      expect(() => validateRemotePreconditions()).toThrow(/gh CLI is required/)

      whichSpy.mockRestore()
    })
  })

  describe('CLI flag interactions', () => {
    it('prints the local dry-run plan', async () => {
      const deployScriptPath = resolveLocalDeployScriptPath()
      const {stdout, stderr, exitCode} = await runDeployCommand(['--local', '--dry-run'])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain('Dry run: local broker deploy')
      expect(stdout).toContain(deployScriptPath)
      expect(stdout).toContain('BROKER_DOMAIN=')
    })

    it('prints the remote dry-run plan', async () => {
      const {stdout, stderr, exitCode} = await runDeployCommand(['--dry-run'])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain('Dry run: remote broker deploy')
      expect(stdout).toContain('Deploy Broker')
    })

    it('rejects invalid options with a non-zero exit code', async () => {
      const {exitCode} = await runDeployCommand(['--bogus'])

      expect(exitCode).not.toBe(0)
    })
  })
})
