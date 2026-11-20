import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {
  fetchCurrentGoSnapshot,
  GO_SNAPSHOT_MAX_BYTES,
  GO_SNAPSHOT_TIMEOUT_MS,
  GO_SNAPSHOT_URL,
  type GoSnapshotFailureReason,
} from './go-snapshot'

const COMMIT = 'b'.repeat(40)

function snapshotBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    source: {
      repo: 'anomalyco/opencode',
      path: 'services/site/src/docs/content/console/go.mdx',
      commit: COMMIT,
    },
    models: {
      'glm-5.3': {zeroRetention: true, trainsOnData: false, regionGated: false, agreementExpiry: null},
      'kimi-k3': {zeroRetention: true, trainsOnData: false, regionGated: false, agreementExpiry: '2027-01-31'},
    },
    ...overrides,
  }
}

interface Seen {
  url: string
  init: RequestInit | undefined
}

function recordingFetch(reply: () => Response | Promise<Response>): {
  fetchFn: (input: string, init?: RequestInit) => Promise<Response>
  seen: Seen[]
} {
  const seen: Seen[] = []
  return {
    seen,
    fetchFn: async (input, init) => {
      seen.push({url: input, init})
      return reply()
    },
  }
}

async function failureOf(fetchFn: (input: string, init?: RequestInit) => Promise<Response>, timeoutMs?: number) {
  const result = await fetchCurrentGoSnapshot(fetchFn, timeoutMs)
  if (result.ok) throw new Error('expected a failed fetch')
  return result.reason
}

