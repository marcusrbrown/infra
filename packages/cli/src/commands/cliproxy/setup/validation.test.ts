/// <reference types="bun" />

import {afterEach, describe, expect, it, mock} from 'bun:test'

import {
  assertProxyKeyWorks,
  assertProxyReachable,
  MODEL_ID_RE,
  validateSetupOptions,
  verifyModelsAvailable,
} from './validation'

// ── validateSetupOptions ──────────────────────────────────────────────────────

describe('validateSetupOptions', () => {
  it('requires --key in non-interactive mode', () => {
    expect(() => validateSetupOptions({repo: 'owner/repo', harness: 'opencode'}, false)).toThrow(
      '--key is required when stdin is not a TTY',
    )
  })

  it('requires --repo in non-interactive mode', () => {
    expect(() => validateSetupOptions({key: 'sk-test', harness: 'opencode'}, false)).toThrow(
      '--repo is required when stdin is not a TTY',
    )
  })

  it('requires --harness in non-interactive mode', () => {
    expect(() => validateSetupOptions({key: 'sk-test', repo: 'owner/repo'}, false)).toThrow(
      '--harness is required when stdin is not a TTY',
    )
  })
})

// ── model flag validation (MODEL_ID_RE) ───────────────────────────────────────

describe('model flag validation', () => {
  it('accepts "openai/gpt-5.4-mini"', () => {
    expect(MODEL_ID_RE.test('openai/gpt-5.4-mini')).toBe(true)
  })

  it('rejects "gpt-5.4-mini" (no provider prefix)', () => {
    expect(MODEL_ID_RE.test('gpt-5.4-mini')).toBe(false)
  })

  it('rejects "openai/GPT-5.4-mini" (uppercase)', () => {
    expect(MODEL_ID_RE.test('openai/GPT-5.4-mini')).toBe(false)
  })

  it('rejects "openai/gpt-5.4-mini; rm -rf /" (injection attempt)', () => {
    expect(MODEL_ID_RE.test('openai/gpt-5.4-mini; rm -rf /')).toBe(false)
  })

  it('rejects "openai/gpt-4o." (trailing dot)', () => {
    expect(MODEL_ID_RE.test('openai/gpt-4o.')).toBe(false)
  })

  it('rejects "openai/gpt-4o-" (trailing hyphen)', () => {
    expect(MODEL_ID_RE.test('openai/gpt-4o-')).toBe(false)
  })

  it('accepts "openai/gpt-4o" (regression — still works)', () => {
    expect(MODEL_ID_RE.test('openai/gpt-4o')).toBe(true)
  })

  it('accepts "anthropic/claude-sonnet-4-6" (regression)', () => {
    expect(MODEL_ID_RE.test('anthropic/claude-sonnet-4-6')).toBe(true)
  })

  it('accepts "openai/a" (single-char tail)', () => {
    expect(MODEL_ID_RE.test('openai/a')).toBe(true)
  })

  it('rejects "openai/" (empty tail)', () => {
    expect(MODEL_ID_RE.test('openai/')).toBe(false)
  })
})

// ── verifyModelsAvailable ─────────────────────────────────────────────────────

