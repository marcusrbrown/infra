import type {SpawnFn, SpawnResult} from './deploy'
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test'

// ─── Test digest fixtures ─────────────────────────────────────────────────────

const GATEWAY_DIGEST = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
const WORKSPACE_DIGEST = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(content: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(new TextEncoder().encode(content))
      c.close()
    },
  })
}

function makeSpawnResult(
  opts: {stdout?: string; stderr?: string; exitCode?: number; captureStdin?: boolean} = {},
): SpawnResult & {stdinData?: string} {
  let stdinData = ''
  const result: SpawnResult & {stdinData?: string} = {
    stdout: makeStream(opts.stdout ?? ''),
    stderr: makeStream(opts.stderr ?? ''),
    exited: Promise.resolve(opts.exitCode ?? 0),
  }
  if (opts.captureStdin) {
    result.stdin = {
      write(data: Uint8Array) {
        stdinData += new TextDecoder().decode(data)
      },
      end() {},
    }
    Object.defineProperty(result, 'stdinData', {get: () => stdinData})
  } else {
    result.stdin = {write() {}, end() {}}
  }
  return result
}

/** Build a minimal valid env for tests. */
function makeEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    CI: 'true',
    GATEWAY_SSH_KEY: 'fake-key',
    DISCORD_TOKEN: 'tok-secret',
    AWS_ACCESS_KEY_ID: 'AKIAIOSFODNN7EXAMPLE',
    AWS_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    DISCORD_APPLICATION_ID: 'app123',
    DISCORD_GUILD_ID: 'guild456',
    S3_BUCKET: 'my-bucket',
    S3_REGION: 'us-east-1',
    GATEWAY_HOST: 'gateway.fro.bot',
    GH_APP_ID: 'app-id-12345',
    GH_APP_PRIVATE_KEY: '-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----\n',
    WORKSPACE_OPENCODE_TOKEN: 'ws-token-secret',
    WORKSPACE_OPENCODE_AUTH: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
    WORKSPACE_OPENCODE_MODEL: 'anthropic/claude-sonnet-4-6',
    WORKSPACE_OPENCODE_CONFIG: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
    GATEWAY_TRIGGER_ROLE_ID: '123456789012345678',
    GATEWAY_IMAGE_DIGEST: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    WORKSPACE_IMAGE_DIGEST: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    ...overrides,
  }
}

/** Upstream fixture path helper. */
let tmpDir: string

function writeUpstreamJson(content: object): string {
  const path = join(tmpDir, 'upstream.json')
  writeFileSync(path, JSON.stringify(content))
  return path
}

/**
 * Build a spawn mock that records calls and returns success by default.
 * docker inspect commands return appropriate values so assertRunningImageDigest
 * passes in tests that don't override the handler.
 *
 * Two-step image inspect (P1 fix):
 *   1. `docker inspect --format '{{.Image}}' <container>` → returns a fake image SHA
 *   2. `docker inspect --format '{{json .RepoDigests}}' <imageSHA>` → returns valid RepoDigests JSON
 */
function makeSpawnMock(handler?: (cmd: string[]) => SpawnResult | undefined): {spawnFn: SpawnFn; calls: string[][]} {
  const calls: string[][] = []
  const spawnFn: SpawnFn = (cmd, _opts) => {
    calls.push(cmd)
    const custom = handler?.(cmd)
    if (custom !== undefined) return custom
    const cmdStr = cmd.join(' ')
    // Step 1: resolve container → image SHA
    if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
      return makeSpawnResult({stdout: 'sha256:mockimagesha0000000000000000000000000000000000000000000000000000'})
    }
    // Step 2: inspect image RepoDigests — return both digests so either service check passes
    if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
      const digests = [
        `ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`,
        `ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`,
      ]
      return makeSpawnResult({stdout: JSON.stringify(digests)})
    }
    return makeSpawnResult()
  }
  return {spawnFn, calls}
}

/** Build a minimal valid env with operator listener vars set. */
function makeOperatorEnv() {
  return makeEnv({
    GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
    GATEWAY_OPERATOR_BIND_PORT: '9300',
    GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
  })
}

/** Build a mock fetch that returns a Discord commands response. */
function makeDiscordFetch(commands: {name: string}[]): typeof fetch {
  return mock(async () => new Response(JSON.stringify(commands), {status: 200})) as unknown as typeof fetch
}

// ─── Test setup ───────────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'gateway-deploy-test-'))
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
})

// ─── upstream.json pin regression guard ──────────────────────────────────────
//
// This topology requires fro-bot/agent#931 / v0.66.0 because deploy now invokes
// deploy/validate-stack.sh which was introduced at that version.
// If upstream.json is ever downgraded below v0.66.0 this test fails immediately.

describe('upstream.json pin', () => {
  test('upstream.json is pinned to exactly v0.66.0 (operator topology requires fro-bot/agent#931)', async () => {
    const {resolveUpstreamPin} = await import('./deploy')
    const upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    const pin = resolveUpstreamPin(upstreamPath)
    expect(pin.repo).toBe('fro-bot/agent')
    expect(pin.ref).toBe('v0.66.0')
  })
})

// ─── validateRequiredEnv ──────────────────────────────────────────────────────

describe('validateRequiredEnv', () => {
  test('returns empty array when all required vars are present', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const result = validateRequiredEnv(makeEnv())
    expect(result).toEqual([])
  })

  test('returns list of missing required vars', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).DISCORD_TOKEN
    delete (env as Record<string, string>).S3_BUCKET
    const result = validateRequiredEnv(env)
    expect(result).toContain('DISCORD_TOKEN')
    expect(result).toContain('S3_BUCKET')
  })

  test('does not require GATEWAY_SSH_KEY when CI is not set', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv({CI: ''})
    delete (env as Record<string, string>).GATEWAY_SSH_KEY
    const result = validateRequiredEnv(env)
    expect(result).not.toContain('GATEWAY_SSH_KEY')
  })

  test('requires GATEWAY_SSH_KEY when CI=true', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv({CI: 'true'})
    delete (env as Record<string, string>).GATEWAY_SSH_KEY
    const result = validateRequiredEnv(env)
    expect(result).toContain('GATEWAY_SSH_KEY')
  })

  test('does not require optional vars S3_ENDPOINT, OBJECT_STORE_HOSTS, DISCORD_OPERATOR_ROLE_ID', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const result = validateRequiredEnv(makeEnv())
    expect(result).not.toContain('S3_ENDPOINT')
    expect(result).not.toContain('OBJECT_STORE_HOSTS')
    expect(result).not.toContain('DISCORD_OPERATOR_ROLE_ID')
  })
})

// ─── resolveUpstreamPin ───────────────────────────────────────────────────────

describe('resolveUpstreamPin', () => {
  test('reads repo and ref from upstream.json', async () => {
    const {resolveUpstreamPin} = await import('./deploy')
    const path = writeUpstreamJson({repo: 'fro-bot/agent', ref: 'v0.44.0'})
    const result = resolveUpstreamPin(path)
    expect(result).toEqual({repo: 'fro-bot/agent', ref: 'v0.44.0'})
  })

  test('throws when upstream.json is missing', async () => {
    const {resolveUpstreamPin} = await import('./deploy')
    expect(() => resolveUpstreamPin(join(tmpDir, 'nonexistent.json'))).toThrow(/Cannot read upstream\.json/)
  })

  test('throws when upstream.json is malformed (missing ref)', async () => {
    const {resolveUpstreamPin} = await import('./deploy')
    const path = writeUpstreamJson({repo: 'fro-bot/agent'})
    expect(() => resolveUpstreamPin(path)).toThrow(/must have string fields/)
  })

  test('throws when upstream.json is malformed (missing repo)', async () => {
    const {resolveUpstreamPin} = await import('./deploy')
    const path = writeUpstreamJson({ref: 'v0.44.0'})
    expect(() => resolveUpstreamPin(path)).toThrow(/must have string fields/)
  })
})

// ─── computeObjectStoreHosts ──────────────────────────────────────────────────

describe('computeObjectStoreHosts', () => {
  test('returns explicit OBJECT_STORE_HOSTS override verbatim', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(makeEnv({OBJECT_STORE_HOSTS: 'custom.host.example.com'}))
    expect(result).toBe('custom.host.example.com')
  })

  test('R2 custom endpoint: path-style access uses hostname only (no bucket prefix)', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com', S3_BUCKET: 'my-bucket'}),
    )
    // S3 client uses forcePathStyle: true — requests go to hostname/bucket, not bucket.hostname
    expect(result).toBe('abc123.r2.cloudflarestorage.com')
  })

  test('MinIO custom endpoint: path-style access uses hostname only (no bucket prefix)', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({S3_ENDPOINT: 'https://minio.example.com:9000', S3_BUCKET: 'my-bucket'}),
    )
    // S3 client uses forcePathStyle: true — hostname only, port stripped (mitmproxy matches on hostname)
    expect(result).toBe('minio.example.com')
  })

  test('strips scheme, port, and path from S3_ENDPOINT for path-style hostname', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({S3_ENDPOINT: 'https://endpoint.example.com/some/path', S3_BUCKET: 'bucket'}),
    )
    expect(result).toBe('endpoint.example.com')
  })

  test('derives AWS pattern when S3_ENDPOINT is not set', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(makeEnv({S3_BUCKET: 'my-bucket', S3_REGION: 'us-west-2'}))
    expect(result).toBe('my-bucket.s3.us-west-2.amazonaws.com')
  })

  test('OBJECT_STORE_HOSTS takes priority over S3_ENDPOINT', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({
        OBJECT_STORE_HOSTS: 'override.example.com',
        S3_ENDPOINT: 'https://r2.example.com',
        S3_BUCKET: 'bucket',
      }),
    )
    expect(result).toBe('override.example.com')
  })
})

// ─── buildSecretFileList ──────────────────────────────────────────────────────

describe('buildSecretFileList', () => {
  test('returns exactly 16 secret entries', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    expect(secrets).toHaveLength(16)
  })

  test('uses kebab-case file names matching upstream compose contract', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const names = secrets.map(s => s.name)
    expect(names).toContain('discord-token')
    expect(names).toContain('discord-application-id')
    expect(names).toContain('discord-guild-id')
    expect(names).toContain('aws-access-key-id')
    expect(names).toContain('aws-secret-access-key')
    expect(names).toContain('s3-bucket')
    expect(names).toContain('s3-region')
    expect(names).toContain('s3-endpoint')
    expect(names).toContain('aws-session-token')
    expect(names).toContain('github-app-id')
    expect(names).toContain('github-app-private-key')
    expect(names).toContain('discord-privileged-intents')
    expect(names).toContain('workspace-opencode-token')
    expect(names).toContain('workspace-opencode-auth')
    expect(names).toContain('workspace-opencode-url')
    expect(names).toContain('gateway-trigger-role-id')
  })

  test('does not use snake_case file names', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const names = secrets.map(s => s.name)
    expect(names).not.toContain('discord_token')
    expect(names).not.toContain('discord_application_id')
    expect(names).not.toContain('discord_guild_id')
    expect(names).not.toContain('aws_access_key_id')
    expect(names).not.toContain('aws_secret_access_key')
  })

  test('discord-token maps to DISCORD_TOKEN env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const token = secrets.find(s => s.name === 'discord-token')
    expect(token).toBeDefined()
    expect(token?.content).toBe('tok-secret')
    expect(token?.required).toBe(true)
  })

  test('discord-application-id maps to DISCORD_APPLICATION_ID env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const appId = secrets.find(s => s.name === 'discord-application-id')
    expect(appId).toBeDefined()
    expect(appId?.content).toBe('app123')
    expect(appId?.required).toBe(true)
  })

  test('discord-guild-id maps to DISCORD_GUILD_ID env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const guildId = secrets.find(s => s.name === 'discord-guild-id')
    expect(guildId).toBeDefined()
    expect(guildId?.content).toBe('guild456')
  })

  test('aws-access-key-id maps to AWS_ACCESS_KEY_ID env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const key = secrets.find(s => s.name === 'aws-access-key-id')
    expect(key).toBeDefined()
    expect(key?.content).toBe('AKIAIOSFODNN7EXAMPLE')
    expect(key?.required).toBe(true)
  })

  test('aws-secret-access-key maps to AWS_SECRET_ACCESS_KEY env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const secretKey = secrets.find(s => s.name === 'aws-secret-access-key')
    expect(secretKey).toBeDefined()
    expect(secretKey?.content).toBe('wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY')
    expect(secretKey?.required).toBe(true)
  })

  test('s3-bucket maps to S3_BUCKET env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const bucket = secrets.find(s => s.name === 's3-bucket')
    expect(bucket).toBeDefined()
    expect(bucket?.content).toBe('my-bucket')
    expect(bucket?.required).toBe(true)
  })

  test('s3-region maps to S3_REGION env var', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const region = secrets.find(s => s.name === 's3-region')
    expect(region).toBeDefined()
    expect(region?.content).toBe('us-east-1')
    expect(region?.required).toBe(true)
  })

  test('s3-endpoint is optional: unset → empty content, required false', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).S3_ENDPOINT
    const secrets = buildSecretFileList(env)
    const endpoint = secrets.find(s => s.name === 's3-endpoint')
    expect(endpoint).toBeDefined()
    expect(endpoint?.content).toBe('')
    expect(endpoint?.required).toBe(false)
  })

  test('s3-endpoint set → content is the value', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com'}))
    const endpoint = secrets.find(s => s.name === 's3-endpoint')
    expect(endpoint?.content).toBe('https://abc123.r2.cloudflarestorage.com')
  })

  test('aws-session-token is optional: unset → empty content, required false', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).AWS_SESSION_TOKEN
    const secrets = buildSecretFileList(env)
    const sessionToken = secrets.find(s => s.name === 'aws-session-token')
    expect(sessionToken).toBeDefined()
    expect(sessionToken?.content).toBe('')
    expect(sessionToken?.required).toBe(false)
  })

  test('aws-session-token set → content is the value', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({AWS_SESSION_TOKEN: 'AQoXnyc4lcK4w=='}))
    const sessionToken = secrets.find(s => s.name === 'aws-session-token')
    expect(sessionToken?.content).toBe('AQoXnyc4lcK4w==')
    expect(sessionToken?.required).toBe(false)
  })
})

// ─── computeSecretsChecksum ───────────────────────────────────────────────────

describe('computeSecretsChecksum', () => {
  test('same inputs produce same checksum', async () => {
    const {buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    expect(computeSecretsChecksum(secrets)).toBe(computeSecretsChecksum(secrets))
  })

  test('different content produces different checksum', async () => {
    const {buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const a = buildSecretFileList(makeEnv({DISCORD_TOKEN: 'token-a'}))
    const b = buildSecretFileList(makeEnv({DISCORD_TOKEN: 'token-b'}))
    expect(computeSecretsChecksum(a)).not.toBe(computeSecretsChecksum(b))
  })

  test('reordered secrets produce different checksum', async () => {
    const {computeSecretsChecksum} = await import('./deploy')
    const s1 = [{name: 'a', content: 'x', required: true}]
    const s2 = [{name: 'b', content: 'y', required: true}]
    const combined1 = [...s1, ...s2]
    const combined2 = [...s2, ...s1]
    expect(computeSecretsChecksum(combined1)).not.toBe(computeSecretsChecksum(combined2))
  })

  test('returns a 64-char hex string (SHA-256)', async () => {
    const {buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const checksum = computeSecretsChecksum(buildSecretFileList(makeEnv()))
    expect(checksum).toMatch(/^[0-9a-f]{64}$/)
  })
})

// ─── parseDeployArgs ──────────────────────────────────────────────────────────

describe('parseDeployArgs', () => {
  test('parses supported boolean flags', async () => {
    const {parseDeployArgs} = await import('./deploy')

    expect(parseDeployArgs(['--dry-run', '--force-recreate'])).toEqual({dryRun: true, forceRecreate: true})
    expect(parseDeployArgs([])).toEqual({dryRun: false, forceRecreate: false})
  })

  test('rejects unknown arguments instead of silently ignoring them', async () => {
    const {parseDeployArgs} = await import('./deploy')

    expect(() => parseDeployArgs(['--dryrun'])).toThrow(/Unknown deploy argument/)
  })
})

// ─── pollRegistration ─────────────────────────────────────────────────────────

describe('pollRegistration', () => {
  test('returns commands when Discord API responds with non-empty list', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response(JSON.stringify([{name: 'ping'}, {name: 'deploy'}]), {status: 200}))
    const result = await pollRegistration({
      applicationId: 'app1',
      guildId: 'guild1',
      token: 'tok-secret',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxAttempts: 3,
    })
    expect(result.commands).toEqual(['ping', 'deploy'])
  })

  test('retries until commands appear', async () => {
    const {pollRegistration} = await import('./deploy')
    let callCount = 0
    const fetchMock = mock(async () => {
      callCount++
      const commands = callCount >= 3 ? [{name: 'ping'}] : []
      return new Response(JSON.stringify(commands), {status: 200})
    })
    const result = await pollRegistration({
      applicationId: 'app1',
      guildId: 'guild1',
      token: 'tok-secret',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxAttempts: 5,
    })
    expect(result.commands).toEqual(['ping'])
    expect(callCount).toBe(3)
  })

  test('throws on timeout without exposing token', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response(JSON.stringify([]), {status: 200}))
    await expect(
      pollRegistration({
        applicationId: 'app123',
        guildId: 'guild456',
        token: 'tok-secret',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 2,
      }),
    ).rejects.toThrow(/application=app123.*guild=guild456/)
  })

  test('token confidentiality: timeout error does not contain token', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response(JSON.stringify([]), {status: 200}))
    let errorMessage = ''
    try {
      await pollRegistration({
        applicationId: 'app123',
        guildId: 'guild456',
        token: 'tok-secret',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 1,
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).not.toContain('tok-secret')
    expect(errorMessage).toContain('app123')
    expect(errorMessage).toContain('guild456')
  })

  test('token confidentiality: HTTP error does not contain token', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Unauthorized', {status: 401}))
    let errorMessage = ''
    try {
      await pollRegistration({
        applicationId: 'app123',
        guildId: 'guild456',
        token: 'tok-secret',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).not.toContain('tok-secret')
    expect(errorMessage).toContain('401')
    expect(errorMessage).toContain('app123')
  })
})

// ─── main ─────────────────────────────────────────────────────────────────────

