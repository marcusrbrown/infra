import {readdirSync} from 'node:fs'

import {describe, expect, it} from 'bun:test'

import {READER_GATE_DEADLINE_MS} from '../src/host'

// The three ingest states are produced by Caddy itself: the Caddyfile imports
// `ingest/{$TRACES_INGEST_STATE}.caddy`, and Caddy substitutes the environment value while it parses.
// `render(state)` reproduces that one substitution (the site address and the import) and nothing
// else, so the tests assert against the real files. Behaviour of the rendered text was also checked
// with `caddy adapt` and a running Caddy container when the files were written.
//
// The routing model parses `handle` blocks in file order (Caddy's `handle` is first-match-wins and
// mutually exclusive), as apps/dashboard/config/Caddyfile.test.ts does. The only wildcard matchers in this contract
// are the two agent routes, which sit in the main file and not in the ingest-state files.

const GROUPS = ['marcusrbrown', 'fro-bot', 'workstation'] as const
const AGENT_ROUTES = ['langfuse', 'grafana'] as const
const AGENT_MATCHER = /^\/agent\/(?:langfuse|grafana)\/\*$/
const GATE_UPSTREAM = 'reader-gate:8090'
const DOMAIN = 'traces.fro.bot'
const IMPORT_LINE = /^[^\S\n]*import ingest\/\{\$TRACES_INGEST_STATE\}\.caddy[^\S\n]*$/m

const caddyfile = await Bun.file(new URL('Caddyfile', import.meta.url)).text()
const ingestDir = new URL('ingest/', import.meta.url)
const states = readdirSync(ingestDir)
  .filter(name => name.endsWith('.caddy'))
  .map(name => name.slice(0, -'.caddy'.length))
  .sort()

async function ingestFile(state: string): Promise<string> {
  return Bun.file(new URL(`${state}.caddy`, ingestDir)).text()
}

function stripComments(input: string): string {
  return input
    .split('\n')
    .filter(line => !line.trim().startsWith('#'))
    .join('\n')
}

async function render(state: string): Promise<string> {
  const snippet = stripComments(await ingestFile(state))
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => `\t${line}`)
    .join('\n')
  return stripComments(caddyfile).replaceAll('{$TRACES_DOMAIN}', DOMAIN).replace(IMPORT_LINE, snippet)
}

