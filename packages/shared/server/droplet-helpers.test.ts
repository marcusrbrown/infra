import {mkdtempSync, readFileSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  pinHostKeys,
  runCapture,
  scp,
  sleep,
  ssh,
  validateDoctl,
  waitForSsh,
} from './droplet-helpers'

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
// Spy lifecycle management
// ---------------------------------------------------------------------------

// Track spies so they're restored even if a test throws.
const spies: {mockRestore: () => void}[] = []

afterEach(() => {
  while (spies.length) {
    spies.pop()?.mockRestore()
  }
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('droplet-helpers', () => {
  // -------------------------------------------------------------------------
  // Pure logic: ssh
  // -------------------------------------------------------------------------

  describe('ssh', () => {
    it('returns the exact 8-element array with all 3 -o flag pairs and user@host', () => {
      const result = ssh('1.2.3.4', 'echo hello', 'root')
      expect(result).toEqual([
        'ssh',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        'root@1.2.3.4',
        'echo hello',
      ])
    })

    it('uses the provided user in user@host', () => {
      const result = ssh('example.com', 'ls', 'deploy-user')
      expect(result[7]).toBe('deploy-user@example.com')
    })
  })

  // -------------------------------------------------------------------------
  // Pure logic: scp
  // -------------------------------------------------------------------------

  describe('scp', () => {
    it('returns the exact 8-element array with all 3 -o flag pairs', () => {
      const result = scp('1.2.3.4', '/local/file', '/remote/path', 'root')
      expect(result).toEqual([
        'scp',
        '-o',
        'BatchMode=yes',
        '-o',
        'StrictHostKeyChecking=accept-new',
        '-o',
        'ConnectTimeout=10',
        '/local/file',
        'root@1.2.3.4:/remote/path',
      ])
    })

    it('uses the provided user in user@host:target', () => {
      const result = scp('host.example.com', '/src', '/dst', 'myuser')
      expect(result[8]).toBe('myuser@host.example.com:/dst')
    })
  })

  // -------------------------------------------------------------------------
  // Pure logic: sleep
  // -------------------------------------------------------------------------

  describe('sleep', () => {
    it('resolves after at least the specified milliseconds', async () => {
      const start = Date.now()
      await sleep(10)
      const elapsed = Date.now() - start
      expect(elapsed).toBeGreaterThanOrEqual(9) // allow 1ms tolerance
    })
  })

  // -------------------------------------------------------------------------
  // validateDoctl
  // -------------------------------------------------------------------------

  describe('validateDoctl', () => {
    it('throws with install URL when doctl is not on PATH', async () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue(null)
      spies.push(whichSpy)

      await expect(validateDoctl()).rejects.toThrow(/doctl is required/)
      await expect(validateDoctl()).rejects.toThrow(/https:\/\/docs\.digitalocean\.com/)
    })

    it('does not call spawn when doctl is found (no-arg form)', async () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue('/usr/local/bin/doctl')
      const spawnSpy = spyOn(Bun, 'spawn')
      spies.push(whichSpy, spawnSpy)

      await validateDoctl()

      expect(spawnSpy).not.toHaveBeenCalled()
    })

    it('runs doctl account get when checkAuth is true', async () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue('/usr/local/bin/doctl')
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('account info', 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(whichSpy, spawnSpy)

      await validateDoctl({checkAuth: true})

      expect(spawnSpy).toHaveBeenCalledTimes(1)
      const cmd = spawnSpy.mock.calls[0]?.[0] as string[]
      expect(cmd).toContain('doctl')
      expect(cmd).toContain('account')
      expect(cmd).toContain('get')
    })

    it('throws when doctl account get returns non-zero', async () => {
      const whichSpy = spyOn(Bun, 'which').mockReturnValue('/usr/local/bin/doctl')
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('unauthorized', 1) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(whichSpy, spawnSpy)

      await expect(validateDoctl({checkAuth: true})).rejects.toThrow(/unauthorized/)
    })
  })

  // -------------------------------------------------------------------------
  // runCapture
  // -------------------------------------------------------------------------

  describe('runCapture', () => {
    it('returns trimmed stdout on exit 0', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('  hello world  \n', 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const result = await runCapture(['echo', 'hello world'])
      expect(result).toBe('hello world')
    })

    it('throws with stderr text on non-zero exit', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('something went wrong', 1) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      await expect(runCapture(['false'])).rejects.toThrow(/something went wrong/)
    })
  })

  // -------------------------------------------------------------------------
  // dropletExists
  // -------------------------------------------------------------------------

  describe('dropletExists', () => {
    it('returns true when name is in stdout', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('cliproxy\nother-droplet\n', 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const result = await dropletExists('cliproxy')
      expect(result).toBe(true)
    })

    it('returns false when name is not in stdout', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('other-droplet\n', 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const result = await dropletExists('cliproxy')
      expect(result).toBe(false)
    })

    it('throws when doctl fails', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('doctl error', 1) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      await expect(dropletExists('cliproxy')).rejects.toThrow()
    })
  })

  // -------------------------------------------------------------------------
  // getSshFingerprint
  // -------------------------------------------------------------------------

  const MULTI_KEY_OUTPUT = [
    'UltraVisor                                            91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9',
    'ShellFish@Marcus-iPad-01052022                        d4:a0:81:f4:7c:ba:17:f5:71:6a:17:75:e3:20:19:2e',
    'id_rsa-root@monica.marcusrbrown.com via hypervisor    b8:02:e3:70:3a:6a:60:45:09:e0:8b:01:d8:09:43:22',
    'fro-bot-cliproxy                                      e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
  ].join('\n')

  describe('getSshFingerprint', () => {
    it('finds the row matching name and returns the fingerprint', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const fp = await getSshFingerprint('fro-bot-cliproxy')
      expect(fp).toBe('e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b')
      // Must NOT return the first key's fingerprint
      expect(fp).not.toBe('91:53:2a:06:50:89:54:68:e6:c5:fd:c4:1a:c5:87:c9')
    })

    it('supports key names with internal whitespace', async () => {
      const spacedKeyOutput = [
        'fro-bot-cliproxy                                      e0:8f:0d:fa:d1:b3:ab:b4:83:9b:06:b6:20:82:91:2b',
        'my key with spaces                                    11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00',
        'another-key                                           ff:ee:dd:cc:bb:aa:99:88:77:66:55:44:33:22:11:00',
      ].join('\n')

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult(spacedKeyOutput, 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const fp = await getSshFingerprint('my key with spaces')
      expect(fp).toBe('11:22:33:44:55:66:77:88:99:aa:bb:cc:dd:ee:ff:00')
    })

    it('throws a helpful error mentioning the key name when not found', async () => {
      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(makeSpawnResult(MULTI_KEY_OUTPUT, 0) as ReturnType<typeof Bun.spawn>)
      spies.push(spawnSpy)

      await expect(getSshFingerprint('nonexistent-key')).rejects.toThrow(/nonexistent-key/)
      await expect(getSshFingerprint('nonexistent-key')).rejects.toThrow(/not found/)
    })

    it('throws on doctl non-zero exit', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResultWithStderr('unauthorized', 1) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      await expect(getSshFingerprint('fro-bot-cliproxy')).rejects.toThrow(/unauthorized/)
    })
  })

  // -------------------------------------------------------------------------
  // getDropletIpWithWait
  // -------------------------------------------------------------------------

  describe('getDropletIpWithWait', () => {
    it('returns IP on first attempt when doctl returns IP', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(
        makeSpawnResult('1.2.3.4', 0) as ReturnType<typeof Bun.spawn>,
      )
      spies.push(spawnSpy)

      const ip = await getDropletIpWithWait('cliproxy', {maxAttempts: 2, intervalMs: 1})
      expect(ip).toBe('1.2.3.4')
    })

    it('times out and throws after maxAttempts when doctl returns empty', async () => {
      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(makeSpawnResult('', 0) as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(makeSpawnResult('', 0) as ReturnType<typeof Bun.spawn>)
      spies.push(spawnSpy)

      await expect(getDropletIpWithWait('cliproxy', {maxAttempts: 2, intervalMs: 1})).rejects.toThrow(/Timed out/)
    })
  })

  // -------------------------------------------------------------------------
  // waitForSsh
  // -------------------------------------------------------------------------

  describe('waitForSsh', () => {
    it('resolves when spawn returns exit 0', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue(makeSpawnResult('ready', 0) as ReturnType<typeof Bun.spawn>)
      spies.push(spawnSpy)

      await expect(waitForSsh('1.2.3.4', 'root', {maxAttempts: 2, intervalMs: 1})).resolves.toBeUndefined()
    })

    it('throws after maxAttempts when spawn returns non-zero each time', async () => {
      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(makeSpawnResult('', 1) as ReturnType<typeof Bun.spawn>)
        .mockReturnValueOnce(makeSpawnResult('', 1) as ReturnType<typeof Bun.spawn>)
      spies.push(spawnSpy)

      await expect(waitForSsh('1.2.3.4', 'root', {maxAttempts: 2, intervalMs: 1})).rejects.toThrow(/Timed out/)
    })
  })

  // -------------------------------------------------------------------------
  // pinHostKeys
  // -------------------------------------------------------------------------

  describe('pinHostKeys', () => {
    let tmpDir: string
    let knownHostsPath: string

    beforeEach(() => {
      tmpDir = mkdtempSync(join(tmpdir(), 'shared-test-'))
      knownHostsPath = join(tmpDir, 'known_hosts')
      writeFileSync(knownHostsPath, '')
    })

    it('writes both unhashed domain and hashed IP keys to known_hosts', async () => {
      const spawnSpy = spyOn(Bun, 'spawn')
        .mockReturnValueOnce(
          makeSpawnResult('example.com ssh-ed25519 AAAA...domain', 0) as ReturnType<typeof Bun.spawn>,
        )
        .mockReturnValueOnce(makeSpawnResult('|1|hash== ssh-ed25519 AAAA...ip', 0) as ReturnType<typeof Bun.spawn>)
      spies.push(spawnSpy)

      await pinHostKeys('example.com', '1.2.3.4', knownHostsPath, {
        marker: '# cliproxy droplet (1.2.3.4 / example.com)',
      })

      const contents = readFileSync(knownHostsPath, 'utf-8')
      expect(contents).toContain('example.com ssh-ed25519')
      expect(contents).toContain('|1|hash==')
      expect(contents).toContain('# cliproxy droplet (1.2.3.4 / example.com)')
    })

    it('is idempotent when marker already present — no-op', async () => {
      const marker = '# cliproxy droplet (1.2.3.4 / example.com)'
      writeFileSync(knownHostsPath, `${marker}\nexample.com ssh-ed25519 AAAA...\n`)

      const spawnSpy = spyOn(Bun, 'spawn')
      spies.push(spawnSpy)

      await pinHostKeys('example.com', '1.2.3.4', knownHostsPath, {marker})

      expect(spawnSpy).not.toHaveBeenCalled()
      const contents = readFileSync(knownHostsPath, 'utf-8')
      expect(contents.split(marker).length).toBe(2) // only one occurrence
    })
  })
})
