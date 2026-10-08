/// <reference types="bun" />

/**
 * Behavior contract for the repo-local deploy-gate Discord notifier.
 *
 * `fetch` is mocked at the boundary and `sleep` is recorded, so no test performs
 * a live network call or waits in real time. Subprocess tests only cover the
 * paths that never reach the network.
 */

import type {FetchLike, NotifyEnv, NotifyIo} from './deploy-gate-notify'
import {mkdtempSync, readFileSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {describe, expect, it} from 'bun:test'
import {
  buildGateMessage,
  DISCORD_CONTENT_LIMIT,
  escapeDiscordText,
  MAX_RETRY_AFTER_MS,
  NETWORK_RETRY_DELAY_MS,
  readNotifyEnv,
  runDeployGateNotify,
  sendDiscordMessage,
  summaryLine,
  SUPPRESS_EMBEDS_FLAG,
} from './deploy-gate-notify'

// ─── Fixtures ────────────────────────────────────────────────────────────────

const WEBHOOK = 'https://discord.example/api/webhooks/1234567890/SECRET-token_value'
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'
const ZWSP = '\u200B'

function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    DEPLOY_GATE_DISCORD_WEBHOOK: WEBHOOK,
    DEPLOY_GATE_APP: 'umami',
    GITHUB_EVENT_NAME: 'push',
    GITHUB_ACTOR: 'marcusrbrown',
    GITHUB_REF_NAME: 'main',
    GITHUB_SHA: SHA,
    DEPLOY_GATE_COMMIT_SUBJECT: 'chore(deps): bump umami image',
    GITHUB_REPOSITORY: 'marcusrbrown/infra',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_RUN_ID: '9876543210',
    ...overrides,
  }
}

function parsedEnv(overrides: Record<string, string | undefined> = {}): NotifyEnv {
  return readNotifyEnv(baseEnv(overrides))
}

interface Captured {
  readonly io: NotifyIo
  readonly stdout: string[]
  readonly warnings: string[]
  readonly summary: string[]
  all: () => string
}

function makeIo(): Captured {
  const stdout: string[] = []
  const warnings: string[] = []
  const summary: string[] = []
  return {
    io: {
      stdout: line => stdout.push(line),
      warn: message => warnings.push(message),
      appendSummary: line => summary.push(line),
    },
    stdout,
    warnings,
    summary,
    all: () => [...stdout, ...warnings, ...summary].join('\n'),
  }
}

interface RecordedCall {
  url: string
  init: RequestInit
}

function recordingFetch(responder: (call: number, signal: AbortSignal | undefined) => Promise<Response> | Response): {
  fetch: FetchLike
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetchImpl: FetchLike = async (input, init) => {
    calls.push({url: String(input), init: init ?? {}})
    return responder(calls.length, init?.signal ?? undefined)
  }
  return {fetch: fetchImpl, calls}
}

function recordingSleep(): {sleep: (ms: number) => Promise<void>; delays: number[]} {
  const delays: number[] = []
  return {
    sleep: async ms => {
      delays.push(ms)
    },
    delays,
  }
}

interface PostedBody {
  content: string
  allowed_mentions: {parse: string[]}
  flags: number
}

function bodyOf(call: RecordedCall): PostedBody {
  return JSON.parse(String(call.init.body)) as PostedBody
}

// ─── Message content ─────────────────────────────────────────────────────────

