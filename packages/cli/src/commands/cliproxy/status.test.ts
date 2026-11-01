import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  checkHttpReachability,
  checkProviderAuth,
  checkProviderAuthState,
  checkRunningVersion,
  checkUsageStats,
  checkVersion,
  cliproxyStatusAction,
  formatDurationMs,
  formatUsageSummaryLine,
  getCliproxyStatusSummary,
  inspectRunningContainer,
  levelLabel,
  stripTrailingSlash,
  toNumber,
  type SpawnFn,
} from './status'

const originalFetch = globalThis.fetch

const managedEnvKeys = ['CLIPROXY_URL', 'CLIPROXY_MANAGEMENT_KEY', 'CLIPROXY_API_KEY', 'CLIPROXY_SSH_KEY'] as const
type ManagedEnvKey = (typeof managedEnvKeys)[number]

let savedEnv: Partial<Record<ManagedEnvKey, string | undefined>>

function saveEnv(): void {
  savedEnv = Object.fromEntries(managedEnvKeys.map(key => [key, process.env[key]]))
}

function clearEnv(): void {
  for (const key of managedEnvKeys) {
    delete process.env[key]
  }
}

function restoreEnv(): void {
  for (const key of managedEnvKeys) {
    const value = savedEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

beforeEach(() => {
  saveEnv()
  clearEnv()
})

afterEach(restoreEnv)

type FetchReplacement = (url: string, init?: RequestInit) => Promise<Response>

function createFetchImplementation(handler: FetchReplacement): typeof fetch {
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      if (typeof input !== 'string') {
        throw new TypeError(`Unexpected non-string fetch input: ${String(input)}`)
      }

      return handler(input, init)
    },
    {preconnect: originalFetch.preconnect},
  )
}

function makeSpawnResult(stdoutText: string, stderrText = '', exitCode = 0): SpawnFn {
  const encoder = new TextEncoder()
  return (_cmd, _opts) => ({
    stdout: new ReadableStream({
      start(controller) {
        if (stdoutText.length > 0) controller.enqueue(encoder.encode(stdoutText))
        controller.close()
      },
    }),
    stderr: new ReadableStream({
      start(controller) {
        if (stderrText.length > 0) controller.enqueue(encoder.encode(stderrText))
        controller.close()
      },
    }),
    exited: Promise.resolve(exitCode),
  })
}

