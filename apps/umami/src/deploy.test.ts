import {describe, expect, it} from 'bun:test'

import {
  buildEnvFileContents,
  computeDbPasswordFingerprint,
  deploy,
  validateEnv,
  validateSecretValue,
  type SpawnFn,
  type SpawnResult,
} from './deploy'

// ─── Test helpers ─────────────────────────────────────────────────────────────

const VALID_ENV = {
  PATH: '/usr/bin:/bin',
  HOME: '/root',
  SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
  UMAMI_DOMAIN: 'metrics.fro.bot',
  UMAMI_APP_SECRET: 'supersecretappkey',
  UMAMI_DB_PASSWORD: 'dbpassword123',
  UMAMI_ADMIN_PASSWORD: 'adminpassword456',
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

/** Fake fetch that returns {"ok":true} for heartbeat. */
const fetchHeartbeatOk = async (_url: string, _opts?: RequestInit): Promise<Response> => {
  return new Response(JSON.stringify({ok: true}), {status: 200})
}

/** Fake fetch that always times out / fails. */
const fetchHeartbeatFail = async (_url: string, _opts?: RequestInit): Promise<Response> => {
  throw new Error('fetch failed')
}

// ─── env validation ───────────────────────────────────────────────────────────

describe('env validation', () => {
  it('accepts a fully valid env', () => {
    expect(() => validateEnv(VALID_ENV)).not.toThrow()
  })

  it('throws a specific message when UMAMI_DOMAIN is missing', () => {
    const env = {...VALID_ENV, UMAMI_DOMAIN: ''}
    expect(() => validateEnv(env)).toThrow('UMAMI_DOMAIN')
  })

  it('throws a specific message when UMAMI_APP_SECRET is missing', () => {
    const env = {...VALID_ENV, UMAMI_APP_SECRET: ''}
    expect(() => validateEnv(env)).toThrow('UMAMI_APP_SECRET')
  })

  it('throws a specific message when UMAMI_DB_PASSWORD is missing', () => {
    const env = {...VALID_ENV, UMAMI_DB_PASSWORD: ''}
    expect(() => validateEnv(env)).toThrow('UMAMI_DB_PASSWORD')
  })

  it('throws a specific message when UMAMI_ADMIN_PASSWORD is missing', () => {
    const env = {...VALID_ENV, UMAMI_ADMIN_PASSWORD: ''}
    expect(() => validateEnv(env)).toThrow('UMAMI_ADMIN_PASSWORD')
  })

  it('throws when PATH is missing', () => {
    const env = {...VALID_ENV, PATH: ''}
    expect(() => validateEnv(env)).toThrow('PATH')
  })

  it('throws when HOME is missing', () => {
    const env = {...VALID_ENV, HOME: ''}
    expect(() => validateEnv(env)).toThrow('HOME')
  })

  it('throws when SSH context is missing (no SSH_AUTH_SOCK, no UMAMI_SSH_KEY)', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: ''}
    expect(() => validateEnv(env)).toThrow(/SSH_AUTH_SOCK|UMAMI_SSH_KEY/)
  })

  it('accepts CI mode with UMAMI_SSH_KEY and no SSH_AUTH_SOCK', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: '', UMAMI_SSH_KEY: 'ssh-ed25519 AAAA...'}
    expect(() => validateEnv(env)).not.toThrow()
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

  it('rejects a value containing a carriage return', () => {
    expect(() => validateSecretValue('bad\rvalue', 'TEST')).toThrow()
  })

  it('rejects a value containing a backtick', () => {
    expect(() => validateSecretValue('bad`value', 'TEST')).toThrow()
  })

  it('rejects a value containing a dollar sign', () => {
    expect(() => validateSecretValue('bad$value', 'TEST')).toThrow()
  })

  it('rejects a value containing a pipe', () => {
    expect(() => validateSecretValue('bad|value', 'TEST')).toThrow()
  })

  it('rejects a value containing a semicolon', () => {
    expect(() => validateSecretValue('bad;value', 'TEST')).toThrow()
  })

  it('rejects a value containing an ampersand', () => {
    expect(() => validateSecretValue('bad&value', 'TEST')).toThrow()
  })

  it('rejects a value containing a single quote', () => {
    expect(() => validateSecretValue("bad'value", 'TEST')).toThrow()
  })

  it('rejects a value containing a double quote', () => {
    expect(() => validateSecretValue('bad"value', 'TEST')).toThrow()
  })

  it('rejects a value containing a backslash', () => {
    expect(() => validateSecretValue(String.raw`bad\value`, 'TEST')).toThrow()
  })
})

// ─── host validation guard ────────────────────────────────────────────────────

