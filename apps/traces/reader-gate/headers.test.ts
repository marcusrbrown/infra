import {describe, expect, test} from 'bun:test'

import {
  filterRequestHeaders,
  filterResponseHeaders,
  REQUEST_HEADER_ALLOWLIST,
  RESPONSE_HEADER_ALLOWLIST,
} from './headers'

function names(headers: Headers): string[] {
  return [...headers.keys()].sort()
}

describe('filterRequestHeaders', () => {
  test('forwards only the allowlisted headers', () => {
    const incoming = new Headers({
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'user-agent': 'opencode/1',
      'mcp-protocol-version': '2025-06-18',
      'mcp-session-id': 'abc',
      'mcp-method': 'tools/list',
      'mcp-name': 'x',
    })
    const out = filterRequestHeaders(incoming, {})
    expect(names(out)).toEqual(
      [
        'accept',
        'accept-encoding',
        'content-type',
        'mcp-method',
        'mcp-name',
        'mcp-protocol-version',
        'mcp-session-id',
        'user-agent',
      ].sort(),
    )
    expect(out.get('content-type')).toBe('application/json')
    expect(out.get('mcp-session-id')).toBe('abc')
  })

  test('drops cookies, credentials, identity, proxy and Grafana override headers', () => {
    const incoming = new Headers({
      authorization: 'Bearer secret',
      cookie: 'a=b',
      'proxy-authorization': 'x',
      'x-forwarded-for': '1.2.3.4',
      'x-forwarded-host': 'evil',
      'x-forwarded-user': 'root',
      'x-real-ip': '1.2.3.4',
      forwarded: 'for=1.2.3.4',
      'x-grafana-url': 'http://evil',
      'x-grafana-api-key': 'k',
      'x-grafana-service-account-token': 't',
      'x-grafana-org-id': '2',
      'x-langfuse-admin-api-key': 'admin',
      'langfuse-project-id': 'p',
      'x-langfuse-project-id': 'p',
      'x-user': 'root',
      'x-remote-user': 'root',
      host: 'evil.example',
      origin: 'http://evil',
      referer: 'http://evil',
      connection: 'upgrade',
      upgrade: 'websocket',
      'content-length': '5',
      'transfer-encoding': 'chunked',
      te: 'trailers',
      'accept-encoding': 'br',
      'last-event-id': '1',
    })
    const out = filterRequestHeaders(incoming, {})
    expect(names(out)).toEqual(['accept-encoding'])
    expect(out.get('accept-encoding')).toBe('identity')
  })

  test('the fixed headers win over anything the caller sent', () => {
    const incoming = new Headers({'content-type': 'text/plain'})
    const out = filterRequestHeaders(incoming, {authorization: 'Basic Zm9v', 'content-type': 'application/json'})
    expect(out.get('authorization')).toBe('Basic Zm9v')
    expect(out.get('content-type')).toBe('application/json')
  })

  test('the allowlist holds no credential, cookie or Grafana header', () => {
    for (const name of REQUEST_HEADER_ALLOWLIST) {
      expect(name).not.toMatch(/authorization|cookie|x-grafana|forwarded|host|x-user|x-remote/)
    }
  })
})

describe('filterResponseHeaders', () => {
  test('returns only the allowlisted headers', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-length': '12',
      'retry-after': '3',
      'mcp-protocol-version': '2025-06-18',
      'mcp-session-id': 'abc',
      server: 'nginx',
      'x-powered-by': 'next',
      'access-control-allow-origin': '*',
      'access-control-expose-headers': 'x',
      'strict-transport-security': 'x',
      etag: 'W/"x"',
      date: 'today',
      'cache-control': 'no-store',
      'x-langfuse-project': 'p',
      location: 'http://evil',
      'www-authenticate': 'Basic',
    })
    const out = filterResponseHeaders(upstream)
    expect(names(out)).toEqual([
      'content-length',
      'content-type',
      'mcp-protocol-version',
      'mcp-session-id',
      'retry-after',
    ])
  })

  test('drops content-length when the upstream compressed the body', () => {
    const upstream = new Headers({
      'content-type': 'application/json',
      'content-length': '12',
      'content-encoding': 'gzip',
    })
    const out = filterResponseHeaders(upstream)
    expect(out.has('content-length')).toBe(false)
    expect(out.has('content-encoding')).toBe(false)
  })

  test('the response allowlist holds no cookie or location', () => {
    const allowed: string[] = [...RESPONSE_HEADER_ALLOWLIST]
    expect(allowed.sort()).toEqual(
      ['content-length', 'content-type', 'mcp-protocol-version', 'mcp-session-id', 'retry-after'].sort(),
    )
  })
})
