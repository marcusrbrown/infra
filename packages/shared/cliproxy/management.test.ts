import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test'
import {parse as parseYaml} from 'yaml'

import {
  applyOAuthModelAlias,
  applyPayloadOverride,
  CLEAR_THINKING_RULE_MARKER,
  hashRawConfig,
  managementHeaders,
  mergePayloadOverride,
  parseClaudeEntries,
  parseManagementKeyList,
  payloadOverrideMatchesModel,
  putRawConfig,
  readBackOAuthModelAlias,
  readOAuthModelAliasFromConfig,
  readPayloadOverrideFromConfig,
  readRawConfig,
  requestJson,
  restoreRawConfig,
  setEqualOAuthModelAlias,
  summarizeRawConfig,
  toStringArray,
} from './management'

const CLEAR_THINKING_CONFIG = `
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models:
        - name: claude-opus-4-8
          protocol: claude
        - name: claude-sonnet-4-6
          protocol: claude
      params:
        context_management: {edits: []}
`.trim()

describe('readPayloadOverrideFromConfig', () => {
  test('extracts only the marked clear-thinking override fragment', () => {
    const configPath = join(tmpdir(), `cliproxy-desired-${Date.now()}.yaml`)
    writeFileSync(configPath, CLEAR_THINKING_CONFIG)

    try {
      expect(readPayloadOverrideFromConfig(configPath)).toEqual({
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      })
    } finally {
      rmSync(configPath, {force: true})
    }
  })

  test('returns null when the config has no payload key', () => {
    const configPath = join(tmpdir(), `cliproxy-no-payload-${Date.now()}.yaml`)
    writeFileSync(configPath, 'auth-dir: /root/.cli-proxy-api\napi-keys: []\n')

    try {
      expect(readPayloadOverrideFromConfig(configPath)).toBeNull()
    } finally {
      rmSync(configPath, {force: true})
    }
  })

  test('returns null when payload exists without an override key', () => {
    const configPath = join(tmpdir(), `cliproxy-no-override-${Date.now()}.yaml`)
    writeFileSync(configPath, 'auth-dir: /root/.cli-proxy-api\napi-keys: []\npayload: {unknown: true}\n')

    try {
      expect(readPayloadOverrideFromConfig(configPath)).toBeNull()
    } finally {
      rmSync(configPath, {force: true})
    }
  })

  test('rejects a tracked rule that broadens beyond the two proven model names', () => {
    const configPath = join(tmpdir(), `cliproxy-broad-rule-${Date.now()}.yaml`)
    writeFileSync(
      configPath,
      CLEAR_THINKING_CONFIG.replace('claude-opus-4-8', 'claude-*').replace('claude-sonnet-4-6', 'claude-sonnet-5'),
    )

    try {
      expect(() => readPayloadOverrideFromConfig(configPath)).toThrow(/exact affected models/)
    } finally {
      rmSync(configPath, {force: true})
    }
  })
})

describe('payloadOverrideMatchesModel', () => {
  test('matches only the exact affected models and case-insensitive claude protocol', () => {
    const rule = {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    }

    expect(payloadOverrideMatchesModel(rule, 'claude-opus-4-8', 'CLAUDE')).toBe(true)
    expect(payloadOverrideMatchesModel(rule, 'claude-sonnet-4-6', 'claude')).toBe(true)
    expect(payloadOverrideMatchesModel(rule, 'claude-sonnet-5', 'claude')).toBe(false)
    expect(payloadOverrideMatchesModel(rule, 'claude-opus-4-8', 'openai')).toBe(false)
  })

  test('treats only * as a model wildcard and requires every entry condition', () => {
    const rule = {
      models: [{name: 'claude-*', protocol: 'claude'}],
      params: {context_management: {edits: []}},
    }

    expect(payloadOverrideMatchesModel(rule, 'claude-sonnet-5', 'claude')).toBe(true)
    expect(payloadOverrideMatchesModel(rule, 'claude.+', 'claude')).toBe(false)
    expect(payloadOverrideMatchesModel(rule, 'claude-sonnet-5', 'openai')).toBe(false)
  })
})

