// The private check entrypoint: `docker compose exec -T reader-gate bun /app/check.ts`. It listens on no port.
//
// stdin is one JSON object, stdout is one sentinel line, and the exit code is 0 whatever the verdict (the sentinel is
// the verdict):
//
//   {"kind":"langfuse","credentialFile":"/run/secrets/reader-gate/langfuse-basic.staged"}
//       The pair in that file reads from Langfuse over REST (`GET /api/public/projects`, a route that events-only mode
//       serves, unlike the v1 trace routes) and MCP, and Langfuse refuses a REST write and an MCP
//       write tool call because of the key's role. A success, a network error, a validation error or any other
//       denial is a failure: only an authorisation denial proves a Viewer key.
//   {"kind":"langfuse-refused","credentialFile":"/run/secrets/reader-gate/langfuse-basic.previous"}
//       Langfuse answers 401 to the pair in that file (the old key is revoked).
//   {"kind":"grafana-mcp"}
//       `tools/list` on grafana-mcp holds only read tools, and one read tool call succeeds. grafana-mcp reads its own
//       service-account token file, so the check sends no credential.
//
//   READER_CHECK_OK <kind>
//   READER_CHECK_FAIL <kind> <reason>        <reason> is one of a fixed set of words; a reason for an unexpected
//                                            Langfuse reply ends in `:<status>`, for example `read-failed:404`
//
// The check goes straight to the upstream, with no reader token and no gate. Nothing it prints can carry a credential:
// the sentinel is built from fixed words and a three-digit status code only. The credential file must be one of the
// Langfuse credential files.
// The write probes send empty bodies and arguments, so they change nothing even if a backend wrongly accepted them.

import type {Env} from './config'
import {loadConfig} from './config'
import {CHECK_TIMEOUT_MS} from './constants'
import {parseLangfuseBasic} from './credentials'
import {errorCode, readTextFile} from './io'

export interface CheckDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  readText: (path: string) => Promise<string>
  env: Env
}

type Kind = 'langfuse' | 'langfuse-refused' | 'grafana-mcp'

const KINDS: readonly Kind[] = ['langfuse', 'langfuse-refused', 'grafana-mcp']

class CheckFailure extends Error {
  constructor(readonly reason: string) {
    super(reason)
  }
}

interface Reply {
  status: number
  body: unknown
  headers: Headers
}

const ROLE_DENIAL = /do not have permission/i
const WRITE_NAME =
  /(?:^|_)(?:create|update|delete|remove|write|patch|add|set|import|upload|send|trigger|restore)(?:_|$)/
const ACCEPT = 'application/json, text/event-stream'

export async function runCheck(stdin: string, deps: CheckDeps): Promise<string> {
  const input = parseInput(stdin)
  if (input === null) return `READER_CHECK_FAIL ${kindOf(stdin)} invalid-input`
  try {
    const config = loadConfig(deps.env)
    if (input.kind === 'grafana-mcp') await checkGrafana(`${config.grafanaMcpUpstream}/mcp`, deps)
    else {
      const path = input.credentialFile ?? ''
      if (!isCredentialPath(path, config.langfuseBasicFile)) throw new CheckFailure('invalid-input')
      const authorization = await loadAuthorization(path, deps)
      if (input.kind === 'langfuse') await checkLangfuse(config.langfuseUpstream, authorization, deps)
      else await checkRefused(config.langfuseUpstream, authorization, deps)
    }
    return `READER_CHECK_OK ${input.kind}`
  } catch (error) {
    return `READER_CHECK_FAIL ${input.kind} ${error instanceof CheckFailure ? error.reason : 'check-error'}`
  }
}

// ─── Input ────────────────────────────────────────────────────────────────────

