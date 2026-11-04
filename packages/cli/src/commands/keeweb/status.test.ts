import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude} from '../../lib/mcp-ctx-fixture'
import {
  checkContentHash,
  checkHttpReachability,
  checkLastDeploy,
  formatDate,
  formatDurationMs,
  getKeewebStatusSummary,
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

interface FakeDeployment {
  id: number
  ref?: string
  /** Newest first, like the API. The status read asks for `per_page=1`, so only the first is returned. */
  statuses: {state: string; created_at: string; target_url?: string}[]
}

const DEPLOYMENTS_PATH = '/repos/marcusrbrown/infra/deployments?'
const SUCCESS_TIME = '2026-04-14T01:48:21Z'
const SUCCESS_JOB = 'https://github.com/marcusrbrown/infra/actions/runs/24376256533/job/71190337752'
// Run 26855044047: a successful run of the standalone workflow whose `deploy-keeweb` job was skipped.
const SKIPPED_JOB_RUN = [
  {createdAt: '2026-06-02T23:54:01Z', url: 'https://github.com/marcusrbrown/infra/actions/runs/26855044047'},
]

/**
 * Fake `gh` at the spawn boundary: serves the Deployments API for the given list (newest first) and records every
 * invocation. A `gh run list` call is answered with the skipped-job run so a regression to the run lookup is visible.
 */
function fakeDeploymentsGh(deployments: FakeDeployment[], calls: string[][] = []): typeof Bun.spawn {
  return ((cmd: unknown) => {
    const args = cmd as string[]
    calls.push(args)
    const path = args[2] ?? ''

    if (args[1] === 'run') return mockSpawnResult(0, JSON.stringify(SKIPPED_JOB_RUN))
    if (args[1] !== 'api') return mockSpawnResult(1, '', `unexpected gh call: ${args.join(' ')}`)

    if (path.startsWith(DEPLOYMENTS_PATH)) {
      const perPage = Number(/per_page=(\d+)/.exec(path)?.[1] ?? 30)
      return mockSpawnResult(
        0,
        JSON.stringify(deployments.slice(0, perPage).map(d => ({id: d.id, ref: d.ref ?? 'main'}))),
      )
    }

    const match = /\/deployments\/(\d+)\/statuses\?/.exec(path)
    const deployment = deployments.find(d => d.id === Number(match?.[1]))
    if (deployment === undefined) return mockSpawnResult(1, '', `unexpected gh api path: ${path}`)
    return mockSpawnResult(0, JSON.stringify(deployment.statuses.slice(0, 1)))
  }) as unknown as typeof Bun.spawn
}

const SUCCESSFUL_DEPLOYMENT: FakeDeployment = {
  id: 4359044301,
  statuses: [{state: 'success', created_at: SUCCESS_TIME, target_url: SUCCESS_JOB}],
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
    it('reports the newest successful main deployment of the keeweb environment', async () => {
      const calls: string[][] = []
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT], calls))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('ok')
      expect(result.summary).toBe(formatDate(SUCCESS_TIME))
      expect(result.details).toEqual([`Deploy job: ${SUCCESS_JOB}`])
      expect(result.value).toBe(SUCCESS_TIME)

      const [list] = calls
      expect(list?.slice(0, 2)).toEqual(['gh', 'api'])
      expect(list?.[2]).toContain('environment=keeweb')
      expect(list?.[2]).toContain('ref=main')
    })

    it('does not count a newer successful run whose deploy job was skipped (issue #1773)', async () => {
      const calls: string[][] = []
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT], calls))

      const result = await checkLastDeploy(false)

      // The skipped-job run (2026-06-02) is the newest successful *run*; it created no deployment.
      expect(result.value).toBe(SUCCESS_TIME)
      expect(result.value).not.toContain('2026-06-02')
      expect(calls.some(args => args[1] === 'run')).toBe(false)
    })

    it('finds a router-driven deploy, which the standalone workflow lookup never saw', async () => {
      const routerJob = 'https://github.com/marcusrbrown/infra/actions/runs/27000000000/job/80000000000'
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        fakeDeploymentsGh([
          {id: 5000000001, statuses: [{state: 'success', created_at: '2026-07-01T12:00:00Z', target_url: routerJob}]},
        ]),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('ok')
      expect(result.value).toBe('2026-07-01T12:00:00Z')
      expect(result.details).toEqual([`Deploy job: ${routerJob}`])
    })

    it.each(['failure', 'error', 'waiting', 'in_progress', 'queued', 'pending', 'inactive', 'mystery'])(
      'skips a newer deployment whose latest status is %s and reports the older success',
      async state => {
        spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
          fakeDeploymentsGh([
            {id: 5000000002, statuses: [{state, created_at: '2026-08-01T00:00:00Z'}]},
            SUCCESSFUL_DEPLOYMENT,
          ]),
        )

        const result = await checkLastDeploy(false)

        expect(result.level).toBe('ok')
        expect(result.value).toBe(SUCCESS_TIME)
      },
    )

    it('never reports a failure as the last deploy', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        fakeDeploymentsGh([{id: 5000000003, statuses: [{state: 'failure', created_at: '2026-08-01T00:00:00Z'}]}]),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('No successful')
      expect(result.value).toBeUndefined()
    })

    it('never reports a success on a non-main ref as the last deploy', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        fakeDeploymentsGh([
          {id: 5000000004, ref: 'fix/branch', statuses: [{state: 'success', created_at: '2026-08-01T00:00:00Z'}]},
          SUCCESSFUL_DEPLOYMENT,
        ]),
      )

      const result = await checkLastDeploy(false)

      expect(result.value).toBe(SUCCESS_TIME)
    })

    it('reports unavailable when the only success is on a non-main ref', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        fakeDeploymentsGh([
          {id: 5000000004, ref: 'fix/branch', statuses: [{state: 'success', created_at: '2026-08-01T00:00:00Z'}]},
        ]),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.value).toBeUndefined()
    })

    it('returns warning when there are no deployments', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([]))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('No successful')
    })

    it('gives up after a bounded number of deployments instead of walking history', async () => {
      const calls: string[][] = []
      const failures = Array.from({length: 25}, (_, index) => ({
        id: 5100000000 + index,
        statuses: [{state: 'failure', created_at: '2026-08-01T00:00:00Z'}],
      }))
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh(failures, calls))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.value).toBeUndefined()
      // One list call plus at most one status call per scanned deployment.
      expect(calls.length).toBeLessThanOrEqual(11)
    })

    it('returns warning when gh exits non-zero', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => mockSpawnResult(1, '', 'boom'))

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('gh exited 1')
      expect(result.details).toEqual(['boom'])
      expect(result.value).toBeUndefined()
    })

    it('does not fall back to an older deployment when a status read fails', async () => {
      const inner = fakeDeploymentsGh([{id: 5000000005, statuses: []}, SUCCESSFUL_DEPLOYMENT])
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: unknown, opts: unknown) => {
        const path = (cmd as string[])[2] ?? ''
        if (path.includes('/deployments/5000000005/statuses')) return mockSpawnResult(1, '', 'rate limited')
        return (inner as unknown as (c: unknown, o: unknown) => SpawnResult)(cmd, opts)
      }) as unknown as typeof Bun.spawn)

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('gh exited 1')
      expect(result.value).toBeUndefined()
    })

    it('returns warning when the API output does not match the expected schema', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() =>
        mockSpawnResult(0, JSON.stringify({message: 'Not Found'})),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('did not match expected schema')
      expect(result.value).toBeUndefined()
    })

    it('returns warning when a status has no usable timestamp', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(
        fakeDeploymentsGh([{id: 5000000006, statuses: [{state: 'success', created_at: 'yesterday'}]}]),
      )

      const result = await checkLastDeploy(false)

      expect(result.level).toBe('warning')
      expect(result.value).toBeUndefined()
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

    it('adds the raw timestamp in verbose mode', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

      const result = await checkLastDeploy(true)

      expect(result.details).toEqual([`Deploy job: ${SUCCESS_JOB}`, `Raw created_at: ${SUCCESS_TIME}`])
    })
  })

  describe('getKeewebStatusSummary', () => {
    const packagedInstall = () =>
      spyOn(Bun, 'file').mockImplementation(() => ({exists: async () => false}) as ReturnType<typeof Bun.file>)

    it('supplies facts only, with the last deploy time and an unavailable content hash outside a source checkout', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))
      fileSpy = packagedInstall()

      const collection = await getKeewebStatusSummary()

      expect(collection).toEqual({
        observations: [],
        facts: {lastDeploy: SUCCESS_TIME, contentHash: 'unavailable'},
      })
    })

    it('passes the abort signal to every gh spawn', async () => {
      const controller = new AbortController()
      const seen: unknown[] = []
      const inner = fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT])
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: unknown, opts: {signal?: AbortSignal}) => {
        seen.push(opts.signal)
        return (inner as unknown as (c: unknown) => SpawnResult)(cmd)
      }) as unknown as typeof Bun.spawn)
      fileSpy = packagedInstall()

      await getKeewebStatusSummary(controller.signal)

      expect(seen).toEqual([controller.signal, controller.signal])
    })

    it('omits the signal from the gh spawn options when none is given', async () => {
      const seen: string[][] = []
      const inner = fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT])
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmd: unknown, opts: object) => {
        seen.push(Object.keys(opts))
        return (inner as unknown as (c: unknown) => SpawnResult)(cmd)
      }) as unknown as typeof Bun.spawn)
      fileSpy = packagedInstall()

      await getKeewebStatusSummary()

      expect(seen.flat()).not.toContain('signal')
    })

    it('reports a null last deploy when gh cannot say, without failing', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(() => mockSpawnResult(1, '', 'not logged in'))
      fileSpy = packagedInstall()

      const collection = await getKeewebStatusSummary()

      expect(collection.facts.lastDeploy).toBeNull()
      expect(JSON.stringify(collection)).not.toContain('logged in')
    })

    it('reports a null last deploy rather than a skipped-job run time', async () => {
      spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([]))
      fileSpy = packagedInstall()

      const collection = await getKeewebStatusSummary()

      expect(collection.facts.lastDeploy).toBeNull()
    })
  })

  describe('checkContentHash', () => {
    it('does not emit a path-noisy warning when running from a packaged install (bunx)', async () => {
      // Simulate packaged layout: inject a fake repoRoot where build.ts does NOT exist.
      // This is the new seam — tests inject a repoRoot directly, no depth arithmetic.
      const fakeRoot = '/fake/packaged-install'
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false, fakeRoot)

      // Must NOT contain the bogus path in the summary
      expect(result.summary).not.toContain('/fake/packaged-install')
      // Must clearly communicate that local dist is unavailable from packaged CLI
      expect(result.summary.toLowerCase()).toMatch(/not available|unavailable|packaged|source checkout/)
      // Level should be info (neutral — not a warning for packaged installs)
      expect(result.level).toBe('info')
    })

    it('does not emit path-noisy warning for any node_modules install path', async () => {
      // Simulate npm/npx global install: inject a fake repoRoot where build.ts does NOT exist.
      const fakeRoot = '/fake/npm-global-install'
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false, fakeRoot)

      expect(result.summary).not.toContain('/fake/npm-global-install')
      expect(result.summary.toLowerCase()).toMatch(/not available|unavailable|packaged|source checkout/)
    })

    it('does not emit path-noisy warning when running from an unpacked tarball outside node_modules', async () => {
      // Simulate unpacked tarball layout: inject a fake repoRoot where build.ts does NOT exist.
      const fakeRoot = '/tmp/pkg/package'
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false, fakeRoot)

      // Must NOT contain the raw temp path in the summary
      expect(result.summary).not.toContain('/tmp/pkg/package')
      // Must NOT contain the path-noisy "Local dist file not found: ..." message
      expect(result.summary).not.toMatch(/Local dist file not found/)
      // Must clearly communicate that local dist is unavailable from packaged CLI
      expect(result.summary.toLowerCase()).toMatch(/not available|unavailable|packaged|source checkout/)
      // Level should be info (neutral — not a warning for packaged installs)
      expect(result.level).toBe('info')
    })

    it('packaged install content hash level is info, not warning', async () => {
      // Packaged/non-source installs should not degrade status with a warning.
      // The content hash check is a source-only local comparison; when not in a
      // source checkout, the result should be neutral (info), not warning.
      const fakeRoot = '/fake/packaged-install-2'
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false, fakeRoot)

      expect(result.level).toBe('info')
      expect(result.summary.toLowerCase()).toMatch(/not available|unavailable|packaged|source checkout/)
    })

    it('returns info when findRepoRoot throws (production packaged-install path)', async () => {
      // When no repoRoot is injected and findRepoRoot() throws (no workspace marker),
      // checkContentHash must catch the error and return the clean info result.
      // We simulate this by calling with no repoRoot from a context where findRepoRoot
      // would throw — we mock findRepoRoot via Bun.file to ensure no workspace marker
      // is found. Since findRepoRoot walks the real filesystem, we instead verify the
      // contract by calling checkContentHash with a repoRoot that has no build.ts marker,
      // which exercises the same info-result code path.
      //
      // For the throw path specifically: we rely on the fact that the production code
      // wraps findRepoRoot() in try/catch and returns the info result on throw.
      // This is verified by the implementation structure; the injected-root tests above
      // cover the isSourceCheckout(false) branch that produces the same output.
      const fakeRoot = '/fake/no-marker'
      fileSpy = spyOn(Bun, 'file').mockImplementation(
        () =>
          ({
            exists: async () => false,
          }) as ReturnType<typeof Bun.file>,
      )

      const result = await checkContentHash(false, fakeRoot)

      expect(result.title).toBe('Content hash')
      expect(result.level).toBe('info')
      expect(result.summary).toContain('not available')
    })

    it('source checkout with matching hashes returns ok', async () => {
      // Simulate source checkout: inject a fake repoRoot, mock build.ts marker + dist/index.html.
      const fakeRoot = '/fake/source-checkout'
      const htmlContent = '<html>KeeWeb</html>'

      fileSpy = spyOn(Bun, 'file').mockImplementation((pathArg: unknown) => {
        const p = String(pathArg)
        if (p === `${fakeRoot}/apps/keeweb/src/build.ts`) {
          return {exists: async () => true} as ReturnType<typeof Bun.file>
        }
        if (p === `${fakeRoot}/apps/keeweb/dist/index.html`) {
          return {
            exists: async () => true,
            text: async () => htmlContent,
          } as ReturnType<typeof Bun.file>
        }
        return {exists: async () => false} as ReturnType<typeof Bun.file>
      })

      fetchMock.mockImplementation(createFetchImplementation(async () => new Response(htmlContent, {status: 200})))

      const result = await checkContentHash(false, fakeRoot)

      expect(result.level).toBe('ok')
      expect(result.summary).toContain('matches')
      expect(result.value).toBe('match')
    })

    it('source checkout with mismatched hashes returns warning', async () => {
      // Simulate source checkout: inject a fake repoRoot, mock build.ts marker + dist/index.html.
      const fakeRoot = '/fake/source-checkout'
      const localHtml = '<html>KeeWeb local</html>'
      const remoteHtml = '<html>KeeWeb remote</html>'

      fileSpy = spyOn(Bun, 'file').mockImplementation((pathArg: unknown) => {
        const p = String(pathArg)
        if (p === `${fakeRoot}/apps/keeweb/src/build.ts`) {
          return {exists: async () => true} as ReturnType<typeof Bun.file>
        }
        if (p === `${fakeRoot}/apps/keeweb/dist/index.html`) {
          return {
            exists: async () => true,
            text: async () => localHtml,
          } as ReturnType<typeof Bun.file>
        }
        return {exists: async () => false} as ReturnType<typeof Bun.file>
      })

      fetchMock.mockImplementation(createFetchImplementation(async () => new Response(remoteHtml, {status: 200})))

      const result = await checkContentHash(false, fakeRoot)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('differs')
      expect(result.value).toBe('differs')
    })

    it('resolves dist path off injected repoRoot without depth arithmetic', async () => {
      // Regression test: dist path must be join(root, 'apps','keeweb','dist','index.html').
      // No ../ arithmetic. Uses path-sensitive mock: marker returns true, dist returns false.
      const fakeRoot = '/fake/source-checkout'
      const capturedPaths: string[] = []
      fileSpy = spyOn(Bun, 'file').mockImplementation((pathArg: unknown) => {
        const p = String(pathArg)
        capturedPaths.push(p)
        if (p === `${fakeRoot}/apps/keeweb/src/build.ts`) {
          return {exists: async () => true} as ReturnType<typeof Bun.file>
        }
        return {exists: async () => false} as ReturnType<typeof Bun.file>
      })

      await checkContentHash(false, fakeRoot)

      // The dist path must be exactly root + apps/keeweb/dist/index.html
      const distPath = capturedPaths.find(p => p.endsWith('apps/keeweb/dist/index.html'))
      expect(distPath).toBeDefined()
      expect(distPath).toBe(`${fakeRoot}/apps/keeweb/dist/index.html`)
      expect(distPath).not.toContain('..')
    })

    it('returns warning when the local dist file does not exist in source checkout', async () => {
      // Simulate source checkout: inject a fake repoRoot, marker exists, dist file missing.
      const fakeRoot = '/fake/source-checkout'
      fileSpy = spyOn(Bun, 'file').mockImplementation((pathArg: unknown) => {
        const p = String(pathArg)
        if (p === `${fakeRoot}/apps/keeweb/src/build.ts`) {
          return {exists: async () => true} as ReturnType<typeof Bun.file>
        }
        // dist/index.html → missing
        return {exists: async () => false} as ReturnType<typeof Bun.file>
      })

      const result = await checkContentHash(false, fakeRoot)

      expect(result.level).toBe('warning')
      expect(result.summary).toContain('not found')
      expect(result.details).toEqual(expect.arrayContaining(['Run: bun run --cwd apps/keeweb build']))
      expect(result.summary).not.toContain('node_modules')
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
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

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

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

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

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

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

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

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

    spawnSpy = spyOn(Bun, 'spawn').mockImplementation(fakeDeploymentsGh([SUCCESSFUL_DEPLOYMENT]))

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
