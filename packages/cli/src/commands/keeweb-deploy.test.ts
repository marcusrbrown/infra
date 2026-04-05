import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  getLocalDeployEnv,
  resolveDeployScriptPath,
  resolveDistIndexPath,
  validateRemotePreconditions,
} from './keeweb-deploy'

const cliDir = resolve(import.meta.dir, '../..')

const envKeys = ['HOST', 'HOME', 'PATH', 'REMOTE_USER', 'SITE_DIR', 'SSH_AUTH_SOCK'] as const

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

    process.env[key] = value
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

  const proc = Bun.spawn(['bun', 'src/cli.ts', 'keeweb', 'deploy', ...args], {
    cwd: cliDir,
    env: {
      ...env,
      NO_COLOR: '1',
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

describe('keeweb deploy', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  })

  afterEach(() => {
    restoreManagedEnv()
  })

  describe('resolveDeployScriptPath', () => {
    it('returns a string path containing deploy.sh', () => {
      const deployScriptPath = resolveDeployScriptPath()

      expect(typeof deployScriptPath).toBe('string')
      expect(deployScriptPath).toContain('deploy.sh')
    })
  })

  describe('resolveDistIndexPath', () => {
    it('returns a string path ending with dist/index.html', () => {
      const distIndexPath = resolveDistIndexPath()

      expect(typeof distIndexPath).toBe('string')
      expect(distIndexPath).toEndWith('dist/index.html')
    })
  })

  describe('getLocalDeployEnv', () => {
    it('returns the expected deploy environment when required variables are present', () => {
      setManagedEnv({
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(getLocalDeployEnv()).toEqual({
        HOME: '/tmp/test-home',
        HOST: 'box.heatvision.co',
        PATH: '/usr/bin:/bin',
        REMOTE_USER: 'deploy-kw',
        SITE_DIR: '/home/user-data/www/kw.igg.ms',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      setManagedEnv({
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: undefined,
      })

      expect(() => getLocalDeployEnv()).toThrow(/SSH_AUTH_SOCK/)
    })

    it('throws when PATH is missing', () => {
      setManagedEnv({
        HOME: '/tmp/test-home',
        PATH: undefined,
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(() => getLocalDeployEnv()).toThrow(/PATH/)
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
    it('rejects --nginx without --local', async () => {
      const {stdout, stderr, exitCode} = await runDeployCommand(['--nginx'])

      expect(exitCode).not.toBe(0)
      expect(`${stdout}${stderr}`).toContain('only valid with --local')
    })

    it('prints the local dry-run plan without executing deploy.sh', async () => {
      const deployScriptPath = resolveDeployScriptPath()
      const {stdout, stderr, exitCode} = await runDeployCommand(['--local', '--dry-run'])

      expect(exitCode).toBe(0)
      expect(stderr).toBe('')
      expect(stdout).toContain('Dry run: local KeeWeb deploy')
      expect(stdout).toContain(deployScriptPath)
    })
  })
})
