import type {OpenAICompatEntry} from './management'
import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test'
import {
  applyOAuthModelAlias,
  applyOpenAICompat,
  managementHeaders,
  normalizeOpenAICompatEntry,
  parseClaudeEntries,
  parseManagementKeyList,
  patchOpenAICompatDisabled,
  readBackOAuthModelAlias,
  readBackOpenAICompat,
  readOAuthModelAliasFromConfig,
  requestJson,
  setEqualOAuthModelAlias,
  setEqualOpenAICompat,
  toStringArray,
} from './management'

// ─── toStringArray ────────────────────────────────────────────────────────────

describe('toStringArray', () => {
  test('returns string[] from a top-level string array', () => {
    expect(toStringArray(['a', 'b'])).toEqual(['a', 'b'])
  })

  test('filters non-strings from a top-level array', () => {
    expect(toStringArray(['a', 1, null, 'b'])).toEqual(['a', 'b'])
  })

  test('extracts api-keys from an object', () => {
    expect(toStringArray({'api-keys': ['k1', 'k2']})).toEqual(['k1', 'k2'])
  })

  test('extracts api_keys from an object', () => {
    expect(toStringArray({api_keys: ['k1']})).toEqual(['k1'])
  })

  test('returns [] for null', () => {
    expect(toStringArray(null)).toEqual([])
  })

  test('returns [] for unrecognized shape', () => {
    expect(toStringArray({other: 'value'})).toEqual([])
  })
})

// ─── managementHeaders ────────────────────────────────────────────────────────

describe('managementHeaders', () => {
  test('sets x-management-key header', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('x-management-key')).toBe('mgmt-key')
  })

  test('sets content-type to application/json', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('content-type')).toBe('application/json')
  })

  test('does not set Authorization header', () => {
    const headers = managementHeaders('mgmt-key')
    expect(headers.get('authorization')).toBeNull()
  })
})

// ─── requestJson ──────────────────────────────────────────────────────────────

describe('requestJson', () => {
  test('returns parsed JSON on success', async () => {
    const payload = {ok: true, value: 42}
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: {'content-type': 'application/json'},
        }),
      ),
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      const result = await requestJson('https://example.com/api', {method: 'GET'})
      expect(result).toEqual(payload)
    } finally {
      globalThis.fetch = original
    }
  })

  test('throws with HTTP status and body on non-200 response', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Unauthorized', {status: 401})))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      await expect(requestJson('https://example.com/api', {method: 'POST'})).rejects.toThrow(
        'POST https://example.com/api failed with HTTP 401: Unauthorized',
      )
    } finally {
      globalThis.fetch = original
    }
  })

  test('throws on 200 with malformed JSON body so mutating callers fail closed', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(
        new Response('not-json-content', {
          status: 200,
          headers: {'content-type': 'text/plain'},
        }),
      ),
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      await expect(requestJson('https://example.com/api', {method: 'GET'})).rejects.toThrow(/returned malformed JSON/)
    } finally {
      globalThis.fetch = original
    }
  })

  test('returns null on 204 No Content', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response(null, {status: 204})))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as unknown as typeof fetch
    try {
      const result = await requestJson('https://example.com/api', {method: 'DELETE'})
      expect(result).toBeNull()
    } finally {
      globalThis.fetch = original
    }
  })
})

// ─── parseManagementKeyList ───────────────────────────────────────────────────

describe('parseManagementKeyList', () => {
  test('accepts top-level string array', () => {
    expect(parseManagementKeyList(['k1', 'k2'])).toEqual(['k1', 'k2'])
  })

  test('accepts {api-keys: string[]}', () => {
    expect(parseManagementKeyList({'api-keys': ['k1']})).toEqual(['k1'])
  })

  test('accepts {api_keys: string[]}', () => {
    expect(parseManagementKeyList({api_keys: ['k1']})).toEqual(['k1'])
  })

  test('throws on null payload so destructive PUTs fail closed', () => {
    expect(() => parseManagementKeyList(null)).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on empty object', () => {
    expect(() => parseManagementKeyList({})).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on array of non-strings', () => {
    expect(() => parseManagementKeyList([1, 2, 3])).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on string scalar', () => {
    expect(() => parseManagementKeyList('not-an-array')).toThrow(/Unexpected management key-list shape/)
  })

  test('throws on object with non-array api-keys field', () => {
    expect(() => parseManagementKeyList({'api-keys': 'k1'})).toThrow(/Unexpected management key-list shape/)
  })
})

