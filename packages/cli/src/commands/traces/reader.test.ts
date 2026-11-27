import {createHash} from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {controlPaths, installHostShims, recordingSpawn, type SpawnCall} from './__fixtures__/remote-fixture'
import {TRACES_APP_DIR, TRACES_READER_DIR, TRACES_READER_LOCK, TRACES_READER_TOKEN_FILE} from './host'
import {
  CONSUMER_PATTERN,
  DEFAULT_READER_SECRET_NAME,
  defaultWorkstationFile,
  READER_LOCK_BUSY_SENTINEL,
  READER_REMOTE,
  READER_ROUTES,
  readerSentinel,
  tracesReaderAddAction,
  tracesReaderListAction,
  tracesReaderRevokeAction,
  type AddOptions,
  type ReaderDeps,
  type RevokeOptions,
} from './reader'
import {fingerprintOf, formatVoidLine, generateToken, generateVoidToken, VOID_TOKEN_PREFIX} from './token-common'

const ENV_KEYS = ['TRACES_HOST', 'TRACES_DOMAIN', 'TRACES_SSH_KEY'] as const
let savedEnv: Record<string, string | undefined> = {}

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  delete process.env.TRACES_SSH_KEY
  process.env.TRACES_HOST = 'host.example.invalid'
  process.env.TRACES_DOMAIN = 'traces.example.invalid'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key]
    else process.env[key] = savedEnv[key]
  }
})

// ─── A host that runs the real remote scripts ─────────────────────────────────
//
// The token commands are shell scripts. The fake host runs them under a real `sh` against a temporary directory
// standing in for the app directory, so atomic replace, mode preservation and line removal are proven by their
// effect on real files. The gate is modelled from that same file, parsed the way the gate parses it: a token is
// accepted exactly when the whole file is well formed and the token is the first field of a reader line.

const CREATED = '2026-11-20T12:00:00.000Z'
const OLD_A = `trc_${'A'.repeat(43)}`
const OLD_B = `trc_${'B'.repeat(43)}`
const OLD_C = `trc_${'C'.repeat(43)}`

const sha12 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12)
const readerLine = (token: string, consumer: string, date = '2026-10-01T00:00:00.000Z'): string =>
  `${token} ${sha12(token)} ${consumer} ${date}\n`

function randomFilledWith(byte: number): (length: number) => Uint8Array {
  return length => new Uint8Array(length).fill(byte)
}

const voidLine = (seed: number, date = '2026-10-01T00:00:00.000Z'): string =>
  formatVoidLine(generateVoidToken(randomFilledWith(seed)), date)

let sandbox = ''
let shimDir = ''

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'traces-reader-'))
  shimDir = installHostShims(join(sandbox, 'shim'))
})

afterAll(() => {
  rmSync(sandbox, {recursive: true, force: true})
})

function execOnHost(
  dir: string,
  command: string,
  stdin: string | undefined,
): {exitCode: number; stdout: string; stderr: string} {
  const result = Bun.spawnSync(['sh', '-c', command.replaceAll(TRACES_APP_DIR, dir)], {
    stdin: new TextEncoder().encode(stdin ?? ''),
    env: {PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: dir},
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString()}
}

/** The gate's view of a token file: the set of accepted tokens, or null when it denies everything. */
function gateTokens(text: string): Set<string> | null {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return null
  const tokens = new Set<string>()
  for (const line of lines) {
    const fields = line.split(' ')
    const token = fields[0] ?? ''
    if (token.startsWith(VOID_TOKEN_PREFIX)) {
      if (fields.length !== 3 || fields[1] !== 'void') return null
      continue
    }
    if (fields.length !== 4 || !/^trc_[\w-]{32,128}$/.test(token)) return null
    if (fields[1] !== sha12(token)) return null
    if (!CONSUMER_PATTERN.test(fields[2] ?? '')) return null
    if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(fields[3] ?? '')) return null
    tokens.add(token)
  }
  return tokens
}

interface WorldOptions {
  /** Full token-file contents. Default: one void line, as deploy creates it. */
  file?: string
  /** What the public origin does: answer as the gate does, answer nothing, or answer 502 to everything. */
  publicRoute?: 'up' | 'down' | 'broken'
}

interface FetchCall {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: unknown
}

interface World {
  dir: string
  spawn: ReturnType<typeof recordingSpawn>['spawn']
  calls: SpawnCall[]
  closes: ReturnType<typeof recordingSpawn>['closes']
  fetch: NonNullable<ReaderDeps['fetch']>
  fetchCalls: FetchCall[]
  /** Tokens the modelled gate keeps accepting whatever the file says. */
  stubborn: Set<string>
  /** Answers for the next authenticated requests, consumed first. */
  forced: (number | 'down')[]
  /** Remote operations that fail, by name. */
  failing: Set<string>
  /** Remote operations that run and change the host, but whose reply is lost. */
  dropReply: Set<string>
  /** Remote operations that find the lock held and change nothing. */
  busy: Set<string>
  gh: {exitCode: number; stderr: string}
  file: () => string
  path: string
  accepts: (token: string) => boolean
  ghCalls: () => SpawnCall[]
  probeCalls: () => SpawnCall[]
}

let worldCounter = 0

