import {describe, expect, it} from 'bun:test'

import {
  buildEnvFileContents,
  computeDbPasswordFingerprint,
  computeRetentionReleaseHash,
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
 * `responses` is consumed in order; additional calls receive fresh successful
 * results so a response stream is never consumed twice.
 */
function makeFakeSpawn(
  responses: SpawnResult[],
  override?: (cmd: string[], callIndex: number) => SpawnResult | undefined,
): {spawnFn: SpawnFn; calls: SpawnCall[]} {
  const calls: SpawnCall[] = []
  let idx = 0

  const spawnFn: SpawnFn = (cmd, opts) => {
    const call: SpawnCall = {cmd: [...cmd], stdinData: ''}

    const callIndex = idx++
    const command = cmd.join(' ')
    const result =
      override?.(cmd, callIndex) ??
      (command.includes('systemctl is-active')
        ? makeSpawnResult('inactive\n', '', 3)
        : command.includes('systemctl is-enabled')
          ? makeSpawnResult('disabled\n', '', 1)
          : (responses[callIndex] ?? makeSpawnResult()))

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

  it('rejects UMAMI_ADMIN_PASSWORD shorter than 8 characters', () => {
    const env = {...VALID_ENV, UMAMI_ADMIN_PASSWORD: 'short'}
    expect(() => validateEnv(env)).toThrow(/UMAMI_ADMIN_PASSWORD.*8 characters/)
  })

  it('accepts UMAMI_ADMIN_PASSWORD of exactly 8 characters', () => {
    const env = {...VALID_ENV, UMAMI_ADMIN_PASSWORD: 'exactly8'}
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
  it('skips rotation when default login returns no token (already rotated)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    // idx 7: login returns exit 0 with no token → treated as already rotated (skip)
    const responses = Array.from({length: 15}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    responses[7] = makeSpawnResult('{"token":null}', '', 0)

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
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login succeeds with token
    responses[7] = makeSpawnResult(JSON.stringify({token: 'test-jwt-token'}), '', 0)
    // idx 8: write curl config (token via stdin)
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify new password login succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify default login fails
    responses[11] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

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

// ─── exec-reachability: rotation runs inside the umami container ──────────────
//
// New call order (with matching fingerprint, already-rotated login):
//   0: mkdir
//   1: cat fingerprint
//   2: write .env
//   3: scp compose
//   4: scp Caddyfile
//   5: compose pull
//   6: compose up db umami
//   7: rotation login curl  ← rotation starts here
//   8: compose up caddy     ← after rotation
//   9: write sentinel
//
// With full rotation (login succeeds):
//   7: rotation login curl
//   8: write curl config (token via stdin)
//   9: update curl
//  10: verify new password login
//  11: verify default login fails
//  12: compose up caddy
//  13: write sentinel

describe('rotation runs inside the umami container via docker compose exec', () => {
  it('login curl runs inside the umami container, not on the droplet host', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login already rotated (exit 22)
    responses[7] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const loginCall = calls.find(c => c.cmd.join(' ').includes('/api/auth/login'))
    expect(loginCall).toBeDefined()
    // Must use docker compose exec -T umami, not bare ssh curl on host
    const cmdStr = loginCall?.cmd.join(' ') ?? ''
    expect(cmdStr).toContain('docker compose exec')
    expect(cmdStr).toContain('-T')
    expect(cmdStr).toContain('umami')
  })

  it('password-update curl runs inside the umami container, not on the droplet host', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login succeeds with token
    responses[7] = makeSpawnResult(JSON.stringify({token: 'tok-abc'}), '', 0)
    // idx 8: write curl config file (token via stdin)
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update curl succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify: re-login with new password succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify: re-login with default umami fails (exit 22)
    responses[11] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const updateCall = calls.find(c => c.cmd.join(' ').includes('/api/me/password'))
    expect(updateCall).toBeDefined()
    const cmdStr = updateCall?.cmd.join(' ') ?? ''
    expect(cmdStr).toContain('docker compose exec')
    expect(cmdStr).toContain('-T')
    expect(cmdStr).toContain('umami')
  })

  it('sends currentPassword and newPassword in the password-update request body', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login succeeds with token
    responses[7] = makeSpawnResult(JSON.stringify({token: 'tok-abc'}), '', 0)
    // idx 8: write curl config file (token via stdin)
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update curl succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify new password login succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify default login fails (exit 22)
    responses[11] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    // Find the update call — stdin carries the request body
    const updateCall = calls.find(c => c.cmd.join(' ').includes('/api/me/password'))
    expect(updateCall).toBeDefined()
    const body = JSON.parse(updateCall?.stdinData ?? '{}') as Record<string, string>
    expect(body.currentPassword).toBe('umami')
    expect(body.newPassword).toBe(VALID_ENV.UMAMI_ADMIN_PASSWORD)
    expect(body).not.toHaveProperty('password')
  })
})

// ─── G1: rotation fails closed ────────────────────────────────────────────────

describe('rotation fails closed on connection/transport failure', () => {
  it('throws when login curl cannot reach umami (connection refused, exit 7)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login curl: connection refused (exit 7)
    responses[7] = makeSpawnResult('', 'curl: (7) Failed to connect', 7)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/cannot reach umami|admin credentials/)
  })

  it('skips rotation (idempotent) when login is cleanly rejected with HTTP 401 (exit 22)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login curl: HTTP 401 → --fail-with-body exits 22
    responses[7] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

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

  it('throws when password-update curl fails (non-zero exit)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login succeeds
    responses[7] = makeSpawnResult(JSON.stringify({token: 'tok-abc'}), '', 0)
    // idx 8: write curl config file
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update curl fails
    responses[9] = makeSpawnResult('', 'error', 1)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow()
  })

  it('throws when post-rotation verification fails (new password login rejected)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login with default succeeds
    responses[7] = makeSpawnResult(JSON.stringify({token: 'tok-abc'}), '', 0)
    // idx 8: write curl config file
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify: re-login with new password FAILS (exit 22 — bad creds)
    responses[10] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/verification|rotate|password/)
  })

  it('throws when post-rotation verification finds default password still works', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login with default succeeds
    responses[7] = makeSpawnResult(JSON.stringify({token: 'tok-abc'}), '', 0)
    // idx 8: write curl config file
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify: re-login with new password succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify: re-login with default umami STILL succeeds (rotation didn't stick)
    responses[11] = makeSpawnResult(JSON.stringify({token: 'tok-default-still-works'}), '', 0)

    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/verification|rotate|password/)
  })
})