describe('buildGateMessage', () => {
  it('push: names app, trigger, subject, 7-char SHA, and run URL', () => {
    const content = buildGateMessage(parsedEnv())
    expect(content).toContain('umami')
    expect(content).toContain('push')
    expect(content).toContain('main')
    expect(content).toContain('chore(deps): bump umami image')
    expect(content).toContain('a1b2c3d')
    expect(content).not.toContain('a1b2c3d4')
    expect(content).toContain('https://github.com/marcusrbrown/infra/actions/runs/9876543210')
  })

  it('push: falls back to a neutral placeholder when the subject is empty', () => {
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: ''}))
    expect(content).toContain('commit subject unavailable')
    expect(content).toContain('a1b2c3d')
  })

  it('push: uses only the first line of a full commit message (body and trailers never leak)', () => {
    const message = [
      'feat(umami): bump image',
      '',
      'Body paragraph with secret-ish detail @everyone.',
      '',
      'Co-authored-by: Someone <someone@example.com>',
    ].join('\n')
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: message}))
    expect(content).toContain('feat(umami): bump image')
    expect(content).not.toContain('Body paragraph')
    expect(content).not.toContain('Co-authored-by')
    expect(content).not.toContain('someone@example.com')
    expect(content).toContain('(a1b2c3d)')
  })

  it('push: handles a CRLF commit message', () => {
    const content = buildGateMessage(
      parsedEnv({
        DEPLOY_GATE_COMMIT_SUBJECT: 'fix: crlf subject\r\n\r\nbody line\r\nSigned-off-by: A <a@example.com>\r\n',
      }),
    )
    expect(content).toContain('fix: crlf subject')
    expect(content).not.toContain('body line')
    expect(content).not.toContain('Signed-off-by')
    expect(content).not.toContain('\r')
  })

  it('push: an empty first line falls back to the placeholder instead of promoting the body', () => {
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: '\nbody that must not appear\n'}))
    expect(content).toContain('commit subject unavailable')
    expect(content).not.toContain('body that must not appear')
  })

  it('dashboard dispatch: names version and short digest, not the commit subject', () => {
    const digest = `sha256:${'abcdef0123456789'.repeat(4)}`
    const content = buildGateMessage(
      parsedEnv({
        DEPLOY_GATE_APP: 'dashboard',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        DEPLOY_GATE_DASHBOARD_VERSION: 'v1.2.3',
        DEPLOY_GATE_DASHBOARD_DIGEST: digest,
      }),
    )
    expect(content).toContain('dashboard')
    expect(content).toContain('v1.2.3')
    expect(content).toContain('sha256:abcdef012345')
    expect(content).not.toContain(digest)
    expect(content).not.toContain('chore(deps)')
    expect(content).toContain('marcusrbrown')
    expect(content).toContain('/actions/runs/9876543210')
  })

  it('dashboard dispatch without a digest says so', () => {
    const content = buildGateMessage(
      parsedEnv({
        DEPLOY_GATE_APP: 'dashboard',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        DEPLOY_GATE_DASHBOARD_VERSION: 'v1.2.3',
        DEPLOY_GATE_DASHBOARD_DIGEST: '',
      }),
    )
    expect(content).toContain('v1.2.3')
    expect(content).toContain('digest not provided')
  })

  it('non-dashboard dispatch: names ref, short SHA, and the dispatching actor', () => {
    const content = buildGateMessage(
      parsedEnv({GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF_NAME: 'main', GITHUB_ACTOR: 'octo-dispatcher'}),
    )
    expect(content).toContain('main')
    expect(content).toContain('a1b2c3d')
    expect(content).toContain('octo-dispatcher')
    expect(content).not.toContain('chore(deps)')
  })

  it('push ignores a stray dashboard version', () => {
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_DASHBOARD_VERSION: 'v9.9.9'}))
    expect(content).not.toContain('v9.9.9')
    expect(content).toContain('chore(deps): bump umami image')
  })

  it('renders hostile commit text inert', () => {
    const subject = '@everyone @here <@&1234> <@5678> <#999> `code` **bold** [run](https://evil.example) > quote # head'
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: subject}))
    expect(content).not.toContain('@everyone')
    expect(content).not.toContain('@here')
    expect(content).not.toContain('<@')
    expect(content).not.toContain('<#')
    expect(content).not.toContain('<@&1234>')
    expect(content).not.toContain('**bold**')
    expect(content).not.toContain('](')
    expect(content).not.toMatch(/(?<!\\)`/)
    expect(content).toContain(`@${ZWSP}everyone`)
    expect(content).toContain(String.raw`<${ZWSP}@${ZWSP}&1234\>`)
  })

  it('bounds a 3000-character subject under the Discord limit and ellipsizes it', () => {
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: 'x'.repeat(3000)}))
    expect(content.length).toBeLessThan(DISCORD_CONTENT_LIMIT)
    expect(content).toContain('…')
    expect(content).toContain('/actions/runs/9876543210')
  })

  it('bounds a subject whose escaping doubles its length', () => {
    const content = buildGateMessage(parsedEnv({DEPLOY_GATE_COMMIT_SUBJECT: '*'.repeat(3000)}))
    expect(content.length).toBeLessThan(DISCORD_CONTENT_LIMIT)
    expect(content).toContain('…')
  })

  it('bounds hostile oversized non-subject fields too', () => {
    const content = buildGateMessage(
      parsedEnv({
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_REF_NAME: 'r'.repeat(5000),
        GITHUB_ACTOR: 'a'.repeat(5000),
      }),
    )
    expect(content.length).toBeLessThan(DISCORD_CONTENT_LIMIT)
  })
})

describe('escapeDiscordText', () => {
  it('escapes markdown metacharacters', () => {
    expect(escapeDiscordText('a\\b*c_d~e`f|g>h#i')).toBe('a\\\\b\\*c\\_d\\~e\\`f\\|g\\>h\\#i')
  })

  it('escapes a leading dash', () => {
    expect(escapeDiscordText('- item')).toBe(String.raw`\- item`)
    expect(escapeDiscordText('a - b')).toBe('a - b')
  })

  it('neutralizes mention syntax with zero-width spaces', () => {
    expect(escapeDiscordText('@everyone')).toBe(`@${ZWSP}everyone`)
    expect(escapeDiscordText('<@123>')).toBe(String.raw`<${ZWSP}@${ZWSP}123\>`)
  })

  it('breaks masked links', () => {
    const out = escapeDiscordText('[x](https://evil.example)')
    expect(out).not.toContain('](')
    expect(out).not.toMatch(/(?<!\\)\[/)
  })

  it('collapses newlines so text cannot start new markdown blocks', () => {
    expect(escapeDiscordText('one\n# two\r\nthree')).not.toContain('\n')
  })
})

