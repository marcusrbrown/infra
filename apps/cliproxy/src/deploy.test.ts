import type {DeployEnv, OpenCodeGoOptions} from './deploy'
import {mkdtempSync, readdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import snapshotJson from '@marcusrbrown/infra-shared/opencode-go/privacy-snapshot.json'
import {afterEach, beforeEach, describe, expect, mock, spyOn, test} from 'bun:test'
import {
  applyOAuthModelAliasStep,
  applyOpenCodeGoStep,
  deploy,
  preflightManagementKeyCheck,
  preflightOpenCodeGo,
} from './deploy'

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

const GO_KEY = 'go-key-SECRET-1111'
const API_KEY = 'api-key-SECRET-2222'
const MGMT_KEY = 'test-management-key'
const ALL_KEYS = [GO_KEY, API_KEY, MGMT_KEY] as const

type EnvOverrides = Partial<
  Pick<DeployEnv, 'CLIPROXY_DOMAIN' | 'CLIPROXY_MANAGEMENT_KEY' | 'CLIPROXY_OPENCODE_GO_KEY' | 'CLIPROXY_API_KEY'>
>

function makeDeployEnv(overrides: EnvOverrides = {}): DeployEnv {
  return {
    PATH: '/usr/bin:/bin',
    HOME: '/root',
    SSH_AUTH_SOCK: '/tmp/ssh-agent.sock',
    CLIPROXY_DOMAIN: 'cliproxy.fro.bot',
    CLIPROXY_MANAGEMENT_KEY: MGMT_KEY,
    CLIPROXY_OPENCODE_GO_KEY: GO_KEY,
    CLIPROXY_API_KEY: API_KEY,
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

/** A healthy proxy for deploys that are not about OpenCode Go: the Go step passes against the committed policy. */
function makeSimpleFetch(): typeof globalThis.fetch {
  return makeGoFetch().fetchFn
}

// ─── OpenCode Go fake proxy ───────────────────────────────────────────────────

interface RecordedRequest {
  method: string
  url: string
  headers: Headers
  body?: string
}

interface GoFakeOptions {
  /** Ids on the unauthenticated Go list. Defaults to every id in the committed snapshot. */
  liveIds?: string[]
  liveListStatus?: number
  /** Raw `openai-compatibility` entries stored on the proxy before the deploy. */
  section?: Record<string, unknown>[]
  /** Models served by other upstreams. */
  others?: {id: string; owned_by: string}[]
  putStatus?: number
  /** Status returned for the disable PATCH without applying it. */
  patchStatus?: number
  /** The write is applied on the proxy, then the connection fails before the client sees a response. */
  writeLosesResponse?: boolean
  /** The management GET answers 200 with a JSON object that has no `openai-compatibility` field. */
  omitSectionField?: boolean
  /** What the management GET returns instead of the stored section. */
  readbackOverride?: unknown[]
  /** Number of /v1/models reads after a write before the Go models appear. Infinity = never. */
  visibleAfterModelsReads?: number
  /** Extra ids always listed as owned by opencode-go (a stale model). */
  staleGoIds?: string[]
  modelsStatus?: number
  chat?: {status: number; body: unknown}
  /** Handles every URL the Go fake does not own. */
  fallback?: typeof globalThis.fetch
}

const CLAUDE_MODELS = [
  {id: 'claude-sonnet-4-5', owned_by: 'anthropic'},
  {id: 'claude-opus-4-5', owned_by: 'anthropic'},
]

function requestUrl(url: string | URL | Request): string {
  return typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {status})
}

/** URL-routed fake of the Go list, the management section, /v1/models and the chat endpoint. */
function makeGoFetch(opts: GoFakeOptions = {}): {
  fetchFn: typeof globalThis.fetch
  requests: RecordedRequest[]
  stored: () => Record<string, unknown>[]
} {
  const requests: RecordedRequest[] = []
  let storedSection: Record<string, unknown>[] = opts.section ?? []
  let writeSeen = false
  let modelsReadsSinceWrite = 0

  function served(): {id: string; owned_by: string}[] {
    const goModels: {id: string; owned_by: string}[] = []
    const hidden = writeSeen && modelsReadsSinceWrite <= (opts.visibleAfterModelsReads ?? 0)
    if (!hidden) {
      for (const entry of storedSection) {
        if (entry.disabled === true) continue
        const prefix = typeof entry.prefix === 'string' ? entry.prefix : ''
        const models = Array.isArray(entry.models) ? entry.models : []
        for (const model of models as {name: string; alias?: string}[]) {
          const id = model.alias || model.name
          goModels.push({id, owned_by: String(entry.name)})
          if (prefix) goModels.push({id: `${prefix}/${id}`, owned_by: String(entry.name)})
        }
      }
    }
    const stale = (opts.staleGoIds ?? []).map(id => ({id, owned_by: 'opencode-go'}))
    return [...(opts.others ?? CLAUDE_MODELS), ...goModels, ...stale]
  }

  const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const urlStr = requestUrl(url)
    const method = init?.method ?? 'GET'
    const body = typeof init?.body === 'string' ? init.body : undefined
    requests.push({method, url: urlStr, headers: new Headers(init?.headers), body})

    if (urlStr === 'https://opencode.ai/inference/go/v1/models') {
      const ids = opts.liveIds ?? Object.keys(snapshotJson.models)
      return json({data: ids.map(id => ({id}))}, opts.liveListStatus ?? 200)
    }

    if (urlStr.endsWith('/v0/management/openai-compatibility')) {
      if (method === 'GET') {
        if (opts.omitSectionField) return json({})
        const list = opts.readbackOverride ?? storedSection.map(entry => ({...entry, 'auth-index': 'idx-1'}))
        return json({'openai-compatibility': list})
      }
      if (method === 'PUT') {
        if ((opts.putStatus ?? 200) >= 400) return new Response('upstream said no', {status: opts.putStatus})
        storedSection = JSON.parse(body ?? '[]') as Record<string, unknown>[]
        writeSeen = true
        modelsReadsSinceWrite = 0
        if (opts.writeLosesResponse) throw new TypeError(`socket closed after PUT ${GO_KEY} ${MGMT_KEY}`)
        return json({status: 'ok'})
      }
      if (method === 'PATCH') {
        if ((opts.patchStatus ?? 200) >= 400) return new Response('upstream said no', {status: opts.patchStatus})
        const patch = JSON.parse(body ?? '{}') as {name: string; value: {disabled: boolean}}
        storedSection = storedSection.map(entry =>
          entry.name === patch.name ? {...entry, disabled: patch.value.disabled} : entry,
        )
        writeSeen = true
        modelsReadsSinceWrite = 0
        if (opts.writeLosesResponse) throw new TypeError(`socket closed after PATCH ${GO_KEY} ${MGMT_KEY}`)
        return json({status: 'ok'})
      }
    }

    if (urlStr.endsWith('/v1/models')) {
      if (writeSeen) modelsReadsSinceWrite++
      return json({data: served()}, opts.modelsStatus ?? 200)
    }

    if (urlStr.endsWith('/v1/chat/completions')) {
      const chat = opts.chat ?? {status: 200, body: {usage: {opencode: {billing_source: 'go'}}}}
      return json(chat.body, chat.status)
    }

    if (opts.fallback) return opts.fallback(url, init)
    return new Response('', {status: 200})
  }) as unknown as typeof globalThis.fetch

  return {fetchFn, requests, stored: () => storedSection}
}

