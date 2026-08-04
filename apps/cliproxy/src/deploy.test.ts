import {mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test'

import {applyOAuthModelAliasStep, deploy, preflightManagementKeyCheck} from './deploy'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** The 7-entry alias block matching apps/cliproxy/config/config.yaml */
const ALIAS_YAML = `
host: ''
port: 8317
auth-dir: /root/.cli-proxy-api
remote-management:
  allow-remote: true
  secret-key: ''
api-keys: []
claude-api-key: []
debug: false
oauth-model-alias:
  claude:
    - name: claude-3-5-haiku-20241022
      alias: claude-3-5-haiku-latest
      fork: true
    - name: claude-haiku-4-5-20251001
      alias: claude-haiku-4-5
      fork: true
    - name: claude-opus-4-20250514
      alias: claude-opus-4-0
      fork: true
    - name: claude-opus-4-1-20250805
      alias: claude-opus-4-1
      fork: true
    - name: claude-opus-4-5-20251101
      alias: claude-opus-4-5
      fork: true
    - name: claude-sonnet-4-20250514
      alias: claude-sonnet-4-0
      fork: true
    - name: claude-sonnet-4-5-20250929
      alias: claude-sonnet-4-5
      fork: true
`

/** Config with no oauth-model-alias block */
const EMPTY_ALIAS_YAML = `
host: ''
port: 8317
auth-dir: /root/.cli-proxy-api
remote-management:
  allow-remote: true
  secret-key: ''
api-keys: []
`

const PAYLOAD_OVERRIDE_YAML = `
host: ''
port: 8317
auth-dir: /root/.cli-proxy-api
remote-management:
  allow-remote: true
  secret-key: ''
api-keys: []
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
`

const ALIAS_WITH_PAYLOAD_YAML = `${ALIAS_YAML.trimEnd()}
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
`

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeDeployEnv(overrides: Partial<{CLIPROXY_DOMAIN: string; CLIPROXY_MANAGEMENT_KEY: string}> = {}): {
  CLIPROXY_DOMAIN: string
  CLIPROXY_MANAGEMENT_KEY: string
  PATH: string
  HOME: string
  SSH_AUTH_SOCK: string
  [key: string]: string
} {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    CLIPROXY_DOMAIN: 'cliproxy.fro.bot',
    CLIPROXY_MANAGEMENT_KEY: 'test-management-key',
    ...overrides,
  }
}

/** No-op sleep for tests — avoids real delays in retry logic. */
const noopSleep = async (_ms: number): Promise<void> => {}

/** Build a mock fetch that handles PUT and GET for oauth-model-alias. */
function makeAliasFetch(
  opts: {
    putStatus?: number
    getResponse?: unknown
    modelsResponse?: unknown
    modelsStatus?: number
    captureRequests?: boolean
  } = {},
): {fetchFn: typeof globalThis.fetch; requests: {method: string; url: string; body?: string}[]} {
  const requests: {method: string; url: string; body?: string}[] = []

  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({method, url: urlStr, body})

    if (urlStr.includes('/v0/management/oauth-model-alias')) {
      if (method === 'PUT') {
        return new Response(JSON.stringify({status: 'ok'}), {status: opts.putStatus ?? 200})
      }
      if (method === 'GET') {
        const payload = opts.getResponse ?? {
          'oauth-model-alias': {
            claude: [
              {name: 'claude-3-5-haiku-20241022', alias: 'claude-3-5-haiku-latest', fork: true},
              {name: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5', fork: true},
              {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: true},
              {name: 'claude-opus-4-1-20250805', alias: 'claude-opus-4-1', fork: true},
              {name: 'claude-opus-4-5-20251101', alias: 'claude-opus-4-5', fork: true},
              {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true},
              {name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true},
            ],
          },
        }
        return new Response(JSON.stringify(payload), {status: 200})
      }
    }

    if (urlStr.includes('/v1/models')) {
      const payload = opts.modelsResponse ?? {
        data: [
          {id: 'claude-3-5-haiku-20241022'},
          {id: 'claude-3-5-haiku-latest'},
          {id: 'claude-haiku-4-5-20251001'},
          {id: 'claude-haiku-4-5'},
          {id: 'claude-opus-4-20250514'},
          {id: 'claude-opus-4-0'},
          {id: 'claude-opus-4-1-20250805'},
          {id: 'claude-opus-4-1'},
          {id: 'claude-opus-4-5-20251101'},
          {id: 'claude-opus-4-5'},
          {id: 'claude-sonnet-4-20250514'},
          {id: 'claude-sonnet-4-0'},
          {id: 'claude-sonnet-4-5-20250929'},
          {id: 'claude-sonnet-4-5'},
        ],
      }
      return new Response(JSON.stringify(payload), {status: opts.modelsStatus ?? 200})
    }

    return new Response('Not Found', {status: 404})
  }) as unknown as typeof globalThis.fetch

  return {fetchFn, requests}
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let tmpDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cliproxy-deploy-test-'))
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
  // Clean up any CLIPROXY_API_KEY set during tests
  delete process.env.CLIPROXY_API_KEY
})