// ─── G2: Caddy starts after rotation (no public default-credential window) ────

describe('Caddy starts after admin rotation completes', () => {
  it('caddy up spawn happens after the rotation login curl spawn', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login already rotated (exit 22)
    responses[7] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const caddyUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('caddy')
    })
    const loginCurlIdx = calls.findIndex(c => c.cmd.join(' ').includes('/api/auth/login'))

    expect(caddyUpIdx).toBeGreaterThan(-1)
    expect(loginCurlIdx).toBeGreaterThan(-1)
    // caddy up must come AFTER the login curl
    expect(caddyUpIdx).toBeGreaterThan(loginCurlIdx)
  })

  it('db and umami start before caddy (internal-only phase)', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    // idx 7: login already rotated
    responses[7] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const dbUmamiUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('db') && s.includes('umami') && !s.includes('caddy')
    })
    const caddyUpIdx = calls.findIndex(c => {
      const s = c.cmd.join(' ')
      return s.includes('docker compose up') && s.includes('caddy')
    })

    expect(dbUmamiUpIdx).toBeGreaterThan(-1)
    expect(caddyUpIdx).toBeGreaterThan(-1)
    expect(dbUmamiUpIdx).toBeLessThan(caddyUpIdx)
  })
})

// ─── G3: fingerprint guard must not bypass on read error ─────────────────────

