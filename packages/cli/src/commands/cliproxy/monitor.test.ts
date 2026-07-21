import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {
  cliproxyMonitorAction,
  createGhEnvironment,
  interpretGhApiResult,
  registerCliproxyMonitor,
  runGhApiOnce,
} from './monitor'

const originalFetch = globalThis.fetch
const originalSetTimeout = globalThis.setTimeout
const originalClearTimeout = globalThis.clearTimeout

function installFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, {preconnect: originalFetch.preconnect})
}

function runMonitor(
  options: Parameters<typeof cliproxyMonitorAction>[0],
  ctx: Parameters<typeof cliproxyMonitorAction>[1],
  sleep: (milliseconds: number) => Promise<void> = async () => {},
): ReturnType<typeof cliproxyMonitorAction> {
  return cliproxyMonitorAction(options, ctx, {
    fetch: globalThis.fetch,
    sleep,
    ghApi: async (_token, path, method, body) => {
      const response = await globalThis.fetch(`https://api.github.com${path}`, {
        method,
        body,
      })
      return {status: response.status, body: await response.text()}
    },
    setTimeout: originalSetTimeout,
    clearTimeout: originalClearTimeout,
  })
}

function configureSyntheticEnvironment(): void {
  process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK = 'https://discord.example/webhook'
  process.env.GITHUB_TOKEN = 'github-token'
  process.env.GITHUB_REPOSITORY = 'owner/repo'
  process.env.GITHUB_ACTOR = 'owner'
  process.env.GITHUB_REPOSITORY_OWNER = 'owner'
  delete process.env.CLIPROXY_URL
}

const MUTATED_ENV_KEYS = [
  'CLIPROXY_API_KEY',
  'CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK',
  'GITHUB_TOKEN',
  'GITHUB_REPOSITORY',
  'GITHUB_ACTOR',
  'GITHUB_REPOSITORY_OWNER',
  'CLIPROXY_URL',
  'ARBITRARY_REPO_SECRET',
  'PATH',
  'HOME',
] as const