describe('readNotifyEnv', () => {
  it('reads the documented environment variables', () => {
    const env = readNotifyEnv(
      baseEnv({DEPLOY_GATE_DASHBOARD_VERSION: 'v1', DEPLOY_GATE_DASHBOARD_DIGEST: 'sha256:abc'}),
    )
    expect(env.webhook).toBe(WEBHOOK)
    expect(env.app).toBe('umami')
    expect(env.eventName).toBe('push')
    expect(env.actor).toBe('marcusrbrown')
    expect(env.refName).toBe('main')
    expect(env.sha).toBe(SHA)
    expect(env.subject).toBe('chore(deps): bump umami image')
    expect(env.repository).toBe('marcusrbrown/infra')
    expect(env.serverUrl).toBe('https://github.com')
    expect(env.runId).toBe('9876543210')
    expect(env.dashboardVersion).toBe('v1')
    expect(env.dashboardDigest).toBe('sha256:abc')
  })

  it('treats missing, empty, and whitespace-only webhook as absent', () => {
    expect(readNotifyEnv(baseEnv({DEPLOY_GATE_DISCORD_WEBHOOK: undefined})).webhook).toBeNull()
    expect(readNotifyEnv(baseEnv({DEPLOY_GATE_DISCORD_WEBHOOK: ''})).webhook).toBeNull()
    expect(readNotifyEnv(baseEnv({DEPLOY_GATE_DISCORD_WEBHOOK: '   '})).webhook).toBeNull()
  })

  it('defaults the server URL', () => {
    expect(readNotifyEnv(baseEnv({GITHUB_SERVER_URL: undefined})).serverUrl).toBe('https://github.com')
  })
})

// ─── Sender ──────────────────────────────────────────────────────────────────

