import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude} from '../../__test__/mcp-ctx-fixture'
import {cliproxyKeysAddAction, cliproxyKeysListAction, cliproxyKeysRemoveAction, toStringArray} from './keys'

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

describe('toStringArray', () => {
  it('returns string array as-is', () => {
    expect(toStringArray(['a', 'b', 'c'])).toEqual(['a', 'b', 'c'])
  })

  it('filters non-string items from array', () => {
    expect(toStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b'])
  })

  it('extracts api-keys from object', () => {
    expect(toStringArray({'api-keys': ['x', 'y']})).toEqual(['x', 'y'])
  })

  it('extracts api_keys from object (underscore variant)', () => {
    expect(toStringArray({api_keys: ['x', 'y']})).toEqual(['x', 'y'])
  })

  it('returns empty array for null', () => {
    expect(toStringArray(null)).toEqual([])
  })

  it('returns empty array for unrecognized shape', () => {
    expect(toStringArray({other: 'stuff'})).toEqual([])
  })
})

describe('cliproxyKeysListAction (Mode C, Tier-2 ctx capture)', () => {
  beforeEach(() => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('Unexpected fetch call')
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode C: captures numbered list to ctx.stdout and returns key array', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(['sk-live-aaa', 'sk-live-bbb']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyKeysListAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    // Tier-2: stdout contains formatted list
    expect(expectCapturedToInclude(captured, 'sk-live-aaa')).toBe(true)
    expect(expectCapturedToInclude(captured, '1.')).toBe(true)
    expect(expectCapturedToInclude(captured, '2.')).toBe(true)

    // Mode C: action returns the parsed array
    expect(Array.isArray(result)).toBe(true)
    expect(result).toEqual(['sk-live-aaa', 'sk-live-bbb'])
  })

  it('Mode C: security warning goes to ctx.stderr', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(['sk-live-aaa']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyKeysListAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    const stderrText = captured.stderr.join('')
    expect(stderrText).toContain('API keys')
  })

  it('Mode C: returns empty array and prints "No API keys configured" when list is empty', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify([]), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyKeysListAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    expect(expectCapturedToInclude(captured, 'No API keys configured')).toBe(true)
    expect(result).toEqual([])
  })

  it('Mode C: --json flag outputs JSON array to ctx.stdout', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(['sk-live-aaa']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyKeysListAction({url: 'https://cliproxy.example.com', key: 'mgmt-key', json: true}, ctx)

    const stdoutText = captured.stdout.join('')
    const parsed = JSON.parse(stdoutText)
    expect(parsed).toEqual(['sk-live-aaa'])
    expect(result).toEqual(['sk-live-aaa'])
  })
})

describe('cliproxyKeysAddAction (Mode A, positional arg, Tier-2 ctx capture)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode A: captures success message to ctx.stdout after adding key', async () => {
    let putCalled = false
    globalThis.fetch = createFetchImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        putCalled = true
        return new Response(JSON.stringify(['sk-live-existing', 'sk-live-new']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }

      // GET current keys
      return new Response(JSON.stringify(['sk-live-existing']), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyKeysAddAction('sk-live-new', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    expect(putCalled).toBe(true)
    expect(expectCapturedToInclude(captured, 'sk-live-new')).toBe(true)
    expect(expectCapturedToInclude(captured, 'Added key')).toBe(true)
  })

  it('Mode A: skips PUT when key already present', async () => {
    let putCalled = false
    globalThis.fetch = createFetchImplementation(async (_url, init) => {
      if (init?.method === 'PUT') {
        putCalled = true
        return new Response('{}', {status: 200})
      }

      return new Response(JSON.stringify(['sk-live-existing']), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    const {ctx, captured} = createCapturedCtx()
    await cliproxyKeysAddAction('sk-live-existing', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    expect(putCalled).toBe(false)
    expect(expectCapturedToInclude(captured, 'already present')).toBe(true)
  })
})

describe('cliproxyKeysRemoveAction (Mode A, positional arg, Tier-2 ctx capture)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode A: captures DELETE response to ctx.stdout', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({removed: true}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyKeysRemoveAction('sk-live-old', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    expect(expectCapturedToInclude(captured, 'removed')).toBe(true)
  })
})

describe('cliproxyKeysListAction (Tier-2 failure-path parity)', () => {
  const originalManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalManagementKey === undefined) {
      delete process.env.CLIPROXY_MANAGEMENT_KEY
    } else {
      process.env.CLIPROXY_MANAGEMENT_KEY = originalManagementKey
    }
  })

  it('Tier-2: missing CLIPROXY_MANAGEMENT_KEY routes to ctx.console.error + exit(1)', async () => {
    delete process.env.CLIPROXY_MANAGEMENT_KEY

    const {ctx, captured} = createCapturedCtx()
    await expect(cliproxyKeysListAction({url: 'https://cliproxy.example.com'}, ctx)).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Management API key')
    expect(captured.exit).toEqual({code: 1})
  })

  it('Tier-2: HTTP 500 response routes to ctx.console.error + exit(1)', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('server error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyKeysListAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('HTTP 500')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyKeysAddAction (Tier-2 failure-path parity)', () => {
  const originalManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalManagementKey === undefined) {
      delete process.env.CLIPROXY_MANAGEMENT_KEY
    } else {
      process.env.CLIPROXY_MANAGEMENT_KEY = originalManagementKey
    }
  })

  it('Tier-2: missing CLIPROXY_MANAGEMENT_KEY routes to ctx.console.error + exit(1)', async () => {
    delete process.env.CLIPROXY_MANAGEMENT_KEY

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyKeysAddAction('sk-live-new', {url: 'https://cliproxy.example.com'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Management API key')
    expect(captured.exit).toEqual({code: 1})
  })

  it('Tier-2: HTTP 500 on GET routes to ctx.console.error + exit(1)', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('server error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyKeysAddAction('sk-live-new', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('HTTP 500')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyKeysRemoveAction (Tier-2 failure-path parity)', () => {
  const originalManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY

  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalManagementKey === undefined) {
      delete process.env.CLIPROXY_MANAGEMENT_KEY
    } else {
      process.env.CLIPROXY_MANAGEMENT_KEY = originalManagementKey
    }
  })

  it('Tier-2: missing CLIPROXY_MANAGEMENT_KEY routes to ctx.console.error + exit(1)', async () => {
    delete process.env.CLIPROXY_MANAGEMENT_KEY

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyKeysRemoveAction('sk-live-old', {url: 'https://cliproxy.example.com'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Management API key')
    expect(captured.exit).toEqual({code: 1})
  })

  it('Tier-2: HTTP 500 response routes to ctx.console.error + exit(1)', async () => {
    globalThis.fetch = createFetchImplementation(async () => new Response('server error', {status: 500}))

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyKeysRemoveAction('sk-live-old', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('HTTP 500')
    expect(captured.exit).toEqual({code: 1})
  })
})
