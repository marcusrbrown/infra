import {createHash} from 'node:crypto'
import {chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, spyOn} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {controlPaths, installHostShims, recordingSpawn, type Reply, type SpawnCall} from './__fixtures__/remote-fixture'
import {
  READER_GRAFANA_PLACEHOLDER,
  READER_LANGFUSE_PLACEHOLDER,
  TRACES_APP_DIR,
  TRACES_GRAFANA_MCP_TOKEN_FILE,
  TRACES_READER_LANGFUSE_FILE,
} from './host'
import {
  GRAFANA_ACCOUNT_NAME,
  GRAFANA_REMOTE_DEADLINE_MS,
  parseCheck,
  PREVIOUS_PENDING_SENTINEL,
  READER_BACKEND_REMOTE,
  SWITCH_INCOMPLETE_SENTINEL,
  tracesReaderBackendGrafanaAction,
  tracesReaderBackendLangfuseAction,
  tracesReaderBackendStatusAction,
  type BackendDeps,
} from './reader-backend'
import {REMOTE_DEADLINE_MS} from './remote'

const ENV_KEYS = ['TRACES_HOST', 'TRACES_DOMAIN', 'TRACES_SSH_KEY'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  delete process.env.TRACES_SSH_KEY
  process.env.TRACES_HOST = 'host.example.invalid'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

let sandbox = ''
let shimDir = ''

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'traces-backend-'))
  shimDir = installHostShims(join(sandbox, 'shim'))
})

afterAll(() => {
  rmSync(sandbox, {recursive: true, force: true})
})

function execOnHost(
  dir: string,
  command: string,
  stdin: string | undefined,
  env: Record<string, string> = {},
  path = shimDir,
): {exitCode: number; stdout: string; stderr: string} {
  const result = Bun.spawnSync(['sh', '-c', command.replaceAll(TRACES_APP_DIR, dir)], {
    stdin: new TextEncoder().encode(stdin ?? ''),
    env: {PATH: `${path}:${process.env.PATH ?? ''}`, HOME: dir, ...env},
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString()}
}

/** Credential files are 0440 on the host: a test that sets one up replaces it, as the scripts do. */
function setFile(path: string, content: string): void {
  rmSync(path, {force: true})
  writeFileSync(path, content)
  chmodSync(path, 0o440)
}

// ─── The two credentials, as files on a scratch host ──────────────────────────
//
// The file scripts (stage, switch, undo, drop, status) run under a real `sh` against a scratch app directory, so
// atomic replace, modes and the `.previous` rules are proven by their effect on real files. Everything that
// talks to a service is modelled: Langfuse and Grafana from the keys they have issued, and the gate's check
// entrypoint from the files it would read and the model's answer for them.

const PK = 'pk-lf-11111111-aaaa'
const SK = 'sk-lf-22222222-bbbb'
const PAIR = `${PK}:${SK}`
const OLD_PK = 'pk-lf-33333333-cccc'
const OLD_SK = 'sk-lf-44444444-dddd'
const OLD_PAIR = `${OLD_PK}:${OLD_SK}`
const ADMIN_PASSWORD = 'AdminPasswordNotInAnyArgv123'

/** The hex-only line the stage step prints: the sha256 of the staged file, computed on the host. */
const STAGED_SHA_PREFIX = 'TRACES_READER_BACKEND_STAGED_SHA='
const shaOfText = (text: string): string => createHash('sha256').update(text).digest('hex')

const FILES = {
  langfuse: TRACES_READER_LANGFUSE_FILE.replace(TRACES_APP_DIR, ''),
  grafana: TRACES_GRAFANA_MCP_TOKEN_FILE.replace(TRACES_APP_DIR, ''),
}

interface Account {
  id: number
  name: string
  role: string
  isDisabled: boolean
}

type Failure =
  | 'sign-in'
  | 'search'
  | 'create-account'
  | 'create-token'
  | 'create-token-no-key'
  | 'check-staged'
  | 'switch'
  | 'switch-reply-lost'
  | 'undo'
  | 'mcp'
  | 'list'
  | 'read-back'
  | 'check-previous-accepted'
  | 'switch-throws'
  | 'mcp-throws'
  | 'undo-throws'

interface World {
  dir: string
  spawn: ReturnType<typeof recordingSpawn>['spawn']
  calls: SpawnCall[]
  closes: ReturnType<typeof recordingSpawn>['closes']
  langfuseFile: string
  grafanaFile: string
  read: (file: string) => string | undefined
  /** Langfuse pairs that authenticate, with the role they hold. */
  pairs: Map<string, 'viewer' | 'admin'>
  /** Grafana model. */
  accounts: Account[]
  tokens: Map<number, {accountId: number; key: string}>
  failures: Set<Failure>
  /** Token ids whose deletion Grafana refuses. */
  deleteFails: Set<number>
  /** Every Grafana key the model ever issued. */
  issuedKeys: string[]
  /** Requests the Grafana model saw, `METHOD path`. */
  requests: string[]
  /** Overrides what the gate's check prints (for a malformed or doubled answer). */
  checkReply: string | undefined
  checks: unknown[]
  /** Runs after the gate's Langfuse check has answered, before the next call: another run's move. */
  afterCheck: (() => void) | undefined
  /**
   * Replaces the hash line the stage step prints with this value (an empty string drops the line): the host reporting
   * something else than the staged file's hash.
   */
  stagedShaReply: string | undefined
  /** Runs before the live Grafana token is verified for cleanup: another run's switch. */
  beforeVerifyLive: (() => void) | undefined
  /** A previous token's key is valid iff it is in the model. */
  grafanaServes: () => boolean
  seedAccount: (name?: string, role?: string) => Account
  seedToken: (accountId: number, live: boolean) => {id: number; key: string}
}

let worldCounter = 0
let keyCounter = 0

function createWorld(): World {
  worldCounter += 1
  const dir = join(sandbox, `app-${worldCounter}`)
  const langfuseFile = join(dir, FILES.langfuse)
  const grafanaFile = join(dir, FILES.grafana)
  mkdirSync(join(langfuseFile, '..'), {recursive: true})
  mkdirSync(join(grafanaFile, '..'), {recursive: true})
  writeFileSync(langfuseFile, READER_LANGFUSE_PLACEHOLDER)
  writeFileSync(grafanaFile, READER_GRAFANA_PLACEHOLDER)
  chmodSync(langfuseFile, 0o440)
  chmodSync(grafanaFile, 0o440)

  const read = (file: string): string | undefined => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return undefined
    }
  }
  const pairs = new Map<string, 'viewer' | 'admin'>()
  const accounts: Account[] = []
  const tokens = new Map<number, {accountId: number; key: string}>()
  const failures = new Set<Failure>()
  const deleteFails = new Set<number>()
  const issuedKeys: string[] = []
  const requests: string[] = []
  const checks: unknown[] = []
  let nextAccount = 1
  let nextToken = 1
  let listCount = 0

  const newKey = (): string => {
    keyCounter += 1
    const key = `glsa_issuedkey${keyCounter}xxxxxxxxxxxx`
    issuedKeys.push(key)
    return key
  }
  const validKey = (key: string | undefined): boolean =>
    key !== undefined && [...tokens.values()].some(token => token.key === key)

  const world: World = {
    dir,
    spawn: undefined as never,
    calls: [],
    closes: [],
    langfuseFile,
    grafanaFile,
    read,
    pairs,
    accounts,
    tokens,
    failures,
    deleteFails,
    issuedKeys,
    requests,
    checkReply: undefined,
    checks,
    afterCheck: undefined,
    stagedShaReply: undefined,
    beforeVerifyLive: undefined,
    grafanaServes: () => validKey(read(grafanaFile)),
    seedAccount: (name = GRAFANA_ACCOUNT_NAME, role = 'Viewer') => {
      const account = {id: nextAccount, name, role, isDisabled: false}
      nextAccount += 1
      accounts.push(account)
      return account
    },
    seedToken: (accountId, live) => {
      const key = newKey()
      const id = nextToken
      nextToken += 1
      tokens.set(id, {accountId, key})
      if (live) setFile(grafanaFile, key)
      return {id, key}
    },
  }

  // ─── The gate's check entrypoint ────────────────────────────────────────────
  const gateCheck = (stdin: string): Reply => {
    const input = JSON.parse(stdin) as {kind: string; credentialFile?: string}
    checks.push(input)
    if (world.checkReply !== undefined) return {stdout: world.checkReply}
    const answer = (verdict: string): Reply => ({stdout: `READER_CHECK_${verdict}\n`})
    if (input.kind === 'grafana-mcp') {
      if (failures.has('mcp-throws')) throw new Error('spawn ssh ENOENT')
      const ok = world.grafanaServes() && !failures.has('mcp')
      return answer(ok ? 'OK grafana-mcp' : 'FAIL grafana-mcp read-call-failed')
    }
    const file = (input.credentialFile ?? '').replace('/run/secrets/reader-gate/', `${join(langfuseFile, '..')}/`)
    const pair = read(file)
    if (pair === undefined) return answer(`FAIL ${input.kind} credential-missing`)
    if (pair === READER_LANGFUSE_PLACEHOLDER) return answer(`FAIL ${input.kind} credential-placeholder`)
    const role = pairs.get(pair)
    world.afterCheck?.()
    if (input.kind === 'langfuse-refused')
      return answer(role === undefined ? 'OK langfuse-refused' : 'FAIL langfuse-refused still-accepted')
    if (role === undefined) return answer('FAIL langfuse credential-refused')
    if (role === 'admin') return answer('FAIL langfuse rest-write-not-denied')
    return answer('OK langfuse')
  }

  // ─── Grafana ────────────────────────────────────────────────────────────────
  const api = (stdin: string): Reply => {
    const [method = '', path = '', ...rest] = stdin.split('\n')
    const body =
      rest.join('\n').trim() === '' ? undefined : (JSON.parse(rest.join('\n')) as {name?: string; role?: string})
    requests.push(`${method} ${path}`)
    const respond = (code: number, json: unknown): Reply => ({
      stdout: `TRACES_GRAFANA_HTTP=${code}\nTRACES_GRAFANA_BODY=${json === undefined ? '' : JSON.stringify(json)}\nTRACES_GRAFANA_API_DONE\n`,
    })
    if (method === 'GET' && path === '/api/user') return respond(failures.has('sign-in') ? 401 : 200, {login: 'admin'})
    if (method === 'GET' && path.startsWith('/api/serviceaccounts/search')) {
      if (failures.has('search')) return respond(500, {message: 'boom'})
      // Grafana's query is a substring match: the CLI must still compare names exactly.
      return respond(200, {serviceAccounts: accounts.filter(account => account.name.includes(GRAFANA_ACCOUNT_NAME))})
    }
    if (method === 'POST' && path === '/api/serviceaccounts') {
      if (failures.has('create-account')) return respond(500, {message: 'boom'})
      const account = world.seedAccount(body?.name, body?.role)
      return respond(201, account)
    }
    const tokensMatch = /^\/api\/serviceaccounts\/(\d+)\/tokens$/.exec(path)
    if (method === 'GET' && tokensMatch !== null) {
      listCount += 1
      if (failures.has('list') || (failures.has('read-back') && listCount >= 2)) return respond(500, {message: 'boom'})
      const accountId = Number(tokensMatch[1])
      return respond(
        200,
        [...tokens.entries()].filter(([, token]) => token.accountId === accountId).map(([id]) => ({id})),
      )
    }
    const deleteMatch = /^\/api\/serviceaccounts\/(\d+)\/tokens\/(\d+)$/.exec(path)
    if (method === 'DELETE' && deleteMatch !== null) {
      const id = Number(deleteMatch[2])
      if (deleteFails.has(id)) return respond(500, {message: 'boom'})
      if (!tokens.delete(id)) return respond(404, {message: 'not found'})
      return respond(200, {message: 'API key deleted'})
    }
    throw new Error(`the CLI made an unmodelled Grafana request: ${method} ${path}`)
  }

  const createToken = (raw: string): Reply => {
    const [id = '', name = ''] = raw.split('\n')
    requests.push(`POST /api/serviceaccounts/${id}/tokens (${name})`)
    if (failures.has('create-token')) return {stdout: 'TRACES_GRAFANA_HTTP=500\nTRACES_GRAFANA_CREATE_TOKEN_DONE\n'}
    const accountId = Number(id)
    const tokenId = [...tokens.keys(), 0].reduce((max, next) => Math.max(max, next)) + 1
    const key = newKey()
    tokens.set(tokenId, {accountId, key})
    if (failures.has('create-token-no-key')) {
      return {stdout: `TRACES_GRAFANA_HTTP=200\nTRACES_GRAFANA_TOKEN_ID=${tokenId}\nTRACES_GRAFANA_CREATE_TOKEN_DONE\n`}
    }
    setFile(`${grafanaFile}.staged`, key)
    const sha = createHash('sha256').update(key).digest('hex')
    return {
      stdout: `TRACES_GRAFANA_HTTP=200\nTRACES_GRAFANA_TOKEN_ID=${tokenId}\nTRACES_GRAFANA_STAGED=1\nTRACES_GRAFANA_KEY_SHA=${sha}\nTRACES_GRAFANA_CREATE_TOKEN_DONE\n`,
    }
  }

  const checkToken = (stdin: string): Reply => {
    const which = stdin.trim()
    const file =
      which === 'staged' ? `${grafanaFile}.staged` : which === 'previous' ? `${grafanaFile}.previous` : grafanaFile
    requests.push(`check ${which}`)
    if (which === 'staged' && failures.has('check-staged'))
      return {stdout: 'TRACES_GRAFANA_HTTP=500\nTRACES_GRAFANA_TOKEN_CHECK_DONE\n'}
    const accepted = validKey(read(file)) || (which === 'previous' && failures.has('check-previous-accepted'))
    return {stdout: `TRACES_GRAFANA_HTTP=${accepted ? 200 : 401}\nTRACES_GRAFANA_TOKEN_CHECK_DONE\n`}
  }

  const route = (call: SpawnCall): Reply => {
    switch (call.command) {
      case READER_BACKEND_REMOTE.gateCheck:
        return gateCheck(call.stdin ?? '')
      case READER_BACKEND_REMOTE.grafanaApi:
        return api(call.stdin ?? '')
      case READER_BACKEND_REMOTE.createGrafanaToken:
        return createToken(call.stdin ?? '')
      case READER_BACKEND_REMOTE.checkGrafanaToken:
        return checkToken(call.stdin ?? '')
      case READER_BACKEND_REMOTE.switchGrafana: {
        if (failures.has('switch-throws')) throw new Error('spawn ssh ENOENT')
        if (failures.has('switch')) return {exitCode: 1, stderr: 'switch failed on the host'}
        const result = execOnHost(dir, call.command, call.stdin)
        return failures.has('switch-reply-lost') ? {exitCode: 255, stderr: 'ssh: connection reset by peer'} : result
      }
      case READER_BACKEND_REMOTE.stageLangfuse: {
        const result = execOnHost(dir, call.command, call.stdin)
        if (world.stagedShaReply === undefined) return result
        const line = world.stagedShaReply === '' ? '' : `${STAGED_SHA_PREFIX}${world.stagedShaReply}\n`
        return {...result, stdout: result.stdout.replace(/^TRACES_READER_BACKEND_STAGED_SHA=.*\n/m, line)}
      }
      case READER_BACKEND_REMOTE.verifyGrafanaLive:
        world.beforeVerifyLive?.()
        return execOnHost(dir, call.command, call.stdin)
      case READER_BACKEND_REMOTE.undoGrafanaSwitch:
        if (failures.has('undo-throws')) throw new Error('spawn ssh ENOENT')
        return failures.has('undo')
          ? {exitCode: 1, stderr: 'undo failed on the host'}
          : execOnHost(dir, call.command, call.stdin)
      default:
        return execOnHost(dir, call.command, call.stdin)
    }
  }

  const recording = recordingSpawn(route)
  world.spawn = recording.spawn
  world.calls = recording.calls
  world.closes = recording.closes
  return world
}

