import type {OpenCodeGoSettings, ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {chmod, mkdtemp, rm, writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  cliproxyMonitorAction,
  createGhEnvironment,
  interpretGhApiResult,
  registerCliproxyMonitor,
  runGhApiOnce,
} from './monitor'

// Fixed Go policy for every run: the committed snapshot and settings change by design, so no test reads them.
const GO_TEST_ENTRY = {zeroRetention: true, trainsOnData: false, regionGated: false, agreementExpiry: null}
const GO_TEST_SNAPSHOT: ParsedSnapshot = {
  source: {
    repo: 'anomalyco/opencode',
    path: 'services/site/src/docs/content/console/go.mdx',
    commit: 'a'.repeat(40),
  },
  models: {
    'glm-5.3': GO_TEST_ENTRY,
    'kimi-k3': GO_TEST_ENTRY,
    'iceman-contributor-free': {...GO_TEST_ENTRY, trainsOnData: true},
  },
  invalid: [],
}
const GO_TEST_SETTINGS: OpenCodeGoSettings = {enabled: true, defaultProbeModel: 'glm-5.3'}

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
  goSettings: OpenCodeGoSettings = GO_TEST_SETTINGS,
): ReturnType<typeof cliproxyMonitorAction> {
  return cliproxyMonitorAction(options, ctx, {
    goSettings,
    goSnapshot: GO_TEST_SNAPSHOT,
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

  it('opens the issue and sends Discord for a live provider-missing 400 exactly like auth-401', async () => {
    const incidentBody =
      '{"error":{"message":"unknown provider for model claude-sonnet-4-6","type":"invalid_request_error","code":"model_not_found","param":"model"}}'
    const runLiveOutage = async (probeResponse: () => Response) => {
      configureSyntheticEnvironment()
      process.env.CLIPROXY_API_KEY = 'provider-key'
      const requests: {url: string; method: string; body?: string}[] = []
      installFetch(async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        const body = typeof init?.body === 'string' ? init.body : undefined
        requests.push({url, method, body})
        if (url.includes('/v1/chat/completions')) return probeResponse()
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
      await runMonitor({validation: 'live'}, ctx)
      return {requests, stdout: captured.stdout.join('\n')}
    }

    const auth401 = await runLiveOutage(() => new Response('Unauthorized', {status: 401}))
    const providerMissing = await runLiveOutage(() => new Response(incidentBody, {status: 400}))

    const shape = (requests: {url: string; method: string}[]) =>
      requests.map(request => `${request.method} ${request.url.replace(/\d+$/, 'N')}`)
    expect(shape(providerMissing.requests)).toEqual(shape(auth401.requests))
    expect(providerMissing.requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(
      1,
    )
    expect(
      providerMissing.requests.find(request => request.method === 'POST' && request.url.endsWith('/issues'))?.body,
    ).toContain('cliproxy login claude')
    expect(providerMissing.stdout).toMatch(
      /CLIProxy auth monitor summary: probe=dead reason=provider-missing transition=outage issue=created discord=outage-sent at \S+/,
    )
    expect(providerMissing.stdout).not.toContain('invalid_request_error')
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

  describe('probe line', () => {
    const probeLinePattern = /^CLIProxy auth monitor probe: probe=(healthy|dead|unknown) reason=(\S+) at (\S+)$/
    const probeLines = (stdout: string[]): string[] =>
      stdout.filter(line => line.startsWith('CLIProxy auth monitor probe:'))
    const summaryLines = (stdout: string[]): string[] =>
      stdout.filter(line => line.startsWith('CLIProxy auth monitor summary:'))

    it('prints the probe line before the summary on a successful run, with the same timestamp', async () => {
      configureSyntheticEnvironment()
      installFetch(async () => new Response('[]', {status: 200}))
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'synthetic-healthy'}, ctx)

      const probeIndex = captured.stdout.findIndex(line => line.startsWith('CLIProxy auth monitor probe:'))
      const summaryIndex = captured.stdout.findIndex(line => line.startsWith('CLIProxy auth monitor summary:'))
      expect(probeIndex).toBeGreaterThanOrEqual(0)
      expect(probeIndex).toBeLessThan(summaryIndex)
      expect(probeLines(captured.stdout)).toHaveLength(1)
      expect(summaryLines(captured.stdout)).toHaveLength(1)
      const probe = probeLinePattern.exec(captured.stdout[probeIndex] ?? '')
      expect(probe?.[1]).toBe('healthy')
      expect(probe?.[2]).toBe('ok')
      expect(captured.stdout[summaryIndex]?.endsWith(` at ${probe?.[3]}`)).toBe(true)
      expect(captured.exit).toBeNull()
    })

    it('does not match the daily-report summary prefix and carries no reconciliation fields', async () => {
      configureSyntheticEnvironment()
      installFetch(async () => new Response('[]', {status: 200}))
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'synthetic-healthy'}, ctx)

      const [line] = probeLines(captured.stdout)
      expect(line).toBeDefined()
      expect(line).not.toMatch(/^CLIProxy auth monitor summary:/)
      expect(line).not.toContain('transition=')
      expect(line).not.toContain('issue=')
      expect(line).not.toContain('discord=')
      expect(line).not.toContain('http')
    })

    it('has printed probe=dead before reconciliation fails, and still exits 1 with no summary', async () => {
      configureSyntheticEnvironment()
      const {ctx, captured} = createCapturedCtx()
      let probeLineSeenAtFirstGithubCall = false

      await expect(
        cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx, {
          fetch: globalThis.fetch,
          sleep: async () => {},
          ghApi: async () => {
            probeLineSeenAtFirstGithubCall ||= probeLines(captured.stdout).length === 1
            throw new Error('github-http-secret-detail')
          },
          setTimeout: originalSetTimeout,
          clearTimeout: originalClearTimeout,
        }),
      ).rejects.toBeInstanceOf(MockProcessExit)

      expect(probeLineSeenAtFirstGithubCall).toBe(true)
      const [line] = probeLines(captured.stdout)
      expect(line).toMatch(/^CLIProxy auth monitor probe: probe=dead reason=auth-401 at \S+$/)
      expect(summaryLines(captured.stdout)).toHaveLength(0)
      expect(captured.exit?.code).toBe(1)
      expect(captured.stderr.join('')).toContain('reconciliation')
      expect([...captured.stdout, ...captured.stderr].join('\n')).not.toContain('secret-detail')
    })

    it('reflects the synthetic outcome for both synthetic modes', async () => {
      configureSyntheticEnvironment()
      installFetch(async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (url === 'https://discord.example/webhook') return new Response(null, {status: 204})
        if (method === 'GET' && url.includes('/issues?state=all')) return new Response('[]', {status: 200})
        if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
        if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
        if (method === 'POST' && url.endsWith('/issues'))
          return new Response(JSON.stringify({number: 42, state: 'open', title: 'x', body: '', labels: []}), {
            status: 201,
          })
        if (method === 'PATCH') return new Response('{}', {status: 200})
        throw new Error(`unexpected ${method} ${url}`)
      })

      const healthy = createCapturedCtx()
      await runMonitor({validation: 'synthetic-healthy'}, healthy.ctx)
      expect(probeLines(healthy.captured.stdout)).toEqual([
        expect.stringMatching(/^CLIProxy auth monitor probe: probe=healthy reason=ok at \S+$/),
      ])

      const dead = createCapturedCtx()
      await runMonitor({validation: 'synthetic-dead'}, dead.ctx)
      expect(probeLines(dead.captured.stdout)).toEqual([
        expect.stringMatching(/^CLIProxy auth monitor probe: probe=dead reason=auth-401 at \S+$/),
      ])
      expect(summaryLines(dead.captured.stdout)).toHaveLength(1)
    })

    it('prints the live unknown probe line without provider text or URLs', async () => {
      configureSyntheticEnvironment()
      process.env.CLIPROXY_API_KEY = 'secret-provider-key'
      installFetch(async input => {
        const url = String(input)
        if (url.includes('/v1/chat/completions'))
          return new Response('HOSTILE_BODY https://secret.example', {status: 503})
        if (url.includes('/issues?state=all')) return new Response('[]', {status: 200})
        throw new Error(`unexpected ${url}`)
      })
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx)

      const lines = probeLines(captured.stdout)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(/^CLIProxy auth monitor probe: probe=unknown reason=unrelated-http at \S+$/)
      expect(lines[0]).not.toContain('HOSTILE_BODY')
      expect(lines[0]).not.toContain('secret')
      expect(summaryLines(captured.stdout)).toHaveLength(1)
    })

    it('prints no probe line when the monitor fails before the probe', async () => {
      const {ctx, captured} = createCapturedCtx()

      await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

      expect(probeLines(captured.stdout)).toHaveLength(0)
    })
  })
})

