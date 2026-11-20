import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {detailBody, detailOutput, recordingSpawn, RUNNING_SERVICES} from './__fixtures__/remote-fixture'
import {REMOTE_COMMANDS} from './remote'
import {
  failingLines,
  getReporterDetail,
  getTracesComposeStatus,
  getTracesStatusSummary,
  isPassing,
  parseComposePs,
  parseComposePsOutput,
  parseDetailOutput,
  tracesStatusAction,
  type ReporterDetail,
} from './status'

const ENV_KEYS = ['TRACES_HOST', 'TRACES_SSH_KEY', 'TRACES_OTHER'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  delete process.env.TRACES_SSH_KEY
  process.env.TRACES_HOST = 'traces.example.invalid'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const passingChecks = [{id: 'collector-health', status: 'pass' as const, detail: 'collector reports healthy'}]

/** Both remote commands, answered as a healthy stack unless overridden. */
function route(overrides: {ps?: string; detail?: string; psExit?: number; detailExit?: number} = {}) {
  return recordingSpawn(call => {
    if (call.command === REMOTE_COMMANDS.composePs) {
      return {stdout: overrides.ps ?? RUNNING_SERVICES, exitCode: overrides.psExit ?? 0}
    }
    if (call.command === REMOTE_COMMANDS.reporterDetail) {
      return {
        stdout: overrides.detail ?? detailOutput(detailBody({checks: passingChecks})),
        exitCode: overrides.detailExit ?? 0,
      }
    }
    throw new Error(`unexpected remote command: ${call.command}`)
  })
}

function detailOf(overrides: Partial<ReporterDetail> = {}): ReporterDetail {
  return {...(JSON.parse(detailBody({checks: passingChecks})) as ReporterDetail), ...overrides}
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

describe('compose output', () => {
  it('parses NDJSON and a JSON array, and names a service by its Service field', () => {
    const ndjson = RUNNING_SERVICES
    expect(parseComposePsOutput(ndjson)).toHaveLength(3)
    expect(parseComposePsOutput(`[${ndjson.replaceAll('\n', ',')}]`)).toHaveLength(3)
    expect(parseComposePsOutput('  \n')).toEqual([])
    const rows = parseComposePs(parseComposePsOutput(ndjson))
    expect(rows[0]).toEqual({service: 'caddy', state: 'running', health: 'healthy'})
    expect(rows[1]?.health).toBe('n-a')
  })
})

describe('parseDetailOutput', () => {
  const ok = (stdout: string, exitCode = 0) => parseDetailOutput({exitCode, stdout, stderr: ''})

  it('accepts a body followed by the sentinel', () => {
    const parsed = ok(detailOutput(detailBody()))
    expect(parsed.ok).toBe(true)
  })

  it('fails when the command exited non-zero, even with a valid body', () => {
    expect(ok(detailOutput(detailBody()), 1)).toEqual({ok: false, reason: 'ssh-failed'})
  })

  it('fails when the sentinel is missing, so a truncated answer is never read as a verdict', () => {
    expect(ok(`${detailBody()}\n`)).toEqual({ok: false, reason: 'unreadable'})
    expect(ok('')).toEqual({ok: false, reason: 'unreadable'})
  })

  it('fails on a body that is not JSON or does not match the schema', () => {
    expect(ok('<html>\nTRACES_DETAIL_END\n')).toEqual({ok: false, reason: 'unreadable'})
    expect(ok(detailOutput('{"ok":true}'))).toEqual({ok: false, reason: 'unreadable'})
    expect(ok(detailOutput(detailBody().replace('"schemaVersion":1', '"schemaVersion":2')))).toEqual({
      ok: false,
      reason: 'unreadable',
    })
  })
})

describe('isPassing', () => {
  it('needs a run, a fresh verdict and ok', () => {
    expect(isPassing(detailOf())).toBe(true)
    expect(isPassing(detailOf({ok: false}))).toBe(false)
    expect(isPassing(detailOf({stale: true}))).toBe(false)
    expect(isPassing(detailOf({ran: false}))).toBe(false)
  })

  it('lists failing and unknown checks, and says when there has been no run or the run is old', () => {
    const lines = failingLines(
      detailOf({
        ok: false,
        stale: true,
        checks: [
          {id: 'a', status: 'pass', detail: 'fine'},
          {id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)'},
          {id: 'tempo-ready', status: 'unknown', detail: 'no answer'},
          {id: 'volume-space', status: 'warn', detail: 'volume 72.0% used'},
        ],
      }),
    )
    expect(lines).toContain('langfuse-worker: langfuse worker is unhealthy (http-503)')
    expect(lines).toContain('tempo-ready: no answer')
    expect(lines.some(line => line.startsWith('a:') || line.startsWith('volume-space:'))).toBe(false)
    expect(lines.at(-1)).toContain('older than two intervals')
    expect(failingLines(detailOf({ran: false}))).toContain('the reporter has not finished a run yet')
  })
})

// ─── SSH commands ─────────────────────────────────────────────────────────────

describe('remote calls', () => {
  it('runs docker compose ps as root over pinned, strict ssh, with the validated host', async () => {
    const {spawn, calls} = route()
    const result = await getTracesComposeStatus('traces.example.invalid', spawn)
    expect(result.ok).toBe(true)
    const argv = calls[0]?.argv ?? []
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv.some(arg => arg.startsWith('UserKnownHostsFile='))).toBe(true)
    expect(argv.at(-2)).toBe('root@traces.example.invalid')
    expect(argv.at(-1)).toBe(REMOTE_COMMANDS.composePs)
  })

  it('asks the reporter for its detail through docker compose exec, on its loopback listener', async () => {
    const {spawn, calls} = route()
    const detail = await getReporterDetail('traces.example.invalid', spawn)
    expect(detail.ok).toBe(true)
    expect(calls[0]?.command).toContain('exec -T health-reporter')
    expect(calls[0]?.command).toContain('http://127.0.0.1:8081/detail')
  })

  it('reports a failed compose call without the host name in the error', async () => {
    const {spawn} = recordingSpawn(() => ({
      stderr: 'ssh: connect to host traces.example.invalid port 22: refused',
      exitCode: 255,
    }))
    const result = await getTracesComposeStatus('traces.example.invalid', spawn)
    expect(result.ok).toBe(false)
    expect(result.error).toContain('exit 255')
    expect(result.error).not.toContain('traces.example.invalid')
  })

  it('refuses a host starting with - before any process is started', async () => {
    const {spawn, calls} = route()
    await expect(getTracesComposeStatus('-oProxyCommand=evil', spawn)).rejects.toThrow('Invalid TRACES_HOST')
    await expect(getReporterDetail('-oProxyCommand=evil', spawn)).rejects.toThrow('Invalid TRACES_HOST')
    expect(calls).toHaveLength(0)
  })

  it('marks a service that is exited as not ok', async () => {
    const ps = [
      JSON.stringify({Service: 'caddy', State: 'running', Health: 'healthy'}),
      JSON.stringify({Service: 'collector', State: 'exited', Health: ''}),
    ].join('\n')
    const result = await getTracesComposeStatus('traces.example.invalid', route({ps}).spawn)
    expect(result.ok).toBe(false)
  })

  it('treats an empty service list as not ok, never as healthy', async () => {
    const result = await getTracesComposeStatus('traces.example.invalid', route({ps: ''}).spawn)
    expect(result.ok).toBe(false)
  })
})

// ─── Unified status ───────────────────────────────────────────────────────────

describe('getTracesStatusSummary', () => {
  it('declares no observation and puts the services and a verdict summary in facts', async () => {
    const collection = await getTracesStatusSummary('traces.example.invalid', route().spawn)
    expect(collection.observations).toEqual([])
    expect(collection.facts.services).toEqual([
      {service: 'caddy', state: 'running', health: 'healthy'},
      {service: 'collector', state: 'running', health: 'n-a'},
      {service: 'health-reporter', state: 'running', health: 'healthy'},
    ])
    expect(collection.facts.health).toEqual({ok: true, stale: false, at: '2026-11-20T11:58:00.000Z', failing: []})
  })

  it('names the failing checks by id only, without their detail', async () => {
    const detail = detailOutput(
      detailBody({
        ok: false,
        checks: [{id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)'}],
      }),
    )
    const collection = await getTracesStatusSummary('traces.example.invalid', route({detail}).spawn)
    expect(collection.facts.health).toEqual({
      ok: false,
      stale: false,
      at: '2026-11-20T11:58:00.000Z',
      failing: ['langfuse-worker'],
    })
  })

  it('reports an unreadable reporter as not ok', async () => {
    const collection = await getTracesStatusSummary('traces.example.invalid', route({detailExit: 1}).spawn)
    expect(collection.facts.health).toEqual({ok: false, unreadable: true})
  })
})

// ─── The command ──────────────────────────────────────────────────────────────

describe('tracesStatusAction', () => {
  it('prints the services and the verdict, and exits cleanly when both are fine', async () => {
    const {ctx, captured} = createCapturedCtx()
    await tracesStatusAction({}, ctx, route().spawn)
    const out = captured.stdout.join('\n')
    expect(out).toContain('caddy')
    expect(out).toContain('Health verdict: PASSING')
    expect(out).toContain('collector-health')
    expect(out).toContain('Status: OK')
    expect(captured.exit).toBeNull()
  })

  it('names the failing check and exits 1 when the verdict fails', async () => {
    const detail = detailOutput(
      detailBody({
        ok: false,
        checks: [
          {id: 'langfuse-web', status: 'pass', detail: 'langfuse web is healthy'},
          {id: 'langfuse-worker', status: 'fail', detail: 'langfuse worker is unhealthy (http-503)'},
        ],
      }),
    )
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesStatusAction({}, ctx, route({detail}).spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.stdout.join('\n')).toContain('Health verdict: FAILING')
    expect(captured.stderr.join('\n')).toContain('langfuse-worker')
    expect(captured.exit).toEqual({code: 1})
  })

  it('exits 1 when a service is down even though the verdict passes', async () => {
    const ps = JSON.stringify({Service: 'collector', State: 'exited', Health: ''})
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesStatusAction({}, ctx, route({ps}).spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.stdout.join('\n')).toContain('DEGRADED')
  })

  it('shows an unreadable reporter as UNKNOWN and exits 1', async () => {
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesStatusAction({}, ctx, route({detailExit: 255}).spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.stdout.join('\n')).toContain('Health verdict: UNKNOWN')
  })

  it('does not call a stale pass passing', async () => {
    const detail = detailOutput(detailBody({stale: true, ok: true}))
    const {ctx, captured} = createCapturedCtx()
    await expect(tracesStatusAction({}, ctx, route({detail}).spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.stdout.join('\n')).toContain('Health verdict: FAILING')
  })

  it('fails with one error when nothing can be read at all', async () => {
    const {ctx, captured} = createCapturedCtx()
    const {spawn} = route({psExit: 255, detailExit: 255})
    await expect(tracesStatusAction({}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.stderr.join('\n')).toContain('Error:')
  })

  it('prints one JSON object with --json', async () => {
    const {ctx, captured} = createCapturedCtx()
    await tracesStatusAction({json: true}, ctx, route().spawn)
    const parsed = JSON.parse(captured.stdout.join('')) as {ok: boolean; services: unknown[]; health: {ok: boolean}}
    expect(parsed.ok).toBe(true)
    expect(parsed.services).toHaveLength(3)
    expect(parsed.health.ok).toBe(true)
  })

  it('refuses a host value starting with - before spawning, and does not echo it', async () => {
    process.env.TRACES_OTHER = '-oProxyCommand=evil'
    const {ctx, captured} = createCapturedCtx()
    const {spawn, calls} = route()
    await expect(tracesStatusAction({key: 'TRACES_OTHER'}, ctx, spawn)).rejects.toBeInstanceOf(MockProcessExit)
    expect(calls).toHaveLength(0)
    expect(captured.stderr.join('\n')).toContain('Invalid TRACES_HOST')
    expect(captured.stderr.join('\n')).not.toContain('ProxyCommand')
  })

  it('uses the host named by --key', async () => {
    process.env.TRACES_OTHER = 'other.example.invalid'
    const {ctx} = createCapturedCtx()
    const {spawn, calls} = route()
    await tracesStatusAction({key: 'TRACES_OTHER'}, ctx, spawn)
    expect(calls[0]?.argv.at(-2)).toBe('root@other.example.invalid')
  })
})