// ─── Running an action, and the rule that no credential leaks ─────────────────

interface Outcome {
  stdout: string
  stderr: string
  exit: number | null
}

interface RunOptions {
  /** Values no argv, environment, standard output or standard error may contain. */
  secrets?: string[]
  /** Values that may be the stdin of exactly the named remote commands, and nowhere else. */
  stdinOnly?: {values: string[]; commands: string[]}
}

async function run(
  world: World,
  action: (ctx: ReturnType<typeof createCapturedCtx>['ctx']) => Promise<void>,
  options: RunOptions = {},
): Promise<Outcome> {
  const {ctx, captured} = createCapturedCtx()
  try {
    await action(ctx)
  } catch (error) {
    if (!(error instanceof MockProcessExit)) throw error
  }
  const stdout = captured.stdout.join('\n')
  const stderr = captured.stderr.join('\n')

  const secrets = [
    ...(options.secrets ?? []),
    ADMIN_PASSWORD,
    ...world.issuedKeys,
    ...(options.stdinOnly?.values ?? []),
  ]
  for (const secret of secrets) {
    for (const call of [...world.calls, ...world.closes]) expect(call.argv.join('\u0000')).not.toContain(secret)
    for (const call of world.calls) expect(JSON.stringify(call.options.env)).not.toContain(secret)
    expect(stdout).not.toContain(secret)
    expect(stderr).not.toContain(secret)
  }
  // A Grafana key never crosses ssh in any direction: it is written on the host and read on the host.
  for (const key of world.issuedKeys) {
    for (const call of world.calls) expect(call.stdin ?? '').not.toContain(key)
  }
  // A Langfuse pair crosses ssh once, on stdin, to the command that stages it.
  for (const value of options.stdinOnly?.values ?? []) {
    for (const call of world.calls) {
      if (!(call.stdin ?? '').includes(value)) continue
      expect(options.stdinOnly?.commands).toContain(call.command)
    }
  }
  return {stdout, stderr, exit: captured.exit?.code ?? null}
}

function makeDeps(world: World, extra: Partial<BackendDeps> = {}): BackendDeps {
  return {spawn: world.spawn, now: () => new Date('2026-11-20T12:00:00.000Z'), ...extra}
}

const promptWith =
  (...answers: (string | undefined)[]) =>
  async (): Promise<string | undefined> =>
    answers.shift()

const installLangfuse = (
  world: World,
  answers: (string | undefined)[] = [PK, SK],
  options: {confirmOldRevoked?: boolean} = {},
) =>
  run(
    world,
    ctx => tracesReaderBackendLangfuseAction(options, ctx, makeDeps(world, {prompt: promptWith(...answers)})),
    {
      secrets: [PK, SK, PAIR, OLD_PK, OLD_SK, OLD_PAIR],
      stdinOnly: {values: [PK, SK, PAIR, OLD_PAIR], commands: [READER_BACKEND_REMOTE.stageLangfuse]},
    },
  )

const installGrafana = (world: World, deps: Partial<BackendDeps> = {}) =>
  run(world, ctx => tracesReaderBackendGrafanaAction({}, ctx, makeDeps(world, deps)))

const stray = (world: World): string[] =>
  readdirSync(join(world.langfuseFile, '..')).filter(
    name => name !== 'langfuse-basic' && !name.startsWith('langfuse-basic.'),
  )

const sessionOf = (world: World): number => controlPaths(world.calls).length

// ─── The gate's check answer ──────────────────────────────────────────────────

describe('parseCheck', () => {
  const result = (stdout: string, exitCode = 0) => ({exitCode, stdout, stderr: ''})

  it('accepts exactly one sentinel line for the kind that was asked', () => {
    expect(parseCheck(result('READER_CHECK_OK langfuse\n'), 'langfuse')).toEqual({ok: true})
    expect(parseCheck(result('READER_CHECK_OK grafana-mcp\n'), 'grafana-mcp')).toEqual({ok: true})
    expect(parseCheck(result('noise\nREADER_CHECK_OK langfuse-refused\n'), 'langfuse-refused')).toEqual({ok: true})
  })

  it('reads the reason of a failure, and not the exit code', () => {
    expect(parseCheck(result('READER_CHECK_FAIL langfuse rest-write-not-denied\n'), 'langfuse')).toEqual({
      ok: false,
      reason: 'rest-write-not-denied',
    })
    // The check exits 0 whatever the verdict; the line is the verdict.
    expect(parseCheck(result('READER_CHECK_OK langfuse\n', 1), 'langfuse')).toEqual({ok: true})
  })

  it.each([
    ['no line', ''],
    ['two lines', 'READER_CHECK_OK langfuse\nREADER_CHECK_OK langfuse\n'],
    ['an OK and a FAIL', 'READER_CHECK_OK langfuse\nREADER_CHECK_FAIL langfuse read-failed\n'],
    ['another kind', 'READER_CHECK_OK grafana-mcp\n'],
    ['an OK with a reason', 'READER_CHECK_OK langfuse extra\n'],
    ['a malformed line', 'READER_CHECK_MAYBE langfuse\n'],
    ['an upper-case reason', 'READER_CHECK_FAIL langfuse BAD_REASON\n'],
  ])('%s is a failure', (_name, stdout) => {
    expect(parseCheck(result(stdout), 'langfuse').ok).toBe(false)
  })
})

// ─── backend langfuse ─────────────────────────────────────────────────────────

