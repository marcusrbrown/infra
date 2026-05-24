import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude} from '../../__test__/mcp-ctx-fixture'
import {
  checkContentHash,
  checkHttpReachability,
  checkLastDeploy,
  formatDate,
  formatDurationMs,
  hashSha256,
  keewebStatusAction,
} from './status'

const originalFetch = globalThis.fetch

type SpawnResult = ReturnType<typeof Bun.spawn>

function createFetchImplementation(
  handler: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => ReturnType<typeof fetch>,
): typeof fetch {
  return Object.assign(
    (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => handler(input, init),
    {preconnect: originalFetch.preconnect},
  )
}

function textStream(value: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(value))
      controller.close()
    },
  })
}

function mockSpawnResult(exitCode: number, stdout: string, stderr = ''): SpawnResult {
  return {
    exited: Promise.resolve(exitCode),
    stdout: textStream(stdout),
    stderr: textStream(stderr),
  } as unknown as SpawnResult
}

describe('keeweb status helpers', () => {
  let fetchMock: ReturnType<typeof mock<typeof fetch>>
  let fileSpy: ReturnType<typeof spyOn<typeof Bun, 'file'>> | undefined
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, 'spawn'>> | undefined

  beforeEach(() => {
    fetchMock = mock(
      createFetchImplementation(async () => {
        throw new Error('Unexpected fetch call')
      }),
    )
    globalThis.fetch = Object.assign(fetchMock, {preconnect: originalFetch.preconnect})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fileSpy?.mockRestore()
    fileSpy = undefined
    spawnSpy?.mockRestore()
    spawnSpy = undefined
  })

  describe('hashSha256', () => {
    it('returns the known digest for hello', () => {
      expect(hashSha256('hello')).toBe('2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824')
    })

    it('returns the known digest for an empty string', () => {
      expect(hashSha256('')).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855')
    })
  })

  describe('formatDate', () => {
    it('formats valid ISO dates', () => {
      const value = '2026-01-15T10:30:00Z'
      const formatted = formatDate(value)

      expect(formatted).not.toBe(value)
      expect(formatted).not.toContain('NaN')
      expect(formatted).toContain('2026')
    })

    it('passes through invalid dates', () => {
      expect(formatDate('not-a-date')).toBe('not-a-date')
    })
  })

  describe('formatDurationMs', () => {
    it('formats positive durations', () => {
      expect(formatDurationMs(1234)).toBe('1234ms')
    })

    it('formats zero duration', () => {
      expect(formatDurationMs(0)).toBe('0ms')
    })

    it('clamps negative durations to zero', () => {
      expect(formatDurationMs(-5)).toBe('0ms')
    })
  })

  describe('checkHttpReachability', () => {
    it('returns ok for HTTP 200', async () => {
      fetchMock.mockImplementation(createFetchImplementation(async () => new Response('ok', {status: 200})))

      const result = await checkHttpReachability(false)

      expect(result.level).toBe('ok')
      expect(result.summary).toContain('GET https://kw.igg.ms/ → 200')
    })

    it('returns error for HTTP 500', async () => {
      fetchMock.mockImplementation(createFetchImplementation(async () => new Response('error', {status: 500})))

      const result = await checkHttpReachability(false)

      expect(result.level).toBe('error')
      expect(result.summary).toContain('GET https://kw.igg.ms/ → 500')
    })

    it('returns error details for network failures', async () => {
      fetchMock.mockImplementation(
        createFetchImplementation(async () => {
          throw new Error('Network timeout')
        }),
      )

      const result = await checkHttpReachability(true)

      expect(result.level).toBe('error')
      expect(result.summary).toContain('Network timeout')
      expect(result.details).toEqual(['URL: https://kw.igg.ms/', 'Timeout: 10000ms'])
    })
  })

  describe('checkLastDeploy', () => {
    it('returns ok for valid gh output', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
        mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('ok')
      expect(result.summary).toBe(formatDate('2026-01-15T10:30:00Z'))
      expect(result.details).toEqual(['Run URL: https://example.com'])
    })

    it('returns warning when no successful runs are found', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => mockSpawnResult(0, '[]'))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('No successful')
    })

    it('returns warning when gh exits non-zero', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => mockSpawnResult(1, '', 'boom'))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('gh exited 1')
    })

    it('returns warning when gh cannot be invoked', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => {
        throw new Error('gh not found')
      })

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('Unable to query')
      expect(result.summary).toContain('gh not found')
    })
  })

  describe('checkContentHash', () => {
    it('resolves dist path at correct depth from restructured location', async () => {
      // Regression test for P1 path depth bug: after restructure from
      // commands/keeweb-status.ts to commands/keeweb/status.ts, the path
      // needs 5 levels of ../ to reach apps/keeweb/dist/index.html
      let capturedPath = ''
      fileSpy = spyOn(Bun, 'file').mockImplementation((...args: unknown[]) => {
        capturedPath = String(args[0])
        return {exists: async () => false} as ReturnType<typeof Bun.file>
      })

      await checkContentHash(false)

      expect(capturedPath).toContain('apps/keeweb/dist/index.html')
      expect(capturedPath).not.toContain('commands/keeweb/apps')
    })

    it('returns warning when the local dist file does not exist', async () => {
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('not found')
    })
  })
})