describe('sendDiscordMessage', () => {
  it('posts JSON once with mentions disabled', async () => {
    const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hello', fetch, sleep})
    expect(result).toEqual({outcome: 'sent', attempts: 1, status: 204, reason: null})
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(WEBHOOK)
    expect(calls[0]?.init.method).toBe('POST')
    expect(new Headers(calls[0]?.init.headers).get('content-type')).toBe('application/json')
    const body = bodyOf(calls[0] as RecordedCall)
    expect(body.content).toBe('hello')
    expect(body.allowed_mentions).toEqual({parse: []})
    expect(body.flags).toBe(4)
    expect(SUPPRESS_EMBEDS_FLAG).toBe(4)
    expect(Object.keys(body).sort()).toEqual(['allowed_mentions', 'content', 'flags'])
  })

  it('retries 429 once, honoring Retry-After, then succeeds', async () => {
    const {fetch, calls} = recordingFetch(call =>
      call === 1
        ? new Response('rate limited', {status: 429, headers: {'retry-after': '1'}})
        : new Response(null, {status: 204}),
    )
    const {sleep, delays} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'sent', attempts: 2, status: 204, reason: null})
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([1000])
  })

  it('caps an excessive Retry-After', async () => {
    const {fetch} = recordingFetch(call =>
      call === 1
        ? new Response('rate limited', {status: 429, headers: {'retry-after': '3600'}})
        : new Response(null, {status: 204}),
    )
    const {sleep, delays} = recordingSleep()
    await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(delays).toEqual([MAX_RETRY_AFTER_MS])
  })

  it.each([
    ['missing', undefined],
    ['malformed', 'soon'],
    ['empty', ''],
    ['zero', '0'],
    ['negative', '-5'],
    ['non-finite', 'Infinity'],
  ] as const)('falls back to the positive network retry delay when Retry-After is %s', async (_label, value) => {
    const {fetch} = recordingFetch(call =>
      call === 1
        ? new Response('rate limited', {status: 429, headers: value === undefined ? {} : {'retry-after': value}})
        : new Response(null, {status: 204}),
    )
    const {sleep, delays} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result.outcome).toBe('sent')
    expect(delays).toEqual([NETWORK_RETRY_DELAY_MS])
    expect(NETWORK_RETRY_DELAY_MS).toBeGreaterThan(0)
  })

  it('also falls back to the positive delay for a 5xx without a usable Retry-After', async () => {
    const {fetch} = recordingFetch(call =>
      call === 1 ? new Response('boom', {status: 503}) : new Response(null, {status: 204}),
    )
    const {sleep, delays} = recordingSleep()
    await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(delays).toEqual([NETWORK_RETRY_DELAY_MS])
  })

  it('gives up after three attempts on repeated 500s', async () => {
    const {fetch, calls} = recordingFetch(() => new Response('boom', {status: 500}))
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'failed', attempts: 3, status: 500, reason: 'http-500'})
    expect(calls).toHaveLength(3)
  })

  it('does not retry a revoked webhook (404)', async () => {
    const {fetch, calls} = recordingFetch(() => new Response('{"message":"Unknown Webhook"}', {status: 404}))
    const {sleep, delays} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'failed', attempts: 1, status: 404, reason: 'http-404'})
    expect(calls).toHaveLength(1)
    expect(delays).toEqual([])
  })

  it('does not retry other 4xx statuses', async () => {
    const {fetch, calls} = recordingFetch(() => new Response('bad', {status: 400}))
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result.attempts).toBe(1)
    expect(calls).toHaveLength(1)
  })

  it('times out every attempt and fails after three', async () => {
    let aborted = 0
    const {fetch, calls} = recordingFetch(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => {
            aborted++
            reject(new DOMException('aborted', 'AbortError'))
          })
        }),
    )
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep, timeoutMs: 5})
    expect(result).toEqual({outcome: 'failed', attempts: 3, status: null, reason: 'timeout'})
    expect(calls).toHaveLength(3)
    expect(aborted).toBe(3)
  })

  it('retries a network error and recovers', async () => {
    const {fetch, calls} = recordingFetch(call => {
      if (call === 1) throw new TypeError(`connect ECONNRESET ${WEBHOOK}`)
      return new Response(null, {status: 204})
    })
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'sent', attempts: 2, status: 204, reason: null})
    expect(calls).toHaveLength(2)
  })

  it('reports persistent network errors with a fixed reason that never carries error text', async () => {
    const {fetch} = recordingFetch(() => {
      throw new TypeError(`connect ECONNREFUSED ${WEBHOOK}`)
    })
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: WEBHOOK, content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'failed', attempts: 3, status: null, reason: 'network'})
    expect(JSON.stringify(result)).not.toContain(WEBHOOK)
  })

  it('refuses a non-https webhook without any request', async () => {
    const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: 'http://discord.example/hook', content: 'hi', fetch, sleep})
    expect(result).toEqual({outcome: 'failed', attempts: 0, status: null, reason: 'invalid-webhook'})
    expect(calls).toHaveLength(0)
  })

  it('refuses an unparseable webhook without any request', async () => {
    const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const result = await sendDiscordMessage({webhook: 'not a url', content: 'hi', fetch, sleep})
    expect(result.reason).toBe('invalid-webhook')
    expect(calls).toHaveLength(0)
  })
})

// ─── Orchestration (never throws, never leaks) ───────────────────────────────

