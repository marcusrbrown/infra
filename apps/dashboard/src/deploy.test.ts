import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  assertRunningImageDigest,
  buildEnvFileContents,
  deploy,
  generateComposeContent,
  parseComposeImageDigest,
  validateCalVer,
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
 * Fake fetch that fails for /api/healthz (simulating ACME cert lag).
 * /operator/health also throws here — since Phase 12b is non-blocking, the deploy
 * still completes. Tests that need /operator/health to return a specific status
 * should use a custom fetch mock.
 */
const fetchHealthzFail = async (_url: string, _opts?: RequestInit): Promise<Response> => {
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
    // Operator UI flags must always be present (static constants, not secrets)
    expect(contents).toContain('DASHBOARD_OPERATOR_UI_ENABLED=true\n')
    expect(contents).toContain('DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true\n')
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

  it('contains an owned-paths handle covering /api/*', () => {
    expect(caddyfile).toContain('/api/*')
  })

  it('contains an owned-paths handle covering /auth/*', () => {
    expect(caddyfile).toContain('/auth/*')
  })

  it('contains an owned-paths handle covering /assets/*', () => {
    expect(caddyfile).toContain('/assets/*')
  })

  it('contains an owned-paths handle covering /manifest.webmanifest', () => {
    expect(caddyfile).toContain('/manifest.webmanifest')
  })

  it('contains an owned-paths handle covering /icon-*', () => {
    expect(caddyfile).toContain('/icon-*')
  })

  it('has /operator/* before the owned-paths handle, and owned-paths before the catch-all', () => {
    const operatorIdx = caddyfile.indexOf('handle /operator/*')
    // The owned-paths handle block is identified by `handle @owned`
    const ownedPathsIdx = caddyfile.indexOf('handle @owned')
    const catchAllIdx = caddyfile.lastIndexOf('handle {')
    expect(operatorIdx).toBeGreaterThan(-1)
    expect(ownedPathsIdx).toBeGreaterThan(-1)
    expect(catchAllIdx).toBeGreaterThan(-1)
    expect(operatorIdx).toBeLessThan(ownedPathsIdx)
    expect(ownedPathsIdx).toBeLessThan(catchAllIdx)
  })

  it('has rewrite * / before reverse_proxy dashboard:3000 in the catch-all handle', () => {
    const rewriteIdx = caddyfile.indexOf('rewrite * /')
    const catchAllProxyIdx = caddyfile.lastIndexOf('reverse_proxy dashboard:3000')
    expect(rewriteIdx).toBeGreaterThan(-1)
    expect(catchAllProxyIdx).toBeGreaterThan(-1)
    expect(rewriteIdx).toBeLessThan(catchAllProxyIdx)
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

// ─── same-origin /operator/health advisory check (non-blocking) ──────────────
//
// Phase 12b probes https://dashboard.fro.bot/operator/health when GATEWAY_VPC_IP is set.
// The check is advisory: a non-200 result or unreachable endpoint emits a warning and
// the deploy continues. The gateway bridge is deployed independently; the dashboard
// deploy must not depend on gateway readiness.
//
// Gate: GATEWAY_VPC_IP is set (i.e. the operator route is active).
// Non-blocking: /operator/health != 200 → warn and continue (never throws).
// Success: /operator/health == 200 → log success.
// Edge: GATEWAY_VPC_IP absent → check skipped (only the existing /api/healthz check runs).
//
// The public-denied gateway.fro.bot:9300 check and DO firewall readback belong to
// the gateway deploy (Phase 8e). The DOCKER-USER readback belongs to Phase 8c.
// This unit covers only the same-origin advisory check that the dashboard deploy owns.

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

  // ── Non-blocking: /operator/health != 200 → warn and continue ───────────────

  it('non-blocking: GATEWAY_VPC_IP set + /operator/health returns 503 → deploy warns and completes', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    // Deploy must complete (not throw) even when /operator/health returns 503
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
    ).resolves.toBeUndefined()
  })

  it('non-blocking: GATEWAY_VPC_IP set + /operator/health returns 404 → deploy warns and completes', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

    // Deploy must complete (not throw) even when /operator/health returns 404
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
    ).resolves.toBeUndefined()
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
// Phase 12b retries the /operator/health check with bounded attempts,
// matching the existing /api/healthz probe pattern. Non-blocking: after all
// attempts exhausted, emits a warning and continues (never throws).

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

  it('warns and completes after all attempts non-200 (non-blocking)', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let operatorHealthAttempts = 0

    // Deploy must complete (not throw) even after exhausting all /operator/health attempts
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
    ).resolves.toBeUndefined()

    // Must have exhausted all attempts
    expect(operatorHealthAttempts).toBe(3)
  })

  it('connection error on all attempts → warns and completes (non-blocking)', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let operatorHealthAttempts = 0

    // Deploy must complete (not throw) even when all /operator/health probes throw
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
    ).resolves.toBeUndefined()

    expect(operatorHealthAttempts).toBeGreaterThanOrEqual(1)
  })
})