function createWorld(options: WorldOptions = {}): World {
  worldCounter += 1
  const dir = join(sandbox, `app-${worldCounter}`)
  mkdirSync(join(dir, 'readers'), {recursive: true})
  const path = join(dir, 'readers', 'token')
  writeFileSync(path, options.file ?? voidLine(1))
  chmodSync(path, 0o640)
  const publicRoute = options.publicRoute ?? 'up'

  const stubborn = new Set<string>()
  const forced: (number | 'down')[] = []
  const failing = new Set<string>()
  const dropReply = new Set<string>()
  const busy = new Set<string>()
  const gh = {exitCode: 0, stderr: ''}

  const file = (): string => readFileSync(path, 'utf8')
  const accepts = (token: string): boolean =>
    token !== '' && (stubborn.has(token) || (gateTokens(file())?.has(token) ?? false))

  const status = (token: string | undefined): number | 'down' => {
    if (token === undefined) return 401
    const next = forced.shift()
    if (next !== undefined) return next
    return accepts(token) ? 200 : 401
  }

  const ops = {
    list: READER_REMOTE.list,
    lines: READER_REMOTE.lines,
    append: READER_REMOTE.append,
    remove: READER_REMOTE.remove,
    deny: READER_REMOTE.deny,
  } as const

  const route = (call: SpawnCall) => {
    if (call.argv[0] === 'gh') return gh.exitCode === 0 ? {exitCode: 0} : {exitCode: gh.exitCode, stderr: gh.stderr}
    if (call.command === READER_REMOTE.probe) {
      const [, which = '', token = ''] = (call.stdin ?? '').split('\n')
      expect(READER_ROUTES as readonly string[]).toContain(which)
      const answer = status(token)
      if (answer === 'down') return {exitCode: 1, stderr: 'connect refused'}
      return {stdout: `TRACES_READER_PROBE_STATUS=${answer}\n`}
    }
    for (const [name, command] of Object.entries(ops)) {
      if (call.command !== command) continue
      if (failing.has(name)) return {exitCode: 1, stderr: `${name} failed on the host`}
      if (busy.has(name)) return {exitCode: 1, stdout: `${READER_LOCK_BUSY_SENTINEL}\n`}
      const result = execOnHost(dir, command, call.stdin)
      if (dropReply.has(name)) return {exitCode: 255, stderr: 'ssh: connection reset by peer'}
      return result
    }
    throw new Error(`unexpected remote command: ${call.command}`)
  }

  const {spawn, calls, closes} = recordingSpawn(route)
  const fetchCalls: FetchCall[] = []

  return {
    dir,
    spawn,
    calls,
    closes,
    fetchCalls,
    stubborn,
    forced,
    failing,
    dropReply,
    busy,
    gh,
    file,
    path,
    accepts,
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
      fetchCalls.push({url, method: init?.method, headers, body: init?.body})
      if (publicRoute === 'down') throw new TypeError('connect failed')
      if (publicRoute === 'broken') return new Response('', {status: 502})
      const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
      const answer = status(authorization?.replace(/^Bearer /, ''))
      if (answer === 'down') throw new TypeError('connect failed')
      return new Response('', {status: answer})
    },
    ghCalls: () => calls.filter(call => call.argv[0] === 'gh'),
    probeCalls: () => calls.filter(call => call.command === READER_REMOTE.probe),
  }
}

// ─── Running an action, and the rule that no token leaks ──────────────────────

const NEXT = generateToken(randomFilledWith(7))
const NEXT_TOKEN = NEXT.token
const NEXT_FINGERPRINT = NEXT.fingerprint
const DEFAULT_VOID_TOKEN = generateVoidToken(randomFilledWith(7))

let homeCounter = 0

function makeDeps(world: World, extra: Partial<ReaderDeps> = {}): ReaderDeps & {slept: number[]; draws: number[]} {
  const slept: number[] = []
  const draws: number[] = []
  homeCounter += 1
  const home = join(sandbox, `home-${homeCounter}`)
  mkdirSync(home, {recursive: true})
  return {
    spawn: world.spawn,
    fetch: world.fetch,
    sleep: async ms => {
      slept.push(ms)
    },
    attempts: 3,
    intervalMs: 5,
    randomBytes: length => {
      draws.push(length)
      return new Uint8Array(length).fill(7)
    },
    now: () => new Date(CREATED),
    isTty: false,
    homeDir: home,
    ...extra,
    slept,
    draws,
  }
}

interface Outcome {
  stdout: string
  stderr: string
  exit: number | null
}

interface RunOptions {
  /** Token text no ssh argument, environment, standard output or standard error may contain. */
  secrets: string[]
  /** The one scenario that prints a token on purpose: a terminal. Standard output is not scanned. */
  printsOnStdout?: boolean
}

async function run(
  world: World,
  action: (ctx: ReturnType<typeof createCapturedCtx>['ctx']) => Promise<void>,
  options: RunOptions,
): Promise<Outcome> {
  const {ctx, captured} = createCapturedCtx()
  try {
    await action(ctx)
  } catch (error) {
    if (!(error instanceof MockProcessExit)) throw error
  }
  const stdout = captured.stdout.join('\n')
  const stderr = captured.stderr.join('\n')

  // The void token a revoke generates by default is as secret as a real one: it may travel on stdin and nowhere else.
  for (const secret of [...options.secrets, DEFAULT_VOID_TOKEN]) {
    for (const call of [...world.calls, ...world.closes]) {
      expect(call.argv.join('\u0000')).not.toContain(secret)
    }
    for (const call of world.calls) expect(JSON.stringify(call.options.env)).not.toContain(secret)
    expect(stderr).not.toContain(secret)
    if (options.printsOnStdout !== true) expect(stdout).not.toContain(secret)
  }
  // A token travels in the Authorization header of a proof and nowhere else in a request.
  for (const call of world.fetchCalls) {
    expect(call.url).not.toContain('trc_')
    expect(String(call.body ?? '')).not.toContain('trc_')
  }
  return {stdout, stderr, exit: captured.exit?.code ?? null}
}

const add = (world: World, consumer: string, options: AddOptions, deps: ReaderDeps, secrets: string[] = [NEXT_TOKEN]) =>
  run(world, ctx => tracesReaderAddAction(consumer, options, ctx, deps), {secrets})

const revoke = (
  world: World,
  consumer: string | undefined,
  fingerprint: string | undefined,
  options: RevokeOptions,
  deps: ReaderDeps,
  secrets: string[] = [OLD_A, OLD_B, OLD_C],
) => run(world, ctx => tracesReaderRevokeAction(consumer, fingerprint, options, ctx, deps), {secrets})

const ghOptions = (repo = 'marcusrbrown/systematic'): AddOptions => ({repo: [repo]})

const realLines = (text: string): string[] =>
  text.split('\n').filter(line => line !== '' && !line.startsWith(VOID_TOKEN_PREFIX))

// ─── add ──────────────────────────────────────────────────────────────────────