describe('raw management config helpers', () => {
  test('hashes exact raw config bytes with SHA-256', () => {
    expect(hashRawConfig('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })

  test('reads the raw YAML body with the management header and no parsing', async () => {
    let capturedHeaders: Headers | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers)
      return new Response('api-keys: [live-secret]\n', {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      readRawConfig({baseUrl: 'https://cliproxy.example.com', key: 'management-secret', fetch: fetchFn}),
    ).resolves.toBe('api-keys: [live-secret]\n')
    expect(capturedHeaders?.get('x-management-key')).toBe('management-secret')
  })

  test('restore accepts the apply result hash instead of a secret-bearing intended document', async () => {
    const snapshot = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\n'
    let current = snapshot
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        current = typeof init?.body === 'string' ? init.body : current
        return new Response('', {status: 200})
      }
      return new Response(current, {status: 200})
    }) as unknown as typeof globalThis.fetch

    const applyResult = await applyPayloadOverride({
      baseUrl: 'https://cliproxy.example.com',
      key: 'management-secret',
      desired: {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      },
      fetch: fetchFn,
    })

    await expect(
      restoreRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        snapshot,
        intendedHash: applyResult.afterHash,
        fetch: fetchFn,
      }),
    ).resolves.toEqual({state: 'restored'})
    expect(applyResult.changed).toBe(true)
    expect(methods.filter(method => method === 'PUT')).toHaveLength(2)
  })

  test('restore rejects a final readback mismatch without exposing YAML or credentials', async () => {
    const snapshot = 'snapshot-secret-yaml\n'
    const intended = 'intended-secret-yaml\n'
    const mismatch = 'mismatch-secret-yaml\n'
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === 'PUT') return new Response('', {status: 200})
      getCount++
      return new Response(getCount === 1 ? intended : mismatch, {status: 200})
    }) as unknown as typeof globalThis.fetch

    let message = ''
    try {
      await restoreRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        snapshot,
        intendedHash: hashRawConfig(intended),
        fetch: fetchFn,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('restore readback')
    expect(message).not.toContain(snapshot)
    expect(message).not.toContain(intended)
    expect(message).not.toContain('management-secret')
  })

  test('writes the exact raw YAML body and sanitizes HTTP failures', async () => {
    let capturedBody = ''
    let capturedHeaders: Headers | undefined
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      capturedBody = typeof init?.body === 'string' ? init.body : ''
      capturedHeaders = new Headers(init?.headers)
      return new Response('contains-live-secret-and-management-secret', {status: 503})
    }) as unknown as typeof globalThis.fetch

    await expect(
      putRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        body: 'api-keys: [live-secret]\n',
        fetch: fetchFn,
      }),
    ).rejects.toThrow('PUT /v0/management/config.yaml failed with HTTP 503')
    expect(capturedBody).toBe('api-keys: [live-secret]\n')
    expect(capturedHeaders?.get('x-management-key')).toBe('management-secret')
    expect(capturedHeaders?.get('content-type')).toBe('application/yaml')
  })

  test('never includes raw config or management key in a raw request error', async () => {
    const fetchFn = mock(
      async () => new Response('api-keys: [live-secret]\nmanagement-secret', {status: 500}),
    ) as unknown as typeof globalThis.fetch

    let message = ''
    try {
      await readRawConfig({baseUrl: 'https://cliproxy.example.com', key: 'management-secret', fetch: fetchFn})
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toContain('HTTP 500')
    expect(message).not.toContain('live-secret')
    expect(message).not.toContain('management-secret')
  })

  test('applies one PUT and verifies the exact owned rule on raw readback', async () => {
    const liveYaml = `api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload:\n  override: []\n`
    const requests: {method: string; body?: string}[] = []
    let candidate = ''
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push({method, body})
      if (method === 'PUT') {
        candidate = body ?? ''
        return new Response('', {status: 200})
      }
      getCount++
      return new Response(getCount === 3 ? candidate : liveYaml, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: true})
    expect(requests.filter(request => request.method === 'PUT')).toHaveLength(1)
    expect(getCount).toBe(3)
    expect(candidate).toContain(CLEAR_THINKING_RULE_MARKER)
  })

  test('first apply accepts a live config without payload scaffolding', async () => {
    let current = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\n'
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        current = typeof init?.body === 'string' ? init.body : current
        return new Response('', {status: 200})
      }
      return new Response(current, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: true})
    expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
  })

  test('first apply accepts a live config with payload but without payload.override', async () => {
    let current = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload: {unknown: true}\n'
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        current = typeof init?.body === 'string' ? init.body : current
        return new Response('', {status: 200})
      }
      return new Response(current, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: true})
    expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
  })

  test('first-apply result can be rerun idempotently without another PUT', async () => {
    let current = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\n'
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        current = typeof init?.body === 'string' ? init.body : current
        return new Response('', {status: 200})
      }
      return new Response(current, {status: 200})
    }) as unknown as typeof globalThis.fetch
    const desired = {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    }

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired,
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: true})
    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired,
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: false})
    expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
  })

  test('apply rejects broad targeting before GET or PUT', async () => {
    const fetchFn = mock(
      async () => new Response('network must not be reached', {status: 200}),
    ) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-*', protocol: 'claude'},
            {name: 'claude-sonnet-*', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/exact affected models/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('apply rejects a single exact target model before GET or PUT', async () => {
    const fetchFn = mock(
      async () => new Response('network must not be reached', {status: 200}),
    ) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [{name: 'claude-opus-4-8', protocol: 'claude'}],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/exact affected models/)
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('idempotent apply performs no PUT when the live managed rule already matches', async () => {
    const liveYaml =
      'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload:\n  override:\n    - # managed-by: infra/cliproxy-clear-thinking\n      models:\n        - name: claude-opus-4-8\n          protocol: claude\n        - name: claude-sonnet-4-6\n          protocol: claude\n      params:\n        context_management: {edits: []}\n'
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response(liveYaml, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).resolves.toMatchObject({changed: false})
    expect(methods).toEqual(['GET'])
  })

  test('aborts on an exact raw-body hash drift before issuing PUT', async () => {
    const liveYaml = `api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload:\n  override: []\n`
    const driftedYaml = `${liveYaml}# changed concurrently\n`
    const methods: string[] = []
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') return new Response('', {status: 200})
      getCount++
      return new Response(getCount === 1 ? liveYaml : driftedYaml, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/changed concurrently before PUT/)
    expect(methods.filter(method => method === 'PUT')).toHaveLength(0)
  })

  test('rejects malformed readback without exposing raw config or credentials', async () => {
    const liveYaml = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload: {override: []}\n'
    const methods: string[] = []
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') return new Response('server accepted live-client-key', {status: 200})
      getCount++
      return new Response(getCount === 3 ? 'api-keys: [REDACTED]\nauth-dir: /wrong\n' : liveYaml, {status: 200})
    }) as unknown as typeof globalThis.fetch

    let message = ''
    try {
      await applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      })
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }

    expect(message).toMatch(/api-keys|auth-dir|readback|refusing/)
    expect(message).not.toContain('live-client-key')
    expect(message).not.toContain('management-secret')
    expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
  })

  test('rejects readback that changes an unrelated opaque field', async () => {
    const liveYaml =
      'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\nunknown: !!str "001"\npayload: {override: []}\n'
    const methods: string[] = []
    let candidate = ''
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        candidate = typeof init?.body === 'string' ? init.body : ''
        return new Response('', {status: 200})
      }
      getCount++
      const readback = candidate.replace('unknown: !!str "001"', 'unknown: !!str "002"')
      return new Response(getCount === 3 ? readback : liveYaml, {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/opaque state|runtime invariants/)
    expect(methods.filter(method => method === 'PUT')).toHaveLength(1)
  })

  test('rejects ambiguous runtime state before PUT', async () => {
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response('api-keys: [REDACTED]\nauth-dir: /root/.cli-proxy-api\npayload: {override: []}\n', {
        status: 200,
      })
    }) as unknown as typeof globalThis.fetch

    await expect(
      applyPayloadOverride({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        desired: {
          models: [
            {name: 'claude-opus-4-8', protocol: 'claude'},
            {name: 'claude-sonnet-4-6', protocol: 'claude'},
          ],
          params: {context_management: {edits: []}},
        },
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/invalid or masked entry/)
    expect(methods).toEqual(['GET'])
  })

  test('restore is a no-op when current bytes already equal the snapshot', async () => {
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response('snapshot-yaml\n', {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      restoreRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        snapshot: 'snapshot-yaml\n',
        intendedHash: hashRawConfig('intended-yaml\n'),
        fetch: fetchFn,
      }),
    ).resolves.toEqual({state: 'noop'})
    expect(methods).toEqual(['GET'])
  })

  test('restore writes the exact snapshot only from the known successful-state hash', async () => {
    const methods: string[] = []
    const bodies: string[] = []
    let getCount = 0
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      methods.push(method)
      if (method === 'PUT') {
        bodies.push(typeof init?.body === 'string' ? init.body : '')
        return new Response('', {status: 200})
      }
      getCount++
      return new Response(getCount === 1 ? 'intended-yaml\n' : 'snapshot-yaml\n', {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      restoreRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        snapshot: 'snapshot-yaml\n',
        intendedHash: hashRawConfig('intended-yaml\n'),
        fetch: fetchFn,
      }),
    ).resolves.toEqual({state: 'restored'})
    expect(methods).toEqual(['GET', 'PUT', 'GET'])
    expect(bodies).toEqual(['snapshot-yaml\n'])
  })

  test('restore halts without PUT from an unknown third state', async () => {
    const methods: string[] = []
    const fetchFn = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      methods.push(init?.method ?? 'GET')
      return new Response('third-state-yaml\n', {status: 200})
    }) as unknown as typeof globalThis.fetch

    await expect(
      restoreRawConfig({
        baseUrl: 'https://cliproxy.example.com',
        key: 'management-secret',
        snapshot: 'snapshot-yaml\n',
        intendedHash: hashRawConfig('intended-yaml\n'),
        fetch: fetchFn,
      }),
    ).rejects.toThrow(/third state/)
    expect(methods).toEqual(['GET'])
  })
})