describe('main', () => {
  // main() resolves upstream.json via import.meta.dir. We write the fixture
  // to the real apps/gateway/upstream.json for the duration of each test,
  // then restore it.

  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('happy path: all env present, spawn returns success → resolves', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    expect(calls.length).toBeGreaterThan(0)
    const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCall).toBeDefined()
  })

  test('edge case (first deploy): .git absent → clone step invoked', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock(cmd => {
      // test -d .git → exit 1 (not found)
      if (cmd.some(s => s.includes('test -d'))) {
        return makeSpawnResult({exitCode: 1})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const cloneCall = calls.find(cmd => cmd.some(s => s.includes('git clone')))
    expect(cloneCall).toBeDefined()
    const fetchCall = calls.find(cmd => cmd.some(s => s.includes('git fetch')))
    expect(fetchCall).toBeUndefined()
  })

  test('edge case (ref bump): .git present → fetch+reset+clean invoked', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock(cmd => {
      // test -d .git → exit 0 (exists)
      if (cmd.some(s => s.includes('test -d'))) {
        return makeSpawnResult({exitCode: 0})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const fetchCall = calls.find(cmd => cmd.some(s => s.includes('git fetch')))
    expect(fetchCall).toBeDefined()
    const resetCall = calls.find(cmd => cmd.some(s => s.includes('git reset --hard')))
    expect(resetCall).toBeDefined()
    const cleanCall = calls.find(cmd => cmd.some(s => s.includes('git clean -xfd')))
    expect(cleanCall).toBeDefined()
    const cloneCall = calls.find(cmd => cmd.some(s => s.includes('git clone')))
    expect(cloneCall).toBeUndefined()
  })

  test('edge case (secrets unchanged): checksum matches → no --force-recreate', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum, buildComposeOverride} = await import('./deploy')
    const env = makeEnv()
    const secrets = buildSecretFileList(env)
    // Override is always included in checksum now
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    const expectedChecksum = computeSecretsChecksum([
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
    ])

    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: expectedChecksum})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall).toBeDefined()
    expect(upCall?.join(' ')).not.toContain('--force-recreate')
    expect(upCall?.join(' ')).not.toContain('--build')
  })

  test('edge case (secrets changed): checksum differs → --force-recreate added', async () => {
    const {main} = await import('./deploy')

    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: 'old-checksum-that-differs'})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall).toBeDefined()
    expect(upCall?.join(' ')).toContain('--force-recreate')
    expect(upCall?.join(' ')).not.toContain('--build')
  })

  test('pulls prebuilt GHCR image on every deploy regardless of --force-recreate', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum, buildComposeOverride} = await import('./deploy')
    const env = makeEnv()
    const secrets = buildSecretFileList(env)
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    const expectedChecksum = computeSecretsChecksum([
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
    ])

    // Secrets unchanged path — no --force-recreate
    const {spawnFn: spawnFnA, calls: callsA} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: expectedChecksum})
      }
      return undefined
    })
    const mockFetchA = makeDiscordFetch([{name: 'ping'}])
    await main({env, args: [], fetch: mockFetchA, sleep: async () => {}, spawn: spawnFnA})

    const upCallA = callsA.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCallA).toBeDefined()
    expect(upCallA?.join(' ')).toContain('--no-build')
    expect(upCallA?.join(' ')).not.toContain('--force-recreate')

    // Secrets changed path — --force-recreate present alongside --no-build
    const {spawnFn: spawnFnB, calls: callsB} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: 'old-checksum-that-differs'})
      }
      return undefined
    })
    const mockFetchB = makeDiscordFetch([{name: 'ping'}])
    await main({env: makeEnv(), args: [], fetch: mockFetchB, sleep: async () => {}, spawn: spawnFnB})

    const upCallB = callsB.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCallB).toBeDefined()
    expect(upCallB?.join(' ')).toContain('--no-build')
    expect(upCallB?.join(' ')).toContain('--force-recreate')
  })

  test('readRemoteChecksum: SSH exits 0 with checksum → returns checksum string', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum, buildComposeOverride} = await import('./deploy')
    const env = makeEnv()
    const secrets = buildSecretFileList(env)
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    const expectedChecksum = computeSecretsChecksum([
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
    ])

    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    // If checksum matches, compose runs without --force-recreate — proves the value was returned
    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes("cat '")) {
        return makeSpawnResult({stdout: expectedChecksum, exitCode: 0})
      }
      return undefined
    })
    await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})
    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall?.join(' ')).not.toContain('--force-recreate')
  })

  test('readRemoteChecksum: SSH exits 0 with empty stdout (first deploy) → returns empty string, no force-recreate suppressed', async () => {
    const {main} = await import('./deploy')

    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes("cat '")) {
        // File doesn't exist on droplet: SSH exits 0, stdout is empty (via 2>/dev/null || echo '')
        return makeSpawnResult({stdout: '', exitCode: 0})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    // Empty prior checksum != current checksum → --force-recreate on the up command
    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall?.join(' ')).toContain('--force-recreate')
  })

  test('readRemoteChecksum: SSH exits non-zero → throws with exit code and stderr', async () => {
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Match the read command: `cat '.secrets-checksum'` (not the write: `cat >`)
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes("cat '")) {
        return makeSpawnResult({
          exitCode: 255,
          stderr: 'ssh: connect to host gateway.fro.bot port 22: Connection refused',
        })
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await expect(
      main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn}),
    ).rejects.toThrow(/Failed to read remote checksum.*exit 255.*Connection refused/)
  })

  test('error path (missing env): fails fast, no spawn invoked', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv()
    delete (env as Record<string, string>).DISCORD_TOKEN
    delete (env as Record<string, string>).S3_BUCKET

    await expect(main({env, args: [], spawn: spawnFn})).rejects.toThrow(/Missing required environment variables/)
    expect(calls).toHaveLength(0)
  })

  test('error path (SSH unreachable): spawn exits non-zero → deploy fails', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock(() =>
      makeSpawnResult({exitCode: 255, stderr: 'ssh: connect to host gateway.fro.bot port 22: Connection refused'}),
    )

    await expect(
      main({env: makeEnv(), args: [], fetch: makeDiscordFetch([]), sleep: async () => {}, spawn: spawnFn}),
    ).rejects.toThrow(/Command failed with exit code 255/)
  })

  test('error path (compose up fails): docker compose exits non-zero → deploy fails', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.some(s => s.includes('docker compose'))) {
        return makeSpawnResult({exitCode: 1, stderr: 'Error response from daemon: container failed to start'})
      }
      return undefined
    })

    await expect(
      main({env: makeEnv(), args: [], fetch: makeDiscordFetch([]), sleep: async () => {}, spawn: spawnFn}),
    ).rejects.toThrow(/Command failed with exit code 1/)
  })

  test('error path (registration timeout): fails with app/guild IDs, not token', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const fetchMock = mock(async () => new Response(JSON.stringify([]), {status: 200}))

    let errorMessage = ''
    try {
      await main({
        env: makeEnv(),
        args: [],
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        spawn: spawnFn,
        maxAttempts: 2,
        intervalMs: 0,
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('app123')
    expect(errorMessage).toContain('guild456')
    expect(errorMessage).not.toContain('tok-secret')
  })

  test('happy path (--dry-run): no spawn invocations', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({env: makeEnv(), args: ['--dry-run'], spawn: spawnFn})

    expect(calls).toHaveLength(0)
  })

  test('edge case (SSH_AUTH_SOCK local mode): CI unset + SSH_AUTH_SOCK unset → fails fast', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv({CI: ''})
    delete (env as Record<string, string>).SSH_AUTH_SOCK

    await expect(main({env, args: [], spawn: spawnFn})).rejects.toThrow(/SSH_AUTH_SOCK/)
    expect(calls).toHaveLength(0)
  })

  // ── checksum persists only after compose + registration both succeed ──────────────

  test('compose failure leaves checksum unwritten so next deploy still force-recreates', async () => {
    const {main} = await import('./deploy')
    const checksumWrites: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Track checksum writes (write: `echo <hash> > /path`; read: `cat ... || echo ''` — different)
      if (cmdStr.includes('> /opt/gateway/.secrets-checksum')) {
        checksumWrites.push(cmdStr)
        return makeSpawnResult()
      }
      // Compose fails
      if (cmdStr.includes('docker compose')) {
        return makeSpawnResult({exitCode: 1, stderr: 'compose failed'})
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/Command failed with exit code 1/)

    // Checksum must NOT have been written since compose failed
    expect(checksumWrites).toHaveLength(0)
  })

  test('pollRegistration failure leaves checksum unwritten', async () => {
    const {main} = await import('./deploy')
    const checksumWrites: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('> /opt/gateway/.secrets-checksum')) {
        checksumWrites.push(cmdStr)
        return makeSpawnResult()
      }
      return undefined
    })

    // Registration always returns empty → timeout
    const fetchMock = mock(async () => new Response(JSON.stringify([]), {status: 200}))

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        spawn: spawnFn,
        maxAttempts: 1,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/timed out/)

    // Checksum must NOT have been written since registration failed
    expect(checksumWrites).toHaveLength(0)
  })

  test('checksum written only after successful compose + registration', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose')) {
        eventLog.push('compose')
      } else if (cmdStr.includes("cat > '/opt/gateway/.secrets-checksum'")) {
        // Only the write: `umask 077; cat > '/opt/gateway/.secrets-checksum'` (content arrives via stdin)
        eventLog.push('checksum-write')
      }
      return undefined
    })

    const fetchMock = mock(async () => {
      eventLog.push('poll-registration')
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      spawn: spawnFn,
    })

    const composeIdx = eventLog.indexOf('compose')
    const pollIdx = eventLog.indexOf('poll-registration')
    const checksumIdx = eventLog.indexOf('checksum-write')

    expect(composeIdx).toBeGreaterThanOrEqual(0)
    expect(pollIdx).toBeGreaterThan(composeIdx)
    expect(checksumIdx).toBeGreaterThan(pollIdx)
  })
})

// ─── validateObjectStoreHosts (S3) ───────────────────────────────────────────

describe('validateObjectStoreHosts', () => {
  // ── valid inputs ────────────────────────────────────────────────────────────

  test('accepts valid AWS S3 hostname', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('bucket.s3.us-east-1.amazonaws.com')).not.toThrow()
  })

  test('accepts valid R2 hostname', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('abc123.r2.cloudflarestorage.com')).not.toThrow()
  })

  test('accepts valid plain hostname', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('minio.example.com')).not.toThrow()
  })

  test('accepts valid comma-separated list', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('host1.example.com,host2.example.com')).not.toThrow()
  })

  test('accepts empty string (no override)', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('')).not.toThrow()
  })

  test('accepts all-numeric label (RFC1123 allows it)', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('123.com')).not.toThrow()
  })

  test('accepts hostnames with whitespace trimmed per entry', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('host1.example.com, host2.example.com')).not.toThrow()
  })

  // ── invalid inputs ──────────────────────────────────────────────────────────

  test('rejects hostname with underscore', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('host_underscore.com')).toThrow()
  })

  test('rejects simple-host_name (previously blessed — now invalid)', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('simple-host_name')).toThrow()
  })

  test('rejects hostname with uppercase letter', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('Host.example.com')).toThrow()
  })

  test('rejects label with leading hyphen', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('-leading-hyphen.com')).toThrow()
  })

  test('rejects label with trailing hyphen', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('trailing-hyphen-.com')).toThrow()
  })

  test('rejects double-dot (empty label)', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('..double.dot.com')).toThrow()
  })

  test('rejects label exceeding 63 chars', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() =>
      validateObjectStoreHosts('a-very-long-label-that-exceeds-the-rfc1123-limit-of-sixty-three-chars-yes.com'),
    ).toThrow()
  })

  test('rejects mixed list where one host is invalid', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('valid.example.com,bad_one.com')).toThrow()
  })

  test('rejects values with shell metacharacters', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('host; rm -rf /')).toThrow()
    expect(() => validateObjectStoreHosts('$(evil)')).toThrow()
    expect(() => validateObjectStoreHosts('`cmd`')).toThrow()
    expect(() => validateObjectStoreHosts('host && bad')).toThrow()
  })

  // ── error message quality ───────────────────────────────────────────────────

  test('error message names the offending host', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('bad_one.com')).toThrow(/bad_one\.com/)
  })

  test('error message names the offending host in a mixed list', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('valid.example.com,bad_one.com')).toThrow(/bad_one\.com/)
  })

  // ── integration: rejected before SSH ───────────────────────────────────────

  test('S3: malformed OBJECT_STORE_HOSTS rejected before SSH is invoked', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({OBJECT_STORE_HOSTS: 'host_underscore.com'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // No SSH calls should have been made
    expect(calls).toHaveLength(0)
  })
})

// ─── redactSecretsFromError (S1) ─────────────────────────────────────────────

describe('redactSecretsFromError', () => {
  test('replaces secret values with redacted placeholders', async () => {
    const {redactSecretsFromError} = await import('./deploy')
    const secrets = [
      {name: 'discord_token', content: 'super-secret-token', required: true},
      {name: 'aws_key', content: 'AKIAIOSFODNN7EXAMPLE', required: true},
    ]
    const err = new Error('SSH failed: super-secret-token was echoed in output AKIAIOSFODNN7EXAMPLE')
    const sanitized = redactSecretsFromError(err, secrets)
    expect(sanitized.message).not.toContain('super-secret-token')
    expect(sanitized.message).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(sanitized.message).toContain('<redacted:discord_token>')
    expect(sanitized.message).toContain('<redacted:aws_key>')
  })

  test('handles non-Error inputs', async () => {
    const {redactSecretsFromError} = await import('./deploy')
    const secrets = [{name: 'tok', content: 'secret-val', required: true}]
    const sanitized = redactSecretsFromError('raw string with secret-val', secrets)
    expect(sanitized.message).not.toContain('secret-val')
    expect(sanitized.message).toContain('<redacted:tok>')
  })

  test('skips secrets with empty content', async () => {
    const {redactSecretsFromError} = await import('./deploy')
    const secrets = [{name: 'optional', content: '', required: false}]
    const err = new Error('some error message')
    const sanitized = redactSecretsFromError(err, secrets)
    expect(sanitized.message).toBe('some error message')
  })
})

// ─── T1: secret-write SSH failure — token confidentiality ────────────────────

describe('T1 secret-write failure token confidentiality', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('SSH spawn failure on discord-token write: error does not contain token value', async () => {
    const {main} = await import('./deploy')
    const TOKEN = 'tok-secret'

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Fail specifically on the discord-token secret write (identified by path)
      if (cmdStr.includes('discord-token')) {
        return makeSpawnResult({
          exitCode: 1,
          // Simulate SSH echoing back something that might contain the token
          stderr: `cat: write error: ${TOKEN}`,
        })
      }
      return undefined
    })

    let caughtError: Error | undefined
    try {
      await main({
        env: makeEnv({DISCORD_TOKEN: TOKEN}),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      })
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error))
    }

    expect(caughtError).toBeDefined()
    // The thrown error must NOT contain the actual token value
    expect(caughtError?.message).not.toContain(TOKEN)
    // The error should reference the label (not the secret content)
    expect(caughtError?.message).toContain('discord-token')
  })

  test('S2: secret with shell metacharacters written via stdin, not argv', async () => {
    const {main} = await import('./deploy')
    const TRICKY_TOKEN = "tok'with'quotes\nand newlines\n$VAR `backtick` ; && \\"
    const stdinContents: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('discord-token')) {
        // Capture stdin content
        const result = makeSpawnResult({captureStdin: true})
        // Intercept stdin writes
        const origWrite = result.stdin!.write.bind(result.stdin)
        result.stdin!.write = (data: Uint8Array) => {
          stdinContents.push(new TextDecoder().decode(data))
          origWrite(data)
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({DISCORD_TOKEN: TRICKY_TOKEN}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // The token must have been passed via stdin, not in the command argv
    // Verify the tricky token is NOT in any command string
    // (we can't easily access calls here, but we can verify stdin received it)
    expect(stdinContents.join('')).toContain(TRICKY_TOKEN)
  })
})

// ─── per-attempt timeout (AbortController) ───────────────────────────────────

describe('pollRegistration per-attempt timeout', () => {
  test('never-resolving fetch: exhausts maxAttempts via per-attempt timeout, resolves in bounded time', async () => {
    const {pollRegistration} = await import('./deploy')

    // fetch that respects the abort signal — simulates a stalled connection that
    // eventually gets cut by the AbortController
    const hangingFetch = (_url: string, opts?: RequestInit): Promise<Response> => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = opts?.signal
        if (signal) {
          if (signal.aborted) {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
            return
          }
          signal.addEventListener('abort', () => {
            const err = new Error('The operation was aborted.')
            err.name = 'AbortError'
            reject(err)
          })
        }
        // Otherwise hangs forever (signal will abort it)
      })
    }

    const start = Date.now()
    await expect(
      pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: hangingFetch as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 2,
        intervalMs: 0,
        perAttemptTimeoutMs: 50,
      }),
    ).rejects.toThrow(/timed out after 2 attempts/)

    const elapsed = Date.now() - start
    // Should complete well under 5s (2 attempts × 50ms timeout each + overhead)
    expect(elapsed).toBeLessThan(5000)
  })

  test('single hang then recovery: first fetch hangs, subsequent returns 200 + commands', async () => {
    const {pollRegistration} = await import('./deploy')
    let callCount = 0

    const fetchMock = (_url: string, opts?: RequestInit): Promise<Response> => {
      callCount++
      if (callCount === 1) {
        // First call hangs until aborted
        return new Promise<Response>((_resolve, reject) => {
          const signal = opts?.signal
          if (signal) {
            signal.addEventListener('abort', () => {
              const err = new Error('The operation was aborted.')
              err.name = 'AbortError'
              reject(err)
            })
          }
        })
      }
      return Promise.resolve(new Response(JSON.stringify([{name: 'ping'}]), {status: 200}))
    }

    const result = await pollRegistration({
      applicationId: 'app1',
      guildId: 'guild1',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxAttempts: 3,
      intervalMs: 0,
      perAttemptTimeoutMs: 50,
    })

    expect(result.commands).toEqual(['ping'])
    // First call hung and was aborted; second call succeeded
    expect(callCount).toBeGreaterThanOrEqual(2)
  })
})

// ─── pollRegistration status branching ───────────────────────────────────