describe('traces reader backend langfuse', () => {
  it('stages the pair, passes the private check, switches it in, and has nothing to keep on a fresh host', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')

    const outcome = await installLangfuse(world)

    expect(outcome.exit).toBeNull()
    expect(world.read(world.langfuseFile)).toBe(PAIR)
    expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
    expect(stray(world)).toEqual([])
    expect(world.checks).toEqual([{kind: 'langfuse', credentialFile: '/run/secrets/reader-gate/langfuse-basic.staged'}])
    expect(statSync(world.langfuseFile).mode & 0o777).toBe(0o440)
    expect(outcome.stdout).toContain('Langfuse refuses both a REST write and an MCP write by role')
    expect(outcome.stdout).toContain('There was no previous pair to revoke')
    // The check ran before the switch, and no reader token took part.
    const commands = world.calls.map(call => call.command)
    expect(commands.indexOf(READER_BACKEND_REMOTE.gateCheck)).toBeLessThan(
      commands.indexOf(READER_BACKEND_REMOTE.switchLangfuse),
    )
    expect(sessionOf(world)).toBe(1)
    expect(world.closes).toHaveLength(1)
  })

  it('on a rotation keeps the old pair as .previous, and says what is left to do', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, OLD_PAIR)
    world.pairs.set(OLD_PAIR, 'viewer')
    world.pairs.set(PAIR, 'viewer')

    const outcome = await installLangfuse(world)

    expect(outcome.exit).toBeNull()
    expect(world.read(world.langfuseFile)).toBe(PAIR)
    expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
    expect(outcome.stdout).toContain('--confirm-old-revoked')
  })

  it('when the private check fails, nothing is switched, the staged file is removed and the reason is named', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, OLD_PAIR)
    world.pairs.set(OLD_PAIR, 'viewer')
    world.pairs.set(PAIR, 'admin')

    const outcome = await installLangfuse(world)

    expect(outcome.exit).toBe(1)
    expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
    expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
    expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
    expect(outcome.stderr).toContain('rest-write-not-denied')
    expect(outcome.stderr).toContain('live pair is unchanged')
    expect(world.calls.some(call => call.command === READER_BACKEND_REMOTE.switchLangfuse)).toBe(false)
  })

  it('a pair Langfuse refuses is not switched in', async () => {
    const world = createWorld()
    const outcome = await installLangfuse(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('credential-refused')
    expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
  })

  it.each([
    ['no answer', ''],
    ['two answers', 'READER_CHECK_OK langfuse\nREADER_CHECK_OK langfuse\n'],
    ['the wrong kind', 'READER_CHECK_OK grafana-mcp\n'],
  ])('a check that gives %s is a failure, and nothing is switched', async (_name, reply) => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    world.checkReply = reply
    const outcome = await installLangfuse(world)
    expect(outcome.exit).toBe(1)
    expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
    expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
  })

  it('refuses a second rotation while the previous pair has not been confirmed revoked', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, PAIR)
    setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
    world.pairs.set(PAIR, 'viewer')
    world.pairs.set(OLD_PAIR, 'viewer')

    const outcome = await installLangfuse(world, [OLD_PK, OLD_SK])

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('still waiting to be confirmed revoked')
    expect(world.read(world.langfuseFile)).toBe(PAIR)
    expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
    expect(world.checks).toEqual([])
    expect(stray(world)).toEqual([])
  })

  it('--confirm-old-revoked keeps .previous while Langfuse still accepts it', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, PAIR)
    setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
    world.pairs.set(OLD_PAIR, 'viewer')

    const outcome = await installLangfuse(world, [], {confirmOldRevoked: true})

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('still accepts the previous pair')
    expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
    expect(world.checks).toEqual([
      {kind: 'langfuse-refused', credentialFile: '/run/secrets/reader-gate/langfuse-basic.previous'},
    ])
  })

  it('--confirm-old-revoked deletes .previous only after Langfuse refuses the old pair, and prompts for nothing', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, PAIR)
    setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
    world.pairs.set(PAIR, 'viewer')
    let prompts = 0

    const outcome = await run(
      world,
      ctx =>
        tracesReaderBackendLangfuseAction(
          {confirmOldRevoked: true},
          ctx,
          makeDeps(world, {
            prompt: async () => {
              prompts += 1
              return undefined
            },
          }),
        ),
      {secrets: [PAIR, OLD_PAIR]},
    )

    expect(outcome.exit).toBeNull()
    expect(prompts).toBe(0)
    expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
    expect(world.read(world.langfuseFile)).toBe(PAIR)
    const commands = world.calls.map(call => call.command)
    expect(commands.indexOf(READER_BACKEND_REMOTE.gateCheck)).toBeLessThan(
      commands.indexOf(READER_BACKEND_REMOTE.dropPrevious('langfuse')),
    )
  })

  it('--confirm-old-revoked with no previous pair says so and changes nothing', async () => {
    const world = createWorld()
    const outcome = await installLangfuse(world, [], {confirmOldRevoked: true})
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('no previous Langfuse pair')
    expect(world.calls.some(call => call.command === READER_BACKEND_REMOTE.dropPrevious('langfuse'))).toBe(false)
  })

  it('a cancelled or unavailable prompt costs no ssh connection and changes nothing', async () => {
    for (const answers of [[undefined], [PK, undefined]]) {
      const world = createWorld()
      const outcome = await installLangfuse(world, answers)
      expect(outcome.exit).toBe(1)
      expect(outcome.stderr).toContain('No key pair was entered')
      expect(world.calls).toHaveLength(0)
    }
  })

  it('a paste that is not a key pair is refused before any connection, and is not echoed', async () => {
    for (const answers of [
      ['pk-lf-short', SK],
      [PK, 'not-a-secret-key-0000'],
      [SK, PK],
      [`${PK}:${SK}`, SK],
    ]) {
      const world = createWorld()
      const outcome = await installLangfuse(world, answers)
      expect(outcome.exit).toBe(1)
      expect(outcome.stderr).toContain('not a Langfuse key pair')
      expect(world.calls).toHaveLength(0)
      expect(outcome.stderr).not.toContain('not-a-secret-key-0000')
    }
  })

  it('the pair is on stdin of the staging command only: not in argv, environment or any output', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    await installLangfuse(world)
    const carrying = world.calls.filter(call => (call.stdin ?? '').includes(PAIR))
    expect(carrying.map(call => call.command)).toEqual([READER_BACKEND_REMOTE.stageLangfuse])
    expect(carrying[0]?.stdin).toBe(`${PAIR}\n`)
  })
})

// ─── Deadlines ────────────────────────────────────────────────────────────────

describe('every backend remote call has a deadline', () => {
  const deadlines = async (action: () => Promise<unknown>): Promise<number[]> => {
    const spy = spyOn(AbortSignal, 'timeout')
    try {
      await action()
      return spy.mock.calls.map(call => Number(call[0]))
    } finally {
      spy.mockRestore()
    }
  }

  it('gives every ssh call of a Langfuse run the standard deadline, and the Grafana flow the longer one', async () => {
    const langfuse = createWorld()
    langfuse.pairs.set(PAIR, 'viewer')
    const short = await deadlines(() => installLangfuse(langfuse))
    const ssh = langfuse.calls.filter(call => call.argv[0] === 'ssh')
    for (const call of ssh) expect(call.options.signal).toBeInstanceOf(AbortSignal)
    // One signal per call, and a close of the shared connection has its own short one.
    expect(short.filter(ms => ms === REMOTE_DEADLINE_MS)).toHaveLength(ssh.length)

    const grafana = createWorld()
    const long = await deadlines(() => installGrafana(grafana))
    const grafanaSsh = grafana.calls.filter(call => call.argv[0] === 'ssh')
    for (const call of grafanaSsh) expect(call.options.signal).toBeInstanceOf(AbortSignal)
    expect(long.filter(ms => ms === GRAFANA_REMOTE_DEADLINE_MS)).toHaveLength(grafanaSsh.length)
    expect(GRAFANA_REMOTE_DEADLINE_MS).toBeGreaterThan(REMOTE_DEADLINE_MS)
  })

  it('the status command has one too', async () => {
    const world = createWorld()
    const seen = await deadlines(() =>
      run(world, ctx => tracesReaderBackendStatusAction({}, ctx, makeDeps(world)), {secrets: []}),
    )
    expect(seen.filter(ms => ms === REMOTE_DEADLINE_MS)).toHaveLength(1)
  })

  it('a host that never answers fails the run at the deadline, and changes nothing', async () => {
    const hang: BackendDeps['spawn'] = (argv, options) => ({
      stdout: new Response('').body,
      stderr: new Response('').body,
      exited: argv.includes('-O')
        ? Promise.resolve(0)
        : new Promise<number>(resolve => {
            options.signal?.addEventListener('abort', () => resolve(143))
          }),
    })
    const world = createWorld()
    const {ctx, captured} = createCapturedCtx()
    try {
      await tracesReaderBackendGrafanaAction({}, ctx, makeDeps(world, {spawn: hang, deadlineMs: 25}))
    } catch (error) {
      if (!(error instanceof MockProcessExit)) throw error
    }
    expect(captured.exit?.code).toBe(1)
    expect(captured.stderr.join('\n')).toContain('Step sign-in failed')
    expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
  })
})

// ─── The pair on stdin, for a run without a terminal ──────────────────────────────────────

describe('traces reader backend langfuse: the pair on stdin', () => {
  const fromStdin = (world: World, text: string, extra: Partial<BackendDeps> = {}) =>
    run(
      world,
      ctx =>
        tracesReaderBackendLangfuseAction(
          {},
          ctx,
          makeDeps(world, {isTty: false, readStdin: async () => text, ...extra}),
        ),
      {
        secrets: [PK, SK, PAIR, OLD_PAIR],
        stdinOnly: {values: [PK, SK, PAIR], commands: [READER_BACKEND_REMOTE.stageLangfuse]},
      },
    )

  it('reads one line, <public>:<secret>, when stdin is not a terminal, and installs it like the prompt does', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    const outcome = await fromStdin(world, `${PAIR}\n`)
    expect(outcome.exit).toBeNull()
    expect(world.read(world.langfuseFile)).toBe(PAIR)
    expect(world.checks).toEqual([{kind: 'langfuse', credentialFile: '/run/secrets/reader-gate/langfuse-basic.staged'}])
  })

  it('puts the pair on the stdin of the staging command only: not in argv, environment or any output', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    await fromStdin(world, `${PAIR}\n`)
    const carrying = world.calls.filter(call => (call.stdin ?? '').includes(PAIR))
    expect(carrying.map(call => call.command)).toEqual([READER_BACKEND_REMOTE.stageLangfuse])
    for (const call of [...world.calls, ...world.closes]) {
      expect(call.argv.join('\u0000')).not.toContain(PK)
      expect(call.argv.join('\u0000')).not.toContain(SK)
    }
    for (const call of world.calls) expect(JSON.stringify(call.options.env)).not.toContain(SK)
  })

  it('accepts a missing final newline and a CRLF', async () => {
    for (const text of [PAIR, `${PAIR}\r\n`]) {
      const world = createWorld()
      world.pairs.set(PAIR, 'viewer')
      expect((await fromStdin(world, text)).exit).toBeNull()
      expect(world.read(world.langfuseFile)).toBe(PAIR)
    }
  })

  it('does not ask for anything, and does not read stdin when a prompt or a terminal is there', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    let reads = 0
    const outcome = await run(
      world,
      ctx =>
        tracesReaderBackendLangfuseAction(
          {},
          ctx,
          makeDeps(world, {
            isTty: true,
            prompt: promptWith(PK, SK),
            readStdin: async () => {
              reads += 1
              return `${OLD_PAIR}\n`
            },
          }),
        ),
      {secrets: [PK, SK, PAIR, OLD_PAIR]},
    )
    expect(outcome.exit).toBeNull()
    expect(reads).toBe(0)
    expect(world.read(world.langfuseFile)).toBe(PAIR)
  })

  it.each([
    ['nothing', ''],
    ['only a newline', '\n'],
    ['one key', `${PK}\n`],
    ['the keys the wrong way round', `${SK}:${PK}\n`],
    ['three parts', `${PK}:${SK}:extra\n`],
    ['two lines', `${PAIR}\n${PAIR}\n`],
    ['a short secret', `${PK}:sk-lf-short\n`],
    ['a space inside', `${PK}: ${SK}\n`],
  ])('%s is refused before any connection, and is not echoed', async (_name, text) => {
    const world = createWorld()
    const outcome = await fromStdin(world, text)
    expect(outcome.exit).toBe(1)
    expect(world.calls).toHaveLength(0)
    expect(outcome.stderr).toContain('Nothing was changed')
    expect(outcome.stderr).not.toContain(PK)
    expect(outcome.stderr).not.toContain(SK)
  })

  it('--confirm-old-revoked reads neither a prompt nor stdin', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, PAIR)
    setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
    world.pairs.set(PAIR, 'viewer')
    let reads = 0
    const outcome = await run(
      world,
      ctx =>
        tracesReaderBackendLangfuseAction(
          {confirmOldRevoked: true},
          ctx,
          makeDeps(world, {
            isTty: false,
            readStdin: async () => {
              reads += 1
              return ''
            },
          }),
        ),
      {secrets: [PAIR, OLD_PAIR]},
    )
    expect(outcome.exit).toBeNull()
    expect(reads).toBe(0)
  })
})

