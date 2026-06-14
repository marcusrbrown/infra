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

describe('cliproxyModelsAction — plain output', () => {
  beforeEach(() => {
    globalThis.fetch = createFetchImplementation(async () => {
      throw new Error('Unexpected fetch call')
    })
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('lists all model ids one per line when no provider filter', async () => {
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
    expect(output).toContain('claude-3-5-sonnet-20241022')
    expect(output).toContain('claude-opus-4')
    expect(output).toContain('gpt-4o')
    expect(output).toContain('gpt-4o-mini')
  })

  it('filters to openai models only when provider=openai', async () => {
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
    expect(output).toContain('gpt-4o')
    expect(output).toContain('gpt-4o-mini')
    expect(output).not.toContain('claude')
  })

  it('matches provider via id prefix when owned_by is absent', async () => {
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
    expect(output).toContain('claude-3-5-sonnet-20241022')
    expect(output).not.toContain('gpt-4o')
  })
})

describe('cliproxyModelsAction — verbose output', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('shows owned_by and formatted date in verbose mode', async () => {
    globalThis.fetch = createFetchImplementation(
      async () =>
        new Response(JSON.stringify(OPENAI_ONLY_RESPONSE), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
    )

    const {ctx, captured} = createCapturedCtx()
    await cliproxyModelsAction({url: 'https://cliproxy.example.com', key: 'test-api-key', verbose: true}, ctx)

    const output = captured.stdout.join('\n')
    expect(output).toContain('gpt-4o')
    expect(output).toContain('openai')
    // created=1705000000 → 2024-01-11 or similar ISO date prefix
    expect(output).toMatch(/\d{4}-\d{2}-\d{2}/)
  })
})

describe('cliproxyModelsAction — empty results', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('prints "No models." when data array is empty', async () => {
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

  it('prints provider-specific "No models" message when filter yields zero matches', async () => {
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
    expect(output).toContain('No models')
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