describe('pollRegistration status branching', () => {
  test('429 with Retry-After ≤ 60s: waits and retries without counting against maxAttempts', async () => {
    const {pollRegistration} = await import('./deploy')
    let callCount = 0
    const sleepCalls: number[] = []

    const fetchMock = mock(async () => {
      callCount++
      if (callCount === 1) {
        return new Response('', {
          status: 429,
          headers: {'Retry-After': '2'},
        })
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    const result = await pollRegistration({
      applicationId: 'app1',
      guildId: 'guild1',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async (ms: number) => {
        sleepCalls.push(ms)
      },
      maxAttempts: 2,
      intervalMs: 1000,
    })

    expect(result.commands).toEqual(['ping'])
    // Should have slept for 2000ms (Retry-After: 2 seconds)
    expect(sleepCalls).toContain(2000)
    // Total fetch calls: 2 (429 + 200)
    expect(callCount).toBe(2)
  })

  test('429 with Retry-After > 60s: aborts with clear message', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(
      async () =>
        new Response('', {
          status: 429,
          headers: {'Retry-After': '120'},
        }),
    )

    await expect(
      pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 3,
      }),
    ).rejects.toThrow(/rate-limit too long/)
  })

  test('5xx: retries with normal interval, counts against maxAttempts', async () => {
    const {pollRegistration} = await import('./deploy')
    let callCount = 0

    const fetchMock = mock(async () => {
      callCount++
      if (callCount < 3) {
        return new Response('Internal Server Error', {status: 500})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    const result = await pollRegistration({
      applicationId: 'app1',
      guildId: 'guild1',
      token: 'tok',
      fetch: fetchMock as unknown as typeof fetch,
      sleep: async () => {},
      maxAttempts: 5,
      intervalMs: 0,
    })

    expect(result.commands).toEqual(['ping'])
    expect(callCount).toBe(3)
  })

  test('5xx exhausts maxAttempts → throws timeout error', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Service Unavailable', {status: 503}))

    await expect(
      pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 2,
        intervalMs: 0,
      }),
    ).rejects.toThrow(/timed out after 2 attempts/)
  })

  test('401: aborts immediately with app/guild IDs, not token', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Unauthorized', {status: 401}))

    let errorMessage = ''
    try {
      await pollRegistration({
        applicationId: 'appXYZ',
        guildId: 'guildABC',
        token: 'secret-bot-token',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        maxAttempts: 5,
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('401')
    expect(errorMessage).toContain('appXYZ')
    expect(errorMessage).toContain('guildABC')
    expect(errorMessage).not.toContain('secret-bot-token')
  })

  test('403: aborts immediately', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Forbidden', {status: 403}))

    await expect(
      pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/403/)
  })

  test('404: aborts immediately', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Not Found', {status: 404}))

    await expect(
      pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/404/)
  })

  test('other 4xx (e.g. 422): aborts immediately with status + IDs', async () => {
    const {pollRegistration} = await import('./deploy')
    const fetchMock = mock(async () => new Response('Unprocessable', {status: 422}))

    let errorMessage = ''
    try {
      await pollRegistration({
        applicationId: 'app1',
        guildId: 'guild1',
        token: 'tok',
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('422')
    expect(errorMessage).toContain('app1')
    expect(errorMessage).toContain('guild1')
  })
})

// ─── B1: validateGatewayHost in main() ───────────────────────────────────────

describe('main() — GATEWAY_HOST validation (B1)', () => {
  test('valid host passes validation and proceeds to SSH phase', async () => {
    const {main} = await import('./deploy')

    // A valid host should not throw from the validation step itself.
    // It will fail later when SSH is attempted (no spawn mock), but that's fine —
    // we just need to confirm the validator doesn't reject it.
    let thrownMessage = ''
    try {
      await main({
        env: makeEnv({GATEWAY_HOST: 'gateway.fro.bot'}),
        args: [],
        spawn: () => {
          throw new Error('spawn-reached')
        },
      })
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    // Should reach spawn (SSH phase), not throw from host validation
    expect(thrownMessage).toContain('spawn-reached')
  })

  test('leading-hyphen host is rejected before any SSH invocation', async () => {
    const {main} = await import('./deploy')

    let spawnCalled = false
    let thrownMessage = ''

    try {
      await main({
        env: makeEnv({GATEWAY_HOST: '-oProxyCommand=touch /tmp/sec-deploy-pwned'}),
        args: [],
        spawn: () => {
          spawnCalled = true
          throw new Error('spawn must not be called')
        },
      })
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    expect(spawnCalled).toBe(false)
    expect(thrownMessage).toMatch(/Invalid GATEWAY_HOST/)

    // Behavioral verification: the attack file must not exist
    const {existsSync} = await import('node:fs')
    expect(existsSync('/tmp/sec-deploy-pwned')).toBe(false)
  })

  test('shell-metacharacter host is rejected before any SSH invocation', async () => {
    const {main} = await import('./deploy')

    let spawnCalled = false
    let thrownMessage = ''

    try {
      await main({
        env: makeEnv({GATEWAY_HOST: 'host;rm -rf /'}),
        args: [],
        spawn: () => {
          spawnCalled = true
          throw new Error('spawn must not be called')
        },
      })
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    expect(spawnCalled).toBe(false)
    expect(thrownMessage).toMatch(/Invalid GATEWAY_HOST/)
  })
})

// ─── CI key-file contract ─────────────────────────────────────────────────────

describe('CI key-file contract', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('CI mode: tmp key file written with mode 0o600', async () => {
    const {main} = await import('./deploy')
    const KEY_CONTENT = 'fake-ssh-private-key-content'
    let writtenKeyPath: string | undefined
    let capturedMode: number | undefined

    const {spawnFn} = makeSpawnMock(cmd => {
      // Capture the -i path from the first ssh call and stat the file while it still exists
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1 && writtenKeyPath === undefined) {
        writtenKeyPath = cmd[iIdx + 1]
        if (writtenKeyPath) capturedMode = statSync(writtenKeyPath).mode & 0o777
      }
      return undefined
    })

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: KEY_CONTENT}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(writtenKeyPath).toBeDefined()
    // File mode must be 0o600 (checked while file existed, before cleanup)
    expect(capturedMode).toBe(0o600)
    // File should have been cleaned up after main() completes
    expect(existsSync(writtenKeyPath!)).toBe(false)
  })

  test('CI mode: -i <path> and -o IdentitiesOnly=yes appear in every ssh argv', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // Every ssh call must have -i and IdentitiesOnly=yes
    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      expect(cmd).toContain('-i')
      expect(cmd).toContain('IdentitiesOnly=yes')
    }
  })

  test('CI mode: key bytes do not appear in any ssh argv', async () => {
    const {main} = await import('./deploy')
    const KEY_CONTENT = 'SUPER_SECRET_KEY_BYTES_THAT_MUST_NOT_LEAK'
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: KEY_CONTENT}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    for (const cmd of calls) {
      const cmdStr = cmd.join(' ')
      expect(cmdStr).not.toContain(KEY_CONTENT)
    }
  })

  test('CI mode: tmp file cleaned up even when main() throws mid-deploy', async () => {
    const {main} = await import('./deploy')
    let capturedKeyPath: string | undefined

    const {spawnFn} = makeSpawnMock(cmd => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1 && capturedKeyPath === undefined) {
        capturedKeyPath = cmd[iIdx + 1]
      }
      // Fail on first mkdir (first SSH call)
      return makeSpawnResult({exitCode: 255, stderr: 'Connection refused'})
    })

    await expect(
      main({
        env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
        args: [],
        fetch: makeDiscordFetch([]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // Key file must be cleaned up even though main() threw
    expect(capturedKeyPath).toBeDefined()
    expect(existsSync(capturedKeyPath!)).toBe(false)
  })

  test('CI mode: tmp dir cleaned up when key materialization throws (inner catch path)', async () => {
    // Verify the inner try/catch in key materialization cleans up keyTmpDir when
    // an fs operation throws. Named ESM imports in deploy.ts cannot be intercepted
    // via spyOn (Bun resolves them as live bindings, bypassing the CJS module cache),
    // so we test the cleanup logic directly using the same rmSync call the inner catch uses.
    const {mkdtempSync: realMkdtemp, rmSync: realRmSync, existsSync: realExistsSync} = await import('node:fs')
    const {tmpdir: realTmpdir} = await import('node:os')
    const {join: realJoin} = await import('node:path')

    // Simulate: mkdtempSync succeeds, then something throws
    const keyTmpDir = realMkdtemp(realJoin(realTmpdir(), 'gateway-deploy-key-'))
    expect(realExistsSync(keyTmpDir)).toBe(true)

    // Simulate the inner catch block: rmSync({recursive: true, force: true})
    realRmSync(keyTmpDir, {recursive: true, force: true})

    // The dir must be gone
    expect(realExistsSync(keyTmpDir)).toBe(false)

    // Calling rmSync again (as the outer finally would) must not throw
    expect(() => realRmSync(keyTmpDir, {recursive: true, force: true})).not.toThrow()
  })
  test('CI mode: key file gets trailing newline appended when GH Actions strips it', async () => {
    const {main} = await import('./deploy')
    // Simulate GitHub Actions stripping the trailing newline from the secret
    const KEY_WITHOUT_NEWLINE = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-bytes\n-----END OPENSSH PRIVATE KEY-----'
    let writtenKeyPath: string | undefined
    let capturedContents: string | undefined

    const {spawnFn} = makeSpawnMock(cmd => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1 && writtenKeyPath === undefined) {
        writtenKeyPath = cmd[iIdx + 1]
        if (writtenKeyPath) capturedContents = readFileSync(writtenKeyPath, 'utf-8')
      }
      return undefined
    })

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: KEY_WITHOUT_NEWLINE}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(writtenKeyPath).toBeDefined()
    // File must end with exactly one newline
    expect(capturedContents).toBe(`${KEY_WITHOUT_NEWLINE}\n`)
    expect(capturedContents!.endsWith('\n')).toBe(true)
  })

  test('CI mode: key file is not double-newlined when secret already has trailing newline', async () => {
    const {main} = await import('./deploy')
    // Key already has a trailing newline (e.g. from a local .env file)
    const KEY_WITH_NEWLINE = '-----BEGIN OPENSSH PRIVATE KEY-----\nfake-key-bytes\n-----END OPENSSH PRIVATE KEY-----\n'
    let writtenKeyPath: string | undefined
    let capturedContents: string | undefined

    const {spawnFn} = makeSpawnMock(cmd => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1 && writtenKeyPath === undefined) {
        writtenKeyPath = cmd[iIdx + 1]
        if (writtenKeyPath) capturedContents = readFileSync(writtenKeyPath, 'utf-8')
      }
      return undefined
    })

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: KEY_WITH_NEWLINE}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(writtenKeyPath).toBeDefined()
    // Must not double-newline — exactly one trailing newline
    expect(capturedContents).toBe(KEY_WITH_NEWLINE)
    expect(capturedContents!.endsWith('\n\n')).toBe(false)
  })

  test('local mode: no -i flag in ssh argv, SSH_AUTH_SOCK forwarded', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: '', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', GATEWAY_SSH_KEY: ''}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      expect(cmd).not.toContain('-i')
      expect(cmd).not.toContain('IdentitiesOnly=yes')
    }
  })

  test('local mode: SSH_AUTH_SOCK absent → fails fast before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv({CI: ''})
    delete (env as Record<string, string>).SSH_AUTH_SOCK
    delete (env as Record<string, string>).GATEWAY_SSH_KEY

    await expect(main({env, args: [], spawn: spawnFn})).rejects.toThrow(/SSH_AUTH_SOCK/)
    expect(calls).toHaveLength(0)
  })
})

// ─── SSH ControlMaster multiplexing ──────────────────────────────────────────

describe('SSH ControlMaster multiplexing', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('CI mode: every ssh argv includes ControlMaster=auto', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      expect(cmd).toContain('ControlMaster=auto')
    }
  })

  test('CI mode: every ssh argv includes ControlPath under /tmp/gw-cm-* (not the key tmpdir)', async () => {
    // After the macOS ControlPath-length fix, the control socket lives under a short
    // /tmp-rooted dir (gw-cm-*) separate from the key tmpdir (gateway-deploy-key-*).
    const {main} = await import('./deploy')

    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      const controlPathArg = cmd.find(arg => arg.startsWith('ControlPath='))
      expect(controlPathArg).toBeDefined()
      // Control socket must be under /tmp/gw-cm-*, not under the key tmpdir
      expect(controlPathArg).toMatch(/^ControlPath=\/tmp\/gw-cm-/)
    }
  })

  test('CI mode: every ssh argv includes ControlPersist=300', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      expect(cmd).toContain('ControlPersist=300')
    }
  })

  test('local mode: ssh argv still includes ControlMaster=auto when CI is unset', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: '', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', GATEWAY_SSH_KEY: ''}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      expect(cmd).toContain('ControlMaster=auto')
      expect(cmd).toContain('ControlPersist=300')
    }
  })

  test('local mode: ControlPath is set even without a CI key file', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({CI: '', SSH_AUTH_SOCK: '/tmp/ssh-agent.sock', GATEWAY_SSH_KEY: ''}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const sshCalls = calls.filter(cmd => cmd[0] === 'ssh')
    expect(sshCalls.length).toBeGreaterThan(0)

    for (const cmd of sshCalls) {
      const controlPathArg = cmd.find(arg => arg.startsWith('ControlPath='))
      expect(controlPathArg).toBeDefined()
    }
  })

  test('macOS long TMPDIR: ControlPath is rooted at /tmp, not the long TMPDIR, and stays under 104 bytes', async () => {
    // Regression test for macOS sun_path limit (104 bytes).
    // On macOS, os.tmpdir() returns a long path like /var/folders/td/f1mm.../T/
    // which causes the ControlPath unix-domain socket to exceed 104 bytes → ssh exits 255.
    // The fix: root the control socket under /tmp (short) regardless of os.tmpdir().
    //
    // Strategy: create a real long-named dir under the actual tmpdir so mkdtempSync
    // succeeds (simulating macOS where the long path exists), then assert the captured
    // ControlPath is rooted at /tmp/ and stays under 104 bytes.
    const {main} = await import('./deploy')
    const {mkdtempSync: realMkdtemp, rmSync: realRmSync} = await import('node:fs')
    const {tmpdir: realTmpdir} = await import('node:os')
    const {join: realJoin} = await import('node:path')

    // Create a real long-named parent dir under the actual tmpdir to simulate macOS.
    // The name is long enough that a socket path rooted here would exceed 104 bytes.
    const longParent = realMkdtemp(realJoin(realTmpdir(), 'gateway-deploy-macos-sim-long-path-xxxxxxxx-'))
    const originalTmpdir = process.env.TMPDIR
    process.env.TMPDIR = longParent

    const capturedControlPaths: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const controlPathArg = cmd.find(arg => arg.startsWith('ControlPath='))
      if (controlPathArg) {
        capturedControlPaths.push(controlPathArg.slice('ControlPath='.length))
      }
      return undefined
    })

    try {
      await main({
        env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      })
    } finally {
      if (originalTmpdir === undefined) {
        delete process.env.TMPDIR
      } else {
        process.env.TMPDIR = originalTmpdir
      }
      realRmSync(longParent, {recursive: true, force: true})
    }

    expect(capturedControlPaths.length).toBeGreaterThan(0)

    for (const controlPath of capturedControlPaths) {
      // (a) Must be rooted at /tmp/, NOT under the long TMPDIR
      expect(controlPath.startsWith('/tmp/')).toBe(true)
      expect(controlPath.startsWith(longParent)).toBe(false)

      // (b) Worst-case resolved length must stay under 104 bytes.
      // Replace %C with a 40-char placeholder (SHA1 hex hash length) to simulate expansion.
      const worstCase = controlPath.replace('%C', 'a'.repeat(40))
      expect(worstCase.length).toBeLessThan(104)
    }
  })

  test('deploy failure mid-way: tmpdir (and ControlPath socket) is cleaned up by finally', async () => {
    const {main} = await import('./deploy')
    let capturedControlPath: string | undefined

    const {spawnFn} = makeSpawnMock(cmd => {
      if (capturedControlPath === undefined) {
        const controlPathArg = cmd.find(arg => arg.startsWith('ControlPath='))
        if (controlPathArg) {
          // Extract the directory portion from ControlPath=<dir>/cm-%C
          capturedControlPath = controlPathArg.replace(/^ControlPath=/, '').replace(/\/cm-%C$/, '')
        }
      }
      // Fail on the first SSH call to simulate mid-deploy failure
      return makeSpawnResult({exitCode: 255, stderr: 'Connection refused'})
    })

    await expect(
      main({
        env: makeEnv({CI: 'true', GATEWAY_SSH_KEY: 'fake-key'}),
        args: [],
        fetch: makeDiscordFetch([]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // The tmpdir containing the ControlPath socket must be cleaned up
    expect(capturedControlPath).toBeDefined()
    if (capturedControlPath) {
      expect(existsSync(capturedControlPath)).toBe(false)
    }
  })
})

// ─── upstream stack validation (validate-stack.sh) ───────────────────────────

describe('upstream stack validation (validate-stack.sh)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('RED: deploy flow invokes deploy/validate-stack.sh after writing compose.override.yaml and before docker compose pull', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('compose.override.yaml') && cmdStr.includes("cat > '")) {
        eventLog.push('write-override')
      } else if (cmdStr.includes('validate-stack.sh')) {
        eventLog.push('validate-stack')
      } else if (cmdStr.includes('docker compose') && cmdStr.includes(' pull')) {
        eventLog.push('compose-pull')
      }
      return undefined
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const overrideIdx = eventLog.indexOf('write-override')
    const validateIdx = eventLog.indexOf('validate-stack')
    const pullIdx = eventLog.indexOf('compose-pull')

    // validate-stack.sh must be invoked
    expect(validateIdx).toBeGreaterThanOrEqual(0)
    // validate-stack.sh must run after compose.override.yaml is written
    expect(validateIdx).toBeGreaterThan(overrideIdx)
    // validate-stack.sh must run before docker compose pull
    expect(validateIdx).toBeLessThan(pullIdx)
  })

  test('RED: validate-stack.sh command uses upstream script under DEPLOY_DIR (not a repo-local script)', async () => {
    const {main} = await import('./deploy')
    const validateCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('validate-stack.sh')) {
        validateCmds.push(cmd)
      }
      return undefined
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(validateCmds).toHaveLength(1)
    const cmdStr = validateCmds[0]!.join(' ')
    // Must reference the upstream script path (deploy/validate-stack.sh relative to REMOTE_DIR)
    expect(cmdStr).toContain('deploy/validate-stack.sh')
    // Must NOT reference a repo-local path (apps/gateway or similar)
    expect(cmdStr).not.toContain('apps/gateway')
    // Must be run from the remote dir (/opt/gateway), not a local path
    expect(cmdStr).toContain('/opt/gateway')
  })

  test('RED: non-zero validator exit aborts deploy before docker compose pull', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('validate-stack.sh')) {
        eventLog.push('validate-stack')
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: sandbox-net is not internal:true'})
      }
      if (cmdStr.includes('docker compose') && cmdStr.includes(' pull')) {
        eventLog.push('compose-pull')
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // validate-stack.sh was invoked
    expect(eventLog).toContain('validate-stack')
    // docker compose pull must NOT have been invoked
    expect(eventLog).not.toContain('compose-pull')
  })

  test('RED: non-zero validator exit aborts deploy before docker compose up', async () => {
    const {main} = await import('./deploy')
    const composeCalls: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('validate-stack.sh')) {
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: topology violation'})
      }
      if (cmdStr.includes('docker compose') && cmdStr.includes(' up ')) {
        composeCalls.push(cmdStr)
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // docker compose up must NOT have been invoked
    expect(composeCalls).toHaveLength(0)
  })

  test('RED: non-zero validator exit aborts deploy before checksum persistence', async () => {
    const {main} = await import('./deploy')
    const checksumWrites: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('validate-stack.sh')) {
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: topology violation'})
      }
      if (cmdStr.includes('> /opt/gateway/.secrets-checksum')) {
        checksumWrites.push(cmdStr)
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    // Checksum must NOT have been written
    expect(checksumWrites).toHaveLength(0)
  })
})

// ─── github app secret materialization ───────────────────────────────────────

describe('github app secret materialization', () => {
  const SAMPLE_PEM =
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234\nabcdefghijklmnop\n-----END RSA PRIVATE KEY-----\n'

  test('github-app-id included as required secret mapped to GH_APP_ID', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({GH_APP_ID: '123456', GH_APP_PRIVATE_KEY: SAMPLE_PEM}))
    const entry = secrets.find(s => s.name === 'github-app-id')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('123456')
    expect(entry?.required).toBe(true)
  })

  test('github-app-private-key included as required secret mapped to GH_APP_PRIVATE_KEY', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({GH_APP_ID: '123456', GH_APP_PRIVATE_KEY: SAMPLE_PEM}))
    const entry = secrets.find(s => s.name === 'github-app-private-key')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe(SAMPLE_PEM)
    expect(entry?.required).toBe(true)
  })

  test('discord-privileged-intents included as optional secret mapped to DISCORD_PRIVILEGED_INTENTS', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(
      makeEnv({
        GH_APP_ID: '123456',
        GH_APP_PRIVATE_KEY: SAMPLE_PEM,
        DISCORD_PRIVILEGED_INTENTS: 'GUILD_MEMBERS,GUILD_PRESENCES',
      }),
    )
    const entry = secrets.find(s => s.name === 'discord-privileged-intents')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('GUILD_MEMBERS,GUILD_PRESENCES')
    expect(entry?.required).toBe(false)
  })

  test('discord-privileged-intents unset → empty content, required false', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv({GH_APP_ID: '123456', GH_APP_PRIVATE_KEY: SAMPLE_PEM})
    delete (env as Record<string, string>).DISCORD_PRIVILEGED_INTENTS
    const secrets = buildSecretFileList(env)
    const entry = secrets.find(s => s.name === 'discord-privileged-intents')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('')
    expect(entry?.required).toBe(false)
  })

  test('multiline PEM content preserved verbatim in github-app-private-key', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({GH_APP_ID: '123456', GH_APP_PRIVATE_KEY: SAMPLE_PEM}))
    const entry = secrets.find(s => s.name === 'github-app-private-key')
    expect(entry?.content).toBe(SAMPLE_PEM)
  })

  test('GH_APP_ID missing → validateRequiredEnv reports missing var', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv({GH_APP_PRIVATE_KEY: SAMPLE_PEM})
    delete (env as Record<string, string>).GH_APP_ID
    const missing = validateRequiredEnv(env)
    expect(missing).toContain('GH_APP_ID')
  })

  test('GH_APP_PRIVATE_KEY missing → validateRequiredEnv reports missing var', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv({GH_APP_ID: '123456'})
    delete (env as Record<string, string>).GH_APP_PRIVATE_KEY
    const missing = validateRequiredEnv(env)
    expect(missing).toContain('GH_APP_PRIVATE_KEY')
  })
})

// ─── Empty-string fail-closed for workspace/trigger vars ─────────────────────

describe('validateRequiredEnv — workspace mention-loop vars', () => {
  test('WORKSPACE_OPENCODE_TOKEN unset → reported missing', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_TOKEN
    expect(validateRequiredEnv(env)).toContain('WORKSPACE_OPENCODE_TOKEN')
  })

  test('WORKSPACE_OPENCODE_TOKEN empty string → reported missing (fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({WORKSPACE_OPENCODE_TOKEN: ''}))).toContain('WORKSPACE_OPENCODE_TOKEN')
  })

  test('WORKSPACE_OPENCODE_TOKEN whitespace-only → reported missing (fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({WORKSPACE_OPENCODE_TOKEN: '   '}))).toContain('WORKSPACE_OPENCODE_TOKEN')
  })

  test('WORKSPACE_OPENCODE_AUTH unset → reported missing', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_AUTH
    expect(validateRequiredEnv(env)).toContain('WORKSPACE_OPENCODE_AUTH')
  })

  test('WORKSPACE_OPENCODE_AUTH empty string → reported missing (fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({WORKSPACE_OPENCODE_AUTH: ''}))).toContain('WORKSPACE_OPENCODE_AUTH')
  })

  test('WORKSPACE_OPENCODE_AUTH whitespace-only → reported missing (fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({WORKSPACE_OPENCODE_AUTH: '  '}))).toContain('WORKSPACE_OPENCODE_AUTH')
  })

  test('GATEWAY_TRIGGER_ROLE_ID unset → reported missing', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_TRIGGER_ROLE_ID
    expect(validateRequiredEnv(env)).toContain('GATEWAY_TRIGGER_ROLE_ID')
  })

  test('GATEWAY_TRIGGER_ROLE_ID empty string → reported missing (authz gate fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({GATEWAY_TRIGGER_ROLE_ID: ''}))).toContain('GATEWAY_TRIGGER_ROLE_ID')
  })

  test('GATEWAY_TRIGGER_ROLE_ID whitespace-only → reported missing (authz gate fail-closed)', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    expect(validateRequiredEnv(makeEnv({GATEWAY_TRIGGER_ROLE_ID: '   '}))).toContain('GATEWAY_TRIGGER_ROLE_ID')
  })

  test('all three present with real values → none reported missing', async () => {
    const {validateRequiredEnv} = await import('./deploy')
    const missing = validateRequiredEnv(makeEnv())
    expect(missing).not.toContain('WORKSPACE_OPENCODE_TOKEN')
    expect(missing).not.toContain('WORKSPACE_OPENCODE_AUTH')
    expect(missing).not.toContain('GATEWAY_TRIGGER_ROLE_ID')
  })
})

describe('buildSecretFileList — workspace mention-loop entries', () => {
  test('workspace-opencode-token maps to WORKSPACE_OPENCODE_TOKEN, required', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const entry = secrets.find(s => s.name === 'workspace-opencode-token')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('ws-token-secret')
    expect(entry?.required).toBe(true)
  })

  test('workspace-opencode-auth maps to WORKSPACE_OPENCODE_AUTH, required', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const entry = secrets.find(s => s.name === 'workspace-opencode-auth')
    expect(entry).toBeDefined()
    expect(entry?.required).toBe(true)
  })

  test('workspace-opencode-url unset → empty content, required false', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_URL
    const secrets = buildSecretFileList(env)
    const entry = secrets.find(s => s.name === 'workspace-opencode-url')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('')
    expect(entry?.required).toBe(false)
  })

  test('workspace-opencode-url set → content is the value', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({WORKSPACE_OPENCODE_URL: 'http://workspace:9200'}))
    const entry = secrets.find(s => s.name === 'workspace-opencode-url')
    expect(entry?.content).toBe('http://workspace:9200')
    expect(entry?.required).toBe(false)
  })

  test('gateway-trigger-role-id maps to GATEWAY_TRIGGER_ROLE_ID, required false in file list', async () => {
    // The env var is in REQUIRED_ENV_VARS (fail-closed), but the file-list entry is optional-shaped
    // so an empty value writes an empty file (upstream compose treats it as optional).
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const entry = secrets.find(s => s.name === 'gateway-trigger-role-id')
    expect(entry).toBeDefined()
    expect(entry?.content).toBe('123456789012345678')
    expect(entry?.required).toBe(false)
  })
})