// ─── What guards a run from its own interruption ─────────────────────────────
//
// There is no lock: one `traces reader` command at a time is a rule, not a mechanism. What stays is a hash check of
// the staged Langfuse file before the switch, and a hash check of the live Grafana file before cleanup.

describe('the hash checks that remain', () => {
  it('refuses to switch a staged pair that is not the one it checked, and leaves the live pair alone', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, OLD_PAIR)
    world.pairs.set(PAIR, 'viewer')
    world.pairs.set(OLD_PAIR, 'viewer')
    // The staged file is swapped after the check has passed.
    world.afterCheck = () => setFile(`${world.langfuseFile}.staged`, 'pk-lf-99999999-zzzz:sk-lf-99999999-zzzz')

    const outcome = await installLangfuse(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('changed after the check')
    expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
    expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
    expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
  })

  it('hashes the staged file on the host: the CLI sends the hash the host reported, and computes none of its own', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    // The host reports a hash that is not the staged file's: the CLI passes it on as it is, and the switch refuses it.
    world.stagedShaReply = 'a'.repeat(64)
    const outcome = await installLangfuse(world)
    const sw = world.calls.find(call => call.command === READER_BACKEND_REMOTE.switchLangfuse)
    expect(sw?.stdin).toBe(`${'a'.repeat(64)}\n`)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('changed after the check')
    expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
    expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
  })

  it.each([
    ['no hash line', ''],
    ['a hash that is not 64 hex characters', 'abc123'],
    ['an upper-case hash', 'A'.repeat(64)],
  ])('stops, removes the staged file and switches nothing when the host reports %s', async (_name, reply) => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    world.stagedShaReply = reply
    const outcome = await installLangfuse(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('did not report a hash of the staged pair')
    expect(world.calls.some(call => call.command === READER_BACKEND_REMOTE.switchLangfuse)).toBe(false)
    expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
    expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
  })

  it('does not hash the credential pair in the CLI (CodeQL js/insufficient-password-hash)', () => {
    const source = readFileSync(new URL('reader-backend.ts', import.meta.url), 'utf8')
    expect(source).not.toContain('node:crypto')
    expect(source).not.toContain('createHash')
  })

  it('sends the hash of the staged pair, never the pair, to the switch', async () => {
    const world = createWorld()
    world.pairs.set(PAIR, 'viewer')
    await installLangfuse(world)
    const sw = world.calls.find(call => call.command === READER_BACKEND_REMOTE.switchLangfuse)
    expect(sw?.stdin).toContain(createHash('sha256').update(PAIR).digest('hex'))
    expect(sw?.stdin).not.toContain(PAIR)
  })

  describe('backend grafana', () => {
    it('does not delete a token when the live file no longer holds the one it made', async () => {
      const world = createWorld()
      const account = world.seedAccount()
      const live = world.seedToken(account.id, true)
      // Another run switches its own token in after this run's switch.
      world.beforeVerifyLive = () => {
        const other = world.seedToken(account.id, false)
        setFile(world.grafanaFile, other.key)
      }

      const outcome = await installGrafana(world)

      expect(outcome.exit).toBe(1)
      expect(outcome.stderr).toContain('no longer holds token')
      expect(world.requests.some(request => request.startsWith('DELETE'))).toBe(false)
      expect(world.tokens.has(live.id)).toBe(true)
      expect(world.grafanaServes()).toBe(true)
    })

    it('verifies the live file by hash, and prints no token value', async () => {
      const world = createWorld()
      const outcome = await installGrafana(world)
      expect(outcome.exit).toBeNull()
      const verify = world.calls.find(call => call.command === READER_BACKEND_REMOTE.verifyGrafanaLive)
      const key = world.issuedKeys[0] ?? ''
      expect(verify?.stdin).toContain(createHash('sha256').update(key).digest('hex'))
      expect(verify?.stdin).not.toContain(key)
    })
  })
})

// ─── backend grafana ──────────────────────────────────────────────────────────

