import type {ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'

import {afterEach, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  checkGoRoute,
  checkGoRouteState,
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
  probeGoRoute,
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

  it.each([
    [401, 'denied'],
    [403, 'denied'],
    [429, 'rate-limited'],
    [500, 'unavailable'],
    [503, 'unavailable'],
  ] as const)('maps a %d auth probe response to managementAccess %s', async (status, expected) => {
    globalThis.fetch = managementFetch({status})

    const collection = await getCliproxyStatusSummary(BASE, 'some-key', runningSpawn())

    expect(collection.facts).toMatchObject({managementAccess: expected, latestVersion: null, usage: null})
    expect(collection.observations[0]?.result).toBe('pass')
  })

  it('maps a 403 ip-ban body to denied', async () => {
    globalThis.fetch = createFetchImplementation(async () => Response.json({error: 'IP banned'}, {status: 403}))

    const collection = await getCliproxyStatusSummary(BASE, 'some-key', runningSpawn())

    expect(collection.facts.managementAccess).toBe('denied')
  })

  it('maps a network error on the auth probe to unavailable', async () => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('socket hang up')
    })

    const collection = await getCliproxyStatusSummary(BASE, 'some-key', runningSpawn())

    expect(collection.facts).toMatchObject({managementAccess: 'unavailable', latestVersion: null, usage: null})
    expect(JSON.stringify(collection)).not.toContain('socket')
  })

  it('keeps managementAccess ok when the auth probe passes but usage and version requests fail', async () => {
    globalThis.fetch = createFetchImplementation(async url =>
      url.endsWith('/v0/management/config')
        ? Response.json({})
        : new Response('boom', {status: url.includes('usage-queue') ? 500 : 429}),
    )

    const collection = await getCliproxyStatusSummary(BASE, 'good-key', runningSpawn())

    expect(collection.facts).toEqual({
      runningVersion: 'v7.2.139',
      latestVersion: null,
      usage: null,
      managementAccess: 'ok',
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

describe('cliproxy abort signal', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('passes the signal to the ssh spawn in getCliproxyStatusSummary and inspectRunningContainer', async () => {
    globalThis.fetch = createFetchImplementation(async () => Response.json({}))
    const controller = new AbortController()
    const seen: (AbortSignal | undefined)[] = []
    const spawn: SpawnFn = (cmd, opts) => {
      seen.push(opts.signal)
      return makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n')(cmd, opts)
    }

    await getCliproxyStatusSummary('https://cliproxy.example.com', '', spawn, controller.signal)
    await inspectRunningContainer('cliproxy-example-com', spawn, controller.signal)

    expect(seen).toEqual([controller.signal, controller.signal])
  })

  it('omits the signal option when none is given', async () => {
    const seen: string[][] = []
    const spawn: SpawnFn = (cmd, opts) => {
      seen.push(Object.keys(opts))
      return makeSpawnResult('')(cmd, opts)
    }

    await inspectRunningContainer('cliproxy-example-com', spawn)

    expect(seen.flat()).not.toContain('signal')
  })
})

/** The proxy lists each Go model twice: bare and prefixed, both owned by opencode-go. */
function modelList(ids: string[]): Response {
  const data = ids.flatMap(id => [
    {id, object: 'model', owned_by: 'opencode-go'},
    {id: `opencode-go/${id}`, object: 'model', owned_by: 'opencode-go'},
  ])
  return Response.json({object: 'list', data: [{id: 'claude-sonnet-4-6', owned_by: 'anthropic'}, ...data]})
}

// Fixed policy for every Go test below: the committed snapshot and settings change by design, so no test reads them.
const goEntry = (overrides: Partial<ParsedSnapshot['models'][string]> = {}) => ({
  zeroRetention: true,
  trainsOnData: false,
  regionGated: false,
  agreementExpiry: null,
  ...overrides,
})
const GO_SNAPSHOT: ParsedSnapshot = {
  source: {
    repo: 'anomalyco/opencode',
    path: 'services/site/src/docs/content/console/go.mdx',
    commit: 'a'.repeat(40),
  },
  models: {
    'glm-5.3': goEntry(),
    'kimi-k3': goEntry(),
    'trains-on-data': goEntry({trainsOnData: true}),
    'expired-model': goEntry({agreementExpiry: '2026-11-03'}),
  },
  invalid: [],
}
const GO_SETTINGS = {enabled: true, defaultProbeModel: 'glm-5.3'}

describe('checkGoRouteState (OpenCode Go classification)', () => {
  const BASE = 'https://cliproxy.example.com'
  const KEY = 'go-probe-secret-key'
  const NOW = new Date('2026-11-04T12:00:00.000Z')
  const entry = goEntry
  const snapshot = GO_SNAPSHOT
  const settings = GO_SETTINGS
  const options = {snapshot, settings, now: NOW}

  const goOk = () => Response.json({choices: [], usage: {opencode: {billing_source: 'go'}}})

  interface Seen {
    url: string
    method: string
    headers: Record<string, string>
    body?: string
  }

  function install(models: () => Response | Promise<Response>, chat: () => Response | Promise<Response>): Seen[] {
    const seen: Seen[] = []
    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const headers = Object.fromEntries(new Headers(init?.headers).entries())
      seen.push({
        url,
        method: init?.method ?? 'GET',
        headers,
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      if (url.endsWith('/v1/models')) return models()
      if (url.endsWith('/v1/chat/completions')) return chat()
      throw new Error(`Unexpected fetch: ${url}`)
    })
    return seen
  }

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('is healthy/ok for a 2xx with billing_source go', async () => {
    install(() => modelList(['glm-5.3', 'kimi-k3']), goOk)

    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'healthy', reason: 'ok'})
  })

  it('is unknown/billing-fallback (a warning) for a 2xx billed to a present non-go source', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => Response.json({usage: {opencode: {billing_source: 'balance'}}}),
    )

    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'billing-fallback'})
    const human = await checkGoRoute(BASE, KEY, options)
    expect(human.level).toBe('warning')
    expect(human.summary).toContain('"balance"')
    expect(human.summary).toContain('glm-5.3')
  })

  it('reports the observed billing token alongside the classification', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => Response.json({usage: {opencode: {billing_source: 'balance'}}}),
    )
    expect(await probeGoRoute(BASE, KEY, options)).toEqual({
      classification: {state: 'unknown', reason: 'billing-fallback'},
      billingSource: 'balance',
    })

    install(() => modelList(['glm-5.3']), goOk)
    expect(await probeGoRoute(BASE, KEY, options)).toEqual({
      classification: {state: 'healthy', reason: 'ok'},
      billingSource: 'go',
    })
  })

  it('bounds a weird billing_source to the token `other` and never prints it', async () => {
    for (const weird of ['bal ance <b>HOSTILE_BODY</b>', 'x'.repeat(33), 'caf\u00E9']) {
      install(
        () => modelList(['glm-5.3']),
        () => Response.json({usage: {opencode: {billing_source: weird}}}),
      )
      expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'billing-fallback'})
      expect((await probeGoRoute(BASE, KEY, options)).billingSource).toBe('other')
      const human = await checkGoRoute(BASE, KEY, options)
      expect(human.summary).toContain('"other"')
      expect(JSON.stringify(human)).not.toContain('HOSTILE_BODY')
    }
  })

  it('is dead/billing-not-go for a 2xx with a missing, null, non-string or empty billing_source', async () => {
    for (const body of [
      {usage: {opencode: {}}},
      {usage: {}},
      {choices: []},
      {usage: {opencode: {billing_source: null}}},
      {usage: {opencode: {billing_source: 7}}},
      {usage: {opencode: {billing_source: ''}}},
    ]) {
      install(
        () => modelList(['glm-5.3']),
        () => Response.json(body),
      )
      expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'billing-not-go'})
      expect((await probeGoRoute(BASE, KEY, options)).billingSource).toBeUndefined()
    }
    install(
      () => modelList(['glm-5.3']),
      () => new Response('not json', {status: 200}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'billing-not-go'})
  })

  it('is dead/provider-missing when no opencode-go models are listed', async () => {
    const seen = install(() => Response.json({data: [{id: 'claude-sonnet-4-6', owned_by: 'anthropic'}]}), goOk)

    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'provider-missing'})
    expect(seen.some(request => request.url.endsWith('/v1/chat/completions'))).toBe(false)
  })

  it('is dead/provider-missing for a model_not_found 400 or the unknown-provider message', async () => {
    const coded =
      '{"error":{"message":"unknown provider for model glm-5.3","type":"invalid_request_error","code":"model_not_found"}}'
    for (const body of [coded, 'unknown provider for model glm-5.3']) {
      install(
        () => modelList(['glm-5.3']),
        () => new Response(body, {status: 400}),
      )
      expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'provider-missing'})
    }
  })

  it('is dead/privacy-noncompliant when an exposed model is not eligible, without probing', async () => {
    for (const exposed of [
      ['glm-5.3', 'trains-on-data'],
      ['glm-5.3', 'expired-model'],
      ['glm-5.3', 'not-in-snapshot'],
    ]) {
      const seen = install(() => modelList(exposed), goOk)
      expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'privacy-noncompliant'})
      expect(seen.some(request => request.url.endsWith('/v1/chat/completions'))).toBe(false)
    }
  })

  it('treats an agreement that expires today as still eligible', async () => {
    const edge = {...snapshot, models: {...snapshot.models, 'glm-5.3': entry({agreementExpiry: '2026-11-04'})}}
    install(() => modelList(['glm-5.3']), goOk)

    expect(await checkGoRouteState(BASE, KEY, {...options, snapshot: edge})).toEqual({state: 'healthy', reason: 'ok'})
  })

  it('is dead/quota-or-billing for 429 and 402', async () => {
    for (const status of [429, 402]) {
      install(
        () => modelList(['glm-5.3']),
        () => new Response('limit', {status}),
      )
      expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'quota-or-billing'})
    }
  })

  it('is dead/auth-401 for a 401 on the request and on the model list', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => new Response('nope', {status: 401}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'auth-401'})

    install(() => new Response('nope', {status: 401}), goOk)
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'auth-401'})
  })

  it('is dead/auth-unavailable-503 only for a 503 carrying the marker', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => new Response('auth_unavailable: no auth available', {status: 503}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'auth-unavailable-503'})

    install(
      () => modelList(['glm-5.3']),
      () => new Response('temporary', {status: 503}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'unrelated-http'})
  })

  it('is dead/session-header-dropped for a 400 MissingSessionID, because the probe always sends the header', async () => {
    const body = '{"type":"MissingSessionID","message":"x-opencode-session is required"}'
    install(
      () => modelList(['glm-5.3']),
      () => new Response(body, {status: 400}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'session-header-dropped'})

    const nested = '{"error":{"type":"MissingSessionID"}}'
    install(
      () => modelList(['glm-5.3']),
      () => new Response(nested, {status: 400}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'dead', reason: 'session-header-dropped'})
  })

  it('sends x-opencode-session on the request that is classified session-header-dropped', async () => {
    const seen = install(
      () => modelList(['glm-5.3']),
      () => new Response('{"type":"MissingSessionID"}', {status: 400}),
    )
    await checkGoRouteState(BASE, KEY, options)

    const chat = seen.find(request => request.url.endsWith('/v1/chat/completions'))
    expect(chat?.headers['x-opencode-session']).toMatch(/^infra-monitor-.+/)
  })

  it('names the dropped header in the human summary', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => new Response('{"type":"MissingSessionID"}', {status: 400}),
    )
    const result = await checkGoRoute(BASE, KEY, options)

    expect(result.level).toBe('error')
    expect(result.summary).toContain('stopped forwarding the x-opencode-session header')
  })

  it('is unknown/unrelated-http for any other non-2xx, and for a bad or failing model list', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => new Response('teapot', {status: 418}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'unrelated-http'})

    install(
      () => modelList(['glm-5.3']),
      () => new Response('{"error":{"message":"bad"}}', {status: 400}),
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'unrelated-http'})

    install(() => new Response('boom', {status: 500}), goOk)
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'unrelated-http'})

    install(() => Response.json({nope: true}), goOk)
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'unrelated-http'})
  })

  it('is unknown/timeout or unknown/network for a thrown error, on either request', async () => {
    install(
      () => modelList(['glm-5.3']),
      () => {
        throw new DOMException('', 'TimeoutError')
      },
    )
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'timeout'})

    install(() => {
      throw new Error('socket hang up')
    }, goOk)
    expect(await checkGoRouteState(BASE, KEY, options)).toEqual({state: 'unknown', reason: 'network'})
  })

  it('prefers the default probe model and falls back to the first exposed id when it is missing', async () => {
    const preferred = install(() => modelList(['glm-5.3', 'kimi-k3']), goOk)
    await checkGoRouteState(BASE, KEY, options)
    const preferredBody = preferred.find(request => request.url.endsWith('/v1/chat/completions'))?.body
    expect(JSON.parse(preferredBody ?? '{}')).toMatchObject({model: 'glm-5.3', max_tokens: 1})

    const fallback = install(() => modelList(['kimi-k3']), goOk)
    await checkGoRouteState(BASE, KEY, options)
    const fallbackBody = fallback.find(request => request.url.endsWith('/v1/chat/completions'))?.body
    expect(JSON.parse(fallbackBody ?? '{}').model).toBe('kimi-k3')

    const bare = install(() => modelList(['kimi-k3']), goOk)
    await checkGoRouteState(BASE, KEY, {...options, settings: {enabled: true}})
    expect(JSON.parse(bare.find(r => r.url.endsWith('/v1/chat/completions'))?.body ?? '{}').model).toBe('kimi-k3')
  })

  it('sends a fresh non-empty x-opencode-session on every request, and never reuses one', async () => {
    const sessions: string[] = []
    for (let run = 0; run < 2; run += 1) {
      const seen = install(() => modelList(['glm-5.3']), goOk)
      await checkGoRouteState(BASE, KEY, options)
      const chat = seen.find(request => request.url.endsWith('/v1/chat/completions'))
      expect(chat?.method).toBe('POST')
      expect(chat?.headers['x-opencode-session']).toMatch(/^infra-monitor-[\da-f-]{36}$/)
      expect(chat?.headers.authorization).toBe(`Bearer ${KEY}`)
      sessions.push(chat?.headers['x-opencode-session'] ?? '')
    }
    expect(new Set(sessions).size).toBe(2)
  })

  it('consults the committed snapshot by default: an id it cannot list is privacy-noncompliant', async () => {
    install(() => modelList(['no-such-model-in-any-snapshot']), goOk)

    expect(await checkGoRouteState(BASE, KEY)).toEqual({state: 'dead', reason: 'privacy-noncompliant'})
  })

  it('keeps the key, session id, usage and cost out of every human summary and detail', async () => {
    const body = {
      usage: {opencode: {billing_source: 'go', list_cost: '0.00006', allowance: {remaining: 41}}},
      hostile: 'HOSTILE_BODY',
    }
    for (const verbose of [false, true]) {
      install(
        () => modelList(['glm-5.3']),
        () => Response.json(body),
      )
      const ok = await checkGoRoute(BASE, KEY, {...options, verbose})
      install(
        () => modelList(['glm-5.3']),
        () => new Response('HOSTILE_BODY secret', {status: 502}),
      )
      const odd = await checkGoRoute(BASE, KEY, {...options, verbose})
      install(() => {
        throw new Error(`HOSTILE_BODY ${KEY}`)
      }, goOk)
      const thrown = await checkGoRoute(BASE, KEY, {...options, verbose})

      for (const result of [ok, odd, thrown]) {
        const text = JSON.stringify(result)
        expect(text).not.toContain(KEY)
        expect(text).not.toContain('HOSTILE_BODY')
        expect(text).not.toContain('infra-monitor-')
        expect(text).not.toContain('list_cost')
        expect(text).not.toContain('0.00006')
        expect(text).not.toContain('allowance')
      }
    }
  })

  it('maps the human check to ok, error and warning under its own heading', async () => {
    install(() => modelList(['glm-5.3']), goOk)
    expect(await checkGoRoute(BASE, KEY, options)).toMatchObject({
      title: 'OpenCode Go route',
      level: 'ok',
      summary: 'opencode-go route OK (glm-5.3)',
    })

    install(
      () => modelList(['glm-5.3']),
      () => new Response('limit', {status: 429}),
    )
    expect((await checkGoRoute(BASE, KEY, options)).level).toBe('error')

    install(
      () => modelList(['glm-5.3']),
      () => new Response('teapot', {status: 418}),
    )
    expect((await checkGoRoute(BASE, KEY, options)).level).toBe('warning')

    install(() => modelList(['glm-5.3', 'trains-on-data']), goOk)
    expect((await checkGoRoute(BASE, KEY, options)).summary).toContain('trains-on-data')
  })
})