describe('host validation guard', () => {
  it('rejects a ProxyCommand-injection domain before any SSH argv is built', () => {
    const env = {...VALID_ENV, UMAMI_DOMAIN: '-oProxyCommand=x'}
    expect(() => validateEnv(env)).toThrow()
  })
})

// ─── .env file contents ───────────────────────────────────────────────────────

describe('.env file contents', () => {
  it('builds the correct .env file contents', () => {
    const contents = buildEnvFileContents({
      appSecret: 'mysecret',
      dbPassword: 'mydbpw',
      domain: 'metrics.fro.bot',
    })
    expect(contents).toContain('APP_SECRET=mysecret\n')
    expect(contents).toContain('POSTGRES_PASSWORD=mydbpw\n')
    expect(contents).toContain('DATABASE_URL=postgresql://umami:mydbpw@db:5432/umami\n')
    expect(contents).toContain('UMAMI_DOMAIN=metrics.fro.bot\n')
  })

  it('does not contain any extra keys beyond the four required', () => {
    const contents = buildEnvFileContents({
      appSecret: 'a',
      dbPassword: 'b',
      domain: 'c.example.com',
    })
    const lines = contents
      .split('\n')
      .filter(l => l.trim())
      .map(l => l.split('=')[0])
    expect(lines.sort()).toEqual(['APP_SECRET', 'DATABASE_URL', 'POSTGRES_PASSWORD', 'UMAMI_DOMAIN'].sort())
  })
})

// ─── db-password fingerprint guard ───────────────────────────────────────────

describe('db-password fingerprint guard', () => {
  it('computes a deterministic fingerprint for a given password', () => {
    const fp1 = computeDbPasswordFingerprint('mypassword')
    const fp2 = computeDbPasswordFingerprint('mypassword')
    expect(fp1).toBe(fp2)
  })

  it('produces different fingerprints for different passwords', () => {
    const fp1 = computeDbPasswordFingerprint('password1')
    const fp2 = computeDbPasswordFingerprint('password2')
    expect(fp1).not.toBe(fp2)
  })

  it('fingerprint does not contain the password', () => {
    const password = 'supersecretpassword'
    const fp = computeDbPasswordFingerprint(password)
    expect(fp).not.toContain(password)
  })

  it('refuses to deploy when sentinel exists with non-matching fingerprint', async () => {
    const existingFingerprint = computeDbPasswordFingerprint('oldpassword')
    const responses = [
      makeSpawnResult(), // mkdir -p
      makeSpawnResult(existingFingerprint), // cat sentinel
    ]
    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/rotation runbook|fingerprint|password/)
  })

  it('does not invoke compose when fingerprint guard blocks deploy', async () => {
    const existingFingerprint = computeDbPasswordFingerprint('oldpassword')
    const responses = [
      makeSpawnResult(), // mkdir -p
      makeSpawnResult(existingFingerprint), // cat sentinel
    ]
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow()

    const composeCalls = calls.filter(c => c.cmd.some(arg => arg.includes('docker compose')))
    expect(composeCalls).toHaveLength(0)
  })

  it('proceeds on first deploy when no sentinel exists', async () => {
    // All commands succeed; sentinel cat returns empty (no sentinel)
    const successResult = makeSpawnResult()
    const emptySentinelResult = makeSpawnResult('') // cat returns empty
    const responses = [
      successResult, // mkdir -p /opt/umami/config
      emptySentinelResult, // cat sentinel (absent)
      makeSpawnResult(), // write .env via stdin
      makeSpawnResult(), // scp docker-compose.yaml
      makeSpawnResult(), // scp Caddyfile
      makeSpawnResult(), // docker compose pull
      makeSpawnResult(), // docker compose up
      makeSpawnResult(), // write fingerprint sentinel
      makeSpawnResult(), // admin rotation: ssh curl login
      makeSpawnResult(), // admin rotation: ssh curl password update (if needed)
    ]
    const {spawnFn} = makeFakeSpawn(responses)

    // Should not throw
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).resolves.toBeUndefined()
  })

  it('writes fingerprint sentinel after healthy compose up, never the password', async () => {
    const successResult = makeSpawnResult()
    const emptySentinelResult = makeSpawnResult('')
    const responses = [
      successResult, // mkdir
      emptySentinelResult, // cat sentinel
      makeSpawnResult(), // write .env
      makeSpawnResult(), // scp compose
      makeSpawnResult(), // scp Caddyfile
      makeSpawnResult(), // compose pull
      makeSpawnResult(), // compose up
      makeSpawnResult(), // write sentinel
      makeSpawnResult(), // admin rotation
      makeSpawnResult(),
    ]
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    // Find the sentinel write call (stdin pipe call writing a hash)
    const sentinelWrite = calls.find(c => {
      const isStdinCall = c.stdinData.length > 0
      const isNotEnvFile = !c.stdinData.includes('APP_SECRET')
      const isNotAdminRotation = !c.stdinData.includes('password')
      return isStdinCall && isNotEnvFile && isNotAdminRotation
    })

    expect(sentinelWrite).toBeDefined()
    // Sentinel must not contain the password
    expect(sentinelWrite?.stdinData).not.toContain(VALID_ENV.UMAMI_DB_PASSWORD)
    // Sentinel should look like a hex hash
    expect(sentinelWrite?.stdinData.trim()).toMatch(/^[0-9a-f]{64}$/)
  })

  it('proceeds normally when fingerprint matches', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = [
      makeSpawnResult(), // mkdir
      makeSpawnResult(matchingFingerprint), // cat sentinel (matches)
      makeSpawnResult(), // write .env
      makeSpawnResult(), // scp compose
      makeSpawnResult(), // scp Caddyfile
      makeSpawnResult(), // compose pull
      makeSpawnResult(), // compose up
      makeSpawnResult(), // write sentinel
      makeSpawnResult(), // admin rotation
      makeSpawnResult(),
    ]
    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── secrets never in argv ────────────────────────────────────────────────────

describe('secrets never in argv', () => {
  it('does not place any secret value in any constructed argv', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint) // sentinel matches

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const secrets = [VALID_ENV.UMAMI_APP_SECRET, VALID_ENV.UMAMI_DB_PASSWORD, VALID_ENV.UMAMI_ADMIN_PASSWORD]

    for (const call of calls) {
      for (const secret of secrets) {
        const argvStr = call.cmd.join(' ')
        expect(argvStr).not.toContain(secret)
      }
    }
  })

  it('places .env contents in stdin, not argv', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    // Find the .env write call
    const envFileWrite = calls.find(c => c.stdinData.includes('APP_SECRET'))
    expect(envFileWrite).toBeDefined()
    // The secret must be in stdin, not in the cmd
    expect(envFileWrite?.cmd.join(' ')).not.toContain(VALID_ENV.UMAMI_APP_SECRET)
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
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/DNS|resolve|metrics\.fro\.bot/)
  })
})