describe('fingerprint guard does not bypass on SSH/read error', () => {
  it('proceeds on first deploy when sentinel is absent (file-not-found exit)', async () => {
    // cat returns exit 1 with "No such file" — treated as first deploy
    // Call order: mkdir(0), cat-absent(1), write-env(2), scp-compose(3),
    //   scp-Caddyfile(4), compose-pull(5), compose-up-db-umami(6),
    //   rotation-login-exit22(7), compose-up-caddy(8), write-sentinel(9)
    const responses = [
      makeSpawnResult(), // 0: mkdir
      makeSpawnResult('cat: /opt/umami/.db-password-fingerprint: No such file or directory', '', 1), // 1: cat absent
      makeSpawnResult(), // 2: write .env
      makeSpawnResult(), // 3: scp compose
      makeSpawnResult(), // 4: scp Caddyfile
      makeSpawnResult(), // 5: compose pull
      makeSpawnResult(), // 6: compose up db umami
      makeSpawnResult('{"message":"Incorrect username or password"}', '', 22), // 7: rotation login (already rotated)
      makeSpawnResult(), // 8: compose up caddy
      makeSpawnResult(), // 9: write sentinel
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

  it('aborts with a distinct message when SSH transport fails reading sentinel (non-missing error)', async () => {
    // exit 255 = SSH connection failure (not file-not-found)
    const responses = [
      makeSpawnResult(), // mkdir
      makeSpawnResult('ssh: connect to host metrics.fro.bot port 22: Connection refused', '', 255), // ssh failure
    ]
    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/fingerprint|sentinel|read|ssh/i)
  })

  it('proceeds when sentinel is present and fingerprint matches', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint, '', 0)
    // idx 7: login already rotated
    responses[7] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

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

  it('aborts when sentinel is present and fingerprint mismatches', async () => {
    const wrongFingerprint = computeDbPasswordFingerprint('completely-different-password')
    const responses = [
      makeSpawnResult(), // mkdir
      makeSpawnResult(wrongFingerprint, '', 0), // cat sentinel (mismatch)
    ]
    const {spawnFn} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/fingerprint|rotation runbook|password/)
  })
})

// ─── G4: URL-encode DB password in DATABASE_URL ───────────────────────────────

describe('DATABASE_URL percent-encodes URL-reserved characters in the password', () => {
  it('encodes @ : / # % in the DATABASE_URL userinfo but keeps POSTGRES_PASSWORD raw', () => {
    const specialPassword = 'p@ss:w/o#r%d'
    const contents = buildEnvFileContents({
      appSecret: 'secret',
      dbPassword: specialPassword,
      domain: 'metrics.fro.bot',
    })

    // POSTGRES_PASSWORD must be the raw value
    expect(contents).toContain(`POSTGRES_PASSWORD=${specialPassword}\n`)

    // DATABASE_URL must percent-encode the reserved chars
    const urlLine = contents.split('\n').find(l => l.startsWith('DATABASE_URL=')) ?? ''
    expect(urlLine).toBeTruthy()
    // Extract the userinfo portion (between :// and @db)
    const match = urlLine.match(/DATABASE_URL=postgresql:\/\/umami:(.+)@db:5432\/umami/)
    expect(match).toBeDefined()
    const encodedPassword = match?.[1] ?? ''
    expect(encodedPassword).toBeTruthy()

    // Must not contain raw reserved chars
    expect(encodedPassword).not.toContain('@')
    expect(encodedPassword).not.toContain(':')
    expect(encodedPassword).not.toContain('/')
    expect(encodedPassword).not.toContain('#')
    // % is only allowed as part of percent-encoding sequences
    expect(encodedPassword).toMatch(/^[\w\-.~!$&'()*+,;=%]+$/)
    // Must decode back to the original password
    expect(decodeURIComponent(encodedPassword)).toBe(specialPassword)
  })

  it('leaves a plain alphanumeric password unchanged in DATABASE_URL', () => {
    const plainPassword = 'plainpassword123'
    const contents = buildEnvFileContents({
      appSecret: 'secret',
      dbPassword: plainPassword,
      domain: 'metrics.fro.bot',
    })
    expect(contents).toContain(`DATABASE_URL=postgresql://umami:${plainPassword}@db:5432/umami\n`)
  })
})

// ─── G5: bearer token never in argv ──────────────────────────────────────────

describe('bearer token never appears in any spawned argv', () => {
  it('does not place the JWT bearer token in any argv during rotation', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.UNIQUE-TOKEN-VALUE'
    // idx 7: login succeeds with token
    responses[7] = makeSpawnResult(JSON.stringify({token: fakeToken}), '', 0)
    // idx 8: write curl config file (token via stdin)
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update curl succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify: new password login succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify: default umami login fails
    responses[11] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    for (const call of calls) {
      expect(call.cmd.join(' ')).not.toContain(fakeToken)
      expect(call.cmd.join(' ')).not.toContain('UNIQUE-TOKEN-VALUE')
    }
  })

  it('passes the bearer token via stdin (curl config file), not argv', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 20}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    const fakeToken = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.UNIQUE-TOKEN-VALUE'
    // idx 7: login succeeds with token
    responses[7] = makeSpawnResult(JSON.stringify({token: fakeToken}), '', 0)
    // idx 8: write curl config file
    responses[8] = makeSpawnResult('', '', 0)
    // idx 9: update curl succeeds
    responses[9] = makeSpawnResult(JSON.stringify({ok: true}), '', 0)
    // idx 10: verify: new password login succeeds
    responses[10] = makeSpawnResult(JSON.stringify({token: 'tok-new'}), '', 0)
    // idx 11: verify: default umami login fails
    responses[11] = makeSpawnResult('{"message":"Incorrect username or password"}', '', 22)

    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    // The token must appear in stdin of some call (the curl config write)
    const tokenInStdin = calls.some(c => c.stdinData.includes(fakeToken))
    expect(tokenInStdin).toBe(true)
  })
})