describe('cliproxy monitor: two routes (Claude and OpenCode Go)', () => {
  const originalEnv: Record<string, string | undefined> = {}
  const ENV_KEYS = [
    'CLIPROXY_API_KEY',
    'CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK',
    'GITHUB_TOKEN',
    'GITHUB_REPOSITORY',
    'GITHUB_ACTOR',
    'GITHUB_REPOSITORY_OWNER',
    'CLIPROXY_URL',
  ] as const
  const CLAUDE_LABEL = 'cliproxy-auth-monitor'
  const GO_LABEL = 'cliproxy-go-monitor'
  const CLAUDE_MARKER = '<!-- cliproxy-auth-monitor:v1 -->'
  const GO_MARKER = '<!-- cliproxy-go-monitor:v1 -->'
  const SECRET_KEY = 'provider-secret-key-never-print'

  interface WorldIssue {
    number: number
    state: 'open' | 'closed'
    title: string
    body: string
    labels: {name: string}[]
  }

  type Reply = () => Response | Promise<Response>

  interface WorldOptions {
    /** The model list the proxy serves; defaults to a healthy Claude plus one eligible Go model. */
    models?: Reply
    claude?: Reply
    go?: Reply
    issues?: WorldIssue[]
    /** Reject writes whose body mentions this marker (an operational failure on one route). */
    failWritesFor?: string
  }

  const claudeOk = () => Response.json({choices: []})
  const goOk = () => Response.json({choices: [], usage: {opencode: {billing_source: 'go', list_cost: '0.00006'}}})
  const goModels = (ids: string[] = ['glm-5.3']) =>
    Response.json({
      data: [
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
        ...ids.flatMap(id => [
          {id, owned_by: 'opencode-go'},
          {id: `opencode-go/${id}`, owned_by: 'opencode-go'},
        ]),
      ],
    })

  interface Recorded {
    url: string
    method: string
    body?: string
    session: string | null
  }

  function installWorld(options: WorldOptions = {}) {
    const issues: WorldIssue[] = options.issues ?? []
    const recorded: Recorded[] = []
    const discord: string[] = []
    const labels = new Set<string>()
    let nextNumber = 100

    installFetch(async (input, init) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      const session = new Headers(init?.headers).get('x-opencode-session')
      recorded.push({url, method, body, session})

      if (url.endsWith('/v1/models')) return (options.models ?? (() => goModels()))()
      if (url.endsWith('/v1/chat/completions')) {
        const model = (JSON.parse(body ?? '{}') as {model?: string}).model ?? ''
        return model.startsWith('claude') ? (options.claude ?? claudeOk)() : (options.go ?? goOk)()
      }
      if (url === 'https://discord.example/webhook') {
        discord.push((JSON.parse(body ?? '{}') as {content: string}).content)
        return new Response(null, {status: 204})
      }
      if (method === 'GET' && url.includes('/issues?state=all')) return Response.json(issues)
      if (method === 'GET' && url.includes('/labels/')) {
        const name = decodeURIComponent(url.split('/labels/')[1] ?? '')
        return new Response('{}', {status: labels.has(name) ? 200 : 404})
      }
      if (method === 'POST' && url.endsWith('/labels')) {
        labels.add((JSON.parse(body ?? '{}') as {name: string}).name)
        return new Response('{}', {status: 201})
      }
      if (options.failWritesFor !== undefined && body?.includes(options.failWritesFor)) {
        return new Response('boom', {status: 500})
      }
      if (method === 'POST' && url.endsWith('/issues')) {
        const parsed = JSON.parse(body ?? '{}') as {title: string; body: string; labels: string[]}
        nextNumber += 1
        const created: WorldIssue = {
          number: nextNumber,
          state: 'open',
          title: parsed.title,
          body: parsed.body,
          labels: parsed.labels.map(name => ({name})),
        }
        issues.push(created)
        return Response.json(created, {status: 201})
      }
      if (method === 'PATCH' && /\/issues\/\d+$/.test(url)) {
        const parsed = JSON.parse(body ?? '{}') as {state: 'open' | 'closed'; body: string}
        const target = issues.find(issue => url.endsWith(`/issues/${issue.number}`))
        if (target === undefined) return new Response('missing', {status: 404})
        target.state = parsed.state
        target.body = parsed.body
        return Response.json(target)
      }
      throw new Error(`unexpected ${method} ${url}`)
    })

    const writes = () =>
      recorded.filter(request => request.method !== 'GET' && new URL(request.url).hostname === 'api.github.com')
    const issueFor = (label: string) => issues.find(issue => issue.labels.some(candidate => candidate.name === label))
    return {issues, recorded, discord, writes, issueFor}
  }

  function liveEnvironment(): void {
    process.env.CLIPROXY_API_KEY = SECRET_KEY
    process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK = 'https://discord.example/webhook'
    process.env.GITHUB_TOKEN = 'github-token'
    process.env.GITHUB_REPOSITORY = 'owner/repo'
    process.env.GITHUB_ACTOR = 'owner'
    process.env.GITHUB_REPOSITORY_OWNER = 'owner'
    delete process.env.CLIPROXY_URL
  }

  const goLines = (stdout: string[]) => stdout.filter(line => line.startsWith('CLIProxy Go monitor probe:'))
  const claudeLines = (stdout: string[]) => stdout.filter(line => line.startsWith('CLIProxy auth monitor probe:'))
  const goSummaries = (stdout: string[]) => stdout.filter(line => line.startsWith('CLIProxy Go monitor summary:'))

  const openIssue = (label: string, marker: string, extra = ''): WorldIssue => ({
    number: label === GO_LABEL ? 7 : 5,
    state: 'open',
    title: 'x',
    body: `${marker}${extra}`,
    labels: [{name: label}],
  })

  beforeEach(() => {
    for (const name of ENV_KEYS) originalEnv[name] = process.env[name]
    liveEnvironment()
  })

  afterEach(() => {
    for (const name of ENV_KEYS) {
      const original = originalEnv[name]
      if (original === undefined) delete process.env[name]
      else process.env[name] = original
    }
    globalThis.fetch = originalFetch
  })

  it('prints both probe lines in one run and touches neither issue when both routes are healthy', async () => {
    const world = installWorld()
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(claudeLines(captured.stdout)).toEqual([
      expect.stringMatching(/^CLIProxy auth monitor probe: probe=healthy reason=ok at \S+$/),
    ])
    expect(goLines(captured.stdout)).toEqual([
      expect.stringMatching(/^CLIProxy Go monitor probe: probe=healthy reason=ok at \S+$/),
    ])
    expect(goSummaries(captured.stdout)).toEqual([
      expect.stringMatching(
        /^CLIProxy Go monitor summary: probe=healthy reason=ok transition=none issue=none discord=none at \S+$/,
      ),
    ])
    expect(world.writes()).toHaveLength(0)
    expect(captured.exit).toBeNull()
  })

  it('prints both probe lines before reconciling, with one timestamp, and keeps the Claude lines as they were', async () => {
    installWorld()
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    const claudeAt = /ok at (\S+)$/.exec(claudeLines(captured.stdout)[0] ?? '')?.[1]
    const goAt = /ok at (\S+)$/.exec(goLines(captured.stdout)[0] ?? '')?.[1]
    expect(claudeAt).toBeDefined()
    expect(goAt).toBe(claudeAt)
    const firstSummary = captured.stdout.findIndex(line => line.includes('monitor summary:'))
    expect(captured.stdout.findIndex(line => line.startsWith('CLIProxy Go monitor probe:'))).toBeLessThan(firstSummary)
    expect(captured.stdout.filter(line => line.startsWith('CLIProxy auth monitor summary:'))).toHaveLength(1)
  })

  describe.each([
    {
      reason: 'provider-missing',
      label: 'an empty Go list',
      options: {models: () => Response.json({data: [{id: 'claude-sonnet-4-6', owned_by: 'anthropic'}]})},
    },
    {
      reason: 'provider-missing',
      label: 'a model_not_found 400',
      options: {
        go: () =>
          new Response('{"error":{"message":"unknown provider for model glm-5.3","code":"model_not_found"}}', {
            status: 400,
          }),
      },
    },
    {
      reason: 'privacy-noncompliant',
      label: 'an exposed model outside the snapshot',
      options: {models: () => goModels(['glm-5.3', 'brand-new-model'])},
    },
    {
      reason: 'privacy-noncompliant',
      label: 'an exposed model that trains on data',
      options: {models: () => goModels(['glm-5.3', 'iceman-contributor-free'])},
    },
    {
      reason: 'billing-not-go',
      label: 'a 2xx with no billing_source',
      options: {go: () => Response.json({usage: {opencode: {}}})},
    },
    {reason: 'quota-or-billing', label: 'a 429', options: {go: () => new Response('limit', {status: 429})}},
    {reason: 'quota-or-billing', label: 'a 402', options: {go: () => new Response('balance', {status: 402})}},
    {reason: 'auth-401', label: 'a 401', options: {go: () => new Response('nope', {status: 401})}},
    {
      reason: 'auth-unavailable-503',
      label: 'a 503 auth_unavailable',
      options: {go: () => new Response('auth_unavailable', {status: 503})},
    },
  ] satisfies {reason: string; label: string; options: WorldOptions}[])(
    'a dead Go route: $label',
    ({reason, options}) => {
      it(`opens only the Go issue and sends one Go Discord alert (reason ${reason})`, async () => {
        const world = installWorld(options)
        const {ctx, captured} = createCapturedCtx()

        await runMonitor({validation: 'live'}, ctx)

        expect(goLines(captured.stdout)).toEqual([
          expect.stringMatching(
            new RegExp(String.raw`^CLIProxy Go monitor probe: probe=dead reason=${reason} at \S+$`),
          ),
        ])
        expect(claudeLines(captured.stdout)[0]).toContain('probe=healthy reason=ok')
        const goIssue = world.issueFor(GO_LABEL)
        expect(goIssue).toMatchObject({title: 'CLIProxy OpenCode Go route outage', state: 'open'})
        expect(goIssue?.body).toContain(GO_MARKER)
        expect(goIssue?.body).toContain(`Reason: ${reason}.`)
        expect(goIssue?.body).toContain('<!-- cliproxy-go-monitor:notified=dead -->')
        expect(world.issueFor(CLAUDE_LABEL)).toBeUndefined()
        expect(world.discord).toHaveLength(1)
        expect(world.discord[0]).toContain('OpenCode Go route is unavailable')
        expect(world.discord[0]).toContain(`reason: ${reason}`)
        expect(world.discord[0]).not.toContain('Anthropic')
        expect(goSummaries(captured.stdout)[0]).toContain('transition=outage issue=created discord=outage-sent')
        expect(captured.exit).toBeNull()
      })
    },
  )

  it('leaves the Claude issue exactly as it was while the Go route is dead', async () => {
    const claudeIssue = openIssue(CLAUDE_LABEL, CLAUDE_MARKER, '\n<!-- cliproxy-auth-monitor:notified=dead -->')
    const before = {...claudeIssue}
    // An unknown Claude result changes nothing, so any write to the Claude issue would come from the Go route.
    const world = installWorld({
      issues: [claudeIssue],
      claude: () => new Response('teapot', {status: 418}),
      go: () => new Response('limit', {status: 429}),
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(claudeIssue).toEqual(before)
    expect(world.issueFor(GO_LABEL)).toBeDefined()
    expect(world.writes().every(request => !request.url.endsWith(`/issues/${claudeIssue.number}`))).toBe(true)
  })

  it('opens the Go issue and alerts when a 400 MissingSessionID shows the proxy dropped the session header', async () => {
    const world = installWorld({go: () => new Response('{"type":"MissingSessionID"}', {status: 400})})
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(goLines(captured.stdout)[0]).toMatch(/probe=dead reason=session-header-dropped at /)
    expect(goSummaries(captured.stdout)[0]).toContain('transition=outage issue=created discord=outage-sent')
    expect(world.issueFor(GO_LABEL)?.body).toContain('the proxy stopped forwarding the session header')
    expect(world.issueFor(CLAUDE_LABEL)).toBeUndefined()
    expect(world.discord).toHaveLength(1)
    expect(world.discord[0]).toContain('reason: session-header-dropped')
    expect(world.discord[0]).toContain('the proxy stopped forwarding the session header')
    expect(captured.exit).toBeNull()
  })

  describe('the Go credits fallback (a 2xx billed to a present non-go source)', () => {
    const fallback = () => Response.json({usage: {opencode: {billing_source: 'balance', list_cost: '0.00006'}}})
    const billingLines = (stdout: string[]) => stdout.filter(line => line.startsWith('CLIProxy Go monitor billing:'))

    it('opens no issue, sends no Discord and writes nothing', async () => {
      const world = installWorld({go: fallback})
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx)

      expect(goLines(captured.stdout)).toEqual([
        expect.stringMatching(/^CLIProxy Go monitor probe: probe=unknown reason=billing-fallback at \S+$/),
      ])
      expect(goSummaries(captured.stdout)[0]).toContain('transition=none issue=none discord=none')
      expect(world.writes()).toHaveLength(0)
      expect(world.discord).toHaveLength(0)
      expect(world.issueFor(GO_LABEL)).toBeUndefined()
      expect(captured.exit).toBeNull()
    })

    it('leaves an open Go outage issue untouched', async () => {
      const goIssue = openIssue(GO_LABEL, GO_MARKER, '\n<!-- cliproxy-go-monitor:notified=dead -->')
      const before = {...goIssue}
      const world = installWorld({issues: [goIssue], go: fallback})
      const {ctx} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx)

      expect(goIssue).toEqual(before)
      expect(world.writes()).toHaveLength(0)
      expect(world.discord).toHaveLength(0)
    })

    it('prints a separate billing line right after the Go probe line, leaving the probe line strict', async () => {
      installWorld({go: fallback})
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx)

      expect(billingLines(captured.stdout)).toEqual(['CLIProxy Go monitor billing: billing_source=balance'])
      const probeIndex = captured.stdout.findIndex(line => line.startsWith('CLIProxy Go monitor probe:'))
      expect(captured.stdout[probeIndex + 1]).toBe('CLIProxy Go monitor billing: billing_source=balance')
      expect(goLines(captured.stdout)).toHaveLength(1)
    })

    it('prints the billing line for a healthy go route and a bounded token for a weird value', async () => {
      installWorld()
      const healthy = createCapturedCtx()
      await runMonitor({validation: 'live'}, healthy.ctx)
      expect(billingLines(healthy.captured.stdout)).toEqual(['CLIProxy Go monitor billing: billing_source=go'])

      installWorld({go: () => Response.json({usage: {opencode: {billing_source: 'a b HOSTILE_BODY'}}})})
      const weird = createCapturedCtx()
      await runMonitor({validation: 'live'}, weird.ctx)
      expect(billingLines(weird.captured.stdout)).toEqual(['CLIProxy Go monitor billing: billing_source=other'])
      expect(weird.captured.stdout.join('\n')).not.toContain('HOSTILE_BODY')
    })

    it('prints no billing line without an observed billing_source', async () => {
      for (const go of [
        () => Response.json({usage: {opencode: {}}}),
        () => new Response('limit', {status: 429}),
        () => new Response('teapot', {status: 418}),
      ]) {
        installWorld({go})
        const {ctx, captured} = createCapturedCtx()
        await runMonitor({validation: 'live'}, ctx)
        expect(billingLines(captured.stdout)).toHaveLength(0)
      }
    })
  })

  it('keeps an unknown Go result silent when no Go issue exists', async () => {
    const world = installWorld({go: () => new Response('teapot', {status: 418})})
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(goLines(captured.stdout)[0]).toMatch(/probe=unknown reason=unrelated-http at /)
    expect(world.writes()).toHaveLength(0)
    expect(captured.exit).toBeNull()
  })

  it('does not repeat the Discord alert while a Go outage stays open', async () => {
    const goIssue = openIssue(GO_LABEL, GO_MARKER, '\n<!-- cliproxy-go-monitor:notified=dead -->')
    const world = installWorld({issues: [goIssue], go: () => new Response('limit', {status: 429})})
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(world.discord).toHaveLength(0)
    expect(goSummaries(captured.stdout)[0]).toContain('transition=none issue=updated discord=none')
    expect(goIssue.state).toBe('open')
  })

  it('closes the Go issue and sends a Go recovery after quota-or-billing clears', async () => {
    const goIssue = openIssue(
      GO_LABEL,
      GO_MARKER,
      '\nReason: quota-or-billing.\n<!-- cliproxy-go-monitor:notified=dead -->',
    )
    const world = installWorld({issues: [goIssue]})
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(goIssue.state).toBe('closed')
    expect(goIssue.body).toContain('<!-- cliproxy-go-monitor:notified=healthy -->')
    expect(world.discord).toHaveLength(1)
    expect(world.discord[0]).toContain('OpenCode Go route recovered')
    expect(goSummaries(captured.stdout)[0]).toContain('transition=recovery issue=closed discord=recovery-sent')
  })

  it('reconciles the routes independently: Claude dead and Go healthy', async () => {
    const world = installWorld({claude: () => new Response('Unauthorized', {status: 401})})
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(world.issueFor(CLAUDE_LABEL)).toMatchObject({title: 'CLIProxy Anthropic authentication outage'})
    expect(world.issueFor(GO_LABEL)).toBeUndefined()
    expect(world.discord).toHaveLength(1)
    expect(world.discord[0]).toContain('Anthropic')
    expect(claudeLines(captured.stdout)[0]).toContain('probe=dead reason=auth-401')
    expect(goLines(captured.stdout)[0]).toContain('probe=healthy reason=ok')
  })

  it('opens both issues with two alerts when both routes are dead', async () => {
    const world = installWorld({
      claude: () => new Response('Unauthorized', {status: 401}),
      go: () => new Response('limit', {status: 429}),
    })
    const {ctx} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    expect(world.issueFor(CLAUDE_LABEL)).toBeDefined()
    expect(world.issueFor(GO_LABEL)).toBeDefined()
    expect(world.discord).toHaveLength(2)
  })

  it('still reconciles Go, and exits 1, when the Claude reconciliation fails', async () => {
    const world = installWorld({
      claude: () => new Response('Unauthorized', {status: 401}),
      go: () => new Response('limit', {status: 429}),
      failWritesFor: CLAUDE_MARKER,
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(world.issueFor(GO_LABEL)).toBeDefined()
    expect(world.discord.some(text => text.includes('OpenCode Go route is unavailable'))).toBe(true)
    expect(captured.exit?.code).toBe(1)
    expect(captured.stderr.join('\n')).toContain('CLIProxy auth monitor failed: reconciliation')
    expect(goSummaries(captured.stdout)).toHaveLength(1)
  })

  it('still reconciles Claude, and exits 1, when the Go reconciliation fails', async () => {
    const world = installWorld({
      claude: () => new Response('Unauthorized', {status: 401}),
      go: () => new Response('limit', {status: 429}),
      failWritesFor: GO_MARKER,
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(world.issueFor(CLAUDE_LABEL)).toBeDefined()
    expect(world.discord.some(text => text.includes('Anthropic'))).toBe(true)
    expect(captured.exit?.code).toBe(1)
    expect(captured.stderr.join('\n')).toContain('CLIProxy Go monitor failed: reconciliation')
    expect(captured.stderr.join('\n')).not.toContain('CLIProxy auth monitor failed')
    expect(claudeLines(captured.stdout)).toHaveLength(1)
    expect(goLines(captured.stdout)).toHaveLength(1)
  })

  it('reports both failures in one run when both reconciliations fail', async () => {
    installWorld({
      claude: () => new Response('Unauthorized', {status: 401}),
      go: () => new Response('limit', {status: 429}),
      failWritesFor: '<!-- cliproxy-',
    })
    const {ctx, captured} = createCapturedCtx()

    await expect(runMonitor({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('\n')).toContain('CLIProxy auth monitor failed: reconciliation')
    expect(captured.stderr.join('\n')).toContain('CLIProxy Go monitor failed: reconciliation')
    expect(captured.exit?.code).toBe(1)
  })

  it('sends a fresh non-empty x-opencode-session on every Go request, and none on the Claude probe', async () => {
    const first = installWorld()
    await runMonitor({validation: 'live'}, createCapturedCtx().ctx)
    const second = installWorld()
    await runMonitor({validation: 'live'}, createCapturedCtx().ctx)

    const goChat = (recorded: Recorded[]) =>
      recorded.filter(
        request => request.url.endsWith('/v1/chat/completions') && !(request.body ?? '').includes('claude-'),
      )
    const sessions = [...goChat(first.recorded), ...goChat(second.recorded)].map(request => request.session)
    expect(sessions).toHaveLength(2)
    for (const session of sessions) expect(session).toMatch(/^infra-monitor-[\da-f-]{36}$/)
    expect(new Set(sessions).size).toBe(2)
    const claudeChat = first.recorded.filter(
      request => request.url.endsWith('/v1/chat/completions') && (request.body ?? '').includes('claude-'),
    )
    expect(claudeChat.every(request => request.session === null)).toBe(true)
  })

  it('never prints the key, the session, usage, cost, or a response body', async () => {
    installWorld({
      go: () =>
        Response.json({
          usage: {opencode: {list_cost: '0.00006', allowance: {remaining: 41}}},
          hostile: 'HOSTILE_BODY',
        }),
    })
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'live'}, ctx)

    const output = [...captured.stdout, ...captured.stderr].join('\n')
    for (const needle of [SECRET_KEY, 'infra-monitor-', 'list_cost', '0.00006', 'allowance', 'HOSTILE_BODY']) {
      expect(output).not.toContain(needle)
    }
    expect(goLines(captured.stdout)[0]).toContain('reason=billing-not-go')
  })

  it('does not probe the Go route in the synthetic modes', async () => {
    const world = installWorld()
    process.env.GITHUB_ACTOR = 'owner'
    const {ctx, captured} = createCapturedCtx()

    await runMonitor({validation: 'synthetic-healthy'}, ctx)

    expect(world.recorded.some(request => request.url.includes('/v1/'))).toBe(false)
    expect(goLines(captured.stdout)).toHaveLength(0)
  })

  describe('when the tracked settings turn the Go route off', () => {
    const disabled = {enabled: false, defaultProbeModel: 'glm-5.3'}
    const isGoRequest = (request: Recorded): boolean =>
      request.url.endsWith('/v1/models') ||
      (request.url.endsWith('/v1/chat/completions') && !(request.body ?? '').includes('claude-'))

    it('makes no Go request, prints no Go line or summary, and leaves the Go issue and Discord alone', async () => {
      const goIssue = openIssue(GO_LABEL, GO_MARKER, '\n<!-- cliproxy-go-monitor:notified=dead -->')
      const before = {...goIssue}
      // Everything Go would see is dead, so any probe or write would show up as a Go line, issue change or alert.
      const world = installWorld({
        issues: [goIssue],
        models: () => Response.json({data: []}),
        go: () => new Response('limit', {status: 429}),
      })
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx, undefined, disabled)

      expect(world.recorded.filter(isGoRequest)).toHaveLength(0)
      expect(goLines(captured.stdout)).toHaveLength(0)
      expect(goSummaries(captured.stdout)).toHaveLength(0)
      expect(goIssue).toEqual(before)
      expect(world.writes()).toHaveLength(0)
      expect(world.discord).toHaveLength(0)
      expect(claudeLines(captured.stdout)).toHaveLength(1)
      expect(captured.exit).toBeNull()
    })

    it('still reconciles the Claude route, and only the Claude route', async () => {
      const goIssue = openIssue(GO_LABEL, GO_MARKER, '\n<!-- cliproxy-go-monitor:notified=dead -->')
      const before = {...goIssue}
      const world = installWorld({issues: [goIssue], claude: () => new Response('Unauthorized', {status: 401})})
      const {ctx} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx, undefined, disabled)

      expect(world.issueFor(CLAUDE_LABEL)).toBeDefined()
      expect(world.discord).toHaveLength(1)
      expect(world.discord[0]).toContain('Anthropic')
      expect(goIssue).toEqual(before)
    })

    it('probes Go again once the setting is true', async () => {
      const world = installWorld()
      const {ctx, captured} = createCapturedCtx()

      await runMonitor({validation: 'live'}, ctx, undefined, {enabled: true})

      expect(world.recorded.some(isGoRequest)).toBe(true)
      expect(goLines(captured.stdout)).toHaveLength(1)
    })
  })
})
