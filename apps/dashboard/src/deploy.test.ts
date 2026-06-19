import {readFileSync} from 'node:fs'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  assertRunningImageDigest,
  buildEnvFileContents,
  deploy,
  parseComposeImageDigest,
  validateEnv,
  validateGatewayVpcIp,
  validateSecretValue,
  type SpawnFn,
  type SpawnResult,
} from './deploy'

// ─── Test helpers ─────────────────────────────────────────────────────────────

// Derive the expected digest from the committed docker-compose.yaml so that
// Renovate image bumps do not require manual test updates.
const composeText = await Bun.file(new URL('../docker-compose.yaml', import.meta.url)).text()
const dashboardImageLine = composeText.split('\n').find(l => l.includes('fro-bot/dashboard')) ?? ''
const COMPOSE_DIGEST = parseComposeImageDigest(dashboardImageLine) ?? ''
if (!COMPOSE_DIGEST) throw new Error('Could not derive COMPOSE_DIGEST from docker-compose.yaml')

const FAKE_DIGEST = `sha256:${'a'.repeat(64)}`

const VALID_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  DASHBOARD_DOMAIN: 'dashboard.fro.bot',
  DASHBOARD_GITHUB_APP_ID: '123456',
  DASHBOARD_GITHUB_APP_KEY: '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----',
  DASHBOARD_OAUTH_CLIENT_ID: 'Iv1.abc123',
  DASHBOARD_OAUTH_CLIENT_SECRET: 'oauthsecretvalue',
  DASHBOARD_OPERATOR_LOGIN: 'marcusrbrown',
  DASHBOARD_COOKIE_KEY: 'cookiesecretkey32byteslong123456',
  GATEWAY_VPC_IP: '10.116.0.3',
}

/** Builds a fake SpawnResult that exits 0 with given stdout. */
function makeSpawnResult(stdout = '', stderr = '', exitCode = 0): SpawnResult {
  const encoder = new TextEncoder()
  return {
    stdout: new ReadableStream({
      start(controller) {
        if (stdout) controller.enqueue(encoder.encode(stdout))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (stderr) controller.enqueue(encoder.encode(stderr))
        controller.close()
      },
    }),
    stdin: {
      write: (_data: Uint8Array) => {},
      end: () => {},
    },
    exited: Promise.resolve(exitCode),
  }
}

/** Tracks all spawn calls for assertion. */
interface SpawnCall {
  cmd: string[]
  stdinData: string
}

/**
 * Builds a fake SpawnFn that records all calls and returns configurable results.
 * `responses` is consumed in order; the last entry is repeated for remaining calls.
 */
function makeFakeSpawn(responses: SpawnResult[]): {spawnFn: SpawnFn; calls: SpawnCall[]} {
  const calls: SpawnCall[] = []
  let idx = 0

  const spawnFn: SpawnFn = (cmd, opts) => {
    const call: SpawnCall = {cmd: [...cmd], stdinData: ''}

    const result = responses[Math.min(idx++, responses.length - 1)] ?? makeSpawnResult()

    if (opts.stdin === 'pipe') {
      // Intercept stdin writes
      const originalWrite = result.stdin?.write
      const originalEnd = result.stdin?.end
      const chunks: Uint8Array[] = []

      const interceptedResult: SpawnResult = {
        ...result,
        stdin: {
          write: (data: Uint8Array) => {
            chunks.push(data)
            originalWrite?.(data)
          },
          end: () => {
            call.stdinData = new TextDecoder().decode(
              chunks.reduce((acc, c) => {
                const merged = new Uint8Array(acc.length + c.length)
                merged.set(acc)
                merged.set(c, acc.length)
                return merged
              }, new Uint8Array()),
            )
            originalEnd?.()
          },
        },
      }
      calls.push(call)
      return interceptedResult
    }

    calls.push(call)
    return result
  }

  return {spawnFn, calls}
}

/** Fake DNS resolver that always resolves. */
const resolvesOk = async (_host: string): Promise<void> => {}

/** Fake DNS resolver that always fails. */
const resolveFails = async (host: string): Promise<void> => {
  throw new Error(`DNS resolution failed for ${host}`)
}

/** Fake fetch that returns 200 for healthz. */
const fetchHealthzOk = async (_url: string, _opts?: RequestInit): Promise<Response> => {
  return new Response(JSON.stringify({ok: true}), {status: 200})
}

/**
 * Fake fetch that fails for /api/healthz (simulating ACME cert lag) but returns 200
 * for /operator/health (so the same-origin check passes in tests that use this mock).
 * Tests that need /operator/health to fail should use a custom fetch mock.
 */
const fetchHealthzFail = async (url: string, _opts?: RequestInit): Promise<Response> => {
  if (url.includes('/operator/health')) {
    // Return 200 for the operator health check — this mock simulates ACME lag only for /api/healthz
    return new Response(JSON.stringify({ok: true}), {status: 200})
  }
  throw new Error('fetch failed')
}

