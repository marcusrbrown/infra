import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {
  dashboardStatusAction,
  getDashboardComposeStatus,
  getDashboardStatusSummary,
  parseComposePs,
  parseComposePsOutput,
  type ComposePsEntry,
  type ServiceRow,
} from './status'

// ─── parseComposePsOutput ─────────────────────────────────────────────────────

describe('parseComposePsOutput', () => {
  it('parses NDJSON output (one JSON object per line)', () => {
    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const entries = parseComposePsOutput(ndjson)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({Name: 'dashboard', State: 'running', Health: 'healthy'})
    expect(entries[1]).toEqual({Name: 'db', State: 'running', Health: ''})
  })

  it('parses JSON-array output (legacy compose format)', () => {
    const jsonArray = JSON.stringify([
      {Name: 'dashboard', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ])

    const entries = parseComposePsOutput(jsonArray)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toEqual({Name: 'dashboard', State: 'running', Health: 'healthy'})
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
      {Name: 'dashboard', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ]

    const rows = parseComposePs(raw)

    expect(rows).toHaveLength(2)
    expect(rows[0]).toEqual({service: 'dashboard', state: 'running', health: 'healthy'} satisfies ServiceRow)
    expect(rows[1]).toEqual({service: 'db', state: 'running', health: 'n-a'} satisfies ServiceRow)
  })

  it('maps exited state', () => {
    const raw: ComposePsEntry[] = [{Name: 'dashboard', State: 'exited', Health: ''}]

    const rows = parseComposePs(raw)

    expect(rows[0]).toEqual({service: 'dashboard', state: 'exited', health: 'n-a'} satisfies ServiceRow)
  })

  it('maps unhealthy health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'dashboard', State: 'running', Health: 'unhealthy'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('unhealthy')
  })

  it('maps starting health status', () => {
    const raw: ComposePsEntry[] = [{Name: 'dashboard', State: 'running', Health: 'starting'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('starting')
  })

  it('maps unknown health values to n-a', () => {
    const raw: ComposePsEntry[] = [{Name: 'dashboard', State: 'running', Health: 'something-weird'}]

    const rows = parseComposePs(raw)

    expect(rows[0]?.health).toBe('n-a')
  })

  it('returns empty array for empty input', () => {
    expect(parseComposePs([])).toEqual([])
  })
})

// ─── getDashboardComposeStatus (SSH mocked via SpawnFn) ──────────────────────

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

// ─── SSH command includes ConnectTimeout ─────────────────────────────────────

describe('getDashboardComposeStatus — SSH command includes ConnectTimeout', () => {
  it('passes -o ConnectTimeout=10 to ssh', async () => {
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

    const connectTimeoutIdx = capturedCmd.findIndex(arg => arg.startsWith('ConnectTimeout='))
    expect(connectTimeoutIdx).toBeGreaterThan(-1)
    expect(capturedCmd[connectTimeoutIdx - 1]).toBe('-o')
    expect(capturedCmd[connectTimeoutIdx]).toBe('ConnectTimeout=10')
  })
})

// ─── SSH command includes repo-pinned UserKnownHostsFile ─────────────────────

describe('getDashboardComposeStatus — SSH command includes UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to ssh when the file exists', async () => {
    let capturedCmd: string[] = []

    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

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
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

    const strictIdx = capturedCmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
    expect(strictIdx).toBeGreaterThan(-1)
    expect(capturedCmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
  })
})

describe('getDashboardComposeStatus', () => {
  it('returns service rows from NDJSON output', async () => {
    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const result = await getDashboardComposeStatus('dashboard.fro.bot', makeSpawn(ndjson))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(2)
    expect(result.services[0]?.service).toBe('dashboard')
  })

  it('returns service rows from JSON-array output', async () => {
    const jsonArray = JSON.stringify([
      {Name: 'dashboard', State: 'running', Health: 'healthy'},
      {Name: 'db', State: 'running', Health: ''},
    ])

    const result = await getDashboardComposeStatus('dashboard.fro.bot', makeSpawn(jsonArray))

    expect(result.ok).toBe(true)
    expect(result.services).toHaveLength(2)
  })

  it('returns ok=false when SSH exits non-zero', async () => {
    const result = await getDashboardComposeStatus('dashboard.fro.bot', makeSpawn('', 'connection refused', 1))

    expect(result.ok).toBe(false)
    expect(result.error).toContain('SSH command failed')
  })

  it('rejects invalid host before spawning SSH', async () => {
    let spawnCalled = false
    const spy: SpawnFn = (cmd, opts) => {
      spawnCalled = true
      return makeSpawn('')(cmd, opts)
    }

    await expect(getDashboardComposeStatus('-oProxyCommand=evil', spy)).rejects.toThrow('Invalid DASHBOARD_DOMAIN')
    expect(spawnCalled).toBe(false)
  })
})

// ─── getDashboardStatusSummary ────────────────────────────────────────────────

describe('getDashboardStatusSummary', () => {
  it('shows service rows with DEGRADED marker when services present but unhealthy', async () => {
    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'unhealthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const summary = await getDashboardStatusSummary('dashboard.fro.bot', makeSpawn(ndjson))

    expect(summary.http).toContain('DEGRADED')
    expect(summary.http).toContain('dashboard')
    expect(summary.http).not.toContain('No services reported')
  })

  it('shows ERROR with no-services message when compose ps returns empty output', async () => {
    const summary = await getDashboardStatusSummary('dashboard.fro.bot', makeSpawn(''))

    expect(summary.http).toContain('ERROR')
    expect(summary.http).toContain('No services')
    expect(summary.http).not.toContain('DEGRADED')
  })

  it('shows OK with service rows when all services are healthy', async () => {
    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const summary = await getDashboardStatusSummary('dashboard.fro.bot', makeSpawn(ndjson))

    expect(summary.http).toContain('OK')
    expect(summary.http).toContain('dashboard')
    expect(summary.http).not.toContain('DEGRADED')
    expect(summary.http).not.toContain('ERROR')
  })

  it('returns a summary with app: dashboard', async () => {
    const ndjson = JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])
    const summary = await getDashboardStatusSummary('dashboard.fro.bot', makeSpawn(ndjson))
    expect(summary.app).toBe('dashboard')
  })
})

