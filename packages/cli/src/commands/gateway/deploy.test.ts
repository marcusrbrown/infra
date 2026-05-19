import {resolve} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {getGatewayDeployEnv, validateGatewayRemotePreconditions} from './deploy'

const cliDir = resolve(import.meta.dir, '../../..')

const envKeys = [
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'DISCORD_TOKEN',
  'GATEWAY_HOST',
  'HOME',
  'OBJECT_STORE_HOSTS',
  'PATH',
  'S3_BUCKET',
  'S3_ENDPOINT',
  'S3_REGION',
  'SSH_AUTH_SOCK',
] as const

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

  // Apply overrides: undefined means explicitly unset the key
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) {
      delete env[key]
    } else {
      env[key] = value
    }
  }

  // Apply defaults only for keys not explicitly overridden
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

  const proc = Bun.spawn(['bun', 'src/cli.ts', 'gateway', 'deploy', ...args], {
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

describe('gateway deploy', () => {
  beforeEach(() => {
    originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
  })

  afterEach(() => {
    restoreManagedEnv()
  })

  describe('getGatewayDeployEnv', () => {
    it('returns the expected deploy environment when required variables are present', () => {
      setManagedEnv({
        GATEWAY_HOST: 'gateway.example.com',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      const env = getGatewayDeployEnv()

      expect(env.GATEWAY_HOST).toBe('gateway.example.com')
      expect(env.HOME).toBe('/tmp/test-home')
      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.SSH_AUTH_SOCK).toBe('/tmp/test-sock')
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      setManagedEnv({
        GATEWAY_HOST: 'gateway.example.com',
        HOME: '/tmp/test-home',
        PATH: '/usr/bin:/bin',
        SSH_AUTH_SOCK: undefined,
      })

      expect(() => getGatewayDeployEnv()).toThrow('SSH_AUTH_SOCK')
    })

    it('throws when PATH is missing', () => {
      setManagedEnv({
        GATEWAY_HOST: 'gateway.example.com',
        HOME: '/tmp/test-home',
        PATH: undefined,
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(() => getGatewayDeployEnv()).toThrow('PATH')
    })

    it('passes required gateway env vars to the child process', () => {
      setManagedEnv({
        AWS_ACCESS_KEY_ID: 'test-key-id',
        AWS_SECRET_ACCESS_KEY: 'test-secret',
        DISCORD_APPLICATION_ID: 'test-app-id',
        DISCORD_GUILD_ID: 'test-guild-id',
        DISCORD_TOKEN: 'test-token',
        GATEWAY_HOST: 'gateway.example.com',
        HOME: '/tmp/test-home',
        OBJECT_STORE_HOSTS: undefined,
        PATH: '/usr/bin:/bin',
        S3_BUCKET: 'test-bucket',
        S3_ENDPOINT: undefined,
        S3_REGION: 'us-east-1',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      const env = getGatewayDeployEnv()

      expect(env.DISCORD_TOKEN).toBe('test-token')
      expect(env.AWS_ACCESS_KEY_ID).toBe('test-key-id')
      expect(env.AWS_SECRET_ACCESS_KEY).toBe('test-secret')
      expect(env.DISCORD_APPLICATION_ID).toBe('test-app-id')
      expect(env.DISCORD_GUILD_ID).toBe('test-guild-id')
      expect(env.S3_BUCKET).toBe('test-bucket')
      expect(env.S3_REGION).toBe('us-east-1')
      expect(env.GATEWAY_HOST).toBe('gateway.example.com')
      // Optional vars present (empty string when unset)
      expect(env.S3_ENDPOINT).toBe('')
      expect(env.OBJECT_STORE_HOSTS).toBe('')
      // Core vars still present
      expect(env.PATH).toBe('/usr/bin:/bin')
      expect(env.HOME).toBe('/tmp/test-home')
      expect(env.SSH_AUTH_SOCK).toBe('/tmp/test-sock')
    })

    it('forwards S3_ENDPOINT and OBJECT_STORE_HOSTS when present in process.env', () => {
      setManagedEnv({
        GATEWAY_HOST: 'gateway.example.com',
        HOME: '/tmp/test-home',
        OBJECT_STORE_HOSTS: 'r2.example.com minio.example.com',
        PATH: '/usr/bin:/bin',
        S3_ENDPOINT: 'https://r2.example.com',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      const env = getGatewayDeployEnv()

      expect(env.S3_ENDPOINT).toBe('https://r2.example.com')
      expect(env.OBJECT_STORE_HOSTS).toBe('r2.example.com minio.example.com')
    })
  })

  describe('validateGatewayRemotePreconditions', () => {
    it('throws when gh is not available', () => {
      const spy = spyOn(Bun, 'which').mockReturnValue(null)

      try {
        expect(() => validateGatewayRemotePreconditions()).toThrow('gh')
      } finally {
        spy.mockRestore()
      }
    })

    it('does not throw when gh is available', () => {
      const spy = spyOn(Bun, 'which').mockReturnValue('/usr/bin/gh')

      try {
        expect(() => validateGatewayRemotePreconditions()).not.toThrow()
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
      expect(stdout).toContain('Deploy Gateway')
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

  describe('--local --force-recreate --dry-run', () => {
    it('includes --force-recreate in the planned command', async () => {
      const {stdout, exitCode} = await runDeployCommand(['--local', '--force-recreate', '--dry-run'], {
        HOME: '/tmp/test-home',
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        SSH_AUTH_SOCK: '/tmp/test-sock',
      })

      expect(exitCode).toBe(0)
      expect(stdout).toContain('--force-recreate')
    })
  })
})
