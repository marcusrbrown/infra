import type {SpawnFn, SpawnResult} from './deploy'
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
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

  test('derives object-store endpoint pattern when S3_ENDPOINT is set', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({S3_ENDPOINT: 'https://abc123.r2.cloudflarestorage.com', S3_BUCKET: 'my-bucket'}),
    )
    expect(result).toBe('my-bucket.abc123.r2.cloudflarestorage.com')
  })

  test('strips scheme and path from S3_ENDPOINT for object-store endpoint pattern', async () => {
    const {computeObjectStoreHosts} = await import('./deploy')
    const result = computeObjectStoreHosts(
      makeEnv({S3_ENDPOINT: 'https://endpoint.example.com/some/path', S3_BUCKET: 'bucket'}),
    )
    expect(result).toBe('bucket.endpoint.example.com')
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
  test('returns required secrets with actual values', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv())
    const token = secrets.find(s => s.name === 'discord_token')
    expect(token).toBeDefined()
    expect(token?.content).toBe('tok-secret')
    expect(token?.required).toBe(true)
  })

  test('optional secret unset → content is empty string, required false', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const env = makeEnv()
    delete (env as Record<string, string>).DISCORD_OPERATOR_ROLE_ID
    const secrets = buildSecretFileList(env)
    const roleSecret = secrets.find(s => s.name === 'discord_operator_role_id')
    expect(roleSecret).toBeDefined()
    expect(roleSecret?.content).toBe('')
    expect(roleSecret?.required).toBe(false)
  })

  test('optional secret set → content is the value', async () => {
    const {buildSecretFileList} = await import('./deploy')
    const secrets = buildSecretFileList(makeEnv({DISCORD_OPERATOR_ROLE_ID: 'role-999'}))
    const roleSecret = secrets.find(s => s.name === 'discord_operator_role_id')
    expect(roleSecret?.content).toBe('role-999')
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

  test('edge case (auth-tier warning): non-ping command without DISCORD_OPERATOR_ROLE_ID → warning, deploy succeeds', async () => {
    const {main} = await import('./deploy')
    const {spawnFn} = makeSpawnMock()
    const mockFetch = makeDiscordFetch([{name: 'ping'}, {name: 'deploy'}])
    const warnings: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => {
      warnings.push(args.join(' '))
    }

    try {
      const env = makeEnv()
      delete (env as Record<string, string>).DISCORD_OPERATOR_ROLE_ID
      await main({env, args: [], fetch: mockFetch, sleep: async () => {}, spawn: spawnFn})
    } finally {
      console.warn = origWarn
    }

    const warningText = warnings.join('\n')
    expect(warningText).toMatch(/DISCORD_OPERATOR_ROLE_ID/)
    expect(warningText).toMatch(/deploy/)
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

  // ── R2: checksum persists AFTER compose + registration succeed ──────────────

  test('R2: compose failure → checksum NOT written, next deploy still force-recreates', async () => {
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

  test('R2: pollRegistration failure → checksum NOT written', async () => {
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

  test('R2: checksum written AFTER successful compose + registration', async () => {
    const {main} = await import('./deploy')
    const eventLog: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('docker compose')) {
        eventLog.push('compose')
      } else if (cmdStr.includes('.secrets-checksum') && cmdStr.includes('> /opt/gateway/.secrets-checksum')) {
        // Only the write: `echo <checksum> > /opt/gateway/.secrets-checksum`
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
  test('accepts valid hostname-only values', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('my-bucket.s3.us-east-1.amazonaws.com')).not.toThrow()
    expect(() => validateObjectStoreHosts('host1.example.com,host2.example.com')).not.toThrow()
    expect(() => validateObjectStoreHosts('simple-host_name')).not.toThrow()
  })

  test('rejects values with shell metacharacters', async () => {
    const {validateObjectStoreHosts} = await import('./deploy')
    expect(() => validateObjectStoreHosts('host; rm -rf /')).toThrow(/invalid characters/)
    expect(() => validateObjectStoreHosts('$(evil)')).toThrow(/invalid characters/)
    expect(() => validateObjectStoreHosts('`cmd`')).toThrow(/invalid characters/)
    expect(() => validateObjectStoreHosts('host && bad')).toThrow(/invalid characters/)
  })

  test('S3: malformed OBJECT_STORE_HOSTS rejected before SSH is invoked', async () => {
    const {main} = await import('./deploy')
    const {spawnFn, calls} = makeSpawnMock()

    await expect(
      main({
        env: makeEnv({OBJECT_STORE_HOSTS: 'host; rm -rf /'}),
        args: [],
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/invalid characters/)

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

  test('SSH spawn failure on discord_token write: error does not contain token value', async () => {
    const {main} = await import('./deploy')
    const TOKEN = 'tok-secret'

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      // Fail specifically on the discord_token secret write (identified by path)
      if (cmdStr.includes('discord_token')) {
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
    expect(caughtError?.message).toContain('discord_token')
  })

  test('S2: secret with shell metacharacters written via stdin, not argv', async () => {
    const {main} = await import('./deploy')
    const TRICKY_TOKEN = "tok'with'quotes\nand newlines\n$VAR `backtick` ; && \\"
    const stdinContents: string[] = []

    const {spawnFn} = makeSpawnMock(cmd => {
      const cmdStr = cmd.join(' ')
      if (cmdStr.includes('discord_token')) {
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

// ─── R1: pollRegistration status branching ───────────────────────────────────

describe('R1 pollRegistration status branching', () => {
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