function makeConfigProbeSpawn(probeResult: {stdout: string; exitCode: number}): {
  spawnFn: typeof Bun.spawn
  calls: string[][]
} {
  const calls: string[][] = []
  const spawnFn = mock((command: string[]) => {
    calls.push(command)
    const isRemoteFileCheck = command.at(-1)?.includes('test -f')
    return {
      stdout: new Response(isRemoteFileCheck ? probeResult.stdout : '').body,
      stderr: new Response('').body,
      exited: Promise.resolve(isRemoteFileCheck ? probeResult.exitCode : 0),
    }
  }) as unknown as typeof Bun.spawn
  return {spawnFn, calls}
}

function scpConfigCalls(calls: string[][]): string[][] {
  return calls.filter(
    command => command[0] === 'scp' && command.some(argument => argument.includes('config/config.yaml')),
  )
}

function remoteCalls(calls: string[][]): string[][] {
  return calls.filter(command => command[0] === 'ssh' || command[0] === 'scp')
}

function controlPathOf(command: string[]): string | undefined {
  return command.find(argument => argument.startsWith('ControlPath='))
}

function expectSharedSocket(calls: string[][], tempRoot: string, expectedCount: number): void {
  const remote = remoteCalls(calls)
  expect(remote).toHaveLength(expectedCount)

  const socket = controlPathOf(remote[0] ?? [])
  expect(socket).toStartWith(`ControlPath=${tempRoot}/cliproxy-deploy-`)
  for (const command of remote) {
    expect(controlPathOf(command)).toBe(socket)
    expect(command).toContain('ControlMaster=auto')
    expect(command).toContain('ControlPersist=60s')
  }
}

function makePruneSpawn(pruneExitCode: number): {spawnFn: typeof Bun.spawn; remoteCommands: string[]} {
  const remoteCommands: string[] = []
  const spawnFn = mock((command: string[]) => {
    const last = command.at(-1) ?? ''
    if (command[0] === 'ssh') remoteCommands.push(last)
    return {
      stdout: new Response(last.includes('test -f') ? 'EXISTS\n' : '').body,
      stderr: new Response('').body,
      exited: Promise.resolve(last.includes('docker image prune') ? pruneExitCode : 0),
    }
  }) as unknown as typeof Bun.spawn
  return {spawnFn, remoteCommands}
}

function writeDeployFiles(dir: string): {compose: string; config: string; caddy: string} {
  const files = {
    compose: join(dir, 'docker-compose.yaml'),
    config: join(dir, 'config.yaml'),
    caddy: join(dir, 'Caddyfile'),
  }
  writeFileSync(files.config, EMPTY_ALIAS_YAML)
  writeFileSync(files.compose, '')
  writeFileSync(files.caddy, '')
  return files
}

// ─── Test setup ───────────────────────────────────────────────────────────────

let tmpDir: string
let originalApiKey: string | undefined

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cliproxy-deploy-test-'))
  originalApiKey = process.env.CLIPROXY_API_KEY
})