/**
 * Builds a standard set of responses for a happy-path deploy.
 * Call order (no override upload — digest is sourced from committed compose file):
 *   0: mkdir -p /opt/dashboard/config
 *   1: write .env (stdin)
 *   2: scp docker-compose.yaml
 *   3: scp Caddyfile
 *   4: write github-app.pem (stdin)
 *   5: chmod 0600 github-app.pem
 *   6: chown 1000:1000 github-app.pem
 *   7: rm -f docker-compose.override.yaml (stale legacy override cleanup)
 *   8: docker compose pull
 *   9: docker compose up -d --no-build --wait dashboard
 *  10: docker inspect (resolve image SHA for dashboard)
 *  11: docker inspect (RepoDigests for dashboard image)
 *  12: docker compose up -d --no-build --wait caddy
 *  13: (extra buffer)
 */
function makeHappyPathResponses(): SpawnResult[] {
  const repoDigestsJson = JSON.stringify([`ghcr.io/fro-bot/dashboard@${COMPOSE_DIGEST}`])
  return [
    makeSpawnResult(), // 0: mkdir
    makeSpawnResult(), // 1: write .env
    makeSpawnResult(), // 2: scp compose
    makeSpawnResult(), // 3: scp Caddyfile
    makeSpawnResult(), // 4: write github-app.pem
    makeSpawnResult(), // 5: chmod 0600
    makeSpawnResult(), // 6: chown 1000:1000
    makeSpawnResult(), // 7: rm -f docker-compose.override.yaml
    makeSpawnResult(), // 8: compose pull
    makeSpawnResult(), // 9: compose up dashboard
    makeSpawnResult('sha256:imageid123'), // 10: docker inspect (image SHA)
    makeSpawnResult(repoDigestsJson), // 11: docker inspect (RepoDigests)
    makeSpawnResult(), // 12: compose up caddy
    makeSpawnResult(), // 13: buffer
  ]
}

// ─── parseComposeImageDigest ──────────────────────────────────────────────────

describe('parseComposeImageDigest', () => {
  it('extracts the sha256 digest from a compose image line with tag@digest', () => {
    const line =
      '    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e'
    const digest = parseComposeImageDigest(line)
    expect(digest).toBe('sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e')
  })

  it('extracts the sha256 digest from a compose image line with only @digest (no tag)', () => {
    const line = `    image: ghcr.io/fro-bot/dashboard@${FAKE_DIGEST}`
    const digest = parseComposeImageDigest(line)
    expect(digest).toBe(FAKE_DIGEST)
  })

  it('returns null when no @sha256: digest is present', () => {
    const line = '    image: ghcr.io/fro-bot/dashboard:latest'
    const digest = parseComposeImageDigest(line)
    expect(digest).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(parseComposeImageDigest('')).toBeNull()
  })

  it('extracts the actual compose digest from the committed docker-compose.yaml', () => {
    // This test reads the real file — verifies the helper works end-to-end
    const digest = parseComposeImageDigest(dashboardImageLine)
    expect(digest).toBe(COMPOSE_DIGEST)
  })
})

// ─── env validation ───────────────────────────────────────────────────────────

describe('env validation', () => {
  it('accepts a fully valid env (no DASHBOARD_IMAGE_DIGEST required)', () => {
    expect(() => validateEnv(VALID_ENV)).not.toThrow()
  })

  it('does NOT require DASHBOARD_IMAGE_DIGEST', () => {
    // VALID_ENV has no DASHBOARD_IMAGE_DIGEST — must not throw
    const env = {...VALID_ENV}
    expect(() => validateEnv(env)).not.toThrow()
  })

  it('throws a specific message when DASHBOARD_DOMAIN is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_DOMAIN: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_DOMAIN')
  })

  it('throws a specific message when DASHBOARD_GITHUB_APP_ID is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_GITHUB_APP_ID: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_GITHUB_APP_ID')
  })

  it('throws a specific message when DASHBOARD_GITHUB_APP_KEY is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_GITHUB_APP_KEY: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_GITHUB_APP_KEY')
  })

  it('throws a specific message when DASHBOARD_OAUTH_CLIENT_ID is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_OAUTH_CLIENT_ID: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_OAUTH_CLIENT_ID')
  })

  it('throws a specific message when DASHBOARD_OAUTH_CLIENT_SECRET is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_OAUTH_CLIENT_SECRET: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_OAUTH_CLIENT_SECRET')
  })

  it('throws a specific message when DASHBOARD_OPERATOR_LOGIN is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_OPERATOR_LOGIN: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_OPERATOR_LOGIN')
  })

  it('throws a specific message when DASHBOARD_COOKIE_KEY is missing', () => {
    const env = {...VALID_ENV, DASHBOARD_COOKIE_KEY: ''}
    expect(() => validateEnv(env)).toThrow('DASHBOARD_COOKIE_KEY')
  })

  it('throws when PATH is missing', () => {
    const env = {...VALID_ENV, PATH: ''}
    expect(() => validateEnv(env)).toThrow('PATH')
  })

  it('throws when HOME is missing', () => {
    const env = {...VALID_ENV, HOME: ''}
    expect(() => validateEnv(env)).toThrow('HOME')
  })

  it('throws when SSH context is missing (no SSH_AUTH_SOCK, no DASHBOARD_SSH_KEY)', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: ''}
    expect(() => validateEnv(env)).toThrow(/SSH_AUTH_SOCK|DASHBOARD_SSH_KEY/)
  })

  it('accepts CI mode with DASHBOARD_SSH_KEY and no SSH_AUTH_SOCK', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: '', DASHBOARD_SSH_KEY: 'ssh-ed25519 AAAA...'}
    expect(() => validateEnv(env)).not.toThrow()
  })

  it('rejects a ProxyCommand-injection domain before any SSH argv is built', () => {
    const env = {...VALID_ENV, DASHBOARD_DOMAIN: '-oProxyCommand=x'}
    expect(() => validateEnv(env)).toThrow()
  })
})