describe('cliproxy status helpers', () => {
  beforeEach(() => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('Unexpected fetch call')
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('levelLabel', () => {
    it('returns OK for ok', () => {
      expect(levelLabel('ok')).toBe('OK')
    })

    it('returns WARN for warning', () => {
      expect(levelLabel('warning')).toBe('WARN')
    })

    it('returns ERROR for error', () => {
      expect(levelLabel('error')).toBe('ERROR')
    })
  })

  describe('formatDurationMs', () => {
    it('formats positive durations', () => {
      expect(formatDurationMs(150)).toBe('150ms')
    })

    it('formats zero duration', () => {
      expect(formatDurationMs(0)).toBe('0ms')
    })

    it('clamps negative durations to zero', () => {
      expect(formatDurationMs(-5)).toBe('0ms')
    })
  })

  describe('stripTrailingSlash', () => {
    it('removes a trailing slash', () => {
      expect(stripTrailingSlash('https://example.com/')).toBe('https://example.com')
    })

    it('does nothing when there is no trailing slash', () => {
      expect(stripTrailingSlash('https://example.com')).toBe('https://example.com')
    })
  })

  describe('toNumber', () => {
    it('returns finite numbers as-is', () => {
      expect(toNumber(42)).toBe(42)
    })

    it('returns null for non-numbers', () => {
      expect(toNumber('not a number')).toBeNull()
    })

    it('returns null for NaN', () => {
      expect(toNumber(Number.NaN)).toBeNull()
    })

    it('returns null for infinity', () => {
      expect(toNumber(Number.POSITIVE_INFINITY)).toBeNull()
    })
  })

  describe('checkHttpReachability', () => {
    it('returns ok for HTTP 200', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('ok', {status: 200}))

      const result = await checkHttpReachability('https://cliproxy.example.com', false)

      expect(result.level).toBe('ok')
      expect(result.summary).toContain('GET https://cliproxy.example.com → 200')
      expect(result.summary).toContain('ms')
    })

    it('returns error for HTTP 500', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

      const result = await checkHttpReachability('https://cliproxy.example.com', false)

      expect(result.level).toBe('error')
      expect(result.summary).toContain('GET https://cliproxy.example.com → 500')
    })

    it('returns error details for network failures', async () => {
      globalThis.fetch = createFetchImplementation(async () => {
        throw new Error('Network timeout')
      })

      const result = await checkHttpReachability('https://cliproxy.example.com', true)

      expect(result.level).toBe('error')
      expect(result.summary).toContain('Network timeout')
      expect(result.details).toEqual(['URL: https://cliproxy.example.com', 'Timeout: 10000ms'])
    })
  })

  describe('checkUsageStats', () => {
    it('returns ok for empty array (idle)', async () => {
      globalThis.fetch = createFetchImplementation(
        async () => new Response('[]', {status: 200, headers: {'content-type': 'application/json'}}),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('ok')
      expect(result.summary).toMatch(/idle|recent: 0/)
    })

    it('returns ok for all-success queue array', async () => {
      const queue = [{status: 200}, {status: 201}, {status: 200}]
      globalThis.fetch = createFetchImplementation(
        async () => new Response(JSON.stringify(queue), {status: 200, headers: {'content-type': 'application/json'}}),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('ok')
      expect(result.summary).toContain('recent: 3')
    })

    it('returns warning for queue with error-status records', async () => {
      const queue = [{status: 200}, {status: 500}, {status: 200}]
      globalThis.fetch = createFetchImplementation(
        async () => new Response(JSON.stringify(queue), {status: 200, headers: {'content-type': 'application/json'}}),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('recent: 3')
      expect(result.summary).toContain('errors: 1')
    })

    it('returns warning when usage-queue returns a non-array object', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(JSON.stringify({unexpected: 'object'}), {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
    })

    it('returns warning when rate limited', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('rate limited', {status: 429}))

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('Rate limited')
    })

    it('returns error for non-200 responses', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('boom', {status: 500}))

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('error')
      expect(result.summary).toContain('HTTP 500')
    })

    it('returns error for network failures', async () => {
      globalThis.fetch = createFetchImplementation(async () => {
        throw new Error('socket hang up')
      })

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('error')
      expect(result.summary).toContain('Unable to read usage stats: socket hang up')
    })
  })

  describe('checkVersion', () => {
    it('returns ok with latest-version from response', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(JSON.stringify({'latest-version': 'v6.9.15'}), {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
      )

      const result = await checkVersion('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('ok')
      expect(result.summary).toBe('v6.9.15')
    })

    it('returns warning when latest-version key is missing', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(JSON.stringify({}), {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
      )

      const result = await checkVersion('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('latest-version')
    })

    it('returns warning when rate limited', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('rate limited', {status: 429}))

      const result = await checkVersion('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('Rate limited')
    })

    it('returns error for non-200 responses', async () => {
      globalThis.fetch = createFetchImplementation(async () => new Response('boom', {status: 500}))

      const result = await checkVersion('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('error')
      expect(result.summary).toContain('HTTP 500')
    })
  })

  describe('checkRunningVersion', () => {
    it('parses the deployed CLIProxyAPI image version from SSH output', async () => {
      const spawn = makeSpawnResult('cli-proxy-api\teceasy/cli-proxy-api:v7.2.138@sha256:deadbeef\n')

      const result = await checkRunningVersion('cliproxy-example-com', spawn)

      expect(result).toEqual({title: 'Running version', level: 'ok', summary: 'v7.2.138'})
    })

    it('degrades to a warning when SSH is unavailable', async () => {
      const result = await checkRunningVersion('cliproxy-example-com', makeSpawnResult('', 'Permission denied\n', 255))

      expect(result.title).toBe('Running version')
      expect(result.level).toBe('warning')
      expect(result.summary).toContain('SSH command failed')
    })

    it('degrades for an invalid host before invoking SSH', async () => {
      const neverSpawn: SpawnFn = () => {
        throw new Error('spawn must not be called for an invalid host')
      }

      const result = await checkRunningVersion('-oProxyCommand=evil', neverSpawn)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('Invalid CLIPROXY_DOMAIN')
    })
  })

  describe('inspectRunningContainer', () => {
    it('returns the running image tag', async () => {
      const spawn = makeSpawnResult('cli-proxy-api\teceasy/cli-proxy-api:v7.2.138@sha256:deadbeef\n')

      expect(await inspectRunningContainer('cliproxy-example-com', spawn)).toEqual({
        kind: 'running',
        version: 'v7.2.138',
      })
    })

    it('returns none when SSH works but no CLIProxyAPI container is listed', async () => {
      const spawn = makeSpawnResult('nginx:latest\nredis:7\n')

      expect(await inspectRunningContainer('cliproxy-example-com', spawn)).toEqual({kind: 'none'})
    })

    it('returns unavailable when SSH fails, and for an invalid host before spawning', async () => {
      const failed = await inspectRunningContainer(
        'cliproxy-example-com',
        makeSpawnResult('', 'Permission denied\n', 255),
      )
      const neverSpawn: SpawnFn = () => {
        throw new Error('spawn must not be called for an invalid host')
      }
      const invalid = await inspectRunningContainer('-oProxyCommand=evil', neverSpawn)

      expect(failed.kind).toBe('unavailable')
      expect(invalid.kind).toBe('unavailable')
    })
  })

  describe('formatUsageSummaryLine', () => {
    it('formats a recent-activity summary with no errors', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'ok',
        summary: 'recent: 10',
      })

      expect(result).toBe('Recent requests: 10')
    })

    it('formats a recent-activity summary with errors appended', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'warning',
        summary: 'recent: 10, errors: 3',
      })

      expect(result).toBe('Recent requests: 10, 3 errors')
    })

    it('formats an idle recent summary', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'ok',
        summary: 'recent: 0 (idle)',
      })

      expect(result).toBe('Recent requests: 0')
    })

    it('returns null when summary has no recent-activity field', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      })

      expect(result).toBeNull()
    })

    it('returns null for error summaries without a recent field', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'error',
        summary: 'Unable to read usage stats: socket hang up',
      })

      expect(result).toBeNull()
    })
  })
})

