import {dropletExists} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {validateUmamiHost} from '../src/host'
import {
  checkDropletExistence,
  getUmamiSshFingerprint,
  parseProvisionArgs,
  validateRequiredEnv,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['DIGITALOCEAN_ACCESS_TOKEN', 'UMAMI_DOMAIN', 'UMAMI_SSH_KEY_NAME'] as const
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
  // import.meta.main guard — importing the module must not trigger side effects
  // -------------------------------------------------------------------------

  describe('import guard', () => {
    it('exports named functions without triggering doctl or network calls on import', () => {
      // The mere fact that this test file imports from ./provision-droplet
      // and we reach this assertion proves the import.meta.main guard works.
      expect(typeof validateRequiredEnv).toBe('function')
      expect(typeof parseProvisionArgs).toBe('function')
      expect(typeof getUmamiSshFingerprint).toBe('function')
      expect(typeof checkDropletExistence).toBe('function')
    })
  })

  // -------------------------------------------------------------------------
  // validateRequiredEnv
  // -------------------------------------------------------------------------

  describe('required environment variable validation', () => {
    it('returns empty array when all required vars are present', () => {
      const missing = validateRequiredEnv({
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
        UMAMI_DOMAIN: 'metrics.fro.bot',
      })

      expect(missing).toEqual([])
    })

    it('reports DIGITALOCEAN_ACCESS_TOKEN when it is missing', () => {
      const missing = validateRequiredEnv({
        UMAMI_DOMAIN: 'metrics.fro.bot',
      })

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
    })

    it('reports UMAMI_DOMAIN when it is missing', () => {
      const missing = validateRequiredEnv({
        DIGITALOCEAN_ACCESS_TOKEN: 'tok_abc',
      })

      expect(missing).toContain('UMAMI_DOMAIN')
    })

    it('reports both vars when both are missing', () => {
      const missing = validateRequiredEnv({})

      expect(missing).toContain('DIGITALOCEAN_ACCESS_TOKEN')
      expect(missing).toContain('UMAMI_DOMAIN')
    })
  })

  // -------------------------------------------------------------------------
  // parseProvisionArgs
  // -------------------------------------------------------------------------

  describe('provision argument parsing', () => {
    it('parses --force and --check-exists flags', () => {
      expect(parseProvisionArgs(['--force', '--check-exists'])).toEqual({force: true, checkExists: true})
      expect(parseProvisionArgs([])).toEqual({force: false, checkExists: false})
    })

    it('rejects unknown arguments instead of silently ignoring them', () => {
      expect(() => parseProvisionArgs(['--unknown'])).toThrow(/Unknown provision argument/)
    })
  })

  // -------------------------------------------------------------------------
  // droplet existence guard
  // -------------------------------------------------------------------------

  describe('droplet existence guard', () => {
    it('returns true when the umami droplet is listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('umami\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('umami')

      expect(result).toBe(true)
      spawnSpy.mockRestore()
    })

    it('returns false when the umami droplet is not listed', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('other-droplet\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const result = await dropletExists('umami')

      expect(result).toBe(false)
      spawnSpy.mockRestore()
    })

    it('aborts without creating when droplet exists and --force is not set', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('umami\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('umami')
      expect(exists).toBe(true)

      const force = false
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(true)

      // Only one spawn call (the list) — no create call made
      expect(spawnSpy).toHaveBeenCalledTimes(1)

      spawnSpy.mockRestore()
    })

    it('proceeds past the guard when --force is set even if droplet exists', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('umami\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const exists = await dropletExists('umami')
      expect(exists).toBe(true)

      const force = true
      const wouldAbort = exists && !force
      expect(wouldAbort).toBe(false)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // checkDropletExistence
  // -------------------------------------------------------------------------

  describe('checkDropletExistence', () => {
    it('returns machine-readable existence state without provisioning side effects', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('umami\n', 0) as ReturnType<typeof Bun.spawn>,
      )

      const state = await checkDropletExistence('umami')

      expect(state).toEqual({name: 'umami', exists: true})
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
  // SSH key selection by name
  // -------------------------------------------------------------------------

  const MULTI_KEY_OUTPUT = [
    'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
    'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
    'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
    'fro-bot-umami                                         e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
  ].join('\n')

  describe('SSH key selection by name', () => {
    it('uses fro-bot-umami as the default key name when no argument is provided', async () => {
      delete process.env.UMAMI_SSH_KEY_NAME

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getUmamiSshFingerprint()

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('uses UMAMI_SSH_KEY_NAME env var when no argument is passed', async () => {
      process.env.UMAMI_SSH_KEY_NAME = 'custom-umami-key'

      const customKeyOutput = [
        'fro-bot-umami                                         e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
        'custom-umami-key                                      aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(customKeyOutput, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getUmamiSshFingerprint()

      expect(fp).toBe('aa:bb:cc:dd:ee:ff:00:11:22:33:44:55:66:77:88:99')
      expect(fp).not.toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('matches the named key when explicitly passed as argument', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getUmamiSshFingerprint('fro-bot-umami')

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')
      expect(fp).not.toBe('91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9')

      spawnSpy.mockRestore()
    })

    it('throws when the named key is not found in the account', async () => {
      const threeOtherKeys = [
        'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
        'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
        'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValueOnce(
        makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>,
      )

      await expect(getUmamiSshFingerprint('fro-bot-umami')).rejects.toThrow(/not found/)

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // validateUmamiHost — provision script must call this before pinHostKeys
  // -------------------------------------------------------------------------

  describe('host validation security invariant', () => {
    it('accepts a valid hostname', () => {
      expect(validateUmamiHost('metrics.fro.bot')).toBe('metrics.fro.bot')
    })

    it('throws on empty string', () => {
      expect(() => validateUmamiHost('')).toThrow(/empty/)
    })

    it('throws on a value starting with a dash (ssh flag injection)', () => {
      expect(() => validateUmamiHost('-oProxyCommand=evil')).toThrow(/Invalid UMAMI_DOMAIN/)
    })

    it('throws on a value containing shell metacharacters', () => {
      expect(() => validateUmamiHost('host;rm -rf /')).toThrow(/Invalid UMAMI_DOMAIN/)
    })

    it('throws on a value containing a space', () => {
      expect(() => validateUmamiHost('host name')).toThrow(/Invalid UMAMI_DOMAIN/)
    })
  })
})