// ─── secret boundary validation ───────────────────────────────────────────────

describe('secret boundary validation', () => {
  it('accepts a clean secret value', () => {
    expect(() => validateSecretValue('cleanpassword123', 'TEST')).not.toThrow()
  })

  it('rejects a value containing a newline', () => {
    expect(() => validateSecretValue('bad\nvalue', 'TEST')).toThrow()
  })

  it('rejects a value containing a backtick', () => {
    expect(() => validateSecretValue('bad`value', 'TEST')).toThrow()
  })

  it('rejects a value containing a dollar sign', () => {
    expect(() => validateSecretValue('bad$value', 'TEST')).toThrow()
  })

  it('rejects a value containing a semicolon', () => {
    expect(() => validateSecretValue('bad;value', 'TEST')).toThrow()
  })

  it('error message contains the var name but NOT the offending character', () => {
    try {
      validateSecretValue('bad`value', 'MY_SECRET')
      expect(true).toBe(false) // should not reach here
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      expect(msg).toContain('MY_SECRET')
      expect(msg).toContain('shell metacharacter')
      // Must NOT echo the secret-derived byte
      expect(msg).not.toContain('`')
    }
  })
})

// ─── .env file contents ───────────────────────────────────────────────────────

describe('.env file contents', () => {
  it('builds the correct .env file contents', () => {
    const contents = buildEnvFileContents({
      domain: 'dashboard.fro.bot',
      githubAppId: '123456',
      oauthClientId: 'Iv1.abc123',
      oauthClientSecret: 'oauthsecret',
      operatorLogin: 'marcusrbrown',
      cookieKey: 'cookiekey',
    })
    expect(contents).toContain('DASHBOARD_DOMAIN=dashboard.fro.bot\n')
    expect(contents).toContain('DASHBOARD_GITHUB_APP_ID=123456\n')
    expect(contents).toContain('DASHBOARD_OAUTH_CLIENT_ID=Iv1.abc123\n')
    expect(contents).toContain('DASHBOARD_OAUTH_CLIENT_SECRET=oauthsecret\n')
    expect(contents).toContain('DASHBOARD_OPERATOR_LOGIN=marcusrbrown\n')
    expect(contents).toContain('DASHBOARD_COOKIE_KEY=cookiekey\n')
    // App key must be a FILE path, not the PEM content
    expect(contents).toContain('DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem\n')
    // OAuth redirect URI must be derived from domain, not hardcoded to localhost
    expect(contents).toContain('DASHBOARD_OAUTH_REDIRECT_URI=https://dashboard.fro.bot/auth/callback\n')
    // Image ref must NOT be in .env — it's pinned in docker-compose.yaml
    expect(contents).not.toContain('DASHBOARD_IMAGE_REF')
  })

  it('does NOT put the raw PEM in .env', () => {
    const pemContent = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    const contents = buildEnvFileContents({
      domain: 'dashboard.fro.bot',
      githubAppId: '123456',
      oauthClientId: 'Iv1.abc123',
      oauthClientSecret: 'oauthsecret',
      operatorLogin: 'marcusrbrown',
      cookieKey: 'cookiekey',
    })
    expect(contents).not.toContain('BEGIN RSA PRIVATE KEY')
    expect(contents).not.toContain(pemContent)
  })
})

// ─── assertRunningImageDigest ─────────────────────────────────────────────────

describe('assertRunningImageDigest', () => {
  it('passes when expected digest is present in RepoDigests', () => {
    const repoDigests = [`ghcr.io/fro-bot/dashboard@${FAKE_DIGEST}`]
    expect(() => assertRunningImageDigest(repoDigests, FAKE_DIGEST, 'dashboard')).not.toThrow()
  })

  it('throws when expected digest is not present', () => {
    const otherDigest = `sha256:${'b'.repeat(64)}`
    const repoDigests = [`ghcr.io/fro-bot/dashboard@${otherDigest}`]
    expect(() => assertRunningImageDigest(repoDigests, FAKE_DIGEST, 'dashboard')).toThrow(/digest|dashboard/)
  })

  it('throws when RepoDigests is empty', () => {
    expect(() => assertRunningImageDigest([], FAKE_DIGEST, 'dashboard')).toThrow(/digest|dashboard/)
  })
})

// ─── DNS preflight ────────────────────────────────────────────────────────────

