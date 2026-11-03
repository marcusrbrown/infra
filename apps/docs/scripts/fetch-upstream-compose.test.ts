import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {dirname, join} from 'node:path'
import {afterEach, describe, expect, it} from 'bun:test'
import {
  fetchUpstreamCompose,
  readPinnedRef,
  UPSTREAM_CACHE_DIR,
  UPSTREAM_REF_PATTERN,
  upstreamComposeCachePath,
  upstreamComposeUrl,
  type FetchLike,
} from './fetch-upstream-compose'

const temps: string[] = []
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, {recursive: true, force: true})
})

function tempRoot(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'infra-fetch-'))
  temps.push(dir)
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), {recursive: true})
    writeFileSync(join(dir, rel), content)
  }
  return dir
}

function pinned(ref: unknown): Record<string, string> {
  return {'apps/gateway/upstream.json': JSON.stringify({repo: 'fro-bot/agent', ref})}
}

/** A fake fetch that records every call; it never touches the network. */
function fakeFetch(respond: () => Response): {fetch: FetchLike; calls: string[]} {
  const calls: string[] = []
  const fetch: FetchLike = url => {
    calls.push(url)
    return Promise.resolve(respond())
  }
  return {fetch, calls}
}

const COMPOSE = 'services:\n  gateway:\n    image: g\n'

describe('shared definitions', () => {
  it('builds the raw URL and the ref-keyed cache path', () => {
    expect(upstreamComposeUrl('v1.2.3')).toBe(
      'https://raw.githubusercontent.com/fro-bot/agent/v1.2.3/deploy/compose.yaml',
    )
    expect(UPSTREAM_CACHE_DIR).toBe('.cache/upstream-compose')
    expect(upstreamComposeCachePath('v1.2.3')).toBe('.cache/upstream-compose/v1.2.3/compose.yaml')
  })

  it('accepts only whole-string release tags', () => {
    expect(UPSTREAM_REF_PATTERN.test('v1.2.3')).toBe(true)
    expect(UPSTREAM_REF_PATTERN.test('v10.20.30')).toBe(true)
    expect(UPSTREAM_REF_PATTERN.test('v1.2.3\nv9.9.9')).toBe(false)
    expect(UPSTREAM_REF_PATTERN.multiline).toBe(false)
  })
})

describe('readPinnedRef', () => {
  it('reads the ref from apps/gateway/upstream.json', () => {
    expect(readPinnedRef(tempRoot(pinned('v1.2.3')))).toBe('v1.2.3')
  })

  it('fails when upstream.json is missing or malformed', () => {
    expect(() => readPinnedRef(tempRoot())).toThrow('apps/gateway/upstream.json')
    expect(() => readPinnedRef(tempRoot({'apps/gateway/upstream.json': '{'}))).toThrow('not valid JSON')
  })
})

describe('fetchUpstreamCompose', () => {
  it('writes the downloaded compose to the ref-keyed cache path', async () => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const {fetch, calls} = fakeFetch(() => new Response(COMPOSE, {status: 200}))
    const written = await fetchUpstreamCompose({repoRoot, fetch})
    expect(calls).toEqual(['https://raw.githubusercontent.com/fro-bot/agent/v1.2.3/deploy/compose.yaml'])
    expect(written).toBe(join(repoRoot, '.cache/upstream-compose/v1.2.3/compose.yaml'))
    expect(readFileSync(written, 'utf8')).toBe(COMPOSE)
  })

  it('sends no credentials', async () => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const inits: (RequestInit | undefined)[] = []
    const fetch: FetchLike = (_url, init) => {
      inits.push(init)
      return Promise.resolve(new Response(COMPOSE))
    }
    await fetchUpstreamCompose({repoRoot, fetch})
    expect(inits).toHaveLength(1)
    expect(inits[0]?.headers).toBeUndefined()
    expect(inits[0]?.credentials).toBeUndefined()
  })

  it.each([['main'], ['v1.2'], ['v1.2.3-rc.1'], ['v1.2.3\nv9.9.9'], ['../v1.2.3'], [null], [123], ['']])(
    'rejects the ref %j without calling fetch',
    async ref => {
      const repoRoot = tempRoot(pinned(ref))
      const {fetch, calls} = fakeFetch(() => new Response(COMPOSE))
      await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('release tag')
      expect(calls).toEqual([])
      expect(existsSync(join(repoRoot, UPSTREAM_CACHE_DIR))).toBe(false)
    },
  )

  it('rejects a missing ref without calling fetch', async () => {
    const repoRoot = tempRoot({'apps/gateway/upstream.json': '{"repo":"fro-bot/agent"}'})
    const {fetch, calls} = fakeFetch(() => new Response(COMPOSE))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('release tag')
    expect(calls).toEqual([])
  })

  it('fails on a 404 and writes nothing', async () => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const {fetch} = fakeFetch(() => new Response('not found', {status: 404}))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('404')
    expect(existsSync(join(repoRoot, UPSTREAM_CACHE_DIR))).toBe(false)
  })

  it('fails on a server error', async () => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const {fetch} = fakeFetch(() => new Response('boom', {status: 503}))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('503')
  })

  it.each([[''], ['  \n']])('fails on an empty body (%j) and leaves no file', async body => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const {fetch} = fakeFetch(() => new Response(body, {status: 200}))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('empty')
    expect(existsSync(join(repoRoot, '.cache/upstream-compose/v1.2.3/compose.yaml'))).toBe(false)
  })

  it('does not leave a temp file behind and replaces an older download', async () => {
    const repoRoot = tempRoot({
      ...pinned('v1.2.3'),
      '.cache/upstream-compose/v1.2.3/compose.yaml': 'old: true\n',
    })
    const {fetch} = fakeFetch(() => new Response(COMPOSE))
    await fetchUpstreamCompose({repoRoot, fetch})
    expect(readdirSync(join(repoRoot, '.cache/upstream-compose/v1.2.3'))).toEqual(['compose.yaml'])
    expect(readFileSync(join(repoRoot, '.cache/upstream-compose/v1.2.3/compose.yaml'), 'utf8')).toBe(COMPOSE)
  })

  it('keeps the previous file when a later download fails', async () => {
    const repoRoot = tempRoot({
      ...pinned('v1.2.3'),
      '.cache/upstream-compose/v1.2.3/compose.yaml': 'old: true\n',
    })
    const {fetch} = fakeFetch(() => new Response('', {status: 200}))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('empty')
    expect(readFileSync(join(repoRoot, '.cache/upstream-compose/v1.2.3/compose.yaml'), 'utf8')).toBe('old: true\n')
  })

  it('propagates a network failure', async () => {
    const repoRoot = tempRoot(pinned('v1.2.3'))
    const fetch: FetchLike = () => Promise.reject(new Error('socket closed'))
    await expect(fetchUpstreamCompose({repoRoot, fetch})).rejects.toThrow('socket closed')
  })
})
