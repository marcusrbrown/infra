import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {
  getUmamiComposeStatus,
  getUmamiStatusSummary,
  parseComposePs,
  parseComposePsOutput,
  umamiStatusAction,
  type ComposePsEntry,
  type ServiceRow,
} from './status'

// ─── parseComposePsOutput ─────────────────────────────────────────────────────

describe('parseComposePsOutput', () => {
  it('parses NDJSON output (one JSON object per line)', () => {
    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const entries = parseComposePsOutput(ndjson)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({Name: 'umami', State: 'running', Health: 'healthy'})
    expect(entries[1]).toEqual({Name: 'db', State: 'running', Health: ''})
  })

  it('parses JSON-array output (legacy compose format)', () => {
    const jsonArray = JSON.stringify([
      {Name: 'umami', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ])

    const entries = parseComposePsOutput(jsonArray)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({Name: 'umami', State: 'running', Health: 'healthy'})
  })

  it('returns empty array for empty string', () => {
    expect(parseComposePsOutput('')).toEqual([])
  })

  it('returns empty array for whitespace-only string', () => {
    expect(parseComposePsOutput('   \n  ')).toEqual([])
  })
})

// ─── parseComposePs ──────────────────────────────────────────────────────────

describe('parseComposePs', () => {
  it('maps running services with healthy status', () => {
    const raw: ComposePsEntry[] = [
      {Name: 'umami', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ]

    const rows = parseComposePs(raw)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({service: 'umami', state: 'running', health: 'healthy'} satisfies ServiceRow)
    expect(rows[1]).toEqual({service: 'db', state: 'running', health: 'n-a'} satisfies ServiceRow)
  })

  it('maps exited state', () => {
    const raw: ComposePsEntry[] = [{Name: 'umami', State: 'exited', Health: ''}]

    const rows = parseComposePs(raw)

    expect(rows[0]).toEqual({service: 'umami', state: 'exited', health: 'n-a'} satisfies ServiceRow)
  })

  it('maps unhealthy health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'umami', State: 'running', Health: 'unhealthy'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('unhealthy')
  })

  it('maps starting health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'umami', State: 'running', Health: 'starting'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('starting')
  })

  it('maps unknown health values to n-a', () => {
    const raw: ComposePsEntry[] = [{Name: 'umami', State: 'running', Health: 'something-weird'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('n-a')
  })

  it('returns empty array for empty input', () => {
    expect(parseComposePs([])).toEqual([])
  })
})

// ─── getUmamiComposeStatus (SSH mocked via SpawnFn) ──────────────────────────

type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawn(stdout: string, stderr = '', exitCode = 0): SpawnFn {
  return (_cmd, _opts) => {
    const enc = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(stdout))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(enc.encode(stderr))
          controller.close()
        },
      }),
      exited: Promise.resolve(exitCode),
    }
  }
}

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('getUmamiComposeStatus — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh when the file exists', async () => {
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'umami', State: 'running', Health: 'healthy'}])))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        exited: Promise.resolve(0),
      }
    }

    await getUmamiComposeStatus('metrics.fro.bot', capturingSpawn)

    // Find the UserKnownHostsFile option in the ssh command
    const knownHostsIdx = capturedCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(capturedCmd[knownHostsIdx - 1]).toBe('-o')
    expect(capturedCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('does not weaken StrictHostKeyChecking when UserKnownHostsFile is added', async () => {
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'umami', State: 'running', Health: 'healthy'}])))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        exited: Promise.resolve(0),
      }
    }

    await getUmamiComposeStatus('metrics.fro.bot', capturingSpawn)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})

