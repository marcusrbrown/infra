import type {CheckDeps} from './check'
import {Buffer} from 'node:buffer'

import {describe, expect, test} from 'bun:test'
import {runCheck} from './check'
import {GRAFANA_MCP_CALLER_HEADER, GRAFANA_PLACEHOLDER, LANGFUSE_PLACEHOLDER} from './constants'
import {CALLER_TOKEN, OTHER_CALLER_TOKEN} from './testing'

const PAIR = 'pk-lf-viewer1:sk-lf-viewer1'
const AUTH = `Basic ${Buffer.from(PAIR).toString('base64')}`
const STAGED = '/run/secrets/reader-gate/langfuse-basic.staged'
const CALLER_FILE = '/run/secrets/mcp-caller/token'
const DENIAL = 'Access denied. The "scores:save" permission is required to access this resource.'

interface Recorded {
  url: string
  method: string
  headers: Headers
  body: string
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}})

interface LangfuseFake {
  /** Who the credential is: a Viewer, an Editor that would be allowed to write, or a refused key. */
  role: 'viewer' | 'editor' | 'refused'
  restWrite?: (role: string) => Response
  mcpWrite?: (id: unknown) => Response
  mcpRead?: (id: unknown) => Response
  readStatus?: number
  /** The body of the REST read; the default is the real `{data: [...]}` shape. */
  readBody?: unknown
  throwOn?: string
}

function langfuse(options: LangfuseFake) {
  const recorded: Recorded[] = []
  const fetchFn: CheckDeps['fetch'] = async (url, init) => {
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? init.body : ''
    const method = init.method ?? 'GET'
    recorded.push({url, method, headers, body})
    const path = new URL(url).pathname
    if (options.throwOn === `${method} ${path}`) throw new Error('connect ECONNREFUSED')
    if (options.role === 'refused') return json({message: 'Invalid credentials'}, 401)
    if (method === 'GET' && path === '/api/public/projects') {
      const body = 'readBody' in options ? options.readBody : {data: [{id: 'p1', name: 'traces'}]}
      return json(body, options.readStatus ?? 200)
    }
    // Langfuse runs in events-only mode: the v1 read routes (traces, sessions, ...) answer 404 before auth.
    if (method === 'GET' && path.startsWith('/api/public/')) {
      return json({message: 'Not found'}, 404)
    }
    if (method === 'POST' && path === '/api/public/scores') {
      if (options.restWrite) return options.restWrite(options.role)
      return options.role === 'viewer'
        ? json({message: DENIAL, error: 'ForbiddenError'}, 403)
        : json({message: 'Invalid request data'}, 400)
    }
    if (method === 'POST' && path === '/api/public/mcp') {
      const rpc = JSON.parse(body) as {id: unknown; method: string; params?: {name?: string}}
      if (rpc.method === 'initialize')
        return json({jsonrpc: '2.0', id: rpc.id, result: {protocolVersion: '2025-06-18', capabilities: {}}})
      if (rpc.method === 'tools/list') {
        return options.mcpRead
          ? options.mcpRead(rpc.id)
          : json({jsonrpc: '2.0', id: rpc.id, result: {tools: [{name: 'listScores'}, {name: 'createScore'}]}})
      }
      if (rpc.method === 'tools/call') {
        if (options.mcpWrite) return options.mcpWrite(rpc.id)
        return options.role === 'viewer'
          ? json({jsonrpc: '2.0', id: rpc.id, error: {code: -32600, message: DENIAL}})
          : json({
              jsonrpc: '2.0',
              id: rpc.id,
              result: {content: [{type: 'text', text: 'Validation failed'}], isError: true},
            })
      }
    }
    return json({message: 'unexpected'}, 500)
  }
  return {fetchFn, recorded}
}

function deps(fetchFn: CheckDeps['fetch'], files: Record<string, string> = {[STAGED]: PAIR}): CheckDeps {
  return {
    fetch: fetchFn,
    readText: async path => {
      const content = files[path]
      if (content === undefined) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
      return content
    },
    env: {},
  }
}

const input = (value: unknown) => JSON.stringify(value)