// ─── dashboardStatusAction ───────────────────────────────────────────────────

describe('status command', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {DASHBOARD_DOMAIN: process.env.DASHBOARD_DOMAIN, MY_DASHBOARD_HOST: process.env.MY_DASHBOARD_HOST}
  })

  afterEach(() => {
    if (originalEnv.DASHBOARD_DOMAIN === undefined) {
      delete process.env.DASHBOARD_DOMAIN
    } else {
      process.env.DASHBOARD_DOMAIN = originalEnv.DASHBOARD_DOMAIN
    }

    if (originalEnv.MY_DASHBOARD_HOST === undefined) {
      delete process.env.MY_DASHBOARD_HOST
    } else {
      process.env.MY_DASHBOARD_HOST = originalEnv.MY_DASHBOARD_HOST
    }
  })

  it('outputs service rows through ctx when services are running', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    await dashboardStatusAction({}, ctx, makeSpawn(ndjson))

    const output = captured.stdout.join('\n')
    expect(output).toContain('dashboard')
    expect(output).toContain('running')
    expect(captured.exit).toBeNull()
  })

  it('uses ctx.console NOT global console (output is captured via ctx)', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const ndjson = JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])
    const {ctx, captured} = createCapturedCtx()

    await dashboardStatusAction({}, ctx, makeSpawn(ndjson))

    // Output must appear in captured ctx, not global console
    expect(captured.stdout.length).toBeGreaterThan(0)
    expect(captured.stdout.join('')).toContain('dashboard')
  })

  it('calls ctx.console.error and ctx.process.exit(1) on SSH failure without throwing', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const {ctx, captured} = createCapturedCtx()

    let threw = false
    try {
      await dashboardStatusAction({}, ctx, makeSpawn('', 'connection refused', 1))
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

  it('prints the SSH error message (not a generic no-services message) when SSH fails', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction(
        {},
        ctx,
        makeSpawn('', 'ssh: connect to host dashboard.fro.bot port 22: Connection timed out', 255),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const stderrText = captured.stderr.join('')
    // Must surface the SSH failure detail, not the generic no-services fallback
    expect(stderrText).toContain('SSH command failed')
    expect(stderrText).not.toContain('No services reported by docker compose ps')
    expect(captured.exit?.code).toBe(1)
  })

  it('calls ctx.console.error and exits when DASHBOARD_DOMAIN is not set', async () => {
    delete process.env.DASHBOARD_DOMAIN

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction({}, ctx)
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toContain('DASHBOARD_DOMAIN')
    expect(captured.exit?.code).toBe(1)
  })

  it('rejects bad host via ctx.console.error without throwing unhandled', async () => {
    process.env.DASHBOARD_DOMAIN = '-oProxyCommand=evil'

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction({}, ctx, makeSpawn(''))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toContain('Invalid DASHBOARD_DOMAIN')
    expect(captured.exit?.code).toBe(1)
  })

  it('reads host from the env var named by --key instead of DASHBOARD_DOMAIN', async () => {
    delete process.env.DASHBOARD_DOMAIN
    process.env.MY_DASHBOARD_HOST = 'dashboard.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction({key: 'MY_DASHBOARD_HOST'}, ctx, makeSpawn(ndjson))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = captured.stdout.join('\n')
    expect(output).toContain('dashboard')
    expect(captured.exit).toBeNull()
  })

  it('exits 1 with a clear message when docker compose ps returns empty output', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction({}, ctx, makeSpawn(''))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(captured.stderr.join('')).toMatch(/no services|empty/i)
    expect(captured.exit?.code).toBe(1)
  })

  it('reports degraded when a service is running but health is unhealthy', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'unhealthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    try {
      await dashboardStatusAction({}, ctx, makeSpawn(ndjson))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = captured.stdout.join('\n')
    expect(output).toContain('DEGRADED')
    expect(captured.exit?.code).toBe(1)
  })

  it('reports OK when a service is running with health n-a (e.g. caddy has no healthcheck)', async () => {
    process.env.DASHBOARD_DOMAIN = 'dashboard.fro.bot'

    const ndjson = [
      JSON.stringify({Name: 'dashboard', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'db', State: 'running', Health: 'healthy'}),
      JSON.stringify({Name: 'caddy', State: 'running', Health: ''}),
    ].join('\n')

    const {ctx, captured} = createCapturedCtx()

    await dashboardStatusAction({}, ctx, makeSpawn(ndjson))

    const output = captured.stdout.join('\n')
    expect(output).toContain('Status: OK')
    expect(captured.exit).toBeNull()
  })
})

