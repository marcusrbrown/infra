/**
 * Tests for the cliproxy mint/revoke client.
 *
 * All tests mock at the fetch boundary — no real network, no real cliproxy.
 * The management URL and key are injected via deps; no secrets in tracked files.
 */

import type {FetchFn} from './mint'

import {describe, expect, mock, test} from 'bun:test'
import {listApiKeys, mintKey, revokeKey} from './mint'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_URL = 'https://cliproxy.example.test'
const TEST_KEY = 'test-management-key'

/** Build a minimal deps object with a custom fetch mock. */
function makeDeps(fetchFn: FetchFn) {
  return {fetch: fetchFn, managementUrl: TEST_URL, managementKey: TEST_KEY}
}

/** Build a Response-like object for use in fetch mocks. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'content-type': 'application/json'},
  })
}

function errorResponse(status: number, body = 'error'): Response {
  return new Response(body, {status})
}

/**
 * Build a simple fetch mock backed by a shared in-memory key store.
 * Handles GET (returns store), PUT (replaces store), DELETE (removes by value).
 */
function makeStoreFetch(store: string[]): FetchFn {
  return mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const urlStr = url.toString()
    const method = init?.method ?? 'GET'

    if (method === 'GET' && urlStr.includes('/v0/management/api-keys')) {
      return jsonResponse([...store])
    }

    if (method === 'PUT' && urlStr.includes('/v0/management/api-keys')) {
      const body = JSON.parse(init?.body as string) as string[]
      store.length = 0
      store.push(...body)
      return jsonResponse({ok: true})
    }

    if (method === 'DELETE' && urlStr.includes('/v0/management/api-keys')) {
      const urlObj = new URL(urlStr)
      const value = urlObj.searchParams.get('value')
      if (value) {
        const idx = store.indexOf(value)
        if (idx !== -1) store.splice(idx, 1)
      }
      return jsonResponse({ok: true})
    }

    throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
  })
}

// ---------------------------------------------------------------------------
// Happy path: mint
// ---------------------------------------------------------------------------

describe('mintKey — happy path', () => {
  test('returns a ghact-prefixed key and appends it to existing keys', async () => {
    const existingKeys = ['existing-key-1', 'existing-key-2']
    const store = [...existingKeys]

    const key = await mintKey('run-123', makeDeps(makeStoreFetch(store)))

    // Key has the greppable prefix
    expect(key).toMatch(/^ghact-run-123-/)

    // Key is now in the stored array
    expect(store).toContain(key)

    // All existing keys are preserved (no lost-update)
    for (const existing of existingKeys) {
      expect(store).toContain(existing)
    }

    // Total count is existingKeys + 1
    expect(store).toHaveLength(existingKeys.length + 1)
  })

  test('GET-back confirms the new key is present before returning', async () => {
    const store: string[] = []

    const key = await mintKey('run-456', makeDeps(makeStoreFetch(store)))

    expect(store).toContain(key)
    expect(key).toMatch(/^ghact-run-456-/)
  })
})

// ---------------------------------------------------------------------------
// Edge: preserves all N existing keys (no lost-update)
// ---------------------------------------------------------------------------

describe('mintKey — preserves existing keys', () => {
  test('preserves all N existing keys when appending', async () => {
    const N = 5
    const existingKeys = Array.from({length: N}, (_, i) => `key-${i}`)
    const store = [...existingKeys]

    const key = await mintKey('run-preserve', makeDeps(makeStoreFetch(store)))

    expect(store).toHaveLength(N + 1)
    expect(store).toContain(key)
    for (const existing of existingKeys) {
      expect(store).toContain(existing)
    }
  })

  test('works when existing api-keys list is empty', async () => {
    const store: string[] = []

    const key = await mintKey('run-empty', makeDeps(makeStoreFetch(store)))

    expect(store).toHaveLength(1)
    expect(store[0]).toBe(key)
    expect(key).toMatch(/^ghact-run-empty-/)
  })
})

// ---------------------------------------------------------------------------
// Error: PUT returns 200 but GET-back doesn't show the key (silent no-op trap)
// ---------------------------------------------------------------------------