describe('langfuse check', () => {
  test('a Viewer key reads, and both writes are refused by role: OK', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    const line = await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))
    expect(line).toBe('READER_CHECK_OK langfuse')
    expect(recorded.every(call => call.headers.get('authorization') === AUTH)).toBe(true)
    expect(recorded.every(call => new URL(call.url).origin === 'http://langfuse-web:3000')).toBe(true)
  })

  test('the write probes are harmless even if the backend accepted them', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))
    const restWrite = recorded.find(call => call.method === 'POST' && call.url.endsWith('/api/public/scores'))
    expect(restWrite?.body).toBe('{}')
    const mcpCall = recorded
      .map(call => (call.body ? (JSON.parse(call.body) as {method?: string; params?: unknown}) : null))
      .find(rpc => rpc?.method === 'tools/call')
    expect(mcpCall?.params).toEqual({name: 'createScore', arguments: {}})
  })

  test('the MCP calls send the JSON-RPC headers Langfuse requires', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))
    const mcp = recorded.filter(call => call.url.endsWith('/api/public/mcp'))
    expect(mcp.length).toBeGreaterThanOrEqual(3)
    for (const call of mcp) {
      expect(call.headers.get('content-type')).toBe('application/json')
      expect(call.headers.get('accept')).toContain('application/json')
      expect(call.headers.get('accept')).toContain('text/event-stream')
    }
  })

  test('a REST denial in the structured error shape is accepted', async () => {
    const {fetchFn} = langfuse({role: 'viewer', restWrite: () => json({code: 'access_denied', message: DENIAL}, 403)})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_OK langfuse',
    )
  })

  test('an MCP denial that arrives as HTTP 403 is accepted', async () => {
    const {fetchFn} = langfuse({role: 'viewer', mcpWrite: () => json({error: DENIAL, code: -32600}, 403)})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_OK langfuse',
    )
  })

  test('an MCP reply sent as an event stream is read', async () => {
    const {fetchFn} = langfuse({
      role: 'viewer',
      mcpWrite: id =>
        new Response(
          `event: message\ndata: ${JSON.stringify({jsonrpc: '2.0', id, error: {code: -32600, message: DENIAL}})}\n\n`,
          {
            headers: {'content-type': 'text/event-stream'},
          },
        ),
    })
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_OK langfuse',
    )
  })

  test('a refused key fails as credential-refused and still prints the sentinel', async () => {
    const {fetchFn} = langfuse({role: 'refused'})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse credential-refused',
    )
  })

  test('the REST read is GET /api/public/projects, which events-only mode serves', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))
    const read = recorded.find(call => call.method === 'GET')
    expect(new URL(read?.url ?? '').pathname).toBe('/api/public/projects')
    expect(recorded.filter(call => call.method === 'GET')).toHaveLength(1)
  })

  test.each([404, 500, 503])('a read that answers %i fails as read-failed with the status', async status => {
    const {fetchFn} = langfuse({role: 'viewer', readStatus: status})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      `READER_CHECK_FAIL langfuse read-failed:${status}`,
    )
  })

  test.each([
    ['an object with no data', {meta: {}}],
    ['a data field that is not an array', {data: {}}],
    ['an array at the top', []],
    ['null', null],
  ])('a 200 read with %s fails as read-failed:200', async (_name, readBody) => {
    const {fetchFn} = langfuse({role: 'viewer', readBody})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse read-failed:200',
    )
  })

  test('a 200 read with a body that is not JSON fails as read-failed:200', async () => {
    const fetchFn: CheckDeps['fetch'] = async () => new Response('<html>ok</html>', {status: 200})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse read-failed:200',
    )
  })

  test('an empty data array is a good read', async () => {
    const {fetchFn} = langfuse({role: 'viewer', readBody: {data: []}})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_OK langfuse',
    )
  })

  test.each([
    ['accepted with a created score (200)', () => json({id: 'x'}, 200)],
    ['accepted with 202', () => json({message: 'Accepted'}, 202)],
    ['rejected by validation, which means auth passed (400)', () => json({message: 'Invalid request data'}, 400)],
    [
      'rejected for another reason (403 ingestion suspended)',
      () => json({message: 'Ingestion suspended: Usage threshold exceeded.'}, 403),
    ],
    [
      'a 403 whose code says access_denied but whose message is not the role denial',
      () => json({code: 'access_denied', message: 'Ingestion suspended'}, 403),
    ],
    [
      'a 403 for a key that is not project-scoped',
      () => json({message: 'Access denied: MCP requires project-scoped API keys with BasicAuth'}, 403),
    ],
    [
      'a 403 for a different missing action',
      () => json({message: 'Access denied. The "scores:read" permission is required to access this resource.'}, 403),
    ],
    ['rejected as unauthenticated (401)', () => json({message: 'Unauthorized'}, 401)],
    ['a server error (500)', () => json({message: DENIAL}, 500)],
    ['a 403 with a body that is not JSON', () => new Response('<html>Forbidden</html>', {status: 403})],
    ['a 403 with an empty body', () => new Response(null, {status: 403})],
  ])('a REST write that is %s fails as rest-write-not-denied', async (_name, restWrite) => {
    const {fetchFn} = langfuse({role: 'viewer', restWrite})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      `READER_CHECK_FAIL langfuse rest-write-not-denied:${restWrite().status}`,
    )
  })

  test.each([
    [
      'a tool result (the write ran or failed inside the tool)',
      (id: unknown) => json({jsonrpc: '2.0', id, result: {content: [], isError: false}}),
    ],
    [
      'a tool-level error, which means authorisation passed',
      (id: unknown) => json({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: DENIAL}], isError: true}}),
    ],
    [
      'an unknown-tool error (-32602)',
      (id: unknown) => json({jsonrpc: '2.0', id, error: {code: -32602, message: 'Unknown tool: createScore'}}),
    ],
    ['an internal error (-32603)', (id: unknown) => json({jsonrpc: '2.0', id, error: {code: -32603, message: DENIAL}})],
    [
      'an invalid-request error that is not a permission denial',
      (id: unknown) => json({jsonrpc: '2.0', id, error: {code: -32600, message: 'Validation failed: name: Required'}}),
    ],
    ['HTTP 401', () => json({error: 'Authentication failed. Please check your API key.'}, 401)],
    ['HTTP 403 for the Host guard', () => json({error: 'Invalid Host header: langfuse-web:3000', code: -32600}, 403)],
    [
      'HTTP 403 for a key that is not project-scoped',
      () => json({error: 'Access denied: MCP requires project-scoped API keys with BasicAuth', code: -32600}, 403),
    ],
    ['a body that is not JSON', () => new Response('nope', {status: 200})],
    ['a server error', () => new Response('boom', {status: 500})],
  ])('an MCP write that is %s fails as mcp-write-not-denied', async (_name, mcpWrite) => {
    const {fetchFn} = langfuse({role: 'viewer', mcpWrite})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      `READER_CHECK_FAIL langfuse mcp-write-not-denied:${mcpWrite(1).status}`,
    )
  })

  test('an Editor-role key fails both probes (REST first)', async () => {
    const {fetchFn} = langfuse({role: 'editor'})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse rest-write-not-denied:400',
    )
  })

  test('an MCP read that fails is mcp-read-failed', async () => {
    const {fetchFn} = langfuse({
      role: 'viewer',
      mcpRead: id => json({jsonrpc: '2.0', id, error: {code: -32603, message: 'x'}}),
    })
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse mcp-read-failed:200',
    )
  })

  test.each(['GET /api/public/projects', 'POST /api/public/scores', 'POST /api/public/mcp'])(
    'a network error on %s is network-error, never success',
    async throwOn => {
      const {fetchFn} = langfuse({role: 'viewer', throwOn})
      expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
        'READER_CHECK_FAIL langfuse network-error',
      )
    },
  )

  test('a placeholder pair fails before any request', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    const line = await runCheck(
      input({kind: 'langfuse', credentialFile: STAGED}),
      deps(fetchFn, {[STAGED]: LANGFUSE_PLACEHOLDER}),
    )
    expect(line).toBe('READER_CHECK_FAIL langfuse credential-placeholder')
    expect(recorded).toHaveLength(0)
  })

  test.each([
    ['a missing file', {}, 'credential-missing'],
    ['a malformed file', {[STAGED]: 'not-a-pair'}, 'credential-malformed'],
  ])('%s fails before any request', async (_name, files, reason) => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn, files))).toBe(
      `READER_CHECK_FAIL langfuse ${reason}`,
    )
    expect(recorded).toHaveLength(0)
  })

  test.each([
    '/etc/passwd',
    '/run/secrets/reader-gate/../grafana-mcp/token',
    '/run/secrets/reader-gate/other',
    '/run/secrets/reader-gate/langfuse-basic/../x',
    'langfuse-basic',
    '',
  ])('refuses the credential path %j', async path => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    const line = await runCheck(input({kind: 'langfuse', credentialFile: path}), deps(fetchFn, {[path]: PAIR}))
    expect(line).toBe('READER_CHECK_FAIL langfuse invalid-input')
    expect(recorded).toHaveLength(0)
  })

  test('the live and previous files are valid credential paths', async () => {
    for (const path of [
      '/run/secrets/reader-gate/langfuse-basic',
      '/run/secrets/reader-gate/langfuse-basic.previous',
    ]) {
      const {fetchFn} = langfuse({role: 'viewer'})
      expect(await runCheck(input({kind: 'langfuse', credentialFile: path}), deps(fetchFn, {[path]: PAIR}))).toBe(
        'READER_CHECK_OK langfuse',
      )
    }
  })

  test('the upstream comes from the environment', async () => {
    const {fetchFn, recorded} = langfuse({role: 'viewer'})
    const withEnv = {...deps(fetchFn), env: {LANGFUSE_UPSTREAM: 'http://lf.test:9'}}
    await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), withEnv)
    expect(recorded.every(call => new URL(call.url).origin === 'http://lf.test:9')).toBe(true)
  })

  test('no output ever carries credential material', async () => {
    const outputs: string[] = []
    for (const options of [
      {role: 'viewer'},
      {role: 'refused'},
      {role: 'editor'},
      {role: 'viewer', throwOn: 'GET /api/public/projects'},
    ] as const) {
      const {fetchFn} = langfuse(options)
      outputs.push(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn)))
    }
    outputs.push(
      await runCheck(
        input({kind: 'langfuse', credentialFile: STAGED}),
        deps(langfuse({role: 'viewer'}).fetchFn, {[STAGED]: 'pk-lf-bad'}),
      ),
    )
    for (const output of outputs) {
      expect(output.split('\n')).toHaveLength(1)
      expect(output).not.toContain('pk-lf')
      expect(output).not.toContain('sk-lf')
      expect(output).not.toContain(Buffer.from(PAIR).toString('base64'))
    }
  })
})