afterEach(() => {
  rmSync(tmpDir, {recursive: true, force: true})
  if (originalApiKey === undefined) {
    delete process.env.CLIPROXY_API_KEY
  } else {
    process.env.CLIPROXY_API_KEY = originalApiKey
  }
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

  describe('management 401/403 mapping', () => {
    const KEY = 'super-secret-key'
    const BAN_BODY = '{"error":"IP banned due to too many failed attempts. Try again in 29m12s"}'

    async function runPreflight(response: Response): Promise<{error: unknown; warnings: string}> {
      const configPath = join(tmpDir, 'config.yaml')
      writeFileSync(configPath, EMPTY_ALIAS_YAML)
      const env = makeDeployEnv({CLIPROXY_MANAGEMENT_KEY: KEY})
      const fetchFn = mock(async () => response) as unknown as typeof globalThis.fetch
      const warnSpy = spyOn(console, 'warn').mockImplementation(() => {})
      try {
        const error = await preflightManagementKeyCheck(env, {config: configPath}, fetchFn).then(
          () => undefined,
          (error_: unknown) => error_,
        )
        return {error, warnings: warnSpy.mock.calls.map(call => call.join(' ')).join('\n')}
      } finally {
        warnSpy.mockRestore()
      }
    }

    test('reports a source-IP ban distinctly from an invalid key (403 with ban body), never as a skip', async () => {
      const {error, warnings} = await runPreflight(new Response(BAN_BODY, {status: 403}))
      expect(error).toBeInstanceOf(Error)
      const message = (error as Error).message
      expect(message).toContain('temporarily banning this source IP')
      expect(message).toContain('#1544')
      expect(message).not.toMatch(/invalid/i)
      expect(message).not.toContain(KEY)
      expect(message).not.toContain('Try again in')
      expect(warnings).not.toMatch(/skipping pre-deploy validation/)
    })

    test('matches the ban text case-insensitively', async () => {
      const {error} = await runPreflight(new Response('ip BANNED due to too many failed attempts', {status: 403}))
      expect((error as Error).message).toContain('temporarily banning this source IP')
    })

    test('keeps a 403 without ban text on the invalid-key path', async () => {
      const {error} = await runPreflight(new Response('{"error":"invalid management key"}', {status: 403}))
      expect((error as Error).message).toMatch(/^Management key is invalid/)
    })

    test('keeps a 401 (even with ban-like text) on the invalid-key path', async () => {
      const {error} = await runPreflight(new Response(BAN_BODY, {status: 401}))
      expect((error as Error).message).toMatch(/^Management key is invalid/)
    })

    test('treats an unreadable 403 body as an invalid key, not a ban', async () => {
      const brokenBody = new Response(
        new ReadableStream({
          pull(controller) {
            controller.error(new Error('stream broke'))
          },
        }),
        {status: 403},
      )
      const {error} = await runPreflight(brokenBody)
      expect((error as Error).message).toMatch(/^Management key is invalid/)
    })
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
    const spawnFn = mock((command: string[]) => ({
      stdout: new Response(command.at(-1)?.includes('test -f') ? 'EXISTS\n' : '').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: makeGoFetch({fallback: fetchFn}).fetchFn,
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
        stdout: new Response(isRemoteFileCheck ? 'MISSING\n' : '').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
      }
    }) as unknown as typeof Bun.spawn

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: makeGoFetch({fallback: fetchFn}).fetchFn,
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
      stdout: new Response(command.at(-1)?.includes('test -f') ? 'EXISTS\n' : '').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    })) as unknown as typeof Bun.spawn
    process.argv.push('--force-config')

    try {
      await expect(
        deploy({
          files: {compose: composePath, config: configPath, caddy: caddyPath},
          env: makeDeployEnv(),
          fetch: makeGoFetch({fallback: fetchFn}).fetchFn,
          spawn: spawnFn,
        }),
      ).resolves.toBeUndefined()
      expect(requests.some(request => request.url.includes('/v0/management/config.yaml'))).toBe(false)
      expect(requests.some(request => request.method === 'PUT')).toBe(false)
    } finally {
      process.argv = process.argv.filter(argument => argument !== '--force-config')
    }
  })

  // ── remoteFileExists probe hardening ──────────────────────────────────────────
  // A failed SSH probe must never be mistaken for "config.yaml does not exist" —
  // that misreading would overwrite the live config.yaml and wipe its runtime API keys.

  test('probe exits 0 with EXISTS: config.yaml is not uploaded and the skip message is emitted', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'EXISTS\n', exitCode: 0})
    const warnSpy = spyOn(console, 'warn')

    try {
      await expect(
        deploy({
          files: {compose: composePath, config: configPath, caddy: caddyPath},
          env: makeDeployEnv(),
          fetch: makeSimpleFetch(),
          spawn: spawnFn,
        }),
      ).resolves.toBeUndefined()

      expect(scpConfigCalls(calls)).toHaveLength(0)
      const warnArgs = warnSpy.mock.calls.map(call => call.join(' ')).join('\n')
      expect(warnArgs).toMatch(/Skipping config\/config\.yaml \(exists on server, use --force-config to overwrite\)/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  test('probe exits 0 with MISSING: config.yaml is uploaded (first-deploy path)', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'MISSING\n', exitCode: 0})

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
      }),
    ).resolves.toBeUndefined()

    expect(scpConfigCalls(calls)).toHaveLength(1)
  })

  test('probe fails with a non-zero exit code (SSH transport failure): deploy aborts and never uploads config.yaml', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const {spawnFn, calls} = makeConfigProbeSpawn({stdout: '', exitCode: 255})

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/Could not determine whether remote file/)

    // The whole point of the fix: a failed probe must never be read as "absent",
    // which would otherwise trigger an scp that wipes the live config.yaml.
    expect(scpConfigCalls(calls)).toHaveLength(0)
  })

  test('probe exits 0 with unrecognized output: deploy aborts and never uploads config.yaml', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'bash: warning: setlocale\n', exitCode: 0})

    await expect(
      deploy({
        files: {compose: composePath, config: configPath, caddy: caddyPath},
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
      }),
    ).rejects.toThrow(/Could not determine whether remote file/)

    expect(scpConfigCalls(calls)).toHaveLength(0)
  })

  test('forceConfig true with probe returning EXISTS: config.yaml is still uploaded (explicit override)', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    const composePath = join(tmpDir, 'docker-compose.yaml')
    const caddyPath = join(tmpDir, 'Caddyfile')
    writeFileSync(configPath, EMPTY_ALIAS_YAML)
    writeFileSync(composePath, '')
    writeFileSync(caddyPath, '')

    const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'EXISTS\n', exitCode: 0})
    process.argv.push('--force-config')

    try {
      await expect(
        deploy({
          files: {compose: composePath, config: configPath, caddy: caddyPath},
          env: makeDeployEnv(),
          fetch: makeSimpleFetch(),
          spawn: spawnFn,
        }),
      ).resolves.toBeUndefined()

      expect(scpConfigCalls(calls)).toHaveLength(1)
    } finally {
      process.argv = process.argv.filter(argument => argument !== '--force-config')
    }
  })

  describe('ssh connection multiplexing', () => {
    test('normal deploy runs every ssh/scp call over one control socket', async () => {
      const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'EXISTS\n', exitCode: 0})

      await deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
        tempRoot: tmpDir,
      })

      // mkdir, scp compose, scp Caddyfile, config probe, image prune, compose pull/up
      expectSharedSocket(calls, tmpDir, 6)
    })

    test('first deploy also uploads config.yaml over the same control socket', async () => {
      const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'MISSING\n', exitCode: 0})

      await deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
        tempRoot: tmpDir,
      })

      expect(scpConfigCalls(calls)).toHaveLength(1)
      expectSharedSocket(calls, tmpDir, 7)
    })

    test('forced config upload uses the same control socket', async () => {
      const {spawnFn, calls} = makeConfigProbeSpawn({stdout: 'EXISTS\n', exitCode: 0})
      process.argv.push('--force-config')

      try {
        await deploy({
          files: writeDeployFiles(tmpDir),
          env: makeDeployEnv(),
          fetch: makeSimpleFetch(),
          spawn: spawnFn,
          tempRoot: tmpDir,
        })
      } finally {
        process.argv = process.argv.filter(argument => argument !== '--force-config')
      }

      expect(scpConfigCalls(calls)).toHaveLength(1)
      expectSharedSocket(calls, tmpDir, 7)
    })

    test('removes the control socket directory after a successful deploy', async () => {
      const root = mkdtempSync(join(tmpDir, 'root-'))
      const {spawnFn} = makeConfigProbeSpawn({stdout: 'EXISTS\n', exitCode: 0})

      await deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv(),
        fetch: makeSimpleFetch(),
        spawn: spawnFn,
        tempRoot: root,
      })

      expect(readdirSync(root)).toEqual([])
    })

    test('removes the control socket directory when the deploy fails', async () => {
      const root = mkdtempSync(join(tmpDir, 'root-'))
      const {spawnFn} = makeConfigProbeSpawn({stdout: '', exitCode: 255})

      await expect(
        deploy({
          files: writeDeployFiles(tmpDir),
          env: makeDeployEnv(),
          fetch: makeSimpleFetch(),
          spawn: spawnFn,
          tempRoot: root,
        }),
      ).rejects.toThrow(/Could not determine whether remote file/)

      expect(readdirSync(root)).toEqual([])
    })
  })

  describe('image prune before pull', () => {
    test('prunes unused images before docker compose pull, without system prune or volumes', async () => {
      const {spawnFn, remoteCommands} = makePruneSpawn(0)

      await deploy({files: writeDeployFiles(tmpDir), env: makeDeployEnv(), fetch: makeSimpleFetch(), spawn: spawnFn})

      const pruneIndex = remoteCommands.findIndex(command => command.includes('docker image prune -af'))
      const pullIndex = remoteCommands.findIndex(command => command.includes('docker compose pull'))
      expect(pruneIndex).toBeGreaterThan(-1)
      expect(pullIndex).toBeGreaterThan(pruneIndex)
      for (const command of remoteCommands) {
        expect(command).not.toContain('system prune')
        expect(command).not.toContain('--volumes')
      }
    })

    test('continues to pull and up when the prune fails', async () => {
      const {spawnFn, remoteCommands} = makePruneSpawn(1)

      await expect(
        deploy({files: writeDeployFiles(tmpDir), env: makeDeployEnv(), fetch: makeSimpleFetch(), spawn: spawnFn}),
      ).resolves.toBeUndefined()

      expect(remoteCommands.some(command => command.includes('docker image prune -af'))).toBe(true)
      expect(remoteCommands.some(command => command.includes('docker compose pull && docker compose up'))).toBe(true)
    })
  })
})

