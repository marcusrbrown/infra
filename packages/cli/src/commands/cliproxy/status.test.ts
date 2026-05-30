import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {
  checkHttpReachability,
  checkUsageStats,
  checkVersion,
  cliproxyStatusAction,
  formatDurationMs,
  formatUsageSummaryLine,
  getCliproxyStatusSummary,
  levelLabel,
  stripTrailingSlash,
  toNumber,
} from './status'

const originalFetch = globalThis.fetch

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

    await expect(cliproxyStatusAction({url: 'https://cliproxy.example.com'}, ctx)).rejects.toMatchObject({
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
    await cliproxyStatusAction({url: 'https://cliproxy.example.com'}, ctx)

    expect(expectCapturedToInclude(captured, 'CLIProxyAPI status')).toBe(true)
    expect(expectCapturedToInclude(captured, 'HTTP reachability')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Summary:')).toBe(true)
  })

  it('Mode A: calls ctx.process.exit(1) on HTTP error', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    let threw: unknown
    try {
      await cliproxyStatusAction({url: 'https://cliproxy.example.com'}, ctx)
    } catch (error) {
      threw = error
    }

    expect(threw).toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
    expect(expectCapturedToInclude(captured, 'ERROR')).toBe(true)
  })

  it('Mode A: shows management key warning when no key provided', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('ok', {status: 200}))

    const savedKey = process.env.CLIPROXY_MANAGEMENT_KEY
    delete process.env.CLIPROXY_MANAGEMENT_KEY
    try {
      const {ctx, captured} = createCapturedCtx()
      await cliproxyStatusAction({url: 'https://cliproxy.example.com'}, ctx)

      expect(expectCapturedToInclude(captured, 'CLIPROXY_MANAGEMENT_KEY')).toBe(true)
    } finally {
      if (savedKey !== undefined) process.env.CLIPROXY_MANAGEMENT_KEY = savedKey
    }
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

describe('management auth failure surfaces in unified summary (FIX 4)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('getCliproxyStatusSummary with a bad key (401) shows auth failure in version and usageStats, not "— (no key)"', async () => {
    globalThis.fetch = createFetchImplementation(async (url, init) => {
      const hdrs = init?.headers
      const hasKey =
        hdrs instanceof Headers
          ? hdrs.has('x-management-key')
          : hdrs !== null && hdrs !== undefined && typeof hdrs === 'object' && 'x-management-key' in hdrs
      if (url.includes('/v0/management/') && hasKey) {
        return new Response('Unauthorized', {status: 401})
      }

      return new Response('ok', {status: 200})
    })

    const summary = await getCliproxyStatusSummary('https://cliproxy.example.com', 'bad-key', false)

    // Must NOT show the no-key sentinel — a bad key is distinct from no key
    expect(summary.version).not.toBe('— (no key)')
    expect(summary.usageStats).not.toBe('— (no key)')
    // Must contain some error/auth indicator
    expect(summary.version.toLowerCase()).toMatch(/error|auth|401|management|unauthorized/i)
    expect(summary.usageStats.toLowerCase()).toMatch(/error|auth|401|management|unauthorized/i)
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
      await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: 'any-key'}, ctx)
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
      await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: 'any-key'}, ctx)
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
    await cliproxyStatusAction({url: BASE}, ctx)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).toContain('OK')
    expect(output).not.toMatch(/ERROR.*HTTP reachability|HTTP reachability.*ERROR/)
  })

  it('getCliproxyStatusSummary reports http ok when /healthz returns 200 and bare base returns 404', async () => {
    const BASE = 'https://cliproxy.example.com'
    globalThis.fetch = createFetchImplementation(async url => {
      if (url === `${BASE}/healthz`) return new Response('{"status":"ok"}', {status: 200})
      if (url === BASE) return new Response('Not Found', {status: 404})
      return new Response('ok', {status: 200})
    })

    const summary = await getCliproxyStatusSummary(BASE, '', false)

    expect(summary.http).toMatch(/^OK/)
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
      await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: 'bad-key'}, ctx)
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
      await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: 'any-key'}, ctx)
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
      await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: secretKey}, ctx)
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
    await cliproxyStatusAction({url: 'https://cliproxy.example.com', key: 'valid-key'}, ctx)

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

    await getCliproxyStatusSummary('https://cliproxy.example.com', 'bad-key', false)

    expect(managementFetchUrls.length).toBe(1)
  })
})