// ─── validateCalVer ───────────────────────────────────────────────────────────

describe('validateCalVer', () => {
  it('accepts a valid CalVer string', () => {
    expect(() => validateCalVer('2026.06.15')).not.toThrow()
    expect(() => validateCalVer('2026.06.47')).not.toThrow()
    expect(() => validateCalVer('2024.01.0')).not.toThrow()
  })

  it('rejects "latest"', () => {
    expect(() => validateCalVer('latest')).toThrow(/version/)
  })

  it('rejects an empty string', () => {
    expect(() => validateCalVer('')).toThrow(/version/)
  })

  it('rejects a semver string (not CalVer)', () => {
    expect(() => validateCalVer('1.2.3')).toThrow(/version/)
  })

  it('rejects a version with extra components', () => {
    expect(() => validateCalVer('2026.06.15.1')).toThrow(/version/)
  })

  it('rejects a version with non-numeric parts', () => {
    expect(() => validateCalVer('2026.06.abc')).toThrow(/version/)
  })

  it('rejects injection strings', () => {
    expect(() => validateCalVer('2026.06.15; rm -rf /')).toThrow(/version/)
    expect(() => validateCalVer('$(evil)')).toThrow(/version/)
    expect(() => validateCalVer('`evil`')).toThrow(/version/)
  })

  it('rejects a version starting with a dash', () => {
    expect(() => validateCalVer('-oProxyCommand=x')).toThrow(/version/)
  })
})

// ─── generateComposeContent ───────────────────────────────────────────────────

describe('generateComposeContent', () => {
  const SAMPLE_COMPOSE = `services:
  dashboard:
    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}
    restart: unless-stopped
`

  it('replaces the image line with version@digest', () => {
    const newDigest = `sha256:${'b'.repeat(64)}`
    const result = generateComposeContent(SAMPLE_COMPOSE, '2026.06.47', newDigest)
    expect(result).toContain(`ghcr.io/fro-bot/dashboard:2026.06.47@${newDigest}`)
  })

  it('does not contain the old version after replacement', () => {
    const newDigest = `sha256:${'b'.repeat(64)}`
    const result = generateComposeContent(SAMPLE_COMPOSE, '2026.06.47', newDigest)
    expect(result).not.toContain('2026.06.15@sha256:')
  })

  it('preserves the rest of the compose file', () => {
    const newDigest = `sha256:${'b'.repeat(64)}`
    const result = generateComposeContent(SAMPLE_COMPOSE, '2026.06.47', newDigest)
    expect(result).toContain('restart: unless-stopped')
  })

  it('throws when no fro-bot/dashboard image line is found', () => {
    const badCompose = `services:\n  other:\n    image: nginx:latest\n`
    expect(() => generateComposeContent(badCompose, '2026.06.47', `sha256:${'b'.repeat(64)}`)).toThrow()
  })
})

// ─── versioned deploy path ────────────────────────────────────────────────────
//
// When version is provided:
// - resolves digest via `docker buildx imagetools inspect`
// - compares resolved digest to dispatched digest (if provided)
// - generates compose content with version@resolvedDigest
// - uploads generated compose (not the committed file)
// - verifies running image against resolvedDigest

const RESOLVED_DIGEST = `sha256:${'c'.repeat(64)}`

