import {describe, expect, test} from 'bun:test'

import {matchRequest} from './paths'

const LF = 'http://gate:8090/agent/langfuse'
const GF = 'http://gate:8090/agent/grafana'

function match(url: string, method = 'GET') {
  return matchRequest(url, method)
}

describe('allowed Langfuse reads', () => {
  const reads: [string, string][] = [
    ['/api/public/traces', '/api/public/traces'],
    ['/api/public/traces/abc123', '/api/public/traces/abc123'],
    ['/api/public/sessions', '/api/public/sessions'],
    ['/api/public/sessions/ses_abc-123', '/api/public/sessions/ses_abc-123'],
    ['/api/public/v2/observations', '/api/public/v2/observations'],
    ['/api/public/observations/obs-1', '/api/public/observations/obs-1'],
    ['/api/public/v2/scores', '/api/public/v2/scores'],
    ['/api/public/v3/scores', '/api/public/v3/scores'],
    ['/api/public/metrics', '/api/public/metrics'],
    ['/api/public/v2/metrics', '/api/public/v2/metrics'],
    ['/api/public/health', '/api/public/health'],
  ]
  test.each(reads)('GET %s is forwarded as %s', (path, upstreamPath) => {
    expect(match(`${LF}${path}`)).toEqual({
      kind: 'match',
      route: 'langfuse-rest',
      upstream: 'langfuse',
      upstreamPath,
      query: '',
    })
  })

  test('the query string is kept for a read', () => {
    expect(match(`${LF}/api/public/traces?limit=50&page=2&fromTimestamp=2026-11-20T00%3A00%3A00Z`)).toEqual({
      kind: 'match',
      route: 'langfuse-rest',
      upstream: 'langfuse',
      upstreamPath: '/api/public/traces',
      query: 'limit=50&page=2&fromTimestamp=2026-11-20T00%3A00%3A00Z',
    })
  })

  test('an empty query is dropped', () => {
    const result = match(`${LF}/api/public/traces?`)
    expect(result).toMatchObject({kind: 'match', query: ''})
  })
})

describe('MCP routes', () => {
  test('POST to the Langfuse MCP endpoint is forwarded without a query', () => {
    expect(match(`${LF}/api/public/mcp?x=1`, 'POST')).toEqual({
      kind: 'match',
      route: 'langfuse-mcp',
      upstream: 'langfuse',
      upstreamPath: '/api/public/mcp',
      query: '',
    })
  })

  test('POST to the Grafana MCP endpoint maps to /mcp', () => {
    expect(match(`${GF}/mcp`, 'POST')).toEqual({
      kind: 'match',
      route: 'grafana-mcp',
      upstream: 'grafana',
      upstreamPath: '/mcp',
      query: '',
    })
  })

  test.each(['GET', 'DELETE', 'PUT', 'OPTIONS', 'HEAD'])('%s to an MCP endpoint is 405', method => {
    expect(match(`${LF}/api/public/mcp`, method)).toEqual({kind: 'method-not-allowed', allow: 'POST'})
    expect(match(`${GF}/mcp`, method)).toEqual({kind: 'method-not-allowed', allow: 'POST'})
  })
})

describe('methods on REST reads', () => {
  test.each(['POST', 'DELETE', 'PUT', 'PATCH', 'OPTIONS', 'HEAD'])('%s to a REST read path is 405', method => {
    expect(match(`${LF}/api/public/traces`, method)).toEqual({kind: 'method-not-allowed', allow: 'GET'})
    expect(match(`${LF}/api/public/traces/abc`, method)).toEqual({kind: 'method-not-allowed', allow: 'GET'})
  })

  test('a write path that the gate does not list is 404 for any method', () => {
    for (const method of ['GET', 'POST', 'DELETE']) {
      expect(match(`${LF}/api/public/scores`, method)).toEqual({kind: 'not-found'})
      expect(match(`${LF}/api/public/ingestion`, method)).toEqual({kind: 'not-found'})
    }
  })
})

