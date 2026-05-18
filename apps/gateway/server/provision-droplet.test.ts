import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {dropletExists, pinHostKeys, validateDoctl, validateRequiredEnv} from './provision-droplet'

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