describe('cliproxyStatusAction (Tier-2 ctx capture, failure-path parity)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Tier-2: routes unexpected thrown error through ctx.console.error + ctx.process.exit(1)', async () => {
    // Trigger an unexpected error by having ctx.console.log throw on first call
    const {ctx, captured} = createCapturedCtx()
    let callCount = 0
    const originalLog = ctx.console.log
    ctx.console.log = (...args: unknown[]) => {
      callCount++
      if (callCount === 1) {
        throw new Error('Unexpected internal error during status output')
      }

      originalLog(...args)
    }

    globalThis.fetch = createFetchImplementation(async () => new Response('ok', {status: 200}))

    await expect(
      cliproxyStatusAction(
        {url: 'https://cliproxy.example.com'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      ),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Unexpected internal error')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyStatusAction (Tier-2 ctx capture)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode A: captures CLIProxyAPI status header to ctx.stdout', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('ok', {status: 200}))

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(expectCapturedToInclude(captured, 'CLIProxyAPI status')).toBe(true)
    expect(expectCapturedToInclude(captured, 'HTTP reachability')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Summary:')).toBe(true)
  })

  it('Mode A: calls ctx.process.exit(1) on HTTP error', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    let threw: unknown
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      threw = error
    }

    expect(threw).toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
    expect(expectCapturedToInclude(captured, 'ERROR')).toBe(true)
  })

  it('Mode A: shows management key warning when no key provided', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('ok', {status: 200}))

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(expectCapturedToInclude(captured, 'CLIPROXY_MANAGEMENT_KEY')).toBe(true)
  })

  it('keeps HTTP checks healthy when the running-version SSH check fails', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.endsWith('/healthz')) return new Response('ok', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.fro.bot'},
      ctx,
      makeSpawnResult('', 'ssh: connect failed\n', 255),
    )

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('[OK] HTTP reachability')
    expect(output).toContain('[WARN] Running version')
    expect(output).toContain('ssh: connect failed')
    expect(captured.exit).toBeNull()
  })

  it('skips SSH for an explicit URL override without failing status', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.endsWith('/healthz')) return new Response('ok', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    let spawnCalls = 0
    const neverSpawn: SpawnFn = () => {
      spawnCalls++
      throw new Error('SSH must not run for an explicit URL override')
    }
    const {ctx, captured} = createCapturedCtx()

    await cliproxyStatusAction({url: 'https://other-cliproxy.example.com'}, ctx, neverSpawn)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('[WARN] Running version')
    expect(output).toContain('Not checked for explicit URL override')
    expect(captured.exit).toBeNull()
    expect(spawnCalls).toBe(0)
  })

  it('keeps HTTP healthy when the URL hostname fails validation', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.endsWith('/healthz')) return new Response('ok', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const neverSpawn: SpawnFn = () => {
      throw new Error('SSH must not run for an invalid host')
    }
    const {ctx, captured} = createCapturedCtx()

    await cliproxyStatusAction({url: 'https://[::1]'}, ctx, neverSpawn)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('[OK] HTTP reachability')
    expect(output).toContain('Invalid CLIPROXY_DOMAIN')
    expect(captured.exit).toBeNull()
  })
})