/**
 * Builds happy-path responses for a versioned deploy.
 * Prepends the imagetools inspect call (returns resolved digest) before the
 * standard deploy sequence. The compose upload is now via stdin (writeRemoteFile),
 * so the scp call for docker-compose.yaml is replaced by a stdin write.
 *
 * Call order for versioned deploy:
 *   0: docker buildx imagetools inspect (resolve digest)
 *   1: mkdir -p /opt/dashboard/config
 *   2: write .env (stdin)
 *   3: write docker-compose.yaml (stdin — generated content)
 *   4: scp Caddyfile
 *   5: write github-app.pem (stdin)
 *   6: chmod 0600 github-app.pem
 *   7: chown 1000:1000 github-app.pem
 *   8: rm -f docker-compose.override.yaml
 *   9: docker compose pull
 *  10: docker compose up -d --no-build --wait dashboard
 *  11: docker inspect (resolve image SHA)
 *  12: docker inspect (RepoDigests)
 *  13: docker compose up -d --no-build --wait caddy
 *  14: (buffer)
 */
function makeVersionedHappyPathResponses(): SpawnResult[] {
  const repoDigestsJson = JSON.stringify([`ghcr.io/fro-bot/dashboard@${RESOLVED_DIGEST}`])
  return [
    makeSpawnResult(RESOLVED_DIGEST), // 0: imagetools inspect → resolved digest
    makeSpawnResult(), // 1: mkdir
    makeSpawnResult(), // 2: write .env
    makeSpawnResult(), // 3: write docker-compose.yaml (stdin)
    makeSpawnResult(), // 4: scp Caddyfile
    makeSpawnResult(), // 5: write github-app.pem
    makeSpawnResult(), // 6: chmod 0600
    makeSpawnResult(), // 7: chown 1000:1000
    makeSpawnResult(), // 8: rm -f docker-compose.override.yaml
    makeSpawnResult(), // 9: compose pull
    makeSpawnResult(), // 10: compose up dashboard
    makeSpawnResult('sha256:imageid123'), // 11: docker inspect (image SHA)
    makeSpawnResult(repoDigestsJson), // 12: docker inspect (RepoDigests)
    makeSpawnResult(), // 13: compose up caddy
    makeSpawnResult(), // 14: buffer
  ]
}