describe('verifyModelsAvailable', () => {
  // Realistic fixture matching the plan spec
  const MODELS_FIXTURE = {
    data: [
      {id: 'claude-3-7-sonnet-20250219', owned_by: 'anthropic'},
      {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      {id: 'gpt-5.4-mini', owned_by: 'openai'},
      {id: 'gpt-5.5', owned_by: 'openai'},
    ],
  }

  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // Save and restore globalThis.fetch around each test
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  // Capture original before any test runs
  originalFetch = globalThis.fetch

  it('anthropic-only short-circuit: returns immediately without calling fetch', async () => {
    const fetchSpy = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await verifyModelsAvailable(BASE_URL, KEY, ['anthropic'], 'anthropic/claude-sonnet-4-6')

    expect(fetchSpy.mock.calls.length).toBe(0)
  })

  it('happy path: openai-only, model present, owned_by openai — passes without throw', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('happy path: dual providers, anthropic model present, openai entries exist — passes', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    await expect(
      verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'anthropic/claude-sonnet-4-6'),
    ).resolves.toBeUndefined()
  })

  it('error path: 401 throws "Proxy key rejected" message', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'Proxy key rejected',
    )
  })

  it('error path: 401 error message does NOT contain the Authorization header value', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).not.toContain(KEY)
    expect(errorMessage).not.toContain('Bearer')
  })

  it('error path: 403 throws "Proxy key rejected" message', async () => {
    globalThis.fetch = mock(async () => new Response('Forbidden', {status: 403})) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'Proxy key rejected',
    )
  })

  it('error path: 500 throws with status and truncated body; no Authorization header in message', async () => {
    const body = 'Internal Server Error — something went wrong on the proxy'
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('500')
    expect(errorMessage).not.toContain(KEY)
    expect(errorMessage).not.toContain('Bearer')
  })

  it('error path: 200 with data:[] and openai in providers throws no-openai-models message', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({data: []}))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'No OpenAI models on proxy',
    )
  })

  it('error path: model not present in data — throws and lists available openai ids', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-99-unknown')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('gpt-99-unknown')
    // Should list available openai models
    expect(errorMessage).toContain('gpt-5.4-mini')
    expect(errorMessage).toContain('gpt-5.5')
    // Should NOT list anthropic models
    expect(errorMessage).not.toContain('claude')
  })

  it('error path: model not present and provider is anthropic — lists available anthropic ids', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'anthropic/claude-unknown-model')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('claude-unknown-model')
    // Should list available anthropic models
    expect(errorMessage).toContain('claude-3-7-sonnet-20250219')
    expect(errorMessage).toContain('claude-sonnet-4-6')
    // Should NOT list openai models
    expect(errorMessage).not.toContain('gpt-')
  })

  it('error path: data is a string (not array) — throws Zod-derived error mentioning "data" and array/Expected', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({data: 'not-an-array'}))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      /data.*Expected|Expected.*data|data.*array/i,
    )
  })

  it('error path: data is missing (response is {}) — throws Zod-derived error indicating data is required', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({}))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(/data/i)
  })

  it('happy path (passthrough): extra top-level field ignored — passes', async () => {
    const fixtureWithExtra = {
      data: [
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
        {id: 'gpt-5.4-mini', owned_by: 'openai'},
      ],
      extraField: 'ignored',
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixtureWithExtra))) as unknown as typeof fetch

    await expect(
      verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'openai/gpt-5.4-mini'),
    ).resolves.toBeUndefined()
  })

  it('happy path (passthrough on entries): extra entry field ignored — passes', async () => {
    const fixtureWithEntryExtra = {
      data: [{id: 'gpt-5.4-mini', owned_by: 'openai', extraEntryField: 'ignored'}],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixtureWithEntryExtra))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('regression: entries WITH owned_by openai still parse and are detected as OpenAI', async () => {
    const fixture = {
      data: [
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
        {id: 'gpt-5.4-mini', owned_by: 'openai'},
      ],
      object: 'list',
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixture))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('v7 compatibility: entries omitting owned_by parse without error and OpenAI is detected via id prefix', async () => {
    // CLIProxyAPI v7 may return entries without owned_by — these must not fail Zod parse,
    // and an entry like {id: 'openai/gpt-5.4-mini'} should be detected as an OpenAI model.
    const v7Fixture = {
      data: [
        {id: 'openai/gpt-5.4-mini', object: 'model'},
        {id: 'anthropic/claude-sonnet-4-6', object: 'model'},
      ],
      object: 'list',
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(v7Fixture))) as unknown as typeof fetch

    // Requesting a model that doesn't exist so we can observe which check throws.
    // The error must be "not found on proxy" — not a Zod parse error or "No OpenAI models on proxy".
    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/nonexistent-model')).rejects.toThrow(
      'not found on proxy',
    )
  })

  it('v7 compatibility: mixed entries (some with owned_by, some without) resolve correctly', async () => {
    const mixedFixture = {
      data: [
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
        // v7-style OpenAI entry — no owned_by, id has openai/ prefix
        {id: 'openai/gpt-5.4-mini', object: 'model'},
      ],
      object: 'list',
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(mixedFixture))) as unknown as typeof fetch

    // Should detect OpenAI via id inference and pass the OpenAI presence check.
    // The error must be "not found on proxy" — not a Zod parse error or "No OpenAI models on proxy".
    await expect(
      verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'openai/nonexistent-model'),
    ).rejects.toThrow('not found on proxy')
  })

  it('v7 compatibility: entry with unrecognizable id and no owned_by does not crash (falls through as non-OpenAI)', async () => {
    const unknownIdFixture = {
      data: [
        // No owned_by, id doesn't map to any known provider
        {id: 'some-unknown-model', object: 'model'},
        // A real OpenAI entry with owned_by — detection should succeed via this entry
        {id: 'gpt-5.4-mini', owned_by: 'openai'},
      ],
      object: 'list',
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(unknownIdFixture))) as unknown as typeof fetch

    // Should still pass — openai is detected via owned_by on the second entry,
    // and the unknown entry does not cause a crash.
    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('error path: dual providers, no owned_by=openai entries — throws no-openai-models message', async () => {
    const anthropicOnlyData = {
      data: [
        {id: 'claude-3-7-sonnet-20250219', owned_by: 'anthropic'},
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      ],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(anthropicOnlyData))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'No OpenAI models on proxy',
    )
  })
})