describe('traces reader add', () => {
  it('appends one line, proves 200 on both routes publicly, and pipes the token to gh on stdin only', async () => {
    const world = createWorld()
    const deps = makeDeps(world)

    const outcome = await add(world, 'systematic', ghOptions(), deps)

    expect(outcome.exit).toBeNull()
    expect(realLines(world.file())).toEqual([`${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic ${CREATED}`])
    // The void line a fresh deploy writes stays: it is harmless and keeps the file non-empty.
    expect(world.accepts(NEXT_TOKEN)).toBe(true)

    const authenticated = world.fetchCalls.filter(call => 'authorization' in call.headers)
    expect(authenticated.map(call => [call.method, new URL(call.url).pathname])).toEqual([
      ['GET', '/agent/langfuse/api/public/health'],
      ['POST', '/agent/grafana/mcp'],
    ])
    expect(authenticated.every(call => call.headers.authorization === `Bearer ${NEXT_TOKEN}`)).toBe(true)
    expect(world.probeCalls()).toHaveLength(0)

    expect(world.ghCalls()).toHaveLength(1)
    const gh = world.ghCalls()[0]
    expect(gh?.argv).toEqual(['gh', 'secret', 'set', DEFAULT_READER_SECRET_NAME, '--repo', 'marcusrbrown/systematic'])
    expect(gh?.stdin).toBe(NEXT_TOKEN)
    expect(outcome.stdout).toContain(`Token ${NEXT_FINGERPRINT} is live`)
    expect(outcome.stdout).toContain('Delivered to repository marcusrbrown/systematic as secret TRACES_READER_TOKEN')
  })

  it('accepts a leading-dot repository name and a custom secret name', async () => {
    const world = createWorld()
    await add(world, 'fro-bot-audit', {repo: ['fro-bot/.github'], secretName: 'AUDIT_TOKEN'}, makeDeps(world))
    expect(world.ghCalls()[0]?.argv).toEqual(['gh', 'secret', 'set', 'AUDIT_TOKEN', '--repo', 'fro-bot/.github'])
  })

  it('refuses an existing consumer without --replace before it generates a token or changes anything', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + voidLine(2)})
    const before = world.file()
    const deps = makeDeps(world)

    const outcome = await add(world, 'systematic', ghOptions(), deps)

    expect(outcome.exit).toBe(1)
    expect(deps.draws).toEqual([])
    expect(world.file()).toBe(before)
    expect(world.ghCalls()).toHaveLength(0)
    expect(outcome.stderr).toContain('already has a reader token')
    expect(outcome.stderr).toContain(sha12(OLD_A))
    expect(outcome.stderr).toContain('--replace')
  })

  it('refuses a consumer name that is not a short kebab name, before it reads or changes anything', async () => {
    for (const bad of ['Systematic', '1abc', 'a_b', 'a b', '-a', '', 'x'.repeat(32), '../etc', 'a;id']) {
      const world = createWorld()
      const outcome = await add(world, bad, ghOptions(), makeDeps(world))
      expect(outcome.exit).toBe(1)
      expect(outcome.stderr).toContain('Invalid consumer name')
      expect(world.calls).toHaveLength(0)
    }
    for (const good of ['a', 'systematic', 'fro-bot-audit', `a${'b'.repeat(30)}`]) {
      expect(CONSUMER_PATTERN.test(good)).toBe(true)
    }
  })

  it('refuses to write to a token file the gate would reject, and says why', async () => {
    const world = createWorld({file: `${readerLine(OLD_A, 'systematic')}${OLD_B} nonsense\n`})
    const before = world.file()
    const deps = makeDeps(world)
    const outcome = await add(world, 'fro-bot-audit', ghOptions(), deps)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('1 malformed line')
    expect(deps.draws).toEqual([])
    expect(world.file()).toBe(before)
  })

  it('--replace installs and proves the new token, delivers it, then removes the old one and proves it refused', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + voidLine(2)})
    const deps = makeDeps(world)

    const outcome = await add(world, 'systematic', {...ghOptions(), replace: true}, deps, [NEXT_TOKEN, OLD_A])

    expect(outcome.exit).toBeNull()
    expect(realLines(world.file())).toEqual([`${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic ${CREATED}`])
    expect(world.accepts(NEXT_TOKEN)).toBe(true)
    expect(world.accepts(OLD_A)).toBe(false)
    expect(world.ghCalls()[0]?.stdin).toBe(NEXT_TOKEN)
    expect(outcome.stdout).toContain(`Old token ${sha12(OLD_A)} removed`)
    // The old token was proven refused on both routes, after the new one was delivered.
    const order = world.calls.map(call =>
      call.argv[0] === 'gh' ? 'gh' : call.command === READER_REMOTE.remove ? 'remove' : '',
    )
    expect(order.indexOf('gh')).toBeLessThan(order.indexOf('remove'))
    const refusals = world.fetchCalls.filter(call => call.headers.authorization === `Bearer ${OLD_A}`)
    expect(refusals).toHaveLength(2)
  })

  it('--replace for a consumer with no token is a fresh add', async () => {
    const world = createWorld()
    const outcome = await add(world, 'systematic', {...ghOptions(), replace: true}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    expect(realLines(world.file())).toHaveLength(1)
  })

  it('on a fresh add, a proof that fails removes the token, proves it refused and names the fingerprint', async () => {
    const world = createWorld()
    // The first authenticated answer is a 502 (a placeholder credential, say); the rest follow the file.
    world.forced.push(502, 502, 502)
    const deps = makeDeps(world)

    const outcome = await add(world, 'systematic', ghOptions(), deps)

    expect(outcome.exit).toBe(1)
    expect(world.ghCalls()).toHaveLength(0)
    expect(realLines(world.file())).toEqual([])
    expect(world.accepts(NEXT_TOKEN)).toBe(false)
    expect(outcome.stderr).toContain(`Token ${NEXT_FINGERPRINT} is in the reader token file but is not live`)
    expect(outcome.stderr).toContain('502')
    expect(outcome.stdout).toContain(`Token ${NEXT_FINGERPRINT} was removed and is refused on both routes`)
  })

  it('a proof that fails under --replace removes only the new token and leaves the old one serving', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + voidLine(2)})
    world.forced.push(502, 502, 502)
    const outcome = await add(world, 'systematic', {...ghOptions(), replace: true}, makeDeps(world), [
      NEXT_TOKEN,
      OLD_A,
    ])
    expect(outcome.exit).toBe(1)
    expect(realLines(world.file())).toEqual([readerLine(OLD_A, 'systematic').trim()])
    expect(world.accepts(OLD_A)).toBe(true)
    expect(world.accepts(NEXT_TOKEN)).toBe(false)
  })

  it('on a fresh add, a gh failure removes the new token, proves its refusal and says to run add again', async () => {
    const world = createWorld()
    world.gh.exitCode = 1
    world.gh.stderr = 'HTTP 403: Resource not accessible'

    const outcome = await add(world, 'systematic', ghOptions(), makeDeps(world))

    expect(outcome.exit).toBe(1)
    expect(realLines(world.file())).toEqual([])
    expect(world.accepts(NEXT_TOKEN)).toBe(false)
    expect(outcome.stderr).toContain(NEXT_FINGERPRINT)
    expect(outcome.stderr).toContain('HTTP 403')
    expect(outcome.stderr).toContain('run add again')
    expect(outcome.stdout).toContain('is refused on both routes')
  })

  it('with --replace, a gh failure revokes neither token, prints both fingerprints and the follow-up commands', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + voidLine(2)})
    world.gh.exitCode = 1
    world.gh.stderr = 'gh: network down'

    const outcome = await add(world, 'systematic', {...ghOptions(), replace: true}, makeDeps(world), [
      NEXT_TOKEN,
      OLD_A,
    ])

    expect(outcome.exit).toBe(1)
    expect(world.accepts(NEXT_TOKEN)).toBe(true)
    expect(world.accepts(OLD_A)).toBe(true)
    expect(world.calls.filter(call => call.command === READER_REMOTE.remove)).toHaveLength(0)
    expect(outcome.stderr).toContain(NEXT_FINGERPRINT)
    expect(outcome.stderr).toContain(sha12(OLD_A))
    expect(outcome.stderr).toContain(`infra traces reader revoke systematic ${NEXT_FINGERPRINT}`)
    expect(outcome.stderr).toContain(`infra traces reader revoke systematic ${sha12(OLD_A)}`)

    // `list` then flags the consumer.
    const list = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN, OLD_A],
    })
    expect(list.stdout).toContain('! systematic has 2 tokens')
  })

  it('does not report success when the host does not confirm the write, and names the fingerprint and both next steps', async () => {
    const world = createWorld()
    world.dropReply.add('append')
    const outcome = await add(world, 'systematic', ghOptions(), makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain(NEXT_FINGERPRINT)
    expect(outcome.stderr).toContain('infra traces reader list')
    expect(outcome.stderr).toContain(`infra traces reader revoke systematic ${NEXT_FINGERPRINT}`)
    expect(world.ghCalls()).toHaveLength(0)
  })

  it('reports a busy lock as such and changes nothing', async () => {
    const world = createWorld()
    world.busy.add('append')
    const before = world.file()
    const outcome = await add(world, 'systematic', ghOptions(), makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('lock is busy')
    expect(world.file()).toBe(before)
    expect(world.ghCalls()).toHaveLength(0)
  })

  it('proves over ssh from the host when the public route does not answer as the gate does', async () => {
    for (const publicRoute of ['down', 'broken'] as const) {
      const world = createWorld({publicRoute})
      const outcome = await add(world, 'systematic', ghOptions(), makeDeps(world))
      expect(outcome.exit).toBeNull()
      const probes = world.probeCalls()
      expect(probes.map(call => (call.stdin ?? '').split('\n').slice(0, 2))).toEqual([
        ['traces.example.invalid', 'langfuse'],
        ['traces.example.invalid', 'grafana'],
      ])
      expect(probes.every(call => call.stdin?.split('\n')[2] === NEXT_TOKEN)).toBe(true)
      // The token is on stdin, never in the ssh argv: `run` checks that for every call.
      expect(world.fetchCalls.every(call => !('authorization' in call.headers))).toBe(true)
      expect(outcome.stdout).toContain('reached from the host over ssh')
    }
  })

  it('retries a proof while the gate reloads its file, then succeeds', async () => {
    const world = createWorld()
    world.forced.push(401, 401)
    const deps = makeDeps(world)
    const outcome = await add(world, 'systematic', ghOptions(), deps)
    expect(outcome.exit).toBeNull()
    expect(deps.slept.length).toBeGreaterThan(0)
  })

  it('every command uses one ssh session', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + voidLine(2)})
    await add(world, 'systematic', {...ghOptions(), replace: true}, makeDeps(world), [NEXT_TOKEN, OLD_A])
    expect(controlPaths(world.calls)).toHaveLength(1)
    expect(controlPaths(world.calls)[0]).toBeDefined()
    expect(world.closes).toHaveLength(1)
  })
})