// ─── parseClaudeEntries ───────────────────────────────────────────────────────

describe('parseClaudeEntries', () => {
  test('returns [] for non-array input', () => {
    expect(parseClaudeEntries(null)).toEqual([])
    expect(parseClaudeEntries('string')).toEqual([])
    expect(parseClaudeEntries(42)).toEqual([])
    expect(parseClaudeEntries({})).toEqual([])
  })

  test('parses valid entries with boolean fork', () => {
    const raw = [
      {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true},
      {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: false},
    ]
    expect(parseClaudeEntries(raw)).toEqual(raw)
  })

  test('normalizes fork string "true" to boolean true', () => {
    const raw = [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: 'true'}]
    const result = parseClaudeEntries(raw)
    expect(result).toHaveLength(1)
    const entry = result[0]
    if (!entry) throw new Error('Expected entry at index 0')
    expect(entry.fork).toBe(true)
    expect(typeof entry.fork).toBe('boolean')
  })

  test('normalizes fork string "false" to boolean false', () => {
    const raw = [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: 'false'}]
    const result = parseClaudeEntries(raw)
    expect(result).toHaveLength(1)
    const entry = result[0]
    if (!entry) throw new Error('Expected entry at index 0')
    expect(entry.fork).toBe(false)
    expect(typeof entry.fork).toBe('boolean')
  })

  test('drops entries with missing name', () => {
    const dropped: number[] = []
    const raw = [{alias: 'claude-sonnet-4-0', fork: true}]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(0)
    expect(dropped).toEqual([0])
  })

  test('drops entries with empty name', () => {
    const dropped: number[] = []
    const raw = [{name: '', alias: 'claude-sonnet-4-0', fork: true}]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(0)
    expect(dropped).toEqual([0])
  })

  test('drops entries with missing alias', () => {
    const dropped: number[] = []
    const raw = [{name: 'claude-sonnet-4-20250514', fork: true}]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(0)
    expect(dropped).toEqual([0])
  })

  test('drops entries with unrecognized fork value', () => {
    const dropped: number[] = []
    const raw = [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: 1}]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(0)
    expect(dropped).toEqual([0])
  })

  test('drops null/non-object entries', () => {
    const dropped: number[] = []
    const raw = [null, 'string', 42]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(0)
    expect(dropped).toEqual([0, 1, 2])
  })

  test('calls onDrop with correct indices for mixed valid/invalid', () => {
    const dropped: number[] = []
    const raw = [
      {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true}, // valid [0]
      {name: '', alias: 'bad', fork: true}, // invalid [1]
      {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: false}, // valid [2]
      {alias: 'no-name', fork: true}, // invalid [3]
    ]
    const result = parseClaudeEntries(raw, i => dropped.push(i))
    expect(result).toHaveLength(2)
    expect(dropped).toEqual([1, 3])
  })
})

// ─── readOAuthModelAliasFromConfig ────────────────────────────────────────────