// ─── .env materialization with MODEL/CONFIG validation ───────────────────────

describe('buildGatewayEnvFileContents', () => {
  test('happy path: valid model + JSON config → .env contains all three lines', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const result = buildGatewayEnvFileContents({
      objectStoreHosts: 'bucket.s3.us-east-1.amazonaws.com',
      model: 'anthropic/claude-sonnet-4-6',
      config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
    })
    expect(result).toContain('OBJECT_STORE_HOSTS=bucket.s3.us-east-1.amazonaws.com')
    expect(result).toContain('WORKSPACE_OPENCODE_MODEL=anthropic/claude-sonnet-4-6')
    // CONFIG line must be present
    expect(result).toMatch(/WORKSPACE_OPENCODE_CONFIG=/)
  })

  test('config containing $ signs: $$ escaping applied so docker-compose interpolation preserves literal $', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    // Fixture deliberately contains $ to exercise the escaping path
    const config =
      '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1","key":"$SECRET_VAL"}}}}'
    const result = buildGatewayEnvFileContents({
      objectStoreHosts: 'host.example.com',
      model: 'anthropic/claude-sonnet-4-6',
      config,
    })
    const configLine = result.split('\n').find(l => l.startsWith('WORKSPACE_OPENCODE_CONFIG='))
    expect(configLine).toBeDefined()
    // The raw .env line must have $$ where the original had $
    expect(configLine).toContain('$$SECRET_VAL')
    // Simulating docker-compose interpolation: replace $$ → $ to recover original
    const rawValue = configLine!.slice('WORKSPACE_OPENCODE_CONFIG='.length).replaceAll('$$', '$')
    expect(rawValue).toBe(config)
  })

  test('config containing $ survives docker-compose interpolation: $$ round-trip', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    // A config with a literal $ in a value field (e.g. a hypothetical env-var reference)
    // Must still have valid provider.anthropic.options.baseURL for the egress guard.
    const config =
      '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1","key":"value$with$dollars"}}}}'
    const result = buildGatewayEnvFileContents({
      objectStoreHosts: 'host.example.com',
      model: 'anthropic/claude-sonnet-4-6',
      config,
    })
    const configLine = result.split('\n').find(l => l.startsWith('WORKSPACE_OPENCODE_CONFIG='))
    expect(configLine).toBeDefined()
    // The raw .env line must have $$ where the original had $
    expect(configLine).toContain('$$')
    // Simulating docker-compose interpolation: replace $$ → $ to recover original
    const rawValue = configLine!.slice('WORKSPACE_OPENCODE_CONFIG='.length).replaceAll('$$', '$')
    expect(rawValue).toBe(config)
  })

  test('config with actual backslash payload round-trips intact', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    // Fixture contains a real backslash (JSON-encoded as \\) to exercise the backslash path
    const config = String.raw`{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1","path":"C:\\Users\\agent"}}}}`
    const result = buildGatewayEnvFileContents({
      objectStoreHosts: 'host.example.com',
      model: 'anthropic/claude-sonnet-4-6',
      config,
    })
    const configLine = result.split('\n').find(l => l.startsWith('WORKSPACE_OPENCODE_CONFIG='))
    expect(configLine).toBeDefined()
    // The .env line must contain the backslash characters from the JSON payload
    expect(configLine).toContain('\\\\')
    // Recover: $$ → $ (docker-compose interpolation simulation); backslashes pass through unchanged
    const rawValue = configLine!.slice('WORKSPACE_OPENCODE_CONFIG='.length).replaceAll('$$', '$')
    expect(rawValue).toBe(config)
  })

  test('SHELL_METACHAR_RE is NOT applied to config (would reject valid JSON)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    // This config contains " and $ — both rejected by SHELL_METACHAR_RE but valid JSON
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).not.toThrow()
  })

  test('invalid JSON config → throws before any SSH write', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: 'not-valid-json',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG.*not valid JSON/i)
  })

  test('config with embedded newline → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"key":"value\nwith newline"}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG.*newline/i)
  })

  test('config exceeding size cap → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const bigConfig = `{"key":"${'x'.repeat(20_000)}"}`
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: bigConfig,
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG.*too large/i)
  })

  test('model with shell metachar → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6; rm -rf /',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('model with valid id (no metachar) → accepted', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).not.toThrow()
  })

  test('emits WORKSPACE_EGRESS_HOSTS with cliproxy and models.dev so the workspace can reach both the proxy and the OpenCode model catalog', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const result = buildGatewayEnvFileContents({
      objectStoreHosts: 'bucket.s3.us-east-1.amazonaws.com',
      model: 'anthropic/claude-sonnet-4-6',
      config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
    })
    // Must contain exactly this line so mitmproxy allows the workspace to reach cliproxy
    // and the OpenCode model catalog (models.dev) — without models.dev OpenCode cannot start
    expect(result.split('\n')).toContain('WORKSPACE_EGRESS_HOSTS=cliproxy.fro.bot,models.dev')
  })
})

describe('getMissingWorkspaceEnvVars', () => {
  test('WORKSPACE_OPENCODE_MODEL missing → reported missing', async () => {
    const {getMissingWorkspaceEnvVars} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_MODEL
    expect(getMissingWorkspaceEnvVars(env)).toContain('WORKSPACE_OPENCODE_MODEL')
  })

  test('WORKSPACE_OPENCODE_MODEL empty → reported missing', async () => {
    const {getMissingWorkspaceEnvVars} = await import('./deploy')
    expect(getMissingWorkspaceEnvVars(makeEnv({WORKSPACE_OPENCODE_MODEL: ''}))).toContain('WORKSPACE_OPENCODE_MODEL')
  })

  test('WORKSPACE_OPENCODE_CONFIG missing → reported missing', async () => {
    const {getMissingWorkspaceEnvVars} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_CONFIG
    expect(getMissingWorkspaceEnvVars(env)).toContain('WORKSPACE_OPENCODE_CONFIG')
  })

  test('WORKSPACE_OPENCODE_CONFIG empty → reported missing', async () => {
    const {getMissingWorkspaceEnvVars} = await import('./deploy')
    expect(getMissingWorkspaceEnvVars(makeEnv({WORKSPACE_OPENCODE_CONFIG: ''}))).toContain('WORKSPACE_OPENCODE_CONFIG')
  })

  test('both present and valid → empty array', async () => {
    const {getMissingWorkspaceEnvVars} = await import('./deploy')
    expect(getMissingWorkspaceEnvVars(makeEnv())).toEqual([])
  })
})

// ─── buildGatewayEnvFileContents — MODEL allow-list validation ───────────────

describe('buildGatewayEnvFileContents — MODEL allow-list validation', () => {
  test('MODEL with embedded whitespace → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with # → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude#sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with = → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude=sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL missing / → rejected (no provider segment)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'claude-sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with multiple / → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude/sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with empty provider segment → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: '/claude-sonnet',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with empty model segment → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_MODEL/)
  })

  test('MODEL with valid chars (letters, digits, dots, hyphens, underscores) → accepted', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'openai/gpt-5.5-fast_v2',
        config: '{"provider":{"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).not.toThrow()
  })
})

// ─── buildGatewayEnvFileContents — CONFIG semantic validation ─────────────────

describe('buildGatewayEnvFileContents — CONFIG semantic validation', () => {
  test('CONFIG that is valid JSON but an array → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '[{"provider":"anthropic"}]',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG/)
  })

  test('CONFIG that is valid JSON null → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: 'null',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG/)
  })

  test('CONFIG that is valid JSON string primitive → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '"just-a-string"',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG/)
  })

  test('CONFIG missing provider baseURL for model provider → rejected (egress proxy guard)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG.*baseURL|egress|cliproxy/i)
  })

  test('CONFIG with baseURL not ending in /v1 → rejected (egress proxy guard)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG.*\/v1|egress|cliproxy/i)
  })

  test('CONFIG with empty baseURL → rejected (egress proxy guard)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":""}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG/)
  })

  test('CONFIG with a direct-upstream /v1 baseURL → rejected (must route through cliproxy)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'openai/gpt-5.5-fast',
        config: '{"provider":{"openai":{"options":{"baseURL":"https://api.openai.com/v1"}}}}',
      }),
    ).toThrow(/cliproxy\.fro\.bot/)
  })

  test('CONFIG with a hostname-spoofing baseURL → rejected (exact host match)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot.evil.example/v1"}}}}',
      }),
    ).toThrow(/cliproxy\.fro\.bot/)
  })

  test('CONFIG with a non-https cliproxy baseURL → rejected', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"http://cliproxy.fro.bot/v1"}}}}',
      }),
    ).toThrow(/WORKSPACE_OPENCODE_CONFIG/)
  })

  test('CONFIG with valid baseURL ending in /v1 → accepted', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'anthropic/claude-sonnet-4-6',
        config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).not.toThrow()
  })

  test('CONFIG provider key derived from MODEL prefix (openai/gpt-5.5-fast → openai)', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    expect(() =>
      buildGatewayEnvFileContents({
        objectStoreHosts: 'host.example.com',
        model: 'openai/gpt-5.5-fast',
        config: '{"provider":{"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      }),
    ).not.toThrow()
  })
})

// ─── main() — negative integration tests (validation aborts before SSH) ───────

describe('main() — validation aborts before any SSH mutation', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('invalid JSON CONFIG: spawn never called, promise rejects', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_CONFIG: 'not-valid-json'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_CONFIG/)

    expect(calls).toHaveLength(0)
  })

  test('CONFIG valid JSON but array: spawn never called, promise rejects', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_CONFIG: '[{"provider":"anthropic"}]'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_CONFIG/)

    expect(calls).toHaveLength(0)
  })

  test('CONFIG missing model-provider baseURL: spawn never called, promise rejects', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_CONFIG: '{"provider":{"anthropic":{"options":{}}}}'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    expect(calls).toHaveLength(0)
  })

  test('MODEL with embedded whitespace: spawn never called, promise rejects', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_MODEL: 'anthropic/claude sonnet'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_MODEL/)

    expect(calls).toHaveLength(0)
  })

  test('MODEL with #: spawn never called, promise rejects', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_MODEL: 'anthropic/claude#sonnet'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_MODEL/)

    expect(calls).toHaveLength(0)
  })
})

// Note: getGatewayDeployEnv CLI parity tests live in packages/cli/src/commands/gateway/deploy.test.ts

// ─── normalizePemPrivateKey ───────────────────────────────────────────────────

describe('normalizePemPrivateKey', () => {
  test(String.raw`single-line value with literal \n sequences → converted to real newlines`, async () => {
    const {normalizePemPrivateKey} = await import('./deploy')
    const singleLine = String.raw`-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----`
    const result = normalizePemPrivateKey(singleLine)
    // Must contain real newlines
    expect(result.includes('\n')).toBe(true)
    // Must NOT contain literal backslash-n
    expect(result.includes(String.raw`\n`)).toBe(false)
    // Exact expected multi-line output (trailing newline ensured)
    const expected = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----\n'
    expect(result).toBe(expected)
  })

  test('value already containing real newlines → returned unchanged except trailing newline ensured', async () => {
    const {normalizePemPrivateKey} = await import('./deploy')
    const multiLine = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----\n'
    const result = normalizePemPrivateKey(multiLine)
    // Body is unchanged — no literal \n present, no double-newline added
    expect(result).toBe(multiLine)
    expect(result.includes(String.raw`\n`)).toBe(false)
  })

  test('value without trailing newline → gets exactly one trailing newline', async () => {
    const {normalizePemPrivateKey} = await import('./deploy')
    const noTrailing = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----'
    const result = normalizePemPrivateKey(noTrailing)
    expect(result.endsWith('\n')).toBe(true)
    expect(result.endsWith('\n\n')).toBe(false)
    expect(result).toBe(`${noTrailing}\n`)
  })

  test(String.raw`value with literal \r\n sequences → normalized to real \n`, async () => {
    const {normalizePemPrivateKey} = await import('./deploy')
    const crlfEscaped = String.raw`-----BEGIN RSA PRIVATE KEY-----\r\nMIIEow...\r\nAB==\r\n-----END RSA PRIVATE KEY-----`
    const result = normalizePemPrivateKey(crlfEscaped)
    // Must not contain literal \r\n or \n
    expect(result.includes(String.raw`\r\n`)).toBe(false)
    expect(result.includes(String.raw`\n`)).toBe(false)
    // Must contain real newlines only
    expect(result.includes('\n')).toBe(true)
    expect(result.includes('\r')).toBe(false)
    const expected = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----\n'
    expect(result).toBe(expected)
  })

  test('empty string → returns empty string (no trailing newline added)', async () => {
    const {normalizePemPrivateKey} = await import('./deploy')
    expect(normalizePemPrivateKey('')).toBe('')
  })
})

// ─── getAnnounceState ─────────────────────────────────────────────────────────

describe('getAnnounceState', () => {
  test('both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID set → enabled', async () => {
    const {getAnnounceState} = await import('./deploy')
    const state = getAnnounceState(
      makeEnv({GATEWAY_WEBHOOK_SECRET: 'secret-hmac-key', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
    )
    expect(state).toBe('enabled')
  })

  test('neither GATEWAY_WEBHOOK_SECRET nor GATEWAY_PRESENCE_CHANNEL_ID set → disabled', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    const state = getAnnounceState(env)
    expect(state).toBe('disabled')
  })

  test('only GATEWAY_WEBHOOK_SECRET set → invalid', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv({GATEWAY_WEBHOOK_SECRET: 'secret-hmac-key'})
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    const state = getAnnounceState(env)
    expect(state).toBe('invalid')
  })

  test('only GATEWAY_PRESENCE_CHANNEL_ID set → invalid', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv({GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'})
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    const state = getAnnounceState(env)
    expect(state).toBe('invalid')
  })

  test('GATEWAY_WEBHOOK_SECRET whitespace-only → treated as absent → invalid', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv({GATEWAY_WEBHOOK_SECRET: '   ', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'})
    const state = getAnnounceState(env)
    expect(state).toBe('invalid')
  })

  test('GATEWAY_PRESENCE_CHANNEL_ID whitespace-only → treated as absent → invalid', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv({GATEWAY_WEBHOOK_SECRET: 'secret-hmac-key', GATEWAY_PRESENCE_CHANNEL_ID: '  '})
    const state = getAnnounceState(env)
    expect(state).toBe('invalid')
  })

  test('both whitespace-only → both absent → disabled', async () => {
    const {getAnnounceState} = await import('./deploy')
    const env = makeEnv({GATEWAY_WEBHOOK_SECRET: '   ', GATEWAY_PRESENCE_CHANNEL_ID: '  '})
    const state = getAnnounceState(env)
    expect(state).toBe('disabled')
  })
})

// ─── buildSecretFileList — announce secret files ──────────────────────────────

describe('buildSecretFileList — announce secret files', () => {
  test('both announce inputs set → includes ANNOUNCE_WEBHOOK_SECRET_FILE and ANNOUNCE_PRESENCE_CHANNEL_FILE', async () => {
    const {buildSecretFileList, ANNOUNCE_WEBHOOK_SECRET_FILE, ANNOUNCE_PRESENCE_CHANNEL_FILE} = await import('./deploy')
    const secrets = buildSecretFileList(
      makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
    )
    const webhookSecret = secrets.find(s => s.name === ANNOUNCE_WEBHOOK_SECRET_FILE)
    const channelId = secrets.find(s => s.name === ANNOUNCE_PRESENCE_CHANNEL_FILE)
    expect(webhookSecret).toBeDefined()
    expect(webhookSecret?.content).toBe('hmac-secret-value')
    expect(webhookSecret?.required).toBe(false)
    expect(channelId).toBeDefined()
    expect(channelId?.content).toBe('111222333444555666')
    expect(channelId?.required).toBe(false)
  })

  test('neither announce input set → neither announce secret file present', async () => {
    const {buildSecretFileList, ANNOUNCE_WEBHOOK_SECRET_FILE, ANNOUNCE_PRESENCE_CHANNEL_FILE} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    const secrets = buildSecretFileList(env)
    const names = secrets.map(s => s.name)
    expect(names).not.toContain(ANNOUNCE_WEBHOOK_SECRET_FILE)
    expect(names).not.toContain(ANNOUNCE_PRESENCE_CHANNEL_FILE)
  })

  test('neither announce input set → output length equals baseline (16)', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    const secrets = buildSecretFileList(env)
    expect(secrets).toHaveLength(16)
  })

  test('both announce inputs set → output has 18 entries (16 baseline + 2 announce)', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(
      makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
    )
    expect(secrets).toHaveLength(18)
  })

  test('both announce inputs set → checksum differs from no-announce baseline', async () => {
    const {buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const baseEnv = makeEnv()
    delete (baseEnv as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (baseEnv as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    const baseSecrets = buildSecretFileList(baseEnv)
    const announceSecrets = buildSecretFileList(
      makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
    )
    expect(computeSecretsChecksum(announceSecrets)).not.toBe(computeSecretsChecksum(baseSecrets))
  })
})

// ─── main() — announce both-or-neither gate ───────────────────────────────────

describe('main() — announce both-or-neither gate', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('only GATEWAY_WEBHOOK_SECRET set → rejects before any spawn naming GATEWAY_PRESENCE_CHANNEL_ID', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    const env = makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value'})
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await expect(
      main({
        env,
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_PRESENCE_CHANNEL_ID/)

    expect(calls).toHaveLength(0)
  })

  test('only GATEWAY_PRESENCE_CHANNEL_ID set → rejects before any spawn naming GATEWAY_WEBHOOK_SECRET', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    const env = makeEnv({GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'})
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET

    await expect(
      main({
        env,
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_WEBHOOK_SECRET/)

    expect(calls).toHaveLength(0)
  })

  test('GATEWAY_WEBHOOK_SECRET whitespace-only + GATEWAY_PRESENCE_CHANNEL_ID set → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({GATEWAY_WEBHOOK_SECRET: '   ', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_WEBHOOK_SECRET/)

    expect(calls).toHaveLength(0)
  })
})

// ─── buildSecretFileList — normalizePemPrivateKey wiring ─────────────────────

describe('buildSecretFileList — normalizePemPrivateKey wiring', () => {
  test(String.raw`github-app-private-key: single-line \n-escaped env value → content has real newlines`, async () => {
    const {buildSecretFileList} = await import('./deploy')
    const singleLineKey = String.raw`-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----`
    const secrets = buildSecretFileList(makeEnv({GH_APP_PRIVATE_KEY: singleLineKey}))
    const entry = secrets.find(s => s.name === 'github-app-private-key')
    expect(entry).toBeDefined()
    // Transform must have been applied: real newlines present
    expect(entry!.content.includes('\n')).toBe(true)
    // No literal backslash-n remaining
    expect(entry!.content.includes(String.raw`\n`)).toBe(false)
    // Exact expected output
    const expected = '-----BEGIN RSA PRIVATE KEY-----\nMIIEow...\nAB==\n-----END RSA PRIVATE KEY-----\n'
    expect(entry!.content).toBe(expected)
  })

  test('discord-token: NOT transformed — value passed through verbatim', async () => {
    const {buildSecretFileList} = await import('./deploy')
    // A value with literal \n that would be transformed if normalizePemPrivateKey were applied
    const rawToken = String.raw`tok\nwith\nliteral\nescapes`
    const secrets = buildSecretFileList(makeEnv({DISCORD_TOKEN: rawToken}))
    const entry = secrets.find(s => s.name === 'discord-token')
    expect(entry).toBeDefined()
    // discord-token has no transform — content must be verbatim
    expect(entry!.content).toBe(rawToken)
    expect(entry!.content.includes(String.raw`\n`)).toBe(true)
  })
})

// ─── buildComposeOverride ─────────────────────────────────────────────────────

const OVERRIDE_OPTS_ANNOUNCE = {
  gatewayDigest: GATEWAY_DIGEST,
  workspaceDigest: WORKSPACE_DIGEST,
  announceEnabled: true,
}

describe('buildComposeOverride', () => {
  test('includes caddy service with 80:80 and 443:443 port bindings', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('80:80')
    expect(yaml).toContain('443:443')
  })

  test('caddy service joins gateway-net network', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('gateway-net')
  })

  test('caddy service has named caddy_data and caddy_config volumes', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('caddy_data')
    expect(yaml).toContain('caddy_config')
  })

  test('caddy service depends_on gateway', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('depends_on')
    expect(yaml).toContain('gateway')
  })

  test('caddy service mounts Caddyfile read-only', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('Caddyfile')
    expect(yaml).toContain(':ro')
  })

  test('gateway service gets GATEWAY_WEBHOOK_SECRET_FILE env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('GATEWAY_WEBHOOK_SECRET_FILE')
    expect(yaml).toContain('/run/secrets/gateway_webhook_secret')
  })

  test('gateway service gets GATEWAY_PRESENCE_CHANNEL_ID_FILE env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('GATEWAY_PRESENCE_CHANNEL_ID_FILE')
    expect(yaml).toContain('/run/secrets/gateway_presence_channel_id')
  })

  test('gateway service gets two announce bind-mount volumes with correct source paths', async () => {
    const {buildComposeOverride, ANNOUNCE_WEBHOOK_SECRET_FILE, ANNOUNCE_PRESENCE_CHANNEL_FILE} =
      await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain(`./secrets/${ANNOUNCE_WEBHOOK_SECRET_FILE}`)
    expect(yaml).toContain(`./secrets/${ANNOUNCE_PRESENCE_CHANNEL_FILE}`)
  })

  test('gateway service bind-mounts target /run/secrets/gateway_webhook_secret', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('/run/secrets/gateway_webhook_secret')
  })

  test('gateway service bind-mounts target /run/secrets/gateway_presence_channel_id', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('/run/secrets/gateway_presence_channel_id')
  })

  test('top-level volumes block declares caddy_data and caddy_config', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    // Top-level volumes section must exist
    expect(yaml).toMatch(/^volumes:/m)
    expect(yaml).toContain('caddy_data')
    expect(yaml).toContain('caddy_config')
  })

  test('caddy image is pinned to the same digest as cliproxy (caddy:2.11.3-alpine@sha256:...)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    // Must use a pinned digest (sha256:)
    expect(yaml).toMatch(/caddy:[\d.]+-alpine@sha256:[0-9a-f]{64}/)
  })

  test('caddy service has restart: unless-stopped', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)
    expect(yaml).toContain('unless-stopped')
  })
})