// ── validateSetupOptions — providers/model validation ─────────────────────────

describe('validateSetupOptions — providers/model validation', () => {
  it('regression: no providers/model passes unchanged (anthropic-only default)', () => {
    expect(() => validateSetupOptions({key: 'sk-test', repo: 'owner/repo', harness: 'opencode'}, false)).not.toThrow()
  })

  it('happy path: single provider anthropic, no model — passes', () => {
    expect(() =>
      validateSetupOptions({key: 'sk-test', repo: 'owner/repo', harness: 'opencode', providers: 'anthropic'}, false),
    ).not.toThrow()
  })

  it('happy path: openai + model with openai prefix — passes', () => {
    expect(() =>
      validateSetupOptions(
        {key: 'sk-test', repo: 'owner/repo', harness: 'opencode', providers: 'openai', model: 'openai/gpt-5.4-mini'},
        false,
      ),
    ).not.toThrow()
  })

  it('happy path: anthropic,openai + model with openai prefix — passes', () => {
    expect(() =>
      validateSetupOptions(
        {
          key: 'sk-test',
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'anthropic,openai',
          model: 'openai/gpt-5.4-mini',
        },
        false,
      ),
    ).not.toThrow()
  })

  it('error: multiple providers without --model throws "Pass --model" error', () => {
    expect(() => validateSetupOptions({harness: 'opencode', providers: 'anthropic,openai'}, false)).toThrow(
      'Pass --model <provider/model-id> when selecting multiple providers.',
    )
  })

  it('error: model prefix does not match single provider (anthropic provider, openai model)', () => {
    expect(() =>
      validateSetupOptions({harness: 'opencode', providers: 'anthropic', model: 'openai/gpt-5.4-mini'}, false),
    ).toThrow(/Model prefix openai does not match selected providers/)
  })

  it('error: model prefix does not match single provider (openai provider, anthropic model)', () => {
    expect(() =>
      validateSetupOptions({harness: 'opencode', providers: 'openai', model: 'anthropic/claude-sonnet-4-6'}, false),
    ).toThrow(/Model prefix anthropic does not match selected providers/)
  })

  it('error: duplicate providers throws from parseProviders', () => {
    expect(() => validateSetupOptions({harness: 'opencode', providers: 'anthropic,anthropic'}, false)).toThrow(
      /duplicate/,
    )
  })

  it('error: unknown provider throws from parseProviders', () => {
    expect(() => validateSetupOptions({harness: 'opencode', providers: 'claude'}, false)).toThrow(/Unknown provider/)
  })

  it('interactive mode: providers/model checks are skipped even with invalid combo', () => {
    // Multiple providers without model — would fail in non-interactive, but interactive skips all checks
    expect(() => validateSetupOptions({providers: 'anthropic,openai'}, true)).not.toThrow()
  })
})

// ── FIX 1: owned_by:'' falls back to id inference ────────────────────────────

