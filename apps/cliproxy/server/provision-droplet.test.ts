import {existsSync} from 'node:fs'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {performProvisioning, resolveProvisionIdentity, validateCliproxyDomain} from './provision-droplet'

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
        copyComposeFiles: fakeCopyComposeFiles,
        writeRemoteEnvFile: fakeWriteRemoteEnvFile,
        deployCompose: fakeDeployCompose,
      })

      expect(capturedPath).toBeUndefined()
    })
  })
})