// ─── OpenCode Go upstream ─────────────────────────────────────────────────────

const RUNBOOK = 'docs/runbooks/cliproxy-opencode-go.md'
const ZDR = {zeroRetention: true, trainsOnData: false, regionGated: false, agreementExpiry: null}
const SNAPSHOT_FIXTURE = {
  schemaVersion: 1,
  source: {
    repo: 'anomalyco/opencode',
    path: 'services/site/src/docs/content/console/go.mdx',
    commit: 'a'.repeat(40),
  },
  models: {
    'glm-5.3': ZDR,
    'qwen-4': ZDR,
    'trainer-1': {...ZDR, trainsOnData: true},
  },
}
/** `mystery-1` is live but absent from the snapshot; `trainer-1` trains on data. */
const LIVE_IDS = ['glm-5.3', 'qwen-4', 'trainer-1', 'mystery-1']
const GO_OPTIONS: OpenCodeGoOptions = {
  settings: {enabled: true, defaultProbeModel: 'glm-5.3'},
  snapshot: SNAPSHOT_FIXTURE,
  now: () => new Date('2026-11-04T12:00:00Z'),
}
const DISABLED_OPTIONS: OpenCodeGoOptions = {...GO_OPTIONS, settings: {enabled: false}}

function expectedEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'opencode-go',
    prefix: 'opencode-go',
    'base-url': 'https://opencode.ai/inference/go/openai/v1',
    'api-key-entries': [{'api-key': GO_KEY}],
    models: [
      {name: 'glm-5.3', alias: 'glm-5.3'},
      {name: 'qwen-4', alias: 'qwen-4'},
    ],
    headers: {'x-opencode-session': '$X-Opencode-Session'},
    disabled: false,
    ...overrides,
  }
}

/** Captures every console channel so tests can assert nothing secret was printed. */
function captureLogs(): {text: () => string; restore: () => void} {
  const spies = [
    spyOn(console, 'warn').mockImplementation(() => {}),
    spyOn(console, 'log').mockImplementation(() => {}),
    spyOn(console, 'error').mockImplementation(() => {}),
  ]
  return {
    text: () => spies.flatMap(spy => spy.mock.calls.map(call => call.join(' '))).join('\n'),
    restore: () => {
      for (const spy of spies) spy.mockRestore()
    },
  }
}

function writes(requests: RecordedRequest[]): RecordedRequest[] {
  return requests.filter(
    request => request.url.endsWith('/v0/management/openai-compatibility') && request.method !== 'GET',
  )
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
  const error = await promise.then(
    () => undefined,
    (error_: unknown) => error_,
  )
  if (!(error instanceof Error)) throw new Error('expected the promise to reject with an Error')
  return error
}

async function expectUnverified(promise: Promise<unknown>, detail: RegExp): Promise<void> {
  const error = await rejection(promise)
  expect(error.message).toMatch(/applied but unverified/i)
  expect(error.message).toContain(RUNBOOK)
  expect(error.message).toMatch(detail)
  expectNoKeys(error.message)
}

function capturingSpawn(): {
  spawnFn: typeof Bun.spawn
  envs: (Record<string, string> | undefined)[]
  count: () => number
} {
  const envs: (Record<string, string> | undefined)[] = []
  const spawnFn = mock((command: string[], options?: {env?: Record<string, string>}) => {
    envs.push(options?.env)
    return {
      stdout: new Response(command.at(-1)?.includes('test -f') ? 'EXISTS\n' : '').body,
      stderr: new Response('').body,
      exited: Promise.resolve(0),
    }
  }) as unknown as typeof Bun.spawn
  return {spawnFn, envs, count: () => envs.length}
}

function expectNoKeys(text: string): void {
  for (const key of ALL_KEYS) expect(text).not.toContain(key)
}