describe('runDeployGateNotify', () => {
  it('push happy path: one POST, sent summary, no warning', async () => {
    const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {fetch, sleep, io: cap.io})
    expect(summary).toEqual({
      app: 'umami',
      event: 'push',
      outcome: 'sent',
      attempts: 1,
      status: 204,
      reason: null,
    })
    expect(calls).toHaveLength(1)
    const body = bodyOf(calls[0] as RecordedCall)
    expect(body.allowed_mentions.parse).toEqual([])
    expect(body.flags).toBe(4)
    expect(body.content).toContain('umami')
    expect(body.content).toContain('a1b2c3d')
    expect(cap.warnings).toEqual([])
    expect(cap.stdout).toEqual([summaryLine(summary)])
    expect(cap.summary).toHaveLength(1)
    expect(cap.summary[0]).toContain('umami')
    expect(cap.summary[0]).toContain('sent')
  })

  for (const webhook of [undefined, '', '   ']) {
    it(`skips without a request when the webhook is ${JSON.stringify(webhook)}`, async () => {
      const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
      const {sleep} = recordingSleep()
      const cap = makeIo()
      const summary = await runDeployGateNotify(baseEnv({DEPLOY_GATE_DISCORD_WEBHOOK: webhook}), {
        fetch,
        sleep,
        io: cap.io,
      })
      expect(calls).toHaveLength(0)
      expect(summary.outcome).toBe('skipped')
      expect(summary.attempts).toBe(0)
      expect(summary.reason).toBe('webhook-unset')
      expect(cap.warnings).toHaveLength(1)
      expect(cap.warnings[0]).toContain('skipped')
      expect(cap.stdout).toHaveLength(1)
      expect(cap.summary).toHaveLength(1)
    })
  }

  it('429 with Retry-After then 204: two attempts, honored delay, sent', async () => {
    const {fetch, calls} = recordingFetch(call =>
      call === 1 ? new Response('rl', {status: 429, headers: {'retry-after': '1'}}) : new Response(null, {status: 204}),
    )
    const {sleep, delays} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {fetch, sleep, io: cap.io})
    expect(summary.outcome).toBe('sent')
    expect(summary.attempts).toBe(2)
    expect(calls).toHaveLength(2)
    expect(delays).toEqual([1000])
    expect(cap.warnings).toEqual([])
  })

  it('500 three times: failed with a warning', async () => {
    const {fetch, calls} = recordingFetch(() => new Response('boom', {status: 500}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {fetch, sleep, io: cap.io})
    expect(calls).toHaveLength(3)
    expect(summary.outcome).toBe('failed')
    expect(summary.attempts).toBe(3)
    expect(summary.status).toBe(500)
    expect(cap.warnings).toHaveLength(1)
    expect(cap.warnings[0]).toContain('::warning::')
    expect(cap.warnings[0]).toContain('failed')
  })

  it('404 revoked webhook: one attempt, failed, warning', async () => {
    const {fetch, calls} = recordingFetch(() => new Response('gone', {status: 404}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {fetch, sleep, io: cap.io})
    expect(calls).toHaveLength(1)
    expect(summary).toMatchObject({outcome: 'failed', attempts: 1, status: 404, reason: 'http-404'})
    expect(cap.warnings).toHaveLength(1)
  })

  it('timeout on every attempt: three attempts, failed', async () => {
    const {fetch, calls} = recordingFetch(
      (_call, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
        }),
    )
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {fetch, sleep, io: cap.io, timeoutMs: 5})
    expect(calls).toHaveLength(3)
    expect(summary).toMatchObject({outcome: 'failed', attempts: 3, reason: 'timeout'})
    expect(cap.warnings).toHaveLength(1)
  })

  it('an exception while building the message is caught and reported', async () => {
    const {fetch, calls} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(baseEnv(), {
      fetch,
      sleep,
      io: cap.io,
      buildMessage: () => {
        throw new Error(`kaboom ${WEBHOOK}`)
      },
    })
    expect(calls).toHaveLength(0)
    expect(summary.outcome).toBe('failed')
    expect(summary.reason).toBe('internal-error')
    expect(cap.warnings).toHaveLength(1)
    expect(cap.all()).not.toContain('kaboom')
    expect(cap.all()).not.toContain(WEBHOOK)
  })

  it('an exception while reading the environment is caught', async () => {
    const hostile = new Proxy({} as Record<string, string | undefined>, {
      get() {
        throw new Error('env exploded')
      },
    })
    const {fetch} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    const summary = await runDeployGateNotify(hostile, {fetch, sleep, io: cap.io})
    expect(summary.outcome).toBe('failed')
    expect(summary.reason).toBe('internal-error')
    expect(cap.warnings).toHaveLength(1)
  })

  it('a throwing output sink never escapes', async () => {
    const {fetch} = recordingFetch(() => new Response(null, {status: 204}))
    const {sleep} = recordingSleep()
    const summary = await runDeployGateNotify(baseEnv(), {
      fetch,
      sleep,
      io: {
        stdout: () => {
          throw new Error('stdout closed')
        },
        warn: () => {
          throw new Error('stderr closed')
        },
        appendSummary: () => {
          throw new Error('disk full')
        },
      },
    })
    expect(summary.outcome).toBe('sent')
  })

  it('never emits the webhook, on any path', async () => {
    const scenarios: FetchLike[] = [
      async () => new Response(null, {status: 204}),
      async () => new Response(`echo ${WEBHOOK}`, {status: 404}),
      async () => new Response(`echo ${WEBHOOK}`, {status: 500}),
      async () => {
        throw new TypeError(`connect ECONNREFUSED ${WEBHOOK}`)
      },
    ]
    for (const scenario of scenarios) {
      const {sleep} = recordingSleep()
      const cap = makeIo()
      await runDeployGateNotify(baseEnv(), {fetch: scenario, sleep, io: cap.io})
      expect(cap.all()).not.toContain(WEBHOOK)
      expect(cap.all()).not.toContain('SECRET-token_value')
    }
  })

  it('never emits the message body in stdout, warnings, or step summary', async () => {
    const {fetch} = recordingFetch(() => new Response('boom', {status: 500}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    await runDeployGateNotify(baseEnv({DEPLOY_GATE_COMMIT_SUBJECT: 'private subject text'}), {
      fetch,
      sleep,
      io: cap.io,
    })
    expect(cap.all()).not.toContain('private subject text')
  })

  it('sanitizes workflow-command injection through the app name in warnings', async () => {
    const {fetch} = recordingFetch(() => new Response('boom', {status: 404}))
    const {sleep} = recordingSleep()
    const cap = makeIo()
    await runDeployGateNotify(baseEnv({DEPLOY_GATE_APP: 'umami\n::error::pwned'}), {fetch, sleep, io: cap.io})
    expect(cap.warnings[0]).not.toContain('\n')
    expect(cap.warnings[0]?.match(/::/g)).toHaveLength(2)
  })
})

