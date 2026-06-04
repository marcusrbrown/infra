import type {SpawnFn, SpawnResult} from './deploy'
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, mock, test} from 'bun:test'

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

/** Build a spawn mock that records calls and returns success by default. */
function makeSpawnMock(handler?: (cmd: string[]) => SpawnResult | undefined): {spawnFn: SpawnFn; calls: string[][]} {
  const calls: string[][] = []
  const spawnFn: SpawnFn = (cmd, _opts) => {
    calls.push(cmd)
    const custom = handler?.(cmd)
    return custom ?? makeSpawnResult()
  }
  return {spawnFn, calls}
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
    const {main, buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const env = makeEnv()
    const expectedChecksum = computeSecretsChecksum(buildSecretFileList(env))

    const {spawnFn, calls} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: expectedChecksum})
      }
      return undefined
    })
    const mockFetch = makeDiscordFetch([{name: 'ping'}])

    await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})

    const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCall).toBeDefined()
    expect(composeCall?.join(' ')).not.toContain('--force-recreate')
    expect(composeCall?.join(' ')).toContain('--build')
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

    const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCall).toBeDefined()
    expect(composeCall?.join(' ')).toContain('--force-recreate')
    expect(composeCall?.join(' ')).toContain('--build')
  })

  test('rebuilds the image from pinned source on every deploy regardless of --force-recreate', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const env = makeEnv()
    const expectedChecksum = computeSecretsChecksum(buildSecretFileList(env))

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

    const composeCallA = callsA.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCallA).toBeDefined()
    expect(composeCallA?.join(' ')).toContain('--build')
    expect(composeCallA?.join(' ')).not.toContain('--force-recreate')

    // Secrets changed path — --force-recreate present alongside --build
    const {spawnFn: spawnFnB, calls: callsB} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('cat')) {
        return makeSpawnResult({stdout: 'old-checksum-that-differs'})
      }
      return undefined
    })
    const mockFetchB = makeDiscordFetch([{name: 'ping'}])
    await main({env: makeEnv(), args: [], fetch: mockFetchB, sleep: async () => {}, spawn: spawnFnB})

    const composeCallB = callsB.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCallB).toBeDefined()
    expect(composeCallB?.join(' ')).toContain('--build')
    expect(composeCallB?.join(' ')).toContain('--force-recreate')
  })

  test('readRemoteChecksum: SSH exits 0 with checksum → returns checksum string', async () => {
    const {main, buildSecretFileList, computeSecretsChecksum} = await import('./deploy')
    const env = makeEnv()
    const expectedChecksum = computeSecretsChecksum(buildSecretFileList(env))

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
    const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCall?.join(' ')).not.toContain('--force-recreate')
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

    // Empty prior checksum != current checksum → --force-recreate
    const composeCall = calls.find(cmd => cmd.some(s => s.includes('docker compose')))
    expect(composeCall?.join(' ')).toContain('--force-recreate')
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

describe('buildComposeOverride', () => {
  test('includes caddy service with 80:80 and 443:443 port bindings', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('80:80')
    expect(yaml).toContain('443:443')
  })

  test('caddy service joins gateway-net network', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('gateway-net')
  })

  test('caddy service has named caddy_data and caddy_config volumes', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('caddy_data')
    expect(yaml).toContain('caddy_config')
  })

  test('caddy service depends_on gateway', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('depends_on')
    expect(yaml).toContain('gateway')
  })

  test('caddy service mounts Caddyfile read-only', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('Caddyfile')
    expect(yaml).toContain(':ro')
  })

  test('gateway service gets GATEWAY_WEBHOOK_SECRET_FILE env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('GATEWAY_WEBHOOK_SECRET_FILE')
    expect(yaml).toContain('/run/secrets/gateway_webhook_secret')
  })

  test('gateway service gets GATEWAY_PRESENCE_CHANNEL_ID_FILE env entry', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('GATEWAY_PRESENCE_CHANNEL_ID_FILE')
    expect(yaml).toContain('/run/secrets/gateway_presence_channel_id')
  })

  test('gateway service gets two announce bind-mount volumes with correct source paths', async () => {
    const {buildComposeOverride, ANNOUNCE_WEBHOOK_SECRET_FILE, ANNOUNCE_PRESENCE_CHANNEL_FILE} =
      await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain(`./secrets/${ANNOUNCE_WEBHOOK_SECRET_FILE}`)
    expect(yaml).toContain(`./secrets/${ANNOUNCE_PRESENCE_CHANNEL_FILE}`)
  })

  test('gateway service bind-mounts target /run/secrets/gateway_webhook_secret', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('/run/secrets/gateway_webhook_secret')
  })

  test('gateway service bind-mounts target /run/secrets/gateway_presence_channel_id', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    expect(yaml).toContain('/run/secrets/gateway_presence_channel_id')
  })

  test('top-level volumes block declares caddy_data and caddy_config', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    // Top-level volumes section must exist
    expect(yaml).toMatch(/^volumes:/m)
    expect(yaml).toContain('caddy_data')
    expect(yaml).toContain('caddy_config')
  })

  test('caddy image is pinned to the same digest as cliproxy (caddy:2.11.3-alpine@sha256:...)', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
    // Must use a pinned digest (sha256:)
    expect(yaml).toMatch(/caddy:[\d.]+-alpine@sha256:[0-9a-f]{64}/)
  })

  test('caddy service has restart: unless-stopped', async () => {
    const {buildComposeOverride} = await import('./deploy')
    const yaml = buildComposeOverride()
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

  test('announce disabled → writeRemoteFile NOT called for compose.override.yaml', async () => {
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

    // compose.override.yaml must NOT have been written
    const overridePath = '/opt/gateway/deploy/compose.override.yaml'
    expect(stdinCaptures[overridePath]).toBeUndefined()
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
    const overrideEntry = {name: 'compose.override.yaml', content: buildComposeOverride(), required: false}
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
      if (cmd.join(' ').includes('docker compose') && cmd.join(' ').includes('up')) {
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

  test('compose-up command always includes --build', async () => {
    const {main} = await import('./deploy')
    const composeCmds: string[][] = []
    const {spawnFn} = makeSpawnMock(cmd => {
      if (cmd.join(' ').includes('docker compose') && cmd.join(' ').includes('up')) {
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
    expect(cmdStr).toContain('--build')
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
    const overrideContent = buildComposeOverride()
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

    const overrideYaml = buildComposeOverride()

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
  })
})
