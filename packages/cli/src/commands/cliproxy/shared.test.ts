import {describe, expect, mock, test} from 'bun:test'
import {managementHeaders, requestJson} from './shared'

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

  test('returns null when response body is not valid JSON', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('', {status: 200})))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      const result = await requestJson('https://example.com/api', {method: 'GET'})
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})