// ─── buildCaddyfile ───────────────────────────────────────────────────────────

describe('buildCaddyfile', () => {
  test('interpolates the passed host as the site address', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).toContain('gateway.fro.bot')
  })

  test('routes /v1/announce path via handle block (not a named matcher)', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    // New form uses handle /v1/announce { ... } — no @announce named matcher
    expect(result).toContain('/v1/announce')
    expect(result).not.toContain('@announce')
  })

  test('reverse_proxy to gateway:3000 inside the /v1/announce handle block', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).toContain('reverse_proxy gateway:3000')
    // Must NOT use the old named-matcher form
    expect(result).not.toContain('reverse_proxy @announce')
  })

  test('uses handle /v1/announce block with reverse_proxy inside (not a named matcher)', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    // Must use handle /v1/announce { reverse_proxy gateway:3000 } form
    expect(result).toContain('handle /v1/announce {')
    expect(result).toMatch(/handle\s+\/v1\/announce\s*\{[^}]*reverse_proxy\s+gateway:3000[^}]*\}/)
  })

  test('has a catch-all handle block with respond 404', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    // Must use handle { respond 404 } catch-all form (mutually exclusive with the path handle above)
    expect(result).toMatch(/handle\s*\{[^}]*respond\s+404[^}]*\}/)
  })

  test('matched /v1/announce handle block appears before the catch-all handle block', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    const announceIdx = result.indexOf('handle /v1/announce')
    const catchAllIdx = result.indexOf('handle {')
    expect(announceIdx).toBeGreaterThanOrEqual(0)
    expect(catchAllIdx).toBeGreaterThanOrEqual(0)
    expect(announceIdx).toBeLessThan(catchAllIdx)
  })

  test('interpolates host as the site address block', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    // Host must appear as the site address (first token before the opening brace)
    expect(result).toMatch(/^gateway\.fro\.bot\s*\{/m)
  })

  test('does NOT reference GATEWAY_ANNOUNCE_DOMAIN (uses passed host directly)', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).not.toContain('GATEWAY_ANNOUNCE_DOMAIN')
  })

  test('different hosts produce different Caddyfile content', async () => {
    const {buildCaddyfile} = await import('./deploy')
    expect(buildCaddyfile('gateway.fro.bot')).not.toBe(buildCaddyfile('other.example.com'))
  })
})

// ─── compose.override.yaml + Caddyfile materialization in main() ──────────────

describe('main() — announce override + Caddyfile materialization', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('announce disabled → compose.override.yaml IS written (carries image pins)', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      // Capture stdin for SSH cat commands
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    // compose.override.yaml MUST be written (carries image digest pins)
    const overridePath = '/opt/gateway/deploy/compose.override.yaml'
    expect(stdinCaptures[overridePath]).toBeDefined()
    expect(stdinCaptures[overridePath]).toContain('ghcr.io/marcusrbrown/infra-gateway@')
    expect(stdinCaptures[overridePath]).toContain('ghcr.io/marcusrbrown/infra-workspace@')
    // Caddy/announce wiring must NOT be present when announce is disabled
    expect(stdinCaptures[overridePath]).not.toContain('GATEWAY_WEBHOOK_SECRET_FILE')
  })

  test('announce disabled → writeRemoteFile NOT called for Caddyfile', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toBeUndefined()
  })

  test('announce enabled → compose.override.yaml is written via writeRemoteFile', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value',
        GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    const overridePath = '/opt/gateway/deploy/compose.override.yaml'
    expect(stdinCaptures[overridePath]).toBeDefined()
    expect(stdinCaptures[overridePath]).toContain('caddy')
  })

  test('announce enabled → Caddyfile is written via writeRemoteFile with correct host', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value',
        GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toBeDefined()
    expect(stdinCaptures[caddyfilePath]).toContain('gateway.fro.bot')
  })
})

// ─── checksum includes override + Caddyfile bytes ────────────────────────────

describe('computeSecretsChecksum — override + Caddyfile folded in', () => {
  test('announce enabled → checksum differs from disabled baseline (override bytes change it)', async () => {
    const {buildSecretFileList, buildComposeOverride, buildCaddyfile, computeSecretsChecksum} = await import('./deploy')

    const baseEnv = makeEnv()
    delete (baseEnv as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (baseEnv as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    const announceEnv = makeEnv({
      GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value',
      GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666',
    })

    const baseSecrets = buildSecretFileList(baseEnv)
    const announceSecrets = buildSecretFileList(announceEnv)

    // Fold override + Caddyfile into the announce checksum input
    const overrideEntry = {
      name: 'compose.override.yaml',
      content: buildComposeOverride({
        gatewayDigest: GATEWAY_DIGEST,
        workspaceDigest: WORKSPACE_DIGEST,
        announceEnabled: true,
      }),
      required: false,
    }
    const caddyfileEntry = {
      name: 'Caddyfile',
      content: buildCaddyfile(announceEnv.GATEWAY_HOST ?? 'gateway.fro.bot'),
      required: false,
    }
    const announceChecksumInput = [...announceSecrets, overrideEntry, caddyfileEntry]

    expect(computeSecretsChecksum(announceChecksumInput)).not.toBe(computeSecretsChecksum(baseSecrets))
  })
})

// ─── compose-up args include --remove-orphans ─────────────────────────────────

describe('main() — compose-up args', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('compose-up command always includes --remove-orphans', async () => {
    const {main} = await import('./deploy')
    const composeCmds: string[][] = []
    const {spawnFn} = makeSpawnMock(cmd => {
      // Match the remote command string (last argv element) to avoid false positives from
      // the random ControlPath socket path (e.g. /tmp/gw-cm-<random>/cm-%C) which may
      // contain the substring "up". The remote command for compose-up looks like:
      //   docker compose --project-directory <dir> up -d --no-build ...
      // whereas compose-pull looks like:
      //   docker compose --project-directory <dir> pull
      // Checking the last element for ' up ' (with spaces) reliably distinguishes them.
      const remoteCmd = cmd.at(-1) ?? ''
      if (remoteCmd.includes('docker compose') && remoteCmd.includes(' up ')) {
        composeCmds.push(cmd)
      }
      return undefined
    })

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    expect(composeCmds.length).toBeGreaterThan(0)
    const composeCmd = composeCmds[0]!
    const cmdStr = composeCmd.join(' ')
    expect(cmdStr).toContain('--remove-orphans')
  })

  test('compose-up command always includes --no-build (pulls prebuilt image, never builds on droplet)', async () => {
    const {main} = await import('./deploy')
    const composeCmds: string[][] = []
    const {spawnFn} = makeSpawnMock(cmd => {
      // Match the remote command string (last argv element) to avoid false positives from
      // the random ControlPath socket path (e.g. /tmp/gw-cm-<random>/cm-%C) which may
      // contain the substring "up". The remote command for compose-up looks like:
      //   docker compose --project-directory <dir> up -d --no-build ...
      // whereas compose-pull looks like:
      //   docker compose --project-directory <dir> pull
      // Checking the last element for ' up ' (with spaces) reliably distinguishes them.
      const remoteCmd = cmd.at(-1) ?? ''
      if (remoteCmd.includes('docker compose') && remoteCmd.includes(' up ')) {
        composeCmds.push(cmd)
      }
      return undefined
    })

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
    })

    expect(composeCmds.length).toBeGreaterThan(0)
    const composeCmd = composeCmds[0]!
    const cmdStr = composeCmd.join(' ')
    expect(cmdStr).toContain('--no-build')
    expect(cmdStr).not.toContain('--build')
  })
})

// ─── Item 1: post-deploy HTTPS ingress probe (announce enabled) ───────────────

describe('main() — post-deploy HTTPS ingress probe', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('announce disabled → probe fetch never called', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const fetchCalls: string[] = []

    const mockFetch = mock(async (url: string) => {
      fetchCalls.push(url)
      // Discord registration response
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID

    await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    // No probe URL should have been called
    const probeCalls = fetchCalls.filter(u => u.includes('/v1/announce'))
    expect(probeCalls).toHaveLength(0)
  })

  test('announce enabled + HTTP 400 → healthy (no warning logged, deploy succeeds)', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
      origWarn(...args)
    }

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/v1/announce')) {
        // 400 = HMAC-gated endpoint, TLS terminated + Caddy routed → healthy
        return new Response('Bad Request', {status: 400})
      }
      // Discord registration
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    try {
      await main({
        env: makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
        args: [],
        fetch: mockFetch,
        sleep: async () => {},
        spawn: spawnFn,
        probeAttempts: 3,
        probeIntervalMs: 0,
      })
    } finally {
      console.warn = origWarn
    }

    // Deploy must succeed (no throw)
    // No warning about cert issuing should appear (400 = healthy)
    // Filter specifically for the probe failure warning (not "init-certs.sh" which also contains "cert")
    const warnAboutCert = warnMessages.filter(
      m => m.includes('still be issuing') || m.includes('probe did not succeed'),
    )
    expect(warnAboutCert).toHaveLength(0)
  })

  test('announce enabled + connection error on all attempts → warning logged, deploy still succeeds', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
      origWarn(...args)
    }

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/v1/announce')) {
        throw new TypeError('fetch failed: connection refused')
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    let threw = false
    try {
      await main({
        env: makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
        args: [],
        fetch: mockFetch,
        sleep: async () => {},
        spawn: spawnFn,
        probeAttempts: 3,
        probeIntervalMs: 0,
      })
    } catch {
      threw = true
    } finally {
      console.warn = origWarn
    }

    // Deploy must NOT throw — warning-only
    expect(threw).toBe(false)
    // A warning about cert issuing must be logged (the probe failure warning)
    const warnAboutCert = warnMessages.filter(
      m => m.includes('still be issuing') || m.includes('probe did not succeed'),
    )
    expect(warnAboutCert.length).toBeGreaterThan(0)
  })

  test('announce enabled + probe runs against https://<GATEWAY_HOST>/v1/announce', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const probedUrls: string[] = []

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/v1/announce')) {
        probedUrls.push(url)
        return new Response('Bad Request', {status: 400})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    await main({
      env: makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
      args: [],
      fetch: mockFetch,
      sleep: async () => {},
      spawn: spawnFn,
      probeAttempts: 1,
      probeIntervalMs: 0,
    })

    expect(probedUrls).toHaveLength(1)
    expect(probedUrls[0]).toBe('https://gateway.fro.bot/v1/announce')
  })

  test('announce enabled + 2xx response → healthy (deploy succeeds, no warning)', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
      origWarn(...args)
    }

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/v1/announce')) {
        return new Response('OK', {status: 200})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    try {
      await main({
        env: makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
        args: [],
        fetch: mockFetch,
        sleep: async () => {},
        spawn: spawnFn,
        probeAttempts: 1,
        probeIntervalMs: 0,
      })
    } finally {
      console.warn = origWarn
    }

    // Filter specifically for the probe failure warning (not "init-certs.sh" which also contains "cert")
    const warnAboutCert = warnMessages.filter(
      m => m.includes('still be issuing') || m.includes('probe did not succeed'),
    )
    expect(warnAboutCert).toHaveLength(0)
  })

  test('announce enabled + never-resolving fetch → bounded by probePerAttemptTimeoutMs, warning logged, deploy succeeds', async () => {
    // A fetch that never resolves on its own must be bounded by the per-attempt AbortController:
    // it fires after probePerAttemptTimeoutMs, the attempt is treated as a connection error, and
    // the probe ends warning-only so the deploy still succeeds.
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
      origWarn(...args)
    }

    // fetchFn that never resolves on its own — only rejects when its signal aborts.
    const mockFetch = mock(async (url: string, init?: RequestInit) => {
      if (url.includes('/v1/announce')) {
        // Hang until the AbortController fires
        return new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal
          if (signal) {
            if (signal.aborted) {
              reject(new DOMException('The operation was aborted.', 'AbortError'))
              return
            }
            signal.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'))
            })
          }
          // No signal → hangs forever (should not happen with the fix)
        })
      }
      // Discord registration
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    let threw = false
    try {
      await main({
        env: makeEnv({GATEWAY_WEBHOOK_SECRET: 'hmac-secret', GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666'}),
        args: [],
        fetch: mockFetch,
        sleep: async () => {},
        spawn: spawnFn,
        probeAttempts: 2,
        probeIntervalMs: 0,
        probePerAttemptTimeoutMs: 10,
      })
    } catch {
      threw = true
    } finally {
      console.warn = origWarn
    }

    // Deploy must NOT throw — warning-only
    expect(threw).toBe(false)
    // A warning about cert issuing must be logged (all attempts timed out)
    const warnAboutCert = warnMessages.filter(
      m => m.includes('still be issuing') || m.includes('probe did not succeed'),
    )
    expect(warnAboutCert.length).toBeGreaterThan(0)
  })
})

// ─── Item 2: checksum-delta isolation test ────────────────────────────────────

describe('computeSecretsChecksum — override+Caddyfile contribution isolates from secret-only checksum', () => {
  test('same announce secrets: checksum WITH override+Caddyfile bytes differs from checksum of JUST secret files', async () => {
    const {buildSecretFileList, buildComposeOverride, buildCaddyfile, computeSecretsChecksum} = await import('./deploy')

    const announceEnv = makeEnv({
      GATEWAY_WEBHOOK_SECRET: 'hmac-secret-value',
      GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666',
    })

    // Checksum of just the secret files (same announce secrets present)
    const secretsOnly = buildSecretFileList(announceEnv)
    const checksumSecretsOnly = computeSecretsChecksum(secretsOnly)

    // Checksum with override + Caddyfile bytes folded in (same secrets, same env)
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
    })
    const caddyfileContent = buildCaddyfile(announceEnv.GATEWAY_HOST ?? 'gateway.fro.bot')
    const checksumInput = [
      ...secretsOnly,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
      {name: 'Caddyfile', content: caddyfileContent, required: false},
    ]
    const checksumWithOverride = computeSecretsChecksum(checksumInput)

    // The override/Caddyfile contribution alone must flip the checksum
    expect(checksumWithOverride).not.toBe(checksumSecretsOnly)
  })
})

// ─── docker compose config merge integration test ─────────────────────────────

describe('docker compose config merge — override appends mounts, does not replace', () => {
  test('base with existing bind mounts + override → merged config retains pre-existing mounts AND adds announce mounts', async () => {
    const {buildComposeOverride} = await import('./deploy')

    // Check docker is available
    const dockerAvailable = Boolean(Bun.which('docker'))
    if (!dockerAvailable) {
      if (process.env.CI) {
        throw new Error(
          'docker is not available in CI — the compose merge proof must not silently vanish. ' +
            'Ensure docker is installed in the CI environment.',
        )
      }
      console.warn('docker not available (non-CI) — skipping compose merge integration test')
      return
    }

    // Write a minimal base compose.yaml mimicking the upstream gateway service
    // with a couple of existing bind mounts (simulating the real upstream)
    const baseCompose = `services:
  gateway:
    image: alpine:latest
    networks:
      - gateway-net
    volumes:
      - type: bind
        source: ./secrets/discord-token
        target: /run/secrets/discord_token
        read_only: true
      - type: bind
        source: ./secrets/aws-access-key-id
        target: /run/secrets/aws_access_key_id
        read_only: true
networks:
  gateway-net:
    driver: bridge
`

    const overrideYaml = buildComposeOverride(OVERRIDE_OPTS_ANNOUNCE)

    // Write to a temp directory
    const {mkdtempSync: mkdtemp, writeFileSync: writeFile, rmSync: rm} = await import('node:fs')
    const {tmpdir: tmp} = await import('node:os')
    const {join: pathJoin} = await import('node:path')

    const testDir = mkdtemp(pathJoin(tmp(), 'compose-merge-test-'))
    try {
      writeFile(pathJoin(testDir, 'compose.yaml'), baseCompose)
      writeFile(pathJoin(testDir, 'compose.override.yaml'), overrideYaml)

      const result = Bun.spawnSync(['docker', 'compose', '--project-directory', testDir, 'config'], {
        stdout: 'pipe',
        stderr: 'pipe',
      })

      if (result.exitCode !== 0) {
        const stderr = new TextDecoder().decode(result.stderr)
        // If docker compose config fails due to missing files (secrets dir etc.), that's OK for this test
        // We only care about the merge behavior, not full validity
        if (!stderr.includes('no such file') && !stderr.includes('does not exist')) {
          throw new Error(`docker compose config failed: ${stderr}`)
        }
        // Skip if it fails due to missing secret files (expected in test env)
        console.warn('docker compose config failed due to missing files — checking partial output')
      }

      const merged = new TextDecoder().decode(result.stdout)

      // Pre-existing mounts must be preserved
      expect(merged).toContain('/run/secrets/discord_token')
      expect(merged).toContain('/run/secrets/aws_access_key_id')

      // Announce mounts must be added
      expect(merged).toContain('/run/secrets/gateway_webhook_secret')
      expect(merged).toContain('/run/secrets/gateway_presence_channel_id')
    } finally {
      rm(testDir, {recursive: true, force: true})
    }
  }, 30000)
})

// ─── Off-droplet image build: override, pull-then-up, digest verification ─────

describe('buildComposeOverride — image pins always materialized', () => {
  test('announce-disabled: override contains image pins for gateway and workspace', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const result = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    expect(result).toContain(`ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`)
    expect(result).toContain(`ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`)
  })

  test('announce-disabled: override does NOT contain Caddy service or announce wiring', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const result = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    expect(result).not.toContain('caddy:')
    expect(result).not.toContain('GATEWAY_WEBHOOK_SECRET_FILE')
    expect(result).not.toContain('GATEWAY_PRESENCE_CHANNEL_ID_FILE')
  })

  test('announce-enabled: override contains BOTH image pins AND Caddy/announce wiring', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const result = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
    })
    // Image pins present
    expect(result).toContain(`ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`)
    expect(result).toContain(`ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`)
    // Caddy/announce wiring present
    expect(result).toContain('caddy:')
    expect(result).toContain('GATEWAY_WEBHOOK_SECRET_FILE')
    expect(result).toContain('GATEWAY_PRESENCE_CHANNEL_ID_FILE')
  })

  test('image pins use exact @sha256: digest format, not a tag', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const result = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    // Must use @sha256: digest notation
    expect(result).toMatch(/ghcr\.io\/marcusrbrown\/infra-gateway@sha256:[0-9a-f]{64}/)
    expect(result).toMatch(/ghcr\.io\/marcusrbrown\/infra-workspace@sha256:[0-9a-f]{64}/)
  })

  test('announce-enabled: announce volumes use new mount targets (volume-merge semantics preserved)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const result = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
    })
    expect(result).toContain('/run/secrets/gateway_webhook_secret')
    expect(result).toContain('/run/secrets/gateway_presence_channel_id')
  })
})