// ─── Caddy ACME lag (public probe) ───────────────────────────────────────────

describe('public HTTPS probe', () => {
  it('succeeds with a warning when containers are healthy but public probe never returns ok', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)

    const {spawnFn} = makeFakeSpawn(responses)

    // Should resolve (not throw) even when fetch always fails
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatFail,
        probeAttempts: 2,
        probeIntervalMs: 10,
      }),
    ).resolves.toBeUndefined()
  })

  it('succeeds without warning when public probe returns ok', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
        probeAttempts: 2,
        probeIntervalMs: 10,
      }),
    ).resolves.toBeUndefined()
  })
})

// ─── admin password rotation ──────────────────────────────────────────────────

describe('admin password rotation', () => {
  it('skips rotation when default login fails (already rotated)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    // The admin rotation SSH call returns exit code 1 (login failed)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // Admin rotation call: login fails (non-zero exit or empty token in stdout)
    responses[8] = makeSpawnResult('{"token":null}', '', 0)

    const {spawnFn} = makeFakeSpawn(responses)

    // Should not throw — idempotent
    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).resolves.toBeUndefined()
  })

  it('does not place admin password in any argv', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // Simulate successful login returning a token
    responses[8] = makeSpawnResult(JSON.stringify({token: 'test-jwt-token'}), '', 0)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toContain(VALID_ENV.UMAMI_ADMIN_PASSWORD)
    }
  })
})

// ─── CI mode (UMAMI_SSH_KEY) ──────────────────────────────────────────────────

describe('CI mode with UMAMI_SSH_KEY', () => {
  it('accepts CI env with UMAMI_SSH_KEY and no SSH_AUTH_SOCK', () => {
    const env = {...VALID_ENV, SSH_AUTH_SOCK: '', UMAMI_SSH_KEY: 'ssh-ed25519 AAAA...'}
    expect(() => validateEnv(env)).not.toThrow()
  })

  it('does not place the SSH key content in any argv', async () => {
    const ciEnv = {...VALID_ENV, SSH_AUTH_SOCK: '', UMAMI_SSH_KEY: 'ssh-ed25519 AAAA-UNIQUE-KEY-CONTENT'}
    const matchingFingerprint = computeDbPasswordFingerprint(ciEnv.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: ciEnv,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toContain('AAAA-UNIQUE-KEY-CONTENT')
    }
  })
})