describe('cliproxyStatusAction — Go route wiring', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('adds a Go route check after the unchanged Claude check when a provider key is present', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.endsWith('/v1/models')) return Response.json({data: [{id: 'glm-5.3', owned_by: 'opencode-go'}]})
      if (url.includes('/v1/chat/completions'))
        return Response.json({choices: [], usage: {opencode: {billing_source: 'go'}}})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      GO_SETTINGS,
      GO_SNAPSHOT,
    )

    const output = captured.stdout.join('\n')
    expect(output).toContain('[OK] Upstream provider auth (anthropic)')
    expect(output).toContain('anthropic route OK (claude-sonnet-4-6)')
    expect(output).toContain('[OK] OpenCode Go route')
    expect(output.indexOf('Upstream provider auth (anthropic)')).toBeLessThan(output.indexOf('OpenCode Go route'))
    expect(captured.exit).toBeNull()
  })

  it('runs no Go request without a provider key', async () => {
    const urls: string[] = []
    globalThis.fetch = createFetchImplementation(async url => {
      urls.push(url)
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
    )

    expect(urls.some(url => url.includes('/v1/'))).toBe(false)
  })

  it('does not exit 1 when the Go route is on the credits fallback', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.endsWith('/v1/models')) return Response.json({data: [{id: 'glm-5.3', owned_by: 'opencode-go'}]})
      if (url.includes('/v1/chat/completions'))
        return Response.json({choices: [], usage: {opencode: {billing_source: 'balance'}}})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      GO_SETTINGS,
      GO_SNAPSHOT,
    )

    const output = captured.stdout.join('\n')
    expect(output).toContain('[WARN] OpenCode Go route')
    expect(captured.exit).toBeNull()
  })

  it('exits 1 when only the Go route is dead', async () => {
    globalThis.fetch = createFetchImplementation(async url => {
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.endsWith('/v1/models')) return Response.json({data: []})
      if (url.includes('/v1/chat/completions')) return Response.json({choices: []})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyStatusAction(
        {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
        ctx,
        makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
        GO_SETTINGS,
        GO_SNAPSHOT,
      ),
    ).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
  })
})