describe('mergePayloadOverride', () => {
  test('summarizes runtime invariants without exposing key values', () => {
    const summary = summarizeRawConfig(
      'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\noauth-model-alias: {claude: []}\npayload: {override: []}\n',
    )

    expect(summary).toEqual({
      apiKeyCount: 1,
      oauthModelAliasEntryCount: 0,
      payloadOverrideCount: 0,
    })
    expect(JSON.stringify(summary)).not.toContain('live-client-key')
  })

  test.each([
    ['missing api-keys', 'auth-dir: /root/.cli-proxy-api\npayload: {override: []}\n'],
    ['empty api-keys', 'api-keys: []\nauth-dir: /root/.cli-proxy-api\npayload: {override: []}\n'],
    ['masked api-key', 'api-keys: [REDACTED]\nauth-dir: /root/.cli-proxy-api\npayload: {override: []}\n'],
    ['wrong auth-dir', 'api-keys: [live-client-key]\nauth-dir: /wrong\npayload: {override: []}\n'],
    [
      'malformed payload override',
      'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\npayload: {override: nope}\n',
    ],
  ])('fails closed for %s runtime state', (_name, liveYaml) => {
    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/refusing to mutate/)
  })

  test('rejects duplicate YAML keys and warnings before mutation', () => {
    const duplicateKeys = 'api-keys: [live-client-key]\nauth-dir: /root/.cli-proxy-api\nauth-dir: /wrong\n'
    expect(() =>
      mergePayloadOverride(duplicateKeys, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/malformed or ambiguous/)
  })

  test('appends the marked rule without importing tracked runtime fields', () => {
    const liveYaml = `
api-keys:
  - live-client-key
auth-dir: /root/.cli-proxy-api
oauth-model-alias:
  claude:
    - name: claude-sonnet-5
      alias: sonnet-control
      fork: true
payload:
  override:
    - models:
        - name: claude-sonnet-5
          protocol: claude
      params:
        context_management: {edits: []}
unrelated: &anchor 001
alias-value: *anchor
`.trim()

    const result = mergePayloadOverride(liveYaml, {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    })

    expect(result.changed).toBe(true)
    expect(result.body).toContain(CLEAR_THINKING_RULE_MARKER)
    expect(result.body).not.toContain('tracked-secret')
    expect(result.body).toContain('live-client-key')
    expect(result.body).toContain('auth-dir: /root/.cli-proxy-api')
    const preserved = parseYaml(result.body) as Record<string, unknown>
    expect(preserved.unrelated).toBe(1)
    expect(result.body).toContain('alias-value: *anchor')
  })

  test('allows an earlier broad override because the managed rule is the later write', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - models: [{name: '*', protocol: claude}]
      params: {context_management: {edits: [{type: earlier}]}}
`.trim()

    const result = mergePayloadOverride(liveYaml, {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    })

    const parsed = parseYaml(result.body) as {payload: {override: {models: {name: string}[]}[]}}
    expect(parsed.payload.override.map(rule => rule.models[0]?.name)).toEqual(['*', 'claude-opus-4-8'])
  })

  test('fails closed when a later unowned override writes context_management for a target', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
    - models: [{name: 'claude-*', protocol: claude}]
      params: {context_management: {edits: [{type: later}]}}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/later.*override|last-write|dominance/)
  })

  test('treats a matching wildcard model rule with omitted protocol as a conflict', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
    - models: [{name: 'claude-*'}]
      params: {context_management: {edits: [{type: later}]}}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/later.*override|last-write|dominance/)
  })

  test('fails closed when a later override writes a descendant context_management path', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
    - models: [{name: claude-opus-4-8, protocol: CLAUDE}]
      params: {'context_management.edits': [{type: later}]}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/later.*override|last-write|dominance/)
  })

  test('fails closed when a matching override-raw rule writes context_management', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
  override-raw:
    - models: [{name: '*', protocol: claude}]
      params: {context_management: '{"edits":[{"type":"raw"}]}' }
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/override-raw|last-write|dominance/)
  })

  test('fails closed when a matching filter removes context_management', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
  filter:
    - models: [{name: '*', protocol: claude}]
      params: [context_management.edits]
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/filter|last-write|dominance/)
  })

  test('returns the exact live bytes unchanged when the managed rule already matches', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models:
        - name: claude-opus-4-8
          protocol: CLAUDE
        - name: claude-sonnet-4-6
          protocol: claude
      params:
        context_management: {edits: []}
`.trim()

    const result = mergePayloadOverride(liveYaml, {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    })

    expect(result.changed).toBe(false)
    expect(result.body).toBe(liveYaml)
  })

  test.each([
    'prefix managed-by: infra/cliproxy-clear-thinking',
    'not managed-by: infra/cliproxy-clear-thinking',
    'managed-by: infra/cliproxy-clear-thinking with prose',
  ])('does not treat comment camouflage as the managed marker: %s', camouflage => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # ${camouflage}
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/equivalent unmarked clear-thinking rule/)
  })

  test('accepts whitespace around an exact managed marker comment line', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - #   managed-by: infra/cliproxy-clear-thinking${' '.repeat(2)}
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
`.trim()

    expect(
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toEqual({body: liveYaml, changed: false})
  })

  test('merge rejects broad targeting before parsing live YAML', () => {
    expect(() =>
      mergePayloadOverride('not: [valid: yaml', {
        models: [
          {name: 'claude-opus-*', protocol: 'claude'},
          {name: 'claude-sonnet-*', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/exact affected models/)
  })

  test('merge rejects a single exact target model before parsing live YAML', () => {
    expect(() =>
      mergePayloadOverride('not: [valid: yaml', {
        models: [{name: 'claude-opus-4-8', protocol: 'claude'}],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/exact affected models/)
  })

  test('fails closed when two sequence items carry the managed marker', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: []}}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/duplicate managed clear-thinking markers/)
  })

  test('fails closed when an equivalent unmarked rule already exists', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - models:
        - name: claude-opus-4-8
          protocol: CLAUDE
        - name: claude-sonnet-4-6
          protocol: claude
      params: {context_management: {edits: []}}
`.trim()

    expect(() =>
      mergePayloadOverride(liveYaml, {
        models: [
          {name: 'claude-opus-4-8', protocol: 'claude'},
          {name: 'claude-sonnet-4-6', protocol: 'claude'},
        ],
        params: {context_management: {edits: []}},
      }),
    ).toThrow(/equivalent unmarked clear-thinking rule/)
  })

  test('updates the uniquely marked drifted rule in place and leaves unrelated rule order intact', () => {
    const liveYaml = `
api-keys: [live-client-key]
auth-dir: /root/.cli-proxy-api
payload:
  override:
    - models: [{name: unrelated-model, protocol: openai}]
      params: {temperature: 0}
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: [{type: stale}]}}
    - models: [{name: another-unrelated-model, protocol: claude}]
      params: {temperature: 1}
`.trim()

    const result = mergePayloadOverride(liveYaml, {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    })

    expect(result.changed).toBe(true)
    const parsed = parseYaml(result.body) as {
      payload: {override: {models: {name: string}[]; params: Record<string, unknown>}[]}
    }
    expect(parsed.payload.override.map(item => item.models[0]?.name)).toEqual([
      'unrelated-model',
      'claude-opus-4-8',
      'another-unrelated-model',
    ])
    expect(parsed.payload.override[1]?.params).toEqual({context_management: {edits: []}})
  })

  test('preserves unrelated comments, tags, anchors, aliases, scalar types, and sequence order', () => {
    const liveYaml = `
# operator-owned comment
api-keys: [live-client-key]
auth-dir: !!str /root/.cli-proxy-api
unknown-tagged: !!str "001"
shared-value: &shared !!str "opaque"
shared-alias: *shared
payload:
  override:
    # unrelated rule must stay first
    - models: [{name: !!str unrelated-model, protocol: openai}]
      params: {temperature: !!int 0}
    - # managed-by: infra/cliproxy-clear-thinking
      models: [{name: claude-opus-4-8, protocol: claude}, {name: claude-sonnet-4-6, protocol: claude}]
      params: {context_management: {edits: [{type: stale}]}}
`.trim()

    const result = mergePayloadOverride(liveYaml, {
      models: [
        {name: 'claude-opus-4-8', protocol: 'claude'},
        {name: 'claude-sonnet-4-6', protocol: 'claude'},
      ],
      params: {context_management: {edits: []}},
    })

    expect(result.body).toContain('# operator-owned comment')
    expect(result.body).toContain('unknown-tagged: !!str "001"')
    expect(result.body).toContain('shared-value: &shared !!str "opaque"')
    expect(result.body).toContain('shared-alias: *shared')
    expect(result.body).toContain('# unrelated rule must stay first')
    const parsed = parseYaml(result.body) as {
      payload: {override: {models: {name: string}[]}[]}
    }
    expect(parsed.payload.override[0]?.models[0]?.name).toBe('unrelated-model')
    expect(parsed.payload.override[1]?.models[0]?.name).toBe('claude-opus-4-8')
  })
})

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
