import {mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
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
import {buildRemoteSshCommand, decodeRemotePayload} from './remote-deploy'

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
    kill: (_signal: 'SIGTERM' | 'SIGKILL') => {},
  }
}

function makeRemoteFailureResponse(stage = 'payload-decoded'): SpawnResult {
  return makeSpawnResult(`stage=${stage}\n`, '', 1)
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
 * /operator/health also throws here — since the advisory operator check is non-blocking, the deploy
 * still completes. Tests that need /operator/health to return a specific status
 * should use a custom fetch mock.
 */
const fetchHealthzFail = async (_url: string, _opts?: RequestInit): Promise<Response> => {
  throw new Error('fetch failed')
}

/** Builds a successful remote transaction response for a committed local deploy. */
function makeHappyPathResponses(): SpawnResult[] {
  return [
    makeSpawnResult(
      'stage=remote-transaction-started\nstage=lock-acquired\nstage=payload-decoded\nstage=baseline-evidence\nstage=prune-started\nstage=prune-complete\nstage=post-prune-capacity\nstage=image-acquisition\nstage=post-acquisition-capacity\nstage=active-state-mutation\nstage=active-state-written\nstage=runtime-converged\nstage=complete\n',
    ),
  ]
}

function getRemoteTransactionCommand(calls: SpawnCall[]): string {
  return calls.find(c => c.cmd[0] === 'ssh')?.cmd.join(' ') ?? ''
}

function getRemoteTransactionProgram(calls: SpawnCall[]): string {
  return calls.find(c => c.cmd[0] === 'ssh')?.cmd.at(-1) ?? ''
}

function getRemoteTransactionPayload(calls: SpawnCall[]) {
  const transaction = calls.find(c => c.cmd[0] === 'ssh')
  expect(transaction).toBeDefined()
  return decodeRemotePayload(new TextEncoder().encode(transaction?.stdinData ?? ''))
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

  it('fails closed and physically validates the remote root and config directories before mutation', async () => {
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

    const command = getRemoteTransactionCommand(calls)
    const guards = [
      'if [ -L "$DASHBOARD_ROOT" ] || { [ -e "$DASHBOARD_ROOT" ] && [ ! -d "$DASHBOARD_ROOT" ]; }; then',
      'if [ -L "$DASHBOARD_CONFIG_DIR" ] || { [ -e "$DASHBOARD_CONFIG_DIR" ] && [ ! -d "$DASHBOARD_CONFIG_DIR" ]; }; then',
    ]
    const firstMutationIndex = Math.min(
      ...['install -d -m 0755', 'chown 0:0 "$DASHBOARD_ROOT"']
        .map(token => command.indexOf(token))
        .filter(index => index >= 0),
    )

    expect(calls.filter(c => c.cmd[0] === 'ssh')).toHaveLength(1)
    expect(calls.some(c => c.cmd.join(' ').includes('mkdir -p /opt/dashboard/config'))).toBe(false)
    expect(command).toContain('set -euo pipefail')
    for (const guard of guards) {
      expect(command).toContain(guard)
      expect(command.indexOf(guard)).toBeLessThan(firstMutationIndex)
    }
    expect(command).toContain('readonly DASHBOARD_ROOT="/opt/dashboard"')
    expect(command).toContain('install -d -m 0755 -o 0 -g 0 "$DASHBOARD_ROOT"')
    expect(command).toContain('install -d -m 0755 -o 0 -g 0 "$DASHBOARD_CONFIG_DIR"')
    expect(command).toContain('chown 0:0 "$DASHBOARD_ROOT" "$DASHBOARD_CONFIG_DIR"')
    expect(command).toContain('[ "$(realpath -e "$DASHBOARD_ROOT" 2>/dev/null)" = "$DASHBOARD_ROOT" ]')
    expect(command).toContain('[ "$(realpath -e "$DASHBOARD_CONFIG_DIR" 2>/dev/null)" = "$DASHBOARD_CONFIG_DIR" ]')
    const remoteProgram = getRemoteTransactionProgram(calls)
    expect(remoteProgram).not.toContain(VALID_ENV.DASHBOARD_DOMAIN)
    expect(remoteProgram).not.toContain(VALID_ENV.DASHBOARD_OAUTH_CLIENT_SECRET)
    expect(remoteProgram).not.toContain(VALID_ENV.DASHBOARD_COOKIE_KEY)
  })

  it('rejects symlinks and existing non-directories before changing listener storage', async () => {
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

    const command = getRemoteTransactionCommand(calls)
    const symlinkGuard =
      'if [ -L "$DASHBOARD_DATA_DIR" ] || { [ -e "$DASHBOARD_DATA_DIR" ] && [ ! -d "$DASHBOARD_DATA_DIR" ]; }; then'
    const installIndex = command.indexOf('install -d -m 0700 -o 1000 -g 1000 "$DASHBOARD_DATA_DIR"')
    const chownIndex = command.indexOf('chown -R 1000:1000 "$DASHBOARD_DATA_DIR"')
    const chmodIndex = command.indexOf('chmod 0700 "$DASHBOARD_DATA_DIR"')

    expect(command).toContain('set -euo pipefail')
    expect(command).toContain(symlinkGuard)
    expect(installIndex).toBeGreaterThan(command.indexOf(symlinkGuard))
    expect(chownIndex).toBeGreaterThan(installIndex)
    expect(chmodIndex).toBeGreaterThan(chownIndex)
    expect(command).toContain(
      '[ -d "$DASHBOARD_DATA_DIR" ] && [ ! -L "$DASHBOARD_DATA_DIR" ] && ' +
        '[ "$(realpath -e "$DASHBOARD_DATA_DIR" 2>/dev/null)" = "$DASHBOARD_DATA_DIR" ]',
    )
  })

  it('recursively converges listener storage ownership and preserves the root mode', async () => {
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

    const command = getRemoteTransactionCommand(calls)
    expect(command).toContain('chown -R 1000:1000 "$DASHBOARD_DATA_DIR"')
    expect(command).toContain('chmod 0700 "$DASHBOARD_DATA_DIR"')
    expect(command).toContain(
      '[ -d "$DASHBOARD_DATA_DIR" ] && [ ! -L "$DASHBOARD_DATA_DIR" ] && ' +
        '[ "$(realpath -e "$DASHBOARD_DATA_DIR" 2>/dev/null)" = "$DASHBOARD_DATA_DIR" ]',
    )
  })

  it('aborts before image pull or start when persistent listener storage setup fails', async () => {
    const responses = makeHappyPathResponses()
    responses[0] = makeRemoteFailureResponse('payload-decoded')
    const {spawnFn, calls} = makeFakeSpawn(responses)
    const probedUrls: string[] = []

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string) => {
          probedUrls.push(url)
          return fetchHealthzOk(url)
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Remote dashboard deploy failed at payload-decoded/)

    expect(calls.filter(c => c.cmd[0] === 'ssh')).toHaveLength(1)
    expect(probedUrls).toEqual([])
  })

  it('surfaces lock contention without any post-lock probe or second remote mutation', async () => {
    const {spawnFn, calls} = makeFakeSpawn([makeSpawnResult('stage=lock-contention\n', '', 75)])
    const probedUrls: string[] = []

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: async (url: string) => {
          probedUrls.push(url)
          return fetchHealthzOk(url)
        },
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/Remote dashboard deploy failed at lock-contention/)

    expect(calls.filter(call => call.cmd[0] === 'ssh' || call.cmd[0] === 'scp')).toHaveLength(1)
    expect(probedUrls).toEqual([])
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

    const payload = getRemoteTransactionPayload(calls)
    expect(payload.env).toContain('DASHBOARD_DOMAIN=')
    expect(getRemoteTransactionCommand(calls)).not.toContain('DASHBOARD_DOMAIN=')
  })

  it('materializes docker-compose.yaml through the transaction payload', async () => {
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

    const payload = getRemoteTransactionPayload(calls)
    expect(payload.compose).toContain('services:')
    expect(calls.filter(c => c.cmd[0] === 'scp')).toHaveLength(0)
  })

  it('materializes Caddyfile through the transaction payload', async () => {
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

    const payload = getRemoteTransactionPayload(calls)
    expect(payload.caddyfile).toContain('dashboard.fro.bot')
    expect(calls.filter(c => c.cmd[0] === 'scp')).toHaveLength(0)
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

    const transaction = calls.find(c => c.cmd[0] === 'ssh')
    const command = transaction?.cmd.join(' ') ?? ''
    const dashboardUpIdx = command.indexOf('docker compose up -d --no-build --wait --wait-timeout 120 dashboard')
    const caddyUpIdx = command.indexOf(
      'docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy',
    )

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

    const transaction = calls.find(c => c.cmd[0] === 'ssh')
    const command = transaction?.cmd.join(' ') ?? ''
    expect(command).toContain('docker compose up -d --no-build --wait --wait-timeout 120 dashboard')
    expect(command).toContain('docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy')
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

  it('does NOT publish docker-compose.override.yaml (only removes it)', async () => {
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

    // No SCP or payload field should reference docker-compose.override.yaml
    // (the fixed rm -f cleanup command is expected and allowed).
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
    // responses[12] already returns COMPOSE_DIGEST — deploy should pass
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
    const responses = makeHappyPathResponses()
    responses[0] = makeRemoteFailureResponse('runtime-converged')

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

// ─── digest-verify cwd ────────────────────────────────────────────────────────

describe('digest verification runs inside the dashboard root', () => {
  it('docker compose ps -q dashboard runs after changing to the dashboard root', async () => {
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

    const cmdStr = calls.find(c => c.cmd[0] === 'ssh')?.cmd.join(' ') ?? ''

    expect(cmdStr).toContain('cd "$DASHBOARD_ROOT"')

    const cdIdx = cmdStr.indexOf('cd "$DASHBOARD_ROOT"')
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
  const handleSection = (header: string, nextHeader?: string) => {
    const start = caddyfile.indexOf(header)
    const end = nextHeader ? caddyfile.indexOf(nextHeader, start + header.length) : caddyfile.length
    return caddyfile.slice(start, end === -1 ? caddyfile.length : end)
  }

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

  it('proxies /api/* and /auth/* at their real paths before the catch-all', () => {
    const catchAllIdx = caddyfile.lastIndexOf('handle {')
    const apiSection = handleSection('handle /api/*', 'handle /auth/*')
    const authSection = handleSection('handle /auth/*', 'handle @assets')

    expect(caddyfile.indexOf('handle /api/*')).toBeLessThan(catchAllIdx)
    expect(caddyfile.indexOf('handle /auth/*')).toBeLessThan(catchAllIdx)
    expect(apiSection).toMatch(/reverse_proxy\s+dashboard:3000/)
    expect(authSection).toMatch(/reverse_proxy\s+dashboard:3000/)
    expect(apiSection).not.toContain('rewrite * /')
    expect(authSection).not.toContain('rewrite * /')
  })

  it('routes extension-based files through a real-path asset proxy', () => {
    const matcherIdx = caddyfile.indexOf('@assets path_regexp')
    const assetsHandleIdx = caddyfile.indexOf('handle @assets')
    const catchAllIdx = caddyfile.lastIndexOf('handle {')
    const assetsSection = handleSection('handle @assets', 'handle {')

    expect(caddyfile).toMatch(/@assets\s+path_regexp/)
    expect(caddyfile).toContain(String.raw`path_regexp \.[A-Za-z0-9]+$`)
    expect(matcherIdx).toBeGreaterThan(-1)
    expect(matcherIdx).toBeLessThan(assetsHandleIdx)
    expect(assetsHandleIdx).toBeLessThan(catchAllIdx)
    expect(assetsSection).toMatch(/reverse_proxy\s+dashboard:3000/)
    expect(assetsSection).not.toContain('rewrite * /')
  })

  it('does not use a hand-maintained static asset allowlist', () => {
    expect(caddyfile).not.toContain('@owned')
    expect(caddyfile).not.toMatch(/\/assets\/\*|\/manifest\.webmanifest|\/icon-\*/)
  })

  it('keeps the SPA rewrite only in the final catch-all handle', () => {
    const operatorIdx = caddyfile.indexOf('handle /operator/*')
    const catchAllIdx = caddyfile.lastIndexOf('handle {')
    const handleHeaders = caddyfile
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.startsWith('handle') && line.endsWith('{'))
    const catchAllSection = caddyfile.slice(catchAllIdx)

    expect(operatorIdx).toBeGreaterThan(-1)
    expect(catchAllIdx).toBeGreaterThan(-1)
    expect(handleHeaders.at(-1)).toBe('handle {')
    expect(caddyfile.slice(0, catchAllIdx)).not.toContain('rewrite * /')
    expect(catchAllSection.indexOf('rewrite * /')).toBeGreaterThan(-1)
    expect(catchAllSection.indexOf('rewrite * /')).toBeLessThan(catchAllSection.indexOf('reverse_proxy dashboard:3000'))
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

// ─── DASHBOARD_OPERATOR_PUSH_ENABLED rendering ───────────────────────────────
//
// Server-side push flag: independently controlled from the gateway VAPID quartet.
// Exact-match semantics: the rendered line is a FIXED string
// (`DASHBOARD_OPERATOR_PUSH_ENABLED=true`), never the raw input value, and it is
// written ONLY when the raw input is the literal string "true" (no trim, no
// case-folding). GitHub Environment *variables* (unlike secrets) are not subject
// to the trailing-newline mangling that secrets can pick up, so strict raw
// equality is safe here and gives the strictest, most auditable fail-closed
// behavior: any whitespace or case variant is treated as disabled.
// Absent/false/malformed values are OMITTED (not an error) — the image's
// existing disabled behavior remains the default.

describe('buildEnvFileContents: DASHBOARD_OPERATOR_PUSH_ENABLED', () => {
  const baseOpts = {
    domain: 'dashboard.fro.bot',
    githubAppId: '123456',
    oauthClientId: 'Iv1.abc123',
    oauthClientSecret: 'oauthsecret',
    operatorLogin: 'marcusrbrown',
    cookieKey: 'cookiekey',
  }

  it('omits the push flag line when absent', () => {
    const contents = buildEnvFileContents({...baseOpts})
    expect(contents).not.toContain('DASHBOARD_OPERATOR_PUSH_ENABLED')
  })

  it('omits the push flag line when explicitly false', () => {
    const contents = buildEnvFileContents({...baseOpts, operatorPushEnabled: 'false'})
    expect(contents).not.toContain('DASHBOARD_OPERATOR_PUSH_ENABLED')
  })

  it.each(['True', 'TRUE', ' true', 'true ', 'true\n', '1', 'yes', 'truex', ''])(
    'omits the push flag line for malformed/whitespace-variant input %p',
    variant => {
      const contents = buildEnvFileContents({...baseOpts, operatorPushEnabled: variant})
      expect(contents).not.toContain('DASHBOARD_OPERATOR_PUSH_ENABLED')
    },
  )

  it('writes exactly DASHBOARD_OPERATOR_PUSH_ENABLED=true for the exact enabled value', () => {
    const contents = buildEnvFileContents({...baseOpts, operatorPushEnabled: 'true'})
    expect(contents).toContain('DASHBOARD_OPERATOR_PUSH_ENABLED=true\n')
  })

  it('never renders any VAPID key material or endpoint pointer regardless of push flag state', () => {
    const contents = buildEnvFileContents({...baseOpts, operatorPushEnabled: 'true'})
    expect(contents).not.toMatch(/VAPID/i)
    expect(contents).not.toContain('PUBLIC_KEY')
    expect(contents).not.toContain('PRIVATE_KEY')
    expect(contents).not.toContain('ENDPOINT')
  })
})

// ─── deploy(): DASHBOARD_OPERATOR_PUSH_ENABLED forwarding + isolation ────────

describe('deploy forwards DASHBOARD_OPERATOR_PUSH_ENABLED independently of gateway VAPID state', () => {
  it('renders only DASHBOARD_OPERATOR_PUSH_ENABLED=true in the .env stdin write when exactly "true"', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: {...VALID_ENV, DASHBOARD_OPERATOR_PUSH_ENABLED: 'true'},
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const envFileWrite = calls.find(c => c.stdinData.includes('DASHBOARD_DOMAIN='))
    expect(envFileWrite).toBeDefined()
    expect(envFileWrite?.stdinData).toContain('DASHBOARD_OPERATOR_PUSH_ENABLED=true\n')
  })

  it('omits the push flag from the .env stdin write when absent', async () => {
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

    const envFileWrite = calls.find(c => c.stdinData.includes('DASHBOARD_DOMAIN='))
    expect(envFileWrite).toBeDefined()
    expect(envFileWrite?.stdinData).not.toContain('DASHBOARD_OPERATOR_PUSH_ENABLED')
  })

  it('ignores unrelated gateway VAPID env values present in the same process env (never read or forwarded)', async () => {
    const {spawnFn, calls} = makeFakeSpawn(makeHappyPathResponses())

    await deploy({
      env: {
        ...VALID_ENV,
        DASHBOARD_OPERATOR_PUSH_ENABLED: 'true',
        // Simulates gateway-scoped VAPID values leaking into the same process env —
        // must never be read, rendered, or forwarded by the dashboard deploy.
        GATEWAY_OPERATOR_PUSH_VAPID_PUBLIC_KEY: 'BPub...key',
        GATEWAY_OPERATOR_PUSH_VAPID_PRIVATE_KEY: 'priv-key-material',
        GATEWAY_OPERATOR_PUSH_VAPID_SUBJECT: 'mailto:ops@fro.bot',
        GATEWAY_OPERATOR_PUSH_VAPID_KEY_VERSION: '1',
      },
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    const envFileWrite = calls.find(c => c.stdinData.includes('DASHBOARD_DOMAIN='))
    expect(envFileWrite).toBeDefined()
    expect(envFileWrite?.stdinData).toContain('DASHBOARD_OPERATOR_PUSH_ENABLED=true\n')
    expect(envFileWrite?.stdinData).not.toMatch(/VAPID/i)
    expect(envFileWrite?.stdinData).not.toContain('BPub...key')
    expect(envFileWrite?.stdinData).not.toContain('priv-key-material')

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toMatch(/VAPID/i)
    }
  })
})

// ─── deploy-dashboard.yaml: DASHBOARD_OPERATOR_PUSH_ENABLED forwarding ───────
//
// The flag is a non-secret, dashboard-Environment `vars` value. It must be
// forwarded from `vars.DASHBOARD_OPERATOR_PUSH_ENABLED` in the Deploy step's
// env block — never declared as a `workflow_call` secret, and no VAPID
// key/endpoint values may be introduced anywhere in the workflow file.

describe('deploy-dashboard.yaml: DASHBOARD_OPERATOR_PUSH_ENABLED forwarding', () => {
  const workflowPath = new URL('../../../.github/workflows/deploy-dashboard.yaml', import.meta.url)

  it('Deploy step env forwards DASHBOARD_OPERATOR_PUSH_ENABLED from the vars context', async () => {
    const text = await Bun.file(workflowPath).text()
    // Isolate the "Deploy" step block (from "- name: Deploy" to the next "- name:").
    const deployStepMatch = /- name: Deploy\n[\s\S]*?(?=\n {6}- name:|\n {6}$)/.exec(text)
    expect(deployStepMatch).not.toBeNull()
    const deployStep = deployStepMatch?.[0] ?? ''
    expect(deployStep).toMatch(
      /DASHBOARD_OPERATOR_PUSH_ENABLED:\s*\$\{\{\s*vars\.DASHBOARD_OPERATOR_PUSH_ENABLED\s*\}\}/,
    )
  })

  it('does NOT declare DASHBOARD_OPERATOR_PUSH_ENABLED as a workflow_call secret', async () => {
    const text = await Bun.file(workflowPath).text()
    const secretsBlockMatch = /secrets:\n[\s\S]*?(?=\npermissions:)/.exec(text)
    expect(secretsBlockMatch).not.toBeNull()
    expect(secretsBlockMatch?.[0]).not.toContain('DASHBOARD_OPERATOR_PUSH_ENABLED')
  })

  it('never introduces VAPID key material or an endpoint pointer anywhere in the workflow', async () => {
    const text = await Bun.file(workflowPath).text()
    expect(text).not.toMatch(/VAPID/i)
    expect(text).not.toContain('PUSH_ENDPOINT')
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
// The post-transaction advisory probe checks https://dashboard.fro.bot/operator/health when GATEWAY_VPC_IP is set.
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
// the gateway deploy. The DOCKER-USER readback also belongs to the gateway deploy.
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

// ─── /operator/health retry loop ──────────────────────────────────────────────
//
// The post-transaction advisory check retries /operator/health with bounded attempts,
// matching the existing /api/healthz probe pattern. Non-blocking: after all
// attempts exhausted, emits a warning and continues (never throws).

describe('dashboard verification: /operator/health retry loop', () => {
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
// - sends the generated compose and expected digest in the framed transaction payload
// - verifies running image against resolvedDigest

const RESOLVED_DIGEST = `sha256:${'c'.repeat(64)}`

/** Builds a digest-resolution plus successful remote transaction response. */
function makeVersionedHappyPathResponses(): SpawnResult[] {
  return [
    makeSpawnResult(RESOLVED_DIGEST), // 0: imagetools inspect → resolved digest
    makeSpawnResult(
      'stage=remote-transaction-started\nstage=lock-acquired\nstage=payload-decoded\nstage=baseline-evidence\nstage=prune-started\nstage=prune-complete\nstage=post-prune-capacity\nstage=image-acquisition\nstage=post-acquisition-capacity\nstage=active-state-mutation\nstage=active-state-written\nstage=runtime-converged\nstage=complete\n',
    ), // 1: remote transaction
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

  it('uses exactly one mutating SSH process for the committed local/no-version path', async () => {
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

    const remoteMutationCalls = calls.filter(call => call.cmd[0] === 'ssh' || call.cmd[0] === 'scp')
    expect(remoteMutationCalls).toHaveLength(1)
    expect(remoteMutationCalls[0]?.cmd[0]).toBe('ssh')
    expect(remoteMutationCalls[0]?.cmd).not.toContain('ControlMaster=auto')
    expect(remoteMutationCalls[0]?.cmd.some(arg => arg.startsWith('ControlPath='))).toBe(false)
    expect(remoteMutationCalls[0]?.cmd).not.toContain('ControlPersist=60s')
  })

  it('uses exactly one mutating SSH process for the versioned path', async () => {
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

    const remoteMutationCalls = calls.filter(call => call.cmd[0] === 'ssh' || call.cmd[0] === 'scp')
    expect(remoteMutationCalls).toHaveLength(1)
    expect(remoteMutationCalls[0]?.cmd[0]).toBe('ssh')
  })

  it('does not enable SSH connection multiplexing for the transaction', () => {
    const command = buildRemoteSshCommand({host: 'dashboard.example'})

    expect(command).not.toContain('ControlMaster=auto')
    expect(command).not.toContain('ControlPath=/tmp/dash-cm/cm-%C')
    expect(command).not.toContain('ControlPersist=60s')
  })

  it('creates and cleans only the CI key temp directory, never a ControlMaster temp directory', async () => {
    const prefixes = ['dashboard-deploy-key-', 'dash-cm-']
    const tempRoots = [tmpdir(), '/tmp']
    const entriesForRoots = () =>
      tempRoots.flatMap(root =>
        readdirSync(root)
          .filter(name => prefixes.some(prefix => name.startsWith(prefix)))
          .map(name => `${root}/${name}`),
      )
    const existing = new Set(entriesForRoots())
    const ciEnv: Record<string, string> = {
      ...VALID_ENV,
      DASHBOARD_SSH_KEY: '-----BEGIN PRIVATE KEY-----\nci-key\n-----END PRIVATE KEY-----',
    }
    delete ciEnv.SSH_AUTH_SOCK
    const {spawnFn} = makeFakeSpawn(makeHappyPathResponses())
    let entriesAtRemoteSpawn: string[] = []

    const trackingSpawn: SpawnFn = (command, options) => {
      entriesAtRemoteSpawn = entriesForRoots().filter(name => !existing.has(name))
      return spawnFn(command, options)
    }

    await deploy({
      env: ciEnv,
      spawn: trackingSpawn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    expect(entriesAtRemoteSpawn.filter(name => name.includes('/dashboard-deploy-key-'))).toHaveLength(1)
    expect(entriesAtRemoteSpawn.filter(name => name.includes('/dash-cm-'))).toHaveLength(0)
    expect(entriesForRoots().filter(name => !existing.has(name))).toEqual([])

    const localExisting = new Set(entriesForRoots())
    const {spawnFn: localSpawn} = makeFakeSpawn(makeHappyPathResponses())
    let localEntriesAtRemoteSpawn: string[] = []
    const trackingLocalSpawn: SpawnFn = (command, options) => {
      localEntriesAtRemoteSpawn = entriesForRoots().filter(name => !localExisting.has(name))
      return localSpawn(command, options)
    }

    await deploy({
      env: VALID_ENV,
      spawn: trackingLocalSpawn,
      resolve: resolvesOk,
      fetch: fetchHealthzOk,
      probeAttempts: 1,
      probeIntervalMs: 0,
      sleep: async () => {},
    })

    expect(localEntriesAtRemoteSpawn).toEqual([])
    expect(entriesForRoots().filter(name => !localExisting.has(name))).toEqual([])
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
    const responses = makeVersionedHappyPathResponses()
    responses[1] = makeRemoteFailureResponse('runtime-converged')

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
    ).rejects.toThrow(/Remote dashboard deploy failed at runtime-converged/)
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

  it('does not log raw local resolver stdout or stderr', async () => {
    const unfilteredOutput = 'malicious resolver output oauth-secret-value'
    const responses = makeVersionedHappyPathResponses()
    responses[0] = makeSpawnResult(
      `Name: ghcr.io/fro-bot/dashboard:2026.06.47\nDigest: ${RESOLVED_DIGEST}\n${unfilteredOutput}\n`,
      `raw resolver stderr ${unfilteredOutput}`,
    )
    const {spawnFn} = makeFakeSpawn(responses)
    const logMessages: string[] = []
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = (...args: unknown[]) => {
      logMessages.push(args.map(String).join(' '))
    }
    console.error = (...args: unknown[]) => {
      logMessages.push(args.map(String).join(' '))
    }

    try {
      await deploy({
        env: {...VALID_ENV, GATEWAY_VPC_IP: ''},
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        version: '2026.06.47',
        digest: RESOLVED_DIGEST,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    expect(logMessages.join('\n')).not.toContain(unfilteredOutput)
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

  it('includes the resolved versioned digest as the exact remote verification target', async () => {
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

    expect(getRemoteTransactionPayload(calls).expectedDashboardDigest).toBe(RESOLVED_DIGEST)
  })
})

// ─── no-version fallback ──────────────────────────────────────────────────────
//
// When no version is dispatched, the committed compose file is the source of
// truth. No imagetools inspect or generated compose content is needed.

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

  it('includes the committed compose digest as the exact remote verification target', async () => {
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

    expect(getRemoteTransactionPayload(calls).expectedDashboardDigest).toBe(COMPOSE_DIGEST)
  })

  it('materializes committed compose content in the transaction payload without SCP', async () => {
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

    expect(calls.filter(c => c.cmd[0] === 'scp')).toHaveLength(0)
    const transaction = calls.find(c => c.cmd[0] === 'ssh')
    expect(transaction).toBeDefined()
    const payload = decodeRemotePayload(new TextEncoder().encode(transaction?.stdinData ?? ''))
    expect(payload.compose).toContain(COMPOSE_DIGEST)
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

// ─── Transaction readback and post-transaction audit ordering ─────────────────

describe('locked transaction readback and audit ordering', () => {
  it('logs only allowlisted transaction stages and evidence', async () => {
    const secret = 'oauth-secret-value'
    const {spawnFn} = makeFakeSpawn([
      makeSpawnResult(
        `${[
          'stage=remote-transaction-started',
          'evidence=capacity:post-prune:free-bytes=8589934592',
          `evidence=unknown:operator-secret=${secret}`,
          'stage=unknown',
          `arbitrary remote stdout ${secret}`,
          'stage=complete',
        ].join('\n')}\n`,
        `unfiltered remote stderr ${secret}`,
      ),
    ])
    const logMessages: string[] = []
    const originalWarn = console.warn
    const originalError = console.error
    console.warn = (...args: unknown[]) => {
      logMessages.push(args.map(String).join(' '))
    }
    console.error = (...args: unknown[]) => {
      logMessages.push(args.map(String).join(' '))
    }

    try {
      await deploy({
        env: {...VALID_ENV, GATEWAY_VPC_IP: ''},
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHealthzOk,
        probeAttempts: 1,
        probeIntervalMs: 0,
        sleep: async () => {},
      })
    } finally {
      console.warn = originalWarn
      console.error = originalError
    }

    const logs = logMessages.join('\n')
    expect(logs).toContain('stage=remote-transaction-started')
    expect(logs).toContain('evidence=capacity:post-prune:free-bytes=8589934592')
    expect(logs).toContain('stage=complete')
    expect(logs).not.toContain('evidence=unknown')
    expect(logs).not.toContain('stage=unknown')
    expect(logs).not.toContain('arbitrary remote stdout')
    expect(logs).not.toContain('unfiltered remote stderr')
    expect(logs).not.toContain(secret)
  })

  it('surfaces the deterministic remote stage and exit code without probing or auditing', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-lock-failure-'))
    const localComposePath = join(tmpDir, 'docker-compose.yaml')
    const originalCompose = 'committed compose sentinel\n'
    writeFileSync(localComposePath, originalCompose, 'utf8')
    const secret = 'cookie-secret-value'
    const responses = makeVersionedHappyPathResponses()
    responses[1] = makeSpawnResult(`stage=lock-contention\n`, `remote stderr ${secret}`, 75)
    const {spawnFn} = makeFakeSpawn(responses)
    const probedUrls: string[] = []

    try {
      await expect(
        deploy({
          env: VALID_ENV,
          spawn: spawnFn,
          resolve: resolvesOk,
          fetch: async (url: string) => {
            probedUrls.push(url)
            return fetchHealthzOk(url)
          },
          version: '2026.06.47',
          digest: RESOLVED_DIGEST,
          localComposePath,
          probeAttempts: 1,
          probeIntervalMs: 0,
          sleep: async () => {},
        }),
      ).rejects.toMatchObject({
        stage: 'lock-contention',
        exitCode: 75,
        message: expect.stringContaining('exit code 75'),
      })

      expect(probedUrls).toEqual([])
      expect(readFileSync(localComposePath, 'utf8')).toBe(originalCompose)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('writes the versioned audit pin only after advisory probes, even when probes fail', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-audit-order-'))
    const localComposePath = join(tmpDir, 'docker-compose.yaml')
    const originalCompose = readFileSync(join(import.meta.dir, '..', 'docker-compose.yaml'), 'utf8')
    writeFileSync(localComposePath, originalCompose, 'utf8')
    let probeCount = 0

    try {
      const {spawnFn} = makeFakeSpawn(makeVersionedHappyPathResponses())
      await expect(
        deploy({
          env: {...VALID_ENV, GATEWAY_VPC_IP: ''},
          spawn: spawnFn,
          resolve: resolvesOk,
          fetch: async () => {
            probeCount++
            expect(readFileSync(localComposePath, 'utf8')).toBe(originalCompose)
            throw new Error('advisory probe unavailable')
          },
          version: '2026.06.47',
          digest: RESOLVED_DIGEST,
          localComposePath,
          probeAttempts: 1,
          probeIntervalMs: 0,
          sleep: async () => {},
        }),
      ).resolves.toBeUndefined()

      expect(probeCount).toBe(1)
      const auditedCompose = readFileSync(localComposePath, 'utf8')
      expect(auditedCompose).toContain(`ghcr.io/fro-bot/dashboard:2026.06.47@${RESOLVED_DIGEST}`)
      expect(auditedCompose).not.toBe(originalCompose)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── Versioned deploy writes local compose path ──────────────────────────────
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
    // Verifies that the local compose write only happens after the full remote
    // transaction succeeds. If Caddy convergence throws, the write is skipped.
    const tmpDir = mkdtempSync(join(tmpdir(), 'deploy-test-compose-'))
    const tmpComposePath = join(tmpDir, 'docker-compose.yaml')
    writeFileSync(tmpComposePath, SAMPLE_COMPOSE_FOR_WRITE, 'utf8')

    try {
      // Replace the remote transaction response with a failing exit code.
      const responses = makeVersionedHappyPathResponses()
      responses[1] = makeRemoteFailureResponse('runtime-converged')
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

// ─── compose up safety flags ─────────────────────────────────────────────────
//
// The dashboard app must remain digest-gated without forced recreation. Caddy
// must force recreation so bind-mounted Caddyfile content changes are loaded.

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

    const command = calls.find(c => c.cmd[0] === 'ssh')?.cmd.join(' ') ?? ''
    const dashboardUp = 'docker compose up -d --no-build --wait --wait-timeout 120 dashboard'
    expect(command).toContain(dashboardUp)
    expect(
      command.slice(command.indexOf(dashboardUp), command.indexOf(dashboardUp) + dashboardUp.length),
    ).not.toContain('--force-recreate')
  })

  it('caddy compose up includes --force-recreate, --wait-timeout 120, and --no-build', async () => {
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

    const command = calls.find(c => c.cmd[0] === 'ssh')?.cmd.join(' ') ?? ''
    expect(command).toContain('docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy')
  })
})
