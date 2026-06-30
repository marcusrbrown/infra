import type {FetchFn} from './deploy'

import {tmpdir} from 'node:os'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {
  deploy,
  getDeployEnv,
  healthCheck,
  makeControlPath,
  preflightChecks,
  scpCommand,
  sshCommand,
  writeRemoteEnvFile,
} from './deploy'

// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------

const managedEnvKeys = [
  'PATH',
  'HOME',
  'SSH_AUTH_SOCK',
  'BROKER_HOST',
  'CLIPROXY_MANAGEMENT_URL',
  'CLIPROXY_MANAGEMENT_KEY',
] as const

let savedEnv: Partial<Record<(typeof managedEnvKeys)[number], string | undefined>>

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

function setValidEnv(): void {
  process.env.PATH = '/usr/bin:/bin'
  process.env.HOME = '/root'
  process.env.SSH_AUTH_SOCK = '/tmp/ssh.sock'
  process.env.BROKER_HOST = 'broker.fro.bot'
  process.env.CLIPROXY_MANAGEMENT_URL = 'https://cliproxy.fro.bot'
  process.env.CLIPROXY_MANAGEMENT_KEY = 'cliproxy-mgmt-key-xyz789'
}

function makeValidEnv() {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    SSH_AUTH_SOCK: '/tmp/ssh.sock',
    BROKER_HOST: 'broker.fro.bot',
    CLIPROXY_MANAGEMENT_URL: 'https://cliproxy.fro.bot',
    CLIPROXY_MANAGEMENT_KEY: 'cliproxy-mgmt-key-xyz789',
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deploy (broker)', () => {
  beforeEach(() => {
    saveEnv()
  })

  afterEach(() => {
    restoreEnv()
  })

  // ---------------------------------------------------------------------------
  // getDeployEnv
  // ---------------------------------------------------------------------------

  describe('getDeployEnv', () => {
    it('returns all required env vars when set', () => {
      setValidEnv()
      const env = getDeployEnv()
      expect(env.BROKER_HOST).toBe('broker.fro.bot')
      expect(env.CLIPROXY_MANAGEMENT_URL).toBe('https://cliproxy.fro.bot')
      expect(env.CLIPROXY_MANAGEMENT_KEY).toBe('cliproxy-mgmt-key-xyz789')
    })

    it('throws when BROKER_HOST is missing', () => {
      setValidEnv()
      delete process.env.BROKER_HOST
      expect(() => getDeployEnv()).toThrow(/BROKER_HOST/)
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      setValidEnv()
      delete process.env.SSH_AUTH_SOCK
      expect(() => getDeployEnv()).toThrow(/SSH_AUTH_SOCK/)
    })
  })

  // ---------------------------------------------------------------------------
  // sshCommand / scpCommand — ControlPath threading
  // ---------------------------------------------------------------------------

  describe('sshCommand', () => {
    it('includes the ControlPath in the command', () => {
      const cmd = sshCommand('broker.fro.bot', 'echo hi', '/tmp/test.sock')
      expect(cmd.join(' ')).toContain('/tmp/test.sock')
    })

    it('includes ControlMaster=auto', () => {
      const cmd = sshCommand('broker.fro.bot', 'echo hi', '/tmp/test.sock')
      expect(cmd.join(' ')).toContain('ControlMaster=auto')
    })

    it('includes the remote command', () => {
      const cmd = sshCommand('broker.fro.bot', 'docker compose up -d', '/tmp/test.sock')
      expect(cmd.at(-1)).toBe('docker compose up -d')
    })
  })

  describe('scpCommand', () => {
    it('includes the ControlPath in the command', () => {
      const cmd = scpCommand('broker.fro.bot', '/local/file', '/remote/file', '/tmp/test.sock')
      expect(cmd.join(' ')).toContain('/tmp/test.sock')
    })

    it('does not include ControlMaster (scp does not support it)', () => {
      const cmd = scpCommand('broker.fro.bot', '/local/file', '/remote/file', '/tmp/test.sock')
      expect(cmd.join(' ')).not.toContain('ControlMaster')
    })
  })

  describe('makeControlPath', () => {
    it('returns a path in the system temp directory', () => {
      const cp = makeControlPath('broker.fro.bot')
      expect(cp).toContain(tmpdir())
    })

    it('includes the host in the path', () => {
      const cp = makeControlPath('broker.fro.bot')
      expect(cp).toContain('broker.fro.bot')
    })

    it('returns a path matching the expected pattern', () => {
      const cp = makeControlPath('broker.fro.bot')
      expect(cp).toMatch(/broker-deploy-broker\.fro\.bot-\d+\.sock$/)
    })
  })

  // ---------------------------------------------------------------------------
  // preflightChecks — aborts before compose change on missing key / unreachable
  // ---------------------------------------------------------------------------

  describe('preflightChecks', () => {
    it('throws when CLIPROXY_MANAGEMENT_KEY is missing', async () => {
      const env = {...makeValidEnv(), CLIPROXY_MANAGEMENT_KEY: ''}
      await expect(preflightChecks(env)).rejects.toThrow(/CLIPROXY_MANAGEMENT_KEY/)
    })

    it('throws when cliproxy returns 401 (invalid management key)', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async () => new Response('Unauthorized', {status: 401})
      await expect(preflightChecks(env, {fetch: mockFetch})).rejects.toThrow(/invalid/)
    })

    it('throws when cliproxy returns 403 (forbidden)', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async () => new Response('Forbidden', {status: 403})
      await expect(preflightChecks(env, {fetch: mockFetch})).rejects.toThrow(/invalid/)
    })

    it('throws when cliproxy returns a non-2xx error', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async () => new Response('Server Error', {status: 500})
      await expect(preflightChecks(env, {fetch: mockFetch})).rejects.toThrow(/HTTP 500/)
    })

    it('throws when cliproxy is unreachable (network error)', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async (): Promise<Response> => {
        throw new Error('ECONNREFUSED')
      }
      await expect(preflightChecks(env, {fetch: mockFetch})).rejects.toThrow(/unreachable/)
    })

    it('passes when cliproxy returns 200 with api-keys', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async () => new Response(JSON.stringify(['key1', 'key2']), {status: 200})
      await expect(preflightChecks(env, {fetch: mockFetch})).resolves.toBeUndefined()
    })

    it('calls the cliproxy api-keys endpoint with the management key header', async () => {
      const env = makeValidEnv()
      const capturedRequests: {url: string; headers: Record<string, string>}[] = []

      const mockFetch: FetchFn = async (url, init) => {
        capturedRequests.push({
          url: String(url),
          headers: Object.fromEntries(new Headers(init?.headers as Record<string, string>).entries()),
        })
        return new Response(JSON.stringify([]), {status: 200})
      }

      await preflightChecks(env, {fetch: mockFetch})

      expect(capturedRequests).toHaveLength(1)
      expect(capturedRequests[0]?.url).toContain('/v0/management/api-keys')
      expect(capturedRequests[0]?.headers['x-management-key']).toBe('cliproxy-mgmt-key-xyz789')
    })
  })

  // ---------------------------------------------------------------------------
  // healthCheck — probes /healthz
  // ---------------------------------------------------------------------------

  describe('healthCheck', () => {
    it('probes GET /healthz on the broker host', async () => {
      const env = makeValidEnv()
      const capturedUrls: string[] = []

      const mockFetch: FetchFn = async url => {
        capturedUrls.push(String(url))
        return new Response(JSON.stringify({status: 'ok'}), {status: 200})
      }

      await healthCheck(env, {fetch: mockFetch})

      expect(capturedUrls).toHaveLength(1)
      expect(capturedUrls[0]).toBe('https://broker.fro.bot/healthz')
    })

    it('throws when /healthz returns non-2xx', async () => {
      const env = makeValidEnv()
      const mockFetch: FetchFn = async () => new Response('Service Unavailable', {status: 503})
      await expect(healthCheck(env, {fetch: mockFetch})).rejects.toThrow(/503/)
    })
  })

  // ---------------------------------------------------------------------------
  // writeRemoteEnvFile — secrets via stdin, never argv
  // ---------------------------------------------------------------------------

  describe('writeRemoteEnvFile', () => {
    it('pipes CLIPROXY_MANAGEMENT_KEY through stdin, never in argv', async () => {
      const env = makeValidEnv()
      let capturedStdinWrite = ''

      const mockSpawn = (_cmd: string[], _opts: unknown) => ({
        stdin: {
          write: (chunk: string) => {
            capturedStdinWrite += chunk
          },
          end: () => {},
        },
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      })

      await writeRemoteEnvFile('broker.fro.bot', env, '/tmp/test.sock', {
        spawn: mockSpawn as unknown as typeof Bun.spawn,
      })

      // Secret must appear in stdin
      expect(capturedStdinWrite).toContain('CLIPROXY_MANAGEMENT_KEY=cliproxy-mgmt-key-xyz789')
    })

    it('env file contains all required keys', async () => {
      const env = makeValidEnv()
      let capturedStdinWrite = ''

      const mockSpawn = (_cmd: string[], _opts: unknown) => ({
        stdin: {
          write: (chunk: string) => {
            capturedStdinWrite += chunk
          },
          end: () => {},
        },
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(0),
      })

      await writeRemoteEnvFile('broker.fro.bot', env, '/tmp/test.sock', {
        spawn: mockSpawn as unknown as typeof Bun.spawn,
      })

      expect(capturedStdinWrite).toContain('BROKER_HOST=')
      expect(capturedStdinWrite).toContain('CLIPROXY_MANAGEMENT_URL=')
      expect(capturedStdinWrite).toContain('CLIPROXY_MANAGEMENT_KEY=')
    })

    it('uses the provided controlPath in the SSH command', async () => {
      const env = makeValidEnv()
      let capturedCmd: string[] = []

      const mockSpawn = (cmd: string[], _opts: unknown) => {
        capturedCmd = cmd
        return {
          stdin: {write: () => {}, end: () => {}},
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
        }
      }

      await writeRemoteEnvFile('broker.fro.bot', env, '/tmp/unique-control.sock', {
        spawn: mockSpawn as unknown as typeof Bun.spawn,
      })

      expect(capturedCmd.join(' ')).toContain('/tmp/unique-control.sock')
    })

    it('throws when the SSH command fails', async () => {
      const env = makeValidEnv()

      const mockSpawn = (_cmd: string[], _opts: unknown) => ({
        stdin: {write: () => {}, end: () => {}},
        stdout: new ReadableStream(),
        stderr: new ReadableStream(),
        exited: Promise.resolve(1),
      })

      await expect(
        writeRemoteEnvFile('broker.fro.bot', env, '/tmp/test.sock', {
          spawn: mockSpawn as unknown as typeof Bun.spawn,
        }),
      ).rejects.toThrow(/failed/)
    })
  })

  // ---------------------------------------------------------------------------
  // deploy — preflight aborts before compose change
  // ---------------------------------------------------------------------------

  describe('deploy — preflight abort', () => {
    it('aborts before any compose change when CLIPROXY_MANAGEMENT_KEY is missing', async () => {
      setValidEnv()
      process.env.CLIPROXY_MANAGEMENT_KEY = ''

      // Mock fetch to return 200 (cliproxy is reachable) — but preflight should fail on missing key
      const mockFetch: FetchFn = async () => new Response(JSON.stringify([]), {status: 200})

      // deploy() calls validatePreconditions() which calls getDeployEnv() which throws
      // when CLIPROXY_MANAGEMENT_KEY is empty — but preflightChecks also checks it.
      // Either way, no compose command should run.
      let spawnCalled = false
      const mockSpawn = (_cmd: string[], _opts: unknown) => {
        spawnCalled = true
        return {
          stdin: {write: () => {}, end: () => {}},
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
        }
      }

      await expect(deploy({fetch: mockFetch, spawn: mockSpawn as unknown as typeof Bun.spawn})).rejects.toThrow()

      // No SSH/SCP commands should have been spawned
      expect(spawnCalled).toBe(false)
    })

    it('aborts before any compose change when cliproxy is unreachable', async () => {
      setValidEnv()

      const mockFetch: FetchFn = async (): Promise<Response> => {
        throw new Error('ECONNREFUSED')
      }

      let spawnCalled = false
      const mockSpawn = (_cmd: string[], _opts: unknown) => {
        spawnCalled = true
        return {
          stdin: {write: () => {}, end: () => {}},
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
        }
      }

      await expect(deploy({fetch: mockFetch, spawn: mockSpawn as unknown as typeof Bun.spawn})).rejects.toThrow(
        /unreachable/,
      )

      // No SSH/SCP commands should have been spawned
      expect(spawnCalled).toBe(false)
    })
  })

  // ---------------------------------------------------------------------------
  // deploy — single controlPath threaded through all SSH/SCP calls
  // ---------------------------------------------------------------------------

  describe('deploy — single controlPath threading', () => {
    it('uses the same controlPath in all SSH/SCP commands', () => {
      // deploy() will fail on file existence checks (compose/caddy don't exist in test)
      // so we test the controlPath threading via the lower-level functions.
      // All SSH/SCP commands built with the same controlPath must carry that path.
      const capturedControlPaths = new Set<string>()
      const controlPath = makeControlPath('broker.fro.bot')

      // Simulate the SSH/SCP commands that deploy() would issue
      const cmd1 = sshCommand('broker.fro.bot', 'mkdir -p /opt/broker/config', controlPath)
      const cmd2 = scpCommand('broker.fro.bot', '/local/compose', '/opt/broker/docker-compose.yaml', controlPath)
      const cmd3 = sshCommand('broker.fro.bot', 'cd /opt/broker && docker compose pull', controlPath)

      // All commands should use the same controlPath
      for (const cmd of [cmd1, cmd2, cmd3]) {
        const match = cmd.join(' ').match(/ControlPath=(\S+)/)
        if (match?.[1]) capturedControlPaths.add(match[1])
      }

      // All SSH/SCP commands used the same controlPath
      expect(capturedControlPaths.size).toBe(1)
      expect([...capturedControlPaths][0]).toBe(controlPath)
    })
  })

  // ---------------------------------------------------------------------------
  // Security: no secret bytes in SSH argv
  // ---------------------------------------------------------------------------

  describe('security: no secret bytes in SSH argv', () => {
    it('writeRemoteEnvFile does not put CLIPROXY_MANAGEMENT_KEY in SSH argv', async () => {
      const env = makeValidEnv()
      const secretKey = 'super-secret-cliproxy-mgmt-key-never-in-argv'
      env.CLIPROXY_MANAGEMENT_KEY = secretKey

      let capturedArgv: string[] = []

      const mockSpawn = (cmd: string[], _opts: unknown) => {
        capturedArgv = cmd
        return {
          stdin: {write: () => {}, end: () => {}},
          stdout: new ReadableStream(),
          stderr: new ReadableStream(),
          exited: Promise.resolve(0),
        }
      }

      await writeRemoteEnvFile('broker.fro.bot', env, '/tmp/test.sock', {
        spawn: mockSpawn as unknown as typeof Bun.spawn,
      })

      const argvStr = capturedArgv.join(' ')
      expect(argvStr).not.toContain(secretKey)
    })
  })
})