describe('readOAuthModelAliasFromConfig', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mgmt-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  test('parses a config with the 7-entry claude block (name=DATED upstream, alias=SHORT client)', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(
      configPath,
      `
oauth-model-alias:
  claude:
    - name: claude-opus-4-20250514
      alias: claude-opus-4-5
      fork: true
    - name: claude-sonnet-4-20250514
      alias: claude-sonnet-4-5
      fork: true
    - name: claude-haiku-4-20250514
      alias: claude-haiku-4-5
      fork: true
    - name: claude-sonnet-4-6-20250514
      alias: claude-sonnet-4-6
      fork: true
    - name: claude-opus-4-20250514
      alias: claude-opus-4
      fork: true
    - name: claude-sonnet-4-20250514
      alias: claude-sonnet-4
      fork: true
    - name: claude-haiku-3-5-20241022
      alias: claude-haiku-3-5
      fork: true
`.trim(),
    )

    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toHaveLength(7)
    // name = dated upstream id, alias = short client-facing id
    expect(result.claude[0]).toEqual({name: 'claude-opus-4-20250514', alias: 'claude-opus-4-5', fork: true})
    expect(result.claude[6]).toEqual({name: 'claude-haiku-3-5-20241022', alias: 'claude-haiku-3-5', fork: true})
  })

  test('returns empty alias object when oauth-model-alias key is absent', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(
      configPath,
      `
api-keys: []
debug: false
`.trim(),
    )

    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toEqual([])
  })

  test('returns empty alias object when file has no relevant keys', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, 'some-other-key: value\n')

    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toEqual([])
  })

  test('drops malformed entry (frok typo / missing fork) and emits console.warn', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(
      configPath,
      `
oauth-model-alias:
  claude:
    - name: claude-sonnet-4-20250514
      alias: claude-sonnet-4-0
      fork: true
    - name: claude-opus-4-20250514
      alias: claude-opus-4-0
      frok: true
`.trim(),
    )

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const result = readOAuthModelAliasFromConfig(configPath)
      // Only the valid entry survives
      expect(result.claude).toHaveLength(1)
      expect(result.claude[0]).toEqual({name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true})
      // A warning must have been emitted about the dropped entry
      const warnCalls = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnCalls).toMatch(/dropped 1 malformed/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('returns empty when oauth-model-alias is a non-object (string)', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, 'oauth-model-alias: "not-an-object"\n')
    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toEqual([])
  })

  test('returns empty when oauth-model-alias is a boolean', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, 'oauth-model-alias: true\n')
    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toEqual([])
  })

  test('returns empty when claude is not an array', () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(
      configPath,
      `
oauth-model-alias:
  claude: "not-an-array"
`.trim(),
    )
    const result = readOAuthModelAliasFromConfig(configPath)
    expect(result.claude).toEqual([])
  })
})

// ─── applyOAuthModelAlias ─────────────────────────────────────────────────────

describe('applyOAuthModelAlias', () => {
  const BASE_URL = 'https://cliproxy.example.com'
  const MGMT_KEY = 'secret-mgmt-key-do-not-log'

  const sampleAlias = {
    claude: [
      // name = dated upstream id, alias = short client-facing id
      {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true},
      {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-5', fork: true},
    ],
  }

  test('PUTs to the correct URL', async () => {
    let capturedUrl = ''
    const mockFetch = mock((url: string) => {
      capturedUrl = url
      return Promise.resolve(new Response(JSON.stringify({status: 'ok'}), {status: 200}))
    })

    await applyOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      body: sampleAlias,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(capturedUrl).toBe(`${BASE_URL}/v0/management/oauth-model-alias`)
  })

  test('uses PUT method', async () => {
    let capturedMethod = ''
    const mockFetch = mock((_url: string, init: RequestInit) => {
      capturedMethod = init.method ?? ''
      return Promise.resolve(new Response(JSON.stringify({status: 'ok'}), {status: 200}))
    })

    await applyOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      body: sampleAlias,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(capturedMethod).toBe('PUT')
  })

  test('sends x-management-key header', async () => {
    let capturedHeaders: Headers | undefined
    const mockFetch = mock((_url: string, init: RequestInit) => {
      capturedHeaders = init.headers as Headers
      return Promise.resolve(new Response(JSON.stringify({status: 'ok'}), {status: 200}))
    })

    await applyOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      body: sampleAlias,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(capturedHeaders?.get('x-management-key')).toBe(MGMT_KEY)
  })

  test('sends bare-object body — no value or oauth-model-alias wrapper key', async () => {
    let capturedBody: unknown
    const mockFetch = mock((_url: string, init: RequestInit) => {
      capturedBody = JSON.parse(init.body as string)
      return Promise.resolve(new Response(JSON.stringify({status: 'ok'}), {status: 200}))
    })

    await applyOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      body: sampleAlias,
      fetch: mockFetch as unknown as typeof fetch,
    })

    // The body IS the OAuthModelAlias object — no wrapper keys
    expect(capturedBody).toHaveProperty('claude')
    expect((capturedBody as Record<string, unknown>).value).toBeUndefined()
    expect((capturedBody as Record<string, unknown>)['oauth-model-alias']).toBeUndefined()
    expect((capturedBody as Record<string, unknown>).claude).toEqual(sampleAlias.claude)
  })

  test('throws on non-2xx with status and body text', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Internal Server Error', {status: 500})))

    await expect(
      applyOAuthModelAlias({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        body: sampleAlias,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500/)
  })

  test('management key does not appear in thrown error messages', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Forbidden', {status: 403})))

    let thrownMessage = ''
    try {
      await applyOAuthModelAlias({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        body: sampleAlias,
        fetch: mockFetch as unknown as typeof fetch,
      })
    } catch (error) {
      thrownMessage = error instanceof Error ? error.message : String(error)
    }

    expect(thrownMessage).not.toContain(MGMT_KEY)
    expect(thrownMessage.length).toBeGreaterThan(0)
  })
})