describe('Go route when the tracked settings turn it off', () => {
  const disabled = {enabled: false, defaultProbeModel: 'glm-5.3'}

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('checkGoRoute makes no request and reports an informational ok line', async () => {
    const urls: string[] = []
    globalThis.fetch = createFetchImplementation(async url => {
      urls.push(url)
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const result = await checkGoRoute('https://cliproxy.example.com', 'k', {settings: disabled})

    expect(urls).toEqual([])
    expect(result).toEqual({
      title: 'OpenCode Go route',
      level: 'ok',
      summary: 'disabled by tracked settings — not probed',
    })
  })

  it('does not change the exit code when Go would otherwise be dead', async () => {
    const urls: string[] = []
    globalThis.fetch = createFetchImplementation(async url => {
      urls.push(url)
      if (url.includes('/healthz')) return new Response('ok', {status: 200})
      if (url.endsWith('/v1/models')) return Response.json({data: []})
      if (url.includes('/v1/chat/completions')) return Response.json({choices: []})
      throw new Error(`Unexpected fetch: ${url}`)
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyStatusAction(
      {url: 'https://cliproxy.example.com', apiKey: 'my-api-key'},
      ctx,
      makeSpawnResult('eceasy/cli-proxy-api:v7.2.139\n'),
      disabled,
    )

    const output = captured.stdout.join('\n')
    expect(output).toContain('[OK] OpenCode Go route')
    expect(output).toContain('disabled by tracked settings')
    expect(urls.some(url => url.endsWith('/v1/models'))).toBe(false)
    expect(captured.exit).toBeNull()
  })
})