interface Input {
  kind: Kind
  credentialFile?: string
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asKind(value: unknown): Kind | null {
  return KINDS.find(kind => kind === value) ?? null
}

/** The kind to name in a failure, taken only from the known set. */
function kindOf(stdin: string): Kind | 'unknown' {
  const value = parseJson(stdin)
  return (isRecord(value) ? asKind(value.kind) : null) ?? 'unknown'
}

function parseInput(stdin: string): Input | null {
  const value = parseJson(stdin)
  if (!isRecord(value)) return null
  const kind = asKind(value.kind)
  if (kind === null) return null
  if (kind === 'grafana-mcp') return {kind}
  if (typeof value.credentialFile !== 'string') return null
  return {kind, credentialFile: value.credentialFile}
}

/** The live, staged and previous Langfuse credential files, and nothing else. */
function isCredentialPath(path: string, livePath: string): boolean {
  const slash = livePath.lastIndexOf('/')
  const dir = livePath.slice(0, slash)
  const name = livePath.slice(slash + 1)
  return [name, `${name}.staged`, `${name}.previous`].some(candidate => path === `${dir}/${candidate}`)
}

async function loadAuthorization(path: string, deps: CheckDeps): Promise<string> {
  let text: string
  try {
    text = await deps.readText(path)
  } catch (error) {
    throw new CheckFailure(errorCode(error) === 'ENOENT' ? 'credential-missing' : 'credential-unreadable')
  }
  const credential = parseLangfuseBasic(text)
  if (!credential.ok) throw new CheckFailure(`credential-${credential.reason}`)
  return credential.authorization
}

// ─── Requests ─────────────────────────────────────────────────────────────────

async function send(deps: CheckDeps, url: string, init: RequestInit): Promise<Reply> {
  let response: Response
  try {
    response = await deps.fetch(url, {...init, redirect: 'manual', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS)})
  } catch {
    throw new CheckFailure('network-error')
  }
  let text: string
  try {
    text = await response.text()
  } catch {
    throw new CheckFailure('network-error')
  }
  const contentType = response.headers.get('content-type') ?? ''
  return {status: response.status, headers: response.headers, body: parseBody(text, contentType)}
}

/** A JSON body, or the last `data:` event of an event stream. Anything else is null. */
function parseBody(text: string, contentType: string): unknown {
  if (!contentType.includes('text/event-stream')) return parseJson(text)
  const data = text
    .split('\n')
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice('data:'.length).trim())
    .at(-1)
  return data === undefined ? null : parseJson(data)
}

let nextId = 0

function rpc(method: string, params?: unknown): string {
  nextId += 1
  return JSON.stringify({jsonrpc: '2.0', id: nextId, method, ...(params === undefined ? {} : {params})})
}

function notification(method: string): string {
  return JSON.stringify({jsonrpc: '2.0', method})
}

function post(headers: Record<string, string>, body: string): RequestInit {
  return {method: 'POST', headers: {'content-type': 'application/json', accept: ACCEPT, ...headers}, body}
}

function result(reply: Reply): Record<string, unknown> | null {
  if (reply.status !== 200 || !isRecord(reply.body) || !isRecord(reply.body.result)) return null
  return reply.body.result
}

// ─── Langfuse ─────────────────────────────────────────────────────────────────

/** A reason that carries the HTTP status of the reply that failed it, so a failure is diagnosable without logs. */
function withStatus(reason: string, reply: Reply): string {
  return `${reason}:${reply.status}`
}

/** `/api/public/projects` needs only `project:read`, and Langfuse answers it in events-only mode: `{data: [...]}`. */
async function readLangfuse(base: string, authorization: string, deps: CheckDeps): Promise<Reply> {
  return send(deps, `${base}/api/public/projects`, {
    method: 'GET',
    headers: {authorization, accept: 'application/json'},
  })
}

async function checkLangfuse(base: string, authorization: string, deps: CheckDeps): Promise<void> {
  const read = await readLangfuse(base, authorization, deps)
  if (read.status === 401) throw new CheckFailure('credential-refused')
  if (read.status !== 200 || !isRecord(read.body) || !Array.isArray(read.body.data)) {
    throw new CheckFailure(withStatus('read-failed', read))
  }

  const mcp = `${base}/api/public/mcp`
  const mcpHeaders = {authorization}
  const initialize = await send(
    deps,
    mcp,
    post(
      mcpHeaders,
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {name: 'reader-gate-check', version: '1'},
      }),
    ),
  )
  if (result(initialize) === null) throw new CheckFailure(withStatus('mcp-read-failed', initialize))
  const listReply = await send(deps, mcp, post(mcpHeaders, rpc('tools/list')))
  const list = result(listReply)
  if (list === null || !Array.isArray(list.tools)) throw new CheckFailure(withStatus('mcp-read-failed', listReply))

  const restWrite = await send(deps, `${base}/api/public/scores`, post({authorization}, '{}'))
  if (!isRoleDenial(restWrite, 403)) throw new CheckFailure(withStatus('rest-write-not-denied', restWrite))

  const mcpWrite = await send(deps, mcp, post(mcpHeaders, rpc('tools/call', {name: 'createScore', arguments: {}})))
  if (!isMcpRoleDenial(mcpWrite)) throw new CheckFailure(withStatus('mcp-write-not-denied', mcpWrite))
}