async function runGo(
  fake: ReturnType<typeof makeGoFetch>,
  {
    env = makeDeployEnv(),
    options = GO_OPTIONS,
    sleeps = [],
  }: {env?: DeployEnv; options?: OpenCodeGoOptions; sleeps?: number[]} = {},
): Promise<void> {
  const sleepFn = async (ms: number): Promise<void> => {
    sleeps.push(ms)
  }
  const plan = await preflightOpenCodeGo(env, options, fake.fetchFn)
  await applyOpenCodeGoStep(env, plan, fake.fetchFn, sleepFn)
}

describe('preflightOpenCodeGo', () => {
  test.each([
    ['CLIPROXY_OPENCODE_GO_KEY', {CLIPROXY_OPENCODE_GO_KEY: ''}],
    ['CLIPROXY_API_KEY', {CLIPROXY_API_KEY: ''}],
    ['CLIPROXY_MANAGEMENT_KEY', {CLIPROXY_MANAGEMENT_KEY: ''}],
  ] as const)('enabled: a missing %s fails before any network call', async (name, overrides) => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    const error = await rejection(preflightOpenCodeGo(makeDeployEnv(overrides), GO_OPTIONS, fake.fetchFn))

    expect(error.message).toContain(name)
    expectNoKeys(error.message)
    expect(fake.requests).toHaveLength(0)
  })

  test('an unparseable snapshot fails before any network call', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    const error = await rejection(
      preflightOpenCodeGo(makeDeployEnv(), {...GO_OPTIONS, snapshot: {schemaVersion: 1, models: 'nope'}}, fake.fetchFn),
    )

    expect(error.message).toMatch(/privacy snapshot/)
    expect(fake.requests).toHaveLength(0)
  })

  test('invalid settings fail before any network call', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    const error = await rejection(
      preflightOpenCodeGo(makeDeployEnv(), {...GO_OPTIONS, settings: {enabled: 'yes'}}, fake.fetchFn),
    )

    expect(error.message).toMatch(/settings/)
    expect(fake.requests).toHaveLength(0)
  })

  test('a failed live-list fetch fails the preflight', async () => {
    const fake = makeGoFetch({liveListStatus: 503})

    const error = await rejection(preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fake.fetchFn))

    expect(error.message).toMatch(/live OpenCode Go model list/)
    expect(error.message).toContain('503')
  })

  test('a network error on the live list fails the preflight', async () => {
    const fetchFn = mock(async () => {
      throw new TypeError('connection refused')
    }) as unknown as typeof globalThis.fetch

    const error = await rejection(preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fetchFn))

    expect(error.message).toMatch(/live OpenCode Go model list/)
  })

  test('an empty eligible set fails the preflight', async () => {
    const fake = makeGoFetch({liveIds: ['mystery-1']})

    const error = await rejection(preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fake.fetchFn))

    expect(error.message).toMatch(/no eligible OpenCode Go models/)
  })

  test('prints the eligible count and every excluded id with its reason', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})
    const logs = captureLogs()
    try {
      const plan = await preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fake.fetchFn)
      expect(plan).toMatchObject({enabled: true, eligible: ['glm-5.3', 'qwen-4']})
      const text = logs.text()
      expect(text).toMatch(/2 eligible/)
      expect(text).toContain('mystery-1 (not-in-snapshot)')
      expect(text).toContain('trainer-1 (trains-on-data)')
      expectNoKeys(text)
    } finally {
      logs.restore()
    }
  })

  test('probe model is the default when eligible, otherwise the first eligible id in sorted order', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})
    const preferred = await preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fake.fetchFn)
    const fallback = await preflightOpenCodeGo(
      makeDeployEnv(),
      {...GO_OPTIONS, settings: {enabled: true, defaultProbeModel: 'trainer-1'}},
      fake.fetchFn,
    )
    const unset = await preflightOpenCodeGo(makeDeployEnv(), {...GO_OPTIONS, settings: {enabled: true}}, fake.fetchFn)

    expect(preferred).toMatchObject({probeModel: 'glm-5.3'})
    expect(fallback).toMatchObject({probeModel: 'glm-5.3'})
    expect(unset).toMatchObject({probeModel: 'glm-5.3'})
  })

  test('an expiring agreement is judged against the injected UTC date', async () => {
    const snapshot = {
      ...SNAPSHOT_FIXTURE,
      models: {...SNAPSHOT_FIXTURE.models, 'qwen-4': {...ZDR, agreementExpiry: '2026-11-04'}},
    }
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    const today = await preflightOpenCodeGo(makeDeployEnv(), {...GO_OPTIONS, snapshot}, fake.fetchFn)
    const tomorrow = await preflightOpenCodeGo(
      makeDeployEnv(),
      {...GO_OPTIONS, snapshot, now: () => new Date('2026-11-05T00:00:00Z')},
      fake.fetchFn,
    )

    expect(today).toMatchObject({eligible: ['glm-5.3', 'qwen-4']})
    expect(tomorrow).toMatchObject({eligible: ['glm-5.3']})
  })

  test('disabled: needs no Go or downstream key and makes no network call', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})
    const env = makeDeployEnv({CLIPROXY_OPENCODE_GO_KEY: '', CLIPROXY_API_KEY: ''})

    const plan = await preflightOpenCodeGo(env, DISABLED_OPTIONS, fake.fetchFn)

    expect(plan).toEqual({enabled: false})
    expect(fake.requests).toHaveLength(0)
  })

  test('disabled still rejects an unparseable snapshot', async () => {
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    await expect(
      preflightOpenCodeGo(makeDeployEnv(), {...DISABLED_OPTIONS, snapshot: 'garbage'}, fake.fetchFn),
    ).rejects.toThrow(/privacy snapshot/)
  })
})

