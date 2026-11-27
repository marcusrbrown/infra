import type {CheckDeps} from './check'
import {Buffer} from 'node:buffer'

import {describe, expect, test} from 'bun:test'
import {runCheck} from './check'
import {GRAFANA_PLACEHOLDER, LANGFUSE_PLACEHOLDER} from './constants'

const PAIR = 'pk-lf-viewer1:sk-lf-viewer1'
const AUTH = `Basic ${Buffer.from(PAIR).toString('base64')}`
const STAGED = '/run/secrets/reader-gate/langfuse-basic.staged'
const DENIAL = 'Access denied. You do not have permission to access this resource.'

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
    if (method === 'GET' && path === '/api/public/traces') return json({data: [], meta: {}}, options.readStatus ?? 200)
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

  test('a read that answers anything but 200 fails as read-failed', async () => {
    const {fetchFn} = langfuse({role: 'viewer', readStatus: 500})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse read-failed',
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
    ['rejected as unauthenticated (401)', () => json({message: 'Unauthorized'}, 401)],
    ['a server error (500)', () => json({message: DENIAL}, 500)],
    ['a 403 with a body that is not JSON', () => new Response('<html>Forbidden</html>', {status: 403})],
    ['a 403 with an empty body', () => new Response(null, {status: 403})],
  ])('a REST write that is %s fails as rest-write-not-denied', async (_name, restWrite) => {
    const {fetchFn} = langfuse({role: 'viewer', restWrite})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse rest-write-not-denied',
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
      'READER_CHECK_FAIL langfuse mcp-write-not-denied',
    )
  })

  test('an Editor-role key fails both probes (REST first)', async () => {
    const {fetchFn} = langfuse({role: 'editor'})
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse rest-write-not-denied',
    )
  })

  test('an MCP read that fails is mcp-read-failed', async () => {
    const {fetchFn} = langfuse({
      role: 'viewer',
      mcpRead: id => json({jsonrpc: '2.0', id, error: {code: -32603, message: 'x'}}),
    })
    expect(await runCheck(input({kind: 'langfuse', credentialFile: STAGED}), deps(fetchFn))).toBe(
      'READER_CHECK_FAIL langfuse mcp-read-failed',
    )
  })

  test.each(['GET /api/public/traces', 'POST /api/public/scores', 'POST /api/public/mcp'])(
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
      {role: 'viewer', throwOn: 'GET /api/public/traces'},
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
      'READER_CHECK_FAIL langfuse-refused unexpected-status',
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

describe('grafana-mcp check', () => {
  test('read-only tools and one successful read call: OK', async () => {
    const {fetchFn, recorded} = grafana({})
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect(recorded.every(call => call.url === 'http://grafana-mcp:8000/mcp')).toBe(true)
    expect(recorded.every(call => !call.headers.has('authorization'))).toBe(true)
    const methods = recorded.map(call => (JSON.parse(call.body) as {method: string}).method)
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call'])
  })

  test('the read call is list_datasources with no arguments', async () => {
    const {fetchFn, recorded} = grafana({})
    await runCheck(grafanaInput, deps(fetchFn))
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
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
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
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp write-tool-present')
  })

  test('an empty tool list fails as tools-empty', async () => {
    const {fetchFn} = grafana({tools: []})
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp tools-empty')
  })

  test('no tool the check could call without arguments fails as read-tool-missing', async () => {
    const {fetchFn} = grafana({
      tools: [{name: 'query_prometheus', annotations: {readOnlyHint: true}, inputSchema: {required: ['expr']}}],
    })
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp read-tool-missing')
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
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp read-call-failed')
  })

  test('a handshake that fails is mcp-handshake-failed', async () => {
    const {fetchFn} = grafana({initializeStatus: 403})
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp mcp-handshake-failed')
  })

  test.each(['initialize', 'tools/list', 'tools/call'])('a network error on %s is network-error', async throwOn => {
    const {fetchFn} = grafana({throwOn})
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_FAIL grafana-mcp network-error')
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
    expect(await runCheck(grafanaInput, deps(fetchFn))).toBe('READER_CHECK_OK grafana-mcp')
    expect(recorded.slice(1).every(call => call.headers.get('mcp-session-id') === 'sess-1')).toBe(true)
  })

  test('the upstream comes from the environment', async () => {
    const {fetchFn, recorded} = grafana({})
    await runCheck(grafanaInput, {...deps(fetchFn), env: {GRAFANA_MCP_UPSTREAM: 'http://gm.test:9'}})
    expect(recorded.every(call => call.url === 'http://gm.test:9/mcp')).toBe(true)
  })

  test('the placeholder constant is not what a live token looks like', () => {
    expect(GRAFANA_PLACEHOLDER).toBe('glsa_unset')
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
    expect(line).toMatch(/^READER_CHECK_FAIL (unknown|langfuse|langfuse-refused|grafana-mcp) invalid-input$/)
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
