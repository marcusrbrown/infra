import {existsSync, statSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude} from '../../__test__/mcp-ctx-fixture'
import {
  buildSetRequest,
  cliproxyConfigGetAction,
  cliproxyConfigSetAction,
  formatConfigAsColumns,
  parseBoolean,
  parseNumber,
  resolveManagementKey,
} from './config'
import {toStringArray} from './keys'
import {requireSshAuthSock, resolveHost} from './login'

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

describe('cliproxy config helpers', () => {
  describe('parseBoolean', () => {
    it('parses true values case-insensitively', () => {
      expect(parseBoolean('true')).toBe(true)
      expect(parseBoolean('True')).toBe(true)
      expect(parseBoolean('TRUE')).toBe(true)
    })

    it('parses false values case-insensitively', () => {
      expect(parseBoolean('false')).toBe(false)
      expect(parseBoolean('False')).toBe(false)
    })

    it('throws for invalid values', () => {
      expect(() => parseBoolean('wat')).toThrow()
    })
  })

  describe('parseNumber', () => {
    it('parses integers and floats', () => {
      expect(parseNumber('42', 'request-retry')).toBe(42)
      expect(parseNumber('3.14', 'request-retry')).toBe(3.14)
    })

    it('throws TypeError for non-numeric values', () => {
      expect(() => parseNumber('abc', 'request-retry')).toThrow(TypeError)
    })

    it('throws TypeError for NaN', () => {
      expect(() => parseNumber('NaN', 'request-retry')).toThrow(TypeError)
    })

    it('throws TypeError for Infinity', () => {
      expect(() => parseNumber('Infinity', 'request-retry')).toThrow(TypeError)
    })
  })

  describe('buildSetRequest', () => {
    it('builds a boolean debug request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'debug', 'true')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/debug')
      expect(JSON.parse(request.body)).toEqual({value: true})
    })

    it('builds a numeric request-retry request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'request-retry', '3')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/request-retry')
      expect(JSON.parse(request.body)).toEqual({value: 3})
    })

    it('builds a string proxy-url request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'proxy-url', 'https://x.com')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/proxy-url')
      expect(JSON.parse(request.body)).toEqual({value: 'https://x.com'})
    })

    it('throws for unsupported fields', () => {
      expect(() => buildSetRequest('https://cliproxy.example.com', 'provider', 'claude')).toThrow()
    })
  })

  describe('resolveManagementKey', () => {
    const originalManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY

    beforeEach(() => {
      delete process.env.CLIPROXY_MANAGEMENT_KEY
    })

    afterEach(() => {
      if (originalManagementKey === undefined) {
        delete process.env.CLIPROXY_MANAGEMENT_KEY
      } else {
        process.env.CLIPROXY_MANAGEMENT_KEY = originalManagementKey
      }
    })

    it('returns explicit input when provided', () => {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'env-key'

      expect(resolveManagementKey('explicit-key')).toBe('explicit-key')
    })

    it('falls back to CLIPROXY_MANAGEMENT_KEY', () => {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'env-key'

      expect(resolveManagementKey()).toBe('env-key')
    })

    it('throws when no key is available', () => {
      expect(() => resolveManagementKey()).toThrow()
    })
  })
})

describe('formatConfigAsColumns', () => {
  it('formats flat object as aligned key: value lines', () => {
    const result = formatConfigAsColumns({debug: true, 'request-retry': 3, 'proxy-url': 'https://x.com'})
    const lines = result.split('\n')

    expect(lines[0]).toBe('debug        : true')
    expect(lines[1]).toBe('request-retry: 3')
    expect(lines[2]).toBe('proxy-url    : https://x.com')
  })

  it('serializes nested objects as JSON', () => {
    const result = formatConfigAsColumns({nested: {a: 1}})

    expect(result).toBe('nested: {"a":1}')
  })

  it('returns empty string for empty object', () => {
    expect(formatConfigAsColumns({})).toBe('')
  })

  it('falls back to JSON.stringify for non-objects', () => {
    expect(formatConfigAsColumns(null)).toBe('null')
    expect(formatConfigAsColumns([1, 2])).toBe('[\n  1,\n  2\n]')
  })
})

describe('cliproxyConfigGetAction (Mode C, Tier-2 ctx capture)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode C: captures formatted config to ctx.stdout and returns config object', async () => {
    const mockConfig = {debug: true, 'request-retry': 3}
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(mockConfig), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyConfigGetAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    // Tier-2: stdout contains formatted config
    expect(expectCapturedToInclude(captured, 'debug')).toBe(true)
    expect(expectCapturedToInclude(captured, 'request-retry')).toBe(true)

    // Mode C: action returns the config object
    expect(result).toEqual(mockConfig)
  })

  it('Mode C: security warning goes to ctx.stderr', async () => {
    const mockConfig = {debug: false}
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(mockConfig), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyConfigGetAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    const stderrText = captured.stderr.join('')
    expect(stderrText).toContain('API keys')
  })

  it('Mode C: --json flag outputs raw JSON to ctx.stdout', async () => {
    const mockConfig = {debug: true}
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(mockConfig), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    const result = await cliproxyConfigGetAction(
      {url: 'https://cliproxy.example.com', key: 'mgmt-key', json: true},
      ctx,
    )

    const stdoutText = captured.stdout.join('')
    expect(JSON.parse(stdoutText)).toEqual(mockConfig)
    expect(result).toEqual(mockConfig)
  })

  it('Mode C: --output writes file and prints confirmation to ctx.stdout', async () => {
    const testFile = '/tmp/test-cliproxy-config-get-action.json'
    const mockConfig = {debug: true, 'api-keys': ['key1', 'key2']}
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(mockConfig), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    try {
      const result = await cliproxyConfigGetAction(
        {url: 'https://cliproxy.example.com', key: 'mgmt-key', output: testFile},
        ctx,
      )

      expect(existsSync(testFile)).toBe(true)
      const {mode} = statSync(testFile)
      expect(mode & 0o777).toBe(0o600)
      expect(JSON.parse(await Bun.file(testFile).text())).toEqual(mockConfig)
      expect(expectCapturedToInclude(captured, '✓ Config written to')).toBe(true)
      expect(result).toEqual(mockConfig)
    } finally {
      if (existsSync(testFile)) {
        const fs = await import('node:fs/promises')
        await fs.unlink(testFile).catch(() => {})
      }
    }
  })
})