describe('usage-queue migration', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('populated usage-queue returns recent-activity summary with correct total and error count', async () => {
    const queue = [
      {status: 200, model: 'claude-3-5-sonnet'},
      {status: 500, model: 'claude-3-5-sonnet'},
      {status: 200, model: 'claude-3-5-sonnet'},
    ]
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/usage-queue')) {
        return new Response(JSON.stringify(queue), {status: 200, headers: {'content-type': 'application/json'}})
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

    expect(result.level).not.toBe('error')
    expect(result.summary).toContain('recent: 3')
    expect(result.summary).toContain('errors: 1')
  })

  it('empty usage-queue returns ok/idle result, not an error', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/usage-queue')) {
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

    expect(result.level).toBe('ok')
    expect(result.summary).toMatch(/idle|recent: 0/)
  })

  it('malformed usage-queue response returns warning, not error, and does not throw', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/usage-queue')) {
        return new Response('{"not":"an-array"}', {status: 200, headers: {'content-type': 'application/json'}})
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

    expect(result.level).toBe('warning')
  })

  it('formatUsageSummaryLine returns a human-friendly line for recent-window summary', () => {
    const result = formatUsageSummaryLine({
      title: 'Usage stats',
      level: 'ok',
      summary: 'recent: 5, errors: 1',
    })

    expect(result).not.toBeNull()
    expect(result).toContain('5')
  })
})

function managementFetch(options: {status?: number; usage?: unknown[]; latest?: string} = {}) {
  const {status = 200, usage = [{status: 200}, {status: 500}], latest = 'v7.2.140'} = options
  return createFetchImplementation(async url => {
    if (!url.includes('/v0/management/')) return new Response('ok', {status: 200})
    if (status !== 200) return new Response('Unauthorized', {status})
    if (url.includes('/usage-queue')) return Response.json(usage)
    if (url.includes('/latest-version')) return Response.json({'latest-version': latest})
    return Response.json({})
  })
}

describe('getCliproxyStatusSummary (typed collection)', () => {
  const BASE = 'https://cliproxy.example.com'
  const runningSpawn = () => makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n')

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('reports the container observation and the version, latest version and usage facts', async () => {
    globalThis.fetch = managementFetch()

    const collection = await getCliproxyStatusSummary(BASE, 'good-key', runningSpawn())

    expect(collection.observations).toEqual([
      expect.objectContaining({id: 'container-running', kind: 'container-health', source: 'ssh', result: 'pass'}),
    ])
    expect(collection.facts).toEqual({
      runningVersion: 'v7.2.139',
      latestVersion: 'v7.2.140',
      usage: {recent: 2, errors: 1},
      managementAccess: 'ok',
    })
  })

  it('does not call the public health endpoint (reachability is the shared probe)', async () => {
    const urls: string[] = []
    globalThis.fetch = createFetchImplementation(async url => {
      urls.push(url)
      return Response.json({})
    })

    await getCliproxyStatusSummary(BASE, 'good-key', runningSpawn())

    expect(urls.some(url => url.endsWith('/healthz'))).toBe(false)
  })

  it('reports a bad management key as managementAccess denied with null version and usage, distinct from no key', async () => {
    globalThis.fetch = managementFetch({status: 401})

    const collection = await getCliproxyStatusSummary(BASE, 'bad-key', runningSpawn())

    expect(collection.facts).toEqual({
      runningVersion: 'v7.2.139',
      latestVersion: null,
      usage: null,
      managementAccess: 'denied',
    })
  })

  it('reports a missing management key as managementAccess no-key without calling the management API', async () => {
    const urls: string[] = []
    globalThis.fetch = createFetchImplementation(async url => {
      urls.push(url)
      return Response.json({})
    })

    const collection = await getCliproxyStatusSummary(BASE, '', runningSpawn())

    expect(urls).toEqual([])
    expect(collection.facts).toMatchObject({managementAccess: 'no-key', latestVersion: null, usage: null})
    expect(collection.observations[0]?.result).toBe('pass')
  })

  it('fails the container observation when no CLIProxyAPI container runs', async () => {
    const collection = await getCliproxyStatusSummary(BASE, '', makeSpawnResult('nginx:latest\n'))

    expect(collection.observations[0]).toMatchObject({result: 'fail', detail: {reason: 'not-running'}})
    expect(collection.facts.runningVersion).toBeNull()
  })

  it('makes the container observation unknown, without stderr text, when SSH fails', async () => {
    const collection = await getCliproxyStatusSummary(
      BASE,
      '',
      makeSpawnResult('', 'ssh: connect to host cliproxy.example.com: Connection refused\n', 255),
    )

    expect(collection.observations[0]).toMatchObject({result: 'unknown', detail: {reason: 'ssh-failed'}})
    expect(JSON.stringify(collection)).not.toContain('Connection refused')
    expect(JSON.stringify(collection)).not.toContain('cliproxy.example.com')
  })

  it('rejects an unparseable base URL so the unified command can mark the app unknown', async () => {
    await expect(getCliproxyStatusSummary('not a url', '', runningSpawn())).rejects.toThrow()
  })
})