function findMatchingBrace(input: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < input.length; i++) {
    if (input[i] === '{') depth++
    else if (input[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  throw new Error('unbalanced braces in Caddyfile')
}

interface HandleBlock {
  matcher: string | undefined
  body: string
}

type Outcome = {kind: 'proxy'; upstream: string} | {kind: 'respond'; status: number}

// The top-level site blocks, i.e. lines at column 0 that carry an address before the `{`.
function siteBlocks(rendered: string): string[] {
  const blocks: string[] = []
  const siteRe = /^(?!\{)\S[^\n]*\{[^\S\n]*$/gm
  for (const match of rendered.matchAll(siteRe)) {
    const open = (match.index ?? 0) + match[0].lastIndexOf('{')
    blocks.push(rendered.slice(open + 1, findMatchingBrace(rendered, open)))
  }
  return blocks
}

function handles(site: string): HandleBlock[] {
  const blocks: HandleBlock[] = []
  let cursor = 0
  const handleRe = /^\t(?:handle|handle_path)(?:[^\S\n]+(\S+))?[^\S\n]*\{/gm
  for (const match of site.matchAll(handleRe)) {
    if ((match.index ?? 0) < cursor) continue
    const open = (match.index ?? 0) + match[0].length - 1
    const close = findMatchingBrace(site, open)
    cursor = close
    blocks.push({matcher: match[1], body: site.slice(open + 1, close)})
  }
  return blocks
}

function outcomeOf(body: string): Outcome {
  const proxy = /reverse_proxy[^\S\n]+(\S+)/.exec(body)
  if (proxy?.[1] !== undefined) return {kind: 'proxy', upstream: proxy[1]}
  const respond = /respond[^\S\n]+(\d{3})/.exec(body)
  if (respond?.[1] !== undefined) return {kind: 'respond', status: Number(respond[1])}
  throw new Error(`handle block without a terminal directive: ${body}`)
}

async function resolver(state: string): Promise<(path: string) => Outcome> {
  const [site] = siteBlocks(await render(state))
  if (site === undefined) throw new Error('no site block')
  const blocks = handles(site)
  return path => {
    for (const block of blocks) {
      if (block.matcher === undefined || block.matcher === path) return outcomeOf(block.body)
      if (!block.matcher.startsWith('/')) throw new Error(`unsupported matcher ${block.matcher}`)
      if (block.matcher.endsWith('*')) {
        if (!AGENT_MATCHER.test(block.matcher)) throw new Error('wildcard matchers are not part of this contract')
        if (path.startsWith(block.matcher.slice(0, -1))) return outcomeOf(block.body)
      }
    }
    throw new Error(`no route for ${path}`)
  }
}

/** The text with every agent-route `handle` block removed, so the rules for the other routes can be checked alone. */
function withoutAgentRoutes(text: string): string {
  let out = text
  const opens = [...text.matchAll(/^\thandle \/agent\/[a-z]+\/\*[^\S\n]*\{/gm)]
  for (const match of opens.reverse()) {
    const start = match.index ?? 0
    const close = findMatchingBrace(text, start + match[0].length - 1)
    out = out.slice(0, start) + out.slice(close + 1)
  }
  return out
}

function agentBlocks(rendered: string): HandleBlock[] {
  const [site] = siteBlocks(rendered)
  return handles(site ?? '').filter(block => block.matcher?.startsWith('/agent/') === true)
}

function seconds(text: string, name: string): number[] {
  return [...text.matchAll(new RegExp(String.raw`${name}\s+(\d+)s\b`, 'g'))].map(match => Number(match[1]))
}

const COLLECTOR_PORTS: Record<(typeof GROUPS)[number], number> = {
  marcusrbrown: 4411,
  'fro-bot': 4412,
  workstation: 4413,
}

const NOT_INGEST = [
  '/',
  '/grafana',
  '/grafana/',
  '/langfuse',
  '/api/public/otel/v1/traces',
  '/v1/traces',
  '/canary/v1/traces',
  '/metrics',
  '/marcusrbrown',
  '/marcusrbrown/v1/traces/extra',
  '/marcusrbrown/v1/traces/',
  '/marcusrbrown/v1/metrics',
  '/Marcusrbrown/v1/traces',
  '/other/v1/traces',
  '/healthz/extra',
  '/agent',
  '/agent/',
  '/agent/langfuse',
  '/agent/grafana',
  '/agent/other/x',
  '/agent/mcp',
  '/agent/langfuse-extra/x',
]

describe('traces Caddyfile', () => {
  it('has exactly one site, addressed by TRACES_DOMAIN', () => {
    const text = stripComments(caddyfile)
    expect(text).toMatch(/^\{\$TRACES_DOMAIN\} \{$/m)
    // Site blocks are lines at column 0 with an address; the global options block has none.
    expect(siteBlocks(text.replaceAll('{$TRACES_DOMAIN}', DOMAIN))).toHaveLength(1)
  })

  it('selects the ingest state with one import of ingest/{$TRACES_INGEST_STATE}.caddy', () => {
    expect(caddyfile.match(new RegExp(IMPORT_LINE, 'gm'))).toHaveLength(1)
  })

  it('has exactly the three states: off, held and open', () => {
    // An unknown value names no file, so Caddy fails to start and no ingest route is served.
    expect(states).toEqual(['held', 'off', 'open'])
  })

  it('caps the request body at 4.5 MiB on the site', () => {
    expect(stripComments(caddyfile)).toMatch(/request_body \{\s*max_size 4718592\s*\}/)
  })

  it('imports the ingest state before the catch-all, so the 404 never shadows an ingest route', async () => {
    const text = stripComments(caddyfile)
    expect(text.search(IMPORT_LINE)).toBeGreaterThan(-1)
    expect(text.search(IMPORT_LINE)).toBeLessThan(text.indexOf('\thandle {'))
  })

  // The agent routes are the exception: a read may take up to the gate's deadline, so their own timeouts are above it
  // (see the agent-route tests). Every other route stays under the sender's 10 seconds.
  it('answers within the sender’s 10 seconds: every timeout outside the agent routes is under 10 seconds', async () => {
    const all = withoutAgentRoutes(stripComments(caddyfile)) + stripComments(await ingestFile('open'))
    const values = [...all.matchAll(/(dial_timeout|response_header_timeout|read_header)\s+(\d+)s/g)].map(m =>
      Number(m[2]),
    )
    expect(values.length).toBeGreaterThanOrEqual(4)
    for (const value of values) expect(value).toBeLessThan(10)
    // The acknowledgement path (collector) waits at most 5 seconds.
    expect(all).toMatch(/response_header_timeout 5s/)
  })

  it.each(states)('%s: /healthz reaches the health reporter and every other path is a 404', async state => {
    const resolve = await resolver(state)
    expect(resolve('/healthz')).toEqual({kind: 'proxy', upstream: 'health-reporter:8080'})
    for (const path of NOT_INGEST) expect(resolve(path)).toEqual({kind: 'respond', status: 404})
  })

  it('off: there is no ingest route at all', async () => {
    const rendered = await render('off')
    expect(rendered).not.toContain('/v1/traces')
    expect(rendered).not.toContain('collector')
    const resolve = await resolver('off')
    for (const group of GROUPS) expect(resolve(`/${group}/v1/traces`)).toEqual({kind: 'respond', status: 404})
  })

  it('held: every ingest path answers 503 and nothing reaches the collector', async () => {
    const rendered = await render('held')
    expect(rendered).not.toContain('collector')
    expect(rendered).not.toContain('reverse_proxy collector')
    const resolve = await resolver('held')
    for (const group of GROUPS) expect(resolve(`/${group}/v1/traces`)).toEqual({kind: 'respond', status: 503})
  })

  it('open: each ingest path reaches its own group’s receiver, on a distinct port', async () => {
    const resolve = await resolver('open')
    for (const group of GROUPS) {
      expect(resolve(`/${group}/v1/traces`)).toEqual({kind: 'proxy', upstream: `collector:${COLLECTOR_PORTS[group]}`})
    }
    expect(new Set(Object.values(COLLECTOR_PORTS)).size).toBe(GROUPS.length)
  })

  it('has exactly the three ingest paths in the held and open states', async () => {
    for (const state of ['held', 'open']) {
      const [site] = siteBlocks(await render(state))
      const matchers = handles(site ?? '').map(block => block.matcher)
      expect(matchers).toEqual([
        ...GROUPS.map(group => `/${group}/v1/traces`),
        '/healthz',
        ...AGENT_ROUTES.map(route => `/agent/${route}/*`),
        undefined,
      ])
    }
  })

  it('routes nothing to Grafana, Langfuse, Tempo, Prometheus or the canary receiver in any state, outside the agent routes', async () => {
    for (const state of states) {
      const rendered = withoutAgentRoutes(await render(state))
      for (const forbidden of [
        /grafana/i,
        /langfuse/i,
        /tempo/i,
        /prometheus/i,
        /canary/i,
        /:9090\b/,
        /:8082\b/,
        /\/metrics/,
        /:4414\b/,
        /:3000\b/,
        /:3001\b/,
        /:3200\b/,
        /:4318\b/,
        /:13133\b/,
        /:8888\b/,
      ]) {
        expect(rendered).not.toMatch(forbidden)
      }
    }
  })

  it('proxies the health reporter on its public port only, never its metrics port', async () => {
    for (const state of states) {
      const upstreams = [...(await render(state)).matchAll(/reverse_proxy\s+health-reporter:(\d+)/g)].map(
        match => match[1],
      )
      expect(upstreams).toEqual(['8080'])
    }
  })
})

// The two agent routes belong to the reader gate. They sit in the main file, outside the ingest-state imports, so they
// answer in every state: an ingest hold never closes a read, and `revoke --all` is the reader kill switch.
describe('traces Caddyfile: agent routes', () => {
  const main = stripComments(caddyfile)
  const AGENT_PATHS = [
    '/agent/langfuse/api/public/mcp',
    '/agent/langfuse/api/public/traces',
    '/agent/langfuse/',
    '/agent/grafana/mcp',
    '/agent/grafana/',
  ]

  it('has one handle per route, in the main file, ahead of the 404', () => {
    const [site] = siteBlocks(main.replaceAll('{$TRACES_DOMAIN}', DOMAIN))
    const matchers = handles(site ?? '').map(block => block.matcher)
    expect(matchers.filter(matcher => matcher?.startsWith('/agent/'))).toEqual(
      AGENT_ROUTES.map(route => `/agent/${route}/*`),
    )
    expect(matchers.at(-1)).toBeUndefined()
    expect(main.search(IMPORT_LINE)).toBeLessThan(main.indexOf('handle /agent/'))
  })

  it.each(states)('%s: both routes reach the reader gate and nothing else', async state => {
    const resolve = await resolver(state)
    for (const path of AGENT_PATHS)
      expect({path, outcome: resolve(path)}).toEqual({path, outcome: {kind: 'proxy', upstream: GATE_UPSTREAM}})
    expect([...(await render(state)).matchAll(/reader-gate/g)]).toHaveLength(AGENT_ROUTES.length)
  })

  it.each(states)('%s: the gate is the only upstream of the agent routes, on its proxy port only', async state => {
    const upstreams = agentBlocks(await render(state)).map(block => outcomeOf(block.body))
    expect(upstreams).toEqual(AGENT_ROUTES.map(() => ({kind: 'proxy', upstream: GATE_UPSTREAM})))
    expect(await render(state)).not.toContain('8091')
  })

  it('leaves the ingest-state files alone: none of them names an agent route or the gate', async () => {
    for (const state of states) {
      expect(await ingestFile(state)).not.toMatch(/agent|reader-gate|mcp/i)
    }
  })

  it('keeps the bans on every other route: an agent block names no store, canary or metrics port', async () => {
    for (const state of states) {
      for (const block of agentBlocks(await render(state))) {
        for (const forbidden of [
          /grafana/i,
          /langfuse/i,
          /tempo/i,
          /prometheus/i,
          /canary/i,
          /collector/i,
          /mcp/i,
          /:3000\b/,
          /:3001\b/,
          /:3200\b/,
          /:8000\b/,
          /:9090\b/,
          /:4414\b/,
          /:13133\b/,
        ]) {
          expect(block.body).not.toMatch(forbidden)
        }
      }
    }
  })

  // Caddy's server timeouts apply to every route. The gate gives an upstream up to its deadline to send headers, so
  // Caddy's response-header timeout on these routes and its server write timeout must outlast it, in that order: the gate
  // answers 504 first, and Caddy still has time to write that answer. Only the dial timeout stays short.
  it('keeps Caddy’s response-header and write timeouts above the gate deadline, with a short dial timeout', async () => {
    const deadline = READER_GATE_DEADLINE_MS / 1000
    const blocks = agentBlocks(await render('open'))
    expect(blocks).toHaveLength(AGENT_ROUTES.length)
    const [write] = seconds(main, 'write')
    expect(write).toBeGreaterThan(deadline)
    for (const block of blocks) {
      expect(seconds(block.body, 'dial_timeout')).toHaveLength(1)
      expect(seconds(block.body, 'dial_timeout')[0]).toBeLessThanOrEqual(5)
      const header = seconds(block.body, 'response_header_timeout')
      expect(header).toHaveLength(1)
      expect(header[0]).toBeGreaterThan(deadline)
      expect(write).toBeGreaterThan(header[0] ?? Number.POSITIVE_INFINITY)
    }
  })

  it('has one write timeout, so the rule above reads the value Caddy uses', () => {
    expect(seconds(main, 'write')).toHaveLength(1)
  })

  // Caddy logs a request, headers included, when a proxy fails; it hides Authorization and Cookie but not X-Api-Key. A
  // reader token travels in Authorization, so the default logger deletes the three credential headers outright.
  it('deletes the Authorization, Cookie and X-Api-Key request headers from the default log', () => {
    const global = main.slice(0, main.indexOf('{$TRACES_DOMAIN}'))
    expect(global).toMatch(/log \{.*format filter \{.*wrap json/s)
    for (const header of ['Authorization', 'Cookie', 'X-Api-Key']) {
      expect(global).toMatch(new RegExp(`request>headers>${header} delete`))
    }
  })

  it('never forwards the caller’s credential headers by naming them in a header directive', () => {
    expect(main).not.toMatch(/header_up\s+(Authorization|Cookie|X-Api-Key)/i)
  })
})
