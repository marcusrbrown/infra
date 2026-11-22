import {existsSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {SSH_SCAN_PAUSE_MS} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  performProvisioning,
  resolveProvisionIdentity,
  writeManagementKeyFile,
  writeRemoteEnvFile,
  type PerformProvisioningDeps,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['BROKER_DOMAIN', 'BROKER_SSH_KEY'] as const
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

// A fake private key for testing — not a real key, just realistic shape
const FAKE_PRIVATE_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakebase64content\n-----END OPENSSH PRIVATE KEY-----'

// Deps that keep a test off the network and off the clock: no pause, no `ssh -O exit`, no scan.
const OFFLINE = {
  hostKeysPinned: () => false,
  sleep: async () => {},
  withControl: async (_host, _user, body) => body({path: '/tmp/fake-cm/cm', persist: '120s'}),
} satisfies Partial<PerformProvisioningDeps>

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('provision-droplet (broker)', () => {
  beforeEach(() => {
    saveEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  // ---------------------------------------------------------------------------
  // resolveProvisionIdentity — identity materialization helper
  // ---------------------------------------------------------------------------

  describe('resolveProvisionIdentity', () => {
    it('returns a temp file path when key material is provided', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(FAKE_PRIVATE_KEY)
      try {
        expect(identityFile).toBeTruthy()
        expect(identityFile).not.toBe('')
        expect(existsSync(identityFile ?? '')).toBe(true)
      } finally {
        cleanup()
      }
    })

    it('cleanup removes the temp file', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(FAKE_PRIVATE_KEY)
      expect(existsSync(identityFile ?? '')).toBe(true)
      cleanup()
      expect(existsSync(identityFile ?? '')).toBe(false)
    })

    it('cleanup is idempotent — calling twice does not throw', () => {
      const {cleanup} = resolveProvisionIdentity(FAKE_PRIVATE_KEY)
      cleanup()
      expect(() => cleanup()).not.toThrow()
    })

    it('returns no identityFile and a no-op cleanup when key material is absent', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity(undefined)
      expect(identityFile).toBeUndefined()
      expect(() => cleanup()).not.toThrow()
    })

    it('treats a whitespace-only key as absent — no temp file, no-op cleanup', () => {
      const {identityFile, cleanup} = resolveProvisionIdentity('   \n  ')
      expect(identityFile).toBeUndefined()
      expect(() => cleanup()).not.toThrow()
    })
  })

  // ---------------------------------------------------------------------------
  // performProvisioning — idempotency and secret-in-stdin assertions
  // ---------------------------------------------------------------------------

  describe('performProvisioning — orchestration seam', () => {
    it('threads identity file through waitForSsh and all helper calls when key is set', async () => {
      const capturedWaitForSsh: {host: string; user: string; identityFile?: string}[] = []
      const capturedCopyComposeFiles: {host: string; identityFile?: string}[] = []
      const capturedWriteRemoteEnvFile: {host: string; identityFile?: string}[] = []
      const capturedDeployCompose: {host: string; identityFile?: string}[] = []

      const fakeWaitForSsh = async (host: string, user: string, opts?: {identityFile?: string}) => {
        capturedWaitForSsh.push({host, user, identityFile: opts?.identityFile})
      }
      const fakeCopyComposeFiles = async (host: string, identityFile?: string) => {
        capturedCopyComposeFiles.push({host, identityFile})
      }
      const fakeWriteRemoteEnvFile = async (
        host: string,
        _mgmtKey: string,
        _brokerHost: string,
        _aud: string,
        identityFile?: string,
      ) => {
        capturedWriteRemoteEnvFile.push({host, identityFile})
      }
      const fakeInstallDocker = async (_host: string, _identityFile?: string) => {}
      const fakeDeployCompose = async (host: string, identityFile?: string) => {
        capturedDeployCompose.push({host, identityFile})
      }

      await performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
        ...OFFLINE,
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        installDocker: fakeInstallDocker,
        deployCompose: fakeDeployCompose,
      })

      // waitForSsh must have received a non-empty identity file path
      expect(capturedWaitForSsh).toHaveLength(1)
      const {identityFile: wsfPath} = capturedWaitForSsh[0] ?? {}
      expect(wsfPath).toBeTruthy()

      // All helpers must receive the same identity file path
      expect(capturedCopyComposeFiles[0]?.identityFile).toBe(wsfPath)
      expect(capturedWriteRemoteEnvFile[0]?.identityFile).toBe(wsfPath)
      expect(capturedDeployCompose[0]?.identityFile).toBe(wsfPath)
    })

    it('does not pass identity file to any helper when no key material is given', async () => {
      const capturedIdentities: (string | undefined)[] = []

      const recordIdentity = (identityFile?: string) => {
        capturedIdentities.push(identityFile)
      }

      await performProvisioning('1.2.3.4', undefined, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
        ...OFFLINE,
        waitForSsh: async (_host, _user, opts) => {
          recordIdentity(opts?.identityFile)
        },
        pinHostKeys: async () => {},
        copyComposeFiles: async (_host, identityFile) => {
          recordIdentity(identityFile)
        },
        writeRemoteEnvFile: async (_host, _mgmtKey, _brokerHost, _aud, identityFile) => {
          recordIdentity(identityFile)
        },
        installDocker: async (_host, identityFile) => {
          recordIdentity(identityFile)
        },
        deployCompose: async (_host, identityFile) => {
          recordIdentity(identityFile)
        },
      })

      // No helper should have received an identity file
      for (const id of capturedIdentities) {
        expect(id).toBeUndefined()
      }
    })

    it('cleans up the temp key file even when a provisioning step throws', async () => {
      let capturedPath: string | undefined

      await expect(
        performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
          ...OFFLINE,
          waitForSsh: async (_host, _user, opts) => {
            capturedPath = opts?.identityFile
            throw new Error('provisioning step failed')
          },
          pinHostKeys: async () => {},
          copyComposeFiles: async () => {},
          writeRemoteEnvFile: async () => {},
          installDocker: async () => {},
          deployCompose: async () => {},
        }),
      ).rejects.toThrow('provisioning step failed')

      // The temp file must have been cleaned up in the finally block
      expect(capturedPath).toBeTruthy()
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('calls pinHostKeys with the broker marker containing the IP and domain', async () => {
      const capturedPinHostKeys: {domain: string; ip: string; marker: string}[] = []

      await performProvisioning('10.0.0.1', undefined, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
        ...OFFLINE,
        waitForSsh: async () => {},
        pinHostKeys: async (domain, ip, _path, opts) => {
          capturedPinHostKeys.push({domain, ip, marker: opts.marker})
        },
        copyComposeFiles: async () => {},
        writeRemoteEnvFile: async () => {},
        installDocker: async () => {},
        deployCompose: async () => {},
      })

      expect(capturedPinHostKeys).toHaveLength(1)
      const pinCall = capturedPinHostKeys[0]
      expect(pinCall?.marker).toContain('10.0.0.1')
      expect(pinCall?.marker).toContain('broker.fro.bot')
      expect(pinCall?.marker).toContain('# broker droplet')
    })

    it('calls waitForSsh before pinHostKeys', async () => {
      const callOrder: string[] = []

      await performProvisioning('1.2.3.4', undefined, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
        ...OFFLINE,
        waitForSsh: async () => {
          callOrder.push('waitForSsh')
        },
        pinHostKeys: async () => {
          callOrder.push('pinHostKeys')
        },
        copyComposeFiles: async () => {},
        writeRemoteEnvFile: async () => {},
        installDocker: async () => {},
        deployCompose: async () => {},
      })

      expect(callOrder.indexOf('waitForSsh')).toBeLessThan(callOrder.indexOf('pinHostKeys'))
    })

    it('existing droplet without --force is not reprovisioned (idempotency via caller)', async () => {
      // The idempotency guard lives in the main provision() function (checks --force flag).
      // performProvisioning itself always runs when called — the caller decides whether to call it.
      // This test verifies that performProvisioning completes without error when called with
      // all-no-op deps (simulating a re-run on an already-provisioned droplet).
      let callCount = 0
      const countingDep = async () => {
        callCount++
      }

      await performProvisioning('1.2.3.4', undefined, 'mgmt-key', 'broker.fro.bot', 'broker-aud', {
        ...OFFLINE,
        waitForSsh: async () => {
          callCount++
        },
        pinHostKeys: async () => {
          callCount++
        },
        copyComposeFiles: countingDep,
        writeRemoteEnvFile: countingDep,
        installDocker: countingDep,
        deployCompose: countingDep,
      })

      // All steps ran exactly once
      expect(callCount).toBe(6)
    })
  })

  // ---------------------------------------------------------------------------
  // writeRemoteEnvFile — secret bytes via stdin, never argv
  // ---------------------------------------------------------------------------

  describe('writeRemoteEnvFile', () => {
    it('pipes the management key through stdin, never in the command argv', async () => {
      const managementKey = 'super-secret-management-key-abc123'
      let capturedStdinWrite = ''

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {
          write: (chunk: string) => {
            capturedStdinWrite += chunk
          },
          end: () => {},
        },
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await writeRemoteEnvFile('1.2.3.4', managementKey, 'broker.fro.bot', 'broker-aud-value')
      const capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]

      spawnSpy.mockRestore()

      // Management key must appear in stdin, never in argv
      expect(capturedStdinWrite).toContain(managementKey)
      expect(capturedArgv?.join(' ')).not.toContain(managementKey)
    })

    it('pipes the broker aud through stdin, never in the command argv', async () => {
      const brokerAud = 'https://broker.fro.bot/oidc-audience-value'
      let capturedStdinWrite = ''

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {
          write: (chunk: string) => {
            capturedStdinWrite += chunk
          },
          end: () => {},
        },
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await writeRemoteEnvFile('1.2.3.4', 'mgmt-key', 'broker.fro.bot', brokerAud)
      const capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]

      spawnSpy.mockRestore()

      // Aud value must appear in stdin, never in argv
      expect(capturedStdinWrite).toContain(brokerAud)
      expect(capturedArgv?.join(' ')).not.toContain(brokerAud)
    })

    it('env file contains CLIPROXY_MANAGEMENT_KEY, BROKER_HOST, and BROKER_AUD', async () => {
      let capturedStdinWrite = ''

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {
          write: (chunk: string) => {
            capturedStdinWrite += chunk
          },
          end: () => {},
        },
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await writeRemoteEnvFile('1.2.3.4', 'test-mgmt-key', 'broker.fro.bot', 'test-aud')

      spawnSpy.mockRestore()

      expect(capturedStdinWrite).toContain('CLIPROXY_MANAGEMENT_KEY=test-mgmt-key')
      expect(capturedStdinWrite).toContain('BROKER_HOST=broker.fro.bot')
      expect(capturedStdinWrite).toContain('BROKER_AUD=test-aud')
    })

    it('rejects with an error when the SSH command fails', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(255),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await expect(writeRemoteEnvFile('1.2.3.4', 'key', 'host', 'aud')).rejects.toThrow(/255/)

      spawnSpy.mockRestore()
    })

    it('passes the identity file to the SSH command when provided', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await writeRemoteEnvFile('1.2.3.4', 'key', 'host', 'aud', '/tmp/fake-key')

      const capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]
      spawnSpy.mockRestore()

      expect(capturedArgv?.join(' ')).toContain('/tmp/fake-key')
    })
  })

  // ---------------------------------------------------------------------------
  // writeManagementKeyFile — writes key to 0600 file, never to stdout
  // ---------------------------------------------------------------------------

  describe('writeManagementKeyFile', () => {
    let testDir: string
    let keyFilePath: string

    beforeEach(() => {
      testDir = join(tmpdir(), `infra-broker-test-${Date.now()}`)
      keyFilePath = join(testDir, '.broker-management-key')
    })

    afterEach(async () => {
      try {
        const {rmSync} = await import('node:fs')
        rmSync(testDir, {recursive: true, force: true})
      } catch {
        // best-effort
      }
    })

    it('writes the management key to the expected file path', async () => {
      const key = 'test-broker-management-key-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      expect(existsSync(result)).toBe(true)
      const contents = await Bun.file(result).text()
      expect(contents).toBe(key)
    })

    it('creates the file with mode 0600 (owner read/write only)', async () => {
      const key = 'test-broker-management-key-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      const stat = statSync(result)
      // 0o600 = 384 decimal; mask with 0o777 to get permission bits only
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('returns the path to the written file', async () => {
      const key = 'test-broker-management-key-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      expect(result).toBe(keyFilePath)
    })

    it('does NOT include the raw key value in the returned path string', async () => {
      const key = 'super-secret-broker-key-xyz789'
      const result = await writeManagementKeyFile(testDir, key)

      // The returned path must not contain the key value
      expect(result).not.toContain(key)
    })
  })
})