// ─── Entry point (subprocess; no network paths) ──────────────────────────────

describe('entry point', () => {
  const scriptPath = join(import.meta.dir, 'deploy-gate-notify.ts')

  async function runScript(
    env: Record<string, string>,
  ): Promise<{code: number; stdout: string; stderr: string; summary: string}> {
    const dir = mkdtempSync(join(tmpdir(), 'deploy-gate-notify-'))
    const summaryFile = join(dir, 'summary.md')
    try {
      const proc = Bun.spawn(['bun', scriptPath], {
        env: {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GITHUB_STEP_SUMMARY: summaryFile, ...env},
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      let summary = ''
      try {
        summary = readFileSync(summaryFile, 'utf8')
      } catch {
        summary = ''
      }
      return {code, stdout, stderr, summary}
    } finally {
      rmSync(dir, {recursive: true, force: true})
    }
  }

  it('exits 0 with a skipped summary and warning when the webhook is unset', async () => {
    const result = await runScript({DEPLOY_GATE_APP: 'keeweb', GITHUB_EVENT_NAME: 'push'})
    expect(result.code).toBe(0)
    const lines = result.stdout.split('\n').filter(line => line.startsWith('{'))
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0] as string)).toMatchObject({app: 'keeweb', event: 'push', outcome: 'skipped'})
    expect(result.stdout).toContain('::warning::')
    expect(result.summary).toContain('keeweb')
  })

  it('exits 0 and never echoes a rejected webhook', async () => {
    const secret = 'http://discord.example/api/webhooks/1/SECRET-token_value'
    const result = await runScript({DEPLOY_GATE_DISCORD_WEBHOOK: secret, DEPLOY_GATE_APP: 'umami'})
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('"outcome":"failed"')
    expect(result.stdout).not.toContain('SECRET-token_value')
    expect(result.stderr).not.toContain('SECRET-token_value')
    expect(result.summary).not.toContain('SECRET-token_value')
  })
})