describe('ban body word-boundary detection (FIX 5)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('403 with body {detail:"bandwidth exceeded"} is NOT treated as a ban (generic 403)', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/config')) {
        return new Response(JSON.stringify({detail: 'bandwidth exceeded'}), {
          status: 403,
          headers: {'content-type': 'application/json'},
        })
      }

      return new Response('ok', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', key: 'any-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output.toLowerCase()).not.toMatch(/ip.?ban/)
  })

  it('403 with body {error:"IP banned"} IS treated as a ban', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/config')) {
        return new Response(JSON.stringify({error: 'IP banned'}), {
          status: 403,
          headers: {'content-type': 'application/json'},
        })
      }

      return new Response('ok', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', key: 'any-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output.toLowerCase()).toMatch(/ip.?ban/)
  })
})

describe('reachability probe targets /healthz liveness endpoint', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('cliproxyStatusAction reports HTTP reachable when /healthz returns 200 and bare base returns 404', async () => {
    const BASE = 'https://cliproxy.example.com'
    globalThis.fetch = createFetchImplementation(async url => {
      if (url === `${BASE}/healthz`) return new Response('{"status":"ok"}', {status: 200})
      if (url === BASE) return new Response('Not Found', {status: 404})
      return new Response('ok', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction({url: BASE}, ctx, makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'))

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('OK')
    expect(output).not.toMatch(/ERROR.*HTTP reachability|HTTP reachability.*ERROR/)
  })
})

describe('management auth probe (ban-awareness)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('bad management key causes at most one management fetch and skips version+usage calls', async () => {
    const managementFetchUrls: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      const hasManagementKey =
        hdrs instanceof Headers
          ? hdrs.has('x-management-key')
          : hdrs !== null && hdrs !== undefined && typeof hdrs === 'object' && 'x-management-key' in hdrs
      if (url.includes('/v0/management/') && hasManagementKey) {
        managementFetchUrls.push(url)
        return new Response('Unauthorized', {status: 401})
      }

      if (url.includes('/healthz') || !url.includes('/v0/management/')) {
        return new Response('ok', {status: 200})
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx} = createCapturedCtx()
    // Auth failure yields error-level result → exit(1) → MockProcessExit thrown
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', key: 'bad-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    expect(managementFetchUrls.length).toBe(1)
    expect(managementFetchUrls[0]).toContain('/v0/management/config')
  })

  it('403 with ban body surfaces a distinct IP-banned message', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/config')) {
        return new Response(JSON.stringify({error: 'IP banned'}), {
          status: 403,
          headers: {'content-type': 'application/json'},
        })
      }

      return new Response('ok', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    // 403+ban → error level → exit(1)
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', key: 'any-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output.toLowerCase()).toMatch(/ip.?ban/)
  })

  it('auth error message does not contain the management key value', async () => {
    const secretKey = 'super-secret-mgmt-key-12345'

    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/v0/management/config')) {
        return new Response('Unauthorized', {status: 401})
      }

      return new Response('ok', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    // 401 → error level → exit(1)
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', key: secretKey},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    const allOutput = [...captured.stdout, ...captured.stderr].join('\n')
    expect(allOutput).not.toContain(secretKey)
  })

  it('successful probe allows version and usage checks to proceed in parallel', async () => {
    const fetchedUrls: string[] = []

    globalThis.fetch = createFetchImplementation(async url => {
      fetchedUrls.push(url)
      if (url.includes('/v0/management/config')) {
        return new Response(JSON.stringify({config: 'ok'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }

      if (url.includes('/v0/management/usage-queue')) {
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      }

      if (url.includes('/v0/management/latest-version')) {
        return new Response(JSON.stringify({'latest-version': 'v7.1.31'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }

      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com', key: 'valid-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(fetchedUrls.some(u => u.includes('/v0/management/latest-version'))).toBe(true)
    expect(fetchedUrls.some(u => u.includes('/v0/management/usage-queue'))).toBe(true)
  })

  it('getCliproxyStatusSummary with bad key fires only one management fetch', async () => {
    const managementFetchUrls: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      const hasKey =
        hdrs instanceof Headers
          ? hdrs.has('x-management-key')
          : hdrs !== null && hdrs !== undefined && typeof hdrs === 'object' && 'x-management-key' in hdrs
      if (url.includes('/v0/management/') && hasKey) {
        managementFetchUrls.push(url)
        return new Response('Unauthorized', {status: 401})
      }

      return new Response('ok', {status: 200})
    })

    await getCliproxyStatusSummary(
      'https://cliproxy.example.com',
      'bad-key',
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(managementFetchUrls.length).toBe(1)
  })
})

// ─── Ambient management key trusted-URL binding ───────────────────────────────

describe('cliproxyStatusAction — ambient key does not follow agent-supplied URLs', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      CLIPROXY_URL: process.env.CLIPROXY_URL,
      CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY,
    }
    process.env.CLIPROXY_MANAGEMENT_KEY = 'secret-ambient-key'
    delete process.env.CLIPROXY_URL
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    globalThis.fetch = originalFetch
  })

  it('does NOT send the ambient management key to a non-trusted --url override', async () => {
    const capturedRequestsByHost: Record<string, string[]> = {}

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const {hostname} = new URL(url)
      const hdrs = init?.headers
      const key = hdrs instanceof Headers ? hdrs.get('x-management-key') : null

      if (!capturedRequestsByHost[hostname]) capturedRequestsByHost[hostname] = []
      if (key) capturedRequestsByHost[hostname].push(key)

      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v0/management/'))
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    try {
      await cliproxyStatusAction(
        {url: 'https://evil.example.com'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch {
      // exit(1) expected or not — either way, we just care about key leakage
    }

    // The ambient secret key must NOT appear in any request to the evil host
    expect(capturedRequestsByHost['evil.example.com'] ?? []).not.toContain('secret-ambient-key')
  })

  it('still uses the ambient key when --url matches the default trusted URL', async () => {
    const capturedManagementKeys: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      const key = hdrs instanceof Headers ? hdrs.get('x-management-key') : null
      if (url.includes('/v0/management/') && key) capturedManagementKeys.push(key)

      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v0/management/config'))
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/usage-queue'))
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/latest-version'))
        return new Response(JSON.stringify({'latest-version': 'v1.0.0'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    // Default URL is https://cliproxy.fro.bot — pass it explicitly
    await cliproxyStatusAction(
      {url: 'https://cliproxy.fro.bot'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(capturedManagementKeys).toContain('secret-ambient-key')
  })

  it('uses an explicit --key even when --url is a non-trusted host', async () => {
    const capturedManagementKeys: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      const key = hdrs instanceof Headers ? hdrs.get('x-management-key') : null
      if (url.includes('/v0/management/') && key) capturedManagementKeys.push(key)

      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v0/management/config'))
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/usage-queue'))
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/latest-version'))
        return new Response(JSON.stringify({'latest-version': 'v1.0.0'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://other-cliproxy.example.com', key: 'explicit-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(capturedManagementKeys).toContain('explicit-key')
  })

  it('falls through to the no-key warning path when URL is untrusted and no --key given', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      return new Response('[]', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://other-cliproxy.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toMatch(/CLIPROXY_MANAGEMENT_KEY|no key|skipping/i)
  })
})

// ─── checkProviderAuth ────────────────────────────────────────────────────────

describe('checkProviderAuth', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('returns ok when POST /v1/chat/completions returns 200', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({choices: [{message: {content: 'pong'}}]}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('ok')
    expect(result.title).toBe('Upstream provider auth (anthropic)')
    expect(result.summary).toContain('anthropic route OK')
    expect(result.summary).toContain('claude-sonnet-4-6')
  })

  it('returns an automation-safe healthy state for a minimal successful completion', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response(JSON.stringify({choices: []}), {status: 200}))

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'healthy', reason: 'ok'})
  })

  it('classifies an aborted provider probe as an unknown timeout with a bounded reason', async () => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new DOMException('', 'TimeoutError')
    })

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'unknown', reason: 'timeout'})
  })

  it('returns only a bounded dead classification for HTTP 401', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('secret upstream diagnostic', {status: 401}))

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'dead', reason: 'auth-401'})
    expect(Object.keys(result).sort()).toEqual(['reason', 'state'])
    expect(JSON.stringify(result)).not.toContain('secret upstream diagnostic')
  })

  it('classifies supported 503 auth-unavailable markers as dead', async () => {
    for (const body of ['auth_unavailable', 'no auth available', 'providers=claude']) {
      globalThis.fetch = createFetchImplementation(async () => new Response(`raw: ${body}`, {status: 503}))

      const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

      expect(result).toEqual({state: 'dead', reason: 'auth-unavailable-503'})
    }
  })

  it('classifies the model_not_found 400 from a lost Claude credential as dead provider-missing', async () => {
    const incidentBody =
      '{"error":{"message":"unknown provider for model claude-sonnet-4-6","type":"invalid_request_error","code":"model_not_found","param":"model"}}'
    globalThis.fetch = createFetchImplementation(
      async () => new Response(incidentBody, {status: 400, headers: {'content-type': 'application/json'}}),
    )

    const state = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')
    const human = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(state).toEqual({state: 'dead', reason: 'provider-missing'})
    expect(human.level).toBe('error')
    expect(human.summary).toBe(
      'Anthropic provider not registered for claude-sonnet-4-6 (HTTP 400) — check /v1/models; run: cliproxy login claude',
    )
    expect(JSON.stringify(state)).not.toContain('invalid_request_error')
  })

  it('classifies a non-JSON 400 carrying only the unknown-provider message as dead', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response('Error: Unknown provider for model claude-sonnet-4-6', {status: 400}),
    )

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'dead', reason: 'provider-missing'})
  })

  it('classifies a JSON 400 with only the model_not_found code as dead', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response('{"error":{"code":"model_not_found","message":"nope"}}', {status: 400}),
    )

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'dead', reason: 'provider-missing'})
  })

  it('keeps a 400 without provider-missing markers unknown/unrelated-http', async () => {
    for (const body of [
      '{"error":{"message":"max_tokens must be positive","type":"invalid_request_error","code":"invalid_value"}}',
      'Bad Request',
      '',
    ]) {
      globalThis.fetch = createFetchImplementation(async () => new Response(body, {status: 400}))

      const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

      expect(result).toEqual({state: 'unknown', reason: 'unrelated-http'})
    }
  })

  it('reads the provider probe response body at most once', async () => {
    for (const [status, body, reason] of [
      [400, '{"error":{"code":"model_not_found"}}', 'provider-missing'],
      [400, 'Bad Request', 'unrelated-http'],
      [503, 'auth_unavailable', 'auth-unavailable-503'],
      [503, 'Service Unavailable', 'unrelated-http'],
    ] as const) {
      const response = new Response(body, {status})
      const textSpy = spyOn(response, 'text')
      globalThis.fetch = createFetchImplementation(async () => response)

      const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

      expect(result.reason).toBe(reason)
      expect(textSpy.mock.calls.length).toBeLessThanOrEqual(1)
      expect(response.bodyUsed).toBe(textSpy.mock.calls.length === 1)
    }
  })

  it('classifies unrelated HTTP failures as unknown without response data', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('secret upstream diagnostic', {status: 503}))

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'unknown', reason: 'unrelated-http'})
    expect(JSON.stringify(result)).not.toContain('secret upstream diagnostic')
  })

  it('classifies network failures as unknown without exception text', async () => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('secret socket details and URL https://private.example')
    })

    const result = await checkProviderAuthState('https://cliproxy.example.com', 'test-api-key')

    expect(result).toEqual({state: 'unknown', reason: 'network'})
    expect(JSON.stringify(result)).not.toContain('secret socket details')
    expect(JSON.stringify(result)).not.toContain('private.example')
  })

  it('returns error when POST returns 401', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('Unauthorized', {status: 401}))

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('error')
    expect(result.summary).toContain('401')
    expect(result.summary).toContain('cliproxy login claude')
  })

  it('returns error when POST returns 503 with auth_unavailable body', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response('auth_unavailable: no auth available (providers=claude)', {status: 503}),
    )

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('error')
    expect(result.summary).toContain('503')
    expect(result.summary).toContain('cliproxy login claude')
  })

  it('returns error when POST returns 503 with "no auth available" in body', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('no auth available', {status: 503}))

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('error')
    expect(result.summary).toContain('cliproxy login claude')
  })

  it('returns error when POST returns 503 with "providers=claude" in body', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response('{"error":"providers=claude unavailable"}', {status: 503}),
    )

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('error')
    expect(result.summary).toContain('cliproxy login claude')
  })

  it('returns warning when POST returns 503 without auth-unavailable markers', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('Service Unavailable', {status: 503}))

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('warning')
    expect(result.summary).toContain('503')
    expect(result.summary).not.toContain('cliproxy login claude')
  })

  it('returns warning when POST returns other non-2xx (e.g. 500)', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('Internal Server Error', {status: 500}))

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('warning')
    expect(result.summary).toContain('500')
  })

  it('returns warning (not error) when fetch throws (network/timeout)', async () => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('The operation was aborted due to timeout')
    })

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(result.level).toBe('warning')
    expect(result.summary).toContain('Anthropic probe failed')
    expect(result.summary).toContain('aborted')
  })

  it('never includes the apiKey in summary or details', async () => {
    const secretKey = 'super-secret-api-key-do-not-leak'

    globalThis.fetch = createFetchImplementation(async () => new Response('Unauthorized', {status: 401}))

    const result = await checkProviderAuth('https://cliproxy.example.com', secretKey)

    expect(result.summary).not.toContain(secretKey)
    const detailsText = (result.details ?? []).join('\n')
    expect(detailsText).not.toContain(secretKey)
  })

  it('uses the default model claude-sonnet-4-6 when no model override given', async () => {
    let capturedBody = ''

    globalThis.fetch = createFetchImplementation(async (_url, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      return new Response(JSON.stringify({choices: []}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    await checkProviderAuth('https://cliproxy.example.com', 'test-api-key')

    expect(capturedBody).toContain('claude-sonnet-4-6')
  })

  it('uses the model override when options.model is provided', async () => {
    let capturedBody = ''

    globalThis.fetch = createFetchImplementation(async (_url, init) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      return new Response(JSON.stringify({choices: []}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    await checkProviderAuth('https://cliproxy.example.com', 'test-api-key', {model: 'claude-opus-4-5'})

    expect(capturedBody).toContain('claude-opus-4-5')
    expect(capturedBody).not.toContain('claude-sonnet-4-6')
  })

  it('includes verbose details (URL, model, status) when verbose=true', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({choices: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const result = await checkProviderAuth('https://cliproxy.example.com', 'test-api-key', {verbose: true})

    expect(result.details).toBeDefined()
    const detailsText = (result.details ?? []).join('\n')
    expect(detailsText).toContain('https://cliproxy.example.com')
    expect(detailsText).toContain('claude-sonnet-4-6')
  })
})

// ─── cliproxyStatusAction — provider auth wiring ─────────────────────────────

describe('cliproxyStatusAction — provider auth probe wiring', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      CLIPROXY_URL: process.env.CLIPROXY_URL,
      CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
    }
    delete process.env.CLIPROXY_URL
    delete process.env.CLIPROXY_MANAGEMENT_KEY
    delete process.env.CLIPROXY_API_KEY
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    globalThis.fetch = originalFetch
  })

  it('shows a warning (not error) when no provider key is available', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toMatch(/CLIPROXY_API_KEY|skipping upstream provider probe/i)
    // Must be a warning, not an error — no exit(1) for missing key
    expect(captured.exit).toBeNull()
  })

  it('runs the provider auth probe when --api-key is provided', async () => {
    const fetchedUrls: string[] = []

    globalThis.fetch = createFetchImplementation(async url => {
      fetchedUrls.push(url)
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v1/chat/completions'))
        return new Response(JSON.stringify({choices: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(fetchedUrls.some(u => u.includes('/v1/chat/completions'))).toBe(true)
    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('Upstream provider auth')
  })

  it('does NOT forward ambient CLIPROXY_API_KEY to an explicit --url override', async () => {
    process.env.CLIPROXY_API_KEY = 'ambient-api-key-secret'

    const capturedAuthHeaders: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      let auth: string | null = null
      if (hdrs instanceof Headers) {
        auth = hdrs.get('authorization')
      } else if (hdrs !== null && hdrs !== undefined && typeof hdrs === 'object') {
        const hdrsObj = hdrs as Record<string, string>
        auth = hdrsObj.authorization ?? hdrsObj.Authorization ?? null
      }
      if (auth) capturedAuthHeaders.push(auth)

      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v1/chat/completions')) return new Response(JSON.stringify({choices: []}), {status: 200})
      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    // Explicit --url override to a non-trusted host — ambient key must NOT follow
    await cliproxyStatusAction(
      {url: 'https://evil.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    // The ambient API key must not appear in any Authorization header sent to evil host
    expect(capturedAuthHeaders.some(h => h.includes('ambient-api-key-secret'))).toBe(false)
  })

  it('uses ambient CLIPROXY_API_KEY when URL is the trusted default', async () => {
    process.env.CLIPROXY_API_KEY = 'ambient-api-key-trusted'

    const capturedAuthHeaders: string[] = []

    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      let auth: string | null = null
      if (hdrs instanceof Headers) {
        auth = hdrs.get('authorization')
      } else if (hdrs !== null && hdrs !== undefined && typeof hdrs === 'object') {
        const hdrsObj = hdrs as Record<string, string>
        auth = hdrsObj.authorization ?? hdrsObj.Authorization ?? null
      }
      if (auth) capturedAuthHeaders.push(auth)

      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v1/chat/completions'))
        return new Response(JSON.stringify({choices: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      // Management endpoints — return ok so management checks don't block
      if (url.includes('/v0/management/config'))
        return new Response('{}', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/usage-queue'))
        return new Response('[]', {status: 200, headers: {'content-type': 'application/json'}})
      if (url.includes('/v0/management/latest-version'))
        return new Response(JSON.stringify({'latest-version': 'v1.0.0'}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      return new Response('ok', {status: 200})
    })

    const {ctx} = createCapturedCtx()
    // Default trusted URL — ambient key SHOULD be used
    await cliproxyStatusAction(
      {url: 'https://cliproxy.fro.bot'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(capturedAuthHeaders.some(h => h.includes('ambient-api-key-trusted'))).toBe(true)
  })

  it('provider auth error (401) causes exit(1) — dead upstream is a real error', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.includes('/v1/chat/completions')) return new Response('Unauthorized', {status: 401})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    let threw: unknown
    try {
      await cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      )
    } catch (error) {
      threw = error
    }

    expect(threw).toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
  })
})