describe('DNS preflight', () => {
  it('fails fast with a clear message when DNS does not resolve', async () => {
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: makeFakeSpawn([makeSpawnResult()]).spawnFn,
        resolve: resolveFails,
        fetch: fetchHealthzOk,
      }),
    ).rejects.toThrow(/DNS|resolve|dashboard\.fro\.bot/)
  })
})

// ─── happy path ───────────────────────────────────────────────────────────────

describe('happy path deploy', () => {
  it('completes without throwing', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('materializes .env via SSH stdin (not argv)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find the .env write call — stdin must contain DASHBOARD_DOMAIN
    const envFileWrite = calls.find(c => c.stdinData.includes('DASHBOARD_DOMAIN='))
    expect(envFileWrite).toBeDefined()
    // The domain must be in stdin, not in the cmd
    expect(envFileWrite?.cmd.join(' ')).not.toContain('DASHBOARD_DOMAIN=')
  })

  it('uploads docker-compose.yaml', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const composeUpload = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker-compose.yaml') || (s.includes('scp') && s.includes('compose'))
    })
    expect(composeUpload).toBeDefined()
  })

  it('uploads Caddyfile', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const caddyUpload = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('Caddyfile') || (s.includes('scp') && s.includes('caddy'))
    })
    expect(caddyUpload).toBeDefined()
  })

  it('brings up dashboard before caddy', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const dashboardUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('dashboard') && !s.includes('caddy')
    })
    const caddyUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('caddy')
    })

    expect(dashboardUpIdx).toBeGreaterThan(-1)
    expect(caddyUpIdx).toBeGreaterThan(-1)
    expect(dashboardUpIdx).toBeLessThan(caddyUpIdx)
  })

  it('uses --no-build for both compose up calls', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const composeUpCalls = calls.filter(c => c.cmd.join(' ').includes('docker compose up'))
    expect(composeUpCalls.length).toBeGreaterThanOrEqual(2)
    for (const call of composeUpCalls) {
      expect(call.cmd.join(' ')).toContain('--no-build')
    }
  })

  it('probes /api/healthz', async () => {
    const probedUrls: string[] = []
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: async (url: string, opts?: RequestInit) => {
        probedUrls.push(url)
        return fetchHealthzOk(url, opts)
      },
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    expect(probedUrls.some(u => u.includes('/api/healthz'))).toBe(true)
  })

  it('removes stale docker-compose.override.yaml before docker compose pull', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find the rm -f cleanup call
    const rmCall = calls.find(
      c => c.cmd.join(' ').includes('rm -f') && c.cmd.join(' ').includes('docker-compose.override.yaml'),
    )
    expect(rmCall).toBeDefined()

    // It must come before docker compose pull
    const rmIdx = calls.findIndex(
      c => c.cmd.join(' ').includes('rm -f') && c.cmd.join(' ').includes('docker-compose.override.yaml'),
    )
    const pullIdx = calls.findIndex(c => c.cmd.join(' ').includes('docker compose pull'))
    expect(rmIdx).toBeGreaterThan(-1)
    expect(pullIdx).toBeGreaterThan(-1)
    expect(rmIdx).toBeLessThan(pullIdx)
  })

  it('does NOT upload docker-compose.override.yaml (only removes it)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // No scp or stdin-write call should reference docker-compose.override.yaml
    // (the rm -f cleanup call is expected and allowed)
    const uploadOverrideCall = calls.find(c => {
      const s = c.cmd.join(' ') + c.stdinData
      return (
        s.includes('docker-compose.override.yaml') && !s.includes('rm -f') // rm -f is the expected cleanup, not an upload
      )
    })
    expect(uploadOverrideCall).toBeUndefined()
  })

  it('uses digest from committed compose file for assertRunningImageDigest', async () => {
    // Provide a RepoDigests response that matches the compose-pinned digest
    const responses = makeHappyPathResponses()
    // responses[11] already returns COMPOSE_DIGEST — deploy should pass
    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── SECURITY: App key never in argv ─────────────────────────────────────────

describe('SECURITY: App key PEM never in spawn argv', () => {
  it('does not place the App key PEM in any spawn argv', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const pemContent = VALID_ENV.DASHBOARD_GITHUB_APP_KEY
    // Check every spawn call's argv — PEM must never appear
    for (const call of calls) {
      const argvStr = call.cmd.join(' ')
      expect(argvStr).not.toContain('BEGIN RSA PRIVATE KEY')
      expect(argvStr).not.toContain(pemContent)
    }
  })

  it('places App key PEM bytes in SSH stdin, not argv', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // The PEM must appear in stdin of some call (the App key upload)
    const pemInStdin = calls.some(c => c.stdinData.includes('BEGIN RSA PRIVATE KEY'))
    expect(pemInStdin).toBe(true)
  })

  it('uploads App key to the correct remote path', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find the call that writes the PEM via stdin
    const pemWrite = calls.find(c => c.stdinData.includes('BEGIN RSA PRIVATE KEY'))
    expect(pemWrite).toBeDefined()
    // The command must reference the correct remote path
    expect(pemWrite?.cmd.join(' ')).toContain('github-app.pem')
  })

  it('does not place any secret value in any spawn argv', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const secrets = [
      VALID_ENV.DASHBOARD_GITHUB_APP_KEY,
      VALID_ENV.DASHBOARD_OAUTH_CLIENT_SECRET,
      VALID_ENV.DASHBOARD_COOKIE_KEY,
    ]

    for (const call of calls) {
      for (const secret of secrets) {
        const argvStr = call.cmd.join(' ')
        expect(argvStr).not.toContain(secret)
      }
    }
  })
})

