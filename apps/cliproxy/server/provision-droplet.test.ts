import {existsSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  performProvisioning,
  resolveProvisionIdentity,
  seedRemoteSecretKey,
  validateCliproxyDomain,
  writeManagementKeyFile,
  writeRemoteEnvFile,
} from './provision-droplet'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = ['CLIPROXY_DOMAIN', 'CLIPROXY_SSH_KEY'] as const
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

  // ---------------------------------------------------------------------------
  // validateCliproxyDomain
  // ---------------------------------------------------------------------------

  describe('validateCliproxyDomain', () => {
    it('accepts a valid domain', () => {
      expect(validateCliproxyDomain('cliproxy.fro.bot')).toBe('cliproxy.fro.bot')
    })

    it('accepts a plain hostname', () => {
      expect(validateCliproxyDomain('example.com')).toBe('example.com')
    })

    it('throws on a value containing a newline (heredoc termination)', () => {
      expect(() => validateCliproxyDomain('cliproxy.fro.bot\nENVFILE\nevil')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a dollar sign (variable expansion)', () => {
      expect(() => validateCliproxyDomain('host$PATH')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a backtick (command substitution)', () => {
      expect(() => validateCliproxyDomain('host`id`')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a pipe (command chaining)', () => {
      expect(() => validateCliproxyDomain('host|cat /etc/passwd')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a semicolon (command separator)', () => {
      expect(() => validateCliproxyDomain('host;rm -rf /')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing an ampersand (background execution)', () => {
      expect(() => validateCliproxyDomain('host&evil')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a single quote', () => {
      expect(() => validateCliproxyDomain("host'evil")).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a double quote', () => {
      expect(() => validateCliproxyDomain('host"evil')).toThrow(/disallowed characters/)
    })

    it('throws on a value containing a backslash', () => {
      expect(() => validateCliproxyDomain(String.raw`host\evil`)).toThrow(/disallowed characters/)
    })
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
  // performProvisioning — full SSH orchestration seam
  // ---------------------------------------------------------------------------

  describe('SSH provisioning orchestration', () => {
    it('threads identity file through waitForSsh and all helper calls when key is set', async () => {
      const capturedWaitForSsh: {host: string; user: string; identityFile?: string}[] = []
      const capturedCopyComposeFiles: {host: string; identityFile?: string}[] = []
      const capturedWriteRemoteEnvFile: {host: string; identityFile?: string}[] = []
      const capturedSeedRemoteSecretKey: {host: string; identityFile?: string}[] = []
      const capturedDeployCompose: {host: string; identityFile?: string}[] = []

      const fakeWaitForSsh = async (host: string, user: string, opts?: {identityFile?: string}) => {
        capturedWaitForSsh.push({host, user, identityFile: opts?.identityFile})
      }
      const fakeCopyComposeFiles = async (host: string, identityFile?: string) => {
        capturedCopyComposeFiles.push({host, identityFile})
      }
      const fakeWriteRemoteEnvFile = async (host: string, identityFile?: string): Promise<string> => {
        capturedWriteRemoteEnvFile.push({host, identityFile})
        return 'fake-mgmt-password'
      }
      const fakeSeedRemoteSecretKey = async (host: string, _password: string, identityFile?: string) => {
        capturedSeedRemoteSecretKey.push({host, identityFile})
      }
      const fakeDeployCompose = async (host: string, identityFile?: string) => {
        capturedDeployCompose.push({host, identityFile})
      }

      await performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        seedRemoteSecretKey: fakeSeedRemoteSecretKey,
        deployCompose: fakeDeployCompose,
      })

      // waitForSsh must have received a non-empty identity file path
      expect(capturedWaitForSsh).toHaveLength(1)
      const {identityFile: wsfPath} = capturedWaitForSsh[0] ?? {}
      expect(wsfPath).toBeTruthy()

      // All helpers must receive the same identity file path
      expect(capturedCopyComposeFiles[0]?.identityFile).toBe(wsfPath)
      expect(capturedWriteRemoteEnvFile[0]?.identityFile).toBe(wsfPath)
      expect(capturedSeedRemoteSecretKey[0]?.identityFile).toBe(wsfPath)
      expect(capturedDeployCompose[0]?.identityFile).toBe(wsfPath)
    })

    it('does not pass identity file to any helper when no key material is given', async () => {
      const capturedIdentities: (string | undefined)[] = []

      const recordIdentity = (identityFile?: string) => {
        capturedIdentities.push(identityFile)
      }

      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        recordIdentity(opts?.identityFile)
      }
      const fakeCopyComposeFiles = async (_host: string, identityFile?: string) => {
        recordIdentity(identityFile)
      }
      const fakeWriteRemoteEnvFile = async (_host: string, identityFile?: string): Promise<string> => {
        recordIdentity(identityFile)
        return 'fake-mgmt-password'
      }
      const fakeSeedRemoteSecretKey = async (_host: string, _password: string, identityFile?: string) => {
        recordIdentity(identityFile)
      }
      const fakeDeployCompose = async (_host: string, identityFile?: string) => {
        recordIdentity(identityFile)
      }

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        seedRemoteSecretKey: fakeSeedRemoteSecretKey,
        deployCompose: fakeDeployCompose,
      })

      // No helper should have received an identity file
      for (const id of capturedIdentities) {
        expect(id).toBeUndefined()
      }
    })

    it('cleans up the temp key file even when a provisioning step throws', async () => {
      let capturedPath: string | undefined

      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
        throw new Error('provisioning step failed')
      }
      const fakeCopyComposeFiles = async (_host: string, _identityFile?: string) => {}
      const fakeWriteRemoteEnvFile = async (_host: string, _identityFile?: string): Promise<string> =>
        'fake-mgmt-password'
      const fakeSeedRemoteSecretKey = async (_host: string, _password: string, _identityFile?: string) => {}
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await expect(
        performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, {
          waitForSsh: fakeWaitForSsh,
          pinHostKeys: async () => {},
          copyComposeFiles: fakeCopyComposeFiles,
          writeRemoteEnvFile: fakeWriteRemoteEnvFile,
          seedRemoteSecretKey: fakeSeedRemoteSecretKey,
          deployCompose: fakeDeployCompose,
        }),
      ).rejects.toThrow('provisioning step failed')

      // The temp file must have been cleaned up in the finally block
      expect(capturedPath).toBeTruthy()
      expect(existsSync(capturedPath ?? '')).toBe(false)
    })

    it('does not create a temp file when no key material is provided', async () => {
      let capturedPath: string | undefined

      const fakeWaitForSsh = async (_host: string, _user: string, opts?: {identityFile?: string}) => {
        capturedPath = opts?.identityFile
      }
      const fakeCopyComposeFiles = async (_host: string, _identityFile?: string) => {}
      const fakeWriteRemoteEnvFile = async (_host: string, _identityFile?: string): Promise<string> =>
        'fake-mgmt-password'
      const fakeSeedRemoteSecretKey = async (_host: string, _password: string, _identityFile?: string) => {}
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        seedRemoteSecretKey: fakeSeedRemoteSecretKey,
        deployCompose: fakeDeployCompose,
      })

      expect(capturedPath).toBeUndefined()
    })

    it('calls waitForSsh before pinHostKeys when pinHostKeys is injected', async () => {
      const callOrder: string[] = []

      const fakeWaitForSsh = async () => {
        callOrder.push('waitForSsh')
      }
      const fakePinHostKeys = async () => {
        callOrder.push('pinHostKeys')
      }
      const fakeCopyComposeFiles = async (_host: string, _identityFile?: string) => {}
      const fakeWriteRemoteEnvFile = async (_host: string, _identityFile?: string): Promise<string> =>
        'fake-mgmt-password'
      const fakeSeedRemoteSecretKey = async (_host: string, _password: string, _identityFile?: string) => {}
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: fakePinHostKeys,
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        seedRemoteSecretKey: fakeSeedRemoteSecretKey,
        deployCompose: fakeDeployCompose,
      })

      expect(callOrder.indexOf('waitForSsh')).toBeLessThan(callOrder.indexOf('pinHostKeys'))
    })
  })

  // ---------------------------------------------------------------------------
  // seedRemoteSecretKey — pipes password via stdin, never in argv
  // ---------------------------------------------------------------------------

  describe('seedRemoteSecretKey', () => {
    it('pipes the management password through stdin, never in the command argv', async () => {
      const password = 'deadbeef1234567890abcdef'
      let capturedStdinWrite: string | undefined
      let capturedArgv: string[] | undefined

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {
          write: (chunk: string) => {
            capturedArgv ??= []
            capturedStdinWrite = (capturedStdinWrite ?? '') + chunk
          },
          end: () => {},
        },
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      // Capture argv via the spy's call args after the call
      await seedRemoteSecretKey('1.2.3.4', password)
      capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]

      spawnSpy.mockRestore()

      // Password must appear in stdin, never in argv
      expect(capturedStdinWrite).toContain(password)
      expect(capturedArgv?.join(' ')).not.toContain(password)
      // Trailing newline so the remote `read -r` returns 0 and the seed runs
      // (without it, read exits non-zero at EOF and the sed silently no-ops).
      expect(capturedStdinWrite?.endsWith('\n')).toBe(true)
    })

    it('uses an if/grep guard (not || true) so a real sed failure surfaces', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await seedRemoteSecretKey('1.2.3.4', 'abc123')
      const remoteCmd = (spawnSpy.mock.calls[0]?.[0] as string[]).at(-1) ?? ''
      spawnSpy.mockRestore()

      expect(remoteCmd).toContain('if grep -q')
      expect(remoteCmd).not.toContain('|| true')
    })

    it('targets the remote config.yaml path in the SSH command', async () => {
      const password = 'deadbeef1234567890abcdef'

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await seedRemoteSecretKey('1.2.3.4', password)

      const capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]
      spawnSpy.mockRestore()

      // The remote command must reference the config.yaml path
      const argvStr = capturedArgv?.join(' ') ?? ''
      expect(argvStr).toContain('/opt/cliproxy/config/config.yaml')
    })

    it('rejects with an error when the SSH command fails', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(1),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await expect(seedRemoteSecretKey('1.2.3.4', 'some-password')).rejects.toThrow(/exit/)

      spawnSpy.mockRestore()
    })

    it('passes the identity file to the SSH command when provided', async () => {
      const password = 'deadbeef1234567890abcdef'

      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(0),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await seedRemoteSecretKey('1.2.3.4', password, '/tmp/fake-key')

      const capturedArgv = spawnSpy.mock.calls[0]?.[0] as string[]
      spawnSpy.mockRestore()

      expect(capturedArgv?.join(' ')).toContain('/tmp/fake-key')
    })
  })

  // ---------------------------------------------------------------------------
  // performProvisioning — seedRemoteSecretKey ordering
  // ---------------------------------------------------------------------------

  describe('SSH provisioning orchestration — seedRemoteSecretKey ordering', () => {
    it('calls seedRemoteSecretKey after copyComposeFiles and writeRemoteEnvFile, before deployCompose', async () => {
      const callOrder: string[] = []

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: async () => {
          callOrder.push('waitForSsh')
        },
        pinHostKeys: async () => {
          callOrder.push('pinHostKeys')
        },
        copyComposeFiles: async () => {
          callOrder.push('copyComposeFiles')
        },
        writeRemoteEnvFile: async () => {
          callOrder.push('writeRemoteEnvFile')
          return 'fake-pw'
        },
        seedRemoteSecretKey: async () => {
          callOrder.push('seedRemoteSecretKey')
        },
        deployCompose: async () => {
          callOrder.push('deployCompose')
        },
      })

      const seedIdx = callOrder.indexOf('seedRemoteSecretKey')
      const uploadIdx = callOrder.indexOf('copyComposeFiles')
      const envIdx = callOrder.indexOf('writeRemoteEnvFile')
      const composeIdx = callOrder.indexOf('deployCompose')

      expect(seedIdx).toBeGreaterThan(uploadIdx)
      expect(seedIdx).toBeGreaterThan(envIdx)
      expect(seedIdx).toBeLessThan(composeIdx)
    })

    it('passes the management password from writeRemoteEnvFile to seedRemoteSecretKey', async () => {
      let capturedPassword: string | undefined
      let capturedHost: string | undefined

      await performProvisioning('5.6.7.8', undefined, {
        waitForSsh: async () => {},
        pinHostKeys: async () => {},
        copyComposeFiles: async () => {},
        writeRemoteEnvFile: async () => 'the-generated-password',
        seedRemoteSecretKey: async (host: string, password: string) => {
          capturedHost = host
          capturedPassword = password
        },
        deployCompose: async () => {},
      })

      expect(capturedPassword).toBe('the-generated-password')
      expect(capturedHost).toBe('5.6.7.8')
    })

    it('threads identity file through seedRemoteSecretKey when key is set', async () => {
      let capturedIdentityFile: string | undefined

      await performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, {
        waitForSsh: async (_host, _user, opts) => {
          capturedIdentityFile = opts?.identityFile
        },
        pinHostKeys: async () => {},
        copyComposeFiles: async () => {},
        writeRemoteEnvFile: async () => 'fake-pw',
        seedRemoteSecretKey: async (_host, _password, identityFile) => {
          // identityFile must match what waitForSsh received
          expect(identityFile).toBe(capturedIdentityFile)
        },
        deployCompose: async () => {},
      })
    })
  })

  // ---------------------------------------------------------------------------
  // writeRemoteEnvFile — rejects on non-zero SSH exit
  // ---------------------------------------------------------------------------

  describe('writeRemoteEnvFile', () => {
    it('rejects with an error when the SSH .env write command fails', async () => {
      const spawnSpy = spyOn(Bun, 'spawn').mockReturnValue({
        stdin: {write: () => {}, end: () => {}},
        exited: Promise.resolve(255),
      } as unknown as ReturnType<typeof Bun.spawn>)

      await expect(writeRemoteEnvFile('1.2.3.4')).rejects.toThrow(/255/)

      spawnSpy.mockRestore()
    })
  })

  // ---------------------------------------------------------------------------
  // writeManagementKeyFile — writes key to 0600 file, never to stdout
  // ---------------------------------------------------------------------------

  describe('writeManagementKeyFile', () => {
    let testDir: string
    let keyFilePath: string

    beforeEach(() => {
      testDir = join(tmpdir(), `infra-test-${Date.now()}`)
      keyFilePath = join(testDir, '.cliproxy-management-key')
    })

    afterEach(async () => {
      // Clean up test file
      try {
        const {rmSync} = await import('node:fs')
        rmSync(testDir, {recursive: true, force: true})
      } catch {
        // best-effort
      }
    })

    it('writes the management key to the expected file path', async () => {
      const key = 'test-management-key-value-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      expect(existsSync(result)).toBe(true)
      const contents = await Bun.file(result).text()
      expect(contents).toBe(key)
    })

    it('creates the file with mode 0600 (owner read/write only)', async () => {
      const key = 'test-management-key-value-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      const stat = statSync(result)
      // 0o600 = 384 decimal; mask with 0o777 to get permission bits only
      expect(stat.mode & 0o777).toBe(0o600)
    })

    it('returns the path to the written file', async () => {
      const key = 'test-management-key-value-abc123'
      const result = await writeManagementKeyFile(testDir, key)

      expect(result).toBe(keyFilePath)
    })

    it('does NOT include the raw key value in the returned path string', async () => {
      const key = 'super-secret-management-key-xyz789'
      const result = await writeManagementKeyFile(testDir, key)

      // The returned path must not contain the key value
      expect(result).not.toContain(key)
    })
  })
})