// ─── SSH error redaction — host value must not leak in returned error strings ──

describe('getDashboardComposeStatus — SSH error redaction', () => {
  it('does not include the resolved host value in the error when SSH fails', async () => {
    const {getDashboardComposeStatus} = await import('./status')
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

    const result = await getDashboardComposeStatus(secretLookingHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).not.toContain(secretLookingHost)
  })

  it('does not leak the host even when OpenSSH lowercases it in stderr', async () => {
    const {getDashboardComposeStatus} = await import('./status')
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

    const result = await getDashboardComposeStatus(secretHost, mockSpawn)

    expect(result.ok).toBe(false)
    expect(result.error).not.toContain(secretHost)
    expect(result.error).not.toContain(secretHost.toLowerCase())
  })
})

// ─── SSH identity injection (DASHBOARD_SSH_KEY) ───────────────────────────────

describe('getDashboardComposeStatus — SSH identity injection', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {DASHBOARD_SSH_KEY: process.env.DASHBOARD_SSH_KEY}
  })

  afterEach(() => {
    if (originalEnv.DASHBOARD_SSH_KEY === undefined) {
      delete process.env.DASHBOARD_SSH_KEY
    } else {
      process.env.DASHBOARD_SSH_KEY = originalEnv.DASHBOARD_SSH_KEY
    }
  })

  it('includes -i <path> and IdentitiesOnly=yes in ssh argv when DASHBOARD_SSH_KEY is set', async () => {
    process.env.DASHBOARD_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedCmd: string[] = []
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

    const iIdx = capturedCmd.indexOf('-i')
    expect(iIdx).toBeGreaterThan(-1)
    expect(capturedCmd[iIdx + 1]).toBeTruthy()

    const identitiesOnlyIdx = capturedCmd.indexOf('IdentitiesOnly=yes')
    expect(identitiesOnlyIdx).toBeGreaterThan(-1)

    const destination = capturedCmd.find(arg => arg.includes('@'))
    expect(destination).toBe('root@dashboard.fro.bot')
  })

  it('does not include -i or IdentitiesOnly=yes when DASHBOARD_SSH_KEY is absent', async () => {
    delete process.env.DASHBOARD_SSH_KEY

    let capturedCmd: string[] = []
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      capturedCmd = cmd
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

    expect(capturedCmd.indexOf('-i')).toBe(-1)
    expect(capturedCmd.indexOf('IdentitiesOnly=yes')).toBe(-1)
  })

  it('cleans up the temp key file after the SSH command completes', async () => {
    const {statSync} = await import('node:fs')
    process.env.DASHBOARD_SSH_KEY = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'

    let capturedKeyPath: string | undefined
    const capturingSpawn: SpawnFn = (cmd, _opts) => {
      const iIdx = cmd.indexOf('-i')
      if (iIdx !== -1) capturedKeyPath = cmd[iIdx + 1]
      const enc = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(JSON.stringify([{Name: 'dashboard', State: 'running', Health: 'healthy'}])))
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

    await getDashboardComposeStatus('dashboard.fro.bot', capturingSpawn)

    expect(capturedKeyPath).toBeTruthy()
    const keyPath = capturedKeyPath
    if (keyPath) {
      expect(() => statSync(keyPath)).toThrow()
    }
  })
})
