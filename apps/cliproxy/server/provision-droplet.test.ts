import {existsSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {
  performProvisioning,
  resolveProvisionIdentity,
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
      const fakeDeployCompose = async (host: string, identityFile?: string) => {
        capturedDeployCompose.push({host, identityFile})
      }

      await performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
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
      const fakeDeployCompose = async (_host: string, identityFile?: string) => {
        recordIdentity(identityFile)
      }

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
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
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await expect(
        performProvisioning('1.2.3.4', FAKE_PRIVATE_KEY, {
          waitForSsh: fakeWaitForSsh,
          pinHostKeys: async () => {},
          copyComposeFiles: fakeCopyComposeFiles,
          writeRemoteEnvFile: fakeWriteRemoteEnvFile,
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
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: async () => {},
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
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
      const fakeDeployCompose = async (_host: string, _identityFile?: string) => {}

      await performProvisioning('1.2.3.4', undefined, {
        waitForSsh: fakeWaitForSsh,
        pinHostKeys: fakePinHostKeys,
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        deployCompose: fakeDeployCompose,
      })

      expect(callOrder.indexOf('waitForSsh')).toBeLessThan(callOrder.indexOf('pinHostKeys'))
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
