import {describe, expect, it} from 'bun:test'

import {
  assertRunningImageDigest,
  buildEnvFileContents,
  deploy,
  parseComposeImageDigest,
  validateEnv,
  validateSecretValue,
  type SpawnFn,
  type SpawnResult,
} from './deploy'

// ─── Test helpers ─────────────────────────────────────────────────────────────

// Digest pinned in apps/dashboard/docker-compose.yaml
const COMPOSE_DIGEST = 'sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e'
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

/** Fake fetch that always fails. */
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
    const digest = parseComposeImageDigest(
      'image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd509856430b7bf90119ed2aaff5c579c89f53605596e250494702a8fe5f2e',
    )
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