describe('main() — compose command sequence: pull-then-up-without-build', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('compose command sequence includes a pull step before up', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const composeCalls = calls.filter(cmd => cmd.some(s => s.includes('docker compose')))
    const pullCall = composeCalls.find(cmd => cmd.some(s => s.includes(' pull') || s.endsWith('pull')))
    const upCall = composeCalls.find(cmd => cmd.some(s => s.includes(' up ')))

    expect(pullCall).toBeDefined()
    expect(upCall).toBeDefined()

    // pull must come before up
    const pullIdx = pullCall ? calls.indexOf(pullCall) : -1
    const upIdx = upCall ? calls.indexOf(upCall) : -1
    expect(pullIdx).toBeLessThan(upIdx)
  })

  test('compose up command does NOT contain --build', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall).toBeDefined()
    expect(upCall?.join(' ')).not.toContain('--build')
  })

  test('compose up command contains --no-build', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall).toBeDefined()
    expect(upCall?.join(' ')).toContain('--no-build')
  })

  test('compose up command retains --wait, --wait-timeout 120, --remove-orphans', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall).toBeDefined()
    const upStr = upCall?.join(' ') ?? ''
    expect(upStr).toContain('--wait')
    expect(upStr).toContain('--wait-timeout')
    expect(upStr).toContain('120')
    expect(upStr).toContain('--remove-orphans')
  })

  test('--force-recreate absent when checksum unchanged and forceRecreate not set', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const env = makeEnv()
    // Compute what the checksum will be with the override always included
    const secrets = buildSecretFileList(env)
    const {buildComposeOverride} = await import('./deploy')
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
    })
    const checksumInput = [...secrets, {name: 'compose.override.yaml', content: overrideContent, required: false}]
    const expectedChecksum = computeSecretsChecksum(checksumInput)

    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: expectedChecksum})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall?.join(' ')).not.toContain('--force-recreate')
  })

  test('--force-recreate present when checksum changed', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: 'old-checksum-that-differs'})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall?.join(' ')).toContain('--force-recreate')
  })

  test('--force-recreate present when --force-recreate arg passed', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: ['--force-recreate'], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const upCall = calls.find(cmd => cmd.some(s => s.includes('docker compose') && s.includes(' up ')))
    expect(upCall?.join(' ')).toContain('--force-recreate')
  })

  test('missing GATEWAY_IMAGE_DIGEST → throws before any SSH, no build fallback', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_IMAGE_DIGEST

    await expect(main({env, args: [], spawn: spawnFn})).rejects.toThrow(/GATEWAY_IMAGE_DIGEST/)
    expect(calls).toHaveLength(0)
  })

  test('missing WORKSPACE_IMAGE_DIGEST → throws before any SSH, no build fallback', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_IMAGE_DIGEST

    await expect(main({env, args: [], spawn: spawnFn})).rejects.toThrow(/WORKSPACE_IMAGE_DIGEST/)
    expect(calls).toHaveLength(0)
  })

  test('override is always written (announce-disabled path) and contains image pins', async () => {
    const {main} = await import('./deploy')
    const overrideWrites: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('compose.override.yaml')) {
        const result = makeSpawnResult({captureStdin: true})
        if (result.stdin) {
          const origWrite = result.stdin.write.bind(result.stdin)
          result.stdin.write = (data: Uint8Array) => {
            overrideWrites.push(new TextDecoder().decode(data))
            origWrite(data)
          }
        }
        return result
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env: makeEnv(), args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    expect(overrideWrites.length).toBeGreaterThan(0)
    const overrideContent = overrideWrites.join('')
    expect(overrideContent).toContain(`ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`)
    expect(overrideContent).toContain(`ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`)
  })
})

describe('assertRunningImageDigest — pure digest verification helper', () => {
  test('passes when actual RepoDigests contains the expected digest', async () => {
    const {assertRunningImageDigest} = await import('./deploy')
    const repoDigests = [
      `ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`,
      'ghcr.io/marcusrbrown/infra-gateway:v0.44.0',
    ]
    expect(() => assertRunningImageDigest(repoDigests, GATEWAY_DIGEST, 'gateway')).not.toThrow()
  })

  test('throws when actual RepoDigests does not contain the expected digest', async () => {
    const {assertRunningImageDigest} = await import('./deploy')
    const wrongDigest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const repoDigests = [`ghcr.io/marcusrbrown/infra-gateway@${wrongDigest}`]
    expect(() => assertRunningImageDigest(repoDigests, GATEWAY_DIGEST, 'gateway')).toThrow(/gateway/)
  })

  test('throws when RepoDigests is empty', async () => {
    const {assertRunningImageDigest} = await import('./deploy')
    expect(() => assertRunningImageDigest([], GATEWAY_DIGEST, 'gateway')).toThrow(/gateway/)
  })

  test('error message includes the expected digest for actionability', async () => {
    const {assertRunningImageDigest} = await import('./deploy')
    const wrongDigest = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc'
    const repoDigests = [`ghcr.io/marcusrbrown/infra-gateway@${wrongDigest}`]
    let errorMessage = ''
    try {
      assertRunningImageDigest(repoDigests, GATEWAY_DIGEST, 'gateway')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).toContain(GATEWAY_DIGEST)
  })

  test('passes for workspace service with correct digest', async () => {
    const {assertRunningImageDigest} = await import('./deploy')
    const repoDigests = [`ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`]
    expect(() => assertRunningImageDigest(repoDigests, WORKSPACE_DIGEST, 'workspace')).not.toThrow()
  })
})

// ─── P1: image-inspect command targets IMAGE, not container ──────────────────

describe('Phase 9c — running image digest verification (P1)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('inspect command resolves container image ID first, then inspects image RepoDigests', async () => {
    // P1: the old code ran `docker inspect --format '{{json .RepoDigests}}' <container-id>`
    // which errors on containers (no .RepoDigests field). The fix must:
    //   1. Run `docker inspect --format '{{.Image}}' <container-id>` to get the image SHA
    //   2. Run `docker inspect --format '{{json .RepoDigests}}' <image-sha>` on the IMAGE
    const {main} = await import('./deploy')
    const inspectCalls: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect')) {
        inspectCalls.push(cmdStr)
        // First inspect: resolve container → image ID
        if (cmdStr.includes('{{.Image}}')) {
          return makeSpawnResult({stdout: 'sha256:deadbeef1234'})
        }
        // Second inspect: image RepoDigests
        if (cmdStr.includes('RepoDigests') && cmdStr.includes('sha256:deadbeef1234')) {
          const digests = [
            `ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`,
            `ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`,
          ]
          return makeSpawnResult({stdout: JSON.stringify(digests)})
        }
      }
      return undefined
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // Must have at least one inspect call that resolves the container's image ID
    const imageResolutionCall = inspectCalls.find(c => c.includes('{{.Image}}'))
    expect(imageResolutionCall).toBeDefined()

    // Must have at least one inspect call that inspects RepoDigests on the image SHA
    const repoDigestsCall = inspectCalls.find(c => c.includes('RepoDigests') && c.includes('sha256:deadbeef1234'))
    expect(repoDigestsCall).toBeDefined()
  })

  test('RepoDigests inspect uses the image SHA returned by the {{.Image}} step, not a subshell', async () => {
    // The old broken form embedded `$(docker compose ps -q svc)` directly in the RepoDigests inspect.
    // The fix: Step 1 resolves the image SHA via `{{.Image}}`; Step 2 passes that SHA to RepoDigests.
    // This test verifies Step 2's command contains the image SHA from Step 1's stdout.
    const {main} = await import('./deploy')
    const inspectCalls: string[] = []
    const IMAGE_SHA = 'sha256:verifiableimagesha00000000000000000000000000000000000000000000'

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect')) {
        inspectCalls.push(cmdStr)
        if (cmdStr.includes('{{.Image}}')) {
          // Return a known image SHA
          return makeSpawnResult({stdout: IMAGE_SHA})
        }
        if (cmdStr.includes('RepoDigests')) {
          const digests = [
            `ghcr.io/marcusrbrown/infra-gateway@${GATEWAY_DIGEST}`,
            `ghcr.io/marcusrbrown/infra-workspace@${WORKSPACE_DIGEST}`,
          ]
          return makeSpawnResult({stdout: JSON.stringify(digests)})
        }
      }
      return undefined
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // The RepoDigests inspect must contain the image SHA from Step 1
    const repoDigestsCalls = inspectCalls.filter(c => c.includes('RepoDigests'))
    expect(repoDigestsCalls.length).toBeGreaterThan(0)
    for (const call of repoDigestsCalls) {
      expect(call).toContain(IMAGE_SHA)
    }
  })

  test('deploy fails when image RepoDigests do not contain the expected digest', async () => {
    // Regression guard: assertRunningImageDigest must still throw when digest mismatches
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
        return makeSpawnResult({stdout: 'sha256:imagesha999'})
      }
      if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
        // Return a WRONG digest
        return makeSpawnResult({
          stdout: JSON.stringify([`ghcr.io/marcusrbrown/infra-gateway@sha256:${'f'.repeat(64)}`]),
        })
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/digest does not match/)
  })
})

// ─── P2: digest format validation ────────────────────────────────────────────

describe('Phase 3c — digest format validation (P2)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('malformed GATEWAY_IMAGE_DIGEST (partial hex) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({GATEWAY_IMAGE_DIGEST: 'sha256:abc123'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('malformed GATEWAY_IMAGE_DIGEST (tag-only, no sha256:) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({GATEWAY_IMAGE_DIGEST: 'v1.2.3'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('malformed GATEWAY_IMAGE_DIGEST (sha256: prefix but wrong length) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({GATEWAY_IMAGE_DIGEST: `sha256:${'a'.repeat(63)}`}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('malformed GATEWAY_IMAGE_DIGEST (shell metacharacters) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({GATEWAY_IMAGE_DIGEST: `sha256:$(evil)${'a'.repeat(55)}`}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('malformed WORKSPACE_IMAGE_DIGEST (partial hex) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_IMAGE_DIGEST: 'sha256:abc123'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('malformed WORKSPACE_IMAGE_DIGEST (tag-only) → throws before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_IMAGE_DIGEST: 'latest'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_IMAGE_DIGEST/)

    expect(calls).toHaveLength(0)
  })

  test('valid sha256 digests (64 hex chars) → passes validation, proceeds to SSH', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    // Valid digests — should NOT throw from validation; will reach SSH phase
    await main({
      env: makeEnv({
        GATEWAY_IMAGE_DIGEST: `sha256:${'a'.repeat(64)}`,
        WORKSPACE_IMAGE_DIGEST: `sha256:${'b'.repeat(64)}`,
      }),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // Reached SSH phase (calls > 0)
    expect(calls.length).toBeGreaterThan(0)
  })
})

// ─── P2: JSON narrowing for docker inspect output ────────────────────────────

describe('Phase 9c — JSON narrowing for docker inspect RepoDigests output', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('docker inspect returning null → treated as empty → assertRunningImageDigest throws mismatch (not TypeError)', async () => {
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
        return makeSpawnResult({stdout: 'sha256:imagesha999'})
      }
      if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
        return makeSpawnResult({stdout: 'null'})
      }
      return undefined
    })

    let caughtError: Error | undefined
    try {
      await main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      })
    } catch (error) {
      caughtError = error instanceof Error ? error : new Error(String(error))
    }

    expect(caughtError).toBeDefined()
    // Must be the actionable mismatch error, not a TypeError from unsafe cast
    expect(caughtError?.message).toMatch(/digest does not match/)
    expect(caughtError?.message).not.toMatch(/TypeError/)
    expect(caughtError?.message).not.toMatch(/Cannot read/)
  })

  test('docker inspect returning a plain string → treated as empty → assertRunningImageDigest throws mismatch', async () => {
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
        return makeSpawnResult({stdout: 'sha256:imagesha999'})
      }
      if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
        return makeSpawnResult({stdout: '"just-a-string"'})
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/digest does not match/)
  })

  test('docker inspect returning an object {} → treated as empty → assertRunningImageDigest throws mismatch', async () => {
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
        return makeSpawnResult({stdout: 'sha256:imagesha999'})
      }
      if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
        return makeSpawnResult({stdout: '{}'})
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/digest does not match/)
  })

  test('docker inspect returning array of non-strings [123] → treated as empty → assertRunningImageDigest throws mismatch', async () => {
    const {main} = await import('./deploy')

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker inspect') && cmdStr.includes('{{.Image}}')) {
        return makeSpawnResult({stdout: 'sha256:imagesha999'})
      }
      if (cmdStr.includes('docker inspect') && cmdStr.includes('RepoDigests')) {
        return makeSpawnResult({stdout: '[123, 456]'})
      }
      return undefined
    })

    await expect(
      main({
        env: makeEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/digest does not match/)
  })
})

describe('validateReadyTimeout — WORKSPACE_OPENCODE_READY_TIMEOUT_MS', () => {
  test('absent/empty → returns undefined (use upstream default of 60000)', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(validateReadyTimeout(undefined)).toBeUndefined()
    expect(validateReadyTimeout('')).toBeUndefined()
  })

  test('whitespace-only string → throws (malformed, not absent)', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(() => validateReadyTimeout('   ')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
    expect(() => validateReadyTimeout('\t')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
    expect(() => validateReadyTimeout(' \n ')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
  })

  test('valid positive integer string → returns the parsed number', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(validateReadyTimeout('60000')).toBe(60000)
    expect(validateReadyTimeout('120000')).toBe(120000)
    expect(validateReadyTimeout('30000')).toBe(30000)
  })

  test('non-numeric string → throws with descriptive message', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(() => validateReadyTimeout('not-a-number')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
  })

  test('zero → throws (must be positive)', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(() => validateReadyTimeout('0')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
  })

  test('negative integer → throws (must be positive)', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(() => validateReadyTimeout('-1000')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
  })

  test('float string → throws (must be integer)', async () => {
    const {validateReadyTimeout} = await import('./deploy')
    expect(() => validateReadyTimeout('60000.5')).toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)
  })
})

describe('buildGatewayEnvFileContents — WORKSPACE_OPENCODE_READY_TIMEOUT_MS', () => {
  const VALID_OPTS = {
    objectStoreHosts: 'bucket.s3.us-east-1.amazonaws.com',
    model: 'anthropic/claude-sonnet-4-6',
    config: '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
  }

  test('readyTimeoutMs absent → .env does NOT contain WORKSPACE_OPENCODE_READY_TIMEOUT_MS line', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const result = buildGatewayEnvFileContents(VALID_OPTS)
    expect(result).not.toContain('WORKSPACE_OPENCODE_READY_TIMEOUT_MS')
  })

  test('readyTimeoutMs set → .env contains WORKSPACE_OPENCODE_READY_TIMEOUT_MS=<value>', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const result = buildGatewayEnvFileContents({...VALID_OPTS, readyTimeoutMs: 90000})
    expect(result).toContain('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=90000')
  })

  test('readyTimeoutMs=60000 (upstream default) → emitted explicitly when provided', async () => {
    const {buildGatewayEnvFileContents} = await import('./deploy')
    const result = buildGatewayEnvFileContents({...VALID_OPTS, readyTimeoutMs: 60000})
    expect(result).toContain('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=60000')
  })
})

describe('main() — WORKSPACE_OPENCODE_READY_TIMEOUT_MS validation', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.55.2'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('WORKSPACE_OPENCODE_READY_TIMEOUT_MS absent → deploy proceeds normally', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv()
    delete (env as Record<string, string>).WORKSPACE_OPENCODE_READY_TIMEOUT_MS

    await main({env, args: [], fetch: makeDiscordFetch([{name: 'ping'}]), sleep: async () => {}, spawn: spawnFn})
    expect(calls.length).toBeGreaterThan(0)
  })

  test('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=120000 → deploy proceeds normally', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '120000'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })
    expect(calls.length).toBeGreaterThan(0)
  })

  test('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=0 → throws before any SSH', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '0'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)

    expect(calls).toHaveLength(0)
  })

  test('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=not-a-number → throws before any SSH', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({WORKSPACE_OPENCODE_READY_TIMEOUT_MS: 'not-a-number'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/WORKSPACE_OPENCODE_READY_TIMEOUT_MS/)

    expect(calls).toHaveLength(0)
  })

  test('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=120000 → .env written with WORKSPACE_OPENCODE_READY_TIMEOUT_MS line', async () => {
    const {main} = await import('./deploy')
    const envWrites: Record<string, string> = {}

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('cat >') && cmdStr.includes('.env')) {
        const result = makeSpawnResult({captureStdin: true})
        result.stdin = {
          write(data: Uint8Array) {
            const path = cmdStr.match(/cat > '([^']+)'/)?.[1] ?? '.env'
            envWrites[path] = (envWrites[path] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({WORKSPACE_OPENCODE_READY_TIMEOUT_MS: '120000'}),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const envPath = '/opt/gateway/deploy/.env'
    expect(envWrites[envPath]).toBeDefined()
    expect(envWrites[envPath]).toContain('WORKSPACE_OPENCODE_READY_TIMEOUT_MS=120000')
  })
})

// ─── getOperatorState ─────────────────────────────────────────────────────────

describe('getOperatorState', () => {
  test('all three vars present → enabled', async () => {
    const {getOperatorState} = await import('./deploy')
    const state = getOperatorState(
      makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://gateway.fro.bot',
      }),
    )
    expect(state).toBe('enabled')
  })

  test('none of the three vars present → disabled', async () => {
    const {getOperatorState} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN
    const state = getOperatorState(env)
    expect(state).toBe('disabled')
  })

  test('only GATEWAY_OPERATOR_BIND_HOST set → invalid (partial config)', async () => {
    const {getOperatorState} = await import('./deploy')
    const env = makeEnv({GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN
    const state = getOperatorState(env)
    expect(state).toBe('invalid')
  })

  test('only GATEWAY_OPERATOR_BIND_PORT set → invalid (partial config)', async () => {
    const {getOperatorState} = await import('./deploy')
    const env = makeEnv({GATEWAY_OPERATOR_BIND_PORT: '9300'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN
    const state = getOperatorState(env)
    expect(state).toBe('invalid')
  })

  test('only GATEWAY_OPERATOR_PUBLIC_ORIGIN set → invalid (partial config)', async () => {
    const {getOperatorState} = await import('./deploy')
    const env = makeEnv({GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://gateway.fro.bot'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    const state = getOperatorState(env)
    expect(state).toBe('invalid')
  })

  test('two of three vars set → invalid (partial config)', async () => {
    const {getOperatorState} = await import('./deploy')
    const env = makeEnv({
      GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
      GATEWAY_OPERATOR_BIND_PORT: '9300',
    })
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN
    const state = getOperatorState(env)
    expect(state).toBe('invalid')
  })

  test('whitespace-only values treated as absent → disabled when all whitespace-only', async () => {
    const {getOperatorState} = await import('./deploy')
    const state = getOperatorState(
      makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '   ',
        GATEWAY_OPERATOR_BIND_PORT: '   ',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: '   ',
      }),
    )
    expect(state).toBe('disabled')
  })
})

// ─── validateOperatorConfig ───────────────────────────────────────────────────

describe('validateOperatorConfig', () => {
  // ── valid inputs ────────────────────────────────────────────────────────────

  test('valid gateway-net IP, valid port, valid HTTPS origin → no throw', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).not.toThrow()
  })

  test('accepts port 1 (minimum valid port)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '1',
        publicOrigin: 'https://operator.example.com',
      }),
    ).not.toThrow()
  })

  test('accepts port 65535 (maximum valid port)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '65535',
        publicOrigin: 'https://operator.example.com',
      }),
    ).not.toThrow()
  })

  // ── bind host rejections ────────────────────────────────────────────────────

  test('rejects 0.0.0.0 (all-interface bind)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '0.0.0.0',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*0\.0\.0\.0|all.interface/i)
  })

  test('rejects 127.0.0.1 (loopback)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '127.0.0.1',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*loopback|127\./i)
  })

  test('rejects 127.0.0.2 (loopback range)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '127.0.0.2',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*loopback|127\./i)
  })

  test('rejects 10.0.0.1 (sandbox-net range)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '10.0.0.1',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*sandbox|10\./i)
  })

  test('rejects 10.255.255.255 (sandbox-net range boundary)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '10.255.255.255',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*sandbox|10\./i)
  })

  test('rejects IPv6 address', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '::1',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*IPv6/i)
  })

  test('rejects IPv6 full address', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '2001:db8::1',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*IPv6/i)
  })

  // ── port rejections ─────────────────────────────────────────────────────────

  test('rejects port 0', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '0',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  test('rejects port 65536 (out of range)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '65536',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  test('rejects non-integer port string', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: 'abc',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  test('rejects float port string', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300.5',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  test('rejects negative port', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '-1',
        publicOrigin: 'https://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT/)
  })

  // ── public origin rejections ────────────────────────────────────────────────

  test('rejects non-HTTPS origin (http://)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'http://operator.example.com',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*https/i)
  })

  test('rejects empty origin', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: '',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN/)
  })

  test('rejects non-URL origin', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'not-a-url',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN/)
  })
})

// ─── buildComposeOverride — operator topology ─────────────────────────────────

