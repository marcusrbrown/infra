import {afterEach, beforeEach, describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {createCapturedCtx, MockProcessExit} from '../../__test__/mcp-ctx-fixture'
import {cliproxyModelsAction, registerCliproxyModels} from './models'

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

// Fixture: mixed providers with known created timestamps for ordering assertions.
// anthropic group: claude-3-5-sonnet (created=1700000000) < claude-opus-4 (created=1710000000)
// openai group: gpt-4o (created=1705000000) < gpt-4o-mini (created=1706000000)
// Provider groups sorted ascending: anthropic < openai
// Expected plain order: anthropic/claude-3-5-sonnet-20241022, anthropic/claude-opus-4, openai/gpt-4o, openai/gpt-4o-mini
const MIXED_MODELS_RESPONSE = {
  object: 'list',
  data: [
    {id: 'claude-3-5-sonnet-20241022', object: 'model', owned_by: 'anthropic', created: 1_700_000_000},
    {id: 'claude-opus-4', object: 'model', owned_by: 'anthropic', created: 1_710_000_000},
    {id: 'gpt-4o', object: 'model', owned_by: 'openai', created: 1_705_000_000},
    {id: 'gpt-4o-mini', object: 'model', owned_by: 'openai', created: 1_706_000_000},
  ],
}

const OPENAI_ONLY_RESPONSE = {
  object: 'list',
  data: [
    {id: 'gpt-4o', object: 'model', owned_by: 'openai', created: 1_705_000_000},
    {id: 'gpt-4o-mini', object: 'model', owned_by: 'openai', created: 1_706_000_000},
  ],
}

// Models without owned_by — provider inferred from id prefix
const NO_OWNED_BY_RESPONSE = {
  object: 'list',
  data: [
    {id: 'claude-3-5-sonnet-20241022', object: 'model', created: 1_700_000_000},
    {id: 'gpt-4o', object: 'model', created: 1_705_000_000},
  ],
}

// Model with no owned_by and no matching pattern → unknown provider
const UNKNOWN_PROVIDER_RESPONSE = {
  object: 'list',
  data: [
    {id: 'claude-3-5-sonnet-20241022', object: 'model', owned_by: 'anthropic', created: 1_700_000_000},
    {id: 'some-mystery-model-v1', object: 'model', created: 1_715_000_000},
  ],
}

// Fixture with deliberately reversed order to test date-asc sorting within a group
const REVERSED_ORDER_RESPONSE = {
  object: 'list',
  data: [
    {id: 'claude-opus-4', object: 'model', owned_by: 'anthropic', created: 1_710_000_000},
    {id: 'claude-3-5-sonnet-20241022', object: 'model', owned_by: 'anthropic', created: 1_700_000_000},
  ],
}

describe('cliproxyModelsAction — plain output', () => {
  beforeEach(() => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('Unexpected fetch call')
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('emits provider/id format (not bare id) for each model', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(MIXED_MODELS_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('anthropic/claude-3-5-sonnet-20241022')
    expect(output).toContain('anthropic/claude-opus-4')
    expect(output).toContain('openai/gpt-4o')
    expect(output).toContain('openai/gpt-4o-mini')
    // Must NOT emit bare ids without prefix
    expect(output).not.toMatch(/^claude-/m)
    expect(output).not.toMatch(/^gpt-/m)
  })

  it('groups by provider (anthropic before openai) and sorts date-asc within each group', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(MIXED_MODELS_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const lines = captured.stdout.join('\n').split('\n').filter(Boolean)
    expect(lines).toEqual([
      'anthropic/claude-3-5-sonnet-20241022',
      'anthropic/claude-opus-4',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ])
  })

  it('sorts date-asc within a provider group even when API returns them in reverse order', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(REVERSED_ORDER_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const lines = captured.stdout.join('\n').split('\n').filter(Boolean)
    // claude-3-5-sonnet (created=1700000000) must come before claude-opus-4 (created=1710000000)
    expect(lines).toEqual(['anthropic/claude-3-5-sonnet-20241022', 'anthropic/claude-opus-4'])
  })

  it('filters to openai models only when provider=openai, still emits provider/id', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(MIXED_MODELS_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', provider: 'openai'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('openai/gpt-4o')
    expect(output).toContain('openai/gpt-4o-mini')
    expect(output).not.toContain('claude')
  })

  it('infers anthropic provider via id pattern when owned_by is absent', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(NO_OWNED_BY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', provider: 'anthropic'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('anthropic/claude-3-5-sonnet-20241022')
    expect(output).not.toContain('gpt-4o')
  })

  it('infers openai provider via id pattern when owned_by is absent', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(NO_OWNED_BY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', provider: 'openai'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('openai/gpt-4o')
    expect(output).not.toContain('claude')
  })

  it('prefixes unknown/<id> for entries with no owned_by and no matching pattern, sorted last', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(UNKNOWN_PROVIDER_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const lines = captured.stdout.join('\n').split('\n').filter(Boolean)
    // anthropic group first, unknown group last
    expect(lines[0]).toBe('anthropic/claude-3-5-sonnet-20241022')
    expect(lines.at(-1)).toBe('unknown/some-mystery-model-v1')
  })

  it('does not double-prefix an id that already has a provider/ prefix', async () => {
    const alreadyPrefixedResponse = {
      object: 'list',
      data: [{id: 'anthropic/claude-opus-4', object: 'model', owned_by: 'anthropic', created: 1_710_000_000}],
    }

    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(alreadyPrefixedResponse), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('anthropic/claude-opus-4')
    expect(output).not.toContain('anthropic/anthropic/')
  })
})

describe('cliproxyModelsAction — verbose output', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('emits a single valid JSON array parseable by JSON.parse', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(OPENAI_ONLY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const raw = captured.stdout.join('')
    const parsed = JSON.parse(raw)
    expect(Array.isArray(parsed)).toBe(true)
  })

  it('verbose entries have {id, provider, raw_id, created} shape with prefixed id', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(OPENAI_ONLY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const parsed: {id: string; provider: string; raw_id: string; created: string | null}[] = JSON.parse(
      captured.stdout.join(''),
    )
    expect(parsed.length).toBe(2)

    // parsed.length === 2 asserted above; non-null access is safe
    const first = parsed[0]!
    expect(first).toHaveProperty('id')
    expect(first).toHaveProperty('provider')
    expect(first).toHaveProperty('raw_id')
    expect(first).toHaveProperty('created')
    // id must be prefixed
    expect(first.id).toBe('openai/gpt-4o')
    expect(first.provider).toBe('openai')
    expect(first.raw_id).toBe('gpt-4o')
    // created is ISO 8601 string
    expect(typeof first.created).toBe('string')
    expect(first.created).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('verbose output is date-asc sorted and provider-grouped (anthropic before openai)', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(MIXED_MODELS_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const parsed: {id: string; provider: string; raw_id: string; created: string | null}[] = JSON.parse(
      captured.stdout.join(''),
    )
    expect(parsed.map(e => e.id)).toEqual([
      'anthropic/claude-3-5-sonnet-20241022',
      'anthropic/claude-opus-4',
      'openai/gpt-4o',
      'openai/gpt-4o-mini',
    ])
  })

  it('verbose with empty data emits [] (not a text message)', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({object: 'list', data: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const raw = captured.stdout.join('')
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual([])
  })

  it('verbose with zero-match provider filter emits [] (not a text message)', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(OPENAI_ONLY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction(
      {url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true, provider: 'anthropic'},
      ctx,
    )

    const raw = captured.stdout.join('')
    const parsed = JSON.parse(raw)
    expect(parsed).toEqual([])
  })

  it('verbose: created is null when entry has no created timestamp', async () => {
    const noCreatedResponse = {
      object: 'list',
      data: [{id: 'gpt-4o', object: 'model', owned_by: 'openai'}],
    }

    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(noCreatedResponse), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const parsed: {id: string; provider: string; raw_id: string; created: string | null}[] = JSON.parse(
      captured.stdout.join(''),
    )
    expect(parsed.length).toBe(1)
    // parsed.length === 1 asserted above; non-null access is safe
    expect(parsed[0]!.created).toBeNull()
  })
})

describe('cliproxyModelsAction — empty results', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('prints "No models." when data array is empty (non-verbose)', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify({object: 'list', data: []}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('No models')
    expect(captured.exit).toBeNull()
  })

  it('prints provider-specific "No models" message when filter yields zero matches (non-verbose)', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(OPENAI_ONLY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', provider: 'anthropic'}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('for provider anthropic')
    expect(captured.exit).toBeNull()
  })
})

describe('cliproxyModelsAction — validation errors', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('exits with error for unknown provider without making a fetch call', async () => {
    let fetchCalled = false
    globalThis.fetch = createFetchImplementation(async () => {
      fetchCalled = true
      return new Response('{}', {status: 200})
    })

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', provider: 'gemini'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})

    expect(fetchCalled).toBe(false)
    expect(captured.stderr.join('')).toMatch(/gemini|provider/i)
    expect(captured.exit).toEqual({code: 1})
  })

  it('exits with error when no API key is provided', async () => {
    const savedKey = process.env.CLIPROXY_API_KEY
    delete process.env.CLIPROXY_API_KEY

    try {
      const {ctx, captured} = createCapturedCtx()
      await expect(cliproxyModelsAction({url: 'https://cliproxy.example.com'}, ctx)).rejects.toMatchObject({
        name: 'MockProcessExit',
        code: 1,
      })

      expect(captured.stderr.join('')).toMatch(/key|CLIPROXY_API_KEY/i)
      expect(captured.exit).toEqual({code: 1})
    } finally {
      if (savedKey !== undefined) process.env.CLIPROXY_API_KEY = savedKey
    }
  })
})

describe('cliproxyModelsAction — HTTP errors', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('exits with error on 401 and does not include the bearer key in output', async () => {
    const secretKey = 'super-secret-api-key-12345'

    globalThis.fetch = createFetchImplementation(async () => new Response('Unauthorized', {status: 401}))

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyModelsAction({url: 'https://cliproxy.example.com', key: secretKey}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})

    const allOutput = [...captured.stdout, ...captured.stderr].join('\n')
    expect(allOutput).not.toContain(secretKey)
    expect(captured.exit).toEqual({code: 1})
  })

  it('exits with error on malformed JSON response', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response('not valid json {{{', {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await expect(
      cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key'}, ctx),
    ).rejects.toMatchObject({name: 'MockProcessExit', code: 1})

    expect(captured.stderr.join('')).toMatch(/json|malformed|parse/i)
    expect(captured.exit).toEqual({code: 1})
  })
})

describe('cliproxyModelsAction — ambient key not forwarded to untrusted URL', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {
      CLIPROXY_URL: process.env.CLIPROXY_URL,
      CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY,
    }
    process.env.CLIPROXY_API_KEY = 'ambient-secret-key'
    delete process.env.CLIPROXY_URL
  })

  afterEach(() => {
    for (const [k, v] of Object.entries(originalEnv)) {
      if (v === undefined) {
        delete process.env[k]
      } else {
        process.env[k] = v
      }
    }
    globalThis.fetch = originalFetch
  })

  it('does not forward ambient CLIPROXY_API_KEY to a non-trusted --url', async () => {
    let capturedAuthHeader: string | null | undefined
    let fetchCalled = false

    globalThis.fetch = createFetchImplementation(async (_url, init) => {
      fetchCalled = true
      const hdrs = init?.headers
      if (hdrs instanceof Headers) {
        capturedAuthHeader = hdrs.get('Authorization')
      } else if (hdrs !== null && hdrs !== undefined && typeof hdrs === 'object') {
        const h = hdrs as Record<string, string>
        capturedAuthHeader = h.Authorization ?? h.authorization ?? null
      } else {
        capturedAuthHeader = null
      }

      return new Response(JSON.stringify({object: 'list', data: []}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      })
    })

    const {ctx, captured} = createCapturedCtx()
    // Pass an explicit untrusted URL with no --key.
    // The ambient CLIPROXY_API_KEY must NOT be forwarded to the untrusted host.
    // Two valid outcomes: (a) no fetch is made at all (key withheld → "No API key" error),
    // or (b) fetch is made but without the ambient key in the Authorization header.
    try {
      await cliproxyModelsAction({url: 'https://evil.example.com'}, ctx)
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }

    if (fetchCalled) {
      // If a fetch was made, the ambient key must not appear in the Authorization header
      if (capturedAuthHeader !== null && capturedAuthHeader !== undefined) {
        expect(capturedAuthHeader).not.toContain('ambient-secret-key')
      }
    } else {
      // No fetch made — key was withheld entirely (correct behavior)
      // Verify the error output doesn't contain the ambient key either
      const allOutput = [...captured.stdout, ...captured.stderr].join('\n')
      expect(allOutput).not.toContain('ambient-secret-key')
    }
  })
})

describe('registerCliproxyModels — help output and command discovery', () => {
  it('shows [provider] positional, --url, --key, and --verbose in help text', () => {
    const cli = goke('infra')
    registerCliproxyModels(cli)
    cli.help()

    const helpText = cli.helpText()

    expect(helpText).toContain('cliproxy models')
    expect(helpText).toContain('[provider]')
    expect(helpText).toContain('--url [url]')
    expect(helpText).toContain('--key [key]')
    expect(helpText).toContain('--verbose')
  })

  it('command is discoverable in the registered cliproxy group', () => {
    const cli = goke('infra')
    registerCliproxyModels(cli)
    cli.help()

    const helpText = cli.helpText()

    expect(helpText).toContain('List the models CLIProxyAPI serves.')
  })
})