async function checkRefused(base: string, authorization: string, deps: CheckDeps): Promise<void> {
  const read = await readLangfuse(base, authorization, deps)
  if (read.status === 401) return
  throw new CheckFailure(read.status === 200 ? 'still-accepted' : withStatus('unexpected-status', read))
}

/** The text a Langfuse error body carries: `message`, `error` as a string, or `error.message`. */
function errorText(body: unknown): string {
  if (!isRecord(body)) return ''
  if (typeof body.message === 'string') return body.message
  if (typeof body.error === 'string') return body.error
  if (isRecord(body.error) && typeof body.error.message === 'string') return body.error.message
  return ''
}

/** HTTP `status` with Langfuse's own role-denial message. A 403 for another reason (Host guard, suspension) is not a denial. */
function isRoleDenial(reply: Reply, status: number): boolean {
  return reply.status === status && ROLE_DENIAL.test(errorText(reply.body))
}

/** A JSON-RPC invalid-request error with the role-denial message, or the same message in a bare 403. */
function isMcpRoleDenial(reply: Reply): boolean {
  if (isRoleDenial(reply, 403)) return true
  if (reply.status !== 200 || !isRecord(reply.body) || !isRecord(reply.body.error)) return false
  return reply.body.error.code === -32_600 && ROLE_DENIAL.test(errorText(reply.body.error))
}

// ─── Grafana MCP ──────────────────────────────────────────────────────────────

const PREFERRED_READ_TOOL = 'list_datasources'

interface Tool {
  name: string
  annotations?: unknown
  inputSchema?: unknown
}

function isTool(value: unknown): value is Tool {
  return isRecord(value) && typeof value.name === 'string'
}

function isReadOnly(tool: Tool): boolean {
  return isRecord(tool.annotations) && tool.annotations.readOnlyHint === true && !WRITE_NAME.test(tool.name)
}

function needsNoArguments(tool: Tool): boolean {
  if (!isRecord(tool.inputSchema)) return true
  const required = tool.inputSchema.required
  return !Array.isArray(required) || required.length === 0
}

async function checkGrafana(url: string, deps: CheckDeps): Promise<void> {
  const initialize = await send(
    deps,
    url,
    post(
      {},
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: {name: 'reader-gate-check', version: '1'},
      }),
    ),
  )
  if (result(initialize) === null) throw new CheckFailure('mcp-handshake-failed')
  const session = initialize.headers.get('mcp-session-id')
  const headers: Record<string, string> = session === null ? {} : {'mcp-session-id': session}

  const initialized = await send(deps, url, post(headers, notification('notifications/initialized')))
  if (initialized.status < 200 || initialized.status >= 300) throw new CheckFailure('mcp-handshake-failed')

  const list = result(await send(deps, url, post(headers, rpc('tools/list'))))
  if (list === null || !Array.isArray(list.tools)) throw new CheckFailure('tools-list-failed')
  const tools = list.tools.filter(isTool)
  if (tools.length !== list.tools.length) throw new CheckFailure('tools-list-failed')
  if (tools.length === 0) throw new CheckFailure('tools-empty')
  if (!tools.every(isReadOnly)) throw new CheckFailure('write-tool-present')

  const tool = tools.find(candidate => candidate.name === PREFERRED_READ_TOOL) ?? tools.find(needsNoArguments)
  if (tool === undefined) throw new CheckFailure('read-tool-missing')

  const call = result(await send(deps, url, post(headers, rpc('tools/call', {name: tool.name, arguments: {}}))))
  if (call === null || call.isError === true) throw new CheckFailure('read-call-failed')
}

// ─── Entrypoint ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  const line = await runCheck(await Bun.stdin.text(), {
    fetch: (url, init) => fetch(url, init),
    readText: readTextFile,
    env: process.env,
  })
  process.stdout.write(`${line}\n`)
  process.exit(0)
}