// ─── readBackOAuthModelAlias ──────────────────────────────────────────────────

describe('readBackOAuthModelAlias', () => {
  const BASE_URL = 'https://cliproxy.example.com'
  const MGMT_KEY = 'secret-mgmt-key'

  test('returns parsed alias from GET response', async () => {
    const responsePayload = {
      'oauth-model-alias': {
        // name = dated upstream id, alias = short client-facing id
        claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}],
      },
    }
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(responsePayload), {status: 200})))

    const result = await readBackOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(result.claude).toHaveLength(1)
    expect(result.claude[0]).toEqual({name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true})
  })

  test('returns empty alias when oauth-model-alias field is null', async () => {
    const responsePayload = {'oauth-model-alias': null}
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(responsePayload), {status: 200})))

    const result = await readBackOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(result.claude).toEqual([])
  })

  test('returns empty alias when oauth-model-alias field is absent', async () => {
    const responsePayload = {}
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(responsePayload), {status: 200})))

    const result = await readBackOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(result.claude).toEqual([])
  })

  test('GETs from the correct URL', async () => {
    let capturedUrl = ''
    const mockFetch = mock((url: string) => {
      capturedUrl = url
      return Promise.resolve(new Response(JSON.stringify({'oauth-model-alias': {claude: []}}), {status: 200}))
    })

    await readBackOAuthModelAlias({baseUrl: BASE_URL, key: MGMT_KEY, fetch: mockFetch as unknown as typeof fetch})
    expect(capturedUrl).toBe(`${BASE_URL}/v0/management/oauth-model-alias`)
  })

  test('throws on non-ok response (500)', async () => {
    const mockFetch = mock(() => Promise.resolve(new Response('Internal Server Error', {status: 500})))

    await expect(
      readBackOAuthModelAlias({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/GET .*oauth-model-alias failed with HTTP 500/)
  })

  test('throws on malformed JSON response', async () => {
    const mockFetch = mock(() =>
      Promise.resolve(new Response('not-valid-json{{{', {status: 200, headers: {'content-type': 'application/json'}})),
    )

    await expect(
      readBackOAuthModelAlias({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        fetch: mockFetch as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/returned malformed JSON/)
  })

  test('normalizes fork string "true" from server to boolean true', async () => {
    const responsePayload = {
      'oauth-model-alias': {
        // Server returns fork as string — must be normalized to boolean
        claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: 'true'}],
      },
    }
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(responsePayload), {status: 200})))

    const result = await readBackOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      fetch: mockFetch as unknown as typeof fetch,
    })
    expect(result.claude).toHaveLength(1)
    const entry = result.claude[0]
    if (!entry) throw new Error('Expected entry at index 0')
    expect(entry.fork).toBe(true)
    expect(typeof entry.fork).toBe('boolean')
  })

  test('string fork "true" from server matches boolean fork true in setEqualOAuthModelAlias', async () => {
    const desired = {
      claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}],
    }
    const responsePayload = {
      'oauth-model-alias': {
        claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: 'true'}],
      },
    }
    const mockFetch = mock(() => Promise.resolve(new Response(JSON.stringify(responsePayload), {status: 200})))

    const actual = await readBackOAuthModelAlias({
      baseUrl: BASE_URL,
      key: MGMT_KEY,
      fetch: mockFetch as unknown as typeof fetch,
    })
    // After normalization, set equality must hold
    expect(setEqualOAuthModelAlias(desired, actual)).toBe(true)
  })
})