// ─── retention deployment integration ─────────────────────────────────────────

describe('retention deployment integration', () => {
  it('computes a deterministic content-addressed hash from all runtime artifact bytes', () => {
    const encoder = new TextEncoder()
    const artifacts = {
      retentionScript: encoder.encode('script-v1'),
      retentionCheckSql: encoder.encode('check-v1'),
      retentionApplySql: encoder.encode('apply-v1'),
      retentionServiceUnit: encoder.encode('service-v1'),
      retentionTimerUnit: encoder.encode('timer-v1'),
    }

    const first = computeRetentionReleaseHash(artifacts)
    const second = computeRetentionReleaseHash(artifacts)
    const changed = computeRetentionReleaseHash({...artifacts, retentionApplySql: encoder.encode('apply-v2')})
    const changedUnit = computeRetentionReleaseHash({...artifacts, retentionTimerUnit: encoder.encode('timer-v2')})

    expect(first).toMatch(/^[0-9a-f]{64}$/)
    expect(second).toBe(first)
    expect(changed).not.toBe(first)
    expect(changedUnit).not.toBe(first)
  })

  it('uploads exact retention artifacts and systemd units before host verification and reload', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 30}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const scpCalls = calls.filter(call => call.cmd[0] === 'scp')
    const expectedUploads = [
      ['retention.sh', '/opt/umami/retention/staging/'],
      ['retention-check.sql', '/opt/umami/retention/staging/'],
      ['retention.sql', '/opt/umami/retention/staging/'],
      ['umami-retention.service', '/opt/umami/retention/systemd-staging/'],
      ['umami-retention.timer', '/opt/umami/retention/systemd-staging/'],
    ] as const

    const uploadIndexes = expectedUploads.map(([sourceName, destination]) => {
      const index = calls.findIndex(call => {
        const command = call.cmd.join(' ')
        return call.cmd[0] === 'scp' && command.includes(`/${sourceName}`) && command.includes(destination)
      })
      expect(index).toBeGreaterThan(-1)
      return index
    })

    expect(scpCalls).toHaveLength(7)
    expect(new Set(uploadIndexes).size).toBe(expectedUploads.length)
    expect(
      scpCalls
        .filter(call => call.cmd.join(' ').includes('/opt/umami/retention/systemd-staging/'))
        .every(call => /\/systemd-staging\/[0-9a-f]{64}\//.test(call.cmd.join(' '))),
    ).toBe(true)

    const permissionIndex = calls.findIndex(call => call.cmd.join(' ').includes('chmod 0755'))
    const shellVerifyIndex = calls.findIndex(call => call.cmd.join(' ').includes('bash -n'))
    const currentSwapIndex = calls.findIndex(
      call => call.cmd.join(' ').includes('mv -Tf') && call.cmd.join(' ').includes('/opt/umami/retention/current'),
    )
    const unitVerifyIndex = calls.findIndex(call => call.cmd.join(' ').includes('systemd-analyze verify'))
    const serviceInstallIndex = calls.findIndex(call => call.cmd.join(' ').includes('umami-retention.service.tmp'))
    const reloadIndex = calls.findIndex(call => call.cmd.join(' ').includes('systemctl daemon-reload'))

    expect(permissionIndex).toBeGreaterThan(-1)
    expect(shellVerifyIndex).toBeGreaterThan(permissionIndex)
    expect(currentSwapIndex).toBeGreaterThan(shellVerifyIndex)
    expect(unitVerifyIndex).toBeGreaterThan(shellVerifyIndex)
    expect(unitVerifyIndex).toBeGreaterThanOrEqual(currentSwapIndex)
    const promotionCommand = calls[currentSwapIndex]?.cmd.join(' ') ?? ''
    expect(promotionCommand.indexOf('mv -Tf')).toBeLessThan(promotionCommand.indexOf('systemd-analyze verify'))
    expect(serviceInstallIndex).toBeGreaterThan(unitVerifyIndex)
    expect(reloadIndex).toBeGreaterThan(unitVerifyIndex)
    for (const uploadIndex of uploadIndexes) {
      expect(uploadIndex).toBeLessThan(permissionIndex)
      expect(uploadIndex).toBeLessThan(unitVerifyIndex)
      expect(uploadIndex).toBeLessThan(reloadIndex)
    }

    expect(
      calls.filter(call => call.cmd[0] === 'scp').every(call => !call.cmd.join(' ').includes('/etc/systemd/system/')),
    ).toBe(true)
    expect(commandGraph(calls)).toContain('ln -s')
    expect(commandGraph(calls)).toContain('mv -Tf')
    expect(commandGraph(calls)).toMatch(/\/opt\/umami\/retention\/releases\/[0-9a-f]{64}/)
    expect(commandGraph(calls)).toContain('/opt/umami/retention/current')
    expect(commandGraph(calls)).toContain('timeout 60s systemd-analyze verify')
    expect(commandGraph(calls)).toContain('timeout 60s systemctl daemon-reload')
  })

  it('does not touch current when a runtime upload is interrupted', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 40}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    responses[11] = makeSpawnResult('', 'interrupted upload', 1)
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow()

    const graph = commandGraph(calls)
    expect(graph).toContain('/opt/umami/retention/staging/')
    expect(graph).not.toContain('mv -Tf')
    expect(graph).not.toContain('systemctl daemon-reload')
  })

  it('does not touch current when staged runtime validation fails', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 40}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    responses[17] = makeSpawnResult('', 'invalid staged runtime', 1)
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow()

    const graph = commandGraph(calls)
    expect(graph).toContain('bash -n')
    expect(graph).not.toContain('mv -Tf')
    expect(graph).not.toContain('systemd-analyze verify')
  })

  it('rolls current back when staged unit verification fails before unit installation', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 40}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    responses[18] = makeSpawnResult('', 'systemd-analyze failed', 1)
    const {spawnFn, calls} = makeFakeSpawn(responses)

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow()

    const graph = commandGraph(calls)
    expect(graph).toContain('trap rollback_on_error EXIT')
    expect(graph).toContain('restore_current()')
    expect(graph).toContain('ln -s "$previous_target" "$rollback"')
    expect(graph).toContain('mv -Tf "$rollback" "$current"')
    expect(graph).not.toContain('Installing retention service unit atomically')
    expect(graph).not.toContain('Installing retention timer unit atomically')
    expect(graph).not.toContain('systemctl daemon-reload')
    expect(graph).not.toContain('systemctl restart umami-retention.timer')
    expect(graph).not.toContain('systemctl start umami-retention.timer')
  })

  it('propagates a systemd timeout without mutating timer state', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 40}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    const {spawnFn, calls} = makeFakeSpawn(responses, command => {
      if (command.join(' ').includes('systemctl is-active')) {
        return makeSpawnResult('', 'systemctl timed out', 124)
      }
      return undefined
    })

    await expect(
      deploy({
        env: VALID_ENV,
        spawn: spawnFn,
        resolve: resolvesOk,
        fetch: fetchHeartbeatOk,
      }),
    ).rejects.toThrow(/exit 124/)

    const graph = commandGraph(calls)
    expect(graph).toContain('timeout 60s systemctl is-active umami-retention.timer')
    expect(graph).not.toContain('systemctl is-enabled umami-retention.timer')
    expect(graph).not.toContain('systemctl restart umami-retention.timer')
    expect(graph).not.toContain('systemctl start umami-retention.timer')
  })

  it('refreshes an active timer with bounded restart and no start', async () => {
    const matchingFingerprint = computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD)
    const responses = Array.from({length: 30}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(matchingFingerprint)
    const {spawnFn, calls} = makeFakeSpawn(responses, command => {
      const commandText = command.join(' ')
      if (commandText.includes('systemctl is-active')) return makeSpawnResult('active\n')
      return undefined
    })

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const reloadIndex = calls.findIndex(call => call.cmd.join(' ').includes('systemctl daemon-reload'))
    const restartIndex = calls.findIndex(call => call.cmd.join(' ').includes('systemctl restart umami-retention.timer'))
    const startIndex = calls.findIndex(call => call.cmd.join(' ').includes('systemctl start umami-retention.timer'))
    const activeIndex = calls.findIndex(call =>
      call.cmd.join(' ').includes('systemctl is-active umami-retention.timer'),
    )

    expect(reloadIndex).toBeGreaterThan(-1)
    expect(activeIndex).toBeGreaterThan(reloadIndex)
    expect(restartIndex).toBeGreaterThan(activeIndex)
    expect(startIndex).toBe(-1)
    expect(commandGraph(calls)).toContain('timeout 60s systemctl restart umami-retention.timer')
  })

  it('starts an enabled but inactive timer after daemon-reload', async () => {
    const responses = Array.from({length: 30}, () => makeSpawnResult())
    responses[1] = makeSpawnResult(computeDbPasswordFingerprint(VALID_ENV.UMAMI_DB_PASSWORD))
    const {spawnFn, calls} = makeFakeSpawn(responses, command => {
      const commandText = command.join(' ')
      if (commandText.includes('systemctl is-active')) return makeSpawnResult('inactive\n', '', 3)
      if (commandText.includes('systemctl is-enabled')) return makeSpawnResult('enabled\n')
      return undefined
    })

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const graph = commandGraph(calls)
    expect(graph).toContain('timeout 60s systemctl is-enabled umami-retention.timer')
    expect(graph).toContain('timeout 60s systemctl start umami-retention.timer')
    expect(graph).not.toContain('systemctl restart umami-retention.timer')
    expect(graph).not.toContain('systemctl enable')
  })

  it('leaves a disabled inactive timer untouched and never runs retention during deploy', async () => {
    const responses = Array.from({length: 30}, () => makeSpawnResult())
    responses[1] = makeSpawnResult('')
    const {spawnFn, calls} = makeFakeSpawn(responses, command => {
      const commandText = command.join(' ')
      if (commandText.includes('systemctl is-active')) return makeSpawnResult('inactive\n', '', 3)
      if (commandText.includes('systemctl is-enabled')) return makeSpawnResult('disabled\n', '', 1)
      return undefined
    })

    await deploy({
      env: VALID_ENV,
      spawn: spawnFn,
      resolve: resolvesOk,
      fetch: fetchHeartbeatOk,
    })

    const graph = commandGraph(calls)
    expect(graph).not.toContain('systemctl restart umami-retention.timer')
    expect(graph).not.toContain('systemctl start umami-retention.timer')
    expect(graph).not.toContain('systemctl enable')
    expect(graph).not.toContain('retention.sh --apply')
    expect(graph).not.toContain('retention.sh --check')
    expect(graph).not.toMatch(/(?:docker compose|psql).*retention(?:\.sql|\.sh)/)
  })
})

function commandGraph(calls: SpawnCall[]): string {
  return calls.map(call => call.cmd.join(' ')).join('\n')
}
