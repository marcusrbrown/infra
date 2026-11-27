// Path canonicalisation and the route allowlist. The gate matches the request target as text and forwards the
// canonical path it matched, never the raw one. Anything that is not plainly a path of letters, digits, `-`, `_`, `.`
// and `/` is refused with 404: no percent-encoding (so no `%2e`, `%2f`, `%5c` or `%00`), no `;` parameter, no
// backslash. A dot segment, an empty segment or a trailing slash is refused as well. A `{id}` segment must match a
// strict id charset.
//
// Bun's HTTP server resolves dot segments before the handler sees the URL, so `..` normally never arrives. The check
// stays as a second line, and a collapsed path is still only forwarded if it lands on an allowlisted route.

import {LIMITS} from './constants'

export type RouteName = 'langfuse-rest' | 'langfuse-mcp' | 'grafana-mcp'
export type UpstreamName = 'langfuse' | 'grafana'

export type MatchResult =
  | {kind: 'match'; route: RouteName; upstream: UpstreamName; upstreamPath: string; query: string}
  | {kind: 'method-not-allowed'; allow: string}
  | {kind: 'not-found'}

interface Entry {
  segments: readonly string[]
  route: RouteName
  upstream: UpstreamName
  methods: readonly string[]
  /** The path the upstream sees; `{id}` is replaced by the matched segment. */
  upstreamSegments: readonly string[]
}

const ID = '{id}'
const ID_PATTERN = /^[\w-]{1,128}$/
const SEGMENT_PATTERN = /^[\w.-]+$/
const QUERY_PATTERN = /^[\x21-\x7E]*$/

function rest(...path: string[]): Entry {
  const segments = ['api', 'public', ...path]
  return {segments, route: 'langfuse-rest', upstream: 'langfuse', methods: ['GET'], upstreamSegments: segments}
}

const LANGFUSE: readonly Entry[] = [
  {
    segments: ['api', 'public', 'mcp'],
    route: 'langfuse-mcp',
    upstream: 'langfuse',
    methods: ['POST'],
    upstreamSegments: ['api', 'public', 'mcp'],
  },
  rest('traces'),
  rest('traces', ID),
  rest('sessions'),
  rest('sessions', ID),
  rest('v2', 'observations'),
  rest('observations', ID),
  rest('v2', 'scores'),
  rest('v3', 'scores'),
  rest('metrics'),
  rest('v2', 'metrics'),
  rest('health'),
]

const GRAFANA: readonly Entry[] = [
  {segments: ['mcp'], route: 'grafana-mcp', upstream: 'grafana', methods: ['POST'], upstreamSegments: ['mcp']},
]

const PREFIXES = new Map<string, readonly Entry[]>([
  ['langfuse', LANGFUSE],
  ['grafana', GRAFANA],
])

const SCHEME = /^[A-Z][\d+.A-Z-]*$/i

/** Split an absolute URL into its raw path and query without resolving anything. */
function splitTarget(url: string): {path: string; query: string} | null {
  const schemeEnd = url.indexOf('://')
  if (schemeEnd < 1 || !SCHEME.test(url.slice(0, schemeEnd))) return null
  const afterScheme = url.slice(schemeEnd + 3)
  const hostEnd = afterScheme.search(/[#/?]/)
  if (hostEnd === -1) return {path: '', query: ''}
  const target = afterScheme.slice(hostEnd).split('#')[0] ?? ''
  const mark = target.indexOf('?')
  return mark === -1 ? {path: target, query: ''} : {path: target.slice(0, mark), query: target.slice(mark + 1)}
}

export function matchRequest(url: string, method: string): MatchResult {
  const parts = splitTarget(url)
  if (!parts) return {kind: 'not-found'}
  const {path, query} = parts

  if (!path.startsWith('/') || path.endsWith('/')) return {kind: 'not-found'}
  const segments = path.slice(1).split('/')
  if (!segments.every(isPlainSegment)) return {kind: 'not-found'}

  const [agent, route, ...tail] = segments
  if (agent !== 'agent' || route === undefined) return {kind: 'not-found'}
  const entries = PREFIXES.get(route)
  if (!entries || tail.length === 0) return {kind: 'not-found'}

  const entry = entries.find(candidate => matches(candidate.segments, tail))
  if (!entry) return {kind: 'not-found'}
  if (!entry.methods.includes(method)) return {kind: 'method-not-allowed', allow: entry.methods.join(', ')}

  const upstreamPath = `/${entry.upstreamSegments.map((segment, index) => (segment === ID ? (tail[index] ?? '') : segment)).join('/')}`
  const forwardedQuery = entry.methods.includes('GET') ? query : ''
  if (forwardedQuery.length > LIMITS.maxQueryBytes || !QUERY_PATTERN.test(forwardedQuery)) return {kind: 'not-found'}
  return {kind: 'match', route: entry.route, upstream: entry.upstream, upstreamPath, query: forwardedQuery}
}

function isPlainSegment(segment: string): boolean {
  return SEGMENT_PATTERN.test(segment) && segment !== '.' && segment !== '..'
}

function matches(pattern: readonly string[], segments: readonly string[]): boolean {
  if (pattern.length !== segments.length) return false
  return pattern.every((expected, index) => {
    const actual = segments[index] ?? ''
    return expected === ID ? ID_PATTERN.test(actual) : expected === actual
  })
}