// ─── setEqualOAuthModelAlias ──────────────────────────────────────────────────

describe('setEqualOAuthModelAlias', () => {
  const entry1 = {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}
  const entry2 = {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-5', fork: true}

  test('returns true for identical sets', () => {
    const a = {claude: [entry1, entry2]}
    const b = {claude: [entry1, entry2]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(true)
  })

  test('returns true for same entries in different order', () => {
    const a = {claude: [entry1, entry2]}
    const b = {claude: [entry2, entry1]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(true)
  })

  test('returns false when counts differ', () => {
    const a = {claude: [entry1, entry2]}
    const b = {claude: [entry1]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(false)
  })

  test('returns false when name differs', () => {
    const a = {claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}]}
    const b = {claude: [{name: 'claude-sonnet-4-6-20250514', alias: 'claude-sonnet-4-5', fork: true}]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(false)
  })

  test('returns false when alias differs', () => {
    const a = {claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}]}
    const b = {claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-999', fork: true}]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(false)
  })

  test('returns false when fork differs', () => {
    const a = {claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: true}]}
    const b = {claude: [{name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-5', fork: false}]}
    expect(setEqualOAuthModelAlias(a, b)).toBe(false)
  })

  test('returns true for two empty sets', () => {
    expect(setEqualOAuthModelAlias({claude: []}, {claude: []})).toBe(true)
  })
})

/** Await a promise that must reject and return its error message. */
async function messageOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected promise to reject')
}

// ─── openai-compatibility helpers ─────────────────────────────────────────────

describe('openai-compatibility helpers', () => {
  const BASE_URL = 'https://cliproxy.example.com'
  const MGMT_KEY = 'secret-mgmt-key-do-not-log'
  const UPSTREAM_KEY = 'sk-upstream-fixture-key-do-not-log'
  const ENDPOINT = `${BASE_URL}/v0/management/openai-compatibility`

  const tracked: OpenAICompatEntry = {
    name: 'opencode-go',
    prefix: 'opencode-go',
    'base-url': 'https://opencode.ai/inference/go/v1',
    'api-key-entries': [{'api-key': UPSTREAM_KEY}],
    models: [
      {name: 'glm-5.3', alias: 'glm-5.3'},
      {name: 'kimi-k2.6', alias: 'kimi-k2.6'},
    ],
    headers: {'x-opencode-session': '$X-Opencode-Session'},
    disabled: false,
  }

  /** Shape the server returns: `auth-index` added to each key entry, `disabled` always present. */
  const liveShape = {
    name: 'opencode-go',
    prefix: 'opencode-go',
    'base-url': 'https://opencode.ai/inference/go/v1',
    'api-key-entries': [{'api-key': UPSTREAM_KEY, 'auth-index': 'a1b2c3d4'}],
    models: [
      {name: 'kimi-k2.6', alias: 'kimi-k2.6'},
      {name: 'glm-5.3', alias: 'glm-5.3'},
    ],
    headers: {'x-opencode-session': '$X-Opencode-Session'},
    disabled: false,
  }

  interface Recorded {
    url: string
    init: RequestInit
  }

  function recordingFetch(respond: () => Response): {fetch: typeof fetch; calls: Recorded[]} {
    const calls: Recorded[] = []
    const fake = mock((url: string, init: RequestInit) => {
      calls.push({url, init})
      return Promise.resolve(respond())
    })
    return {fetch: fake as unknown as typeof fetch, calls}
  }

  function expectNoLeak(message: string): void {
    expect(message.length).toBeGreaterThan(0)
    expect(message).not.toContain(MGMT_KEY)
    expect(message).not.toContain(UPSTREAM_KEY)
  }

  describe('normalizeOpenAICompatEntry', () => {
    test('drops auth-index and defaults disabled to false', () => {
      const {disabled: _disabled, ...withoutDisabled} = liveShape
      const normalized = normalizeOpenAICompatEntry(withoutDisabled)
      expect(normalized.disabled).toBe(false)
      expect(normalized['api-key-entries']).toEqual([{'api-key': UPSTREAM_KEY}])
      expect(JSON.stringify(normalized)).not.toContain('auth-index')
    })

    test('defaults prefix, headers and model alias when absent', () => {
      const normalized = normalizeOpenAICompatEntry({
        name: 'x',
        'base-url': 'https://example.com/v1',
        'api-key-entries': [],
        models: [{name: 'm'}],
      })
      expect(normalized.prefix).toBe('')
      expect(normalized.headers).toEqual({})
      expect(normalized.models).toEqual([{name: 'm', alias: ''}])
    })

    test.each([
      ['not an object', 'nope', /openai-compatibility\[0\] is not an object/],
      ['missing name', {'base-url': 'https://e.com'}, /\.name is missing/],
      ['missing base-url', {name: 'x'}, /\.base-url is missing/],
      [
        'non-string api-key',
        {name: 'x', 'base-url': 'u', 'api-key-entries': [{'api-key': 7}]},
        /api-key-entries\[0\]\.api-key/,
      ],
      ['non-array models', {name: 'x', 'base-url': 'u', models: 'm'}, /\.models is not an array/],
      ['non-string header', {name: 'x', 'base-url': 'u', headers: {h: 1}}, /\.headers\.h is not a string/],
      ['non-boolean disabled', {name: 'x', 'base-url': 'u', disabled: 'yes'}, /\.disabled is not a boolean/],
    ])('throws on %s without echoing values', (_label, raw, pattern) => {
      expect(() => normalizeOpenAICompatEntry(raw)).toThrow(pattern)
    })

    test('error for a malformed key entry does not contain a sibling api-key value', () => {
      const raw = {
        name: 'x',
        'base-url': 'u',
        'api-key-entries': [{'api-key': UPSTREAM_KEY}, {'api-key': 7}],
      }
      let message = ''
      try {
        normalizeOpenAICompatEntry(raw)
      } catch (error) {
        message = error instanceof Error ? error.message : String(error)
      }
      expectNoLeak(message)
    })
  })

  describe('readBackOpenAICompat', () => {
    test('GETs the endpoint with the management key and unwraps and normalizes the list', async () => {
      const {fetch: fakeFetch, calls} = recordingFetch(
        () => new Response(JSON.stringify({'openai-compatibility': [liveShape]}), {status: 200}),
      )

      const result = await readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: fakeFetch})

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(ENDPOINT)
      expect(calls[0]?.init.method).toBe('GET')
      expect((calls[0]?.init.headers as Headers).get('x-management-key')).toBe(MGMT_KEY)
      expect(result).toHaveLength(1)
      expect(JSON.stringify(result)).not.toContain('auth-index')
      expect(result[0]?.disabled).toBe(false)
    })

    test.each([
      ['null', {'openai-compatibility': null}],
      ['absent', {}],
      ['empty', {'openai-compatibility': []}],
    ])('returns [] when the section is %s', async (_label, payload) => {
      const {fetch: fakeFetch} = recordingFetch(() => new Response(JSON.stringify(payload), {status: 200}))
      expect(await readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: fakeFetch})).toEqual([])
    })

    test('throws on a non-2xx and the message carries no key value', async () => {
      const {fetch: fakeFetch} = recordingFetch(() => new Response(`denied for ${MGMT_KEY}`, {status: 403}))
      const message = await messageOf(readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: fakeFetch}))
      expect(message).toMatch(/GET .*openai-compatibility failed with HTTP 403/)
      expectNoLeak(message)
    })

    test('throws on malformed JSON and the message carries no key value', async () => {
      const {fetch: fakeFetch} = recordingFetch(() => new Response(`{"api-key": "${UPSTREAM_KEY}`, {status: 200}))
      const message = await messageOf(readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: fakeFetch}))
      expect(message).toContain('malformed JSON')
      expectNoLeak(message)
    })

    test('throws on a non-object payload and on a non-array section', async () => {
      const arrayPayload = recordingFetch(() => new Response('[]', {status: 200}))
      expect(
        await messageOf(readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: arrayPayload.fetch})),
      ).toContain('unexpected shape')

      const stringSection = recordingFetch(
        () => new Response(JSON.stringify({'openai-compatibility': UPSTREAM_KEY}), {status: 200}),
      )
      const message = await messageOf(
        readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: stringSection.fetch}),
      )
      expect(message).toContain('not an array')
      expectNoLeak(message)
    })

    test('throws on a malformed entry naming the field, not the value', async () => {
      const bad = {...liveShape, 'api-key-entries': [{'api-key': UPSTREAM_KEY}, {'api-key': null}]}
      const {fetch: fakeFetch} = recordingFetch(
        () => new Response(JSON.stringify({'openai-compatibility': [bad]}), {status: 200}),
      )
      const message = await messageOf(readBackOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, fetch: fakeFetch}))
      expect(message).toContain('openai-compatibility[0].api-key-entries[1].api-key')
      expectNoLeak(message)
    })
  })

  describe('applyOpenAICompat', () => {
    test('PUTs a bare array equal to the tracked entry', async () => {
      const {fetch: fakeFetch, calls} = recordingFetch(() => new Response('{"status":"ok"}', {status: 200}))

      await applyOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, body: [tracked], fetch: fakeFetch})

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(ENDPOINT)
      expect(calls[0]?.init.method).toBe('PUT')
      expect((calls[0]?.init.headers as Headers).get('x-management-key')).toBe(MGMT_KEY)
      expect(JSON.parse(calls[0]?.init.body as string)).toEqual([tracked])
    })

    test('throws on an empty list before sending any request', async () => {
      const {fetch: fakeFetch, calls} = recordingFetch(() => new Response('{}', {status: 200}))

      const message = await messageOf(applyOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, body: [], fetch: fakeFetch}))

      expect(calls).toHaveLength(0)
      expect(message).toContain('empty')
      expectNoLeak(message)
    })

    test.each([400, 500])('throws on HTTP %d and the message carries no key value', async status => {
      // A hostile/verbose server echoes the request secrets back in its error body.
      const {fetch: fakeFetch} = recordingFetch(
        () => new Response(`bad entry ${UPSTREAM_KEY} via ${MGMT_KEY}`, {status}),
      )

      const message = await messageOf(
        applyOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, body: [tracked], fetch: fakeFetch}),
      )

      expect(message).toContain(`HTTP ${status}`)
      expect(message).toContain('[redacted]')
      expectNoLeak(message)
    })

    test('truncates a long error body', async () => {
      const {fetch: fakeFetch} = recordingFetch(() => new Response('x'.repeat(5000), {status: 500}))
      const message = await messageOf(
        applyOpenAICompat({baseUrl: BASE_URL, key: MGMT_KEY, body: [tracked], fetch: fakeFetch}),
      )
      expect(message.length).toBeLessThan(400)
    })
  })

  describe('patchOpenAICompatDisabled', () => {
    test('PATCH disable body is exactly {name, value: {disabled: true}}', async () => {
      const {fetch: fakeFetch, calls} = recordingFetch(() => new Response('{"status":"ok"}', {status: 200}))

      await patchOpenAICompatDisabled({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        name: 'opencode-go',
        disabled: true,
        fetch: fakeFetch,
      })

      expect(calls).toHaveLength(1)
      expect(calls[0]?.url).toBe(ENDPOINT)
      expect(calls[0]?.init.method).toBe('PATCH')
      expect((calls[0]?.init.headers as Headers).get('x-management-key')).toBe(MGMT_KEY)
      expect(JSON.parse(calls[0]?.init.body as string)).toEqual({name: 'opencode-go', value: {disabled: true}})
    })

    test('can re-enable with disabled: false', async () => {
      const {fetch: fakeFetch, calls} = recordingFetch(() => new Response('{}', {status: 200}))
      await patchOpenAICompatDisabled({
        baseUrl: BASE_URL,
        key: MGMT_KEY,
        name: 'opencode-go',
        disabled: false,
        fetch: fakeFetch,
      })
      expect(JSON.parse(calls[0]?.init.body as string)).toEqual({name: 'opencode-go', value: {disabled: false}})
    })

    test.each([404, 500])('throws on HTTP %d and the message carries no key value', async status => {
      const {fetch: fakeFetch} = recordingFetch(() => new Response(`no such entry; key ${MGMT_KEY}`, {status}))
      const message = await messageOf(
        patchOpenAICompatDisabled({
          baseUrl: BASE_URL,
          key: MGMT_KEY,
          name: 'opencode-go',
          disabled: true,
          fetch: fakeFetch,
        }),
      )
      expect(message).toContain(`HTTP ${status}`)
      expectNoLeak(message)
    })
  })

  describe('setEqualOpenAICompat', () => {
    test('a readback carrying auth-index and disabled: false equals the tracked entry', () => {
      const {disabled: _disabled, ...trackedWithoutDisabled} = tracked
      const live = [normalizeOpenAICompatEntry(liveShape)]
      expect(setEqualOpenAICompat([trackedWithoutDisabled], live)).toBe(true)
      expect(setEqualOpenAICompat([tracked], live)).toBe(true)
    })

    test('models in a different order compare equal', () => {
      const reordered = {...tracked, models: [...tracked.models].reverse()}
      expect(setEqualOpenAICompat([tracked], [reordered])).toBe(true)
    })

    test('headers compare as a map regardless of key order', () => {
      const a = {...tracked, headers: {a: '1', b: '2'}}
      const b = {...tracked, headers: {b: '2', a: '1'}}
      expect(setEqualOpenAICompat([a], [b])).toBe(true)
    })

    test('header value, extra header and missing header differences are unequal', () => {
      expect(setEqualOpenAICompat([tracked], [{...tracked, headers: {'x-opencode-session': 'other'}}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, headers: {...tracked.headers, extra: '1'}}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, headers: {}}])).toBe(false)
    })

    test('a differing model alias, a missing model or an extra model is unequal', () => {
      const glm = {name: 'glm-5.3', alias: 'glm-5.3'}
      const kimi = {name: 'kimi-k2.6', alias: 'kimi-k2.6'}
      expect(setEqualOpenAICompat([tracked], [{...tracked, models: [{name: 'glm-5.3', alias: 'other'}, kimi]}])).toBe(
        false,
      )
      expect(setEqualOpenAICompat([tracked], [{...tracked, models: [glm]}])).toBe(false)
      expect(
        setEqualOpenAICompat([tracked], [{...tracked, models: [...tracked.models, {name: 'x', alias: 'x'}]}]),
      ).toBe(false)
    })

    test('a differing api-key, base-url, prefix or disabled flag is unequal', () => {
      expect(setEqualOpenAICompat([tracked], [{...tracked, 'api-key-entries': [{'api-key': 'rotated'}]}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, 'base-url': 'https://other.example/v1'}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, prefix: 'other'}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, disabled: true}])).toBe(false)
    })

    test('lists of different length, name, or an empty vs non-empty list are unequal', () => {
      expect(setEqualOpenAICompat([tracked], [])).toBe(false)
      expect(setEqualOpenAICompat([], [tracked])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [{...tracked, name: 'other'}])).toBe(false)
      expect(setEqualOpenAICompat([tracked], [tracked, {...tracked, name: 'extra'}])).toBe(false)
    })

    test('two empty lists are equal', () => {
      expect(setEqualOpenAICompat([], [])).toBe(true)
    })
  })
})