describe('traces reader add: workstation delivery', () => {
  it('writes an exclusive 0600 file at the default path, outside any checkout, and prints no token', async () => {
    const world = createWorld()
    const deps = makeDeps(world)

    const outcome = await add(world, 'workstation', {}, deps)

    expect(outcome.exit).toBeNull()
    const path = defaultWorkstationFile(deps.homeDir ?? '', 'workstation')
    expect(path).toBe(join(deps.homeDir ?? '', '.config', 'infra', 'traces-reader-workstation.token'))
    expect(readFileSync(path, 'utf8')).toBe(NEXT_TOKEN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(statSync(join(deps.homeDir ?? '', '.config', 'infra')).mode & 0o777).toBe(0o700)
    expect(world.ghCalls()).toHaveLength(0)
    expect(outcome.stdout).toContain(path)
  })

  it('--file overrides the path', async () => {
    const world = createWorld()
    const deps = makeDeps(world)
    const path = join(deps.homeDir ?? '', 'elsewhere', 'token')
    await add(world, 'rollout-proof', {file: path}, deps)
    expect(readFileSync(path, 'utf8')).toBe(NEXT_TOKEN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('refuses before issuing anything when the file already exists, and never overwrites it', async () => {
    const world = createWorld()
    const deps = makeDeps(world)
    const path = defaultWorkstationFile(deps.homeDir ?? '', 'workstation')
    mkdirSync(join(deps.homeDir ?? '', '.config', 'infra'), {recursive: true})
    writeFileSync(path, 'precious', {mode: 0o600})

    const outcome = await add(world, 'workstation', {}, deps)

    expect(outcome.exit).toBe(1)
    expect(readFileSync(path, 'utf8')).toBe('precious')
    expect(deps.draws).toEqual([])
    expect(outcome.stderr).toContain('already exists')
    expect(world.calls.filter(call => call.command === READER_REMOTE.append)).toHaveLength(0)
  })

  it('--replace swaps the file by rename and keeps it 0600', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'workstation') + voidLine(2)})
    const deps = makeDeps(world)
    const path = defaultWorkstationFile(deps.homeDir ?? '', 'workstation')
    mkdirSync(join(deps.homeDir ?? '', '.config', 'infra'), {recursive: true})
    writeFileSync(path, OLD_A, {mode: 0o600})

    const outcome = await add(world, 'workstation', {replace: true}, deps, [NEXT_TOKEN, OLD_A])

    expect(outcome.exit).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe(NEXT_TOKEN)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(deps.homeDir ?? '', '.config', 'infra'))).toEqual(['traces-reader-workstation.token'])
    expect(world.accepts(OLD_A)).toBe(false)
  })

  it('refuses a file inside a git checkout', async () => {
    const world = createWorld()
    const deps = makeDeps(world)
    mkdirSync(join(deps.homeDir ?? '', '.git'))
    const outcome = await add(world, 'workstation', {}, deps)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('inside a git checkout')
    expect(world.calls).toHaveLength(0)
  })

  it('--print without a terminal is refused before anything is issued', async () => {
    const world = createWorld()
    const deps = makeDeps(world, {isTty: false})
    const outcome = await add(world, 'workstation', {print: true}, deps)
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('not a terminal')
    expect(deps.draws).toEqual([])
    expect(world.calls).toHaveLength(0)
  })

  it('--print on a terminal shows the token once on standard output and writes no file', async () => {
    const world = createWorld()
    const deps = makeDeps(world, {isTty: true})
    const outcome = await run(world, ctx => tracesReaderAddAction('workstation', {print: true}, ctx, deps), {
      secrets: [NEXT_TOKEN],
      printsOnStdout: true,
    })
    expect(outcome.exit).toBeNull()
    expect(outcome.stdout.split('\n')).toContain(NEXT_TOKEN)
    expect(existsSync(join(deps.homeDir ?? '', '.config'))).toBe(false)
  })

  it('refuses contradictory destinations before anything is issued', async () => {
    const cases: AddOptions[] = [
      {repo: ['a/b'], file: '/tmp/x'},
      {repo: ['a/b'], print: true},
      {print: true, file: '/tmp/x'},
      {secretName: 'X'},
      {repo: ['not a repo']},
      {repo: ['a/b'], secretName: 'lower'},
    ]
    for (const options of cases) {
      const world = createWorld()
      const outcome = await add(world, 'systematic', options, makeDeps(world, {isTty: true}))
      expect(outcome.exit).toBe(1)
      expect(world.calls).toHaveLength(0)
    }
  })
})