describe('traces reader backend grafana', () => {
  const mutating = (world: World): string[] =>
    world.requests.filter(request => !request.startsWith('GET') && !request.startsWith('check'))

  it('on a fresh host creates the service account and a token, proves an MCP read, and prints only ids', async () => {
    const world = createWorld()

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBeNull()
    expect(world.accounts).toEqual([{id: 1, name: GRAFANA_ACCOUNT_NAME, role: 'Viewer', isDisabled: false}])
    expect([...world.tokens.keys()]).toEqual([1])
    expect(world.read(world.grafanaFile)).toBe(world.issuedKeys[0])
    expect(world.grafanaServes()).toBe(true)
    // The placeholder that was live is not left behind as a pending previous token.
    expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
    expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
    expect(world.checks).toEqual([{kind: 'grafana-mcp'}])
    expect(outcome.stdout).toContain('Created service account 1')
    expect(outcome.stdout).toContain('Created token 1 on service account 1')
    expect(outcome.stdout).toContain('holds token 1 only')
    expect(statSync(world.grafanaFile).mode & 0o777).toBe(0o440)
    // One sign-in, and the only things Grafana was asked to create are the account and the token.
    expect(world.requests.filter(request => request === 'GET /api/user')).toHaveLength(1)
    expect(mutating(world)).toEqual([
      'POST /api/serviceaccounts',
      'POST /api/serviceaccounts/1/tokens (agent-reader-20261120120000)',
    ])
    expect(sessionOf(world)).toBe(1)
    expect(world.closes).toHaveLength(1)
  })

  it('the MCP read is the commit point: it comes after the switch, and the token check before it', async () => {
    const world = createWorld()
    await installGrafana(world)
    const order = world.calls
      .map(call => {
        if (call.command === READER_BACKEND_REMOTE.checkGrafanaToken) return `token-check:${call.stdin?.trim()}`
        if (call.command === READER_BACKEND_REMOTE.switchGrafana) return 'switch'
        if (call.command === READER_BACKEND_REMOTE.gateCheck) return 'mcp'
        if (call.command === READER_BACKEND_REMOTE.createGrafanaToken) return 'create'
        return ''
      })
      .filter(Boolean)
    expect(order).toEqual(['create', 'token-check:staged', 'switch', 'mcp', 'token-check:previous'])
  })

  it('on a second run reuses the account by exact name and deletes every other token, snapshot-restored ones included', async () => {
    const world = createWorld()
    // A look-alike account: the search matches substrings, the CLI must not.
    world.seedAccount(`${GRAFANA_ACCOUNT_NAME}-old`)
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const restored = world.seedToken(account.id, false)

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBeNull()
    expect(world.accounts.map(candidate => candidate.name)).toEqual([
      `${GRAFANA_ACCOUNT_NAME}-old`,
      GRAFANA_ACCOUNT_NAME,
    ])
    expect(mutating(world).filter(request => request === 'POST /api/serviceaccounts')).toEqual([])
    const remaining = [...world.tokens.keys()]
    expect(remaining).toHaveLength(1)
    expect(remaining).not.toContain(live.id)
    expect(remaining).not.toContain(restored.id)
    expect(world.read(world.grafanaFile)).toBe(world.tokens.get(remaining[0] ?? 0)?.key)
    // The previous live token was refused by authentication, and then its file was dropped.
    expect(world.requests).toContain('check previous')
    expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
    expect(outcome.stdout).toContain(`Deleted tokens ${live.id}, ${restored.id}`)
  })

  it('refuses an account that is not a Viewer or is disabled, and two accounts of the same name', async () => {
    const editor = createWorld()
    editor.seedAccount(GRAFANA_ACCOUNT_NAME, 'Editor')
    const out1 = await installGrafana(editor)
    expect(out1.exit).toBe(1)
    expect(out1.stderr).toContain('not Viewer')
    expect(editor.tokens.size).toBe(0)

    const twins = createWorld()
    twins.seedAccount()
    twins.seedAccount()
    const out2 = await installGrafana(twins)
    expect(out2.exit).toBe(1)
    expect(out2.stderr).toContain('2 service accounts are named')
    expect(twins.tokens.size).toBe(0)

    const disabled = createWorld()
    disabled.seedAccount().isDisabled = true
    expect((await installGrafana(disabled)).stderr).toContain('disabled')
  })

  it('a failed admin sign-in stops the run after one request and never tries again', async () => {
    const world = createWorld()
    world.failures.add('sign-in')
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(world.requests).toEqual(['GET /api/user'])
    expect(outcome.stderr).toContain('Step sign-in failed')
    expect(outcome.stderr).toContain('not tried again')
    expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
  })

  it.each([
    ['search', 'find-service-account'],
    ['create-account', 'create-service-account'],
  ] as const)('a Grafana error at %s names the step and changes nothing', async (failure, step) => {
    const world = createWorld()
    world.failures.add(failure)
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain(`Step ${step} failed`)
    expect(world.tokens.size).toBe(0)
    expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
  })

  it('a token that cannot be created names the step and leaves the live file alone', async () => {
    const world = createWorld()
    world.failures.add('create-token')
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step create-token failed')
    expect(world.tokens.size).toBe(0)
    expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
  })

  it('a token created but not staged is deleted by id', async () => {
    const world = createWorld()
    world.failures.add('create-token-no-key')
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step create-token failed')
    expect(outcome.stderr).toContain('token 1 exists but was not staged')
    expect(world.tokens.size).toBe(0)
    expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
  })

  it('an error after the token was created and before the switch deletes it by id and leaves the live file unchanged', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const liveKey = world.read(world.grafanaFile)
    world.failures.add('check-staged')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step check-staged-token failed')
    expect(world.read(world.grafanaFile)).toBe(liveKey)
    expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
    expect([...world.tokens.keys()]).toEqual([live.id])
    expect(world.grafanaServes()).toBe(true)
    expect(world.requests).toContain(`DELETE /api/serviceaccounts/${account.id}/tokens/2`)
    expect(world.calls.some(call => call.command === READER_BACKEND_REMOTE.switchGrafana)).toBe(false)
  })

  it('a switch that fails before it changes anything leaves the live file and deletes the new token', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    world.failures.add('switch')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step switch failed')
    expect(outcome.stdout).toContain('never changed')
    expect(world.grafanaServes()).toBe(true)
    expect([...world.tokens.keys()]).toEqual([live.id])
    expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
  })

  it('a switch that landed with its reply lost is undone: the previous token is back and the new one is deleted', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const liveKey = world.read(world.grafanaFile)
    world.failures.add('switch-reply-lost')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(world.read(world.grafanaFile)).toBe(liveKey)
    expect([...world.tokens.keys()]).toEqual([live.id])
    expect(outcome.stdout).toContain('previous token was put back')
  })

  it('a new token that passes the direct check but fails the MCP read after the switch is rolled back, and the previous one still serves', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const liveKey = world.read(world.grafanaFile)
    world.failures.add('mcp')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step check-mcp-read failed')
    expect(outcome.stderr).toContain('read-call-failed')
    expect(world.read(world.grafanaFile)).toBe(liveKey)
    expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
    expect([...world.tokens.keys()]).toEqual([live.id])
    // The previous token is the live one again and is still accepted by Grafana.
    expect(world.grafanaServes()).toBe(true)
    // The direct check passed first, so the MCP read really was the deciding step.
    expect(world.requests).toContain('check staged')
  })

  it('when the previous file cannot be put back, the new token is NOT deleted, because the live file may use it', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    world.seedToken(account.id, true)
    world.failures.add('mcp')
    world.failures.add('undo')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('could not be put back')
    expect(outcome.stderr).toContain('was NOT deleted')
    expect(world.tokens.size).toBe(2)
    expect(world.requests.some(request => request.startsWith('DELETE'))).toBe(false)
  })

  it('a switch call that throws is rolled back like a failed one: the previous token is back, the new one deleted', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const liveKey = world.read(world.grafanaFile)
    world.failures.add('switch-throws')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step switch failed')
    expect(world.read(world.grafanaFile)).toBe(liveKey)
    expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
    expect([...world.tokens.keys()]).toEqual([live.id])
  })

  it('an MCP check that throws after the switch is rolled back: the previous file is restored, then the new token deleted', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const liveKey = world.read(world.grafanaFile)
    world.failures.add('mcp-throws')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Step check-mcp-read failed')
    expect(world.read(world.grafanaFile)).toBe(liveKey)
    expect([...world.tokens.keys()]).toEqual([live.id])
    const order = world.requests.filter(request => request.startsWith('DELETE'))
    expect(order).toEqual([`DELETE /api/serviceaccounts/${account.id}/tokens/2`])
  })

  it('when the rollback cannot reach the host either, it reports the new token id and the previous file, and deletes nothing', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    world.seedToken(account.id, true)
    world.failures.add('mcp-throws')
    world.failures.add('undo-throws')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('token 2')
    expect(outcome.stderr).toContain('.previous')
    expect(outcome.stderr).toContain('run this command again')
    expect(world.requests.some(request => request.startsWith('DELETE'))).toBe(false)
    expect(world.tokens.size).toBe(2)
  })

  it('after the commit, a failed deletion leaves the new token live, lists the ids still to delete, and a rerun converges', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    const stuck = world.seedToken(account.id, false)
    world.deleteFails.add(stuck.id)

    const first = await installGrafana(world)

    expect(first.exit).toBe(1)
    // Never rolled back from here: the live file is the new token and it serves.
    const newId = [...world.tokens.keys()].find(id => id !== live.id && id !== stuck.id)
    expect(world.read(world.grafanaFile)).toBe(world.tokens.get(newId ?? 0)?.key)
    expect(world.grafanaServes()).toBe(true)
    expect(first.stderr).toContain(`Token ids still to delete on service account ${account.id}: ${stuck.id}`)
    expect(first.stderr).toContain('converges')
    expect(world.tokens.has(live.id)).toBe(false)
    expect(world.tokens.has(stuck.id)).toBe(true)
    // The previous file stays while cleanup is unfinished, so status says so.
    expect(world.read(`${world.grafanaFile}.previous`)).toBeDefined()

    world.deleteFails.clear()
    const second = await installGrafana(world)

    expect(second.stderr).toBe('')
    expect(second.exit).toBeNull()
    expect(world.tokens.size).toBe(1)
    expect(world.grafanaServes()).toBe(true)
    expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
  })

  it('when the previous token is still accepted after its deletion, the new one stays live and nothing is dropped', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    world.seedToken(account.id, true)
    world.failures.add('check-previous-accepted')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('still accepts the previous token')
    expect(world.grafanaServes()).toBe(true)
    expect(world.read(`${world.grafanaFile}.previous`)).toBeDefined()
  })

  it('a token list that cannot be read at cleanup leaves the new token live and says to run it again', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    world.failures.add('list')
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('could not list')
    expect(world.grafanaServes()).toBe(true)
    expect(world.tokens.has(live.id)).toBe(true)
    expect(world.read(`${world.grafanaFile}.previous`)).toBeDefined()
  })

  it('a token list that cannot be read back leaves deletions unproven and the previous file kept', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    world.seedToken(account.id, true)
    world.failures.add('read-back')
    const outcome = await installGrafana(world)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('read the token list back')
    expect(world.grafanaServes()).toBe(true)
    expect(world.read(`${world.grafanaFile}.previous`)).toBeDefined()
  })

  it('a rerun after an interrupted run converges to one live token with the file pointing at it', async () => {
    const world = createWorld()
    const account = world.seedAccount()
    const live = world.seedToken(account.id, true)
    // An interrupted run left a created token, a staged file with its key, and nothing else.
    const orphan = world.seedToken(account.id, false)
    setFile(`${world.grafanaFile}.staged`, world.tokens.get(orphan.id)?.key ?? '')

    const outcome = await installGrafana(world)

    expect(outcome.exit).toBeNull()
    expect(world.tokens.size).toBe(1)
    expect(world.tokens.has(live.id)).toBe(false)
    expect(world.tokens.has(orphan.id)).toBe(false)
    expect(world.grafanaServes()).toBe(true)
    expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
    expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
  })
})

// ─── backend status ───────────────────────────────────────────────────────────

describe('traces reader backend status', () => {
  const status = (world: World) =>
    run(world, ctx => tracesReaderBackendStatusAction({}, ctx, makeDeps(world)), {secrets: [PAIR, OLD_PAIR]})

  it('reports a fresh host as placeholders', async () => {
    const world = createWorld()
    const outcome = await status(world)
    expect(outcome.exit).toBeNull()
    expect(outcome.stdout.split('\n')).toEqual([
      'langfuse: placeholder (no credential installed: reads through this route fail)',
      'grafana: placeholder (no credential installed: reads through this route fail)',
    ])
  })

  it('reports installed, pending old revocation, and a left-over staged file, and never a value', async () => {
    const world = createWorld()
    setFile(world.langfuseFile, PAIR)
    setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
    const account = world.seedAccount()
    world.seedToken(account.id, true)
    setFile(`${world.grafanaFile}.staged`, 'glsa_leftoverleftoverleft')

    const outcome = await status(world)

    expect(outcome.exit).toBeNull()
    expect(outcome.stdout).toContain('langfuse: installed; the old credential is not yet confirmed revoked')
    expect(outcome.stdout).toContain('grafana: installed')
    expect(outcome.stdout).toContain('grafana: a staged file is left over')
    expect(outcome.stdout).not.toContain('pk-lf')
    expect(outcome.stdout).not.toContain('glsa_')
  })

  it('fails when the host does not report both credentials', async () => {
    const world = createWorld()
    const spawn = world.spawn
    const outcome = await run(world, ctx =>
      tracesReaderBackendStatusAction({}, ctx, {
        spawn: (argv, options) =>
          argv.at(-1) === READER_BACKEND_REMOTE.status
            ? {stdout: new Response('').body, stderr: null, exited: Promise.resolve(1)}
            : spawn(argv, options),
      }),
    )
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Could not read the credential state')
  })

  describe('--json', () => {
    const statusJson = (world: World) =>
      run(world, ctx => tracesReaderBackendStatusAction({json: true}, ctx, makeDeps(world)), {
        secrets: [PAIR, OLD_PAIR],
      })

    it('prints one JSON object with the state of each credential', async () => {
      const world = createWorld()
      const outcome = await statusJson(world)
      expect(outcome.exit).toBeNull()
      expect(outcome.stdout.split('\n')).toHaveLength(1)
      expect(JSON.parse(outcome.stdout)).toEqual({langfuse: 'placeholder', grafana: 'placeholder'})
    })

    it('names pending old revocation and installed, and never a value or a staged leftover as a state', async () => {
      const world = createWorld()
      setFile(world.langfuseFile, PAIR)
      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      const account = world.seedAccount()
      world.seedToken(account.id, true)
      setFile(`${world.grafanaFile}.staged`, 'glsa_leftoverleftoverleft')
      const outcome = await statusJson(world)
      expect(outcome.exit).toBeNull()
      expect(JSON.parse(outcome.stdout)).toEqual({langfuse: 'pending-old-revocation', grafana: 'installed'})
      expect(outcome.stdout).not.toContain('pk-lf')
      expect(outcome.stdout).not.toContain('glsa_')
    })

    it('reports a missing file as missing', async () => {
      const world = createWorld()
      rmSync(world.langfuseFile)
      expect(JSON.parse((await statusJson(world)).stdout)).toEqual({langfuse: 'missing', grafana: 'placeholder'})
    })

    it('keeps the exit code: a host that does not report both prints no JSON and fails', async () => {
      const world = createWorld()
      const spawn = world.spawn
      const outcome = await run(world, ctx =>
        tracesReaderBackendStatusAction({json: true}, ctx, {
          spawn: (argv, options) =>
            argv.at(-1) === READER_BACKEND_REMOTE.status
              ? {stdout: new Response('').body, stderr: null, exited: Promise.resolve(1)}
              : spawn(argv, options),
        }),
      )
      expect(outcome.exit).toBe(1)
      expect(outcome.stdout).toBe('')
      expect(outcome.stderr).toContain('Could not read the credential state')
    })

    it('without --json the output is the text it was', async () => {
      const world = createWorld()
      const outcome = await run(world, ctx => tracesReaderBackendStatusAction({json: false}, ctx, makeDeps(world)), {
        secrets: [],
      })
      expect(outcome.stdout).toContain('langfuse: placeholder (no credential installed')
    })
  })
})

// ─── The host scripts, run under a real sh ────────────────────────────────────