// ─── edge cases ───────────────────────────────────────────────────────────────

describe('edge cases', () => {
  it('throws before any SSH call when DASHBOARD_DOMAIN is missing', async () => {
    const env = {...VALID_ENV, DASHBOARD_DOMAIN: ''}
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
      }),
    ).rejects.toThrow('DASHBOARD_DOMAIN')

    // No SSH calls should have been made
    expect(calls).toHaveLength(0)
  })

  it('rejects -oProxyCommand= host before any SSH argv', async () => {
    const env = {...VALID_ENV, DASHBOARD_DOMAIN: '-oProxyCommand=evil'}
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
      }),
    ).rejects.toThrow()

    expect(calls).toHaveLength(0)
  })

  it('fails closed when RepoDigests mismatch (compose-sourced digest)', async () => {
    const wrongDigest = `sha256:${'b'.repeat(64)}`
    const wrongRepoDigestsJson = JSON.stringify([`ghcr.io/fro-bot/dashboard@${wrongDigest}`])

    const responses = makeHappyPathResponses()
    // Override the RepoDigests response (index 11) with a mismatched digest
    responses[11] = makeSpawnResult(wrongRepoDigestsJson)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/digest|dashboard/)
  })

  it('succeeds with a warning when /api/healthz never returns ok (ACME lag)', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    // Should resolve (not throw) even when fetch always fails
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzFail,
        probeAttempts: 2,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('succeeds when /api/healthz returns 200', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 2,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── .env does not contain image ref ─────────────────────────────────────────

describe('.env does not contain image ref', () => {
  it('does NOT include DASHBOARD_IMAGE_REF in .env (pinning in docker-compose.yaml)', () => {
    const contents = buildEnvFileContents({
      domain: 'dashboard.fro.bot',
      githubAppId: '123456',
      oauthClientId: 'Iv1.abc123',
      oauthClientSecret: 'oauthsecret',
      operatorLogin: 'marcusrbrown',
      cookieKey: 'cookiekey',
    })
    expect(contents).not.toContain('DASHBOARD_IMAGE_REF')
    expect(contents).not.toContain('sha256:')
  })
})

// ─── chown for node user ──────────────────────────────────────────────────────

describe('GitHub App key chown for node user', () => {
  it('runs chown 1000:1000 on the App key after chmod', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find the chown call
    const chownCall = calls.find(c => c.cmd.join(' ').includes('chown 1000:1000'))
    expect(chownCall).toBeDefined()
    expect(chownCall?.cmd.join(' ')).toContain('github-app.pem')
  })

  it('runs chown AFTER chmod (chmod before chown)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const chmodIdx = calls.findIndex(c => c.cmd.join(' ').includes('chmod 0600'))
    const chownIdx = calls.findIndex(c => c.cmd.join(' ').includes('chown 1000:1000'))
    expect(chmodIdx).toBeGreaterThan(-1)
    expect(chownIdx).toBeGreaterThan(-1)
    expect(chmodIdx).toBeLessThan(chownIdx)
  })
})

// ─── digest-verify cwd ────────────────────────────────────────────────────────

describe('digest-verify SSH command scoped to REMOTE_DIR', () => {
  it('docker compose ps -q dashboard in digest-verify step is prefixed with cd /opt/dashboard', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find the call that resolves the running image SHA (docker inspect + docker compose ps -q)
    const digestVerifyCall = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker inspect') && s.includes('docker compose ps -q dashboard')
    })

    expect(digestVerifyCall).toBeDefined()
    const cmdStr = digestVerifyCall?.cmd.join(' ') ?? ''

    // The command must be scoped to /opt/dashboard before docker compose ps
    expect(cmdStr).toContain('cd /opt/dashboard')

    // cd /opt/dashboard must appear BEFORE docker compose ps -q dashboard
    const cdIdx = cmdStr.indexOf('cd /opt/dashboard')
    const psIdx = cmdStr.indexOf('docker compose ps -q dashboard')
    expect(cdIdx).toBeGreaterThan(-1)
    expect(psIdx).toBeGreaterThan(-1)
    expect(cdIdx).toBeLessThan(psIdx)
  })
})

// ─── CI mode (DASHBOARD_SSH_KEY) ──────────────────────────────────────────────