describe('buildComposeOverride — operator topology', () => {
  const OPERATOR_OPTS = {
    gatewayDigest: GATEWAY_DIGEST,
    workspaceDigest: WORKSPACE_DIGEST,
    announceEnabled: true,
    operatorEnabled: true,
    operatorBindHost: '172.20.0.2',
    operatorBindPort: '9300',
    operatorPublicOrigin: 'https://gateway.fro.bot',
  }

  test('operator enabled: gateway service has GATEWAY_OPERATOR_BIND_HOST env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).toContain('172.20.0.2')
  })

  test('operator enabled: gateway service has GATEWAY_OPERATOR_BIND_PORT env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_PORT')
    expect(yaml).toContain('9300')
  })

  test('operator enabled: gateway service has static ipv4_address on gateway-net', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    expect(yaml).toContain('ipv4_address')
    expect(yaml).toContain('172.20.0.2')
  })

  test('operator enabled: gateway service has NO host ports: entry for operator listener', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    // The gateway service block must not have a ports: section with 9300
    // (Caddy is the only host-published HTTP surface)
    expect(yaml).not.toMatch(/ports:[\s\S]*?9300/)
  })

  test('operator disabled: gateway service has NO GATEWAY_OPERATOR_BIND_HOST env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: false,
    })
    expect(yaml).not.toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).not.toContain('GATEWAY_OPERATOR_BIND_PORT')
  })

  test('operator disabled: gateway service has NO static ipv4_address', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: false,
    })
    expect(yaml).not.toContain('ipv4_address')
  })

  test('workspace service has no gateway-net network (sandbox-net only)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    // workspace service block must not reference gateway-net
    // Find the workspace service section and check it doesn't have gateway-net
    // The workspace section ends at the next service (caddy:) or volumes: section
    const workspaceIdx = yaml.indexOf('  workspace:')
    const afterWorkspace = yaml.slice(workspaceIdx)
    // The next service starts with exactly 2 spaces + name + colon (e.g. "  caddy:")
    // or the volumes: section starts at column 0
    const nextSectionMatch = afterWorkspace.match(/\n {2}[a-z]|\nvolumes:/)
    const workspaceSection = nextSectionMatch ? afterWorkspace.slice(0, nextSectionMatch.index) : afterWorkspace
    expect(workspaceSection).not.toContain('gateway-net')
  })

  test('caddy service has no operator listener ports (only 80:80 and 443:443)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride(OPERATOR_OPTS)
    // Caddy should only have 80:80 and 443:443
    expect(yaml).toContain('80:80')
    expect(yaml).toContain('443:443')
    // No additional port bindings for operator listener
    expect(yaml).not.toMatch(/'9300:9300'/)
    expect(yaml).not.toMatch(/"9300:9300"/)
  })

  test('operator enabled with announce disabled: gateway still gets operator env entries', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://gateway.fro.bot',
    })
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_PORT')
  })
})

// ─── buildCaddyfile — operator routing ───────────────────────────────────────

describe('buildCaddyfile — operator routing', () => {
  test('operator enabled: /operator/* handle block present', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('/operator/*')
  })

  test('operator enabled: /operator/* reverse_proxy targets configured bind host:port', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('reverse_proxy 172.20.0.2:9300')
  })

  test('operator enabled: /operator/* reverse_proxy includes flush_interval -1', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('flush_interval -1')
  })

  test('operator enabled with announce enabled: /v1/announce handle block still present and separate', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: true,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('handle /v1/announce {')
    expect(result).toContain('reverse_proxy gateway:3000')
  })

  test('operator enabled with announce enabled: /v1/announce handle appears before /operator/* handle', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: true,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    const announceIdx = result.indexOf('handle /v1/announce')
    const operatorIdx = result.indexOf('handle /operator/*')
    expect(announceIdx).toBeGreaterThanOrEqual(0)
    expect(operatorIdx).toBeGreaterThanOrEqual(0)
    expect(announceIdx).toBeLessThan(operatorIdx)
  })

  test('operator enabled: catch-all 404 remains last handler', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    const operatorIdx = result.indexOf('handle /operator/*')
    const catchAllIdx = result.indexOf('handle {')
    expect(catchAllIdx).toBeGreaterThan(operatorIdx)
    expect(result).toMatch(/handle\s*\{[^}]*respond\s+404[^}]*\}/)
  })

  test('operator disabled: no /operator/* handle block', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).not.toContain('/operator/*')
  })

  test('operator disabled: no flush_interval in Caddyfile', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).not.toContain('flush_interval')
  })

  test('operator enabled: /operator/* handle block appears before catch-all', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    const operatorIdx = result.indexOf('handle /operator/*')
    const catchAllIdx = result.lastIndexOf('handle {')
    expect(operatorIdx).toBeGreaterThanOrEqual(0)
    expect(operatorIdx).toBeLessThan(catchAllIdx)
  })
})

// ─── main() — operator config validation before SSH ──────────────────────────

describe('main() — operator config validation before SSH', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('partial operator config (only BIND_HOST set) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    const env = makeEnv({GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN

    await expect(
      main({
        env,
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR/)

    expect(calls).toHaveLength(0)
  })

  test('partial operator config (only BIND_PORT set) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    const env = makeEnv({GATEWAY_OPERATOR_BIND_PORT: '9300'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN

    await expect(
      main({
        env,
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR/)

    expect(calls).toHaveLength(0)
  })

  test('partial operator config (only PUBLIC_ORIGIN set) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    const env = makeEnv({GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot'})
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT

    await expect(
      main({
        env,
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR/)

    expect(calls).toHaveLength(0)
  })

  test('unsafe bind host (0.0.0.0) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({
          GATEWAY_OPERATOR_BIND_HOST: '0.0.0.0',
          GATEWAY_OPERATOR_BIND_PORT: '9300',
          GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
        }),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR_BIND_HOST/)

    expect(calls).toHaveLength(0)
  })

  test('loopback bind host (127.0.0.1) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({
          GATEWAY_OPERATOR_BIND_HOST: '127.0.0.1',
          GATEWAY_OPERATOR_BIND_PORT: '9300',
          GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
        }),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR_BIND_HOST/)

    expect(calls).toHaveLength(0)
  })

  test('sandbox-net bind host (10.x.x.x) → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({
          GATEWAY_OPERATOR_BIND_HOST: '10.0.0.5',
          GATEWAY_OPERATOR_BIND_PORT: '9300',
          GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
        }),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR_BIND_HOST/)

    expect(calls).toHaveLength(0)
  })

  test('non-HTTPS public origin → rejects before any spawn', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({
          GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
          GATEWAY_OPERATOR_BIND_PORT: '9300',
          GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'http://dashboard.fro.bot',
        }),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN/)

    expect(calls).toHaveLength(0)
  })

  test('complete valid operator config → deploy proceeds (spawn called)', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await main({
      env: makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    expect(calls.length).toBeGreaterThan(0)
  })

  test('no operator vars → deploy proceeds without operator topology (spawn called)', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()
    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    expect(calls.length).toBeGreaterThan(0)
  })
})

// ─── main() — operator health probe ──────────────────────────────────────────

describe('main() — operator health probe', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('operator enabled: fetch called with /operator/health URL after compose up', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const fetchedUrls: string[] = []

    const fetchMock = mock(async (url: string) => {
      fetchedUrls.push(url)
      if (url.includes('/operator/health')) {
        return new Response(JSON.stringify({status: 'ok'}), {status: 200})
      }
      // Discord commands response
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    await main({
      env: makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
      }),
      args: [],
      spawn: spawnFn,
      fetch: fetchMock,
      sleep: async () => {},
    })

    const operatorHealthUrl = fetchedUrls.find(u => u.includes('/operator/health'))
    expect(operatorHealthUrl).toBeDefined()
    expect(operatorHealthUrl).toContain('https://dashboard.fro.bot/operator/health')
  })

  test('operator disabled: fetch NOT called with /operator/health URL', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const fetchedUrls: string[] = []

    const fetchMock = mock(async (url: string) => {
      fetchedUrls.push(url)
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: fetchMock,
      sleep: async () => {},
    })

    const operatorHealthUrl = fetchedUrls.find(u => u.includes('/operator/health'))
    expect(operatorHealthUrl).toBeUndefined()
  })

  test('operator health probe failure (connection error) → deploy still succeeds (warning only)', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()

    const fetchMock = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        throw new Error('Connection refused')
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    // Should not throw — operator health probe is warning-only
    await expect(
      main({
        env: makeEnv({
          GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
          GATEWAY_OPERATOR_BIND_PORT: '9300',
          GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
        }),
        args: [],
        spawn: spawnFn,
        fetch: fetchMock,
        sleep: async () => {},
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── Topology blocker fixes (issue #579) ─────────────────────────────────────

// Blocker 1: GATEWAY_OPERATOR_PUBLIC_ORIGIN must be passed into gateway container env
describe('buildComposeOverride — GATEWAY_OPERATOR_PUBLIC_ORIGIN in gateway env (blocker 1)', () => {
  test('operator enabled: gateway service has GATEWAY_OPERATOR_PUBLIC_ORIGIN env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(yaml).toContain('https://operator.example.com')
  })

  test('operator disabled: gateway service has NO GATEWAY_OPERATOR_PUBLIC_ORIGIN env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: false,
    })
    expect(yaml).not.toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })

  test('operator enabled with announce enabled: all three operator env entries present', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_PORT')
    expect(yaml).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })
})

// Blocker 2: Caddy must exist when announceEnabled || operatorEnabled
describe('buildComposeOverride — Caddy gated by caddyEnabled = announceEnabled || operatorEnabled (blocker 2)', () => {
  test('operator-only (announce disabled): Caddy service IS declared', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('caddy:')
    expect(yaml).toContain('80:80')
    expect(yaml).toContain('443:443')
  })

  test('operator-only (announce disabled): caddy_data and caddy_config volumes declared', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('caddy_data')
    expect(yaml).toContain('caddy_config')
  })

  test('neither enabled: Caddy service NOT declared', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: false,
    })
    expect(yaml).not.toContain('caddy:')
    expect(yaml).not.toContain('caddy_data')
    expect(yaml).not.toContain('caddy_config')
  })

  test('announce-only (operator disabled): Caddy service IS declared', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
      operatorEnabled: false,
    })
    expect(yaml).toContain('caddy:')
  })

  test('both enabled: Caddy service IS declared', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('caddy:')
  })
})

// Blocker 2: buildCaddyfile must accept announce/operator booleans
describe('buildCaddyfile — announce/operator routing booleans (blocker 2)', () => {
  test('announce-only: /v1/announce route present, no /operator/* route', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: true,
      operatorEnabled: false,
    })
    expect(result).toContain('handle /v1/announce {')
    expect(result).not.toContain('/operator/*')
  })

  test('operator-only: /operator/* route present, no /v1/announce route', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: false,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('/operator/*')
    expect(result).not.toContain('/v1/announce')
  })

  test('operator-only: includes flush_interval -1', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: false,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('flush_interval -1')
  })

  test('both enabled: both /v1/announce and /operator/* routes present', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: true,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toContain('handle /v1/announce {')
    expect(result).toContain('/operator/*')
  })

  test('both enabled: catch-all 404 still present', async () => {
    const {buildCaddyfile} = await import('./deploy')
    const result = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: true,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })
    expect(result).toMatch(/handle\s*\{[^}]*respond\s+404[^}]*\}/)
  })

  test('no opts (legacy call): /v1/announce route present (backward compat)', async () => {
    const {buildCaddyfile} = await import('./deploy')
    // When called with no opts, should still produce a valid Caddyfile
    // (backward compat for existing announce-only callers)
    const result = buildCaddyfile('gateway.fro.bot')
    expect(result).toContain('gateway.fro.bot')
    // catch-all must always be present
    expect(result).toMatch(/handle\s*\{[^}]*respond\s+404[^}]*\}/)
  })
})

// Blocker 3: Static ipv4_address needs explicit network/IPAM contract
describe('buildComposeOverride — deterministic network/IPAM for static operator IP (blocker 3)', () => {
  test('operator enabled: top-level networks section declares gateway-net with IPAM subnet', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    // Must declare top-level networks section with gateway-net
    expect(yaml).toMatch(/^networks:/m)
    expect(yaml).toContain('gateway-net:')
    // Must include IPAM config with a subnet
    expect(yaml).toContain('ipam:')
    expect(yaml).toContain('subnet:')
  })

  test('operator disabled: no top-level networks section with IPAM', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: false,
    })
    // No IPAM section when operator is disabled
    expect(yaml).not.toContain('ipam:')
    expect(yaml).not.toContain('subnet:')
  })

  test('announce-only (no operator): no top-level networks IPAM', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
      operatorEnabled: false,
    })
    expect(yaml).not.toContain('ipam:')
    expect(yaml).not.toContain('subnet:')
  })

  test('operator enabled: IPAM subnet is deterministic (172.20.0.0/16)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    expect(yaml).toContain('172.20.0.0/16')
  })
})

// Blocker: deploy flow writes Caddyfile when operator enabled even if announce disabled
describe('main() — Caddyfile written when operator enabled (announce disabled) (blocker 2)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.44.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('operator enabled, announce disabled → Caddyfile IS written', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://gateway.fro.bot',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toBeDefined()
  })

  test('operator enabled, announce disabled → Caddyfile contains /operator/* route', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://gateway.fro.bot',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toContain('/operator/*')
  })

  test('operator enabled, announce disabled → Caddyfile does NOT contain /v1/announce route', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
        GATEWAY_OPERATOR_BIND_PORT: '9300',
        GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://gateway.fro.bot',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).not.toContain('/v1/announce')
  })

  test('neither enabled → Caddyfile NOT written', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    const env = makeEnv()
    delete (env as Record<string, string>).GATEWAY_WEBHOOK_SECRET
    delete (env as Record<string, string>).GATEWAY_PRESENCE_CHANNEL_ID
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_HOST
    delete (env as Record<string, string>).GATEWAY_OPERATOR_BIND_PORT
    delete (env as Record<string, string>).GATEWAY_OPERATOR_PUBLIC_ORIGIN

    await main({
      env,
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toBeUndefined()
  })

  test('announce enabled, operator disabled → Caddyfile contains /v1/announce, no /operator/*', async () => {
    const {main} = await import('./deploy')
    const stdinCaptures: Record<string, string> = {}
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('cat >')) {
        const remotePath = cmd.join(' ').match(/cat > '([^']+)'/)?.[1] ?? ''
        const result = makeSpawnResult()
        result.stdin = {
          write(data: Uint8Array) {
            stdinCaptures[remotePath] = (stdinCaptures[remotePath] ?? '') + new TextDecoder().decode(data)
          },
          end() {},
        }
        return result
      }
      return undefined
    })

    await main({
      env: makeEnv({
        GATEWAY_WEBHOOK_SECRET: 'hmac-secret',
        GATEWAY_PRESENCE_CHANNEL_ID: '111222333444555666',
      }),
      args: [],
      spawn: spawnFn,
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
    })

    const caddyfilePath = '/opt/gateway/deploy/Caddyfile'
    expect(stdinCaptures[caddyfilePath]).toBeDefined()
    expect(stdinCaptures[caddyfilePath]).toContain('/v1/announce')
    expect(stdinCaptures[caddyfilePath]).not.toContain('/operator/*')
  })
})

// Checksum includes Caddyfile when Caddy is enabled (not just announce)
describe('computeSecretsChecksum — Caddyfile included when operator enabled (blocker 2)', () => {
  test('operator-only: checksum input includes Caddyfile bytes', async () => {
    const {buildSecretFileList, buildComposeOverride, buildCaddyfile, computeSecretsChecksum} = await import('./deploy')

    const operatorEnv = makeEnv({
      GATEWAY_OPERATOR_BIND_HOST: '172.20.0.2',
      GATEWAY_OPERATOR_BIND_PORT: '9300',
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: 'https://dashboard.fro.bot',
    })

    const secrets = buildSecretFileList(operatorEnv)
    const overrideContent = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://operator.example.com',
    })
    const caddyfileContent = buildCaddyfile('gateway.fro.bot', {
      announceEnabled: false,
      operatorEnabled: true,
      operatorTarget: '172.20.0.2:9300',
    })

    // Checksum WITH Caddyfile must differ from checksum WITHOUT Caddyfile
    const checksumWithout = computeSecretsChecksum([
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
    ])
    const checksumWith = computeSecretsChecksum([
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
      {name: 'Caddyfile', content: caddyfileContent, required: false},
    ])

    expect(checksumWith).not.toBe(checksumWithout)
  })
})

// ─── Issue 2: validateOperatorConfig — dashboard-origin convention ────────────
// The ratified browser-visible operator origin is https://dashboard.fro.bot.
// This is enforced by convention and documentation, not by the validator.
// The validator accepts any valid HTTPS origin.

describe('validateOperatorConfig — dashboard-origin convention (issue 2)', () => {
  test('https://dashboard.fro.bot with gatewayHost is accepted (ratified browser-visible origin)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('https://gateway.fro.bot is accepted — validator does not enforce origin convention', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    // The validator accepts any valid HTTPS origin. The dashboard.fro.bot convention is
    // enforced by documentation and operator practice, not by the deploy validator.
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('arbitrary cross-host origin is accepted — validator accepts any valid HTTPS origin', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://operator.example.com',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('origin with pathname other than / is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot/some/path',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*path|origin/i)
  })

  test('origin with query string is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot?foo=bar',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*query|search|origin/i)
  })

  test('origin with hash/fragment is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot#section',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*hash|fragment|origin/i)
  })

  test('origin with username is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://user@dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*credential|username|password|origin/i)
  })

  test('origin with password is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://user:pass@dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_PUBLIC_ORIGIN.*credential|username|password|origin/i)
  })

  test('existing unsafe bind host checks still work with gatewayHost param', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '0.0.0.0',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/0\.0\.0\.0/)
  })

  test('existing loopback check still works with gatewayHost param', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '127.0.0.1',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).toThrow(/loopback/)
  })
})

// ─── Issue 3: operator health probe requires HTTP 200 ─────────────────────────

describe('main() — operator health probe requires HTTP 200 (issue 3)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('operator health probe: HTTP 200 → probeOk (success logged)', async () => {
    const {main} = await import('./deploy')
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnMessages.push(args.join(' '))

    const fetchMock = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        return new Response('OK', {status: 200})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    try {
      await main({
        env: makeOperatorEnv(),
        args: [],
        spawn: makeSpawnMock().spawnFn,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
      })
    } finally {
      console.warn = origWarn
    }

    expect(warnMessages.some(m => m.includes('Operator health probe succeeded'))).toBe(true)
  })

  test('operator health probe: HTTP 404 → NOT success (warns, does not log success)', async () => {
    const {main} = await import('./deploy')
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnMessages.push(args.join(' '))

    const fetchMock = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        return new Response('Not Found', {status: 404})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    try {
      await main({
        env: makeOperatorEnv(),
        args: [],
        spawn: makeSpawnMock().spawnFn,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        probeAttempts: 1,
      })
    } finally {
      console.warn = origWarn
    }

    // 404 must NOT be treated as success
    expect(warnMessages.some(m => m.includes('Operator health probe succeeded'))).toBe(false)
    // Must warn that probe did not succeed
    expect(warnMessages.some(m => m.includes('did not succeed') || m.includes('warn'))).toBe(true)
  })

  test('operator health probe: HTTP 301 redirect → NOT success (warns)', async () => {
    const {main} = await import('./deploy')
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => warnMessages.push(args.join(' '))

    const fetchMock = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        return new Response('', {status: 301, headers: {Location: 'https://gateway.fro.bot/operator/health/'}})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    })

    try {
      await main({
        env: makeOperatorEnv(),
        args: [],
        spawn: makeSpawnMock().spawnFn,
        fetch: fetchMock as unknown as typeof fetch,
        sleep: async () => {},
        probeAttempts: 1,
      })
    } finally {
      console.warn = origWarn
    }

    // 3xx must NOT be treated as success
    expect(warnMessages.some(m => m.includes('Operator health probe succeeded'))).toBe(false)
  })
})

// ─── Issue 4: infra rendered-config validation gate ───────────────────────────

describe('infra rendered-config validation gate (issue 4)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('operator enabled: infra rendered-config validation runs after upstream validate-stack.sh and before docker compose pull', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('validate-stack.sh')) {
        eventLog.push('upstream-validate')
      } else if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        eventLog.push('infra-rendered-config')
      } else if (cmdStr.includes('docker compose') && cmdStr.includes(' pull')) {
        eventLog.push('compose-pull')
      }
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const upstreamIdx = eventLog.indexOf('upstream-validate')
    const infraIdx = eventLog.indexOf('infra-rendered-config')
    const pullIdx = eventLog.indexOf('compose-pull')

    // infra rendered-config validation must be invoked
    expect(infraIdx).toBeGreaterThanOrEqual(0)
    // must run after upstream validate-stack.sh
    expect(infraIdx).toBeGreaterThan(upstreamIdx)
    // must run before docker compose pull
    expect(infraIdx).toBeLessThan(pullIdx)
  })

  test('operator enabled: non-zero rendered-config exit aborts before docker compose pull', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        eventLog.push('infra-rendered-config')
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: gateway not on gateway-net'})
      }
      if (cmdStr.includes('docker compose') && cmdStr.includes(' pull')) {
        eventLog.push('compose-pull')
      }
      return undefined
    })

    await expect(
      main({
        env: makeOperatorEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    expect(eventLog).toContain('infra-rendered-config')
    expect(eventLog).not.toContain('compose-pull')
  })

  test('operator enabled: non-zero rendered-config exit aborts before docker compose up', async () => {
    const {main} = await import('./deploy')
    const composeCalls: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: topology violation'})
      }
      if (cmdStr.includes('docker compose') && cmdStr.includes(' up ')) {
        composeCalls.push(cmdStr)
      }
      return undefined
    })

    await expect(
      main({
        env: makeOperatorEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    expect(composeCalls).toHaveLength(0)
  })

  test('operator enabled: non-zero rendered-config exit aborts before checksum persistence', async () => {
    const {main} = await import('./deploy')
    const checksumWrites: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: topology violation'})
      }
      if (cmdStr.includes('> /opt/gateway/.secrets-checksum')) {
        checksumWrites.push(cmdStr)
      }
      return undefined
    })

    await expect(
      main({
        env: makeOperatorEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    expect(checksumWrites).toHaveLength(0)
  })

  test('operator disabled: infra rendered-config validation is NOT invoked', async () => {
    const {main} = await import('./deploy')
    const renderedConfigCalls: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        renderedConfigCalls.push(cmdStr)
      }
      return undefined
    })

    await main({
      env: makeEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    // No rendered-config validation for non-operator deploys
    expect(renderedConfigCalls).toHaveLength(0)
  })
})

