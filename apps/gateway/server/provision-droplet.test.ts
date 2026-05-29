import {existsSync} from 'node:fs'

import {dropletExists} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {validateGatewayHost} from '../src/host'
import {
  checkDropletExistence,
  establishSshAccess,
  getGatewaySshFingerprint,
  parseProvisionArgs,
  validateRequiredEnv,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['DIGITALOCEAN_ACCESS_TOKEN', 'GATEWAY_HOST', 'GATEWAY_SSH_KEY', 'GATEWAY_SSH_KEY_NAME'] as const
type ManagedEnvKey = (typeof managedEnvKeys)[number]

let savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>

function saveEnv(): void {
  savedEnv = Object.fromEntries(managedEnvKeys.map(k => [k, process.env[k]]))
}

function restoreEnv(): void {
  for (const key of managedEnvKeys) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

// ---------------------------------------------------------------------------
// Spawn mock helpers
// ---------------------------------------------------------------------------

interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawnResult(stdout: string, exitCode: number): SpawnResult {
  const enc = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  }
}

// A fake private key for testing — not a real key, just realistic shape
const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakebase64content\n-----END OPENSSH PRIVATE KEY-----'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provision-droplet', () => {
  beforeEach(() => {
    saveEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  // -------------------------------------------------------------------------
  // validateRequiredEnv
  // -------------------------------------------------------------------------

  describe('validateRequiredEnv', () => {
    it('returns empty array when all required vars are present', () => {
      const missing = validateRequiredEnv({
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
        GATEWAY_HOST: 'gateway.example.com',
      })

      expect(missing).toEqual([])
    })

    it('returns DIGITALOCEAN_ACCESS_TOKEN when it is missing', () => {
      const missing = validateRequiredEnv({
        GATEWAY_HOST: 'gateway.example.com',
      })

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
    })

    it('returns GATEWAY_HOST when it is missing', () => {
      const missing = validateRequiredEnv({
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
      })

      expect(missing).toContain('GATEWAY_HOST')
    })

    it('returns both vars when both are missing', () => {
      const missing = validateRequiredEnv({})

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
      expect(missing).toContain('GATEWAY_HOST')
    })
  })

  // -------------------------------------------------------------------------
  // dropletExists (gateway-specific usage)
  // -------------------------------------------------------------------------

  describe('dropletExists', () => {
    it('returns true when the gateway droplet is listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('gateway')

      expect(result).toBe(true)
      spawnSpy.mockRestore()
    })

    it('returns false when the gateway droplet is not listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('other-droplet\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('gateway')

      expect(result).toBe(false)
      spawnSpy.mockRestore()
    })

    it('returns false when the droplet list is empty', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(makeSpawnResult('', 0) as ReturnType<typeof Bun.spawn>)

      const result = await dropletExists('gateway')

      expect(result).toBe(false)
      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // checkDropletExistence
  // -------------------------------------------------------------------------

  describe('checkDropletExistence', () => {
    it('returns machine-readable existence state without provisioning side effects', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const state = await checkDropletExistence('gateway')

      expect(state).toEqual({name: 'gateway', exists: true})
      expect(spawnSpy).toHaveBeenCalledTimes(1)
      expect(spawnSpy.mock.calls[0]?.[0]).toEqual([
        'doctl',
        'compute',
        'droplet',
        'list',
        '--format',
        'Name',
        '--no-header',
      ])

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // parseProvisionArgs
  // -------------------------------------------------------------------------

  describe('parseProvisionArgs', () => {
    it('parses supported flags', () => {
      expect(parseProvisionArgs(['--force', '--check-exists'])).toEqual({force: true, checkExists: true})
      expect(parseProvisionArgs([])).toEqual({force: false, checkExists: false})
    })

    it('rejects unknown arguments instead of silently ignoring them', () => {
      expect(() => parseProvisionArgs(['--check'])).toThrow(/Unknown provision argument/)
    })
  })

  // -------------------------------------------------------------------------
  // getGatewaySshFingerprint (gateway-specific wrapper)
  // -------------------------------------------------------------------------

  const MULTI_KEY_OUTPUT = [
    'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
    'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
    'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
    'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
  ].join('\n')

  describe('getGatewaySshFingerprint', () => {
    it('uses fro-bot-gateway as the default key name when no argument is provided', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint()

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('uses GATEWAY_SSH_KEY_NAME env var when no argument is passed', async () => {
      process.env.GATEWAY_SSH_KEY_NAME = 'custom-key-name'

      const customKeyOutput = [
        'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
        'custom-key-name                                       aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(customKeyOutput, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint()

      expect(fp).toBe('aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99')
      expect(fp).not.toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('matches the named key when explicitly passed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getGatewaySshFingerprint('fro-bot-gateway')

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')
      expect(fp).not.toBe('91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9')

      spawnSpy.mockRestore()
    })

    it('throws when the named key is not found', async () => {
      const threeOtherKeys = [
        'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
        'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
        'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValueOnce(
        makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>,
      )

      await expect(getGatewaySshFingerprint('fro-bot-gateway')).rejects.toThrow(/not found/)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // validateGatewayHost — provision script must call this before pinHostKeys
  // -------------------------------------------------------------------------

  describe('validateGatewayHost (provision security invariant)', () => {
    it('accepts a valid hostname', () => {
      expect(validateGatewayHost('gateway.example.com')).toBe('gateway.example.com')
    })

    it('throws on empty string', () => {
      expect(() => validateGatewayHost('')).toThrow(/empty/)
    })

    it('throws on a value starting with a dash (ssh flag injection)', () => {
      expect(() => validateGatewayHost('-oProxyCommand=evil')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing shell metacharacters (semicolon)', () => {
      expect(() => validateGatewayHost('host;rm -rf /')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing a space', () => {
      expect(() => validateGatewayHost('host name')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing backtick command substitution', () => {
      expect(() => validateGatewayHost('host`id`')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('throws on a value containing a newline', () => {
      expect(() => validateGatewayHost('host\nENVFILE\nevil')).toThrow(/Invalid GATEWAY_HOST/)
    })
  })

  // -------------------------------------------------------------------------
  // Integration-level: idempotency guard (no --force)
  // -------------------------------------------------------------------------

  describe('idempotency guard', () => {
    it('dropletExists returns true → caller can detect and abort without --force', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('gateway')
      expect(exists).toBe(true)

      // Simulate the abort logic: exists && !force → would exit
      const force = false
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(true)

      spawnSpy.mockRestore()
    })

    it('dropletExists returns true but --force bypasses the guard', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('gateway\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('gateway')
      expect(exists).toBe(true)

      const force = true
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(false)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // establishSshAccess — SSH identity seam
  // -------------------------------------------------------------------------

  describe('SSH access establishment', () => {
    it('passes identity file to waitForSsh when key material is provided', async () => {
      let capturedPath: string | undefined
      let fileExistedDuringCall = false

      const fakeWaitForSsh = async (host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
        // Assert the file actually exists at call time (before finally cleanup)
        fileExistedDuringCall = capturedPath !== undefined && existsSync(capturedPath)
        expect(host).toBe('1.2.3.4')
      }

      await establishSshAccess('1.2.3.4', FAKE_PRIVATE_KEY, {waitForSsh: fakeWaitForSsh})

      // Path must have been a non-empty string
      expect(capturedPath).toBeTruthy()
      expect(capturedPath).not.toBe('')
      // The file must have existed at the moment waitForSsh was called
      expect(fileExistedDuringCall).toBe(true)
      // After the call, the finally block must have cleaned it up
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('does not pass identity file to waitForSsh when no key material is given', async () => {
      const capturedOpts: ({identityFile?: string} | undefined)[] = []
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedOpts.push(opts)
      }

      await establishSshAccess('1.2.3.4', undefined, {waitForSsh: fakeWaitForSsh})

      expect(capturedOpts).toHaveLength(1)
      expect(capturedOpts[0]?.identityFile).toBeUndefined()
    })

    it('cleans up the temp key file even when waitForSsh throws', async () => {
      let capturedPath: string | undefined
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
        throw new Error('SSH connection failed')
      }

      await expect(establishSshAccess('1.2.3.4', FAKE_PRIVATE_KEY, {waitForSsh: fakeWaitForSsh})).rejects.toThrow(
        'SSH connection failed',
      )

      // File must be cleaned up even though waitForSsh threw
      expect(capturedPath).toBeTruthy()
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('does not create a temp file when no key material is provided', async () => {
      let capturedPath: string | undefined
      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
      }

      await establishSshAccess('1.2.3.4', undefined, {waitForSsh: fakeWaitForSsh})

      expect(capturedPath).toBeUndefined()
    })
  })
})