// ─── list ─────────────────────────────────────────────────────────────────────

describe('traces reader list', () => {
  it('prints consumers, fingerprints and dates, never token text or void lines', async () => {
    const world = createWorld({
      file:
        readerLine(OLD_A, 'systematic', '2026-10-01T00:00:00.000Z') + readerLine(OLD_B, 'fro-bot-audit') + voidLine(3),
    })
    const outcome = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {
      secrets: [OLD_A, OLD_B, OLD_C],
    })
    expect(outcome.exit).toBeNull()
    expect(outcome.stdout.split('\n')).toEqual([
      'fro-bot-audit',
      `  ${sha12(OLD_B)}  2026-10-01T00:00:00.000Z`,
      'systematic',
      `  ${sha12(OLD_A)}  2026-10-01T00:00:00.000Z`,
    ])
    expect(outcome.stdout).not.toContain('trc_')
    expect(world.calls).toHaveLength(1)
  })

  it('says so when there is no reader token', async () => {
    const world = createWorld()
    const outcome = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {secrets: []})
    expect(outcome.stdout).toBe('(no reader tokens)')
    expect(outcome.exit).toBeNull()
  })

  it('flags a consumer with more than one line', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + readerLine(OLD_B, 'systematic')})
    const outcome = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {secrets: [OLD_A, OLD_B]})
    expect(outcome.stdout).toContain('! systematic has 2 tokens')
    expect(outcome.stdout).toContain('infra traces reader revoke systematic <fingerprint>')
  })

  it('fails and counts the lines the gate would reject', async () => {
    const world = createWorld({
      file: `${readerLine(OLD_A, 'systematic')}garbage\n${OLD_B} 000000000000 x 2026-10-01T00:00:00.000Z\n`,
    })
    const outcome = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {secrets: [OLD_A, OLD_B]})
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('2 malformed lines')
  })

  it('fails when the host does not answer', async () => {
    const world = createWorld()
    world.failing.add('list')
    const outcome = await run(world, ctx => tracesReaderListAction({}, ctx, makeDeps(world)), {secrets: []})
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('could not be read')
  })
})

// ─── revoke ───────────────────────────────────────────────────────────────────

