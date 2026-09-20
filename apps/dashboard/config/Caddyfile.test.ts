import {describe, expect, it} from 'bun:test'

const caddyfile = await Bun.file(new URL('Caddyfile', import.meta.url)).text()

// --- Minimal Caddyfile routing model -----------------------------------
// This is a model of the config's routing semantics, not a Caddy
// reimplementation. It parses `handle` blocks in file order (Caddy's
// `handle` directive is mutually exclusive, first-match-wins) so tests
// below assert against the real file instead of a hand-copied table.

type NamedMatcher = {type: 'exact'; paths: string[]} | {type: 'regexp'; pattern: RegExp}

interface HandleBlock {
  matcherToken: string | undefined // raw token after `handle`, undefined for the catch-all
  upstream: string
  rewritten: boolean
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

function parseCaddyfile(text: string): {namedMatchers: Map<string, NamedMatcher>; blocks: HandleBlock[]} {
  const stripped = stripComments(text)
  // The site block declaration line is `{$DASHBOARD_DOMAIN} {` — the `{` we
  // want to open on is the last one on that line, not the `{` in the
  // `{$DASHBOARD_DOMAIN}` placeholder.
  const firstLineEnd = stripped.indexOf('\n')
  const siteOpen = stripped.slice(0, firstLineEnd).lastIndexOf('{')
  const siteClose = findMatchingBrace(stripped, siteOpen)
  const site = stripped.slice(siteOpen + 1, siteClose)

  // Horizontal-whitespace-only classes throughout: `\s+` adjacent to `.+` is
  // super-linear-backtracking bait, and `\s` would also swallow newlines in
  // these line-anchored patterns.
  const namedMatchers = new Map<string, NamedMatcher>()
  for (const [, name, paths] of site.matchAll(/^[^\S\n]*@(\S+)[^\S\n]+path[^\S\n]+(\S.*)$/gm)) {
    if (name === undefined || paths === undefined) continue
    namedMatchers.set(name, {type: 'exact', paths: paths.trim().split(/[^\S\n]+/)})
  }
  for (const [, name, pattern] of site.matchAll(/^[^\S\n]*@(\S+)[^\S\n]+path_regexp[^\S\n]+(\S.*)$/gm)) {
    if (name === undefined || pattern === undefined) continue
    namedMatchers.set(name, {type: 'regexp', pattern: new RegExp(pattern.trim())})
  }

  const blocks: HandleBlock[] = []
  // Left boundary only: a trailing \b is redundant here because `handle` is
  // always followed by whitespace or `{`.
  const handleRe = /\bhandle(?:[^\S\n]+(\S+))?[^\S\n]*\{/g
  for (const match of site.matchAll(handleRe)) {
    const openIdx = (match.index ?? 0) + match[0].length - 1
    const closeIdx = findMatchingBrace(site, openIdx)
    const body = site.slice(openIdx + 1, closeIdx)
    const upstreamMatch = /reverse_proxy[^\S\n]+(\S+)/.exec(body)
    blocks.push({
      matcherToken: match[1],
      upstream: upstreamMatch?.[1] ?? '',
      rewritten: /\brewrite\b/.test(body),
    })
  }

  return {namedMatchers, blocks}
}

function resolve(
  parsed: ReturnType<typeof parseCaddyfile>,
  path: string,
): {upstream: string; rewritten: boolean} | undefined {
  const bare = path.split('?')[0] ?? path

  for (const block of parsed.blocks) {
    const token = block.matcherToken

    if (token === undefined) {
      // catch-all
      return {upstream: block.upstream, rewritten: block.rewritten}
    }

    if (token.startsWith('@')) {
      const named = parsed.namedMatchers.get(token.slice(1))
      if (!named) throw new Error(`undefined named matcher ${token}`)
      // Caddy `path` matchers honor a trailing `*` as a prefix match. Modelling
      // that is what lets the anti-widening tests below fail on the mutation
      // they are named for: with plain string equality, `path /privacy*` would
      // match nothing at all, so `/privacy-policy-internal` would fall to the
      // catch-all and look correctly excluded while production widened.
      const matched =
        named.type === 'exact'
          ? named.paths.some(p => (p.endsWith('*') ? bare.startsWith(p.slice(0, -1)) : p === bare))
          : named.pattern.test(bare)
      if (matched) return {upstream: block.upstream, rewritten: block.rewritten}
      continue
    }

    // literal path matcher, e.g. `/operator/*`. Caddy matches the literal
    // prefix including the slash, so `/operator/*` claims `/operator/` and
    // below but NOT bare `/operator` — that falls to the catch-all and is
    // rewritten. Verified against production: `/operator` returns 302 with the
    // dashboard's headers, while `/operator/` reaches the gateway.
    if (token.endsWith('/*')) {
      const base = token.slice(0, -2)
      if (bare.startsWith(`${base}/`)) return {upstream: block.upstream, rewritten: block.rewritten}
    } else if (bare === token) {
      return {upstream: block.upstream, rewritten: block.rewritten}
    }
  }

  return undefined
}

const parsed = parseCaddyfile(caddyfile)

describe('dashboard Caddyfile routing', () => {
  const gateway = '{$GATEWAY_VPC_IP}:9300'

  it.each([
    ['/operator/', gateway, false],
    ['/operator/auth/github/start', gateway, false],
    // Bare `/operator` does not match `/operator/*`; it is rewritten like any
    // other extensionless path. The app's own `/operator` redirect never sees it.
    ['/operator', 'dashboard:3000', true],
    ['/api/healthz', 'dashboard:3000', false],
    ['/auth/login', 'dashboard:3000', false],
    ['/sw.js', 'dashboard:3000', false],
    ['/manifest.webmanifest', 'dashboard:3000', false],
    ['/assets/index-abc123.css', 'dashboard:3000', false],
    ['/icon-192.svg', 'dashboard:3000', false],
    ['/privacy', 'dashboard:3000', false],
    ['/privacy/', 'dashboard:3000', false],
    ['/privacy?x=1', 'dashboard:3000', false],
    ['/privacy-policy-internal', 'dashboard:3000', true],
    ['/privacy.html', 'dashboard:3000', false], // has an extension, so @assets claims it first
    ['/', 'dashboard:3000', true],
    ['/dashboard', 'dashboard:3000', true],
    ['/some/deep/path', 'dashboard:3000', true],
  ])('%s -> %s (rewritten: %s)', (path, upstream, rewritten) => {
    expect(resolve(parsed, path)).toEqual({upstream, rewritten})
  })

  it('routes /privacy without a query string when a query string is present', () => {
    // Caddy path matching ignores the query string; a client hitting
    // /privacy?x=1 must still land on the exact-match handle, not the catch-all.
    expect(resolve(parsed, '/privacy?x=1')).toEqual({upstream: 'dashboard:3000', rewritten: false})
  })

  it('does not prefix-match @privacy against similarly-named paths', () => {
    // The bug this file exists to catch: a prefix match on /privacy would
    // silently widen the public surface to anything starting with "/privacy".
    expect(resolve(parsed, '/privacy-policy-internal')).toEqual({upstream: 'dashboard:3000', rewritten: true})
    expect(resolve(parsed, '/privacyX')).toEqual({upstream: 'dashboard:3000', rewritten: true})
  })

  it('places the @privacy handle before the catch-all', () => {
    // Handle blocks are first-match-wins; @privacy after the catch-all
    // would never be reached, which is exactly how this bug shipped.
    const privacyIndex = parsed.blocks.findIndex(block => block.matcherToken === '@privacy')
    const catchallIndex = parsed.blocks.findIndex(block => block.matcherToken === undefined)

    expect(privacyIndex).toBeGreaterThan(-1)
    expect(catchallIndex).toBeGreaterThan(-1)
    expect(privacyIndex).toBeLessThan(catchallIndex)
  })

  it('has exactly one catch-all block, and it is last', () => {
    const catchalls = parsed.blocks.filter(block => block.matcherToken === undefined)
    expect(catchalls).toHaveLength(1)
    expect(parsed.blocks.at(-1)?.matcherToken).toBeUndefined()
  })

  it('only the catch-all block rewrites', () => {
    for (const block of parsed.blocks) {
      expect(block.rewritten).toBe(block.matcherToken === undefined)
    }
  })

  it.each(['/some-new-public-route', '/whoami', '/status'])(
    // Any extensionless path with no explicit handle falls through to the
    // catch-all and gets rewritten to `/`, which the app then treats as an
    // unauthenticated redirect to login. Adding a public extensionless
    // route to the dashboard therefore requires a Caddyfile handle here,
    // or it will be silently unreachable in production (see /privacy).
    'falls through unhandled extensionless path %s to the rewriting catch-all',
    path => {
      expect(resolve(parsed, path)).toEqual({upstream: 'dashboard:3000', rewritten: true})
    },
  )
})