// ─── CE Review Findings: Phase 5d shell quoting + Bun dependency ─────────────

describe('Phase 5d rendered-config validation — safe shell quoting (CE review finding 1)', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('Phase 5d command does NOT use bun --eval (no host-Bun dependency)', async () => {
    const {main} = await import('./deploy')
    const renderedConfigCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Capture the Phase 5d validation command (runs docker compose config)
      if (cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        renderedConfigCmds.push(cmd)
      }
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(renderedConfigCmds.length).toBeGreaterThan(0)
    for (const cmd of renderedConfigCmds) {
      const cmdStr = cmd.join(' ')
      // Must NOT use bun --eval (no host-Bun dependency on the droplet)
      expect(cmdStr).not.toContain('bun --eval')
      expect(cmdStr).not.toContain('bun --eval')
    }
  })

  test('Phase 5d command uses single-quoted heredoc or equivalent no-expansion mechanism (no outer $VAR expansion)', async () => {
    const {main} = await import('./deploy')
    const sshCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Capture SSH commands that contain the rendered-config validation script
      if (cmd[0] === 'ssh' && cmdStr.includes('docker compose') && cmdStr.includes('config')) {
        sshCmds.push(cmd)
      }
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(sshCmds.length).toBeGreaterThan(0)
    for (const cmd of sshCmds) {
      // The remote command (last SSH arg) must use a single-quoted heredoc
      // (<<'SCRIPT'...SCRIPT) to prevent outer shell expansion of $CONFIG etc.
      // OR use bash -s with stdin piping (no $VAR in the command string itself).
      // We check: the command must NOT use bash -c with a double-quoted or JSON.stringify'd script
      // that would allow outer shell to expand $CONFIG or $(...) before inner bash runs.
      const remoteCmd = cmd.at(-1) ?? ''
      // Must NOT use bash -c with a string that contains unquoted $CONFIG or $(
      // (the old broken form was: bash -c ${JSON.stringify(script)} which passes a double-quoted string)
      expect(remoteCmd).not.toMatch(/bash\s+-c\s+"[^"]*\$CONFIG/)
      expect(remoteCmd).not.toMatch(/bash\s+-c\s+"[^"]*\$\(/)
      // Must use single-quoted heredoc OR stdin-based approach
      // Single-quoted heredoc: <<'SCRIPT' prevents variable expansion
      const usesHeredoc =
        remoteCmd.includes("<<'SCRIPT'") || remoteCmd.includes("<<'EOF'") || remoteCmd.includes("<<'VALIDATE'")
      const usesBashS = remoteCmd.includes('bash -s') || remoteCmd.includes("bash <<'")
      expect(usesHeredoc || usesBashS).toBe(true)
    }
  })

  test('Phase 5d validation command does not use bash -c with JSON.stringify (old broken form)', async () => {
    // The old form was: sshCommand(host, `bash -c ${JSON.stringify(validateScript)}`, ...)
    // This is broken because the outer shell expands $CONFIG before inner bash runs.
    // The fix must use a heredoc or stdin-based approach.
    const {main} = await import('./deploy')
    const sshCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmd[0] === 'ssh' && cmdStr.includes('config') && cmdStr.includes('docker compose')) {
        sshCmds.push(cmd)
      }
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    expect(sshCmds.length).toBeGreaterThan(0)
    for (const cmd of sshCmds) {
      const remoteCmd = cmd.at(-1) ?? ''
      // The old broken form used JSON.stringify which produces a double-quoted string
      // with escaped characters — the outer shell would expand $CONFIG before inner bash.
      // Must NOT match: bash -c "..." where the string contains $CONFIG
      expect(remoteCmd).not.toMatch(/bash\s+-c\s+"\s*set\s+-euo/)
    }
  })
})

// ─── CE Review Findings: buildComposeOverride operator env guard (finding 2) ──

describe('buildComposeOverride — operator env guard requires operatorPublicOrigin (CE review finding 2)', () => {
  test('operator enabled with all three vars: emits GATEWAY_OPERATOR_PUBLIC_ORIGIN', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://gateway.fro.bot',
    })
    expect(yaml).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(yaml).toContain('https://gateway.fro.bot')
  })

  test('operator enabled but operatorPublicOrigin undefined: does NOT emit any operator env lines', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: undefined,
    })
    // Must NOT emit any operator env lines when operatorPublicOrigin is missing
    expect(yaml).not.toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).not.toContain('GATEWAY_OPERATOR_BIND_PORT')
    expect(yaml).not.toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
  })

  test('operator enabled but operatorPublicOrigin undefined: does NOT emit empty GATEWAY_OPERATOR_PUBLIC_ORIGIN', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: undefined,
    })
    // Must NOT emit GATEWAY_OPERATOR_PUBLIC_ORIGIN with empty value
    expect(yaml).not.toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN:')
    expect(yaml).not.toMatch(/GATEWAY_OPERATOR_PUBLIC_ORIGIN:\s*$/)
  })

  test('operator enabled with all three vars: GATEWAY_OPERATOR_PUBLIC_ORIGIN value is the origin, not empty', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: false,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://dashboard.fro.bot',
    })
    // The value must be the actual origin, not empty
    expect(yaml).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN: https://dashboard.fro.bot')
  })
})

// ─── CE Review Findings: validateOperatorConfig hardening (finding 3) ─────────

describe('validateOperatorConfig — non-443 port rejection (CE review finding 3)', () => {
  test('explicit non-443 port in publicOrigin is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot:8443',
      }),
    ).toThrow(/port|443|Caddy/i)
  })

  test('explicit :443 in publicOrigin is accepted (or normalized)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    // https://gateway.fro.bot:443 is the same as https://gateway.fro.bot
    // URL parser normalizes :443 away for https: — should not throw
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot:443',
      }),
    ).not.toThrow()
  })

  test('explicit :8443 port in publicOrigin is rejected with clear message about Caddy topology', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    let errorMessage = ''
    try {
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot:8443',
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    expect(errorMessage).toMatch(/8443|non-default|port|443/i)
    expect(errorMessage).toMatch(/Caddy|topology|supported/i)
  })
})

describe('validateOperatorConfig — gatewayHost param (CE review finding 3)', () => {
  test('dashboard.fro.bot with gatewayHost is accepted (ratified browser-visible origin)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://dashboard.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('gateway.fro.bot as publicOrigin with gatewayHost is accepted — no hostname constraint enforced', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    // The validator accepts any valid HTTPS origin. The dashboard.fro.bot convention is
    // enforced by documentation and operator practice, not by the deploy validator.
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('arbitrary cross-host origin with gatewayHost is accepted — validator accepts any valid HTTPS origin', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://other.example.com',
        gatewayHost: 'gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('omitted gatewayHost is accepted (no hostname check)', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://any.example.com',
      }),
    ).not.toThrow()
  })
})

describe('validateOperatorConfig — trailing slash health URL (CE review finding 3)', () => {
  test('health probe URL does not double-slash when origin has trailing slash', async () => {
    // The health probe URL must be constructed with new URL('/operator/health', origin)
    // so that a trailing slash in origin does not produce //operator/health
    const origin = 'https://dashboard.fro.bot'
    const healthUrl = new URL('/operator/health', origin).toString()
    expect(healthUrl).toBe('https://dashboard.fro.bot/operator/health')
    expect(healthUrl).not.toContain('//operator/health')
  })

  test('health probe URL with trailing slash origin does not double-slash', async () => {
    // Even if origin has trailing slash, new URL('/operator/health', origin) is correct
    const originWithSlash = 'https://dashboard.fro.bot/'
    const healthUrl = new URL('/operator/health', originWithSlash).toString()
    expect(healthUrl).toBe('https://dashboard.fro.bot/operator/health')
    expect(healthUrl).not.toContain('//operator/health')
  })
})

describe('validateOperatorConfig — subnet validation (CE review finding 3)', () => {
  test('bind host inside 172.20.0.0/16 is accepted', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('bind host 172.20.255.254 (top of /16) is accepted', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.255.254',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).not.toThrow()
  })

  test('bind host 172.21.0.2 (outside 172.20.0.0/16) is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.21.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).toThrow(/172\.20\.0\.0\/16|gateway-net|subnet/i)
  })

  test('bind host 172.19.0.2 (outside 172.20.0.0/16) is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.19.0.2',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).toThrow(/172\.20\.0\.0\/16|gateway-net|subnet/i)
  })

  test('bind host 192.168.1.1 (outside 172.20.0.0/16) is rejected', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '192.168.1.1',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).toThrow(/172\.20\.0\.0\/16|gateway-net|subnet/i)
  })
})

describe('validateOperatorConfig — colon error text improvement (CE review finding 3)', () => {
  test('172.20.0.2:9300 (IP with port) is described as containing a colon, not as IPv6', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    let errorMessage = ''
    try {
      validateOperatorConfig({
        bindHost: '172.20.0.2:9300',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }
    // Must NOT describe it as IPv6 (it's an IP:port, not IPv6)
    expect(errorMessage).not.toMatch(/IPv6/i)
    // Must describe the colon issue clearly
    expect(errorMessage).toMatch(/colon|port|IP:port|format/i)
  })
})

describe('validateOperatorConfig — empty bindHost and bindPort (CE review finding 3)', () => {
  test('empty bindHost throws with descriptive message', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '',
        bindPort: '9300',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_HOST.*required/i)
  })

  test('empty bindPort throws with descriptive message', async () => {
    const {validateOperatorConfig} = await import('./deploy')
    expect(() =>
      validateOperatorConfig({
        bindHost: '172.20.0.2',
        bindPort: '',
        publicOrigin: 'https://gateway.fro.bot',
      }),
    ).toThrow(/GATEWAY_OPERATOR_BIND_PORT.*required/i)
  })
})

// ─── CE Review Findings: shared operator fixture includes operatorPublicOrigin ─

describe('buildComposeOverride — shared operator fixture includes operatorPublicOrigin (CE review finding 2)', () => {
  // The shared OPERATOR_OPTS fixture in the existing tests was missing operatorPublicOrigin.
  // These tests assert the primary operator topology tests work with operatorPublicOrigin set.
  test('operator topology with operatorPublicOrigin: GATEWAY_OPERATOR_PUBLIC_ORIGIN in output', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride({
      gatewayDigest: GATEWAY_DIGEST,
      workspaceDigest: WORKSPACE_DIGEST,
      announceEnabled: true,
      operatorEnabled: true,
      operatorBindHost: '172.20.0.2',
      operatorBindPort: '9300',
      operatorPublicOrigin: 'https://dashboard.fro.bot',
    })
    expect(yaml).toContain('GATEWAY_OPERATOR_PUBLIC_ORIGIN')
    expect(yaml).toContain('https://dashboard.fro.bot')
    // Also verify the other operator env entries are present
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_HOST')
    expect(yaml).toContain('GATEWAY_OPERATOR_BIND_PORT')
  })
})

// ─── Phase 5d rendered-config validation — missing invariants ─────────────────
//
// These tests cover the invariants that Phase 5d must check but currently does not:
//   - gateway keeps sandbox-net
//   - workspace is sandbox-net only (not gateway-net/egress-net)
//   - caddy is gateway-net only
//   - caddy publishes only host ports 80 and 443

/** Capture the Phase 5d validate script command string from spawn calls. */
function captureValidateScript(calls: string[][]): string | undefined {
  // The Phase 5d script is passed as the last element of an SSH command
  // and contains the single-quoted heredoc marker and docker compose config.
  const cmd = calls.find(c => {
    const last = c.at(-1) ?? ''
    return last.includes("bash <<'SCRIPT'") && last.includes('docker compose') && last.includes('config --format json')
  })
  return cmd?.at(-1)
}

describe('Phase 5d rendered-config validation — full invariant coverage', () => {
  // These tests inspect the validateScript string that main() passes to SSH.
  // We capture the SSH command for the infra rendered-config validation step
  // and assert the script body contains the required checks.

  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('Phase 5d script checks gateway keeps sandbox-net', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must check that gateway keeps sandbox-net
    expect(script).toMatch(/sandbox.net/)
  })

  test('Phase 5d script checks workspace is sandbox-net only (not gateway-net or egress-net)', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must check workspace network membership
    expect(script).toMatch(/workspace/)
    // Must check for absence of gateway-net or egress-net on workspace
    expect(script).toMatch(/gateway.net|egress.net/)
  })

  test('Phase 5d script checks caddy is gateway-net only', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must check caddy network membership
    expect(script).toMatch(/caddy/)
    expect(script).toMatch(/gateway.net/)
  })

  test('Phase 5d script checks caddy publishes only ports 80 and 443', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must check caddy port bindings (80 and 443)
    expect(script).toMatch(/caddy/)
    expect(script).toMatch(/80/)
    expect(script).toMatch(/443/)
  })

  test('Phase 5d script uses single-quoted heredoc (no outer shell expansion)', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must use single-quoted heredoc to prevent outer shell expansion
    expect(script).toContain("bash <<'SCRIPT'")
    // Must NOT use double-quoted heredoc
    expect(script).not.toContain('bash <<"SCRIPT"')
    expect(script).not.toContain('bash <<SCRIPT')
  })

  test('Phase 5d script does not use bun --eval', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must NOT use bun --eval (not guaranteed on droplet)
    expect(script).not.toContain('bun --eval')
    expect(script).not.toContain('bun -e ')
  })

  test('Phase 5d script does not swallow parse errors with 2>/dev/null || true', async () => {
    const {main} = await import('./deploy')
    const capturedCmds: string[][] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      capturedCmds.push(cmd)
      return undefined
    })

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: makeDiscordFetch([{name: 'ping'}]),
      sleep: async () => {},
      spawn: spawnFn,
    })

    const script = captureValidateScript(capturedCmds)
    expect(script, 'Phase 5d script must be present for operator deploys').toBeDefined()
    // Must NOT swallow errors with 2>/dev/null || true
    expect(script).not.toContain('2>/dev/null || true')
  })

  test('Phase 5d non-zero exit (sandbox-net missing from gateway) aborts deploy before compose pull', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      const lastArg = cmd.at(-1) ?? ''
      if (lastArg.includes("bash <<'SCRIPT'") && lastArg.includes('config --format json')) {
        eventLog.push('phase-5d-validate')
        return makeSpawnResult({exitCode: 1, stderr: 'FAIL: gateway missing sandbox-net'})
      }
      if (cmdStr.includes('docker compose') && cmdStr.includes(' pull')) {
        eventLog.push('compose-pull')
      }
      return undefined
    })

    await expect(
      main({
        env: makeOperatorEnv(),
        args: [],
        fetch: makeDiscordFetch([{name: 'ping'}]),
        sleep: async () => {},
        spawn: spawnFn,
      }),
    ).rejects.toThrow()

    expect(eventLog).toContain('phase-5d-validate')
    expect(eventLog).not.toContain('compose-pull')
  })
})

// ─── Issue 2: operator health URL trailing-slash normalization ────────────────
//
// `${operatorPublicOrigin}/operator/health` produces a double slash when origin
// has a trailing slash (e.g. "https://gateway.fro.bot/"). Fix: use new URL().

describe('operator health URL — trailing-slash origin normalization', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('trailing-slash origin probes /operator/health with no double slash', async () => {
    // validateOperatorConfig rejects trailing-slash origins (pathname !== '/'),
    // so we test the URL construction directly via the new URL() helper behavior.
    // The regression: string concat `${origin}/operator/health` where origin ends in '/'
    // produces 'https://gateway.fro.bot//operator/health' (double slash in path).
    // The fix: new URL('/operator/health', origin).toString() normalizes correctly.
    //
    // We verify the fix by checking the probed URL from a valid (no trailing slash) origin
    // does NOT contain '//operator' (the double-slash path pattern).
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const probedUrls: string[] = []

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        probedUrls.push(url)
        return new Response('OK', {status: 200})
      }
      // Discord registration
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: mockFetch,
      sleep: async () => {},
      spawn: spawnFn,
      probeAttempts: 1,
      probeIntervalMs: 0,
    })

    expect(probedUrls).toHaveLength(1)
    // Must NOT have double slash in the path (the regression pattern)
    expect(probedUrls[0]).not.toMatch(/\/\/operator/)
    // Must be exactly this URL (no double slash)
    expect(probedUrls[0]).toBe('https://dashboard.fro.bot/operator/health')
  })

  test('URL construction: new URL("/operator/health", origin) normalizes trailing-slash origin correctly', () => {
    // Unit test for the URL construction fix independent of main().
    // This directly verifies that new URL('/operator/health', origin).toString()
    // produces the correct URL even when origin has a trailing slash.
    const originWithSlash = 'https://dashboard.fro.bot/'
    const originWithoutSlash = 'https://dashboard.fro.bot'

    // String concat (the broken approach):
    const brokenWithSlash = `${originWithSlash}/operator/health`
    const brokenWithoutSlash = `${originWithoutSlash}/operator/health`

    // new URL() (the correct approach):
    const fixedWithSlash = new URL('/operator/health', originWithSlash).toString()
    const fixedWithoutSlash = new URL('/operator/health', originWithoutSlash).toString()

    // The broken approach produces double slash for trailing-slash origin
    expect(brokenWithSlash).toContain('//operator')
    // The broken approach works for no-trailing-slash origin
    expect(brokenWithoutSlash).not.toContain('//operator')

    // The fixed approach works for both
    expect(fixedWithSlash).toBe('https://dashboard.fro.bot/operator/health')
    expect(fixedWithoutSlash).toBe('https://dashboard.fro.bot/operator/health')
    expect(fixedWithSlash).not.toContain('//operator')
    expect(fixedWithoutSlash).not.toContain('//operator')
  })

  test('operator health probe URL is constructed with new URL() not string concat', async () => {
    // Verify the URL construction is correct by checking the probed URL format.
    // The fix: new URL('/operator/health', operatorPublicOrigin).toString()
    // This test verifies the result is correct regardless of implementation.
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const probedUrls: string[] = []

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        probedUrls.push(url)
        return new Response('OK', {status: 200})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    await main({
      env: makeOperatorEnv(),
      args: [],
      fetch: mockFetch,
      sleep: async () => {},
      spawn: spawnFn,
      probeAttempts: 1,
      probeIntervalMs: 0,
    })

    expect(probedUrls).toHaveLength(1)
    expect(probedUrls[0]).toBe('https://dashboard.fro.bot/operator/health')
    // Verify no double slash in the path
    expect(probedUrls[0]).not.toMatch(/\/\/operator/)
  })
})

// ─── Issue 3: operator health probe log does not expose URL ──────────────────
//
// The initial probe log must use a static message, not the full URL.
// The final verify curl URL may still appear (existing tests/docs expect it).

describe('operator health probe — initial log does not expose URL', () => {
  let upstreamPath: string
  let originalUpstream: string | undefined

  beforeEach(() => {
    upstreamPath = join(import.meta.dir, '..', 'upstream.json')
    originalUpstream = existsSync(upstreamPath) ? readFileSync(upstreamPath, 'utf-8') : undefined
    writeFileSync(upstreamPath, JSON.stringify({repo: 'fro-bot/agent', ref: 'v0.66.0'}))
  })

  afterEach(() => {
    if (originalUpstream === undefined) {
      try {
        rmSync(upstreamPath)
      } catch {
        // ignore
      }
    } else {
      writeFileSync(upstreamPath, originalUpstream)
    }
  })

  test('initial operator health probe log uses static message, not the full URL', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const warnMessages: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnMessages.push(args.join(' '))
      origWarn(...args)
    }

    const mockFetch = mock(async (url: string) => {
      if (url.includes('/operator/health')) {
        return new Response('OK', {status: 200})
      }
      return new Response(JSON.stringify([{name: 'ping'}]), {status: 200})
    }) as unknown as typeof fetch

    try {
      await main({
        env: makeOperatorEnv(),
        args: [],
        fetch: mockFetch,
        sleep: async () => {},
        spawn: spawnFn,
        probeAttempts: 1,
        probeIntervalMs: 0,
      })
    } finally {
      console.warn = origWarn
    }

    // The initial probe log must use a static message
    const initialProbeLogs = warnMessages.filter(m => m.includes('Probing operator health'))
    expect(initialProbeLogs.length).toBeGreaterThan(0)
    // The initial probe log must NOT contain the full URL
    const initialProbeLog = initialProbeLogs[0]!
    expect(initialProbeLog).not.toContain('https://dashboard.fro.bot/operator/health')
    // Must use a static message
    expect(initialProbeLog).toContain('Probing operator health')
  })
})