describe('traces reader revoke', () => {
  const twoConsumers = (): string =>
    readerLine(OLD_A, 'systematic') +
    readerLine(OLD_B, 'fro-bot-audit') +
    readerLine(OLD_C, 'workstation') +
    voidLine(2)

  it('revokes a consumer, proves 401 on both routes, and the other consumers still read', async () => {
    const world = createWorld({file: twoConsumers()})

    const outcome = await revoke(world, 'fro-bot-audit', undefined, {}, makeDeps(world))

    expect(outcome.exit).toBeNull()
    expect(world.accepts(OLD_B)).toBe(false)
    expect(world.accepts(OLD_A)).toBe(true)
    expect(world.accepts(OLD_C)).toBe(true)
    const proofs = world.fetchCalls.filter(call => call.headers.authorization === `Bearer ${OLD_B}`)
    expect(proofs.map(call => new URL(call.url).pathname)).toEqual([
      '/agent/langfuse/api/public/health',
      '/agent/grafana/mcp',
    ])
    expect(outcome.stdout).toContain('revoked')
    expect(outcome.stdout).toContain('answered 401')
  })

  it('removes both lines of a consumer with two and proves 401 for each', async () => {
    const world = createWorld({
      file: readerLine(OLD_A, 'systematic') + readerLine(OLD_B, 'systematic') + readerLine(OLD_C, 'workstation'),
    })
    const outcome = await revoke(world, 'systematic', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    expect(realLines(world.file())).toEqual([readerLine(OLD_C, 'workstation').trim()])
    for (const token of [OLD_A, OLD_B]) {
      expect(world.fetchCalls.filter(call => call.headers.authorization === `Bearer ${token}`)).toHaveLength(2)
    }
  })

  it('removes one line by fingerprint and leaves the consumer other token', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic') + readerLine(OLD_B, 'systematic')})
    const outcome = await revoke(world, 'systematic', sha12(OLD_A), {}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    expect(realLines(world.file())).toEqual([readerLine(OLD_B, 'systematic').trim()])
    expect(world.accepts(OLD_B)).toBe(true)
  })

  it('a fingerprint of another consumer matches nothing', async () => {
    const world = createWorld({file: twoConsumers()})
    const before = world.file()
    const outcome = await revoke(world, 'systematic', sha12(OLD_B), {}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('No reader token of systematic has fingerprint')
    expect(world.file()).toBe(before)
    expect(world.calls.filter(call => call.command === READER_REMOTE.remove)).toHaveLength(0)
  })

  it('an unknown consumer is an error that lists the consumers present and changes nothing', async () => {
    const world = createWorld({file: twoConsumers()})
    const before = world.file()
    const outcome = await revoke(world, 'nobody', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('Consumers present: ')
    expect(outcome.stderr).toContain('systematic')
    expect(world.file()).toBe(before)
  })

  it('revoking the last token leaves one void line', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic')})
    const outcome = await revoke(world, 'systematic', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    const lines = world.file().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^trc_void_[\w-]{43} void \S+$/)
    expect(outcome.stdout).toContain('No reader token remains')
  })

  it('fails loudly when a removed token is still accepted, and says what to do', async () => {
    const world = createWorld({file: twoConsumers()})
    world.stubborn.add(OLD_B)
    const outcome = await revoke(world, 'fro-bot-audit', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('still accepted')
    expect(outcome.stderr).toContain('infra traces reader revoke --all')
  })

  it('proves over ssh when the public route is not the gate, and fails when no proof can be had', async () => {
    const world = createWorld({file: twoConsumers(), publicRoute: 'down'})
    const outcome = await revoke(world, 'fro-bot-audit', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    expect(world.probeCalls()).toHaveLength(2)

    const unreachable = createWorld({file: twoConsumers(), publicRoute: 'down'})
    unreachable.forced.push('down', 'down', 'down')
    const failed = await revoke(unreachable, 'fro-bot-audit', undefined, {}, makeDeps(unreachable, {attempts: 3}))
    expect(failed.exit).toBe(1)
    expect(failed.stderr).toContain('refusal on the langfuse route could not be proven')
  })

  it('--all leaves exactly one void line, proves every token refused and says the copies remain', async () => {
    const world = createWorld({file: twoConsumers()})
    const outcome = await revoke(world, undefined, undefined, {all: true}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    const lines = world.file().split('\n').filter(Boolean)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/^trc_void_[\w-]{43} void \S+$/)
    for (const token of [OLD_A, OLD_B, OLD_C]) expect(world.accepts(token)).toBe(false)
    expect(outcome.stdout).toContain('Copies still exist')
    expect(outcome.stdout).toContain(`systematic: removed ${sha12(OLD_A)}`)
  })

  it('--all takes no consumer and no fingerprint', async () => {
    const world = createWorld({file: twoConsumers()})
    const outcome = await revoke(world, 'systematic', undefined, {all: true}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('--all takes no consumer')
    expect(world.calls.filter(call => call.command === READER_REMOTE.deny)).toHaveLength(0)
  })

  it('--all works on a malformed file: it is the way out', async () => {
    const world = createWorld({file: `${readerLine(OLD_A, 'systematic')}garbage\n`})
    const outcome = await revoke(world, undefined, undefined, {all: true}, makeDeps(world))
    expect(outcome.exit).toBeNull()
    expect(gateTokens(world.file())).toEqual(new Set())
  })

  it('names a consumer or --all, and rejects a bad fingerprint without echoing it', async () => {
    const world = createWorld({file: twoConsumers()})
    const none = await revoke(world, undefined, undefined, {}, makeDeps(world))
    expect(none.exit).toBe(1)
    expect(none.stderr).toContain('Name a consumer')
    const bad = await revoke(world, 'systematic', OLD_A, {}, makeDeps(world))
    expect(bad.exit).toBe(1)
    expect(bad.stderr).toContain('12 hexadecimal')
    expect(world.calls).toHaveLength(0)
  })

  it('reports a busy lock without claiming a revocation', async () => {
    const world = createWorld({file: twoConsumers()})
    world.busy.add('remove')
    const outcome = await revoke(world, 'systematic', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('lock is busy')
    expect(world.accepts(OLD_A)).toBe(true)
  })

  it('does not claim success when the host does not confirm the removal', async () => {
    const world = createWorld({file: twoConsumers()})
    world.dropReply.add('remove')
    const outcome = await revoke(world, 'systematic', undefined, {}, makeDeps(world))
    expect(outcome.exit).toBe(1)
    expect(outcome.stderr).toContain('did not confirm')
    expect(outcome.stdout).not.toContain('revoked')
  })

  it('uses one ssh session', async () => {
    const world = createWorld({file: twoConsumers()})
    await revoke(world, 'systematic', undefined, {}, makeDeps(world))
    expect(controlPaths(world.calls)).toHaveLength(1)
    expect(world.closes).toHaveLength(1)
  })
})

// ─── The remote scripts ───────────────────────────────────────────────────────

describe('remote command hygiene', () => {
  const commands = Object.entries(READER_REMOTE)

  it.each(commands)(
    '%s: fixed text, no null device, no eval, no backticks, deletion only of its own temp file',
    (_name, command) => {
      expect(command).not.toContain('/dev/')
      expect(command).not.toMatch(/(^|[\s;&|])[0-8]>/)
      expect(command).not.toContain('&>')
      expect(command).not.toContain('eval')
      expect(command).not.toContain('`')
      for (const match of command.matchAll(/\brm\b[^']*/g)) expect(match[0]).toBe('rm -f "$t"')
    },
  )

  it.each(commands)('%s: carries no token, fingerprint or generated value', (_name, command) => {
    expect(command.replaceAll(VOID_TOKEN_PREFIX, '').replaceAll('trc_*', '')).not.toMatch(/trc_[\w-]{4,}/)
    expect(command).not.toContain(NEXT_FINGERPRINT)
  })

  it('every writing command holds the reader lock across the whole of it and renames a temporary file', () => {
    for (const name of ['append', 'remove', 'deny'] as const) {
      const command = READER_REMOTE[name]
      const take = command.indexOf('flock -w 30 9')
      expect(command).toContain(`l=${TRACES_READER_LOCK}`)
      expect(command).toContain('exec 9>>"$l"')
      expect(take).toBeGreaterThan(0)
      expect(take).toBeLessThan(command.indexOf('mktemp'))
      expect(take).toBeLessThan(command.indexOf('mv -f "$t" "$f"'))
      expect(command).not.toContain('flock -u')
      expect(command).not.toContain('flock -n')
      expect(command).toContain(`flock -w 30 9 || { echo ${READER_LOCK_BUSY_SENTINEL}; exit 1; }`)
      expect(command).toContain('t=$(mktemp "$d/.token.XXXXXX")')
      expect(command).not.toContain('> "$f"')
      expect(command).not.toContain('>> "$f"')
      expect(command.endsWith(`echo ${readerSentinel(name)}`)).toBe(true)
    }
  })

  it('the read-only commands take no lock', () => {
    for (const name of ['list', 'lines'] as const) expect(READER_REMOTE[name]).not.toContain('flock')
  })

  it('every command names only the reader directory', () => {
    for (const name of ['list', 'lines', 'append', 'remove', 'deny'] as const) {
      const command = READER_REMOTE[name]
      expect(command).toContain(`d=${TRACES_READER_DIR}`)
      expect(command).not.toContain('/tokens')
    }
  })

  it('the probe takes the token on stdin and puts it in a curl config, never an argument', () => {
    const probe = READER_REMOTE.probe
    expect(probe).toContain('-K -')
    expect(probe).toContain(`printf 'header = "Authorization: Bearer %s"`)
    expect(probe).toContain('--resolve "$domain:443:127.0.0.1"')
    expect(probe).toContain('-q -s --noproxy')
    expect(probe).toContain('TRACES_READER_PROBE_STATUS=')
    expect(probe).not.toMatch(/Bearer \$tok|Bearer "\$tok"/)
  })
})

describe('constants match the app', async () => {
  const hostSource = await Bun.file(new URL('../../../../../apps/traces/src/host.ts', import.meta.url)).text()

  it('the reader directory, token file and lock are the ones apps/traces names', () => {
    expect(TRACES_READER_DIR).toBe(`${TRACES_APP_DIR}/readers`)
    expect(TRACES_READER_TOKEN_FILE).toBe(`${TRACES_READER_DIR}/token`)
    expect(TRACES_READER_LOCK).toBe(`${TRACES_READER_DIR}/.lock`)
    expect(READER_REMOTE.list).toContain(`d=${TRACES_READER_DIR}`)
    expect(READER_REMOTE.list).toContain('f="$d/token"')
    expect(hostSource).toMatch(/TRACES_READER_DIR\s*=\s*`\$\{TRACES_APP_DIR\}\/readers`/)
    expect(hostSource).toMatch(/TRACES_READER_TOKEN_FILE\s*=\s*`\$\{TRACES_READER_DIR\}\/token`/)
    expect(hostSource).toMatch(/TRACES_READER_LOCK\s*=\s*`\$\{TRACES_READER_DIR\}\/\.lock`/)
  })

  it('the consumer pattern is the one the contract names', () => {
    expect(CONSUMER_PATTERN.source).toBe('^[a-z][a-z0-9-]{0,30}$')
  })
})

describe('host scripts, run under a real sh', () => {
  const run1 = (world: World, command: string, stdin?: string) => execOnHost(world.dir, command, stdin)
  const stray = (world: World): string[] =>
    readdirSync(join(world.dir, 'readers')).filter(name => name !== 'token' && name !== '.lock')
  const removeInput = (name: string, selector = '-', vline = voidLine(200, CREATED)): string =>
    `${name} ${selector}\n${vline}`

  describe('classification and list', () => {
    it('lists reader lines with a computed fingerprint, hides void lines, counts malformed ones', () => {
      const world = createWorld({
        file: `${readerLine(OLD_A, 'systematic')}${voidLine(2)}\n${OLD_B} 000000000000 systematic 2026-10-01T00:00:00.000Z\nnot a line\n${OLD_C} ${sha12(OLD_C)} Bad 2026-10-01T00:00:00.000Z\n${OLD_C} ${sha12(OLD_C)} ok 2026-10-01\n`,
      })
      const result = run1(world, READER_REMOTE.list)
      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n').filter(line => line.startsWith('TRACES_READER '))).toEqual([
        `TRACES_READER ${sha12(OLD_A)} systematic 2026-10-01T00:00:00.000Z`,
      ])
      expect(result.stdout).toContain('TRACES_READER_BAD=4')
      expect(result.stdout).not.toContain(OLD_A)
      expect(result.stdout).toContain(readerSentinel('list'))
    })

    it('a file with five fields, a too-short token or a void line with a consumer column is malformed', () => {
      const lines = [
        `${OLD_A} ${sha12(OLD_A)} systematic 2026-10-01T00:00:00.000Z extra\n`,
        `trc_short ${sha12('trc_short')} systematic 2026-10-01T00:00:00.000Z\n`,
        `${voidLine(2).trim()} extra\n`,
        `${OLD_A} ${sha12(OLD_A)} ${'a'.repeat(32)} 2026-10-01T00:00:00.000Z\n`,
      ]
      for (const line of lines) {
        const world = createWorld({file: line})
        expect(run1(world, READER_REMOTE.list).stdout).toContain('TRACES_READER_BAD=1')
      }
    })

    it('lines prints the token text last, for the refusal proof only', () => {
      const world = createWorld({file: readerLine(OLD_A, 'systematic')})
      const result = run1(world, READER_REMOTE.lines)
      expect(result.stdout).toContain(`TRACES_READER ${sha12(OLD_A)} systematic 2026-10-01T00:00:00.000Z ${OLD_A}`)
    })

    it('a last line with no newline counts, and globbing never expands a line', () => {
      const world = createWorld({file: `${readerLine(OLD_A, 'systematic').trimEnd()}`})
      expect(run1(world, READER_REMOTE.list).stdout).toContain(`TRACES_READER ${sha12(OLD_A)} systematic`)
      writeFileSync(world.path, '* * * *\n')
      expect(run1(world, READER_REMOTE.list).stdout).toContain('TRACES_READER_BAD=1')
    })

    it('a missing file is empty, not an error', () => {
      const world = createWorld()
      rmSync(world.path)
      const result = run1(world, READER_REMOTE.list)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_READER_BAD=0')
    })

    it('fails, without the sentinel, when the directory is missing or the token file is a directory', () => {
      const world = createWorld()
      rmSync(world.path)
      mkdirSync(world.path)
      expect(run1(world, READER_REMOTE.list).stdout).not.toContain(readerSentinel('list'))
      rmSync(join(world.dir, 'readers'), {recursive: true})
      const missing = run1(world, READER_REMOTE.list)
      expect(missing.exitCode).not.toBe(0)
      expect(missing.stdout).not.toContain(readerSentinel('list'))
    })
  })

  describe('append', () => {
    const newLine = `${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic ${CREATED}\n`

    it('adds one line, keeps the existing bytes, replaces the file by rename and keeps its mode', () => {
      const world = createWorld({file: readerLine(OLD_A, 'a-one') + voidLine(2)})
      chmodSync(world.path, 0o640)
      const before = statSync(world.path)
      const existing = world.file()

      const result = run1(world, READER_REMOTE.append, newLine)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(readerSentinel('append'))
      expect(world.file()).toBe(existing + newLine)
      const after = statSync(world.path)
      expect(after.ino).not.toBe(before.ino)
      expect(after.mode & 0o777).toBe(0o640)
      expect(stray(world)).toEqual([])
    })

    it('starts a new line when the file does not end in a newline', () => {
      const world = createWorld({file: readerLine(OLD_A, 'a-one').trimEnd()})
      run1(world, READER_REMOTE.append, newLine)
      expect(world.file()).toBe(readerLine(OLD_A, 'a-one') + newLine)
    })

    it('creates the file when only the directory exists, readable by its group but not by others', () => {
      const world = createWorld()
      rmSync(world.path)
      const result = run1(world, READER_REMOTE.append, newLine)
      expect(result.exitCode).toBe(0)
      expect(world.file()).toBe(newLine)
      expect(statSync(world.path).mode & 0o777).toBe(0o640)
    })

    it('refuses a line the gate would reject, and touches nothing', () => {
      const world = createWorld()
      const before = world.file()
      const bad = [
        'trc_x fp consumer date\n',
        `${NEXT_TOKEN} 000000000000 systematic ${CREATED}\n`,
        `${NEXT_TOKEN} ${NEXT_FINGERPRINT} Systematic ${CREATED}\n`,
        `${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic ${CREATED} extra\n`,
        `${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic\n`,
        '\n',
        voidLine(3),
      ]
      for (const line of bad) {
        const result = run1(world, READER_REMOTE.append, line)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain(readerSentinel('append'))
        expect(world.file()).toBe(before)
      }
      expect(stray(world)).toEqual([])
    })

    it('leaves no temporary file behind when it fails', () => {
      const world = createWorld()
      rmSync(world.path)
      mkdirSync(world.path)
      const result = run1(world, READER_REMOTE.append, newLine)
      expect(result.exitCode).not.toBe(0)
      expect(stray(world)).toEqual([])
    })
  })

  describe('remove', () => {
    it('removes every line of the consumer, keeps every other line byte for byte, drops blank lines', () => {
      const keep = `${readerLine(OLD_A, 'other')}${voidLine(2)}`
      const world = createWorld({
        file: `\n${keep}\n${readerLine(OLD_B, 'systematic')}${readerLine(OLD_C, 'systematic')}`,
      })
      const before = statSync(world.path)

      const result = run1(world, READER_REMOTE.remove, removeInput('systematic'))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_READER_REMOVED=2')
      expect(result.stdout).toContain('TRACES_READER_REAL=1')
      expect(result.stdout).toContain('TRACES_READER_BAD=0')
      expect(result.stdout).toContain(readerSentinel('remove'))
      expect(world.file()).toBe(keep)
      expect(statSync(world.path).ino).not.toBe(before.ino)
      expect(statSync(world.path).mode & 0o777).toBe(0o640)
      expect(stray(world)).toEqual([])
    })

    it('with a fingerprint removes only that line of that consumer', () => {
      const world = createWorld({
        file: readerLine(OLD_A, 'systematic') + readerLine(OLD_B, 'systematic') + readerLine(OLD_C, 'other'),
      })
      const result = run1(world, READER_REMOTE.remove, removeInput('systematic', sha12(OLD_A)))
      expect(result.stdout).toContain('TRACES_READER_REMOVED=1')
      expect(world.file()).toBe(readerLine(OLD_B, 'systematic') + readerLine(OLD_C, 'other'))
      // The fingerprint of another consumer's token matches nothing under this name.
      const none = run1(world, READER_REMOTE.remove, removeInput('systematic', sha12(OLD_C)))
      expect(none.stdout).toContain('TRACES_READER_REMOVED=0')
      expect(world.file()).toBe(readerLine(OLD_B, 'systematic') + readerLine(OLD_C, 'other'))
    })

    it('writes the void line when no reader line is left, even when a malformed line was there', () => {
      const world = createWorld({file: `${readerLine(OLD_A, 'systematic')}garbage line\n`})
      const vline = voidLine(200, CREATED)
      const result = run1(world, READER_REMOTE.remove, removeInput('systematic', '-', vline))
      expect(result.stdout).toContain('TRACES_READER_REAL=0')
      expect(result.stdout).toContain('TRACES_READER_BAD=1')
      expect(world.file()).toBe(vline)
    })

    it('keeps a malformed line, and says so, while readers remain', () => {
      const world = createWorld({file: `${readerLine(OLD_A, 'systematic')}garbage line\n${readerLine(OLD_B, 'other')}`})
      const result = run1(world, READER_REMOTE.remove, removeInput('systematic'))
      expect(result.stdout).toContain('TRACES_READER_BAD=1')
      expect(world.file()).toBe(`garbage line\n${readerLine(OLD_B, 'other')}`)
    })

    it('refuses a bad consumer, selector or void line before touching anything', () => {
      const world = createWorld({file: readerLine(OLD_A, 'systematic')})
      const before = world.file()
      const bad = [
        removeInput('Systematic'),
        removeInput('../x'),
        removeInput('a b'),
        removeInput('systematic', 'xyz'),
        removeInput('systematic', 'ZZZZZZZZZZZZ'),
        `systematic -\nnot a void line\n`,
        `systematic -\n`,
        '',
      ]
      for (const input of bad) {
        const result = run1(world, READER_REMOTE.remove, input)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain(readerSentinel('remove'))
        expect(world.file()).toBe(before)
      }
      expect(stray(world)).toEqual([])
    })

    it('fails without the sentinel when the token file does not exist', () => {
      const world = createWorld()
      rmSync(world.path)
      const result = run1(world, READER_REMOTE.remove, removeInput('systematic'))
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain(readerSentinel('remove'))
    })
  })

  describe('deny', () => {
    it('replaces the file with the void line alone, keeping its mode', () => {
      const world = createWorld({file: readerLine(OLD_A, 'systematic')})
      const vline = voidLine(201, CREATED)
      const result = run1(world, READER_REMOTE.deny, vline)
      expect(result.exitCode).toBe(0)
      expect(world.file()).toBe(vline)
      expect(statSync(world.path).mode & 0o777).toBe(0o640)
      expect(stray(world)).toEqual([])
    })

    it('refuses anything that is not a void line', () => {
      const world = createWorld({file: readerLine(OLD_A, 'systematic')})
      const before = world.file()
      for (const input of ['', 'trc_void_short void 2026-10-01\n', readerLine(OLD_A, 'systematic')]) {
        expect(run1(world, READER_REMOTE.deny, input).exitCode).not.toBe(0)
        expect(world.file()).toBe(before)
      }
    })
  })

  it('a busy lock fails with its own sentinel and changes nothing', async () => {
    const world = createWorld({file: readerLine(OLD_A, 'systematic')})
    // The lock is held by another process for longer than a test would wait: model it with a 1-second flock.
    const command = READER_REMOTE.append.replace('flock -w 30 9', 'flock -w 1 9')
    const holder = Bun.spawn(
      ['sh', '-c', `exec 9>>"${join(world.dir, 'readers', '.lock')}"; flock -w 5 9 && echo held && exec sleep 4`],
      {
        env: {PATH: `${shimDir}:${process.env.PATH ?? ''}`},
        stdout: 'pipe',
      },
    )
    const reader = holder.stdout.getReader()
    const first = await reader.read()
    expect(new TextDecoder().decode(first.value)).toContain('held')
    const before = world.file()
    const result = execOnHost(world.dir, command, `${NEXT_TOKEN} ${NEXT_FINGERPRINT} systematic ${CREATED}\n`)
    holder.kill()
    expect(result.exitCode).not.toBe(0)
    expect(result.stdout).toContain(READER_LOCK_BUSY_SENTINEL)
    expect(world.file()).toBe(before)
  })
})

describe('the fixed token is the fixed fingerprint', () => {
  it('matches the CLI helper', () => {
    expect(fingerprintOf(NEXT_TOKEN)).toBe(NEXT_FINGERPRINT)
  })
})