describe('fetchCurrentGoSnapshot', () => {
  const savedEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) savedEnv[name] = process.env[name]
    process.env.GITHUB_TOKEN = 'ghs_must_never_be_sent'
    process.env.GH_TOKEN = 'gho_must_never_be_sent'
  })

  afterEach(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it('reads the fixed raw URL for main and returns the parsed snapshot with its upstream commit', async () => {
    const {fetchFn, seen} = recordingFetch(() => Response.json(snapshotBody()))

    const result = await fetchCurrentGoSnapshot(fetchFn)

    expect(GO_SNAPSHOT_URL).toBe(
      'https://raw.githubusercontent.com/marcusrbrown/infra/main/packages/shared/opencode-go/privacy-snapshot.json',
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(GO_SNAPSHOT_URL)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.source.commit).toBe(COMMIT)
    expect(Object.keys(result.snapshot.models)).toEqual(['glm-5.3', 'kimi-k3'])
  })

  it('sends no credential of any kind, even with GITHUB_TOKEN and GH_TOKEN in the environment', async () => {
    const {fetchFn, seen} = recordingFetch(() => Response.json(snapshotBody()))

    await fetchCurrentGoSnapshot(fetchFn)

    const init = seen[0]?.init
    const headers = new Headers(init?.headers)
    expect(headers.has('authorization')).toBe(false)
    expect(headers.has('cookie')).toBe(false)
    expect([...headers.keys()]).toEqual([])
    expect(JSON.stringify(init)).not.toContain('must_never_be_sent')
    expect(init?.method ?? 'GET').toBe('GET')
    expect(init?.credentials ?? 'omit').not.toBe('include')
  })

  it('bounds the request in time and refuses redirects', async () => {
    const {fetchFn, seen} = recordingFetch(() => Response.json(snapshotBody()))

    await fetchCurrentGoSnapshot(fetchFn)

    expect(seen[0]?.init?.signal).toBeInstanceOf(AbortSignal)
    expect(seen[0]?.init?.redirect).toBe('error')
    expect(GO_SNAPSHOT_TIMEOUT_MS).toBeGreaterThan(0)
    expect(GO_SNAPSHOT_TIMEOUT_MS).toBeLessThanOrEqual(10_000)
  })

  it('keeps an entry that fails its own validation on the `invalid` list, as the deploy does', async () => {
    const body = snapshotBody({models: {'glm-5.3': {zeroRetention: 'yes'}}})
    const result = await fetchCurrentGoSnapshot(recordingFetch(() => Response.json(body)).fetchFn)

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.snapshot.invalid).toEqual(['glm-5.3'])
  })

  describe('failures are fetch failures, never a policy', () => {
    const cases: [string, () => Response | Promise<Response>, GoSnapshotFailureReason][] = [
      [
        'a network error',
        () => {
          throw new TypeError('fetch failed')
        },
        'network',
      ],
      [
        'a timeout error',
        () => {
          throw new DOMException('The operation timed out.', 'TimeoutError')
        },
        'timeout',
      ],
      [
        'an abort error',
        () => {
          throw new DOMException('The operation was aborted.', 'AbortError')
        },
        'timeout',
      ],
      ['HTTP 404', () => new Response('not found', {status: 404}), 'http-404'],
      ['HTTP 503', () => new Response('unavailable', {status: 503}), 'http-503'],
      [
        'a 3xx that was not followed',
        () => new Response(null, {status: 302, headers: {location: 'https://x'}}),
        'http-302',
      ],
      [
        'a declared length over the cap',
        () =>
          new Response(JSON.stringify(snapshotBody()), {
            headers: {'content-length': String(GO_SNAPSHOT_MAX_BYTES + 1)},
          }),
        'oversize',
      ],
      [
        'a streamed body over the cap with no declared length',
        () =>
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                const chunk = new Uint8Array(GO_SNAPSHOT_MAX_BYTES / 4)
                chunk.fill(0x20)
                for (let i = 0; i < 5; i++) controller.enqueue(chunk)
                controller.close()
              },
            }),
          ),
        'oversize',
      ],
      ['a body that is not JSON', () => new Response('<html>rate limited</html>'), 'not-json'],
      ['an empty body', () => new Response(''), 'not-json'],
      ['JSON that is not an object', () => Response.json([1, 2, 3]), 'invalid-snapshot'],
      ['a missing schemaVersion', () => Response.json({source: snapshotBody().source, models: {}}), 'invalid-snapshot'],
      ['a wrong schemaVersion', () => Response.json(snapshotBody({schemaVersion: 2})), 'invalid-snapshot'],
      [
        'a wrong source repo',
        () =>
          Response.json(
            snapshotBody({
              source: {repo: 'evil/opencode', path: 'services/site/src/docs/content/console/go.mdx', commit: COMMIT},
            }),
          ),
        'invalid-snapshot',
      ],
      [
        'a wrong source path',
        () =>
          Response.json(snapshotBody({source: {repo: 'anomalyco/opencode', path: 'docs/other.mdx', commit: COMMIT}})),
        'invalid-snapshot',
      ],
      [
        'a commit that is not 40 hex characters',
        () =>
          Response.json(
            snapshotBody({
              source: {
                repo: 'anomalyco/opencode',
                path: 'services/site/src/docs/content/console/go.mdx',
                commit: 'main',
              },
            }),
          ),
        'invalid-snapshot',
      ],
      ['an unknown top-level field', () => Response.json(snapshotBody({extra: true})), 'invalid-snapshot'],
      ['models that are not an object', () => Response.json(snapshotBody({models: 'all of them'})), 'invalid-snapshot'],
    ]

    for (const [name, reply, reason] of cases) {
      it(`${name} → ${reason}`, async () => {
        expect(await failureOf(recordingFetch(reply).fetchFn)).toBe(reason)
      })
    }

    it('a request that never answers is aborted at the timeout', async () => {
      const fetchFn = (_input: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason))
        })

      expect(await failureOf(fetchFn, 25)).toBe('timeout')
    })

    it('a body that starts and then stalls is aborted at the timeout, even when the fetch does not wire the signal into it', async () => {
      const fetchFn = async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"schemaVersion":'))
              // never closes, never errors
            },
          }),
        )

      const started = performance.now()
      expect(await failureOf(fetchFn, 50)).toBe('timeout')
      expect(performance.now() - started).toBeLessThan(2000)
    }, 3000)

    it('a body that never produces a chunk is aborted at the timeout too', async () => {
      const fetchFn = async () => new Response(new ReadableStream<Uint8Array>({}))

      expect(await failureOf(fetchFn, 50)).toBe('timeout')
    }, 3000)

    it('a non-2xx answer with a stalled body is still reported by status, without waiting on the body', async () => {
      const fetchFn = async () => new Response(new ReadableStream<Uint8Array>({}), {status: 502})

      expect(await failureOf(fetchFn, 50)).toBe('http-502')
    }, 3000)

    it('never puts the response body or an error message into the failure', async () => {
      const result = await fetchCurrentGoSnapshot(
        recordingFetch(() => new Response('SECRET-BODY-TEXT', {status: 500})).fetchFn,
      )
      expect(JSON.stringify(result)).not.toContain('SECRET-BODY-TEXT')

      const thrown = await fetchCurrentGoSnapshot(() => {
        throw new TypeError('connect ECONNREFUSED 10.0.0.1:443 SECRET-ERROR-TEXT')
      })
      expect(JSON.stringify(thrown)).not.toContain('SECRET-ERROR-TEXT')
    })
  })
})