// ---------------------------------------------------------------------------
// One SSH connection for the whole provisioning run
// ---------------------------------------------------------------------------
//
// The droplet runs `ufw limit 22/tcp`: the sixth new connection from one source within 30 seconds is refused.
// Provisioning ran mkdir, two scp, the .env write, a docker check and compose up as six separate connections.
// Every one of them goes over one ControlMaster socket now, and the master is closed when the run ends.

describe('provision-droplet (broker) — one shared SSH connection', () => {
  interface Recorded {
    argv: string[]
  }

  let events: string[]
  let calls: Recorded[]
  let spawnSpy: ReturnType<typeof spyOn>
  let logSpy: ReturnType<typeof spyOn>

  const isClose = (argv: string[]): boolean => argv.includes('-O') && argv.includes('exit')
  const controlPathOf = (argv: string[]): string | undefined =>
    argv.find(arg => arg.startsWith('ControlPath='))?.slice('ControlPath='.length)

  /** Spawns nothing. Records each argv; `failOn` makes a matching call exit non-zero. */
  function installSpawn(failOn?: (argv: string[]) => boolean): void {
    const encoder = new TextEncoder()
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((argv: string[]) => {
      calls.push({argv: [...argv]})
      events.push(`spawn:${argv[0]}${isClose(argv) ? ':close' : ''}`)
      const failed = failOn?.(argv) === true
      return {
        stdin: {write: () => {}, end: () => {}},
        stdout: new ReadableStream({
          start(controller) {
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            if (failed) controller.enqueue(encoder.encode('boom'))
            controller.close()
          },
        }),
        exited: Promise.resolve(failed ? 1 : 0),
      }
    }) as unknown as typeof Bun.spawn)
  }

  const deps = (extra: Partial<PerformProvisioningDeps> = {}): PerformProvisioningDeps => ({
    waitForSsh: async () => {
      events.push('waitForSsh')
    },
    pinHostKeys: async () => {
      events.push('pinHostKeys')
    },
    hostKeysPinned: () => false,
    sleep: async ms => {
      events.push(`sleep:${ms}`)
    },
    ...extra,
  })

  const remoteCalls = (): string[][] => calls.map(c => c.argv).filter(argv => !isClose(argv))
  const run = (key = FAKE_PRIVATE_KEY, extra: Partial<PerformProvisioningDeps> = {}): Promise<void> =>
    performProvisioning('1.2.3.4', key, 'mgmt-key', 'broker.fro.bot', 'broker-aud', deps(extra))

  beforeEach(() => {
    events = []
    calls = []
    logSpy = spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    spawnSpy?.mockRestore()
    logSpy.mockRestore()
  })

  it('sends all six remote calls over one control socket, the first of them opening the master', async () => {
    installSpawn()

    await run()

    const remote = remoteCalls()
    // mkdir, scp compose, scp Caddyfile, .env write, docker check, compose up
    expect(remote.map(argv => argv[0])).toEqual(['ssh', 'scp', 'scp', 'ssh', 'ssh', 'ssh'])
    const sockets = new Set(remote.map(controlPathOf))
    expect(sockets.size).toBe(1)
    const [socket] = [...sockets]
    expect(socket?.startsWith('/tmp/')).toBe(true)
    for (const argv of remote) {
      expect(argv).toContain('ControlMaster=auto')
      expect(argv.some(arg => arg.startsWith('ControlPersist='))).toBe(true)
    }
    expect(remote[0]?.at(-1)).toContain('mkdir -p /opt/broker/config')
  })

  it('keeps the host-key and identity options of every call unchanged', async () => {
    installSpawn()

    await run()

    const remote = remoteCalls()
    const identity = remote[0]?.[remote[0].indexOf('-i') + 1]
    expect(identity).toBeTruthy()
    for (const argv of remote) {
      expect(argv).toContain('StrictHostKeyChecking=accept-new')
      expect(argv).toContain('BatchMode=yes')
      expect(argv[argv.indexOf('-i') + 1]).toBe(identity)
      expect(argv).toContain('IdentitiesOnly=yes')
    }
  })

  it('closes the master over the same socket after the last call, and removes the socket directory', async () => {
    installSpawn()

    await run()

    const closes = calls.map(c => c.argv).filter(isClose)
    expect(closes).toHaveLength(1)
    expect(calls.at(-1)?.argv).toBe(closes[0])
    const socket = controlPathOf(closes[0] ?? [])
    expect(socket).toBe(controlPathOf(remoteCalls()[0] ?? []))
    expect(closes[0]?.at(-1)).toBe('root@1.2.3.4')
    expect(existsSync(join(socket ?? '/nonexistent', '..'))).toBe(false)
  })

  it('closes the master, removes the directory and the key file when a step fails', async () => {
    installSpawn(argv => argv[0] === 'scp')

    await expect(run()).rejects.toThrow(/Uploading docker-compose.yaml failed/)

    const closes = calls.map(c => c.argv).filter(isClose)
    expect(closes).toHaveLength(1)
    // mkdir, then the failing scp; nothing after it.
    expect(remoteCalls().map(argv => argv[0])).toEqual(['ssh', 'scp'])
    const socket = controlPathOf(closes[0] ?? [])
    expect(socket).toBe(controlPathOf(remoteCalls()[0] ?? []))
    expect(existsSync(join(socket ?? '/nonexistent', '..'))).toBe(false)
    const identity = remoteCalls()[0]?.[(remoteCalls()[0]?.indexOf('-i') ?? -2) + 1]
    expect(existsSync(identity ?? '')).toBe(false)
  })

  it('pauses before each key scan and once more after the last, before the master opens', async () => {
    installSpawn()
    const pinCalls: {marker: string; pauseBeforeScanMs?: number}[] = []

    await run(undefined, {
      pinHostKeys: async (_domain, _ip, _path, opts) => {
        events.push('pinHostKeys')
        pinCalls.push(opts)
      },
    })

    expect(pinCalls).toEqual([
      {marker: '# broker droplet (1.2.3.4 / broker.fro.bot)', pauseBeforeScanMs: SSH_SCAN_PAUSE_MS},
    ])
    expect(events.slice(0, 3)).toEqual(['waitForSsh', 'pinHostKeys', `sleep:${SSH_SCAN_PAUSE_MS}`])
    expect(events[3]).toBe('spawn:ssh')
  })

  it('does not pause again when the host keys are already pinned and no scan ran', async () => {
    installSpawn()

    await run(undefined, {hostKeysPinned: () => true})

    expect(events.filter(event => event.startsWith('sleep:'))).toEqual([])
  })

  it('opens no master when waitForSsh fails, and still cleans up', async () => {
    installSpawn()

    await expect(
      run(undefined, {
        waitForSsh: async () => {
          throw new Error('ssh never came up')
        },
      }),
    ).rejects.toThrow('ssh never came up')

    expect(remoteCalls()).toEqual([])
  })
})