describe('paths that are not on the allowlist', () => {
  test.each([
    `${LF}`,
    `${LF}/`,
    `${LF}/project/abc/traces`,
    `${LF}/api/auth/session`,
    `${LF}/api/trpc/projects.all`,
    `${LF}/api/public`,
    `${LF}/api/public/otel/v1/traces`,
    `${LF}/api/public/projects`,
    `${LF}/api/public/traces/abc/extra`,
    `${LF}/api/public/v2/observations/abc`,
    `${GF}`,
    `${GF}/api/dashboards`,
    `${GF}/mcp/extra`,
    `${GF}/login`,
    'http://gate:8090/healthz',
    'http://gate:8090/agent',
    'http://gate:8090/agent/other/mcp',
    'http://gate:8090/agent/constructor/mcp',
    'http://gate:8090/agent/__proto__/mcp',
    'http://gate:8090/agent/toString/mcp',
    'http://gate:8090/agentx/langfuse/api/public/traces',
    'http://gate:8090/',
  ])('%s is 404', url => {
    expect(match(url)).toEqual({kind: 'not-found'})
    expect(match(url, 'POST')).toEqual({kind: 'not-found'})
  })

  test('the route names are case-sensitive', () => {
    expect(match(`${LF}/API/PUBLIC/traces`)).toEqual({kind: 'not-found'})
    expect(match('http://gate:8090/agent/Langfuse/api/public/traces')).toEqual({kind: 'not-found'})
  })
})

describe('canonicalisation refuses with 404', () => {
  const base = `${LF}/api/public`
  const refused: [string, string][] = [
    ['dot-dot segment', `${base}/../traces`],
    ['dot segment', `${base}/./traces`],
    ['trailing dot-dot', `${base}/traces/..`],
    ['encoded dot-dot', `${base}/%2e%2e/traces`],
    ['upper-case encoded dot-dot', `${base}/%2E%2E/traces`],
    ['half-encoded dot-dot', `${base}/.%2e/traces`],
    ['encoded slash', `${base}/traces%2fabc`],
    ['upper-case encoded slash', `${base}/traces%2Fabc`],
    ['encoded backslash', `${base}/traces%5cabc`],
    ['upper-case encoded backslash', `${base}/traces%5Cabc`],
    ['literal backslash', String.raw`${base}/traces\abc`],
    ['encoded NUL', `${base}/traces%00`],
    ['literal NUL', `${base}/traces\u0000`],
    ['any other percent-encoding', `${base}/tra%63es`],
    ['empty segment', `${base}//traces`],
    ['empty segment after the prefix', `${LF}//api/public/traces`],
    ['trailing slash', `${base}/traces/`],
    ['semicolon parameter', `${base}/traces;jsessionid=1`],
    ['semicolon in the middle', `${base};x=1/traces`],
    ['id with a dot', `${base}/traces/a.b`],
    ['id with a colon', `${base}/traces/a:b`],
    ['id with a space', `${base}/traces/a b`],
    ['id with unicode', `${base}/traces/caf\u00E9`],
    ['id over 128 characters', `${base}/traces/${'a'.repeat(129)}`],
    ['id with a plus', `${base}/sessions/a+b`],
    ['id with a tilde', `${base}/sessions/a~b`],
  ]
  test.each(refused)('%s', (_name, url) => {
    expect(match(url)).toEqual({kind: 'not-found'})
  })

  test('an id of exactly 128 characters is accepted', () => {
    expect(match(`${base}/traces/${'a'.repeat(128)}`)).toMatchObject({kind: 'match'})
  })

  test('the forwarded path is the canonical one the gate matched', () => {
    const result = match(`${LF}/api/public/traces/abc?limit=1`)
    expect(result).toMatchObject({upstreamPath: '/api/public/traces/abc'})
  })

  test('a query with a space, a control character or a fragment marker is 404', () => {
    expect(match(`${LF}/api/public/traces?a=b c`)).toEqual({kind: 'not-found'})
    expect(match(`${LF}/api/public/traces?a=\u0001`)).toEqual({kind: 'not-found'})
    expect(match(`${LF}/api/public/traces?a=\u0000`)).toEqual({kind: 'not-found'})
  })

  test('a query over 4 KiB is 404', () => {
    expect(match(`${LF}/api/public/traces?q=${'a'.repeat(4097)}`)).toEqual({kind: 'not-found'})
    expect(match(`${LF}/api/public/traces?q=${'a'.repeat(100)}`)).toMatchObject({kind: 'match'})
  })

  test('input that is not an absolute URL is 404', () => {
    expect(match('/agent/langfuse/api/public/traces')).toEqual({kind: 'not-found'})
    expect(match('')).toEqual({kind: 'not-found'})
  })
})