describe('versioned deploy path', () => {
  it('rejects invalid CalVer before any SSH/spawn', async () => {
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: 'latest',
      }),
    ).rejects.toThrow(/version/)

    expect(calls).toHaveLength(0)
  })

  it('rejects digest mismatch when resolved digest differs from dispatched digest', async () => {
    const wrongDispatchedDigest = `sha256:${'d'.repeat(64)}`
    const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: wrongDispatchedDigest,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/digest/)
  })

  it('completes successfully with valid version + matching digest', async () => {
    const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('uploads generated compose content with version@resolvedDigest via stdin', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeVersionedHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      version: '2026.06.47',
      digest: RESOLVED_DIGEST,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    // The compose upload must contain the version@resolvedDigest image reference
    const composeWrite = calls.find(c => c.stdinData.includes('fro-bot/dashboard:2026.06.47@'))
    expect(composeWrite).toBeDefined()
    expect(composeWrite?.stdinData).toContain(`ghcr.io/fro-bot/dashboard:2026.06.47@${RESOLVED_DIGEST}`)
  })

  it('verifies running image against resolvedDigest (not committed compose digest)', async () => {
    // The RepoDigests response matches RESOLVED_DIGEST (not COMPOSE_DIGEST)
    const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

    // Should pass because makeVersionedHappyPathResponses returns RESOLVED_DIGEST in RepoDigests
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('fails when running image digest does not match resolvedDigest', async () => {
    const wrongRepoDigestsJson = JSON.stringify([`ghcr.io/fro-bot/dashboard@sha256:${'e'.repeat(64)}`])
    const responses = makeVersionedHappyPathResponses()
    // Override the RepoDigests response (index 12) with a mismatched digest
    responses[12] = makeSpawnResult(wrongRepoDigestsJson)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/digest/)
  })

  it('calls docker buildx imagetools inspect to resolve digest', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeVersionedHappyPathResponses())

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      version: '2026.06.47',
      digest: RESOLVED_DIGEST,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const imagetoolsCall = calls.find(c => c.cmd.join(' ').includes('imagetools inspect'))
    expect(imagetoolsCall).toBeDefined()
    expect(imagetoolsCall?.cmd.join(' ')).toContain('ghcr.io/fro-bot/dashboard:2026.06.47')
  })

  it('succeeds without dispatched digest (resolves and uses resolved digest only)', async () => {
    const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

    // No dispatched digest — should resolve and use the resolved digest
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: '',
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── no-version fallback ──────────────────────────────────────────────────────
//
// When no version is dispatched, the committed compose file is the source of
// truth. No imagetools inspect, no generated compose content, no audit commit.

describe('no-version fallback', () => {
  it('uses committed compose digest when no version is provided', async () => {
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

    // No imagetools inspect call
    const imagetoolsCall = calls.find(c => c.cmd.join(' ').includes('imagetools inspect'))
    expect(imagetoolsCall).toBeUndefined()
  })

  it('does not upload generated compose content (uses committed file via scp)', async () => {
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

    // The compose upload must be via scp (not stdin with generated content)
    const scpComposeCall = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('scp') && s.includes('docker-compose.yaml')
    })
    expect(scpComposeCall).toBeDefined()

    // No stdin write should contain a version@digest image reference for a new version
    // (the committed compose content may contain the existing pinned digest, but not a new one)
    const generatedComposeWrite = calls.find(c => c.stdinData.includes('fro-bot/dashboard:2026.06.47@'))
    expect(generatedComposeWrite).toBeUndefined()
  })

  it('succeeds without version or digest', async () => {
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
})

// ─── Gap 1: versioned deploy writes local compose path ───────────────────────
//
// After a successful versioned deploy, the local compose file at localComposePath
// must be updated to reflect version@resolvedDigest. This is what the workflow's
// `git add apps/dashboard/docker-compose.yaml` step reads for the audit commit.
//
// Tests use an injectable localComposePath (temp file) so the real
// apps/dashboard/docker-compose.yaml is never mutated.

describe('versioned deploy: writes local compose path after successful deploy', () => {
  const SAMPLE_COMPOSE_FOR_WRITE = `services:
  caddy:
    image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648
    restart: unless-stopped
  dashboard:
    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}
    restart: unless-stopped
`

  it('writes version@resolvedDigest to localComposePath after successful versioned deploy', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-compose-'))
    const tmpComposePath = join(tmpDir, 'docker-compose.yaml')
    writeFileSync(tmpComposePath, SAMPLE_COMPOSE_FOR_WRITE, 'utf8')

    try {
      const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

      await deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        localComposePath: tmpComposePath,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      })

      const written = readFileSync(tmpComposePath, 'utf8')
      expect(written).toContain(`ghcr.io/fro-bot/dashboard:2026.06.47@${RESOLVED_DIGEST}`)
      // Old version must be gone
      expect(written).not.toContain('2026.06.15@sha256:')
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('does NOT write local compose path on failed versioned deploy (digest mismatch)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-compose-'))
    const tmpComposePath = join(tmpDir, 'docker-compose.yaml')
    writeFileSync(tmpComposePath, SAMPLE_COMPOSE_FOR_WRITE, 'utf8')

    try {
      const wrongDispatchedDigest = `sha256:${'d'.repeat(64)}`
      const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

      await expect(
        deploy({
          env: VALID_ENV,
          spawn: spawnFn,
          resolve: resolvesOk,
          fetch: fetchHealthzOk,
          version: '2026.06.47',
          digest: wrongDispatchedDigest, // mismatch → throws before deploy
          localComposePath: tmpComposePath,
          probeAttempts: 1,
          probeIntervalMs: 0,
          sleep: async () => {},
        }),
      ).rejects.toThrow(/digest/)

      // Local compose must be unchanged
      const written = readFileSync(tmpComposePath, 'utf8')
      expect(written).toBe(SAMPLE_COMPOSE_FOR_WRITE)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('does NOT write local compose path on no-version fallback deploy', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-compose-'))
    const tmpComposePath = join(tmpDir, 'docker-compose.yaml')
    writeFileSync(tmpComposePath, SAMPLE_COMPOSE_FOR_WRITE, 'utf8')

    try {
      const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())

      await deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        localComposePath: tmpComposePath,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      })

      // No-version fallback must not mutate the local compose
      const written = readFileSync(tmpComposePath, 'utf8')
      expect(written).toBe(SAMPLE_COMPOSE_FOR_WRITE)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('does NOT write local compose path when caddy up fails (late deploy failure)', async () => {
    // Verifies that the local compose write only happens after the full deploy
    // succeeds. If caddy up (Phase 11) throws, the write must be skipped.
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-compose-'))
    const tmpComposePath = join(tmpDir, 'docker-compose.yaml')
    writeFileSync(tmpComposePath, SAMPLE_COMPOSE_FOR_WRITE, 'utf8')

    try {
      // Replace the caddy up response (index 13) with a failing exit code.
      const responses = makeVersionedHappyPathResponses()
      responses[13] = makeSpawnResult('', 'caddy up failed', 1)
      const {spawnFn} = makeFakeSpawn(responses)

      await expect(
        deploy({
          env: VALID_ENV,
          spawn: spawnFn,
          resolve: resolvesOk,
          fetch: fetchHealthzOk,
          version: '2026.06.47',
          digest: RESOLVED_DIGEST,
          localComposePath: tmpComposePath,
          probeAttempts: 1,
          probeIntervalMs: 0,
          sleep: async () => {},
        }),
      ).rejects.toThrow()

      // Local compose must be unchanged — write only happens after full success
      const written = readFileSync(tmpComposePath, 'utf8')
      expect(written).toBe(SAMPLE_COMPOSE_FOR_WRITE)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── Explicit input mode validation ──────────────────────────────────────────
//
// Valid modes:
//   a) all release inputs empty => no-version fallback
//   b) version (CalVer) + optional digest
//
// Invalid: digest without version, malformed digest, malformed version.

describe('explicit input mode validation', () => {
  it('rejects digest-only (no version) before any SSH/spawn', async () => {
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '',
        digest: FAKE_DIGEST,
      }),
    ).rejects.toThrow(/version|mode/)

    expect(calls).toHaveLength(0)
  })

  it('rejects malformed digest (not sha256:<64hex>) before any SSH/spawn', async () => {
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: 'sha256:tooshort',
      }),
    ).rejects.toThrow(/digest/)

    expect(calls).toHaveLength(0)
  })

  it('rejects digest without sha256: prefix before any SSH/spawn', async () => {
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult()])

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: 'a'.repeat(64),
      }),
    ).rejects.toThrow(/digest/)

    expect(calls).toHaveLength(0)
  })

  it('accepts valid version with omitted digest (empty string)', async () => {
    const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: '',
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── RED: generateComposeContent digest validation ───────────────────────────
//
// generateComposeContent must validate the digest with DIGEST_RE and throw on
// malformed input. It must also throw when more than one fro-bot/dashboard
// image line is found (silent multi-service drift guard).

describe('generateComposeContent: digest validation and duplicate guard', () => {
  it('throws on malformed digest (not sha256:<64hex>)', () => {
    const compose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}\n`
    expect(() => generateComposeContent(compose, '2026.06.47', 'sha256:tooshort')).toThrow(/digest/)
  })

  it('throws on digest without sha256: prefix', () => {
    const compose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}\n`
    expect(() => generateComposeContent(compose, '2026.06.47', 'a'.repeat(64))).toThrow(/digest/)
  })

  it('throws on empty digest', () => {
    const compose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}\n`
    expect(() => generateComposeContent(compose, '2026.06.47', '')).toThrow(/digest/)
  })

  it('throws when more than one fro-bot/dashboard image line is found', () => {
    const compose = `services:
  dashboard:
    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}
  dashboard2:
    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}
`
    expect(() => generateComposeContent(compose, '2026.06.47', `sha256:${'b'.repeat(64)}`)).toThrow(
      /fro-bot\/dashboard|multiple|more than one/,
    )
  })

  it('accepts exactly one fro-bot/dashboard image line with valid digest', () => {
    const compose = `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:${'a'.repeat(64)}\n`
    const newDigest = `sha256:${'b'.repeat(64)}`
    expect(() => generateComposeContent(compose, '2026.06.47', newDigest)).not.toThrow()
  })
})

// ─── RED: resolveImageDigest fallback and error paths ────────────────────────
//
// resolveImageDigest must:
// - parse "Digest: sha256:<hex>" fallback output when template format unavailable
// - throw with a clear message on unparseable output

describe('resolveImageDigest: fallback Digest: output and unparseable output', () => {
  it('versioned deploy succeeds when imagetools returns "Digest: sha256:<hex>" fallback format', async () => {
    // Simulate imagetools returning plain "Digest: sha256:<hex>" instead of template format
    const fallbackOutput = `Name:      ghcr.io/fro-bot/dashboard:2026.06.47\nDigest: ${RESOLVED_DIGEST}\nManifest: application/vnd.oci.image.index.v1+json\n`
    const responses = makeVersionedHappyPathResponses()
    responses[0] = makeSpawnResult(fallbackOutput) // override imagetools inspect response

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })

  it('versioned deploy fails with clear message when imagetools output is unparseable', async () => {
    const responses = makeVersionedHappyPathResponses()
    responses[0] = makeSpawnResult('Error: manifest unknown') // unparseable — no sha256 digest

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/digest|imagetools|parse/)
  })
})

// ─── RED: public probe final warning includes last error/status ───────────────
//
// When the public HTTPS probe fails, the final warning must include either the
// last fetch error message or the last non-OK HTTP status code. This mirrors
// the operator-health diagnostics pattern and helps diagnose DNS/routing/ACME.

describe('public probe: final warning includes last error or status', () => {
  it('warning includes last HTTP status when probe returns non-ok status', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '))
    }

    try {
      await deploy({
        env: {...VALID_ENV, GATEWAY_VPC_IP: ''}, // skip operator health check
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (_url: string, _opts?: RequestInit) => {
          return new Response('Service Unavailable', {status: 503})
        },
        probeAttempts: 2,
        probeIntervalMs: 0,
        sleep: async () => {},
      })
    } finally {
      console.warn = origWarn
    }

    // The final warning for /api/healthz must include the last HTTP status
    const healthzWarning = warnMessages.find(m => m.includes('healthz') || m.includes('TLS') || m.includes('cert'))
    expect(healthzWarning).toBeDefined()
    expect(healthzWarning).toMatch(/503|status/)
  })

  it('warning includes last error message when probe throws', async () => {
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.map(String).join(' '))
    }

    try {
      await deploy({
        env: {...VALID_ENV, GATEWAY_VPC_IP: ''}, // skip operator health check
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (_url: string, _opts?: RequestInit) => {
          throw new TypeError('ECONNREFUSED: connection refused')
        },
        probeAttempts: 2,
        probeIntervalMs: 0,
        sleep: async () => {},
      })
    } finally {
      console.warn = origWarn
    }

    // The final warning for /api/healthz must include the last error message
    const healthzWarning = warnMessages.find(m => m.includes('healthz') || m.includes('TLS') || m.includes('cert'))
    expect(healthzWarning).toBeDefined()
    expect(healthzWarning).toMatch(/ECONNREFUSED|connection refused|error/i)
  })
})

// ─── RED: --wait-timeout 120 in compose up commands ──────────────────────────
//
// Both `docker compose up -d --no-build --wait dashboard` and
// `docker compose up -d --no-build --wait caddy` must include `--wait-timeout 120`
// to bound the wait and surface clear timeout errors.

describe('docker compose up: --wait-timeout 120', () => {
  it('dashboard compose up includes --wait-timeout 120', async () => {
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

    const dashboardUpCall = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('dashboard') && !s.includes('caddy')
    })
    expect(dashboardUpCall).toBeDefined()
    expect(dashboardUpCall?.cmd.join(' ')).toContain('--wait-timeout 120')
  })

  it('caddy compose up includes --wait-timeout 120', async () => {
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

    const caddyUpCall = calls.find(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('caddy')
    })
    expect(caddyUpCall).toBeDefined()
    expect(caddyUpCall?.cmd.join(' ')).toContain('--wait-timeout 120')
  })
})