// ─── preflightManagementKeyCheck ──────────────────────────────────────────────

describe('preflightManagementKeyCheck', () => {
  test('throws early when key is empty and alias block is non-empty', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})

    await expect(preflightManagementKeyCheck(env, {config: configPath})).rejects.toThrow(
      /oauth-model-alias block present.*CLIPROXY_MANAGEMENT_KEY is not set/,
    )
  })

  test('early-throw message does not contain any key value', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})

    let errorMessage = ''
    try {
      await preflightManagementKeyCheck(env, {config: configPath})
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('CLIPROXY_MANAGEMENT_KEY')
    // The key value itself (empty string) is not the concern here — but the key name is safe
    expect(errorMessage).not.toContain('super-secret-key')
  })

  test('warns (does not throw) when key is empty and alias block is empty', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(preflightManagementKeyCheck(env, {config: configPath})).resolves.toBeUndefined()
      const warnCalls = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnCalls).toMatch(/CLIPROXY_MANAGEMENT_KEY not set/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test.each([
    ['no payload key', 'auth-dir: /root/.cli-proxy-api\napi-keys: []\n'],
    ['payload without override', 'auth-dir: /root/.cli-proxy-api\napi-keys: []\npayload: {unknown: true}\n'],
  ])('skips payload preflight when the tracked config has %s', async (_name, config) => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, config)
    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})
    const fetchFn = mock(
      async () => new Response('network must not be reached', {status: 200}),
    ) as unknown as typeof globalThis.fetch
    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(preflightManagementKeyCheck(env, {config: configPath}, fetchFn)).resolves.toBeUndefined()
      expect(fetchFn).not.toHaveBeenCalled()
      expect(warnSpy.mock.calls.map(call => call.join(' ')).join('\n')).toMatch(/CLIPROXY_MANAGEMENT_KEY not set/)
    } finally {
      warnSpy.mockRestore()
    }
  })
})

// ─── applyOAuthModelAliasStep ─────────────────────────────────────────────────

