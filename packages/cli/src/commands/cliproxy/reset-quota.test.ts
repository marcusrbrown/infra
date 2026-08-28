import {afterEach, describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx, expectCapturedToInclude} from '../../lib/mcp-ctx-fixture'
import {cliproxyResetQuotaAction, registerCliproxyResetQuota} from './reset-quota'

const originalFetch = globalThis.fetch

type FetchReplacement = (url: string, init?: RequestInit) => Promise<Response>

function createFetchImplementation(handler: FetchReplacement): typeof fetch {
  return Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      if (typeof input !== 'string') {
        throw new TypeError(`Unexpected non-string fetch input: ${String(input)}`)
      }

      return handler(input, init)
    },
    {preconnect: originalFetch.preconnect},
  )
}

describe('cliproxyResetQuotaAction', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('resets the requested auth record with the management key header', async () => {
    let requestUrl = ''
    let requestInit: RequestInit | undefined
    globalThis.fetch = createFetchImplementation(async (url, init) => {
      requestUrl = url
      requestInit = init
      return new Response(JSON.stringify({status: 'ok', auth_index: 'auth-123', models: ['claude-sonnet']}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyResetQuotaAction(
      'auth-123',
      {url: 'https://cliproxy.example.com', key: 'mgmt-key'},
      ctx,
    )

    expect(requestUrl).toBe('https://cliproxy.example.com/v0/management/reset-quota')
    expect(new Headers(requestInit?.headers).get('x-management-key')).toBe('mgmt-key')
    expect(new Headers(requestInit?.headers).get('authorization')).toBeNull()
    expect(JSON.parse(String(requestInit?.body))).toEqual({auth_index: 'auth-123'})
    expect(result).toEqual({status: 'ok', auth_index: 'auth-123', models: ['claude-sonnet']})
    expect(expectCapturedToInclude(captured, 'auth-123')).toBe(true)
  })

  it('surfaces the upstream auth-not-found error on 404', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response(JSON.stringify({error: 'auth not found'}), {status: 404}),
    )

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyResetQuotaAction('missing-auth', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})
    expect(captured.stderr.join('')).toContain('auth not found')
  })

  it('rejects a missing auth index before making a request', async () => {
    let fetchCalled = false
    globalThis.fetch = createFetchImplementation(async () => {
      fetchCalled = true
      return new Response('{}', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyResetQuotaAction(undefined, {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})
    expect(fetchCalled).toBe(false)
    expect(captured.stderr.join('')).toContain('auth_index is required')
  })

  it('surfaces the upstream auth failure error on 401', async () => {
    globalThis.fetch = createFetchImplementation(
      async () => new Response(JSON.stringify({error: 'invalid management key'}), {status: 401}),
    )

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyResetQuotaAction('auth-123', {url: 'https://cliproxy.example.com', key: 'wrong-key'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})
    expect(captured.stderr.join('')).toContain('invalid management key')
  })

  it('enumerates auth records with --list', async () => {
    globalThis.fetch = createFetchImplementation(async (url, init) => {
      expect(url).toBe('https://cliproxy.example.com/v0/management/auth-files')
      expect(init?.method).toBe('GET')
      return new Response(
        JSON.stringify({
          files: [
            {
              id: '1',
              auth_index: 'auth-123',
              name: 'primary',
              type: 'oauth',
              provider: 'anthropic',
              email: 'user@example.com',
            },
          ],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      )
    })

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyResetQuotaAction(
      undefined,
      {
        url: 'https://cliproxy.example.com',
        key: 'mgmt-key',
        list: true,
      },
      ctx,
    )

    expect(result).toEqual([
      {
        id: '1',
        auth_index: 'auth-123',
        name: 'primary',
        type: 'oauth',
        provider: 'anthropic',
        email: 'user@example.com',
      },
    ])
    expect(expectCapturedToInclude(captured, 'auth-123')).toBe(true)
    expect(expectCapturedToInclude(captured, 'primary')).toBe(true)
  })
})

describe('registerCliproxyResetQuota', () => {
  it('registers the space-separated reset-quota command with list support', () => {
    const cli = goke('infra')
    registerCliproxyResetQuota(cli)
    cli.help()

    expect(cli.helpText()).toContain('cliproxy reset-quota')
    expect(cli.helpText()).toContain('--list')
  })
})