describe('langfuse-refused check', () => {
  test('a key Langfuse answers 401 to is OK', async () => {
    const {fetchFn, recorded} = langfuse({role: 'refused'})
    const line = await runCheck(input({kind: 'langfuse-refused', credentialFile: STAGED}), deps(fetchFn))
    expect(line).toBe('READER_CHECK_OK langfuse-refused')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.method).toBe('GET')
  })

  test('a key Langfuse still accepts is a failure', async () => {
    const {fetchFn} = langfuse({role: 'viewer'})
    expect(await runCheck(input({kind: 'langfuse-refused', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse-refused still-accepted',
    )
  })

  test.each([403, 500, 503])('a %i is not proof of refusal', async status => {
    const fetchFn: CheckDeps['fetch'] = async () => json({message: 'x'}, status)
    expect(await runCheck(input({kind: 'langfuse-refused', credentialFile: STAGED}), deps(fetchFn))).toBe(
      `READER_CHECK_FAIL langfuse-refused unexpected-status:${status}`,
    )
  })

  test('a network error is not proof of refusal', async () => {
    const fetchFn: CheckDeps['fetch'] = async () => {
      throw new Error('connect ECONNREFUSED')
    }
    expect(await runCheck(input({kind: 'langfuse-refused', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse-refused network-error',
    )
  })
})

interface Tool {
  name: string
  annotations?: {readOnlyHint?: boolean}
  inputSchema?: {required?: string[]}
}

const readTool = (name: string): Tool => ({
  name,
  annotations: {readOnlyHint: true},
  inputSchema: {type: 'object'} as Tool['inputSchema'],
})

function grafana(options: {
  tools?: Tool[]
  call?: (id: unknown, name: string) => Response
  throwOn?: string
  initializeStatus?: number
}) {
  const recorded: Recorded[] = []
  const fetchFn: CheckDeps['fetch'] = async (url, init) => {
    const headers = new Headers(init.headers)
    const body = typeof init.body === 'string' ? init.body : ''
    recorded.push({url, method: init.method ?? 'GET', headers, body})
    if (new URL(url).pathname !== '/mcp') return json({}, 404)
    // The real server refuses a request without its caller token before it reads the body.
    if (headers.get(GRAFANA_MCP_CALLER_HEADER) !== CALLER_TOKEN) return new Response('unauthorized', {status: 401})
    const rpc = JSON.parse(body) as {id?: unknown; method: string; params?: {name?: string}}
    if (options.throwOn === rpc.method) throw new Error('connect ECONNREFUSED')
    if (rpc.method === 'initialize') {
      if (options.initializeStatus) return json({}, options.initializeStatus)
      return json({jsonrpc: '2.0', id: rpc.id, result: {protocolVersion: '2025-06-18', capabilities: {}}})
    }
    if (rpc.method === 'notifications/initialized') return new Response(null, {status: 202})
    if (rpc.method === 'tools/list') {
      return json({
        jsonrpc: '2.0',
        id: rpc.id,
        result: {tools: options.tools ?? [readTool('list_datasources'), readTool('query_prometheus')]},
      })
    }
    if (rpc.method === 'tools/call') {
      if (options.call) return options.call(rpc.id, rpc.params?.name ?? '')
      return json({jsonrpc: '2.0', id: rpc.id, result: {content: [{type: 'text', text: '[]'}]}})
    }
    return json({}, 500)
  }
  return {fetchFn, recorded}
}

const grafanaInput = input({kind: 'grafana-mcp'})
const unauthenticatedInput = input({kind: 'grafana-mcp-unauthenticated'})
const callerInput = input({kind: 'grafana-mcp-caller'})

/** The gate's check reads the caller token from its file, as the gate does. */
function grafanaDeps(
  fetchFn: CheckDeps['fetch'],
  files: Record<string, string> = {[CALLER_FILE]: `${CALLER_TOKEN}\n`},
) {
  return deps(fetchFn, files)
}

describe('grafana-mcp check', () => {
  test('every request carries the caller header with the file value, and none carries Authorization', async () => {
    const {fetchFn, recorded} = grafana({})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect(recorded).toHaveLength(4)
    for (const call of recorded) {
      expect(call.headers.get(GRAFANA_MCP_CALLER_HEADER)).toBe(CALLER_TOKEN)
      expect(call.headers.has('authorization')).toBe(false)
    }
  })

  test.each([
    ['missing', undefined, 'caller-token-missing'],
    ['unreadable', 'EACCES', 'caller-token-unreadable'],
    ['empty', '', 'caller-token-malformed'],
    ['two words', 'abc def', 'caller-token-malformed'],
    [
      'two words that join to a valid token',
      `${CALLER_TOKEN.slice(0, 20)} ${CALLER_TOKEN.slice(20)}`,
      'caller-token-malformed',
    ],
  ] as const)('a %s caller token file fails as %s and makes no request', async (_name, state, reason) => {
    const {fetchFn, recorded} = grafana({})
    const readText: CheckDeps['readText'] = async () => {
      if (state === undefined) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
      if (state === 'EACCES') throw Object.assign(new Error('EACCES'), {code: 'EACCES'})
      return state
    }
    expect(await runCheck(grafanaInput, {fetch: fetchFn, readText, env: {}})).toBe(
      `READER_CHECK_FAIL grafana-mcp ${reason}`,
    )
    expect(recorded).toHaveLength(0)
  })

  test('the caller token file comes from the environment', async () => {
    const {fetchFn} = grafana({})
    const files = {'/x/caller': CALLER_TOKEN}
    expect(
      await runCheck(grafanaInput, {...grafanaDeps(fetchFn, files), env: {GRAFANA_MCP_CALLER_FILE: '/x/caller'}}),
    ).toBe('READER_CHECK_OK grafana-mcp')
  })

  test('a caller token the server does not know fails as caller-token-refused, not as a broken handshake', async () => {
    const {fetchFn} = grafana({})
    const files = {[CALLER_FILE]: OTHER_CALLER_TOKEN}
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn, files))).toBe(
      'READER_CHECK_FAIL grafana-mcp caller-token-refused',
    )
  })

  test('the caller token never appears in the sentinel, whatever fails', async () => {
    const {fetchFn} = grafana({tools: [readTool('list_datasources'), {name: 'update_dashboard'}]})
    const line = await runCheck(grafanaInput, grafanaDeps(fetchFn))
    expect(line).toBe('READER_CHECK_FAIL grafana-mcp write-tool-present')
    expect(line).not.toContain(CALLER_TOKEN)
  })

  test('read-only tools and one successful read call: OK', async () => {
    const {fetchFn, recorded} = grafana({})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect(recorded.every(call => call.url === 'http://grafana-mcp:8000/mcp')).toBe(true)
    expect(recorded.every(call => !call.headers.has('authorization'))).toBe(true)
    const methods = recorded.map(call => (JSON.parse(call.body) as {method: string}).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  })

  test('the read call is list_datasources with no arguments', async () => {
    const {fetchFn, recorded} = grafana({})
    await runCheck(grafanaInput, grafanaDeps(fetchFn))
    const call = JSON.parse(recorded.at(-1)?.body ?? '{}') as {params: unknown}
    expect(call.params).toEqual({name: 'list_datasources', arguments: {}})
  })

  test('falls back to a read tool that needs no arguments when list_datasources is absent', async () => {
    const {fetchFn, recorded} = grafana({
      tools: [
        {name: 'query_prometheus', annotations: {readOnlyHint: true}, inputSchema: {required: ['expr']}},
        {name: 'list_alert_groups', annotations: {readOnlyHint: true}, inputSchema: {}},
      ],
    })
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect((JSON.parse(recorded.at(-1)?.body ?? '{}') as {params: {name: string}}).params.name).toBe(
      'list_alert_groups',
    )
  })

  test.each([
    [
      'a tool annotated as not read-only',
      [readTool('list_datasources'), {name: 'update_dashboard', annotations: {readOnlyHint: false}}],
    ],
    ['a tool with no annotations', [readTool('list_datasources'), {name: 'mystery'}]],
    ['a tool with empty annotations', [readTool('list_datasources'), {name: 'mystery', annotations: {}}]],
    ['a write-named tool that claims to be read-only', [readTool('list_datasources'), readTool('create_incident')]],
    ['a delete-named tool that claims to be read-only', [readTool('list_datasources'), readTool('delete_dashboard')]],
    ['an update-named tool that claims to be read-only', [readTool('list_datasources'), readTool('update_datasource')]],
  ])('%s fails as write-tool-present', async (_name, tools) => {
    const {fetchFn} = grafana({tools})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp write-tool-present')
  })

  test('an empty tool list fails as tools-empty', async () => {
    const {fetchFn} = grafana({tools: []})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp tools-empty')
  })

  test('no tool the check could call without arguments fails as read-tool-missing', async () => {
    const {fetchFn} = grafana({
      tools: [{name: 'query_prometheus', annotations: {readOnlyHint: true}, inputSchema: {required: ['expr']}}],
    })
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp read-tool-missing')
  })

  test.each([
    [
      'a tool-level error',
      (id: unknown) =>
        json({jsonrpc: '2.0', id, result: {content: [{type: 'text', text: 'unauthorized'}], isError: true}}),
    ],
    ['a protocol error', (id: unknown) => json({jsonrpc: '2.0', id, error: {code: -32603, message: 'x'}})],
    ['an HTTP error', () => json({}, 502)],
  ])('a read call that returns %s fails as read-call-failed', async (_name, call) => {
    const {fetchFn} = grafana({call})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp read-call-failed')
  })

  test('a handshake that fails is mcp-handshake-failed', async () => {
    const {fetchFn} = grafana({initializeStatus: 403})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe(
      'READER_CHECK_FAIL grafana-mcp mcp-handshake-failed',
    )
  })

  test.each(['initialize', 'tools/list', 'tools/call'])('a network error on %s is network-error', async throwOn => {
    const {fetchFn} = grafana({throwOn})
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp network-error')
  })

  test('carries the MCP session id through when the server issues one', async () => {
    const recorded: Recorded[] = []
    const fetchFn: CheckDeps['fetch'] = async (url, init) => {
      const body = typeof init.body === 'string' ? init.body : ''
      recorded.push({url, method: 'POST', headers: new Headers(init.headers), body})
      const rpc = JSON.parse(body) as {id?: unknown; method: string}
      if (rpc.method === 'initialize') {
        return new Response(JSON.stringify({jsonrpc: '2.0', id: rpc.id, result: {}}), {
          headers: {'content-type': 'application/json', 'mcp-session-id': 'sess-1'},
        })
      }
      if (rpc.method === 'notifications/initialized') return new Response(null, {status: 202})
      if (rpc.method === 'tools/list')
        return json({jsonrpc: '2.0', id: rpc.id, result: {tools: [readTool('list_datasources')]}})
      return json({jsonrpc: '2.0', id: rpc.id, result: {content: []}})
    }
    expect(await runCheck(grafanaInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect(recorded.slice(1).every(call => call.headers.get('mcp-session-id') === 'sess-1')).toBe(true)
  })

  test('the upstream comes from the environment', async () => {
    const {fetchFn, recorded} = grafana({})
    await runCheck(grafanaInput, {...grafanaDeps(fetchFn), env: {GRAFANA_MCP_UPSTREAM: 'http://gm.test:9'}})
    expect(recorded.every(call => call.url === 'http://gm.test:9/mcp')).toBe(true)
  })

  test('the placeholder constant is not what a live token looks like', () => {
    expect(GRAFANA_PLACEHOLDER).toBe('glsa_unset')
  })
})

/** A server that answers a request that has no caller header with `status`, and records what it was sent. */
function unauthenticated(status: number, options: {throws?: boolean} = {}) {
  const recorded: Recorded[] = []
  const fetchFn: CheckDeps['fetch'] = async (url, init) => {
    recorded.push({
      url,
      method: init.method ?? 'GET',
      headers: new Headers(init.headers),
      body: typeof init.body === 'string' ? init.body : '',
    })
    if (options.throws) throw new Error('connect ECONNREFUSED')
    return new Response('unauthorized: missing bearer token', {status})
  }
  return {fetchFn, recorded}
}

describe('grafana-mcp-unauthenticated check', () => {
  test('a 401 to a request with no credential at all proves the policy is active: OK', async () => {
    const {fetchFn, recorded} = unauthenticated(401)
    expect(await runCheck(unauthenticatedInput, deps(fetchFn, {}))).toBe('READER_CHECK_OK grafana-mcp-unauthenticated')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.url).toBe('http://grafana-mcp:8000/mcp')
    expect(recorded[0]?.method).toBe('POST')
    // The point of the probe: nothing a caller could be recognised by.
    expect(
      [...(recorded[0]?.headers.keys() ?? [])].filter(name => /authorization|token|x-grafana|cookie/.test(name)),
    ).toEqual([])
  })

  test('does not read the caller token file, so it cannot be satisfied by a bug that sends it', async () => {
    const {fetchFn} = unauthenticated(401)
    let reads = 0
    const readText: CheckDeps['readText'] = async () => {
      reads += 1
      return CALLER_TOKEN
    }
    await runCheck(unauthenticatedInput, {fetch: fetchFn, readText, env: {}})
    expect(reads).toBe(0)
  })

  test.each([
    [200, 'not-refused:200'],
    [202, 'not-refused:202'],
    [403, 'not-refused:403'],
    [404, 'not-refused:404'],
    [500, 'not-refused:500'],
  ])('a %i answer is not the refusal the policy gives, and the status is recorded: %s', async (status, reason) => {
    const {fetchFn} = unauthenticated(status)
    expect(await runCheck(unauthenticatedInput, deps(fetchFn, {}))).toBe(
      `READER_CHECK_FAIL grafana-mcp-unauthenticated ${reason}`,
    )
  })

  test('a network error is a failure, never a pass', async () => {
    const {fetchFn} = unauthenticated(401, {throws: true})
    expect(await runCheck(unauthenticatedInput, deps(fetchFn, {}))).toBe(
      'READER_CHECK_FAIL grafana-mcp-unauthenticated network-error',
    )
  })

  test('the upstream comes from the environment', async () => {
    const {fetchFn, recorded} = unauthenticated(401)
    await runCheck(unauthenticatedInput, {...deps(fetchFn, {}), env: {GRAFANA_MCP_UPSTREAM: 'http://gm.test:9'}})
    expect(recorded[0]?.url).toBe('http://gm.test:9/mcp')
  })
})

describe('grafana-mcp-caller check', () => {
  /** A server that knows one caller token, answers `initialize` with it, and records every request. */
  function server(options: {known?: string; status?: number; body?: unknown; throws?: boolean} = {}) {
    const recorded: Recorded[] = []
    const fetchFn: CheckDeps['fetch'] = async (url, init) => {
      const headers = new Headers(init.headers)
      recorded.push({
        url,
        method: init.method ?? 'GET',
        headers,
        body: typeof init.body === 'string' ? init.body : '',
      })
      if (options.throws) throw new Error('connect ECONNREFUSED')
      if (headers.get(GRAFANA_MCP_CALLER_HEADER) !== (options.known ?? CALLER_TOKEN)) {
        return new Response('unauthorized: invalid bearer token', {status: 401})
      }
      const rpc = JSON.parse(typeof init.body === 'string' ? init.body : '{}') as {id?: unknown}
      return json(
        options.body ?? {jsonrpc: '2.0', id: rpc.id, result: {protocolVersion: '2025-06-18', capabilities: {}}},
        options.status ?? 200,
      )
    }
    return {fetchFn, recorded}
  }

  test('an initialize that carries the configured token and succeeds: OK, and it needs no Grafana credential', async () => {
    const {fetchFn, recorded} = server()
    expect(await runCheck(callerInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp-caller')
    expect(recorded).toHaveLength(1)
    expect(recorded[0]?.url).toBe('http://grafana-mcp:8000/mcp')
    expect(recorded[0]?.method).toBe('POST')
    expect(recorded[0]?.headers.get(GRAFANA_MCP_CALLER_HEADER)).toBe(CALLER_TOKEN)
    expect(recorded[0]?.headers.has('authorization')).toBe(false)
    expect((JSON.parse(recorded[0]?.body ?? '{}') as {method: string}).method).toBe('initialize')
  })

  test('a token the server does not know is caller-token-refused, not a generic failure', async () => {
    const {fetchFn} = server({known: OTHER_CALLER_TOKEN})
    expect(await runCheck(callerInput, grafanaDeps(fetchFn))).toBe(
      'READER_CHECK_FAIL grafana-mcp-caller caller-token-refused',
    )
  })

  test.each([
    ['a 403', 403, {message: 'forbidden'}, 'not-initialised:403'],
    ['a 500', 500, {}, 'not-initialised:500'],
    ['a 200 with no JSON-RPC result', 200, {jsonrpc: '2.0', id: 1}, 'not-initialised:200'],
    [
      'a 200 with a JSON-RPC error',
      200,
      {jsonrpc: '2.0', id: 1, error: {code: -32603, message: 'x'}},
      'not-initialised:200',
    ],
    ['a 200 that is not JSON-RPC', 200, {result: {}}, 'not-initialised:200'],
    ['a 202', 202, {jsonrpc: '2.0', id: 1, result: {}}, 'not-initialised:202'],
  ])('%s is not an initialised session, and the status is recorded: %s', async (_name, status, body, reason) => {
    const {fetchFn} = server({status, body})
    expect(await runCheck(callerInput, grafanaDeps(fetchFn))).toBe(`READER_CHECK_FAIL grafana-mcp-caller ${reason}`)
  })

  test('a network error is a failure', async () => {
    const {fetchFn} = server({throws: true})
    expect(await runCheck(callerInput, grafanaDeps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp-caller network-error')
  })

  test.each([
    ['missing', undefined, 'caller-token-missing'],
    ['unreadable', 'EACCES', 'caller-token-unreadable'],
    ['empty', '', 'caller-token-malformed'],
    ['two words', 'abc def', 'caller-token-malformed'],
    [
      'two words that join to a valid token',
      `${CALLER_TOKEN.slice(0, 20)} ${CALLER_TOKEN.slice(20)}`,
      'caller-token-malformed',
    ],
    ['too short', CALLER_TOKEN.slice(1), 'caller-token-malformed'],
  ] as const)('a %s caller token file fails as %s and makes no request', async (_name, state, reason) => {
    const {fetchFn, recorded} = server()
    const readText: CheckDeps['readText'] = async () => {
      if (state === undefined) throw Object.assign(new Error('ENOENT'), {code: 'ENOENT'})
      if (state === 'EACCES') throw Object.assign(new Error('EACCES'), {code: 'EACCES'})
      return state
    }
    expect(await runCheck(callerInput, {fetch: fetchFn, readText, env: {}})).toBe(
      `READER_CHECK_FAIL grafana-mcp-caller ${reason}`,
    )
    expect(recorded).toHaveLength(0)
  })

  test('the token is never in the sentinel', async () => {
    const {fetchFn} = server({known: OTHER_CALLER_TOKEN})
    const line = await runCheck(callerInput, grafanaDeps(fetchFn))
    expect(line).not.toContain(CALLER_TOKEN)
    expect(line).not.toContain(OTHER_CALLER_TOKEN)
  })
})

describe('input handling', () => {
  test.each([
    ['empty stdin', ''],
    ['not JSON', 'nope'],
    ['a JSON array', '[]'],
    ['a JSON string', '"langfuse"'],
    ['an unknown kind', input({kind: 'redis'})],
    ['no kind', input({credentialFile: STAGED})],
    ['langfuse without a credential file', input({kind: 'langfuse'})],
    ['a non-string credential file', input({kind: 'langfuse', credentialFile: 5})],
  ])('%s prints one failing sentinel and makes no request', async (_name, stdin) => {
    let calls = 0
    const fetchFn: CheckDeps['fetch'] = async () => {
      calls += 1
      return json({})
    }
    const line = await runCheck(stdin, deps(fetchFn))
    expect(line).toMatch(
      /^READER_CHECK_FAIL (unknown|langfuse|langfuse-refused|grafana-mcp|grafana-mcp-unauthenticated|grafana-mcp-caller) invalid-input$/,
    )
    expect(calls).toBe(0)
  })

  test('an unknown kind is never echoed back', async () => {
    const line = await runCheck(
      input({kind: 'x'.repeat(200)}),
      deps(async () => json({})),
    )
    expect(line).toBe('READER_CHECK_FAIL unknown invalid-input')
  })
})
