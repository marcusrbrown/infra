import {describe, expect, mock, test} from 'bun:test'
import {managementHeaders, parseManagementKeyList, requestJson} from './shared'

describe('managementHeaders', () => {
  test('sets x-management-key header', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('x-management-key')).toBe('mgmt-key')
  })

  test('sets content-type to application/json', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('does not set Authorization header', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('authorization')).toBeNull()
  })
})

describe('requestJson', () => {
  test('returns parsed JSON on success', async () => {
    const payload = {ok: true, value: 42}
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
      ),
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      const result = await requestJson('https://example.com/api', {method: 'GET'})
      expect(result).toEqual(payload)
    } finally {
      globalThis.fetch = original
    }
  })

  test('throws with HTTP status and body on non-200 response', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Unauthorized', {status: 401})))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      await expect(requestJson('https://example.com/api', {method: 'POST'})).rejects.toThrow(
        'POST https://example.com/api failed with HTTP 401: Unauthorized',
      )
    } finally {
      globalThis.fetch = original
    }
  })

  test('throws on 200 with malformed JSON body so mutating callers fail closed', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response('not-json-content', {
          status: 200,
          headers: {'content-type': 'text/plain'},
        }),
      ),
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      await expect(requestJson('https://example.com/api', {method: 'GET'})).rejects.toThrow(/returned malformed JSON/)
    } finally {
      globalThis.fetch = original
    }
  })

  test('returns null on 204 No Content', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response(null, {status: 204})))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      const result = await requestJson('https://example.com/api', {method: 'DELETE'})
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})

describe('parseManagementKeyList', () => {
  test('accepts top-level string array', () => {
    expect(parseManagementKeyList(['k1', 'k2'])).toEqual(['k1', 'k2'])
  })

  test('accepts {api-keys: string[]}', () => {
    expect(parseManagementKeyList({'api-keys': ['k1']})).toEqual(['k1'])
  })

  test('accepts {api_keys: string[]}', () => {
    expect(parseManagementKeyList({api_keys: ['k1']})).toEqual(['k1'])
  })

  test('throws on null payload so destructive PUTs fail closed', () => {
    expect(() => parseManagementKeyList(null)).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on empty object', () => {
    expect(() => parseManagementKeyList({})).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on array of non-strings', () => {
    expect(() => parseManagementKeyList([1, 2, 3])).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on string scalar', () => {
    expect(() => parseManagementKeyList('not-an-array')).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on object with non-array api-keys field', () => {
    expect(() => parseManagementKeyList({'api-keys': 'k1'})).toThrow(/Unexpected management key-list shape/)
  })
})