describe('getUmamiComposeStatus', () => {
  it('returns service rows from NDJSON output', async () => {
    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const result = await getUmamiComposeStatus('metrics.fro.bot', makeSpawn(ndjson))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(2)
    expect(result.services[0]?.service).toBe('umami')
  })

  it('returns service rows from JSON-array output', async () => {
    const jsonArray = JSON.stringify([
      {Name: 'umami', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ])

    const result = await getUmamiComposeStatus('metrics.fro.bot', makeSpawn(jsonArray))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(2)
  })

  it('returns ok=false when SSH exits non-zero', async () => {
    const result = await getUmamiComposeStatus('metrics.fro.bot', makeSpawn('', 'connection refused', 1))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SSH command failed')
  })

  it('rejects invalid host before spawning SSH', async () => {
    let spawnCalled = false
    const spy: SpawnFn = (cmd, opts) => {
      spawnCalled = true
      return makeSpawn('')(cmd, opts)
    }

    await expect(getUmamiComposeStatus('-oProxyCommand=evil', spy)).rejects.toThrow('Invalid UMAMI_DOMAIN')
    expect(spawnCalled).toBe(false)
  })
})

// ─── getUmamiStatusSummary ────────────────────────────────────────────────────

describe('getUmamiStatusSummary', () => {
  it('shows service rows with DEGRADED marker when services present but unhealthy', async () => {
    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'unhealthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const summary = await getUmamiStatusSummary('metrics.fro.bot', makeSpawn(ndjson))

    expect(summary.http).toContain('DEGRADED')
    expect(summary.http).toContain('umami')
    expect(summary.http).not.toContain('No services reported')
  })

  it('shows ERROR with no-services message when compose ps returns empty output', async () => {
    const summary = await getUmamiStatusSummary('metrics.fro.bot', makeSpawn(''))

    expect(summary.http).toContain('ERROR')
    expect(summary.http).toContain('No services')
    expect(summary.http).not.toContain('DEGRADED')
  })

  it('shows OK with service rows when all services are healthy', async () => {
    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const summary = await getUmamiStatusSummary('metrics.fro.bot', makeSpawn(ndjson))

    expect(summary.http).toContain('OK')
    expect(summary.http).toContain('umami')
    expect(summary.http).not.toContain('DEGRADED')
    expect(summary.http).not.toContain('ERROR')
  })
})

// ─── umamiStatusAction ───────────────────────────────────────────────────────

describe('status command', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {UMAMI_DOMAIN: process.env.UMAMI_DOMAIN, MY_UMAMI_HOST: process.env.MY_UMAMI_HOST}
  })

  afterEach(() => {
    if (originalEnv.UMAMI_DOMAIN === undefined) {
      delete process.env.UMAMI_DOMAIN
    } else {
      process.env.UMAMI_DOMAIN = originalEnv.UMAMI_DOMAIN
    }

    if (originalEnv.MY_UMAMI_HOST === undefined) {
      delete process.env.MY_UMAMI_HOST
    } else {
      process.env.MY_UMAMI_HOST = originalEnv.MY_UMAMI_HOST
    }
  })

  it('outputs service rows through ctx when services are running', async () => {
    process.env.UMAMI_DOMAIN = 'metrics.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    await umamiStatusAction({}, ctx, makeSpawn(ndjson))

    const output = captured.stdout.join('\n')
    expect(output).toContain('umami')
    expect(output).toContain('running')
    expect(captured.exit).toBeNull()
  })

  it('calls ctx.console.error and ctx.process.exit(1) on SSH failure without throwing', async () => {
    process.env.UMAMI_DOMAIN = 'metrics.fro.bot'

    const {ctx, captured} = createCapturedCtx()

    let threw = false
    try {
      await umamiStatusAction({}, ctx, makeSpawn('', 'connection refused', 1))
    } catch (error) {
      if (error instanceof MockProcessExit) {
        // expected — MockProcessExit is thrown by ctx.process.exit
      } else {
        threw = true
      }
    }

    expect(threw).toBe(false)
    expect(captured.stderr.join('')).toContain('Error')
    expect(captured.exit?.code).toBe(1)
  })

  it('calls ctx.console.error and exits when UMAMI_DOMAIN is not set', async () => {
    delete process.env.UMAMI_DOMAIN

    const {ctx, captured} = createCapturedCtx()

    try {
      await umamiStatusAction({}, ctx)
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toContain('UMAMI_DOMAIN')
    expect(captured.exit?.code).toBe(1)
  })

  it('rejects bad host via ctx.console.error without throwing unhandled', async () => {
    process.env.UMAMI_DOMAIN = '-oProxyCommand=evil'

    const {ctx, captured} = createCapturedCtx()

    try {
      await umamiStatusAction({}, ctx, makeSpawn(''))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toContain('Invalid UMAMI_DOMAIN')
    expect(captured.exit?.code).toBe(1)
  })

  it('reads host from the env var named by --key instead of UMAMI_DOMAIN', async () => {
    delete process.env.UMAMI_DOMAIN
    process.env.MY_UMAMI_HOST = 'metrics.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    try {
      await umamiStatusAction({key: 'MY_UMAMI_HOST'}, ctx, makeSpawn(ndjson))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = captured.stdout.join('\n')
    expect(output).toContain('umami')
    expect(captured.exit).toBeNull()
  })

  it('exits 1 with a clear message when docker compose ps returns empty output', async () => {
    process.env.UMAMI_DOMAIN = 'metrics.fro.bot'

    const {ctx, captured} = createCapturedCtx()

    try {
      await umamiStatusAction({}, ctx, makeSpawn(''))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toMatch(/no services|empty/i)
    expect(captured.exit?.code).toBe(1)
  })

  it('reports degraded when a service is running but health is unhealthy', async () => {
    process.env.UMAMI_DOMAIN = 'metrics.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'unhealthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    try {
      await umamiStatusAction({}, ctx, makeSpawn(ndjson))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = captured.stdout.join('\n')
    expect(output).toContain('DEGRADED')
    expect(captured.exit?.code).toBe(1)
  })

  it('reports OK when a service is running with health n-a (e.g. caddy has no healthcheck)', async () => {
    process.env.UMAMI_DOMAIN = 'metrics.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'umami', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'caddy', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    await umamiStatusAction({}, ctx, makeSpawn(ndjson))

    const output = captured.stdout.join('\n')
    expect(output).toContain('Status: OK')
    expect(captured.exit).toBeNull()
  })
})

// ─── SSH error redaction — host value must not leak in returned error strings ──

describe('getUmamiComposeStatus — SSH error redaction', () => {
  it('does not include the resolved host value in the error when SSH fails', async () => {
    const {getUmamiComposeStatus} = await import('./status')
    const secretLookingHost = 'TOPSECRETHOSTNAME'

    const mockSpawn = (_cmd: string[], _opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'}) => {
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(''))
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(encoder.encode(`ssh: Could not resolve hostname ${secretLookingHost}: Name or service not known`))
            c.close()
          },
        }),
        exited: Promise.resolve(255),
      }
    }

    const result = await getUmamiComposeStatus(secretLookingHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(secretLookingHost)
  })

  it('does not leak the host even when OpenSSH lowercases it in stderr', async () => {
    const {getUmamiComposeStatus} = await import('./status')
    const secretHost = 'AKIAIOSFODNN7EXAMPLE'

    const mockSpawn = (_cmd: string[], _opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'}) => {
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.close()
          },
        }),
        stderr: new ReadableStream({
          start(c) {
            c.enqueue(
              encoder.encode(`ssh: Could not resolve hostname ${secretHost.toLowerCase()}: Name or service not known`),
            )
            c.close()
          },
        }),
        exited: Promise.resolve(255),
      }
    }

    const result = await getUmamiComposeStatus(secretHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(secretHost)
    expect(result.error).not.toContain(secretHost.toLowerCase())
  })
})