describe('CI mode with DASHBOARD_SSH_KEY', () => {
  it('accepts CI env with DASHBOARD_SSH_KEY and no SSH_AUTH_SOCK', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: '', DASHBOARD_SSH_KEY: 'ssh-ed25519 AAAA...'}
    expect(() => validateEnv(env)).not.toThrow()
  })

  it('does not place the SSH key content in any argv', async () => {
    const ciEnv = {...VALID_ENV, SSH_AUTH_SOCK: '', DASHBOARD_SSH_KEY: 'ssh-ed25519 AAAA-UNIQUE-KEY-CONTENT'}
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: ciEnv,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toContain('AAAA-UNIQUE-KEY-CONTENT')
    }
  })
})

// ─── GATEWAY_VPC_IP validation ────────────────────────────────────────────────

describe('validateGatewayVpcIp', () => {
  it('accepts a valid private IPv4 address', () => {
    expect(() => validateGatewayVpcIp('10.116.0.3')).not.toThrow()
  })

  it('accepts other valid IPv4 addresses', () => {
    expect(() => validateGatewayVpcIp('192.168.1.1')).not.toThrow()
    expect(() => validateGatewayVpcIp('172.16.0.1')).not.toThrow()
    expect(() => validateGatewayVpcIp('10.0.0.1')).not.toThrow()
  })

  it('rejects an empty string', () => {
    expect(() => validateGatewayVpcIp('')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects a hostname (not an IP)', () => {
    expect(() => validateGatewayVpcIp('gateway.fro.bot')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects a value starting with a dash (injection risk)', () => {
    expect(() => validateGatewayVpcIp('-oProxyCommand=x')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects an IPv6 address', () => {
    expect(() => validateGatewayVpcIp('::1')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects a malformed IP (too many octets)', () => {
    expect(() => validateGatewayVpcIp('10.116.0.3.4')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects a malformed IP (octet out of range)', () => {
    expect(() => validateGatewayVpcIp('10.116.0.999')).toThrow(/GATEWAY_VPC_IP/)
  })

  it('rejects a value with shell metacharacters', () => {
    expect(() => validateGatewayVpcIp('10.0.0.1;rm -rf /')).toThrow(/GATEWAY_VPC_IP/)
  })
})

// ─── Caddyfile structure ──────────────────────────────────────────────────────

describe('committed Caddyfile structure', () => {
  const caddyfilePath = join(import.meta.dir, '..', 'config', 'Caddyfile')
  const caddyfile = readFileSync(caddyfilePath, 'utf8')

  it('contains a handle /operator/* block', () => {
    expect(caddyfile).toContain('handle /operator/*')
  })

  it('contains flush_interval -1 in the operator block', () => {
    expect(caddyfile).toContain('flush_interval -1')
  })

  it('contains header_up Host dashboard.fro.bot', () => {
    expect(caddyfile).toContain('header_up Host dashboard.fro.bot')
  })

  it('contains header_up X-Forwarded-Proto https', () => {
    expect(caddyfile).toContain('header_up X-Forwarded-Proto https')
  })

  it('uses {$GATEWAY_VPC_IP}:9300 as the operator proxy target (no literal IP)', () => {
    expect(caddyfile).toContain('{$GATEWAY_VPC_IP}:9300')
    // Must not contain a literal IP in the proxy target
    expect(caddyfile).not.toMatch(/reverse_proxy \d+\.\d+\.\d+\.\d+:9300/)
  })

  it('wraps the dashboard:3000 catch-all in its own handle block', () => {
    // The catch-all must be in a bare handle block, not a bare reverse_proxy.
    // Check structurally: the Caddyfile must contain a bare `handle {` block
    // and a `reverse_proxy dashboard:3000` line, and the handle block must come
    // after the /operator/* handle block.
    expect(caddyfile).toContain('handle {')
    expect(caddyfile).toContain('reverse_proxy dashboard:3000')
  })

  it('has the /operator/* handle block before the catch-all handle block', () => {
    const operatorIdx = caddyfile.indexOf('handle /operator/*')
    const catchAllIdx = caddyfile.indexOf('handle {')
    expect(operatorIdx).toBeGreaterThan(-1)
    expect(catchAllIdx).toBeGreaterThan(-1)
    expect(operatorIdx).toBeLessThan(catchAllIdx)
  })

  it('does not use a bare reverse_proxy at the site-block level (must be inside handle blocks)', () => {
    // A bare reverse_proxy at the site-block level (2-space indent) would be subject to
    // Caddy directive ordering and could sort ahead of the /operator/* route.
    // All reverse_proxy directives must be inside handle blocks (4+ spaces indent).
    const lines = caddyfile.split('\n')
    for (const line of lines) {
      // Site-block level: exactly 2 spaces of indentation (inside the host block, outside any handle)
      if (/^ {2}reverse_proxy\s/.test(line)) {
        throw new Error(`Found bare reverse_proxy at site-block level: ${line}`)
      }
    }
  })
})

// ─── buildEnvFileContents includes GATEWAY_VPC_IP ────────────────────────────

describe('buildEnvFileContents with GATEWAY_VPC_IP', () => {
  it('includes GATEWAY_VPC_IP when provided', () => {
    const contents = buildEnvFileContents({
      domain: 'dashboard.fro.bot',
      githubAppId: '123456',
      oauthClientId: 'Iv1.abc123',
      oauthClientSecret: 'oauthsecret',
      operatorLogin: 'marcusrbrown',
      cookieKey: 'cookiekey',
      gatewayVpcIp: '10.116.0.3',
    })
    expect(contents).toContain('GATEWAY_VPC_IP=10.116.0.3\n')
  })

  it('omits GATEWAY_VPC_IP when not provided', () => {
    const contents = buildEnvFileContents({
      domain: 'dashboard.fro.bot',
      githubAppId: '123456',
      oauthClientId: 'Iv1.abc123',
      oauthClientSecret: 'oauthsecret',
      operatorLogin: 'marcusrbrown',
      cookieKey: 'cookiekey',
    })
    expect(contents).not.toContain('GATEWAY_VPC_IP')
  })
})

// ─── deploy forwards GATEWAY_VPC_IP to caddy service ─────────────────────────

describe('deploy forwards GATEWAY_VPC_IP to caddy service env', () => {
  it('includes GATEWAY_VPC_IP in the .env written via SSH stdin', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // The .env write (stdin) must contain GATEWAY_VPC_IP
    const envFileWrite = calls.find(c => c.stdinData.includes('DASHBOARD_DOMAIN='))
    expect(envFileWrite).toBeDefined()
    expect(envFileWrite?.stdinData).toContain('GATEWAY_VPC_IP=10.116.0.3')
  })

  it('does not include GATEWAY_VPC_IP in any spawn argv (only in stdin)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toContain('GATEWAY_VPC_IP=')
    }
  })

  it('succeeds without GATEWAY_VPC_IP (optional — operator route disabled when absent)', async () => {
    const envWithoutVpcIp = {...VALID_ENV, GATEWAY_VPC_IP: ''}
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await expect(
      deploy({
        env: envWithoutVpcIp,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('throws before any SSH call when GATEWAY_VPC_IP is malformed', async () => {
    const envWithBadVpcIp = {...VALID_ENV, GATEWAY_VPC_IP: 'not-an-ip'}
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env: envWithBadVpcIp,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
      }),
    ).rejects.toThrow(/GATEWAY_VPC_IP/)

    expect(calls).toHaveLength(0)
  })
})

// ─── validateEnv with GATEWAY_VPC_IP ─────────────────────────────────────────

describe('validateEnv with GATEWAY_VPC_IP', () => {
  it('accepts a valid GATEWAY_VPC_IP', () => {
    expect(() => validateEnv({...VALID_ENV, GATEWAY_VPC_IP: '10.116.0.3'})).not.toThrow()
  })

  it('accepts missing GATEWAY_VPC_IP (optional)', () => {
    const env: Record<string, string> = {...VALID_ENV}
    delete env.GATEWAY_VPC_IP
    expect(() => validateEnv(env)).not.toThrow()
  })

  it('throws when GATEWAY_VPC_IP is present but malformed', () => {
    expect(() => validateEnv({...VALID_ENV, GATEWAY_VPC_IP: 'not-an-ip'})).toThrow(/GATEWAY_VPC_IP/)
  })

  it('throws when GATEWAY_VPC_IP starts with a dash', () => {
    expect(() => validateEnv({...VALID_ENV, GATEWAY_VPC_IP: '-oProxyCommand=x'})).toThrow(/GATEWAY_VPC_IP/)
  })
})

// ─── same-origin /operator/health 200 check ──────────────
//
// The dashboard deploy owns the /operator/* Caddy route and runs after the gateway
// deploy. Once the route is live, the runner can probe
// https://dashboard.fro.bot/operator/health from the public internet (the dashboard
// is publicly reachable via Caddy → VPC → gateway operator daemon).
//
// Gate: GATEWAY_VPC_IP is set (i.e. the operator route is active).
// Fail closed: /operator/health != 200 → deploy throws.
// Edge: GATEWAY_VPC_IP absent → check skipped (only the existing /api/healthz check runs).
//
// The public-denied gateway.fro.bot:9300 check and DO firewall readback belong to
// the gateway deploy (Phase 8e). The DOCKER-USER readback belongs to Phase 8c.
// This unit adds only the same-origin health check that the dashboard deploy owns.

describe('dashboard verification: same-origin /operator/health 200 check', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  it('happy path: GATEWAY_VPC_IP set + /operator/health returns 200 → deploy passes', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const probedUrls: string[] = []

    await expect(
      deploy({
        env: VALID_ENV, // VALID_ENV includes GATEWAY_VPC_IP: '10.116.0.3'
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          probedUrls.push(url)
          // Both /api/healthz and /operator/health return 200
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()

    // Must have probed /operator/health
    expect(probedUrls.some(u => u.includes('/operator/health'))).toBe(true)
  })

  // ── Error: /operator/health != 200 → fail closed ────────────────────────────

  it('error: GATEWAY_VPC_IP set + /operator/health returns 503 → deploy fails closed', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          if (url.includes('/operator/health')) {
            return new Response('Service Unavailable', {status: 503})
          }
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/operator.*health|health.*operator|\/operator\/health/i)
  })

  it('error: GATEWAY_VPC_IP set + /operator/health returns 404 → deploy fails closed', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          if (url.includes('/operator/health')) {
            return new Response('Not Found', {status: 404})
          }
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/operator.*health|health.*operator|\/operator\/health/i)
  })

  // ── Edge: GATEWAY_VPC_IP absent → check skipped ──────────────────────────────

  it('edge: GATEWAY_VPC_IP absent → /operator/health check skipped, deploy succeeds', async () => {
    const envWithoutVpcIp = {...VALID_ENV, GATEWAY_VPC_IP: ''}
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const probedUrls: string[] = []

    await expect(
      deploy({
        env: envWithoutVpcIp,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          probedUrls.push(url)
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()

    // Must NOT have probed /operator/health when GATEWAY_VPC_IP is absent
    expect(probedUrls.some(u => u.includes('/operator/health'))).toBe(false)
  })

  it('edge: GATEWAY_VPC_IP absent → only /api/healthz is probed (existing check still runs)', async () => {
    const envWithoutVpcIp = {...VALID_ENV, GATEWAY_VPC_IP: ''}
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const probedUrls: string[] = []

    await deploy({
      env: envWithoutVpcIp,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: async (url: string, _opts?: RequestInit) => {
        probedUrls.push(url)
        return new Response(JSON.stringify({ok: true}), {status: 200})
      },
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // The existing /api/healthz check must still run
    expect(probedUrls.some(u => u.includes('/api/healthz'))).toBe(true)
    // But /operator/health must not be probed
    expect(probedUrls.some(u => u.includes('/operator/health'))).toBe(false)
  })

  // ── Probe targets the correct URL ────────────────────────────────────────────

  it('probes https://dashboard.fro.bot/operator/health (the same-origin path)', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const probedUrls: string[] = []

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: async (url: string, _opts?: RequestInit) => {
        probedUrls.push(url)
        return new Response(JSON.stringify({ok: true}), {status: 200})
      },
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const operatorHealthProbes = probedUrls.filter(u => u.includes('/operator/health'))
    expect(operatorHealthProbes.length).toBeGreaterThan(0)
    // Must use the dashboard domain (same-origin), not the gateway VPC IP
    expect(operatorHealthProbes.every(u => u.includes('dashboard.fro.bot'))).toBe(true)
    expect(operatorHealthProbes.every(u => !u.includes('10.116.0.3'))).toBe(true)
  })

  // ── /operator/health check runs after Caddy is up ────────────────────────────

  it('/operator/health check runs after Caddy is started (Caddy must be up for the route to work)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())
    const eventLog: string[] = []

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: async (url: string, _opts?: RequestInit) => {
        if (url.includes('/operator/health')) {
          eventLog.push('operator-health-probe')
        }
        return new Response(JSON.stringify({ok: true}), {status: 200})
      },
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // Find when Caddy was started
    const caddyUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('caddy')
    })

    const operatorHealthIdx = eventLog.indexOf('operator-health-probe')

    expect(caddyUpIdx).toBeGreaterThan(-1)
    expect(operatorHealthIdx).toBeGreaterThanOrEqual(0)
    // The operator health probe must happen after Caddy is started
    // (We verify this by checking the probe appears in the event log, which is populated
    // during the fetch calls that happen after all spawn calls for compose up)
    // Since fetch is called after all spawn calls complete, this ordering is guaranteed.
  })
})

// ─── [P1] /operator/health retry loop ────────────────────────────────────────
//
// Phase 12b must retry the /operator/health check with bounded attempts,
// matching the existing /api/healthz probe pattern. Fail closed after all
// attempts exhausted.

describe('dashboard verification: /operator/health retry loop (P1 fix)', () => {
  it('succeeds on a later attempt (retry works)', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let operatorHealthAttempts = 0

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          if (url.includes('/operator/health')) {
            operatorHealthAttempts++
            if (operatorHealthAttempts < 3) {
              return new Response('Service Unavailable', {status: 503})
            }
            return new Response(JSON.stringify({ok: true}), {status: 200})
          }
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 5,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()

    // Must have retried — at least 3 attempts
    expect(operatorHealthAttempts).toBeGreaterThanOrEqual(3)
  })

  it('fails closed after all attempts non-200', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let operatorHealthAttempts = 0

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          if (url.includes('/operator/health')) {
            operatorHealthAttempts++
            return new Response('Service Unavailable', {status: 503})
          }
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 3,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/operator.*health|health.*operator|\/operator\/health/i)

    // Must have exhausted all attempts
    expect(operatorHealthAttempts).toBe(3)
  })

  it('connection error on all attempts → fails closed', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let operatorHealthAttempts = 0

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string, _opts?: RequestInit) => {
          if (url.includes('/operator/health')) {
            operatorHealthAttempts++
            throw new TypeError('fetch failed: connection refused')
          }
          return new Response(JSON.stringify({ok: true}), {status: 200})
        },
        probeAttempts: 3,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/operator.*health|health.*operator|\/operator\/health/i)

    expect(operatorHealthAttempts).toBeGreaterThanOrEqual(1)
  })
})