describe('applyOAuthModelAliasStep', () => {
  // ── Happy path ──────────────────────────────────────────────────────────────

  test('happy path: non-empty alias block + valid key → PUT issued, read-back matches → no throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    const {fetchFn, requests} = makeAliasFetch()

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()

    const putReq = requests.find(r => r.method === 'PUT' && r.url.includes('/v0/management/oauth-model-alias'))
    expect(putReq).toBeDefined()

    const getReq = requests.find(r => r.method === 'GET' && r.url.includes('/v0/management/oauth-model-alias'))
    expect(getReq).toBeDefined()
  })

  test('happy path: PUT body is bare object (no value/oauth-model-alias wrapper)', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    const {fetchFn, requests} = makeAliasFetch()

    await applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)

    const putReq = requests.find(r => r.method === 'PUT')
    expect(putReq?.body).toBeDefined()
    if (!putReq?.body) throw new Error('PUT request body is undefined')
    const parsed = JSON.parse(putReq.body)
    // Must be bare object with `claude` key — NOT wrapped in {value: ...} or {oauth-model-alias: ...}
    expect(parsed).toHaveProperty('claude')
    expect(parsed).not.toHaveProperty('value')
    expect(parsed).not.toHaveProperty('oauth-model-alias')
    expect(Array.isArray(parsed.claude)).toBe(true)
    expect(parsed.claude).toHaveLength(7)
  })

  test('happy path: x-management-key header is set on PUT', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: 'super-secret-key'})
    let capturedHeaders: Headers | undefined

    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'
      if (method === 'PUT') {
        capturedHeaders = init?.headers instanceof Headers ? init.headers : new Headers(init?.headers)
      }
      if (urlStr.includes('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') return new Response(JSON.stringify({status: 'ok'}), {status: 200})
        return new Response(
          JSON.stringify({
            'oauth-model-alias': {
              claude: [
                {name: 'claude-3-5-haiku-20241022', alias: 'claude-3-5-haiku-latest', fork: true},
                {name: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5', fork: true},
                {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: true},
                {name: 'claude-opus-4-1-20250805', alias: 'claude-opus-4-1', fork: true},
                {name: 'claude-opus-4-5-20251101', alias: 'claude-opus-4-5', fork: true},
                {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true},
                {name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true},
              ],
            },
          }),
          {status: 200},
        )
      }
      return new Response('Not Found', {status: 404})
    }) as unknown as typeof globalThis.fetch

    await applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)

    expect(capturedHeaders?.get('x-management-key')).toBe('super-secret-key')
  })

  // ── Error: empty management key ─────────────────────────────────────────────

  test('error: non-empty alias block + empty management key → throws BEFORE any fetch', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})
    const fetchFn = mock(
      async () => new Response('should not be called', {status: 200}),
    ) as unknown as typeof globalThis.fetch

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).rejects.toThrow(
      /CLIPROXY_MANAGEMENT_KEY/,
    )
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('error: management key not in thrown error message', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})
    const fetchFn = mock(async () => new Response('', {status: 200})) as unknown as typeof globalThis.fetch

    let errorMessage = ''
    try {
      await applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    // The error message should not contain any key value (empty key case — but test the pattern)
    expect(errorMessage).toContain('CLIPROXY_MANAGEMENT_KEY')
    expect(errorMessage).not.toContain('super-secret-key')
  })

  // ── Error: read-back mismatch ────────────────────────────────────────────────

  test('error: read-back set differs from desired → throws with diff message showing name/alias/fork', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    // Read-back returns only 1 entry instead of 7
    const {fetchFn} = makeAliasFetch({
      getResponse: {
        'oauth-model-alias': {
          claude: [{name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true}],
        },
      },
    })

    let errorMessage = ''
    try {
      await applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toMatch(/read-back mismatch/)
    // Error must show full canonical key (name + alias + fork), not just alias
    expect(errorMessage).toMatch(/name=/)
    expect(errorMessage).toMatch(/alias=/)
    expect(errorMessage).toMatch(/fork=/)
  })

  test('error: read-back mismatch error does not contain management key', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: 'my-secret-mgmt-key'})
    const {fetchFn} = makeAliasFetch({
      getResponse: {
        'oauth-model-alias': {
          claude: [{name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true}],
        },
      },
    })

    let errorMessage = ''
    try {
      await applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('read-back mismatch')
    expect(errorMessage).not.toContain('my-secret-mgmt-key')
  })

  // ── Retry: bounded read-back retry for hot-reload race (Fix 5) ──────────────

  test('retry: first read-back returns stale/empty, second returns correct → succeeds', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    let getCallCount = 0

    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'

      if (urlStr.includes('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') return new Response(JSON.stringify({status: 'ok'}), {status: 200})
        if (method === 'GET') {
          getCallCount++
          if (getCallCount === 1) {
            // First read-back: stale/empty
            return new Response(JSON.stringify({'oauth-model-alias': {claude: []}}), {status: 200})
          }
          // Second read-back: correct
          return new Response(
            JSON.stringify({
              'oauth-model-alias': {
                claude: [
                  {name: 'claude-3-5-haiku-20241022', alias: 'claude-3-5-haiku-latest', fork: true},
                  {name: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5', fork: true},
                  {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: true},
                  {name: 'claude-opus-4-1-20250805', alias: 'claude-opus-4-1', fork: true},
                  {name: 'claude-opus-4-5-20251101', alias: 'claude-opus-4-5', fork: true},
                  {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true},
                  {name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true},
                ],
              },
            }),
            {status: 200},
          )
        }
      }
      return new Response('Not Found', {status: 404})
    }) as unknown as typeof globalThis.fetch

    // Should succeed after retry — no throw
    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
    // Must have retried (2 GET calls)
    expect(getCallCount).toBe(2)
  })

  test('retry: persistent mismatch after all 3 attempts → throws diff error', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    let getCallCount = 0

    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'

      if (urlStr.includes('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') return new Response(JSON.stringify({status: 'ok'}), {status: 200})
        if (method === 'GET') {
          getCallCount++
          // Always return stale/wrong data
          return new Response(
            JSON.stringify({
              'oauth-model-alias': {
                claude: [{name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true}],
              },
            }),
            {status: 200},
          )
        }
      }
      return new Response('Not Found', {status: 404})
    }) as unknown as typeof globalThis.fetch

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).rejects.toThrow(
      /read-back mismatch/,
    )
    // Must have tried all 3 attempts
    expect(getCallCount).toBe(3)
  })

  test('retry: HTTP error from read-back propagates immediately (no retry on HTTP error)', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    const env = makeDeployEnv()
    let getCallCount = 0

    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'

      if (urlStr.includes('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') return new Response(JSON.stringify({status: 'ok'}), {status: 200})
        if (method === 'GET') {
          getCallCount++
          return new Response('Internal Server Error', {status: 500})
        }
      }
      return new Response('Not Found', {status: 404})
    }) as unknown as typeof globalThis.fetch

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).rejects.toThrow(/HTTP 500/)
    // HTTP error should propagate immediately — only 1 GET attempt
    expect(getCallCount).toBe(1)
  })

  // ── Edge: empty/absent alias block ──────────────────────────────────────────

  test('edge: empty alias block → no PUT (fetch not called), returns without throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)

    const env = makeDeployEnv()
    const fetchFn = mock(
      async () => new Response('should not be called', {status: 200}),
    ) as unknown as typeof globalThis.fetch

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  test('edge: empty alias block → skips even when management key is absent', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)

    const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: ''})
    const fetchFn = mock(async () => new Response('', {status: 200})) as unknown as typeof globalThis.fetch

    // Should not throw even though key is empty — nothing to apply
    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
    expect(fetchFn).not.toHaveBeenCalled()
  })

  // ── Edge: fork verification ──────────────────────────────────────────────────

  test('fork verification: with CLIPROXY_API_KEY set and /v1/models missing an alias → warns with /v1/models context, does not throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    process.env.CLIPROXY_API_KEY = 'test-downstream-key'

    const env = makeDeployEnv()
    // /v1/models returns only some models (missing several aliases)
    const {fetchFn} = makeAliasFetch({
      modelsResponse: {
        data: [
          // Only one model — all others missing
          {id: 'claude-sonnet-4-5-20250929'},
        ],
      },
    })

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      // Should NOT throw despite missing models
      await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
      // Should have warned about missing IDs — assert message content
      const warnArgs = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnArgs).toMatch(/Fork verification.*missing expected IDs/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('fork verification: without CLIPROXY_API_KEY → skips fork probe, does not throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    // Ensure CLIPROXY_API_KEY is not set
    delete process.env.CLIPROXY_API_KEY

    const env = makeDeployEnv()
    const {fetchFn, requests} = makeAliasFetch()

    await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()

    // /v1/models should NOT have been called
    const modelsReq = requests.find(r => r.url.includes('/v1/models'))
    expect(modelsReq).toBeUndefined()
  })

  test('fork verification: /v1/models HTTP error → warns with HTTP status, does not throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    process.env.CLIPROXY_API_KEY = 'test-downstream-key'

    const env = makeDeployEnv()
    const {fetchFn} = makeAliasFetch({modelsStatus: 401})

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
      // Assert warn message content includes HTTP status
      const warnArgs = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnArgs).toMatch(/Fork verification.*HTTP 401/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('fork verification: /v1/models network error → warns with error message, does not throw', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)

    process.env.CLIPROXY_API_KEY = 'test-downstream-key'

    const env = makeDeployEnv()

    // Fetch that throws on /v1/models but succeeds for management API
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'

      if (urlStr.includes('/v1/models')) {
        throw new TypeError('fetch failed: connection refused')
      }
      if (urlStr.includes('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') return new Response(JSON.stringify({status: 'ok'}), {status: 200})
        return new Response(
          JSON.stringify({
            'oauth-model-alias': {
              claude: [
                {name: 'claude-3-5-haiku-20241022', alias: 'claude-3-5-haiku-latest', fork: true},
                {name: 'claude-haiku-4-5-20251001', alias: 'claude-haiku-4-5', fork: true},
                {name: 'claude-opus-4-20250514', alias: 'claude-opus-4-0', fork: true},
                {name: 'claude-opus-4-1-20250805', alias: 'claude-opus-4-1', fork: true},
                {name: 'claude-opus-4-5-20251101', alias: 'claude-opus-4-5', fork: true},
                {name: 'claude-sonnet-4-20250514', alias: 'claude-sonnet-4-0', fork: true},
                {name: 'claude-sonnet-4-5-20250929', alias: 'claude-sonnet-4-5', fork: true},
              ],
            },
          }),
          {status: 200},
        )
      }
      return new Response('Not Found', {status: 404})
    }) as unknown as typeof globalThis.fetch

    const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})

    try {
      await expect(applyOAuthModelAliasStep(env, {config: configPath}, fetchFn, noopSleep)).resolves.toBeUndefined()
      // Assert warn message content includes the error text
      const warnArgs = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnArgs).toMatch(/Fork verification.*probe failed.*connection refused/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  // ── Ordering note ────────────────────────────────────────────────────────────
  // The alias step ordering (after compose-up, before healthCheck) is enforced by
  // call-site placement in deploy(). The full deploy() flow requires live SSH/SCP
  // which is not mocked here. The step itself is thoroughly unit-tested above.
  // See deploy.ts: applyOAuthModelAliasStep is called between runCommand('Updating
  // Docker Compose stack') and healthCheck(env).
})

