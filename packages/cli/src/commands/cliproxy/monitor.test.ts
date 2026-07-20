import {afterEach, describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {cliproxyMonitorAction, registerCliproxyMonitor} from './monitor'

const originalFetch = globalThis.fetch

function installFetch(handler: (input: string | URL | Request, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = Object.assign(handler, {preconnect: originalFetch.preconnect})
}

function configureSyntheticEnvironment(): void {
  process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK = 'https://discord.example/webhook'
  process.env.GITHUB_TOKEN = 'github-token'
  process.env.GITHUB_REPOSITORY = 'owner/repo'
  process.env.GITHUB_ACTOR = 'owner'
  process.env.GITHUB_REPOSITORY_OWNER = 'owner'
  delete process.env.CLIPROXY_URL
}

describe('cliproxy monitor', () => {
  afterEach(() => {
    for (const name of [
      'CLIPROXY_API_KEY',
      'CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK',
      'GITHUB_TOKEN',
      'GITHUB_REPOSITORY',
      'GITHUB_ACTOR',
      'GITHUB_REPOSITORY_OWNER',
    ]) {
      delete process.env[name]
    }
    delete process.env.CLIPROXY_URL
    globalThis.fetch = originalFetch
  })

  it('fails through ActionCtx when required monitor inputs are missing', async () => {
    const {ctx, captured} = createCapturedCtx()

    await expect(cliproxyMonitorAction({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)
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

    await expect(cliproxyMonitorAction({validation: 'live'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

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

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain('/issues?state=all')
    expect(requests.some(request => request.method !== 'GET')).toBe(false)
    expect(captured.exit).toBeNull()
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=none issue=none discord=none at \S+/,
    )
    expect(captured.stdout.filter(line => line.includes('CLIProxy auth monitor summary:'))).toHaveLength(1)
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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(1)
    expect(requests.some(request => request.method === 'POST' && request.url.endsWith('/labels'))).toBe(true)
    expect(requests.some(request => request.method === 'POST' && request.url.endsWith('/issues'))).toBe(true)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(requests.filter(request => request.url === 'https://discord.example/webhook')).toHaveLength(1)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(2)
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

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(1)
    expect(requests.filter(request => request.method === 'PATCH')).toHaveLength(1)
    expect(captured.stdout.join('\n')).toMatch(
      /CLIProxy auth monitor summary: probe=healthy reason=ok transition=notification-retry issue=none discord=recovery-sent at \S+/,
    )
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

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)

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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.endsWith('/issues/201'))).toBe(true)
    expect(requests.some(request => request.endsWith('/issues/202'))).toBe(false)
    expect(requests.some(request => request.endsWith('/issues'))).toBe(false)
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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(requests.some(request => request.endsWith('/issues/215'))).toBe(true)
    expect(requests.some(request => request.endsWith('/issues/216'))).toBe(false)
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

      await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

      expect(discordAttempts).toBe(1)
    }
  })

  it('reports missing synthetic inputs separately from synthetic authorization failure', async () => {
    configureSyntheticEnvironment()
    delete process.env.CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK
    const {ctx, captured} = createCapturedCtx()

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('')).toContain('invalid-inputs')
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

    await expect(cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(requestCount).toBe(0)
    expect(captured.stderr.join('')).toContain('invalid-inputs')
  })

  it('retries Discord 429 and honors a bounded Retry-After delay', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const delays: number[] = []
    const originalSetTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((callback: (...args: never[]) => void, delay?: number) => {
      delays.push(delay ?? 0)
      callback()
      return 0 as unknown as ReturnType<typeof setTimeout>
    }) as unknown as typeof setTimeout
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

    try {
      await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)
    } finally {
      globalThis.setTimeout = originalSetTimeout
    }

    expect(discordAttempts).toBe(2)
    expect(delays).toEqual([1000])
  })

  it('ignores a label-only issue and creates the canonical marked issue', async () => {
    configureSyntheticEnvironment()
    const issueCreates: string[] = []
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
      if (method === 'GET' && url.includes('/labels/')) return new Response('missing', {status: 404})
      if (method === 'POST' && url.endsWith('/labels')) return new Response('{}', {status: 201})
      if (method === 'POST' && url.endsWith('/issues')) {
        issueCreates.push(typeof init?.body === 'string' ? init.body : '')
        return new Response(JSON.stringify({number: 206, state: 'open', body: issueCreates[0], labels: []}), {
          status: 201,
        })
      }
      if (method === 'PATCH' && url.endsWith('/issues/206')) return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(issueCreates).toHaveLength(1)
    expect(issueCreates[0]).toContain('cliproxy-auth-monitor-test:v1')
  })

  it('restores the required label when a canonical marker issue loses its label', async () => {
    configureSyntheticEnvironment()
    let labelRestores = 0
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
      if (url.endsWith('/issues/214/labels') && method === 'POST') {
        labelRestores++
        return new Response('{}', {status: 200})
      }
      if (url.endsWith('/issues/214') && method === 'PATCH') return new Response('{}', {status: 200})
      throw new Error(`unexpected ${method} ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(labelRestores).toBe(1)
  })

  it('fails safely on multiple marker-only issues before any mutation', async () => {
    configureSyntheticEnvironment()
    const requests: string[] = []
    installFetch(async (input, init) => {
      const url = String(input)
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
      throw new Error(`unexpected ${url}`)
    })
    const {ctx} = createCapturedCtx()

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(requests).toHaveLength(1)
  })

  it('closes an open dead issue, sends recovery, then persists healthy state', async () => {
    configureSyntheticEnvironment()
    let discordAttempts = 0
    const patchBodies: string[] = []
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
        return new Response('{}', {status: 200})
      }
      throw new Error(`unexpected ${init?.method ?? 'GET'} ${url}`)
    })
    const {ctx, captured} = createCapturedCtx()

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)

    expect(discordAttempts).toBe(1)
    expect(patchBodies).toHaveLength(2)
    expect(patchBodies[0]).toContain('"state":"closed"')
    expect(patchBodies[1]).toContain('notified=healthy')
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

    await cliproxyMonitorAction({validation: 'synthetic-healthy'}, ctx)

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

    await cliproxyMonitorAction({validation: 'live'}, ctx)

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

    await cliproxyMonitorAction({validation: 'live'}, ctx)

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

    await cliproxyMonitorAction({validation: 'live'}, ctx)

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

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

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

    await cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)

    expect(discordAttempts).toBe(2)
    expect(discordBodies.every(body => body.includes('"allowed_mentions":{"parse":[]}'))).toBe(true)
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

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

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

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(discordAttempts).toBe(1)
    expect(patchAttempts).toBe(2)
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

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

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

    await expect(cliproxyMonitorAction({validation: 'synthetic-dead'}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

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