describe('cliproxy monitor', () => {
  const originalEnv: Record<string, string | undefined> = {}

  beforeEach(() => {
    for (const name of MUTATED_ENV_KEYS) {
      originalEnv[name] = process.env[name]
    }
  })

  afterEach(() => {
    for (const name of MUTATED_ENV_KEYS) {
      const original = originalEnv[name]
      if (original === undefined) {
        delete process.env[name]
      } else {
        process.env[name] = original
      }
    }
    globalThis.fetch = originalFetch
  })

  it('fails through ActionCtx when required monitor inputs are missing', async () => {
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)
    expect(captured.exit?.code).toBe(1)
  })

  it('rejects an untrusted proxy origin before forwarding the provider key', async () => {
    process.env.CLIPROXY_API_KEY = 'secret-provider-key'
    process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK = 'https://discord.example/webhook'
    process.env.GITHUB_TOKEN = 'github-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_ACTOR = 'owner'
    process.env.GITHUB_REPOSITORY_OWNER = 'owner'
    process.env.CLIPROXY_URL = 'https://evil.example/path?leak=1'

    let requestCount = 0
    installFetch(async () => {
      requestCount++
      return new Response('{}', {status: 200})
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(requestCount).toBe(0)
    expect(captured.stdout.join('')).not.toContain('secret-provider-key')
  })

  it('keeps a healthy absent canonical issue silent', async () => {
    configureSyntheticEnvironment()
    const requests: {url: string; method: string; body?: string}[] = []
    installFetch(async (input, init) => {
      requests.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      })
      return new Response(JSON.stringify([]), {status: 200})
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/issues?state=all')
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
    expect(captured.exit).toBeNull()
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=none issue=none discord=none at \S+/,
    )
    expect(captured.stdout.filter(line => line.includes('CLIProxy auth monitor summary:'))).toHaveLength(1)
  })

  it('uses the gh subprocess boundary instead of fetching GitHub directly', async () => {
    configureSyntheticEnvironment()
    let githubFetches = 0
    installFetch(async input => {
      if (String(input).startsWith('https://api.github.com/')) githubFetches++
      return new Response(JSON.stringify([]), {status: 200})
    })
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx, {
      fetch: globalThis.fetch,
      sleep: async () => {},
      ghApi: async () => ({status: 200, body: '[]'}),
      setTimeout: originalSetTimeout,
      clearTimeout: originalClearTimeout,
    })

    expect(githubFetches).toBe(0)
  })

  it('passes only the allowlisted gh environment and GH_TOKEN to subprocesses', () => {
    process.env.CLIPROXY_API_KEY = 'hostile-provider-secret'
    process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK = 'https://discord.example/secret'
    process.env.ARBITRARY_REPO_SECRET = 'hostile-ambient-secret'
    process.env.PATH = '/test/bin'
    process.env.HOME = '/test/home'

    const environment = createGhEnvironment('github-token')

    expect(environment.GH_TOKEN).toBe('github-token')
    expect(environment.GH_PROMPT_DISABLED).toBe('1')
    expect(environment.GH_NO_UPDATE_NOTIFIER).toBe('1')
    expect(environment.PATH).toBe('/test/bin')
    expect(environment.HOME).toBe('/test/home')
    expect(environment.GITHUB_TOKEN).toBeUndefined()
    expect(environment.CLIPROXY_API_KEY).toBeUndefined()
    expect(environment.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK).toBeUndefined()
    expect(environment.ARBITRARY_REPO_SECRET).toBeUndefined()
  })

  it('parses a valid --include HTTP 404 response even when gh exits nonzero', () => {
    const stdout = 'HTTP/2.0 404 Not Found\r\ncontent-type: application/json\r\n\r\n{"message":"Not Found"}'

    expect(interpretGhApiResult(1, stdout)).toEqual({status: 404, body: '{"message":"Not Found"}'})
  })

  it('maps a nonzero gh exit with no parseable included response to github-transient', () => {
    expect(() => interpretGhApiResult(1, 'gh: connection reset by peer\n')).toThrow('github-transient')
  })

  it('keeps a zero gh exit with malformed output as github-invalid-response', () => {
    expect(() => interpretGhApiResult(0, 'not a valid http response')).toThrow('github-invalid-response')
  })

  it('runGhApiOnce parses a real 404 --include response from a nonzero-exit gh process', async () => {
    const originalPath = process.env.PATH
    const tempDir = await mkdtemp(join(tmpdir(), 'monitor-gh-boundary-'))
    const jsonBody = '{"message":"Not Found","documentation_url":"https://docs.github.com/rest"}'

    try {
      const ghScriptPath = join(tempDir, 'gh')
      await writeFile(
        ghScriptPath,
        [
          '#!/bin/sh',
          String.raw`printf 'HTTP/2.0 404 Not Found\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${jsonBody}'`,
          "echo 'gh: Not Found (HTTP 404)' >&2",
          'exit 1',
          '',
        ].join('\n'),
      )
      await chmod(ghScriptPath, 0o755)
      process.env.PATH = `${tempDir}${originalPath ? `:${originalPath}` : ''}`

      const response = await runGhApiOnce('github-token', '/labels/cliproxy-auth-monitor-test', 'GET')

      expect(response).toEqual({status: 404, body: jsonBody})
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
      await rm(tempDir, {recursive: true, force: true})
    }
  })

  it('retries transient GitHub responses with bounded backoff', async () => {
    configureSyntheticEnvironment()
    let attempts = 0
    const delays: number[] = []
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx, {
      fetch: globalThis.fetch,
      sleep: async delay => {
        delays.push(delay)
      },
      ghApi: async () => {
        attempts++
        return attempts === 1 ? {status: 503, body: '{}'} : {status: 200, body: '[]'}
      },
      setTimeout: originalSetTimeout,
      clearTimeout: originalClearTimeout,
    })

    expect(attempts).toBe(2)
    expect(delays).toEqual([100])
  })

  it('treats an expected label-exists 422 as terminal without retrying', async () => {
    configureSyntheticEnvironment()
    let labelChecks = 0
    const delays: number[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      if (url.includes('/issues?state=all')) return new Response('[]', {status: 200})
      if (url.includes('/labels/')) {
        labelChecks++
        return new Response('already exists', {status: 422})
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(
      runMonitor({validation: 'synthetic-dead'}, ctx, async delay => {
        delays.push(delay)
      }),
    ).rejects.toBeInstanceOf(MockProcessExit)

    expect(labelChecks).toBe(1)
    expect(delays).toEqual([])
    expect(captured.stderr.join('')).toContain('reconciliation')
  })

  it('fails safely after a bounded GitHub timeout retry budget', async () => {
    configureSyntheticEnvironment()
    let attempts = 0
    const {ctx, captured} = createCapturedCtx()

    await expect(
      cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx, {
        fetch: globalThis.fetch,
        sleep: async () => {},
        ghApi: async () => {
          attempts++
          throw new Error('github-timeout')
        },
        setTimeout: originalSetTimeout,
        clearTimeout: originalClearTimeout,
      }),
    ).rejects.toBeInstanceOf(MockProcessExit)

    expect(attempts).toBe(3)
    expect(captured.stderr.join('')).toContain('reconciliation')
    expect(captured.stderr.join('')).not.toContain('github-timeout')
  })

  it('fails closed when a GitHub JSON response does not match its Zod shape', async () => {
    configureSyntheticEnvironment()
    const {ctx, captured} = createCapturedCtx()

    await expect(
      cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx, {
        fetch: globalThis.fetch,
        sleep: async () => {},
        ghApi: async () => ({status: 200, body: '{}'}),
        setTimeout: originalSetTimeout,
        clearTimeout: originalClearTimeout,
      }),
    ).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('')).toContain('reconciliation')
  })

  it('re-reads canonical state before retrying an uncertain issue create', async () => {
    configureSyntheticEnvironment()
    let issueReads = 0
    let createAttempts = 0
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx, {
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          if (String(input) === 'https://discord.example/webhook') return new Response(null, {status: 204})
          throw new Error(`unexpected ${String(input)}`)
        },
        {preconnect: originalFetch.preconnect},
      ),
      sleep: async () => {},
      ghApi: async (_token, path, method) => {
        if (path.includes('/issues?state=all')) {
          issueReads++
          return issueReads === 1
            ? {status: 200, body: '[]'}
            : {
                status: 200,
                body: JSON.stringify([
                  {
                    number: 401,
                    state: 'open',
                    title: 'canonical',
                    body: '<!-- cliproxy-auth-monitor-test:v1 -->',
                    labels: [{name: 'cliproxy-auth-monitor-test'}],
                  },
                ]),
              }
        }
        if (path.includes('/labels/') && method === 'GET') return {status: 404, body: '{}'}
        if (path.endsWith('/issues') && method === 'POST') {
          createAttempts++
          throw new Error('github-transient')
        }
        return {status: 200, body: '{}'}
      },
      setTimeout: originalSetTimeout,
      clearTimeout: originalClearTimeout,
    })

    expect(issueReads).toBe(2)
    expect(createAttempts).toBe(1)
  })

  it('re-reads after one uncertain create attempt before any second POST', async () => {
    configureSyntheticEnvironment()
    let issueReads = 0
    let createAttempts = 0
    const events: string[] = []
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx, {
      fetch: Object.assign(
        async (input: string | URL | Request) => {
          if (String(input) === 'https://discord.example/webhook') return new Response(null, {status: 204})
          throw new Error(`unexpected ${String(input)}`)
        },
        {preconnect: originalFetch.preconnect},
      ),
      sleep: async () => {},
      ghApi: async (_token, path, method) => {
        if (path.includes('/issues?state=all')) {
          issueReads++
          events.push('list')
          return issueReads === 1
            ? {status: 200, body: '[]'}
            : {
                status: 200,
                body: JSON.stringify([
                  {
                    number: 402,
                    state: 'open',
                    title: 'canonical',
                    body: '<!-- cliproxy-auth-monitor-test:v1 -->',
                    labels: [{name: 'cliproxy-auth-monitor-test'}],
                  },
                ]),
              }
        }
        if (path.includes('/labels/') && method === 'GET') return {status: 404, body: '{}'}
        if (path.endsWith('/issues') && method === 'POST') {
          createAttempts++
          events.push('create')
          throw new Error('github-transient')
        }
        if (path.endsWith('/issues/402') && method === 'PATCH') {
          events.push('marker')
          return {status: 200, body: '{}'}
        }
        return {status: 200, body: '{}'}
      },
      setTimeout: originalSetTimeout,
      clearTimeout: originalClearTimeout,
    })

    expect(createAttempts).toBe(1)
    expect(events.slice(0, 3)).toEqual(['list', 'create', 'list'])
  })

  it('creates, alerts, and marks a canonical issue for a bootstrap outage', async () => {
    configureSyntheticEnvironment()
    const requests: {url: string; method: string; body?: string}[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push({url, method, body})
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'GET' && url.endsWith('/issues?state=all&per_page=100')) return new Response('[]', {status: 200})
      if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
      if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
      if (method === 'POST' && url.endsWith('/issues')) {
        return new Response(JSON.stringify({number: 42, state: 'open', title: 'x', body: body ?? '', labels: []}), {
          status: 201,
        })
      }
      if (method === 'PATCH' && url.endsWith('/issues/42')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(1)
    expect(requests.some(request => request.method === 'POST' && request.url.endsWith('/labels'))).toBe(true)
    expect(requests.some(request => request.method === 'POST' && request.url.endsWith('/issues'))).toBe(true)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
    const createIndex = requests.findIndex(request => request.method === 'POST' && request.url.endsWith('/issues'))
    const discordIndex = requests.findIndex(request => request.url === 'https://discord.example/webhook')
    const markerIndex = requests.findIndex(request => request.method === 'PATCH' && request.url.endsWith('/issues/42'))
    expect(createIndex).toBeLessThan(discordIndex)
    expect(discordIndex).toBeLessThan(markerIndex)
    expect(requests.find(request => request.method === 'POST' && request.url.endsWith('/issues'))?.body).toContain(
      'cliproxy login claude',
    )
    expect(requests.every(request => !request.body?.includes('unexpected'))).toBe(true)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=dead reason=auth-401 transition=outage issue=created discord=outage-sent at \S+/,
    )
    expect(captured.stdout.filter(line => line.includes('CLIProxy auth monitor summary:'))).toHaveLength(1)
  })

  it('refreshes an active dead issue without duplicating its alert', async () => {
    configureSyntheticEnvironment()
    const requests: {url: string; method: string}[] = []
    const body = '<!-- cliproxy-auth-monitor-test:v1 -->\n<!-- cliproxy-auth-monitor-test:notified=dead -->'
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({url, method})
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'GET') {
        return new Response(
          JSON.stringify([
            {number: 7, state: 'open', title: 'edited', body, labels: [{name: 'cliproxy-auth-monitor-test'}]},
          ]),
          {
            status: 200,
          },
        )
      }
      if (method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(0)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=dead reason=auth-401 transition=none issue=updated discord=none at \S+/,
    )
  })

  it('reopens a manually closed dead issue and sends a fresh outage alert', async () => {
    configureSyntheticEnvironment()
    const requests: {url: string; method: string}[] = []
    const body = '<!-- cliproxy-auth-monitor-test:v1 -->\n<!-- cliproxy-auth-monitor-test:notified=dead -->'
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({url, method})
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'GET') {
        return new Response(
          JSON.stringify([
            {number: 10, state: 'closed', title: 'x', body, labels: [{name: 'cliproxy-auth-monitor-test'}]},
          ]),
          {
            status: 200,
          },
        )
      }
      if (method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(1)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(2)
    const reopenIndex = requests.findIndex(request => request.method === 'PATCH' && request.url.endsWith('/issues/10'))
    const discordIndex = requests.findIndex(request => request.url === 'https://discord.example/webhook')
    const markerIndex = requests.findLastIndex(
      request => request.method === 'PATCH' && request.url.endsWith('/issues/10'),
    )
    expect(reopenIndex).toBeLessThan(discordIndex)
    expect(discordIndex).toBeLessThan(markerIndex)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=dead reason=auth-401 transition=outage issue=reopened discord=outage-sent at \S+/,
    )
  })

  it('retries recovery notification for a closed issue with a dead marker', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const requests: {url: string; method: string}[] = []
    const body = '<!-- cliproxy-auth-monitor-test:v1 -->\n<!-- cliproxy-auth-monitor-test:notified=dead -->'
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({url, method})
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response(null, {status: 204})
      }
      if (method === 'GET') {
        return new Response(
          JSON.stringify([
            {number: 13, state: 'closed', title: 'x', body, labels: [{name: 'cliproxy-auth-monitor-test'}]},
          ]),
          {status: 200},
        )
      }
      if (method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(1)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
    const discordIndex = requests.findIndex(request => request.url === 'https://discord.example/webhook')
    const markerIndex = requests.findLastIndex(
      request => request.method === 'PATCH' && request.url.endsWith('/issues/13'),
    )
    expect(discordIndex).toBeLessThan(markerIndex)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=notification-retry issue=none discord=recovery-sent at \S+/,
    )
  })

  it('updates an open outage before retrying Discord and marking notified state', async () => {
    configureSyntheticEnvironment()
    const events: string[] = []
    const body = '<!-- cliproxy-auth-monitor-test:v1 -->'
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        events.push('discord')
        return new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all'))
        return new Response(
          JSON.stringify([
            {number: 15, state: 'open', title: 'x', body, labels: [{name: 'cliproxy-auth-monitor-test'}]},
          ]),
          {status: 200},
        )
      if (url.endsWith('/issues/15') && init?.method === 'PATCH') {
        events.push(typeof init.body === 'string' && init.body.includes('notified=dead') ? 'marker' : 'open')
        return new Response('{}', {status: 200})
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(events).toEqual(['open', 'discord', 'marker'])
  })

  for (const marker of ['healthy', null] as const) {
    it(`keeps a closed healthy issue with ${marker === null ? 'no' : marker} marker as a no-op`, async () => {
      configureSyntheticEnvironment()
      let discordAttempts = 0
      let mutations = 0
      const body = `<!-- cliproxy-auth-monitor-test:v1 -->${marker === null ? '' : `\n<!-- cliproxy-auth-monitor-test:notified=${marker} -->`}`
      installFetch(async (input, _init) => {
        const url = String(input)
        if (url === 'https://discord.example/webhook') {
          discordAttempts++
          return new Response(null, {status: 204})
        }
        if (url.includes('/issues?state=all'))
          return new Response(
            JSON.stringify([
              {
                number: marker === null ? 17 : 16,
                state: 'closed',
                title: 'x',
                body,
                labels: [{name: 'cliproxy-auth-monitor-test'}],
              },
            ]),
            {status: 200},
          )
        mutations++
        return new Response('{}', {status: 200})
      })
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'synthetic-healthy'}, ctx)

      expect(discordAttempts).toBe(0)
      expect(mutations).toBe(0)
      expect(captured.stdout.join('\n')).toContain('transition=none')
    })
  }

  it('does not treat a live notification marker as synthetic state', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all'))
        return new Response(
          JSON.stringify([
            {
              number: 14,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->\n<!-- cliproxy-auth-monitor:notified=dead -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      if (init?.method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(0)
    expect(captured.stdout.join('\n')).toContain('transition=repair')
  })

  it('searches beyond the first GitHub issue page before creating a canonical issue', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    const firstPage = Array.from({length: 100}, (_, index) => ({
      number: index + 1,
      state: 'closed',
      title: 'unrelated',
      body: null,
      labels: [],
    }))
    const canonical = {
      number: 101,
      state: 'closed',
      title: 'edited title',
      body: '<!-- cliproxy-auth-monitor-test:v1 -->',
      labels: [{name: 'cliproxy-auth-monitor-test'}],
    }
    installFetch(async (input, init) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('page=2')) return new Response(JSON.stringify([canonical]), {status: 200})
      if (url.includes('/issues?state=all')) return new Response(JSON.stringify(firstPage), {status: 200})
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(requests.some(request => request.includes('page=2'))).toBe(true)
    expect(requests.some(request => request.includes('POST') && request.endsWith('/issues'))).toBe(false)
  })

  it('prefers the unique labeled identity when a marker-only stray also exists', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 201,
              state: 'open',
              title: 'canonical',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
            {
              number: 202,
              state: 'open',
              title: 'stray',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/201')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.endsWith('/issues/201'))).toBe(true)
    expect(requests.some(request => request.endsWith('/issues/202'))).toBe(false)
    expect(requests.some(request => request.endsWith('/issues'))).toBe(false)
  })

  it('chooses the lowest issue number when multiple trusted canonical issues exist', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push(`${method} ${url}`)
      if (url.includes('/issues?state=all'))
        return new Response(
          JSON.stringify([
            {
              number: 302,
              state: 'open',
              title: 'higher',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
            {
              number: 301,
              state: 'open',
              title: 'lower',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'PATCH' && url.endsWith('/issues/301')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.endsWith('/issues/301'))).toBe(true)
    expect(requests.some(request => request.endsWith('/issues/302'))).toBe(false)
  })

  it('ignores marker-bearing pull requests during canonical issue resolution', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 215,
              state: 'open',
              title: 'canonical issue',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
            {
              number: 216,
              state: 'open',
              title: 'canonical pull request',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
              pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/216'},
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/215')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.endsWith('/issues/215'))).toBe(true)
    expect(requests.some(request => request.endsWith('/issues/216'))).toBe(false)
  })

  it('does not adopt a trusted marker-bearing pull request when no real issue exists', async () => {
    configureSyntheticEnvironment()
    let issueCreates = 0
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url.includes('/issues?state=all'))
        return new Response(
          JSON.stringify([
            {
              number: 217,
              state: 'open',
              title: 'pull request',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
              pull_request: {url: 'https://api.github.com/repos/owner/repo/pulls/217'},
            },
          ]),
          {status: 200},
        )
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
      if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
      if (method === 'POST' && url.endsWith('/issues')) {
        issueCreates++
        return new Response(JSON.stringify({number: 218, state: 'open', title: 'issue', body: '', labels: []}), {
          status: 201,
        })
      }
      if (method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(issueCreates).toBe(1)
  })

  it('does not retry a non-429 client error from Discord', async () => {
    configureSyntheticEnvironment()
    for (const status of [400, 401, 403]) {
      let discordAttempts = 0
      installFetch(async (input, init) => {
        const url = String(input)
        if (url === 'https://discord.example/webhook') {
          discordAttempts++
          return new Response('bad request', {status})
        }
        if (url.includes('/issues?state=all')) {
          return new Response(
            JSON.stringify([
              {
                number: 203,
                state: 'open',
                title: 'x',
                body: '<!-- cliproxy-auth-monitor-test:v1 -->',
                labels: [{name: 'cliproxy-auth-monitor-test'}],
              },
            ]),
            {status: 200},
          )
        }
        if (url.endsWith('/issues/203')) return new Response('{}', {status: 200})
        throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
      })
      const {ctx} = createCapturedCtx()

      await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

      expect(discordAttempts).toBe(1)
    }
  })

  it('reports missing synthetic inputs separately from synthetic authorization failure', async () => {
    configureSyntheticEnvironment()
    delete process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('')).toContain('missing-CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK')
    expect(captured.stderr.join('')).not.toContain('synthetic-unauthorized')
  })

  it('rejects malformed repository identity before making a GitHub request', async () => {
    configureSyntheticEnvironment()
    process.env.GITHUB_REPOSITORY = 'owner/repo/extra'
    let requestCount = 0
    installFetch(async () => {
      requestCount++
      return new Response('{}', {status: 200})
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-healthy'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(requestCount).toBe(0)
    expect(captured.stderr.join('')).toContain('malformed-GITHUB_REPOSITORY')
  })

  it('retries Discord 429 and honors a bounded Retry-After delay', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const delays: number[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return discordAttempts === 1
          ? new Response('rate limited', {status: 429, headers: {'retry-after': '2'}})
          : new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 204,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/204')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx, async delay => {
      delays.push(delay)
    })

    expect(discordAttempts).toBe(2)
    expect(delays).toEqual([1000])
  })

  it('fails closed when a trusted label-only issue lacks the active marker', async () => {
    configureSyntheticEnvironment()
    let mutationCount = 0
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 205,
              state: 'closed',
              title: 'label only',
              body: 'no identity',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (method !== 'GET') mutationCount++
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(mutationCount).toBe(0)
    expect(captured.stderr.join('')).toContain('trusted-label-mismatch')
  })

  it('ignores an unlabeled marker issue and creates a separate trusted issue', async () => {
    configureSyntheticEnvironment()
    let issueCreates = 0
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 214,
              state: 'open',
              title: 'operator edited title',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [],
            },
          ]),
          {status: 200},
        )
      }
      if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
      if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
      if (method === 'POST' && url.endsWith('/issues')) {
        issueCreates++
        return new Response(JSON.stringify({number: 215, state: 'open', title: 'new', body: '', labels: []}), {
          status: 201,
        })
      }
      if (method === 'PATCH' || url === 'https://discord.example/webhook') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(issueCreates).toBe(1)
  })

  it('ignores multiple unlabeled marker-only issues and creates a trusted canonical issue', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push(`${init?.method ?? 'GET'} ${url}`)
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {number: 207, state: 'closed', title: 'one', body: '<!-- cliproxy-auth-monitor-test:v1 -->', labels: []},
            {number: 208, state: 'closed', title: 'two', body: '<!-- cliproxy-auth-monitor-test:v1 -->', labels: []},
          ]),
          {status: 200},
        )
      }
      if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
      if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
      if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
      if (method === 'POST' && url.endsWith('/issues'))
        return new Response(JSON.stringify({number: 208, state: 'open', title: 'created', body: '', labels: []}), {
          status: 201,
        })
      if (method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.includes('POST https://discord.example/webhook'))).toBe(true)
  })

  it('closes an open dead issue, sends recovery, then persists healthy state', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const patchBodies: string[] = []
    const sequence: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        sequence.push('discord')
        return new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 209,
              state: 'open',
              title: 'edited title',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->\n<!-- cliproxy-auth-monitor-test:notified=dead -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/209') && init?.method === 'PATCH') {
        patchBodies.push(typeof init.body === 'string' ? init.body : '')
        sequence.push(patchBodies.length === 1 ? 'close' : 'marker')
        return new Response('{}', {status: 200})
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(1)
    expect(patchBodies).toHaveLength(2)
    expect(patchBodies[0]).toContain('"state":"closed"')
    expect(patchBodies[1]).toContain('notified=healthy')
    expect(sequence).toEqual(['close', 'discord', 'marker'])
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=recovery issue=closed discord=recovery-sent at \S+/,
    )
  })

  it('closes an open issue with no dead marker silently and records healthy state', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    let patchCount = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 210,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/210') && init?.method === 'PATCH') {
        patchCount++
        return new Response('{}', {status: 200})
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(0)
    expect(patchCount).toBe(2)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=repair issue=closed discord=none at \S+/,
    )
  })

  it('does not mutate canonical state for an unknown live provider result', async () => {
    configureSyntheticEnvironment()
    process.env.CLIPROXY_API_KEY = 'provider-key'
    const requests: {url: string; method: string}[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      requests.push({url, method})
      if (url.includes('/v1/chat/completions')) return new Response('temporary upstream failure', {status: 503})
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 8,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor:v1 -->',
              labels: [],
            },
          ]),
          {status: 200},
        )
      }
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(
      requests.filter(request => request.method !== 'GET' && !request.url.includes('/v1/chat/completions')),
    ).toHaveLength(0)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=unknown reason=unrelated-http transition=none issue=none discord=none at \S+/,
    )
  })

  it('keeps an unknown provider result silent when no canonical issue exists', async () => {
    configureSyntheticEnvironment()
    process.env.CLIPROXY_API_KEY = 'provider-key'
    const requests: {url: string; method: string}[] = []
    installFetch(async (input, init) => {
      const url = String(input)
      requests.push({url, method: init?.method ?? 'GET'})
      if (url.includes('/v1/chat/completions')) return new Response('temporary', {status: 503})
      if (url.includes('/issues?state=all')) return new Response('[]', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(requests.some(request => request.url.includes('/v1/chat/completions'))).toBe(true)
    expect(
      requests.filter(request => request.method !== 'GET' && !request.url.includes('/v1/chat/completions')),
    ).toHaveLength(0)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=unknown reason=unrelated-http transition=none issue=none discord=none at \S+/,
    )
  })

  it('keeps hostile provider body and exception text out of monitor output', async () => {
    configureSyntheticEnvironment()
    process.env.CLIPROXY_API_KEY = 'secret-provider-key'
    const hostile = 'HOSTILE_BODY https://secret.example stack trace secret-provider-key'
    installFetch(async input => {
      const url = String(input)
      if (url.includes('/v1/chat/completions')) throw new Error(hostile)
      if (url.includes('/issues?state=all')) return new Response('[]', {status: 200})
      throw new Error(hostile)
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    expect(output).not.toContain('HOSTILE_BODY')
    expect(output).not.toContain('secret-provider-key')
    expect(output).not.toContain('secret.example')
  })

  it('rejects unauthorized synthetic validation before provider or state requests', async () => {
    configureSyntheticEnvironment()
    process.env.GITHUB_ACTOR = 'contributor'
    let requestCount = 0
    installFetch(async () => {
      requestCount++
      return new Response('{}', {status: 200})
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(requestCount).toBe(0)
    expect(captured.stderr.join('')).not.toContain('contributor')
  })

  it('retries a transient Discord failure and disables mentions', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const discordBodies: string[] = []
    const issueBody = '<!-- cliproxy-auth-monitor-test:v1 -->'
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        discordBodies.push(typeof init?.body === 'string' ? init.body : '')
        return discordAttempts === 1 ? new Response('temporary', {status: 503}) : new Response(null, {status: 204})
      }
      if (url.endsWith('/issues?state=all&per_page=100')) {
        return new Response(
          JSON.stringify([
            {
              number: 9,
              state: 'open',
              title: 'edited',
              body: issueBody,
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {
            status: 200,
          },
        )
      }
      if (url.endsWith('/issues/9')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-dead'}, ctx)

    expect(discordAttempts).toBe(2)
    expect(discordBodies.every(body => body.includes('"allowed_mentions":{"parse":[]}'))).toBe(true)
    expect(discordBodies.every(body => body.includes('"content":"[synthetic test] '))).toBe(true)
  })

  it('retries Discord network failures up to the bounded attempt limit', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        throw new Error('secret network exception')
      }
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 212,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/212')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(discordAttempts).toBe(3)
  })

  it('leaves the notification marker stale when the post-Discord GitHub write fails', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    let patchAttempts = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response(null, {status: 204})
      }
      if (url.endsWith('/issues?state=all&per_page=100')) {
        return new Response(
          JSON.stringify([
            {
              number: 11,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/11') && init?.method === 'PATCH') {
        patchAttempts++
        return new Response('{}', {status: patchAttempts === 1 ? 200 : 500})
      }
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(discordAttempts).toBe(1)
    expect(patchAttempts).toBe(4)
  })

  it('treats a revoked Discord webhook as terminal without retrying', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response('revoked', {status: 404})
      }
      if (url.endsWith('/issues?state=all&per_page=100')) {
        return new Response(
          JSON.stringify([
            {
              number: 12,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/12') && init?.method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(discordAttempts).toBe(1)
  })

  it('does not send Discord when the issue state mutation fails', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    installFetch(async (input, init) => {
      const url = String(input)
      if (url === 'https://discord.example/webhook') {
        discordAttempts++
        return new Response(null, {status: 204})
      }
      if (url.includes('/issues?state=all')) {
        return new Response(
          JSON.stringify([
            {
              number: 211,
              state: 'open',
              title: 'x',
              body: '<!-- cliproxy-auth-monitor-test:v1 -->',
              labels: [{name: 'cliproxy-auth-monitor-test'}],
            },
          ]),
          {status: 200},
        )
      }
      if (url.endsWith('/issues/211') && init?.method === 'PATCH') return new Response('denied', {status: 403})
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await expect(runMonitor({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(discordAttempts).toBe(0)
  })

  it('registers the enum validation option with a live default and no secret flags', () => {
    const cli = goke('infra')
    registerCliproxyMonitor(cli)
    const help = cli.helpText()

    expect(help).toContain('cliproxy monitor')
    expect(help).toContain('synthetic-dead')
    expect(help).toContain('synthetic-healthy')
    expect(help).toContain('default: live')
    expect(help).not.toContain('--api-key')
    expect(help).not.toContain('--webhook')
  })
})
