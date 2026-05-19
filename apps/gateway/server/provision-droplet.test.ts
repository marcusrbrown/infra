import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  checkDropletExistence,
  dropletExists,
  getSshFingerprint,
  parseProvisionArgs,
  pinHostKeys,
  validateDoctl,
  validateRequiredEnv,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['DIGITALOCEAN_ACCESS_TOKEN', 'GATEWAY_HOST'] as const
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

function makeSpawnResultWithStderr(stderr: string, exitCode: number): SpawnResult {
  const enc = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(controller) {
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode(stderr))
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
  // validateDoctl
  // -------------------------------------------------------------------------

  describe('validateDoctl', () => {
    it('throws when doctl is not on PATH', () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue(null)

      expect(() => validateDoctl()).toThrow(/doctl is required/)

      whichSpy.mockRestore()
    })

    it('does not throw when doctl is available', () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue('/usr/local/bin/doctl')

      expect(() => validateDoctl()).not.toThrow()

      whichSpy.mockRestore()
    })
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
  // dropletExists
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
  // pinHostKeys
  // -------------------------------------------------------------------------

  describe('pinHostKeys', () => {
    let tmpDir: string
    let knownHostsPath: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'gateway-test-'))
      knownHostsPath = join(tmpDir, 'known_hosts')
      writeFileSync(knownHostsPath, '')
    })

    it('appends domain and IP host key entries to known_hosts', async () => {
      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(
          makeSpawnResult('gateway.example.com ssh-ed25519 AAAA...domain', 0) as ReturnType<typeof Bun.spawn>,
        )
        .mockReturnValueOnce(makeSpawnResult('|1|hash== ssh-ed25519 AAAA...ip', 0) as ReturnType<typeof Bun.spawn>)

      await pinHostKeys('gateway.example.com', '1.2.3.4', knownHostsPath)

      const contents = readFileSync(knownHostsPath, 'utf-8')
      expect(contents).toContain('gateway.example.com ssh-ed25519')
      expect(contents).toContain('|1|hash==')

      spawnSpy.mockRestore()
    })

    it('skips append when entries for this host already exist (idempotency)', async () => {
      // Pre-populate with the marker
      writeFileSync(
        knownHostsPath,
        '# gateway droplet (1.2.3.4 / gateway.example.com)\ngateway.example.com ssh-ed25519 AAAA...\n',
      )

      const spawnSpy = spyOn(Bun, 'spawn')

      await pinHostKeys('gateway.example.com', '1.2.3.4', knownHostsPath)

      // spawn should NOT have been called (no ssh-keyscan needed)
      expect(spawnSpy).not.toHaveBeenCalled()

      const contents = readFileSync(knownHostsPath, 'utf-8')
      // File should be unchanged — only one occurrence of the marker
      expect(contents.split('# gateway droplet').length).toBe(2) // 1 split = 2 parts

      spawnSpy.mockRestore()
    })

    it('throws when ssh-keyscan fails for the domain', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('ssh-keyscan: getaddrinfo for host gateway.example.com failed', 1) as ReturnType<
          typeof Bun.spawn
        >,
      )

      await expect(pinHostKeys('gateway.example.com', '1.2.3.4', knownHostsPath)).rejects.toThrow()

      spawnSpy.mockRestore()
    })
  })

  // -------------------------------------------------------------------------
  // getSshFingerprint
  // -------------------------------------------------------------------------

  // Real doctl output uses multi-space padding between Name and FingerPrint columns.
  // The Name column can contain spaces, @, and dots — so we parse last-field-is-fingerprint.
  const MULTI_KEY_OUTPUT = [
    'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
    'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
    'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
    'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
  ].join('\n')

  describe('getSshFingerprint', () => {
    it('matches gateway-specific key when multiple keys exist', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getSshFingerprint('fro-bot-gateway')

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')
      // Must NOT return the first key's fingerprint
      expect(fp).not.toBe('91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9')

      spawnSpy.mockRestore()
    })

    it('picks the named key even when it is the only row', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(
          'fro-bot-gateway                                       e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
          0,
        ) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getSshFingerprint('fro-bot-gateway')

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
    })

    it('throws with a clear message when the named key is not found', async () => {
      const threeOtherKeys = [
        'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
        'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
        'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(makeSpawnResult(threeOtherKeys, 0) as ReturnType<typeof Bun.spawn>)

      await expect(getSshFingerprint('fro-bot-gateway')).rejects.toThrow(/not found/)
      await expect(getSshFingerprint('fro-bot-gateway')).rejects.toThrow(/GATEWAY_SSH_KEY_NAME/)
      await expect(getSshFingerprint('fro-bot-gateway')).rejects.toThrow(/fro-bot-gateway/)

      spawnSpy.mockRestore()
    })

    it('throws with a clear message when the key list is empty', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(makeSpawnResult('', 0) as ReturnType<typeof Bun.spawn>)

      await expect(getSshFingerprint('fro-bot-gateway')).rejects.toThrow(/not found/)

      spawnSpy.mockRestore()
    })

    it('throws on doctl non-zero exit', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('unauthorized', 1) as ReturnType<typeof Bun.spawn>,
      )

      await expect(getSshFingerprint('fro-bot-gateway')).rejects.toThrow(/unauthorized/)

      spawnSpy.mockRestore()
    })

    it('uses fro-bot-gateway as the default key name when no argument is provided', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )

      const fp = await getSshFingerprint()

      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')

      spawnSpy.mockRestore()
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
})