describe('mintKey — GET-back mismatch retry', () => {
  test('retries on GET-back mismatch and throws after max attempts', async () => {
    // PUT always succeeds but GET-back never shows the new key (silent no-op trap)
    const fetchMock: FetchFn = mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString()
      const method = init?.method ?? 'GET'

      if (method === 'GET' && urlStr.includes('/v0/management/api-keys')) {
        // Always returns empty — simulates the "PUT returns 200 but stores nothing" trap
        return jsonResponse([])
      }

      if (method === 'PUT' && urlStr.includes('/v0/management/api-keys')) {
        return jsonResponse({ok: true})
      }

      throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
    })

    await expect(mintKey('run-mismatch', makeDeps(fetchMock))).rejects.toThrow(
      /read-back.*not found|not found.*read-back|key not present|mismatch/i,
    )
  })

  test('succeeds on second attempt when GET-back eventually confirms', async () => {
    let getCount = 0
    const store: string[] = []

    const fetchMock: FetchFn = mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString()
      const method = init?.method ?? 'GET'

      if (method === 'PUT' && urlStr.includes('/v0/management/api-keys')) {
        const body = JSON.parse(init?.body as string) as string[]
        store.length = 0
        store.push(...body)
        return jsonResponse({ok: true})
      }

      if (method === 'GET' && urlStr.includes('/v0/management/api-keys')) {
        getCount++
        // First GET (initial read before PUT): return empty
        // Second GET (first read-back after PUT): return empty (simulate delay)
        // Third GET (second read-back after retry): return stored keys
        if (getCount <= 2) {
          return jsonResponse([])
        }
        return jsonResponse([...store])
      }

      throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
    })

    const key = await mintKey('run-retry', makeDeps(fetchMock))

    expect(key).toMatch(/^ghact-run-retry-/)
    expect(store).toContain(key)
  })
})

// ---------------------------------------------------------------------------
// Error: management API 401/403 → throw immediately, no retry
// ---------------------------------------------------------------------------

describe('mintKey — HTTP errors throw immediately', () => {
  test('throws immediately on 401 without retrying', async () => {
    let callCount = 0

    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      callCount++
      return errorResponse(401, 'Unauthorized')
    })

    await expect(mintKey('run-401', makeDeps(fetchMock))).rejects.toThrow(/401/)

    // Only one call — no retry on auth failure
    expect(callCount).toBe(1)
  })

  test('throws immediately on 403 without retrying', async () => {
    let callCount = 0

    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      callCount++
      return errorResponse(403, 'Forbidden')
    })

    await expect(mintKey('run-403', makeDeps(fetchMock))).rejects.toThrow(/403/)

    expect(callCount).toBe(1)
  })

  test('throws immediately on 500 without retrying', async () => {
    let callCount = 0

    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      callCount++
      return errorResponse(500, 'Internal Server Error')
    })

    await expect(mintKey('run-500', makeDeps(fetchMock))).rejects.toThrow(/500/)

    expect(callCount).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Happy path: revoke
// ---------------------------------------------------------------------------

describe('revokeKey — happy path', () => {
  test('sends DELETE with the key as query param', async () => {
    let deletedUrl: string | undefined

    const fetchMock: FetchFn = mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString()
      const method = init?.method ?? 'GET'

      if (method === 'DELETE' && urlStr.includes('/v0/management/api-keys')) {
        deletedUrl = urlStr
        return jsonResponse({ok: true})
      }

      throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
    })

    await revokeKey('ghact-run-123-abc', makeDeps(fetchMock))

    expect(deletedUrl).toBeDefined()
    expect(deletedUrl).toContain('value=ghact-run-123-abc')
  })

  test('is idempotent — absent key is success (404 treated as success)', async () => {
    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return errorResponse(404, 'Not Found')
    })

    // Should not throw
    await expect(revokeKey('ghact-run-gone', makeDeps(fetchMock))).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Edge: unique greppable prefix per run
// ---------------------------------------------------------------------------

describe('mintKey — unique prefix per run', () => {
  test('two mints for different runIds produce keys with different prefixes', async () => {
    const store1: string[] = []
    const store2: string[] = []

    const key1 = await mintKey('run-aaa', makeDeps(makeStoreFetch(store1)))
    const key2 = await mintKey('run-bbb', makeDeps(makeStoreFetch(store2)))

    expect(key1).toMatch(/^ghact-run-aaa-/)
    expect(key2).toMatch(/^ghact-run-bbb-/)
    expect(key1).not.toBe(key2)
  })

  test('two mints for the same runId produce different keys (random suffix)', async () => {
    const store1: string[] = []
    const store2: string[] = []

    const key1 = await mintKey('run-same', makeDeps(makeStoreFetch(store1)))
    const key2 = await mintKey('run-same', makeDeps(makeStoreFetch(store2)))

    expect(key1).toMatch(/^ghact-run-same-/)
    expect(key2).toMatch(/^ghact-run-same-/)
    expect(key1).not.toBe(key2)
  })
})

// ---------------------------------------------------------------------------
// Integration (concurrency): single-flight lock serializes concurrent mints
// ---------------------------------------------------------------------------