describe('host scripts, run under a real sh', () => {
  // A `curl` that records what it was given and answers from a file: nothing here reaches a network.
  let curlDir = ''
  beforeAll(() => {
    curlDir = join(sandbox, 'curl-shim')
    mkdirSync(curlDir)
    writeFileSync(
      join(curlDir, 'curl'),
      [
        '#!/bin/sh',
        String.raw`printf "%s\n" "$@" > "$CURL_LOG.argv"`,
        'cat > "$CURL_LOG.stdin"',
        'cat "$CURL_REPLY"',
        String.raw`printf "\nTRACES_HTTP=%s" "$CURL_CODE"`,
        '',
      ].join('\n'),
    )
    chmodSync(join(curlDir, 'curl'), 0o755)
  })

  let counter = 0
  interface Curl {
    log: string
    argv: () => string
    stdin: () => string
    called: () => boolean
    env: Record<string, string>
  }
  function curl(world: World, reply: string, code: number): Curl {
    counter += 1
    const log = join(world.dir, `curl-${counter}`)
    const replyFile = `${log}.reply`
    writeFileSync(replyFile, reply)
    const read = (suffix: string): string => world.read(`${log}.${suffix}`) ?? ''
    return {
      log,
      argv: () => read('argv'),
      stdin: () => read('stdin'),
      called: () => world.read(`${log}.argv`) !== undefined,
      env: {CURL_LOG: log, CURL_REPLY: replyFile, CURL_CODE: String(code)},
    }
  }
  const withCurl = (world: World, command: string, stdin: string, shim: Curl) =>
    execOnHost(world.dir, command, stdin, shim.env, `${curlDir}:${shimDir}`)

  const withPassword = (world: World): void => {
    mkdirSync(join(world.dir, 'secrets', 'grafana'), {recursive: true})
    writeFileSync(join(world.dir, 'secrets', 'grafana', 'admin-password'), ADMIN_PASSWORD)
  }

  describe('grafanaApi', () => {
    it('signs in through a curl config on stdin: the password is in no argv and not in the output', () => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, '{"login":"admin"}', 200)

      const result = withCurl(world, READER_BACKEND_REMOTE.grafanaApi, 'GET\n/api/user\n', shim)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=200')
      expect(result.stdout).toContain('TRACES_GRAFANA_BODY={"login":"admin"}')
      expect(result.stdout).toContain('TRACES_GRAFANA_API_DONE')
      expect(shim.stdin()).toContain(`user = "admin:${ADMIN_PASSWORD}"`)
      expect(shim.argv()).not.toContain(ADMIN_PASSWORD)
      expect(shim.argv().split('\n')).toEqual(
        expect.arrayContaining([
          '-q',
          '-s',
          '--noproxy',
          '*',
          '-K',
          '-',
          '-X',
          'GET',
          'http://127.0.0.1:3001/api/user',
        ]),
      )
      expect(result.stdout + result.stderr).not.toContain(ADMIN_PASSWORD)
    })

    it('puts a JSON body into the curl config, quote-escaped, never into argv', () => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, '{"id":3}', 201)
      const body = JSON.stringify({name: 'agent-reader', role: 'Viewer', isDisabled: false})

      const result = withCurl(world, READER_BACKEND_REMOTE.grafanaApi, `POST\n/api/serviceaccounts\n${body}`, shim)

      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=201')
      expect(shim.stdin()).toContain(
        String.raw`data = "{\"name\":\"agent-reader\",\"role\":\"Viewer\",\"isDisabled\":false}"`,
      )
      expect(shim.argv()).not.toContain('agent-reader')
    })

    it.each([
      ['POST', '/api/serviceaccounts/1/tokens'],
      ['DELETE', '/api/serviceaccounts/1'],
      ['GET', '/api/serviceaccounts/1/tokens/2'],
      ['GET', '/api/user?x=1'],
      ['GET', '/api/serviceaccounts/search?perpage=100&query=other'],
      ['GET', '/api/admin/users'],
      ['GET', '/api/serviceaccounts/1/../2/tokens'],
      ['GET', '/api/serviceaccounts/1%2F/tokens'],
      ['GET', '/api/serviceaccounts/1; id'],
      ['PATCH', '/api/serviceaccounts/1'],
      ['GET', '/api/serviceaccounts/'],
      ['DELETE', '/api/serviceaccounts/1/tokens/'],
    ])('refuses %s %s, and makes no request', (method, path) => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, '{}', 200)
      const result = withCurl(world, READER_BACKEND_REMOTE.grafanaApi, `${method}\n${path}\n`, shim)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('TRACES_GRAFANA_API_DONE')
      expect(shim.called()).toBe(false)
    })

    it('refuses a body that is not plain JSON text, and makes no request', () => {
      const world = createWorld()
      withPassword(world)
      for (const body of ['$(id)', '{"a":"`id`"}', String.raw`{"a":"b\"}`, "{'a':1}"]) {
        const shim = curl(world, '{}', 200)
        const result = withCurl(world, READER_BACKEND_REMOTE.grafanaApi, `POST\n/api/serviceaccounts\n${body}`, shim)
        expect(result.exitCode).not.toBe(0)
        expect(shim.called()).toBe(false)
      }
    })

    it('reports no answer, and makes no request, when the host holds no admin password', () => {
      const world = createWorld()
      const shim = curl(world, '{}', 200)
      const result = withCurl(world, READER_BACKEND_REMOTE.grafanaApi, 'GET\n/api/user\n', shim)
      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=000')
      expect(shim.called()).toBe(false)
    })
  })

  describe('createGrafanaToken', () => {
    const key = 'glsa_AbC123xyz_0f1e2d3c'
    const input = '7\nagent-reader-20261120120000\n'

    it('writes the key straight into token.staged (0440) and prints the id and nothing of the key', () => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, `{"id":9,"name":"agent-reader-20261120120000","key":"${key}"}`, 200)

      const result = withCurl(world, READER_BACKEND_REMOTE.createGrafanaToken, input, shim)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=200')
      expect(result.stdout).toContain('TRACES_GRAFANA_TOKEN_ID=9')
      expect(result.stdout).toContain('TRACES_GRAFANA_STAGED=1')
      // The key's hash is printed so a later step can prove the live file holds it; the key is not.
      expect(result.stdout).toContain(`TRACES_GRAFANA_KEY_SHA=${createHash('sha256').update(key).digest('hex')}`)
      expect(result.stdout + result.stderr).not.toContain(key)
      expect(result.stdout + result.stderr).not.toContain(ADMIN_PASSWORD)
      expect(world.read(`${world.grafanaFile}.staged`)).toBe(key)
      expect(statSync(`${world.grafanaFile}.staged`).mode & 0o777).toBe(0o440)
      expect(world.read(world.grafanaFile)).toBe(READER_GRAFANA_PLACEHOLDER)
      expect(readdirSync(join(world.grafanaFile, '..')).sort()).toEqual(['token', 'token.staged'])
      expect(shim.argv()).not.toContain(ADMIN_PASSWORD)
      expect(shim.argv()).toContain('http://127.0.0.1:3001/api/serviceaccounts/7/tokens')
      expect(shim.stdin()).toContain(
        String.raw`data = "{\"name\":\"agent-reader-20261120120000\",\"secondsToLive\":0}"`,
      )
    })

    it('reports a token that came back without a key by id only, and stages nothing', () => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, '{"id":9,"name":"x"}', 200)
      const result = withCurl(world, READER_BACKEND_REMOTE.createGrafanaToken, input, shim)
      expect(result.stdout).toContain('TRACES_GRAFANA_TOKEN_ID=9')
      expect(result.stdout).not.toContain('TRACES_GRAFANA_STAGED')
      expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
      expect(readdirSync(join(world.grafanaFile, '..'))).toEqual(['token'])
    })

    it('stages nothing for an error answer, even one that carries a key-shaped field', () => {
      const world = createWorld()
      withPassword(world)
      const shim = curl(world, `{"message":"no","key":"${key}"}`, 403)
      const result = withCurl(world, READER_BACKEND_REMOTE.createGrafanaToken, input, shim)
      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=403')
      expect(result.stdout).not.toContain('TRACES_GRAFANA_STAGED')
      expect(world.read(`${world.grafanaFile}.staged`)).toBeUndefined()
    })

    it('refuses an account id or token name that is not plain, and makes no request', () => {
      const world = createWorld()
      withPassword(world)
      for (const bad of ['x\nname\n', '1 2\nname\n', '1\nbad name\n', '1\nn;id\n', '\n\n', '1\n"q"\n']) {
        const shim = curl(world, '{}', 200)
        const result = withCurl(world, READER_BACKEND_REMOTE.createGrafanaToken, bad, shim)
        expect(result.exitCode).not.toBe(0)
        expect(shim.called()).toBe(false)
      }
    })
  })

  describe('checkGrafanaToken', () => {
    it('hands the token to curl as a config on stdin and prints only a status', () => {
      const world = createWorld()
      setFile(`${world.grafanaFile}.previous`, 'glsa_PreviousKey_abc123')
      const shim = curl(world, '{"login":"sa-agent-reader"}', 401)

      const result = withCurl(world, READER_BACKEND_REMOTE.checkGrafanaToken, 'previous\n', shim)

      expect(result.stdout).toContain('TRACES_GRAFANA_HTTP=401')
      expect(result.stdout + result.stderr).not.toContain('glsa_PreviousKey')
      expect(shim.stdin()).toContain('header = "Authorization: Bearer glsa_PreviousKey_abc123"')
      expect(shim.argv()).not.toContain('glsa_PreviousKey')
      expect(shim.argv()).toContain('http://127.0.0.1:3001/api/user')
    })

    it('a missing file, an empty file or a token with unsafe characters is no answer, and makes no request', () => {
      const world = createWorld()
      const missing = curl(world, '{}', 200)
      expect(withCurl(world, READER_BACKEND_REMOTE.checkGrafanaToken, 'staged\n', missing).stdout).toContain(
        'TRACES_GRAFANA_HTTP=000',
      )
      setFile(`${world.grafanaFile}.staged`, '')
      setFile(`${world.grafanaFile}.previous`, 'glsa_x"\nuser = "root:pw')
      for (const which of ['staged', 'previous']) {
        const shim = curl(world, '{}', 200)
        expect(withCurl(world, READER_BACKEND_REMOTE.checkGrafanaToken, `${which}\n`, shim).stdout).toContain(
          'TRACES_GRAFANA_HTTP=000',
        )
        expect(shim.called()).toBe(false)
      }
    })

    it('refuses a file selector other than staged, previous and live', () => {
      const world = createWorld()
      const shim = curl(world, '{}', 200)
      const result = withCurl(world, READER_BACKEND_REMOTE.checkGrafanaToken, '../../etc/passwd\n', shim)
      expect(result.exitCode).not.toBe(0)
      expect(shim.called()).toBe(false)
    })
  })

  describe('stageLangfuse', () => {
    it('writes the pair exactly, 0440, as token.staged, and nothing else is left in the directory', () => {
      const world = createWorld()
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${PAIR}\n`)
      expect(result.exitCode).toBe(0)
      // The host hashes the file it wrote and prints that hash on a hex-only line before the sentinel.
      expect(result.stdout.trim().split('\n')).toEqual([
        'TRACES_READER_BACKEND_SETTLED=none',
        `${STAGED_SHA_PREFIX}${shaOfText(PAIR)}`,
        'TRACES_READER_BACKEND_STAGED',
      ])
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(PAIR)
      expect(statSync(`${world.langfuseFile}.staged`).mode & 0o777).toBe(0o440)
      expect(stray(world)).toEqual([])
      expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
    })

    it.each([
      [''],
      ['pk-lf-aaaaaaaa'],
      [`${PK}:${SK}:extra`],
      [`${SK}:${PK}`],
      [`${PK}:${SK} trailing`],
      [`${PK}:${SK}"; id`],
      [READER_LANGFUSE_PLACEHOLDER],
      ['pk-lf-$(id):sk-lf-bbbbbbbb'],
    ])('refuses %j and writes nothing', pair => {
      const world = createWorld()
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${pair}\n`)
      expect(result.exitCode).not.toBe(0)
      expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
      expect(stray(world)).toEqual([])
    })

    it('stops, with its own sentinel, while a previous pair waits to be confirmed revoked', () => {
      const world = createWorld()
      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${PAIR}\n`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain(PREVIOUS_PENDING_SENTINEL)
      expect(world.read(`${world.langfuseFile}.staged`)).toBeUndefined()
    })
  })

  describe('switchLangfuse', () => {
    it('keeps the live pair as .previous, unless it is the placeholder', () => {
      const world = createWorld()
      const shaOf = (pair: string): string => createHash('sha256').update(pair).digest('hex')
      setFile(`${world.langfuseFile}.staged`, PAIR)
      const fresh = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(PAIR)}\n`)
      expect(fresh.stdout).toContain('TRACES_READER_BACKEND_PREVIOUS=none')
      expect(world.read(world.langfuseFile)).toBe(PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()

      setFile(`${world.langfuseFile}.staged`, OLD_PAIR)
      const rotated = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(OLD_PAIR)}\n`)
      expect(rotated.stdout).toContain('TRACES_READER_BACKEND_PREVIOUS=kept')
      expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBe(PAIR)
    })

    it('stops, changing nothing, while a previous pair still waits to be confirmed revoked', () => {
      const world = createWorld()
      setFile(world.langfuseFile, PAIR)
      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      setFile(`${world.langfuseFile}.staged`, 'pk-lf-55555555-eeee:sk-lf-66666666-ffff')
      const sha = createHash('sha256').update('pk-lf-55555555-eeee:sk-lf-66666666-ffff').digest('hex')
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${sha}\n`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain(PREVIOUS_PENDING_SENTINEL)
      expect(world.read(world.langfuseFile)).toBe(PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
      expect(world.read(`${world.langfuseFile}.staged`)).toBe('pk-lf-55555555-eeee:sk-lf-66666666-ffff')
    })

    it('fails without a staged pair', () => {
      const world = createWorld()
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${'0'.repeat(64)}\n`)
      expect(result.exitCode).not.toBe(0)
      expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
    })

    it('refuses a staged file whose hash is not the one given, and changes nothing', () => {
      const world = createWorld()
      setFile(`${world.langfuseFile}.staged`, PAIR)
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${'0'.repeat(64)}\n`)
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toContain('TRACES_READER_BACKEND_STAGED_CHANGED')
      expect(world.read(world.langfuseFile)).toBe(READER_LANGFUSE_PLACEHOLDER)
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(PAIR)
    })
  })

  // A switch is three steps (link live to `.previous.tmp`, rename staged to live, rename tmp to `.previous`), and a
  // process can stop between any two. A shim `mv` stands in for the stop: it exits 137 instead of renaming when the
  // destination ends with `STOP_BEFORE_MV`, so the real script runs under a real `sh` and dies where a kill would.
  describe('an interrupted Langfuse switch', () => {
    let stopDir = ''
    beforeAll(() => {
      stopDir = join(sandbox, 'stop-shim')
      mkdirSync(stopDir)
      writeFileSync(
        join(stopDir, 'mv'),
        [
          '#!/bin/sh',
          'for last; do :; done',
          'if [ -n "$STOP_BEFORE_MV" ]; then case "$last" in *"$STOP_BEFORE_MV") exit 137 ;; esac; fi',
          'exec "$REAL_MV" "$@"',
          '',
        ].join('\n'),
      )
      chmodSync(join(stopDir, 'mv'), 0o755)
    })

    const NEW_PAIR = 'pk-lf-55555555-eeee:sk-lf-66666666-ffff'
    const shaOf = (pair: string): string => createHash('sha256').update(pair).digest('hex')
    const withStop = (world: World, command: string, stdin: string, stopBefore: string) =>
      execOnHost(
        world.dir,
        command,
        stdin,
        {STOP_BEFORE_MV: stopBefore, REAL_MV: Bun.which('mv') ?? '/bin/mv'},
        `${stopDir}:${shimDir}`,
      )
    const names = (world: World): string[] => readdirSync(join(world.langfuseFile, '..')).sort()
    const statusOf = (world: World): string[] =>
      execOnHost(world.dir, READER_BACKEND_REMOTE.status, undefined)
        .stdout.split('\n')
        .filter(line => line.startsWith('TRACES_READER_CREDENTIAL langfuse'))

    /** Live holds OLD_PAIR and the staged file holds NEW_PAIR, as after a stage and a passed check. */
    const readyToSwitch = (): World => {
      const world = createWorld()
      setFile(world.langfuseFile, OLD_PAIR)
      setFile(`${world.langfuseFile}.staged`, NEW_PAIR)
      return world
    }

    it('a switch that completes leaves live, `.previous` and nothing else: the tmp name is gone', () => {
      const world = readyToSwitch()
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_READER_BACKEND_PREVIOUS=kept')
      expect(world.read(world.langfuseFile)).toBe(NEW_PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
      expect(names(world)).toEqual(['langfuse-basic', 'langfuse-basic.previous'])
      expect(statSync(`${world.langfuseFile}.previous`).mode & 0o777).toBe(0o440)
    })

    it('a stop after the link and before the commit leaves the old state: live is untouched and staged is kept', () => {
      const world = readyToSwitch()
      const stopped = withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '/langfuse-basic')
      expect(stopped.exitCode).toBe(137)
      expect(stopped.stdout).not.toContain('TRACES_READER_BACKEND_SWITCHED')
      expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(NEW_PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
      // The old pair is still on disk twice, once live and once under the tmp name.
      expect(world.read(`${world.langfuseFile}.previous.tmp`)).toBe(OLD_PAIR)
    })

    it('after that stop, status does not call the tmp copy a pending revocation', () => {
      const world = readyToSwitch()
      withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '/langfuse-basic')
      expect(statusOf(world)).toEqual([
        'TRACES_READER_CREDENTIAL langfuse installed',
        'TRACES_READER_CREDENTIAL langfuse staged-file-left-over',
        'TRACES_READER_CREDENTIAL langfuse interrupted-switch-left-over',
      ])
    })

    it('after that stop, a rerun of the switch removes the copy, reports it did not complete, keeps staged, and never says revoke', () => {
      const world = readyToSwitch()
      withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '/langfuse-basic')

      const rerun = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`)

      expect(rerun.exitCode).toBe(1)
      expect(rerun.stdout).toContain(SWITCH_INCOMPLETE_SENTINEL)
      expect(rerun.stdout).not.toContain(PREVIOUS_PENDING_SENTINEL)
      expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(NEW_PAIR)
      expect(names(world)).toEqual(['langfuse-basic', 'langfuse-basic.staged'])
      // Run again: nothing is left to settle, so it completes.
      const done = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`)
      expect(done.exitCode).toBe(0)
      expect(world.read(world.langfuseFile)).toBe(NEW_PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
    })

    it('after that stop, a new stage is not blocked by the copy', () => {
      const world = readyToSwitch()
      withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '/langfuse-basic')
      const staged = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${PAIR}\n`)
      expect(staged.exitCode).toBe(0)
      expect(staged.stdout).toContain('TRACES_READER_BACKEND_SETTLED=cleaned')
      expect(staged.stdout).not.toContain(PREVIOUS_PENDING_SENTINEL)
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(PAIR)
      expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
      expect(names(world)).toEqual(['langfuse-basic', 'langfuse-basic.staged'])
    })

    it('a stop after the commit and before the last rename leaves the old pair under the tmp name, and status calls it pending', () => {
      const world = readyToSwitch()
      const stopped = withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '.previous')
      expect(stopped.exitCode).toBe(137)
      expect(world.read(world.langfuseFile)).toBe(NEW_PAIR)
      expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
      expect(world.read(`${world.langfuseFile}.previous.tmp`)).toBe(OLD_PAIR)
      expect(statusOf(world)).toEqual(['TRACES_READER_CREDENTIAL langfuse pending-old-revocation'])
    })

    it('after that stop, the settle step names the old pair `.previous` again, and a stage is stopped by it as usual', () => {
      const world = readyToSwitch()
      withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '.previous')

      const settled = execOnHost(world.dir, READER_BACKEND_REMOTE.settleLangfuse, undefined)

      expect(settled.exitCode).toBe(0)
      expect(settled.stdout).toContain('TRACES_READER_BACKEND_SETTLED=recovered')
      expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
      expect(names(world)).toEqual(['langfuse-basic', 'langfuse-basic.previous'])
      expect(statusOf(world)).toEqual(['TRACES_READER_CREDENTIAL langfuse pending-old-revocation'])
      const blocked = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${PAIR}\n`)
      expect(blocked.exitCode).toBe(1)
      expect(blocked.stdout).toContain(PREVIOUS_PENDING_SENTINEL)
    })

    it('a `.previous` that is a copy of the live pair is not pending: status, stage and switch all say so', () => {
      const world = createWorld()
      setFile(world.langfuseFile, OLD_PAIR)
      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      expect(statusOf(world)).toEqual([
        'TRACES_READER_CREDENTIAL langfuse installed',
        'TRACES_READER_CREDENTIAL langfuse interrupted-switch-left-over',
      ])
      // A different previous pair is pending, whatever the live one is.
      setFile(`${world.langfuseFile}.previous`, PAIR)
      expect(statusOf(world)).toEqual(['TRACES_READER_CREDENTIAL langfuse pending-old-revocation'])

      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      setFile(`${world.langfuseFile}.staged`, NEW_PAIR)
      const switched = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`)
      expect(switched.exitCode).toBe(1)
      expect(switched.stdout).toContain(SWITCH_INCOMPLETE_SENTINEL)
      expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
      expect(world.read(`${world.langfuseFile}.staged`)).toBe(NEW_PAIR)
      expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)

      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      const staged = execOnHost(world.dir, READER_BACKEND_REMOTE.stageLangfuse, `${PAIR}\n`)
      expect(staged.exitCode).toBe(0)
      expect(staged.stdout).toContain('TRACES_READER_BACKEND_SETTLED=cleaned')
      expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
    })

    it('switching the pair that is already live keeps no previous', () => {
      const world = createWorld()
      setFile(world.langfuseFile, NEW_PAIR)
      setFile(`${world.langfuseFile}.staged`, NEW_PAIR)
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_READER_BACKEND_PREVIOUS=none')
      expect(names(world)).toEqual(['langfuse-basic'])
    })

    it('status without a live file or on a placeholder never calls a previous file pending', () => {
      const world = createWorld()
      setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
      expect(statusOf(world)).toEqual(['TRACES_READER_CREDENTIAL langfuse placeholder'])
    })

    // The same, through the command: what the operator is told.
    describe('through the command', () => {
      it('an install over a copy of the live pair goes through, says the copy was removed, and does not ask for a revocation', async () => {
        const world = createWorld()
        setFile(world.langfuseFile, OLD_PAIR)
        setFile(`${world.langfuseFile}.previous`, OLD_PAIR)
        world.pairs.set(PAIR, 'viewer')
        world.pairs.set(OLD_PAIR, 'viewer')

        const outcome = await installLangfuse(world)

        expect(outcome.exit).toBeNull()
        expect(outcome.stdout).toContain('copy of the live pair')
        expect(outcome.stderr).not.toContain('still waiting to be confirmed revoked')
        expect(world.read(world.langfuseFile)).toBe(PAIR)
        // The old live pair is now genuinely pending, and only now is the operator told to revoke it.
        expect(world.read(`${world.langfuseFile}.previous`)).toBe(OLD_PAIR)
        expect(outcome.stdout).toContain('--confirm-old-revoked')
      })

      it('a switch that finds a copy of the live pair reports it did not complete, keeps the staged pair, and does not advise revoking', async () => {
        const world = createWorld()
        setFile(world.langfuseFile, OLD_PAIR)
        world.pairs.set(PAIR, 'viewer')
        world.pairs.set(OLD_PAIR, 'viewer')
        // Between the check and the switch an earlier, interrupted switch's copy appears.
        world.afterCheck = () => setFile(`${world.langfuseFile}.previous`, OLD_PAIR)

        const outcome = await installLangfuse(world)

        expect(outcome.exit).toBe(1)
        expect(outcome.stderr).toContain('switch did not complete; staged pair kept')
        expect(outcome.stderr).not.toMatch(/revok/i)
        expect(world.read(world.langfuseFile)).toBe(OLD_PAIR)
        expect(world.read(`${world.langfuseFile}.staged`)).toBe(PAIR)
        expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
      })

      it('--confirm-old-revoked settles first: a copy of the live pair is not proven refused or deleted as an old key', async () => {
        const world = createWorld()
        setFile(world.langfuseFile, PAIR)
        setFile(`${world.langfuseFile}.previous`, PAIR)
        world.pairs.set(PAIR, 'viewer')

        const outcome = await installLangfuse(world, [], {confirmOldRevoked: true})

        expect(outcome.exit).toBe(1)
        expect(outcome.stderr).toContain('no previous Langfuse pair')
        expect(outcome.stdout).toContain('copy of the live pair')
        expect(world.checks).toEqual([
          {kind: 'langfuse-refused', credentialFile: '/run/secrets/reader-gate/langfuse-basic.previous'},
        ])
        expect(world.read(world.langfuseFile)).toBe(PAIR)
        expect(world.read(`${world.langfuseFile}.previous`)).toBeUndefined()
      })

      it('--confirm-old-revoked after a stop past the commit recovers the old pair, proves it refused, and deletes it', async () => {
        const world = readyToSwitch()
        withStop(world, READER_BACKEND_REMOTE.switchLangfuse, `${shaOf(NEW_PAIR)}\n`, '.previous')
        // OLD_PAIR is not in `pairs`: Langfuse refuses it.

        const outcome = await installLangfuse(world, [], {confirmOldRevoked: true})

        expect(outcome.exit).toBeNull()
        expect(outcome.stdout).toContain('recovered')
        expect(world.read(world.langfuseFile)).toBe(NEW_PAIR)
        expect(names(world)).toEqual(['langfuse-basic'])
      })

      it('status names a copy of the live pair as installed, with a note, and as JSON as installed', async () => {
        const world = createWorld()
        setFile(world.langfuseFile, PAIR)
        setFile(`${world.langfuseFile}.previous`, PAIR)
        const text = await run(world, ctx => tracesReaderBackendStatusAction({}, ctx, makeDeps(world)), {secrets: []})
        expect(text.stdout).toContain('langfuse: installed')
        expect(text.stdout).not.toContain('not yet confirmed revoked')
        expect(text.stdout).toContain('nothing to revoke')
        const json = await run(world, ctx => tracesReaderBackendStatusAction({json: true}, ctx, makeDeps(world)), {
          secrets: [],
        })
        expect(JSON.parse(json.stdout)).toEqual({langfuse: 'installed', grafana: 'placeholder'})
      })
    })
  })

  describe('undoGrafanaSwitch', () => {
    it('fails and changes nothing when there is neither a staged nor a previous file', () => {
      const world = createWorld()
      const before = world.read(world.grafanaFile)
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.undoGrafanaSwitch, '')
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('TRACES_READER_BACKEND_RESTORED')
      expect(world.read(world.grafanaFile)).toBe(before)
    })

    it('puts the previous file back as the live one when the staged file is gone', () => {
      const world = createWorld()
      setFile(`${world.grafanaFile}.previous`, 'glsa_previouspreviousprev')
      const result = execOnHost(world.dir, READER_BACKEND_REMOTE.undoGrafanaSwitch, '')
      expect(result.stdout).toContain('TRACES_READER_BACKEND_UNDO=restored')
      expect(world.read(world.grafanaFile)).toBe('glsa_previouspreviousprev')
      expect(world.read(`${world.grafanaFile}.previous`)).toBeUndefined()
    })
  })

  describe('verifyGrafanaLive', () => {
    const key = 'glsa_LiveKey_abc123'
    const sha = createHash('sha256').update(key).digest('hex')

    it('says same for the key it was given the hash of, and changed for any other file content', () => {
      const world = createWorld()
      setFile(world.grafanaFile, key)
      const same = execOnHost(world.dir, READER_BACKEND_REMOTE.verifyGrafanaLive, `${sha}\n`)
      expect(same.stdout).toContain('TRACES_GRAFANA_LIVE=same')
      expect(same.stdout + same.stderr).not.toContain(key)
      setFile(world.grafanaFile, 'glsa_other')
      expect(execOnHost(world.dir, READER_BACKEND_REMOTE.verifyGrafanaLive, `${sha}\n`).stdout).toContain(
        'TRACES_GRAFANA_LIVE=changed',
      )
    })

    it('says changed for a missing file, and refuses a value that is not a SHA-256', () => {
      const world = createWorld()
      rmSync(world.grafanaFile)
      expect(execOnHost(world.dir, READER_BACKEND_REMOTE.verifyGrafanaLive, `${sha}\n`).stdout).toContain(
        'TRACES_GRAFANA_LIVE=changed',
      )
      for (const bad of ['', key, 'g'.repeat(64), '0'.repeat(63)]) {
        expect(execOnHost(world.dir, READER_BACKEND_REMOTE.verifyGrafanaLive, `${bad}\n`).exitCode).not.toBe(0)
      }
    })
  })

  describe('hygiene and constants', () => {
    const commands = Object.entries(READER_BACKEND_REMOTE).flatMap(([name, value]) =>
      typeof value === 'string'
        ? [[name, value] as const]
        : (['langfuse', 'grafana'] as const).map(credential => [`${name}(${credential})`, value(credential)] as const),
    )

    it.each(commands)(
      '%s: fixed text, no null device, no eval, no backticks, only its own files deleted',
      (_name, command) => {
        expect(command).not.toContain('/dev/')
        expect(command).not.toMatch(/(^|[\s;&|])[0-8]>/)
        expect(command).not.toContain('&>')
        expect(command).not.toContain('eval')
        expect(command).not.toContain('`')
        expect(command).not.toContain('$@')
        for (const match of command.matchAll(/\brm\b[^;']*/g)) {
          // `$p` is `$f.previous` and `$q` is `$f.previous.tmp`, set by the settle fragment; both are asserted below.
          expect(['rm -f "$t"', 'rm -f "$f.staged"', 'rm -f "$f.previous"', 'rm -f "$p"', 'rm -f "$q"']).toContain(
            match[0].trim(),
          )
        }
      },
    )

    it.each(commands)('%s: carries no credential, no token and no admin password', (_name, command) => {
      expect(command).not.toMatch(/glsa_(?!unset)/)
      expect(command).not.toContain('trc_')
      expect(command).not.toMatch(/pk-lf-(?!\*|unset)/)
      expect(command).not.toContain(ADMIN_PASSWORD)
    })

    it('every curl runs from a config on stdin, and no script prints or interpolates a secret file into argv', () => {
      for (const command of [
        READER_BACKEND_REMOTE.grafanaApi,
        READER_BACKEND_REMOTE.createGrafanaToken,
        READER_BACKEND_REMOTE.checkGrafanaToken,
      ]) {
        expect(command).toContain("curl -q -s --noproxy '*' --max-time 15 -K -")
        expect(command).not.toMatch(/curl[^|;]*(--user|-u |--header|Bearer \$)/)
        // The credential reaches curl only through the config pipe: `printf ... | curl ... -K -`.
        expect(command).toMatch(/printf '[^']*(user|header) = [^']*' [^|]*\| curl/)
      }
      // The token creation script never prints the key: the only place `$key` is used is the redirect into the file.
      const uses = [...READER_BACKEND_REMOTE.createGrafanaToken.matchAll(/\$key\b/g)].length
      const written = [...READER_BACKEND_REMOTE.createGrafanaToken.matchAll(/printf %s "\$key" > "\$t"/g)].length
      expect(written).toBe(1)
      // The others are the emptiness test in the staging condition and the hash printed for the live-file check.
      expect(uses).toBe(3)
      expect(READER_BACKEND_REMOTE.createGrafanaToken).toContain('printf %s "$key" | sha256sum')
    })

    it('the file paths, suffixes and placeholders are the ones apps/traces and the compose file name', async () => {
      const hostSource = await Bun.file(new URL('../../../../../apps/traces/src/host.ts', import.meta.url)).text()
      const compose = await Bun.file(new URL('../../../../../apps/traces/docker-compose.yaml', import.meta.url)).text()
      expect(hostSource).toContain("READER_STAGED_SUFFIX = '.staged'")
      expect(hostSource).toContain("READER_PREVIOUS_SUFFIX = '.previous'")
      expect(hostSource).toContain(`READER_LANGFUSE_PLACEHOLDER = '${READER_LANGFUSE_PLACEHOLDER}'`)
      expect(hostSource).toContain(`READER_GRAFANA_PLACEHOLDER = '${READER_GRAFANA_PLACEHOLDER}'`)
      expect(TRACES_READER_LANGFUSE_FILE).toBe(`${TRACES_APP_DIR}/secrets/reader-gate/langfuse-basic`)
      expect(TRACES_GRAFANA_MCP_TOKEN_FILE).toBe(`${TRACES_APP_DIR}/secrets/grafana-mcp/token`)
      // The gate container reads the live and staged files from the mount the CLI names.
      expect(compose).toContain('./secrets/reader-gate:/run/secrets/reader-gate:ro')
      expect(compose).toContain('LANGFUSE_BASIC_FILE: /run/secrets/reader-gate/langfuse-basic')
      expect(compose).toContain('GRAFANA_SERVICE_ACCOUNT_TOKEN_FILE: /run/secrets/grafana-mcp/token')
      // Grafana's loopback port and the admin password file are the ones deploy uses.
      expect(compose).toContain('127.0.0.1:3001:3000')
      const deploySource = await Bun.file(new URL('../../../../../apps/traces/src/deploy.ts', import.meta.url)).text()
      expect(deploySource).toContain('file=secrets/grafana/admin-password')
      expect(deploySource).toContain('http://127.0.0.1:3001/api/user')
      expect(READER_BACKEND_REMOTE.grafanaApi).toContain(`${TRACES_APP_DIR}/secrets/grafana/admin-password`)
    })
  })
})
