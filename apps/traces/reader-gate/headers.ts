// Header allowlists in both directions. A header the lists do not name never crosses the gate: no cookie,
// `Authorization`, `X-Grafana-*` override, proxy or identity header goes upstream, and no `Set-Cookie`, `Location` or
// server banner comes back.

export const REQUEST_HEADER_ALLOWLIST = [
  'content-type',
  'accept',
  'user-agent',
  'mcp-protocol-version',
  'mcp-session-id',
  'mcp-method',
  'mcp-name',
] as const

export const RESPONSE_HEADER_ALLOWLIST = [
  'content-type',
  'content-length',
  'retry-after',
  'mcp-protocol-version',
  'mcp-session-id',
] as const

/**
 * The headers sent upstream: the allowlisted ones the caller sent, then the gate's own. `accept-encoding: identity`
 * keeps the upstream body and `content-length` in step, because fetch would otherwise decompress under a header
 * that describes the compressed size.
 */
export function filterRequestHeaders(incoming: Headers, fixed: Record<string, string>): Headers {
  const out = new Headers()
  for (const name of REQUEST_HEADER_ALLOWLIST) {
    const value = incoming.get(name)
    if (value !== null) out.set(name, value)
  }
  out.set('accept-encoding', 'identity')
  for (const [name, value] of Object.entries(fixed)) out.set(name, value)
  return out
}

export function filterResponseHeaders(upstream: Headers): Headers {
  const out = new Headers()
  const compressed = upstream.has('content-encoding')
  for (const name of RESPONSE_HEADER_ALLOWLIST) {
    if (name === 'content-length' && compressed) continue
    const value = upstream.get(name)
    if (value !== null) out.set(name, value)
  }
  return out
}