describe('applyOpenCodeGoStep', () => {
  describe('enabled', () => {
    test('bootstrap: an empty live section is PUT with the tracked entry, verified, and smoke-tested', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})
      const logs = captureLogs()
      try {
        await runGo(fake)

        const put = writes(fake.requests)
        expect(put).toHaveLength(1)
        expect(put[0]?.method).toBe('PUT')
        // A bare array holding exactly the tracked entry, with the session header mapped (never forwarded wholesale).
        expect(JSON.parse(put[0]?.body ?? 'null')).toEqual([expectedEntry()])

        const chat = fake.requests.find(request => request.url.endsWith('/v1/chat/completions'))
        expect(chat?.method).toBe('POST')
        expect(chat?.url).toBe('https://cliproxy.fro.bot/v1/chat/completions')
        expect(chat?.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
        expect(JSON.parse(chat?.body ?? 'null')).toEqual({
          model: 'glm-5.3',
          messages: [{role: 'user', content: 'Reply with OK'}],
          max_tokens: 1,
        })
        expect(logs.text()).toMatch(/OpenCode Go.*verified/i)
      } finally {
        logs.restore()
      }
    })

    test('a 2xx billed to a present non-go source passes with a warning that names it', async () => {
      const fake = makeGoFetch({
        liveIds: LIVE_IDS,
        chat: {status: 200, body: {usage: {opencode: {billing_source: 'balance', list_cost: '0.00006'}}}},
      })
      const logs = captureLogs()
      try {
        await runGo(fake)

        const text = logs.text()
        expect(text).toContain(
          'OpenCode Go smoke request billed to "balance", not "go" (Go usage window exhausted or credits fallback); route works',
        )
        expect(text).not.toMatch(/smoke request billed to Go/)
        expect(text).toMatch(/OpenCode Go applied and verified/)
        expect(text).not.toContain('list_cost')
        expect(writes(fake.requests)).toHaveLength(1)
      } finally {
        logs.restore()
      }
    })

    test('a weird billing_source is bounded to the token `other` in the warning', async () => {
      const fake = makeGoFetch({
        liveIds: LIVE_IDS,
        chat: {status: 200, body: {usage: {opencode: {billing_source: 'a b HOSTILE_BODY'}}}},
      })
      const logs = captureLogs()
      try {
        await runGo(fake)

        expect(logs.text()).toContain('billed to "other", not "go"')
        expect(logs.text()).not.toContain('HOSTILE_BODY')
      } finally {
        logs.restore()
      }
    })

    test('a go-billed smoke request still reports billing to Go with no warning', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})
      const logs = captureLogs()
      try {
        await runGo(fake)

        expect(logs.text()).toContain('smoke request billed to Go')
        expect(logs.text()).not.toContain('credits fallback')
      } finally {
        logs.restore()
      }
    })

    test('the smoke request carries a fresh non-empty x-opencode-session that is never logged', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})
      const logs = captureLogs()
      try {
        await runGo(fake)
        await runGo(makeGoFetch({liveIds: LIVE_IDS}))

        const session = fake.requests
          .find(request => request.url.endsWith('/v1/chat/completions'))
          ?.headers.get('x-opencode-session')
        expect(session).toMatch(/^infra-deploy-.+/)
        expect(logs.text()).not.toContain(session ?? 'missing')
      } finally {
        logs.restore()
      }
    })

    test('every management call carries x-management-key', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})

      await runGo(fake)

      const management = fake.requests.filter(request => request.url.includes('/v0/management/'))
      expect(management.length).toBeGreaterThanOrEqual(3)
      for (const request of management) expect(request.headers.get('x-management-key')).toBe(MGMT_KEY)
    })

    test('the downstream key authenticates the /v1/models reads', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})

      await runGo(fake)

      const reads = fake.requests.filter(request => request.url === 'https://cliproxy.fro.bot/v1/models')
      expect(reads.length).toBeGreaterThanOrEqual(2)
      for (const request of reads) expect(request.headers.get('authorization')).toBe(`Bearer ${API_KEY}`)
    })

    test('idempotent: a live entry identical to the tracked one is PUT again and verified', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()]})

      await runGo(fake)

      expect(writes(fake.requests)).toHaveLength(1)
      expect(fake.stored()).toEqual([expectedEntry()])
    })

    test('a stale live model list is replaced by the eligible set', async () => {
      const stale = expectedEntry({models: [{name: 'old-model', alias: 'old-model'}]})
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [stale]})

      await runGo(fake)

      expect(fake.stored()).toEqual([expectedEntry()])
    })

    test('a live model that is not in the snapshot is excluded and printed, and the deploy still passes', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})
      const logs = captureLogs()
      try {
        await runGo(fake)
        expect(logs.text()).toContain('mystery-1 (not-in-snapshot)')
        expect(writes(fake.requests)).toHaveLength(1)
      } finally {
        logs.restore()
      }
    })

    test('the visibility poll tolerates a short reload delay', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, visibleAfterModelsReads: 3})
      const sleeps: number[] = []

      await runGo(fake, {sleeps})

      expect(sleeps.length).toBeGreaterThan(0)
    })

    test('no captured log line contains any key', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})
      const logs = captureLogs()
      try {
        await runGo(fake)
        expectNoKeys(logs.text())
      } finally {
        logs.restore()
      }
    })
  })

  describe('guards that fail before the write', () => {
    test('a foreign live entry fails, names the entry and leaks no key', async () => {
      const foreign = {
        name: 'some-other-upstream',
        'base-url': 'https://example.invalid/v1',
        'api-key-entries': [{'api-key': 'foreign-secret-key'}],
        models: [{name: 'x', alias: 'x'}],
      }
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [foreign]})

      const error = await rejection(runGo(fake))

      expect(error.message).toContain('some-other-upstream')
      expect(error.message).not.toContain('foreign-secret-key')
      expectNoKeys(error.message)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('a foreign entry next to the Go entry also fails', async () => {
      const foreign = {name: 'other', 'base-url': 'https://example.invalid/v1', 'api-key-entries': [], models: []}
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry(), foreign]})

      await expect(runGo(fake)).rejects.toThrow(/other/)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('a disabled live entry while tracked enabled is true fails and points at the runbook', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry({disabled: true})]})

      const error = await rejection(runGo(fake))

      expect(error.message).toMatch(/disabled/)
      expect(error.message).toContain(RUNBOOK)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test.each([
      ['a bare id', 'glm-5.3'],
      ['a prefixed id', 'opencode-go/qwen-4'],
    ])('a collision with %s served by another provider fails', async (_label, id) => {
      const fake = makeGoFetch({
        liveIds: LIVE_IDS,
        others: [...CLAUDE_MODELS, {id, owned_by: 'anthropic'}],
      })

      const error = await rejection(runGo(fake))

      expect(error.message).toContain(id)
      expect(error.message).toMatch(/anthropic/)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('a failed /v1/models read before the write fails closed', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, modelsStatus: 500})

      const error = await rejection(runGo(fake))

      expect(error.message).toContain('500')
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test.each([400, 403, 422, 429])(
      'a PUT the proxy rejects with HTTP %i is a plain failure, not "applied but unverified", and leaks no key',
      async status => {
        const fake = makeGoFetch({liveIds: LIVE_IDS, putStatus: status})

        const error = await rejection(runGo(fake))

        expect(error.message).toContain(`HTTP ${status}`)
        expect(error.message).not.toMatch(/unverified/i)
        expectNoKeys(error.message)
      },
    )

    test('a management GET that lacks the openai-compatibility field fails before any PUT', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, omitSectionField: true})

      const error = await rejection(runGo(fake))

      expect(error.message).toContain('openai-compatibility')
      expect(error.message).toMatch(/missing/)
      expect(error.message).not.toMatch(/unverified/i)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('the disabled mode also refuses a GET that lacks the field, and sends no PATCH', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, omitSectionField: true})

      await expect(runGo(fake, {options: DISABLED_OPTIONS})).rejects.toThrow(/missing/)
      expect(writes(fake.requests)).toHaveLength(0)
    })
  })

  describe('applied but unverified', () => {
    test('a PUT whose response is lost after the proxy applied it', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, writeLosesResponse: true})

      await expectUnverified(runGo(fake), /\(write\).*socket closed after PUT/)
      expect(fake.stored()).toEqual([expectedEntry()])
      expect(writes(fake.requests)).toHaveLength(1)
    })

    test.each([500, 502, 504, 408])('a PUT answered with HTTP %i may have been applied', async status => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, putStatus: status})

      await expectUnverified(runGo(fake), new RegExp(String.raw`\(write\).*HTTP ${status}`))
    })

    test('a PUT that times out is unverified', async () => {
      const inner = makeGoFetch({liveIds: LIVE_IDS})
      const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
        if (init?.method === 'PUT') throw new DOMException('The operation timed out.', 'TimeoutError')
        return inner.fetchFn(url, init)
      }) as unknown as typeof globalThis.fetch
      const plan = await preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fetchFn)

      await expectUnverified(
        applyOpenCodeGoStep(makeDeployEnv(), plan, fetchFn, async () => {}),
        /\(write\).*timed out/,
      )
    })

    test('a readback mismatch', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, readbackOverride: [expectedEntry({prefix: 'wrong'})]})

      await expectUnverified(runGo(fake), /read-?back/i)
      expect(fake.requests.filter(r => r.method === 'GET' && r.url.endsWith('/openai-compatibility'))).toHaveLength(4)
    })

    test('a visibility timeout stays inside a few seconds of sleeping', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, visibleAfterModelsReads: Number.POSITIVE_INFINITY})
      const sleeps: number[] = []

      await expectUnverified(runGo(fake, {sleeps}), /not visible|visible/i)

      const total = sleeps.reduce((sum, ms) => sum + ms, 0)
      expect(total).toBeGreaterThanOrEqual(3000)
      expect(total).toBeLessThanOrEqual(6000)
    })

    test('an extra opencode-go-owned model that is not eligible', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, staleGoIds: ['trainer-1']})

      await expectUnverified(runGo(fake), /trainer-1/)
    })

    test('a smoke request that is not a 2xx', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, chat: {status: 500, body: {error: 'boom'}}})

      await expectUnverified(runGo(fake), /HTTP 500/)
    })

    test.each([
      ['none', {usage: {}}],
      ['null', {usage: {opencode: {billing_source: null}}}],
      ['a number', {usage: {opencode: {billing_source: 7}}}],
      ['an empty string', {usage: {opencode: {billing_source: ''}}}],
      ['a non-object body', 'ok'],
    ])('a 2xx with billing_source %s', async (_label, body) => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, chat: {status: 200, body}})

      await expectUnverified(runGo(fake), /billing_source/)
    })

    test('a network error after the write', async () => {
      const inner = makeGoFetch({liveIds: LIVE_IDS})
      const fetchFn = mock(async (url: string | URL | Request, init?: RequestInit) => {
        if (requestUrl(url).endsWith('/v1/chat/completions')) throw new TypeError(`socket closed ${API_KEY}`)
        return inner.fetchFn(url, init)
      }) as unknown as typeof globalThis.fetch
      const plan = await preflightOpenCodeGo(makeDeployEnv(), GO_OPTIONS, fetchFn)

      await expectUnverified(
        applyOpenCodeGoStep(makeDeployEnv(), plan, fetchFn, async () => {}),
        /socket closed/,
      )
    })
  })

  describe('disabled', () => {
    test('disables the live entry without a smoke request and expects no Go ids', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()]})

      await runGo(fake, {options: DISABLED_OPTIONS})

      const [patch] = writes(fake.requests)
      expect(writes(fake.requests)).toHaveLength(1)
      expect(patch?.method).toBe('PATCH')
      expect(JSON.parse(patch?.body ?? 'null')).toEqual({name: 'opencode-go', value: {disabled: true}})
      expect(fake.requests.some(request => request.url.endsWith('/v1/chat/completions'))).toBe(false)
      expect(fake.requests.some(request => request.url === 'https://opencode.ai/inference/go/v1/models')).toBe(false)
    })

    test('an already-disabled live entry is left alone', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry({disabled: true})]})

      await runGo(fake, {options: DISABLED_OPTIONS})

      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('an empty live section has nothing to disable and writes nothing', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS})

      await runGo(fake, {options: DISABLED_OPTIONS})

      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('a foreign live entry still fails', async () => {
      const foreign = {name: 'other', 'base-url': 'https://example.invalid/v1', 'api-key-entries': [], models: []}
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [foreign]})

      await expect(runGo(fake, {options: DISABLED_OPTIONS})).rejects.toThrow(/other/)
      expect(writes(fake.requests)).toHaveLength(0)
    })

    test('a disable PATCH whose response is lost after the proxy applied it is unverified', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()], writeLosesResponse: true})

      await expectUnverified(runGo(fake, {options: DISABLED_OPTIONS}), /\(write\).*socket closed after PATCH/)
      expect(writes(fake.requests)).toHaveLength(1)
    })

    test('a disable PATCH answered with HTTP 503 is unverified', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()], patchStatus: 503})

      await expectUnverified(runGo(fake, {options: DISABLED_OPTIONS}), /\(write\).*HTTP 503/)
    })

    test('a disable PATCH the proxy rejects with HTTP 404 is a plain failure', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()], patchStatus: 404})

      const error = await rejection(runGo(fake, {options: DISABLED_OPTIONS}))

      expect(error.message).toContain('HTTP 404')
      expect(error.message).not.toMatch(/unverified/i)
    })

    test('Go ids still visible after the disable are "applied but unverified"', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()], staleGoIds: ['glm-5.3']})

      const error = await rejection(runGo(fake, {options: DISABLED_OPTIONS}))

      expect(error.message).toMatch(/applied but unverified/i)
      expect(error.message).toContain(RUNBOOK)
      expect(error.message).toContain('glm-5.3')
    })

    test('without a downstream key the visibility check is skipped with a warning', async () => {
      const fake = makeGoFetch({liveIds: LIVE_IDS, section: [expectedEntry()]})
      const logs = captureLogs()
      try {
        await runGo(fake, {env: makeDeployEnv({CLIPROXY_API_KEY: ''}), options: DISABLED_OPTIONS})
        expect(logs.text()).toMatch(/CLIPROXY_API_KEY not set/)
        expect(fake.requests.some(request => request.url.endsWith('/v1/models'))).toBe(false)
      } finally {
        logs.restore()
      }
    })
  })
})