describe('deploy', () => {
  test('normal deploy preserves an existing server config and never uses the raw config endpoint', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, ALIAS_WITH_PAYLOAD_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')
    delete process.env.CLIPROXY_API_KEY

    const requests: {method: string; url: string; body?: string}[] = []
    let aliasBody: unknown
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlString = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      const method = init?.method ?? 'GET'
      const body = typeof init?.body === 'string' ? init.body : undefined
      requests.push({method, url: urlString, body})
      if (urlString.includes('/v0/management/config.yaml')) {
        throw new Error('raw config endpoint must not be called')
      }
      if (urlString.endsWith('/v0/management/oauth-model-alias')) {
        if (method === 'PUT') {
          aliasBody = body ? JSON.parse(body) : undefined
          return new Response('', {status: 200})
        }
        return new Response(JSON.stringify({'oauth-model-alias': aliasBody}), {status: 200})
      }
      return new Response('', {status: 200})
    }) as unknown as typeof globalThis.fetch
    const spawnFn = mock((_command: string[]) => ({
      stdout: new Response('').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: fetchFn,
        spawn: spawnFn,
      }),
    ).resolves.toBeUndefined()
    expect(requests.some(request => request.url.includes('/v0/management/config.yaml'))).toBe(false)
    const aliasPutIndex = requests.findIndex(
      request => request.method === 'PUT' && request.url.endsWith('/v0/management/oauth-model-alias'),
    )
    const aliasGetIndex = requests.findIndex(
      request => request.method === 'GET' && request.url.endsWith('/v0/management/oauth-model-alias'),
    )
    const healthIndex = requests.findLastIndex(
      request => request.method === 'GET' && request.url.endsWith('/v0/management/config'),
    )
    expect(aliasPutIndex).toBeGreaterThan(-1)
    expect(aliasGetIndex).toBeGreaterThan(aliasPutIndex)
    expect(healthIndex).toBeGreaterThan(aliasGetIndex)
    expect(aliasBody).toMatchObject({claude: expect.any(Array)})
    expect(aliasBody).not.toHaveProperty('oauth-model-alias')
    expect(spawnFn).toHaveBeenCalled()
  })

  test('fresh deploy skips raw payload apply after uploading tracked config', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, PAYLOAD_OVERRIDE_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const requests: {method: string; url: string}[] = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      requests.push({method: init?.method ?? 'GET', url: urlStr})
      return new Response('', {status: 200})
    }) as unknown as typeof globalThis.fetch
    const spawnFn = mock((command: string[]) => {
      const isRemoteFileCheck = command.at(-1)?.includes('test -f')
      return {
        stdout: new Response('').body,
        stderr: new Response('').body,
        exited: Promise.resolve(isRemoteFileCheck ? 1 : 0),
      }
    }) as unknown as typeof Bun.spawn

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: fetchFn,
        spawn: spawnFn,
      }),
    ).resolves.toBeUndefined()
    expect(requests.some(request => request.url.includes('/v0/management/config.yaml'))).toBe(false)
    expect(requests.some(request => request.method === 'PUT')).toBe(false)
  })

  test('forced tracked config upload also skips raw payload apply', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, PAYLOAD_OVERRIDE_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const requests: {method: string; url: string}[] = []
    const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
      requests.push({method: init?.method ?? 'GET', url: urlStr})
      return new Response('', {status: 200})
    }) as unknown as typeof globalThis.fetch
    const spawnFn = mock((command: string[]) => ({
      stdout: new Response('').body,
      stderr: new Response('').body,
      exited: Promise.resolve(command.at(-1)?.includes('test -f') ? 0 : 0),
    })) as unknown as typeof Bun.spawn
    process.argv.push('--force-config')

    try {
      await expect(
        deploy({
          files: {compose: composePath, config: configPath, caddy: caddyPath},
          env: makeDeployEnv(),
          fetch: fetchFn,
          spawn: spawnFn,
        }),
      ).resolves.toBeUndefined()
      expect(requests.some(request => request.url.includes('/v0/management/config.yaml'))).toBe(false)
      expect(requests.some(request => request.method === 'PUT')).toBe(false)
    } finally {
      process.argv = process.argv.filter(argument => argument !== '--force-config')
    }
  })
})