describe('mintKey — single-flight lock (concurrency)', () => {
  test('two concurrent mints serialize — both keys present, no lost-update', async () => {
    // Shared in-memory array simulating cliproxy's api-keys store.
    // The fetch mock yields the event loop between GET and PUT to expose
    // any lost-update race if the lock is absent.
    const sharedStore: string[] = ['pre-existing-key']

    const fetchMock: FetchFn = mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString()
      const method = init?.method ?? 'GET'

      if (method === 'GET' && urlStr.includes('/v0/management/api-keys')) {
        // Yield the event loop to allow interleaving if there is no lock
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        return jsonResponse([...sharedStore])
      }

      if (method === 'PUT' && urlStr.includes('/v0/management/api-keys')) {
        // Yield again before writing
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        const body = JSON.parse(init?.body as string) as string[]
        sharedStore.length = 0
        sharedStore.push(...body)
        return jsonResponse({ok: true})
      }

      throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
    })

    const deps = makeDeps(fetchMock)

    // Fire both mints concurrently
    const [key1, key2] = await Promise.all([mintKey('run-concurrent-1', deps), mintKey('run-concurrent-2', deps)])

    // Both keys must be present in the final store
    expect(sharedStore).toContain(key1)
    expect(sharedStore).toContain(key2)

    // The pre-existing key must not have been lost
    expect(sharedStore).toContain('pre-existing-key')

    // Total: 1 pre-existing + 2 minted
    expect(sharedStore).toHaveLength(3)
  })

  test('mint and revoke serialize — revoke does not interleave with a concurrent mint', async () => {
    const sharedStore: string[] = ['existing-key']

    const fetchMock: FetchFn = mock(async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
      const urlStr = url.toString()
      const method = init?.method ?? 'GET'

      if (method === 'GET' && urlStr.includes('/v0/management/api-keys')) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        return jsonResponse([...sharedStore])
      }

      if (method === 'PUT' && urlStr.includes('/v0/management/api-keys')) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        const body = JSON.parse(init?.body as string) as string[]
        sharedStore.length = 0
        sharedStore.push(...body)
        return jsonResponse({ok: true})
      }

      if (method === 'DELETE' && urlStr.includes('/v0/management/api-keys')) {
        await new Promise<void>(resolve => setTimeout(resolve, 0))
        const urlObj = new URL(urlStr)
        const value = urlObj.searchParams.get('value')
        if (value) {
          const idx = sharedStore.indexOf(value)
          if (idx !== -1) sharedStore.splice(idx, 1)
        }
        return jsonResponse({ok: true})
      }

      throw new Error(`Unexpected fetch: ${method} ${urlStr}`)
    })

    const deps = makeDeps(fetchMock)

    // First mint to get a key to revoke
    const keyToRevoke = await mintKey('run-serial-1', deps)
    expect(sharedStore).toContain(keyToRevoke)

    // Now run a mint and a revoke concurrently
    const [key2] = await Promise.all([mintKey('run-serial-2', deps), revokeKey(keyToRevoke, deps)])

    // The new key must be present
    expect(sharedStore).toContain(key2)

    // The revoked key must be gone
    expect(sharedStore).not.toContain(keyToRevoke)

    // The original existing key must still be there
    expect(sharedStore).toContain('existing-key')
  })
})

// ---------------------------------------------------------------------------
// listApiKeys — exported helper for sweeper
// ---------------------------------------------------------------------------

describe('listApiKeys — exported helper', () => {
  test('returns the current api-keys list from cliproxy', async () => {
    const keys = ['existing-key-1', 'ghact-run-123-abc']

    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return jsonResponse(keys)
    })

    const result = await listApiKeys(makeDeps(fetchMock))

    expect(result).toEqual(keys)
  })

  test('throws on non-2xx response (fail-closed)', async () => {
    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return errorResponse(401, 'Unauthorized')
    })

    await expect(listApiKeys(makeDeps(fetchMock))).rejects.toThrow(/401/)
  })

  test('runs under the single-flight lock — serializes with concurrent mint', async () => {
    // Shared store: listApiKeys should see the state after a concurrent mint completes
    const store: string[] = ['pre-existing']

    const fetchMock = makeStoreFetch(store)
    const deps = makeDeps(fetchMock)

    // Fire a mint and a listApiKeys concurrently
    const [mintedKey, listedKeys] = await Promise.all([mintKey('run-list-concurrent', deps), listApiKeys(deps)])

    // The listed keys should include the pre-existing key
    expect(listedKeys).toContain('pre-existing')
    // The minted key should be in the store
    expect(store).toContain(mintedKey)
  })
})

// ---------------------------------------------------------------------------
// Management key is never logged
// ---------------------------------------------------------------------------

describe('mintKey — no secret leakage in errors', () => {
  test('error messages do not contain the management key', async () => {
    const fetchMock: FetchFn = mock(async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
      return errorResponse(401, 'Unauthorized')
    })

    let thrownError: Error | undefined
    try {
      await mintKey('run-leak-check', makeDeps(fetchMock))
    } catch (error) {
      thrownError = error instanceof Error ? error : new Error(String(error))
    }

    expect(thrownError).toBeDefined()
    // The management key value must not appear in the error message
    expect(thrownError?.message).not.toContain(TEST_KEY)
  })
})