describe('verifyModelsAvailable — owned_by empty string falls back to id inference', () => {
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('entry with owned_by:"" and id "openai/gpt-5.4-mini" is detected as OpenAI (does not throw no-openai-models)', async () => {
    const fixture = {
      data: [{id: 'openai/gpt-5.4-mini', owned_by: ''}],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixture))) as unknown as typeof fetch

    // Must resolve — empty owned_by should fall back to id prefix inference
    await expect(
      verifyModelsAvailable('https://cliproxy.fro.bot', 'sk-test-key', ['openai'], 'openai/gpt-5.4-mini'),
    ).resolves.toBeUndefined()
  })
})

// ── FIX 2: v7-prefixed model presence ────────────────────────────────────────

describe('verifyModelsAvailable — v7-prefixed model id matched without owned_by', () => {
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('entry with id "openai/gpt-5.4-mini" (no owned_by) resolves when requesting "openai/gpt-5.4-mini"', async () => {
    const fixture = {
      data: [{id: 'openai/gpt-5.4-mini'}],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixture))) as unknown as typeof fetch

    await expect(
      verifyModelsAvailable('https://cliproxy.fro.bot', 'sk-test-key', ['openai'], 'openai/gpt-5.4-mini'),
    ).resolves.toBeUndefined()
  })

  it('model not found error lists requested model and available openai id but not anthropic ids', async () => {
    const fixture = {
      data: [{id: 'openai/gpt-5.4-mini'}, {id: 'anthropic/claude-sonnet-4-6'}],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(fixture))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable('https://cliproxy.fro.bot', 'sk-test-key', ['openai'], 'openai/nonexistent')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('nonexistent')
    expect(errorMessage).toContain('openai/gpt-5.4-mini')
    expect(errorMessage).not.toContain('anthropic')
    expect(errorMessage).not.toContain('claude')
  })
})

// ── FIX 3: exact key redacted in /v1/models error body ───────────────────────

describe('verifyModelsAvailable — exact key redacted in error body', () => {
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('500 response body containing the raw key does not expose the key in thrown message', async () => {
    const rawKey = 'my-plain-key-no-bearer-prefix'
    const body = `Internal error: key=${rawKey} was invalid`
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable('https://cliproxy.fro.bot', rawKey, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('500')
    expect(errorMessage).not.toContain(rawKey)
  })
})

// ── assertProxyReachable (new TDD tests) ──────────────────────────────────────

describe('assertProxyReachable', () => {
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('happy path: fetch returns HTTP 200 — resolves without throw', async () => {
    globalThis.fetch = mock(async () => new Response('OK', {status: 200})) as unknown as typeof fetch

    await expect(assertProxyReachable('https://good.example')).resolves.toBeUndefined()
  })

  it('error path: fetch throws AbortError — throws with "Unable to reach proxy" prefix', async () => {
    const abortError = new DOMException('The operation was aborted.', 'AbortError')
    globalThis.fetch = mock(async () => {
      throw abortError
    }) as unknown as typeof fetch

    await expect(assertProxyReachable('https://bad.example')).rejects.toThrow(/Unable to reach proxy/)
  })

  it('error path: fetch returns non-ok status — throws with "Proxy check failed" prefix', async () => {
    globalThis.fetch = mock(async () => new Response('Bad Gateway', {status: 502})) as unknown as typeof fetch

    await expect(assertProxyReachable('https://bad.example')).rejects.toThrow(/Proxy check failed/)
  })
})

// ── assertProxyKeyWorks (new TDD tests) ───────────────────────────────────────

describe('assertProxyKeyWorks', () => {
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('happy path: fetch returns HTTP 200 — resolves without throw', async () => {
    globalThis.fetch = mock(async () => new Response('OK', {status: 200})) as unknown as typeof fetch

    await expect(assertProxyKeyWorks('https://good.example', 'sk-good')).resolves.toBeUndefined()
  })

  it('error path: fetch returns HTTP 401 — throws with "Unable to verify proxy key" prefix', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

    await expect(assertProxyKeyWorks('https://good.example', 'sk-bad')).rejects.toThrow(/Proxy key verification failed/)
  })

  it('error path: fetch throws network error — throws with "Unable to verify proxy key" prefix', async () => {
    globalThis.fetch = mock(async () => {
      throw new Error('network failure')
    }) as unknown as typeof fetch

    await expect(assertProxyKeyWorks('https://good.example', 'sk-good')).rejects.toThrow(/Unable to verify proxy key/)
  })
})