describe('keewebStatusAction (Tier-2 ctx capture)', () => {
  let fetchMock: ReturnType<typeof mock<typeof fetch>>
  let fileSpy: ReturnType<typeof spyOn<typeof Bun, 'file'>> | undefined
  let spawnSpy: ReturnType<typeof spyOn<typeof Bun, 'spawn'>> | undefined

  beforeEach(() => {
    fetchMock = mock(
      createFetchImplementation(async () => {
        throw new Error('Unexpected fetch call')
      }),
    )
    globalThis.fetch = Object.assign(fetchMock, {preconnect: originalFetch.preconnect})
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    fileSpy?.mockRestore()
    fileSpy = undefined
    spawnSpy?.mockRestore()
    spawnSpy = undefined
  })

  it('writes "KeeWeb status" header to ctx.console.log (not global console)', async () => {
    // Mock HTTP 200
    fetchMock.mockImplementation(createFetchImplementation(async () => new Response('ok', {status: 200})))

    // Mock gh CLI returning a successful run
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
      mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
    )

    // Mock local dist file as missing (avoids filesystem dependency)
    fileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>,
    )

    const {ctx, captured} = createCapturedCtx()

    await keewebStatusAction({verbose: false}, ctx)

    // 'KeeWeb status' is the header line in the formatted output — the contract
    // marker confirming the action printed to ctx.console.log (captured) rather
    // than the real global console (which would not appear in `captured`).
    expect(expectCapturedToInclude(captured, 'KeeWeb status')).toBe(true)
    // Summary footer is always emitted; pairing it with the header proves both
    // ends of the formatted output flow through ctx capture.
    expect(expectCapturedToInclude(captured, 'Summary:')).toBe(true)
  })

  it('writes HTTP check result to captured stdout', async () => {
    fetchMock.mockImplementation(createFetchImplementation(async () => new Response('ok', {status: 200})))

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
      mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
    )

    fileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>,
    )

    const {ctx, captured} = createCapturedCtx()

    await keewebStatusAction({verbose: false}, ctx)

    expect(expectCapturedToInclude(captured, 'HTTP reachability')).toBe(true)
    expect(expectCapturedToInclude(captured, '[OK]')).toBe(true)
  })

  it('writes summary line to captured stdout', async () => {
    fetchMock.mockImplementation(createFetchImplementation(async () => new Response('ok', {status: 200})))

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
      mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
    )

    fileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>,
    )

    const {ctx, captured} = createCapturedCtx()

    await keewebStatusAction({verbose: false}, ctx)

    expect(expectCapturedToInclude(captured, 'Summary:')).toBe(true)
    expect(expectCapturedToInclude(captured, '3 checks')).toBe(true)
  })

  it('calls ctx.process.exit(1) when there are errors', async () => {
    // HTTP 500 → error level
    fetchMock.mockImplementation(createFetchImplementation(async () => new Response('error', {status: 500})))

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
      mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
    )

    fileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>,
    )

    const {ctx, captured} = createCapturedCtx()

    // ctx.process.exit throws MockProcessExit — catch it
    await expect(keewebStatusAction({verbose: false}, ctx)).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })

    expect(captured.exit).toEqual({code: 1})
  })

  it('does not call ctx.process.exit when all checks pass', async () => {
    fetchMock.mockImplementation(createFetchImplementation(async () => new Response('ok', {status: 200})))

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
      mockSpawnResult(0, JSON.stringify([{createdAt: '2026-01-15T10:30:00Z', url: 'https://example.com'}])),
    )

    fileSpy = spyOn(Bun, 'file').mockImplementation(
      () =>
        ({
          exists: async () => false,
        }) as ReturnType<typeof Bun.file>,
    )

    const {ctx, captured} = createCapturedCtx()

    await keewebStatusAction({verbose: false}, ctx)

    expect(captured.exit).toBeNull()
  })
})
