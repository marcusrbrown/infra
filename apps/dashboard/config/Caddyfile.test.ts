import {describe, expect, it} from 'bun:test'

const caddyfile = await Bun.file(new URL('Caddyfile', import.meta.url)).text()

// --- Minimal Caddyfile routing model -----------------------------------
// This is a model of the config's routing semantics, not a Caddy
// reimplementation. It parses `handle` blocks in file order (Caddy's
// `handle` directive is mutually exclusive, first-match-wins) so tests
// below assert against the real file instead of a hand-copied table.
//
// Routing contract: `/operator/*` goes to the gateway; everything else goes
// to the dashboard app unrewritten. The app owns auth and path handling.

interface HandleBlock {
  matcherToken: string | undefined // raw token after `handle`, undefined for the catch-all
  upstream: string
  body: string
}

function findMatchingBrace(text: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced braces in Caddyfile')
}

function stripComments(text: string): string {
  return text
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
}

function parseCaddyfile(text: string): {blocks: HandleBlock[]} {
  const stripped = stripComments(text)
  // The site block declaration line is `{$DASHBOARD_DOMAIN} {` — the `{` we
  // want to open on is the last one on that line, not the `{` in the
  // `{$DASHBOARD_DOMAIN}` placeholder.
  const firstLineEnd = stripped.indexOf('\n')
  const siteOpen = stripped.slice(0, firstLineEnd).lastIndexOf('{')
  const siteClose = findMatchingBrace(stripped, siteOpen)
  const site = stripped.slice(siteOpen + 1, siteClose)

  const blocks: HandleBlock[] = []
  // Horizontal-whitespace-only classes: `\s` would also swallow newlines in
  // this line-anchored pattern. Left boundary only: a trailing \b is
  // redundant because `handle` is always followed by whitespace or `{`.
  const handleRe = /\bhandle(?:[^\S\n]+(\S+))?[^\S\n]*\{/g
  for (const match of site.matchAll(handleRe)) {
    const openIdx = (match.index ?? 0) + match[0].length - 1
    const closeIdx = findMatchingBrace(site, openIdx)
    const body = site.slice(openIdx + 1, closeIdx)
    const upstreamMatch = /reverse_proxy[^\S\n]+(\S+)/.exec(body)
    blocks.push({matcherToken: match[1], upstream: upstreamMatch?.[1] ?? '', body})
  }

  return {blocks}
}

function resolve(parsed: ReturnType<typeof parseCaddyfile>, path: string): {upstream: string} | undefined {
  const bare = path.split('?')[0] ?? path

  for (const block of parsed.blocks) {
    const token = block.matcherToken

    if (token === undefined) {
      // catch-all
      return {upstream: block.upstream}
    }

    // Literal path matcher, e.g. `/operator/*`. Caddy matches the literal
    // prefix including the slash, so `/operator/*` claims `/operator/` and
    // below but NOT bare `/operator` or `/operatorx` — those fall to the
    // catch-all and reach the dashboard app.
    if (token.endsWith('/*')) {
      const base = token.slice(0, -2)
      if (bare.startsWith(`${base}/`)) return {upstream: block.upstream}
    } else if (token.startsWith('/')) {
      if (bare === token) return {upstream: block.upstream}
    } else {
      // Named matchers, regexps, etc. are not part of the contract. Fail
      // loudly instead of silently mis-modelling them.
      throw new Error(`unsupported handle matcher ${token}`)
    }
  }

  return undefined
}

const parsed = parseCaddyfile(caddyfile)
const gateway = '{$GATEWAY_VPC_IP}:9300'
const app = 'dashboard:3000'

describe('dashboard Caddyfile routing', () => {
  it.each([
    // `/operator/*` goes to the gateway.
    ['/operator/', gateway],
    ['/operator/health', gateway],
    ['/operator/auth/github/start', gateway],
    ['/operator/runs/abc/stream', gateway],
    ['/operator/health?x=1', gateway],
    // Everything else goes to the app, unrewritten. Bare `/operator` and
    // `/operatorx` do not match `/operator/*`.
    ['/', app],
    ['/privacy', app],
    ['/api/healthz', app],
    ['/auth/callback', app],
    ['/sw.js', app],
    ['/manifest.webmanifest', app],
    ['/icon-192.png', app],
    ['/foo', app],
    ['/operator', app],
    ['/operatorx', app],
    ['/static/operator-stream.js', app],
  ])('%s -> %s', (path, upstream) => {
    expect(resolve(parsed, path)).toEqual({upstream})
  })

  it('has exactly two handles: /operator/* first, then a matcherless catch-all', () => {
    expect(parsed.blocks.map(block => block.matcherToken)).toEqual(['/operator/*', undefined])
  })

  it('places /operator/* before the catch-all', () => {
    // Handle blocks are first-match-wins; /operator/* after the catch-all
    // would never be reached and operator traffic would hit the app.
    const operatorIndex = parsed.blocks.findIndex(block => block.matcherToken === '/operator/*')
    const catchallIndex = parsed.blocks.findIndex(block => block.matcherToken === undefined)

    expect(operatorIndex).toBeGreaterThan(-1)
    expect(catchallIndex).toBeGreaterThan(-1)
    expect(operatorIndex).toBeLessThan(catchallIndex)
  })

  it('proxies the catch-all to the app with no extra directives', () => {
    const catchall = parsed.blocks.find(block => block.matcherToken === undefined)
    expect(catchall?.upstream).toBe(app)
    expect(catchall?.body.trim()).toBe(`reverse_proxy ${app}`)
  })

  it('keeps the operator proxy target and headers', () => {
    const operator = parsed.blocks.find(block => block.matcherToken === '/operator/*')
    expect(operator?.upstream).toBe(gateway)
    expect(operator?.body).toContain('flush_interval -1')
    expect(operator?.body).toContain('header_up Host dashboard.fro.bot')
    expect(operator?.body).toContain('header_up X-Forwarded-Proto https')
  })

  it('has no rewrite directive anywhere; the app owns path handling', () => {
    expect(stripComments(caddyfile)).not.toMatch(/\brewrite\b/)
  })
})