describe('cliproxyConfigSetAction (Mode A, two positional args, Tier-2 ctx capture)', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('Mode A: captures PUT response to ctx.stdout', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({value: true}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyConfigSetAction('debug', 'true', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx)

    expect(expectCapturedToInclude(captured, 'value')).toBe(true)
    expect(expectCapturedToInclude(captured, 'true')).toBe(true)
  })

  it('Mode A: routes unsupported field error through ctx.console.error + exit(1)', async () => {
    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyConfigSetAction('unsupported-field', 'val', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})
    expect(captured.stderr.join('')).toContain('not a supported mutable field')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyConfigGetAction (Tier-2 failure-path parity)', () => {
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
    await expect(cliproxyConfigGetAction({url: 'https://cliproxy.example.com'}, ctx)).rejects.toMatchObject({
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
      cliproxyConfigGetAction({url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('HTTP 500')
    expect(captured.exit).toEqual({code: 1})
  })

  it('Tier-2: --output write failure routes to ctx.console.error + exit(1)', async () => {
    const mockConfig = {debug: true}
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(mockConfig), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    // Use a path that cannot be written (directory as file path)
    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyConfigGetAction(
        {url: 'https://cliproxy.example.com', key: 'mgmt-key', output: '/dev/null/cannot-write'},
        ctx,
      ),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('Failed to write config')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyConfigSetAction (Tier-2 failure-path parity)', () => {
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
      cliproxyConfigSetAction('debug', 'true', {url: 'https://cliproxy.example.com'}, ctx),
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
      cliproxyConfigSetAction('debug', 'true', {url: 'https://cliproxy.example.com', key: 'mgmt-key'}, ctx),
    ).rejects.toMatchObject({
      name: 'MockProcessExit',
      code: 1,
    })
    expect(captured.stderr.join('')).toContain('HTTP 500')
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxy keys helpers', () => {
  describe('toStringArray', () => {
    it('returns string arrays filtered to strings only', () => {
      expect(toStringArray(['a', 'b'])).toEqual(['a', 'b'])
      expect(toStringArray(['a', 1, 'b', false])).toEqual(['a', 'b'])
    })

    it('reads api-keys (hyphenated) from objects', () => {
      expect(toStringArray({'api-keys': ['a', 'b']})).toEqual(['a', 'b'])
    })

    it('reads api_keys (underscored) from objects', () => {
      expect(toStringArray({api_keys: ['a', 'b']})).toEqual(['a', 'b'])
    })

    it('prefers api-keys over api_keys', () => {
      expect(toStringArray({'api-keys': ['x'], api_keys: ['y']})).toEqual(['x'])
    })

    it('returns an empty array for unsupported payloads', () => {
      expect(toStringArray(null)).toEqual([])
      expect(toStringArray(undefined)).toEqual([])
      expect(toStringArray(123)).toEqual([])
    })
  })
})

describe('cliproxy login helpers', () => {
  describe('resolveHost', () => {
    const originalHost = process.env.CLIPROXY_DOMAIN

    beforeEach(() => {
      delete process.env.CLIPROXY_DOMAIN
    })

    afterEach(() => {
      if (originalHost === undefined) {
        delete process.env.CLIPROXY_DOMAIN
      } else {
        process.env.CLIPROXY_DOMAIN = originalHost
      }
    })

    it('returns explicit input when provided', () => {
      process.env.CLIPROXY_DOMAIN = 'env.example.com'

      expect(resolveHost('explicit.example.com')).toBe('explicit.example.com')
    })

    it('falls back to CLIPROXY_DOMAIN', () => {
      process.env.CLIPROXY_DOMAIN = 'env.example.com'

      expect(resolveHost()).toBe('env.example.com')
    })

    it('falls back to the default host', () => {
      expect(resolveHost()).toBe('cliproxy.fro.bot')
    })
  })

  describe('requireSshAuthSock', () => {
    const originalSshAuthSock = process.env.SSH_AUTH_SOCK

    beforeEach(() => {
      delete process.env.SSH_AUTH_SOCK
    })

    afterEach(() => {
      if (originalSshAuthSock === undefined) {
        delete process.env.SSH_AUTH_SOCK
      } else {
        process.env.SSH_AUTH_SOCK = originalSshAuthSock
      }
    })

    it('returns SSH_AUTH_SOCK when set', () => {
      process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'

      expect(requireSshAuthSock()).toBe('/tmp/agent.sock')
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      expect(() => requireSshAuthSock()).toThrow()
    })
  })
})