describe('deploy: OpenCode Go wiring', () => {
  test('the preflight runs before any SSH when the Go key is missing', async () => {
    const {spawnFn, count} = capturingSpawn()
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    const error = await rejection(
      deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv({CLIPROXY_OPENCODE_GO_KEY: ''}),
        fetch: fake.fetchFn,
        spawn: spawnFn,
        opencodeGo: GO_OPTIONS,
      }),
    )

    expect(error.message).toContain('CLIPROXY_OPENCODE_GO_KEY')
    expect(count()).toBe(0)
    expect(writes(fake.requests)).toHaveLength(0)
  })

  test('an empty eligible set fails before any SSH', async () => {
    const {spawnFn, count} = capturingSpawn()
    const fake = makeGoFetch({liveIds: ['mystery-1']})

    await expect(
      deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv(),
        fetch: fake.fetchFn,
        spawn: spawnFn,
        opencodeGo: GO_OPTIONS,
      }),
    ).rejects.toThrow(/no eligible OpenCode Go models/)
    expect(count()).toBe(0)
  })

  test('ssh and scp child processes never receive the Go or downstream key', async () => {
    const {spawnFn, envs, count} = capturingSpawn()
    const fake = makeGoFetch({liveIds: LIVE_IDS})

    await deploy({
      files: writeDeployFiles(tmpDir),
      env: makeDeployEnv(),
      fetch: fake.fetchFn,
      spawn: spawnFn,
      opencodeGo: GO_OPTIONS,
    })

    expect(count()).toBeGreaterThan(0)
    for (const env of envs) {
      expect(env).toBeDefined()
      expect(Object.keys(env ?? {})).not.toContain('CLIPROXY_OPENCODE_GO_KEY')
      expect(Object.keys(env ?? {})).not.toContain('CLIPROXY_API_KEY')
      expect(Object.values(env ?? {})).not.toContain(GO_KEY)
      expect(Object.values(env ?? {})).not.toContain(API_KEY)
      // The child still gets what ssh needs.
      expect(env?.SSH_AUTH_SOCK).toBe('/tmp/ssh-agent.sock')
    }
  })

  test('the step runs after the alias step and before the health check, and logs no key', async () => {
    const configPath = join(tmpDir, 'config.yaml')
    writeFileSync(configPath, ALIAS_YAML)
    writeFileSync(join(tmpDir, 'docker-compose.yaml'), '')
    writeFileSync(join(tmpDir, 'Caddyfile'), '')
    const alias = makeAliasFetch()
    const fallback = mock(async (url: string | URL | Request, init?: RequestInit) =>
      requestUrl(url).endsWith('/v0/management/config') ? new Response('{}', {status: 200}) : alias.fetchFn(url, init),
    ) as unknown as typeof globalThis.fetch
    const fake = makeGoFetch({liveIds: LIVE_IDS, fallback})
    const {spawnFn} = capturingSpawn()
    const logs = captureLogs()
    try {
      await deploy({
        files: {compose: join(tmpDir, 'docker-compose.yaml'), config: configPath, caddy: join(tmpDir, 'Caddyfile')},
        env: makeDeployEnv(),
        fetch: fake.fetchFn,
        spawn: spawnFn,
        opencodeGo: GO_OPTIONS,
      })

      const aliasPut = fake.requests.findIndex(r => r.method === 'PUT' && r.url.endsWith('/oauth-model-alias'))
      const goPut = fake.requests.findIndex(r => r.method === 'PUT' && r.url.endsWith('/openai-compatibility'))
      const smoke = fake.requests.findIndex(r => r.url.endsWith('/v1/chat/completions'))
      const health = fake.requests.findLastIndex(r => r.method === 'GET' && r.url.endsWith('/v0/management/config'))
      expect(aliasPut).toBeGreaterThan(-1)
      expect(goPut).toBeGreaterThan(aliasPut)
      expect(smoke).toBeGreaterThan(goPut)
      expect(health).toBeGreaterThan(smoke)
      expectNoKeys(logs.text())
    } finally {
      logs.restore()
    }
  })

  test('an applied-but-unverified Go step fails the deploy before the health check', async () => {
    const {spawnFn} = capturingSpawn()
    const fake = makeGoFetch({liveIds: LIVE_IDS, chat: {status: 500, body: {}}})

    await expect(
      deploy({
        files: writeDeployFiles(tmpDir),
        env: makeDeployEnv(),
        fetch: fake.fetchFn,
        spawn: spawnFn,
        opencodeGo: GO_OPTIONS,
      }),
    ).rejects.toThrow(/applied but unverified/i)
    expect(fake.requests.filter(r => r.method === 'GET' && r.url.endsWith('/v0/management/config'))).toHaveLength(1)
  })
})
