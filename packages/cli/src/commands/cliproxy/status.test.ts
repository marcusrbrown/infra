import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {
  checkHttpReachability,
  checkUsageStats,
  checkVersion,
  formatDurationMs,
  formatUsageSummaryLine,
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
    it('returns ok when failures are zero (nested usage object)', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(
            JSON.stringify({failed_requests: 0, usage: {total_requests: 10, failure_count: 0, success_count: 10}}),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('ok')
      expect(result.summary).toBe('total_requests=10, failure_count=0')
    })

    it('returns ok with flat payload (backwards compat)', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(JSON.stringify({total_requests: 10, failure_count: 0}), {
            status: 200,
            headers: {'content-type': 'application/json'},
          }),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('ok')
      expect(result.summary).toBe('total_requests=10, failure_count=0')
    })

    it('returns warning when token refresh is likely needed', async () => {
      globalThis.fetch = createFetchImplementation(
        async () =>
          new Response(
            JSON.stringify({failed_requests: 3, usage: {total_requests: 10, failure_count: 3, success_count: 7}}),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
      )

      const result = await checkUsageStats('https://cliproxy.example.com', 'secret')

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('total_requests=10, failure_count=3')
      expect(result.summary).toContain('token refresh likely needed')
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
    it('formats zero-failure summary', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'ok',
        summary: 'total_requests=10, failure_count=0',
      })

      expect(result).toBe('Requests: 10 total, 0 failed (0.0% failure rate)')
    })

    it('formats non-zero failure summary with correct rate', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'warning',
        summary: 'total_requests=10, failure_count=3 (token refresh likely needed)',
      })

      expect(result).toBe('Requests: 10 total, 3 failed (30.0% failure rate)')
    })

    it('returns null when summary has no numeric fields', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'warning',
        summary: 'Rate limited by management API (HTTP 429). Retry in a few moments.',
      })

      expect(result).toBeNull()
    })

    it('returns null for error summaries without numeric fields', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'error',
        summary: 'Unable to read usage stats: socket hang up',
      })

      expect(result).toBeNull()
    })

    it('handles zero total requests without division by zero', () => {
      const result = formatUsageSummaryLine({
        title: 'Usage stats',
        level: 'ok',
        summary: 'total_requests=0, failure_count=0',
      })

      expect(result).toBe('Requests: 0 total, 0 failed (0.0% failure rate)')
    })
  })
})
