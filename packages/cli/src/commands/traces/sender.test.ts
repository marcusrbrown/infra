import {Buffer} from 'node:buffer'
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
import {dirname, join} from 'node:path'
import {afterAll, afterEach, beforeAll, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {
  controlPaths,
  recordingSpawn,
  type CloseBehaviour,
  type CloseCall,
  type Reply,
  type SpawnCall,
} from './__fixtures__/remote-fixture'
import {TRACES_APP_DIR, TRACES_GROUPS} from './host'
import {REMOTE_COMMANDS, type IngestState, type SpawnFn} from './remote'
import {
  DEFAULT_SECRET_NAME,
  fingerprintOf,
  formatTokenLine,
  formatVoidLine,
  generateToken,
  generateVoidToken,
  lockBusySentinel,
  SENDER_REMOTE,
  senderSentinel,
  TOKEN_PREFIX,
  TRACES_TOKENS_LOCK,
  tracesSenderAddAction,
  tracesSenderListAction,
  tracesSenderRevokeAction,
  VOID_TOKEN_PREFIX,
  type AddOptions,
  type RevokeOptions,
  type SenderDeps,
} from './sender'

type Group = (typeof TRACES_GROUPS)[number]

const ENV_KEYS = ['TRACES_HOST', 'TRACES_DOMAIN', 'TRACES_SSH_KEY', 'TRACES_OTHER'] as const
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
// The token commands are shell scripts. The fake host runs them under a real `sh` against a temporary
// directory standing in for the app directory, so atomic replace, mode preservation and single-line removal
// are proven by their effect on real files, not by looking at the script text. The collector is modelled
// from those same files: a token is accepted exactly when it is the first field of a line.

const ORIGIN = 'https://traces.example.invalid'
const CREATED = '2026-11-20T12:00:00.000Z'
const OLD_A = `trc_${'A'.repeat(43)}`
const OLD_B = `trc_${'B'.repeat(43)}`
const OLD_C = `trc_${'C'.repeat(43)}`

const sha12 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12)
const oldLine = (token: string, date = '2026-10-01T00:00:00.000Z'): string => `${token} ${sha12(token)} ${date}\n`

/** A void line like the ones a deny-all file holds. `seed` makes each one different. */
const voidLine = (seed: number, date = '2026-10-01T00:00:00.000Z'): string =>
  formatVoidLine(generateVoidToken(randomFilledWith(seed)), date)
const VOID_LINE_PATTERN = /^trc_void_[\w-]{43} void \S+\n$/

/** What `revoke` sends the host on stdin: the fingerprint, then the void line to use if no real token is left. */
const removeInput = (fingerprint: string, vline = voidLine(200, CREATED)): string => `${fingerprint}\n${vline}`

let sandbox = ''
let shimDir = ''

/**
 * The host has util-linux `flock`. macOS has none. Where it is missing, a shim over the system `perl` stands in:
 * it takes the same `flock -w SECONDS FD` call and takes a real, kernel-level `flock(2)` on the descriptor, so two
 * shells holding the same file really do exclude each other. The two concurrency cases are skipped only where
 * neither `flock` nor `perl` exists.
 */
const HAS_REAL_FLOCK = Bun.which('flock') !== null
const CAN_LOCK = HAS_REAL_FLOCK || Bun.which('perl') !== null
const FLOCK_SHIM = [
  '#!/usr/bin/perl',
  'use Fcntl qw(:flock);',
  'use Time::HiRes qw(time sleep);',
  'my ($wait, $fd) = (0, undef);',
  'while (@ARGV) { my $arg = shift @ARGV; if ($arg eq "-w") { $wait = shift @ARGV } else { $fd = $arg } }',
  'open(my $fh, ">&=", $fd) or exit 1;',
  'my $deadline = time + $wait;',
  'while (1) { if (flock($fh, LOCK_EX | LOCK_NB)) { exit 0 } if (time >= $deadline) { exit 1 } sleep(0.05) }',
  '',
].join('\n')

beforeAll(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'traces-sender-'))
  // The host has GNU `sha256sum`. Where the machine running the tests lacks it, a one-line shim stands in.
  shimDir = join(sandbox, 'shim')
  mkdirSync(shimDir)
  if (Bun.which('sha256sum') === null) {
    const shim = join(shimDir, 'sha256sum')
    writeFileSync(shim, '#!/bin/sh\nexec shasum -a 256 "$@"\n')
    chmodSync(shim, 0o755)
  }
  if (!HAS_REAL_FLOCK && CAN_LOCK) {
    const shim = join(shimDir, 'flock')
    writeFileSync(shim, FLOCK_SHIM)
    chmodSync(shim, 0o755)
  }
})

afterAll(() => {
  rmSync(sandbox, {recursive: true, force: true})
})

/** Run a remote script under a real `sh`, with the app directory standing in as `dir`. */
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

/** The same, without waiting: for a script a test holds paused while another one runs. */
function startOnHost(dir: string, command: string, stdin: string | undefined) {
  const child = Bun.spawn(['sh', '-c', command.replaceAll(TRACES_APP_DIR, dir)], {
    stdin: new TextEncoder().encode(stdin ?? ''),
    env: {PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: dir},
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    finished: async (): Promise<{exitCode: number; stdout: string; stderr: string}> => {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      return {exitCode, stdout, stderr}
    },
  }
}

async function until(condition: () => boolean, what: string): Promise<void> {
  for (let waited = 0; waited < 10_000; waited += 25) {
    if (condition()) return
    await Bun.sleep(25)
  }
  throw new Error(`timed out waiting for ${what}`)
}

interface WorldOptions {
  /** What the host's `.env` says. */
  configured?: IngestState
  /** What an outside request sees. Defaults to the configured state. `down` is no answer at all. */
  outside?: IngestState | 'down'
  /** Full token-file contents per group. */
  files?: Partial<Record<Group, string>>
  /** How the fake answers a close of the shared ssh connection. */
  closeBehaviour?: CloseBehaviour
}

interface FetchCall {
  url: string
  method: string | undefined
  headers: Record<string, string>
  body: unknown
}

interface World {
  dir: string
  spawn: SpawnFn
  calls: SpawnCall[]
  /** Closes of the shared ssh connection (`ssh -O exit`), kept apart from `calls`. */
  closes: CloseCall[]
  fetch: NonNullable<SenderDeps['fetch']>
  fetchCalls: FetchCall[]
  /** Tokens the modelled collector keeps accepting whatever the file says. */
  stubborn: Set<string>
  /** Answers for the next authenticated requests, consumed first. Used to script a reload delay or an outage. */
  forced: (number | 'down')[]
  /** Remote operations that fail, by name (`append`, `lines`, `list:<group>`). */
  failing: Set<string>
  /** Remote operations that run on the host and change it, but whose reply is lost (ssh drops after the work). */
  dropReply: Set<string>
  /** Remote operations that find the token lock held and change nothing. */
  busy: Set<string>
  gh: {exitCode: number; stderr: string; failOnCall?: number}
  file: (group: Group) => string
  path: (group: Group) => string
  seed: (group: Group, content: string) => void
  remoteCalls: (command: string) => SpawnCall[]
  ghCalls: () => SpawnCall[]
}

let worldCounter = 0

function createWorld(options: WorldOptions = {}): World {
  worldCounter += 1
  const dir = join(sandbox, `app-${worldCounter}`)
  for (const group of TRACES_GROUPS) mkdirSync(join(dir, 'tokens', group), {recursive: true})
  const configured = options.configured ?? 'held'
  const outside = options.outside ?? configured

  const path = (group: Group): string => join(dir, 'tokens', group, 'token')
  const file = (group: Group): string => readFileSync(path(group), 'utf8')

  // The collector's credential watcher, as measured against the pinned build: it takes each new file it reads, but
  // an EMPTY file is rejected and the previous credentials stay in force. So what it accepts is the last non-empty
  // content the file had, not what the file says now. A test that empties a file to revoke sees the token still accepted.
  const watched = new Map<Group, string>()
  const reload = (group: Group): void => {
    const content = file(group)
    if (content.trim() !== '') watched.set(group, content)
  }

  const seed = (group: Group, content: string): void => {
    writeFileSync(path(group), content)
    chmodSync(path(group), 0o640)
    reload(group)
  }
  // A file nothing has written yet is empty. Deploy creates real files as deny-all; the empty default keeps the
  // scenarios that start from "no token yet" short, and `add`, `list` and `revoke` all cope with it.
  for (const group of TRACES_GROUPS) seed(group, options.files?.[group] ?? '')

  const stubborn = new Set<string>()
  const forced: (number | 'down')[] = []
  const failing = new Set<string>()
  const dropReply = new Set<string>()
  const busy = new Set<string>()
  const gh = {exitCode: 0, stderr: '', failOnCall: undefined as number | undefined}
  let ghCount = 0

  const accepts = (group: Group, token: string): boolean => {
    if (stubborn.has(token)) return true
    reload(group)
    return (watched.get(group) ?? '')
      .split('\n')
      .some(line => line.trim().split(/\s+/)[0] === token && token.length > 0)
  }

  const nextForced = (): number | 'down' | undefined => forced.shift()

  const runShell = (command: string, stdin: string | undefined): Reply => {
    const result = execOnHost(dir, command, stdin)
    for (const group of TRACES_GROUPS) reload(group)
    return {stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode}
  }

  const route = (call: SpawnCall): Reply => {
    if (call.argv[0] === 'gh') {
      ghCount += 1
      const failing = gh.failOnCall === undefined ? gh.exitCode !== 0 : gh.failOnCall === ghCount
      return failing ? {exitCode: gh.exitCode || 1, stderr: gh.stderr} : {exitCode: 0}
    }
    if (call.command === REMOTE_COMMANDS.readIngestState) return {stdout: `TRACES_INGEST_STATE=${configured}\n`}
    for (const group of TRACES_GROUPS) {
      if (call.command === SENDER_REMOTE.probe(group)) {
        const forcedStatus = nextForced()
        if (forcedStatus === 'down') return {exitCode: 1, stderr: 'connect refused'}
        const token = (call.stdin ?? '').trim()
        const status = forcedStatus ?? (accepts(group, token) ? 200 : 401)
        return {stdout: `TRACES_PROBE_STATUS=${status}\n`}
      }
      if (call.command === SENDER_REMOTE.list(group) && failing.has(`list:${group}`)) {
        return {exitCode: 255, stderr: 'ssh: connection reset'}
      }
      for (const name of ['list', 'lines', 'append', 'remove', 'deny'] as const) {
        if (call.command === SENDER_REMOTE[name](group)) {
          if (failing.has(name)) return {exitCode: 1, stderr: `${name} failed on the host`}
          if (busy.has(name)) return {exitCode: 1, stdout: `${lockBusySentinel(group)}\n`}
          const reply = runShell(call.command, call.stdin)
          if (dropReply.has(name)) return {exitCode: 255, stderr: 'ssh: connection reset by peer'}
          return reply
        }
      }
    }
    throw new Error(`unexpected remote command: ${call.command}`)
  }

  const {spawn, calls, closes} = recordingSpawn(route, options.closeBehaviour)
  const fetchCalls: FetchCall[] = []

  const world: World = {
    dir,
    spawn,
    calls,
    closes,
    fetch: async (url, init) => {
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>))
      fetchCalls.push({url, method: init?.method, headers, body: init?.body})
      if (outside === 'down') throw new TypeError('connect failed')
      if (outside === 'off') return new Response('', {status: 404})
      if (outside === 'held') return new Response('', {status: 503})
      const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1]
      const forcedStatus = authorization === undefined ? undefined : nextForced()
      if (forcedStatus === 'down') throw new TypeError('connect failed')
      if (forcedStatus !== undefined) return new Response('', {status: forcedStatus})
      const group = TRACES_GROUPS.find(candidate => url.endsWith(`/${candidate}/v1/traces`))
      const token = authorization?.replace(/^Bearer /, '') ?? ''
      return new Response('', {status: group !== undefined && token !== '' && accepts(group, token) ? 200 : 401})
    },
    fetchCalls,
    stubborn,
    forced,
    failing,
    dropReply,
    busy,
    gh,
    file,
    path,
    seed,
    remoteCalls: command => calls.filter(call => call.command === command),
    ghCalls: () => calls.filter(call => call.argv[0] === 'gh'),
  }
  return world
}

// ─── Running an action, and the rule that no token leaks ──────────────────────

function randomFilledWith(byte: number): (length: number) => Uint8Array {
  return length => new Uint8Array(length).fill(byte)
}

function makeDeps(world: World, extra: Partial<SenderDeps> = {}): SenderDeps & {slept: number[]} {
  const slept: number[] = []
  return {
    spawn: world.spawn,
    fetch: world.fetch,
    sleep: async ms => {
      slept.push(ms)
    },
    attempts: 3,
    intervalMs: 5,
    randomBytes: randomFilledWith(7),
    now: () => new Date(CREATED),
    isTty: false,
    ...extra,
    slept,
  }
}

/** The token the next `add` generates with the default fixed random source. */
const NEXT_TOKEN = generateToken(randomFilledWith(7)).token
const NEXT_FINGERPRINT = fingerprintOf(NEXT_TOKEN)

/** The void token a `revoke` generates with the default fixed random source, and the line it sends. */
const DEFAULT_VOID_TOKEN = generateVoidToken(randomFilledWith(7))
const DEFAULT_VOID_LINE = formatVoidLine(DEFAULT_VOID_TOKEN, CREATED)

interface Outcome {
  stdout: string
  stderr: string
  exit: number | null
}

interface RunOptions {
  /** Token text no ssh argument, environment, standard output or standard error may contain. */
  secrets: string[]
  /** The one scenario that prints a token on purpose: workstation on a terminal. Standard output is not scanned. */
  printsOn?: 'stdout'
}

/**
 * Run an action with a captured console, then check the rule every scenario shares: none of the token text
 * appears in any ssh or gh argument, any child environment, or any line written to the console. A token may
 * travel on stdin (that is how it reaches the host and `gh`) and in the Authorization header of the proof.
 */
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
    if (options.printsOn !== 'stdout') expect(stdout).not.toContain(secret)
  }
  return {stdout, stderr, exit: captured.exit?.code ?? null}
}

const noOptions: AddOptions = {}
const github = (repo = 'marcusrbrown/example'): AddOptions => ({repo: [repo]})

// ─── Tokens ───────────────────────────────────────────────────────────────────

describe('token and fingerprint', () => {
  it('is the prefix plus 32 random bytes in URL-safe base64 without padding', () => {
    const bytes = new Uint8Array(32).map((_, index) => index * 8 + 1)
    const {token} = generateToken(() => bytes)
    expect(token).toBe(`${TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`)
    expect(token).toMatch(/^trc_[\w-]{43}$/)
  })

  it('asks the random source for exactly 32 bytes and refuses a short answer', () => {
    const asked: number[] = []
    generateToken(length => {
      asked.push(length)
      return new Uint8Array(length)
    })
    expect(asked).toEqual([32])
    expect(() => generateToken(() => new Uint8Array(8))).toThrow('32 bytes')
  })

  it('draws from the platform CSPRNG by default, so two tokens differ', () => {
    const first = generateToken()
    const second = generateToken()
    expect(first.token).not.toBe(second.token)
    expect(first.token).toMatch(/^trc_[\w-]{43}$/)
  })

  it('the fingerprint is the first 12 hex characters of the SHA-256 of the token', () => {
    const {token, fingerprint} = generateToken(randomFilledWith(7))
    expect(fingerprint).toBe(createHash('sha256').update(token).digest('hex').slice(0, 12))
    expect(fingerprint).toMatch(/^[0-9a-f]{12}$/)
    expect(fingerprintOf(token)).toBe(fingerprint)
  })

  it('formats a file line as token, fingerprint and date, with the token first', () => {
    const line = formatTokenLine('trc_x', 'abcdef012345', CREATED)
    expect(line).toBe(`trc_x abcdef012345 ${CREATED}\n`)
    expect(line.split(' ')[0]).toBe('trc_x')
  })

  it('a void token is the void prefix plus 32 random bytes in URL-safe base64, from the same CSPRNG source', () => {
    const asked: number[] = []
    const bytes = new Uint8Array(32).map((_, index) => index * 7 + 3)
    const token = generateVoidToken(length => {
      asked.push(length)
      return bytes
    })
    expect(asked).toEqual([32])
    expect(token).toBe(`${VOID_TOKEN_PREFIX}${Buffer.from(bytes).toString('base64url')}`)
    expect(token).toMatch(/^trc_void_[\w-]{43}$/)
    expect(() => generateVoidToken(() => new Uint8Array(8))).toThrow('32 bytes')
    expect(generateVoidToken()).not.toBe(generateVoidToken())
  })

  it('a void line is the void token, the word void and the date: nothing a person would mistake for a credential', () => {
    const line = formatVoidLine('trc_void_x', CREATED)
    expect(line).toBe(`trc_void_x void ${CREATED}\n`)
    expect(line.split(' ')[0]).toBe('trc_void_x')
  })

  it('a real token never starts with the void prefix, so it is never taken for a void line', () => {
    // 'void_' in URL-safe base64 is the first 3.75 bytes: such a draw would hide a live token from `list` and `revoke`.
    const colliding = Buffer.from(`void_${'A'.repeat(38)}`, 'base64url')
    expect(colliding).toHaveLength(32)
    let draws = 0
    const {token} = generateToken(length => {
      draws += 1
      return draws === 1 ? new Uint8Array(colliding) : new Uint8Array(length).fill(9)
    })
    expect(draws).toBe(2)
    expect(token.startsWith(VOID_TOKEN_PREFIX)).toBe(false)
    // A source stuck on such a draw is an error, not a loop.
    expect(() => generateToken(() => new Uint8Array(colliding))).toThrow('void prefix')
  })
})

// ─── The remote scripts ───────────────────────────────────────────────────────

describe('remote command hygiene', () => {
  const commands = TRACES_GROUPS.flatMap(group =>
    (['list', 'lines', 'append', 'remove', 'deny', 'probe'] as const).map(
      name => [`${name} ${group}`, SENDER_REMOTE[name](group)] as const,
    ),
  )

  it.each(commands)(
    '%s: fixed text, no null device, no eval, no backticks, deletion only of its own temp file',
    (_name, command) => {
      expect(command).not.toContain('/dev/')
      expect(command).not.toMatch(/\d?>&?\s*\/dev/)
      // Standard output and error are never redirected. Descriptor 9 is the lock and is the only other one.
      expect(command).not.toMatch(/(^|[\s;&|])[0-8]>/)
      expect(command).not.toContain('&>')
      expect(command).not.toContain('eval')
      expect(command).not.toContain('`')
      expect(command).not.toContain('$@')
      for (const match of command.matchAll(/\brm\b[^']*/g)) expect(match[0]).toBe('rm -f "$t"')
    },
  )

  it.each(commands)('%s: never carries a token marker or any generated value', (_name, command) => {
    // The void prefix is the one token marker a host script may name: it has to tell void lines from real ones.
    expect(command.replaceAll(VOID_TOKEN_PREFIX, '')).not.toContain(TOKEN_PREFIX)
    expect(command).not.toContain(NEXT_FINGERPRINT)
    expect(command).not.toMatch(/trc_void_[\w-]{20,}/)
  })

  it('every command is built from the group alone and names only that group directory under the app directory', () => {
    for (const group of TRACES_GROUPS) {
      for (const name of ['list', 'lines', 'append', 'remove', 'deny'] as const) {
        const command = SENDER_REMOTE[name](group)
        expect(command).toContain(`d=${TRACES_APP_DIR}/tokens/${group}`)
        for (const other of TRACES_GROUPS.filter(candidate => candidate !== group)) {
          expect(command).not.toContain(`/tokens/${other}`)
        }
        expect(command.endsWith(`echo ${senderSentinel(name, group)}`)).toBe(true)
      }
    }
  })

  it('refuses a group that is not one of the three, in every builder', () => {
    for (const name of ['list', 'lines', 'append', 'remove', 'deny', 'probe'] as const) {
      expect(() => SENDER_REMOTE[name]('../../etc')).toThrow('not a sender group')
      expect(() => SENDER_REMOTE[name]('a; id')).toThrow('not a sender group')
    }
  })

  it('every command that reads a token file and replaces it holds the token lock across the whole of it', () => {
    for (const group of TRACES_GROUPS) {
      for (const name of ['append', 'remove', 'deny'] as const) {
        const command = SENDER_REMOTE[name](group)
        const lock = command.indexOf(`l=${TRACES_TOKENS_LOCK}`)
        const take = command.indexOf('flock -w 30 9')
        // `mktemp` comes before the first copy of the file in every one of them.
        const copy = command.indexOf('mktemp')
        const rename = command.indexOf('mv -f "$t" "$f"')
        expect(lock).toBeGreaterThanOrEqual(0)
        expect(command).toContain('exec 9>>"$l"')
        expect(take).toBeGreaterThan(lock)
        // Taken before the first read or copy of the file, held until after the rename, never released early.
        expect(take).toBeLessThan(copy)
        expect(take).toBeLessThan(rename)
        expect(command).not.toContain('flock -u')
        expect(command).not.toContain('flock -n')
        // A lock that cannot be taken is its own failure, never a silent skip.
        expect(command).toContain(`flock -w 30 9 || { echo ${lockBusySentinel(group)}; exit 1; }`)
      }
    }
  })

  it('the read-only commands take no lock: a rename is atomic, so a read sees a whole file', () => {
    for (const group of TRACES_GROUPS) {
      for (const name of ['list', 'lines'] as const) expect(SENDER_REMOTE[name](group)).not.toContain('flock')
    }
  })

  it('every writing command writes a temporary file in the token directory and renames it over the token file', () => {
    for (const group of TRACES_GROUPS) {
      for (const name of ['append', 'remove', 'deny'] as const) {
        const command = SENDER_REMOTE[name](group)
        expect(command).toContain('t=$(mktemp "$d/.token.XXXXXX")')
        expect(command).toContain('mv -f "$t" "$f"')
        // Nothing is ever written to the live file directly.
        expect(command).not.toContain('> "$f"')
        expect(command).not.toContain('>> "$f"')
      }
    }
  })
})

describe('constants match the app', async () => {
  const hostSource = await Bun.file(new URL('../../../../../apps/traces/src/host.ts', import.meta.url)).text()
  const collectorSource = await Bun.file(
    new URL('../../../../../apps/traces/config/otelcol.yaml', import.meta.url),
  ).text()

  it('the token directories are the ones apps/traces lays out', () => {
    expect(hostSource).toContain(['TRACES_TOKEN_ROOT = `$', '{TRACES_APP_DIR}/tokens`'].join(''))
    expect(hostSource).toContain(['`$', '{TRACES_TOKEN_ROOT}/$', '{group}`'].join(''))
    for (const group of TRACES_GROUPS) {
      expect(SENDER_REMOTE.list(group)).toContain(`d=${TRACES_APP_DIR}/tokens/${group}`)
    }
  })

  it('the void token prefix is the one apps/traces names, and a real token prefix is not a void one', () => {
    expect(VOID_TOKEN_PREFIX).toBe('trc_void_')
    expect(hostSource).toContain(`TRACES_VOID_TOKEN_PREFIX = '${VOID_TOKEN_PREFIX}'`)
    // The void prefix extends the real one, which is why the real generator must avoid it.
    expect(VOID_TOKEN_PREFIX.startsWith(TOKEN_PREFIX)).toBe(true)
    for (const group of TRACES_GROUPS) expect(SENDER_REMOTE.list(group)).toContain(VOID_TOKEN_PREFIX)
  })

  it('the token lock is the file apps/traces names, under the token directory', () => {
    expect(TRACES_TOKENS_LOCK).toBe(`${TRACES_APP_DIR}/tokens/.lock`)
    const line = /TRACES_TOKENS_LOCK\s*=\s*(.+)/.exec(hostSource)?.[1] ?? ''
    // The same path however host.ts spells it: from the app directory, from the token root, or in full.
    expect(line).toMatch(
      /^(`\$\{TRACES_APP_DIR\}\/tokens\/\.lock`|`\$\{TRACES_TOKEN_ROOT\}\/\.lock`|'\/mnt\/traces\/app\/tokens\/\.lock')/,
    )
    expect(hostSource).toContain(['TRACES_TOKEN_ROOT = `$', '{TRACES_APP_DIR}/tokens`'].join(''))
  })

  it('the private probe reaches each group receiver on its port and path', () => {
    const config = Bun.YAML.parse(collectorSource) as {
      receivers: Record<string, {protocols: {http: {endpoint: string; traces_url_path: string}}}>
    }
    for (const group of TRACES_GROUPS) {
      const http = config.receivers[`otlp/${group}`]?.protocols.http
      expect(http).toBeDefined()
      const port = /:(\d+)$/.exec(http?.endpoint ?? '')?.[1]
      const probe = SENDER_REMOTE.probe(group)
      expect(probe).toContain(`http://collector:${port}${http?.traces_url_path}`)
      expect(probe).toContain('health-reporter')
    }
  })

  it('the probe takes the token on stdin and prints a recognised status line', () => {
    const probe = SENDER_REMOTE.probe('fro-bot')
    expect(probe).toContain('exec -T health-reporter')
    expect(probe).toContain('Bun.stdin.text()')
    expect(probe).toContain('TRACES_PROBE_STATUS=')
    expect(probe).not.toContain(TOKEN_PREFIX)
  })
})

// The collector keeps no state besides these files, so every property below is a property of the file.
describe('host scripts, run under a real sh', () => {
  const run1 = (world: World, command: string, stdin?: string) => execOnHost(world.dir, command, stdin)

  const tempFiles = (world: World, group: Group): string[] =>
    readdirSync(join(world.dir, 'tokens', group)).filter(name => name !== 'token')

  describe('append', () => {
    it('adds one line, keeps the existing bytes, replaces the file by rename and keeps its mode', () => {
      const world = createWorld({files: {'fro-bot': oldLine(OLD_A) + oldLine(OLD_B)}})
      chmodSync(world.path('fro-bot'), 0o640)
      const before = statSync(world.path('fro-bot'))
      const newLine = formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED)

      const result = run1(world, SENDER_REMOTE.append('fro-bot'), newLine)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(senderSentinel('append', 'fro-bot'))
      expect(world.file('fro-bot')).toBe(oldLine(OLD_A) + oldLine(OLD_B) + newLine)
      const after = statSync(world.path('fro-bot'))
      // A rename gives a new inode; an in-place edit would keep this one.
      expect(after.ino).not.toBe(before.ino)
      expect(after.mode & 0o777).toBe(0o640)
      expect(tempFiles(world, 'fro-bot')).toEqual([])
      for (const other of ['marcusrbrown', 'workstation'] as const) expect(world.file(other)).toBe('')
    })

    it('starts a new line when the file does not end in a newline', () => {
      const world = createWorld({files: {workstation: oldLine(OLD_A).trimEnd()}})
      run1(world, SENDER_REMOTE.append('workstation'), 'trc_new fp date\n')
      expect(world.file('workstation')).toBe(`${oldLine(OLD_A)}trc_new fp date\n`)
    })

    it('adds to a deny-all file and keeps its void line, which is harmless', () => {
      const deny = voidLine(5)
      const world = createWorld({files: {'fro-bot': deny}})
      const newLine = formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED)
      const result = run1(world, SENDER_REMOTE.append('fro-bot'), newLine)
      expect(result.exitCode).toBe(0)
      expect(world.file('fro-bot')).toBe(deny + newLine)
    })

    it('creates the file when only the directory exists, readable by its group but not by others', () => {
      const world = createWorld()
      rmSync(world.path('marcusrbrown'))
      const result = run1(world, SENDER_REMOTE.append('marcusrbrown'), 'trc_new fp date\n')
      expect(result.exitCode).toBe(0)
      expect(world.file('marcusrbrown')).toBe('trc_new fp date\n')
      expect(statSync(world.path('marcusrbrown')).mode & 0o777).toBe(0o640)
    })

    it('fails, without the sentinel, when the group directory is missing', () => {
      const world = createWorld()
      rmSync(join(world.dir, 'tokens', 'workstation'), {recursive: true})
      const result = run1(world, SENDER_REMOTE.append('workstation'), 'trc_new fp date\n')
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain(senderSentinel('append', 'workstation'))
      expect(existsSync(join(world.dir, 'tokens', 'workstation'))).toBe(false)
    })

    it('leaves no temporary file behind when it fails', () => {
      const world = createWorld()
      rmSync(world.path('fro-bot'))
      mkdirSync(world.path('fro-bot'))
      const result = run1(world, SENDER_REMOTE.append('fro-bot'), 'trc_new fp date\n')
      expect(result.exitCode).not.toBe(0)
      expect(tempFiles(world, 'fro-bot')).toEqual([])
    })
  })

  describe('remove', () => {
    it('removes exactly the line whose token has the fingerprint, keeps every other line byte for byte', () => {
      const lines = oldLine(OLD_A) + oldLine(OLD_B) + oldLine(OLD_C)
      const world = createWorld({files: {marcusrbrown: lines}})
      const before = statSync(world.path('marcusrbrown'))

      const result = run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_B)))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=1')
      expect(result.stdout).toContain('TRACES_TOKENS_REAL=2')
      expect(result.stdout).toContain(senderSentinel('remove', 'marcusrbrown'))
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_C))
      expect(statSync(world.path('marcusrbrown')).ino).not.toBe(before.ino)
      expect(statSync(world.path('marcusrbrown')).mode & 0o777).toBe(0o640)
      expect(tempFiles(world, 'marcusrbrown')).toEqual([])
    })

    it('matches on the token, not on the fingerprint column a hand-edit may have got wrong', () => {
      const world = createWorld({files: {marcusrbrown: `${OLD_A} 000000000000 2026-10-01\n${oldLine(OLD_B)}`}})
      const result = run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_A)))
      expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=1')
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_B))
    })

    it('keeps a line that has only a token, and drops blank lines', () => {
      const world = createWorld({files: {marcusrbrown: `\n${OLD_A}\n\n${oldLine(OLD_B)}`}})
      run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_B)))
      expect(world.file('marcusrbrown')).toBe(`${OLD_A}\n`)
    })

    it('removes both lines when the same token appears twice, and says so', () => {
      const world = createWorld({files: {marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B) + oldLine(OLD_A)}})
      const result = run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_A)))
      expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=2')
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_B))
    })

    it('removes nothing, and says 0, for a fingerprint that matches no line', () => {
      const world = createWorld({files: {marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B)}})
      const result = run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput('ffffffffffff'))
      expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=0')
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_B))
    })

    it('refuses a fingerprint that is not 12 characters, so a prefix never matches', () => {
      const world = createWorld({files: {marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B)}})
      const result = run1(world, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_A).slice(0, 4)))
      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).not.toContain('TRACES_TOKEN_REMOVED')
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_B))
    })

    describe('the last real token', () => {
      it('leaves exactly one void line, the one on stdin, and nothing else: never an empty file', () => {
        const world = createWorld({files: {workstation: oldLine(OLD_A)}})
        const before = statSync(world.path('workstation'))
        const vline = voidLine(31, CREATED)

        const result = run1(world, SENDER_REMOTE.remove('workstation'), removeInput(sha12(OLD_A), vline))

        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=1')
        expect(result.stdout).toContain('TRACES_TOKENS_REAL=0')
        expect(result.stdout).toContain(senderSentinel('remove', 'workstation'))
        expect(world.file('workstation')).toBe(vline)
        expect(world.file('workstation')).toMatch(VOID_LINE_PATTERN)
        expect(world.file('workstation')).not.toContain(OLD_A)
        // Written and renamed like every other change, so the collector sees a whole file and re-reads it.
        expect(statSync(world.path('workstation')).ino).not.toBe(before.ino)
        expect(statSync(world.path('workstation')).mode & 0o777).toBe(0o640)
        expect(tempFiles(world, 'workstation')).toEqual([])
      })

      it('keeps an older void line while a real token is left, and drops it for the new one only when none is', () => {
        const oldVoid = voidLine(5)
        const world = createWorld({files: {workstation: oldVoid + oldLine(OLD_A) + oldLine(OLD_B)}})
        const vline = voidLine(31, CREATED)
        run1(world, SENDER_REMOTE.remove('workstation'), removeInput(sha12(OLD_A), vline))
        // B is still there, so the file keeps its lines and the older void line stays; A goes.
        expect(world.file('workstation')).toBe(oldVoid + oldLine(OLD_B))
        const last = run1(world, SENDER_REMOTE.remove('workstation'), removeInput(sha12(OLD_B), vline))
        expect(last.stdout).toContain('TRACES_TOKENS_REAL=0')
        expect(world.file('workstation')).toBe(vline)
      })

      it('does not count a void line as a token to remove, and never lets a fingerprint empty a file through one', () => {
        const oldVoid = voidLine(5)
        const oldVoidToken = oldVoid.split(' ')[0] ?? ''
        const world = createWorld({files: {workstation: oldVoid}})
        const result = run1(world, SENDER_REMOTE.remove('workstation'), removeInput(sha12(oldVoidToken)))
        expect(result.exitCode).toBe(0)
        expect(result.stdout).toContain('TRACES_TOKEN_REMOVED=0')
        expect(world.file('workstation')).not.toBe('')
        expect(world.file('workstation')).toMatch(VOID_LINE_PATTERN)
      })

      it('fails, changing nothing, when stdin carries no valid void line', () => {
        for (const bad of ['', 'trc_notvoid_x void d\n', 'plain text\n', 'trc_void_x\n', 'trc_void_short void d\n']) {
          const world = createWorld({files: {workstation: oldLine(OLD_A)}})
          const result = run1(world, SENDER_REMOTE.remove('workstation'), `${sha12(OLD_A)}\n${bad}`)
          expect(result.exitCode).not.toBe(0)
          expect(result.stdout).not.toContain(senderSentinel('remove', 'workstation'))
          expect(world.file('workstation')).toBe(oldLine(OLD_A))
          expect(tempFiles(world, 'workstation')).toEqual([])
        }
      })
    })
  })

  describe('deny', () => {
    it('leaves exactly the void line on stdin, by rename, with the same mode: never an empty file', () => {
      const world = createWorld({files: {workstation: oldLine(OLD_A) + oldLine(OLD_B) + voidLine(5)}})
      const before = statSync(world.path('workstation'))
      const vline = voidLine(31, CREATED)
      const result = run1(world, SENDER_REMOTE.deny('workstation'), vline)
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(senderSentinel('deny', 'workstation'))
      expect(world.file('workstation')).toBe(vline)
      expect(world.file('workstation')).toMatch(VOID_LINE_PATTERN)
      expect(statSync(world.path('workstation')).ino).not.toBe(before.ino)
      expect(statSync(world.path('workstation')).mode & 0o777).toBe(0o640)
      expect(tempFiles(world, 'workstation')).toEqual([])
    })

    it('writes the file when it is empty or missing, so a group that has no real token ends up deny-all too', () => {
      const vline = voidLine(31, CREATED)
      const emptyWorld = createWorld()
      expect(run1(emptyWorld, SENDER_REMOTE.deny('fro-bot'), vline).exitCode).toBe(0)
      expect(emptyWorld.file('fro-bot')).toBe(vline)

      const missingWorld = createWorld()
      rmSync(missingWorld.path('fro-bot'))
      expect(run1(missingWorld, SENDER_REMOTE.deny('fro-bot'), vline).exitCode).toBe(0)
      expect(missingWorld.file('fro-bot')).toBe(vline)
      expect(statSync(missingWorld.path('fro-bot')).mode & 0o777).toBe(0o640)
    })

    it('fails, changing nothing, when stdin carries no valid void line', () => {
      for (const bad of ['', 'trc_notvoid_x void d\n', 'plain text\n', 'trc_void_short void d\n']) {
        const world = createWorld({files: {workstation: oldLine(OLD_A)}})
        const result = run1(world, SENDER_REMOTE.deny('workstation'), bad)
        expect(result.exitCode).not.toBe(0)
        expect(result.stdout).not.toContain(senderSentinel('deny', 'workstation'))
        expect(world.file('workstation')).toBe(oldLine(OLD_A))
      }
    })
  })

  describe('the token lock', () => {
    const NEW_LINE = formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED)

    /** The append, held between its copy and its rename until the test creates `go`. */
    const pausedAppend = (world: World) => {
      const paused = join(world.dir, 'paused')
      const go = join(world.dir, 'go')
      const command = SENDER_REMOTE.append('marcusrbrown').replace(
        'mv -f "$t" "$f"',
        `: > ${paused}; while [ ! -e ${go} ]; do sleep 0.05; done; mv -f "$t" "$f"`,
      )
      expect(command).toContain(paused)
      return {
        started: () => startOnHost(world.dir, command, NEW_LINE),
        waitUntilPaused: () => until(() => existsSync(paused), 'the append to reach its rename'),
        release: () => writeFileSync(go, ''),
      }
    }

    it.skipIf(!CAN_LOCK)(
      'a revoke that runs while an append sits between its copy and its rename is not undone by it',
      async () => {
        const world = createWorld({files: {marcusrbrown: oldLine(OLD_A)}})
        const append = pausedAppend(world)
        const running = append.started()
        await append.waitUntilPaused()

        // The revoke starts now, while the append holds a copy that still has the token in it.
        const revoking = startOnHost(world.dir, SENDER_REMOTE.remove('marcusrbrown'), removeInput(sha12(OLD_A)))
        await Bun.sleep(300)
        append.release()
        const [appended, revoked] = await Promise.all([running.finished(), revoking.finished()])

        expect(appended.exitCode).toBe(0)
        expect(appended.stdout).toContain(senderSentinel('append', 'marcusrbrown'))
        expect(revoked.exitCode).toBe(0)
        expect(revoked.stdout).toContain(senderSentinel('remove', 'marcusrbrown'))
        // The revoked token stays revoked, and the appended one is there.
        // A's line is gone and the appended line is there. The void line only appears if no real token is left,
        // and this one is.
        expect(world.file('marcusrbrown')).toBe(NEW_LINE)
        expect(world.file('marcusrbrown')).not.toContain(OLD_A)
      },
    )

    it.skipIf(!CAN_LOCK)(
      'a held lock makes the second command fail with the busy sentinel, change nothing and leave no temp file',
      async () => {
        const world = createWorld({files: {marcusrbrown: oldLine(OLD_A)}})
        const append = pausedAppend(world)
        const running = append.started()
        await append.waitUntilPaused()

        // The same script, with the wait cut from 30 s to 1 s so the test does not stand about.
        const impatient = SENDER_REMOTE.remove('marcusrbrown').replace('flock -w 30', 'flock -w 1')
        expect(impatient).not.toBe(SENDER_REMOTE.remove('marcusrbrown'))
        const second = execOnHost(world.dir, impatient, removeInput(sha12(OLD_A)))

        expect(second.exitCode).not.toBe(0)
        expect(second.stdout).toContain(lockBusySentinel('marcusrbrown'))
        expect(second.stdout).not.toContain(senderSentinel('remove', 'marcusrbrown'))
        expect(second.stdout).not.toContain('TRACES_TOKEN_REMOVED')
        expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A))

        append.release()
        expect((await running.finished()).exitCode).toBe(0)
        expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + NEW_LINE)
        expect(tempFiles(world, 'marcusrbrown').filter(name => name.startsWith('.token.'))).toEqual([])
      },
    )

    it('creates the lock file when it is absent, and takes it for the append, remove and deny', () => {
      for (const name of ['append', 'remove', 'deny'] as const) {
        const world = createWorld({files: {workstation: oldLine(OLD_A)}})
        const stdin = name === 'append' ? NEW_LINE : name === 'remove' ? removeInput(sha12(OLD_A)) : voidLine(31)
        const lock = join(world.dir, 'tokens', '.lock')
        expect(existsSync(lock)).toBe(false)
        const result = run1(world, SENDER_REMOTE[name]('workstation'), stdin)
        expect(result.exitCode).toBe(0)
        expect(statSync(lock).isFile()).toBe(true)
      }
    })
  })

  describe('list and lines', () => {
    const files = {
      marcusrbrown: `${OLD_A} 000000000000 2026-10-01T00:00:00.000Z\n${OLD_B}\n`,
    }

    it('list prints fingerprints (computed from the token) and dates, and no token text', () => {
      const world = createWorld({files})
      const result = run1(world, SENDER_REMOTE.list('marcusrbrown'))
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_A)} 2026-10-01T00:00:00.000Z`)
      expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_B)} unknown`)
      expect(result.stdout).toContain(senderSentinel('list', 'marcusrbrown'))
      expect(result.stdout).not.toContain(OLD_A)
      expect(result.stdout).not.toContain(OLD_B)
      expect(result.stdout).not.toContain('000000000000')
    })

    it('lines prints the token as well, for the proof that follows a revoke', () => {
      const world = createWorld({files})
      const result = run1(world, SENDER_REMOTE.lines('marcusrbrown'))
      expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_A)} 2026-10-01T00:00:00.000Z ${OLD_A}`)
      expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_B)} unknown ${OLD_B}`)
    })

    it('hides every void line from both commands: they are not tokens anyone holds', () => {
      const first = voidLine(5)
      const second = voidLine(6)
      const firstToken = first.split(' ')[0] ?? ''
      const world = createWorld({
        files: {marcusrbrown: `${first}${oldLine(OLD_A)}${second}${OLD_B}\n${first.trimEnd()}`},
      })
      for (const name of ['list', 'lines'] as const) {
        const result = run1(world, SENDER_REMOTE[name]('marcusrbrown'))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.match(/^TRACES_TOKEN /gm)).toHaveLength(2)
        expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_A)} `)
        expect(result.stdout).toContain(`TRACES_TOKEN ${sha12(OLD_B)} `)
        expect(result.stdout).not.toContain(sha12(firstToken))
        expect(result.stdout).not.toContain(VOID_TOKEN_PREFIX)
        expect(result.stdout).toContain(senderSentinel(name, 'marcusrbrown'))
      }
    })

    it('a deny-all file prints only the sentinel', () => {
      const world = createWorld({files: {'fro-bot': voidLine(5)}})
      for (const name of ['list', 'lines'] as const) {
        const result = run1(world, SENDER_REMOTE[name]('fro-bot'))
        expect(result.exitCode).toBe(0)
        expect(result.stdout.trim()).toBe(senderSentinel(name, 'fro-bot'))
      }
    })

    it('an empty file prints only the sentinel, and a missing directory fails', () => {
      const world = createWorld()
      const empty = run1(world, SENDER_REMOTE.list('fro-bot'))
      expect(empty.exitCode).toBe(0)
      expect(empty.stdout.trim()).toBe(senderSentinel('list', 'fro-bot'))
      rmSync(join(world.dir, 'tokens', 'fro-bot'), {recursive: true})
      const missing = run1(world, SENDER_REMOTE.list('fro-bot'))
      expect(missing.exitCode).not.toBe(0)
      expect(missing.stdout).not.toContain(senderSentinel('list', 'fro-bot'))
    })
  })
})

// ─── add ──────────────────────────────────────────────────────────────────────

describe('traces sender add', () => {
  it('writes one new line to the right group file, proves it over ssh while the route is held, then hands it to gh on stdin', async () => {
    const world = createWorld({configured: 'held'})
    const deps = makeDeps(world)
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, deps), {
      secrets: [NEXT_TOKEN],
    })

    expect(result.exit).toBeNull()
    expect(world.file('marcusrbrown')).toBe(formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED))
    expect(world.file('fro-bot')).toBe('')
    expect(world.file('workstation')).toBe('')

    // The proof ran against the private receiver, with the token on stdin, and never touched the public hostname.
    const probes = world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))
    expect(probes).toHaveLength(1)
    expect(probes[0]?.stdin?.trim()).toBe(NEXT_TOKEN)
    expect(world.fetchCalls).toHaveLength(0)

    // The token reached the host on stdin, and reached gh on stdin: exactly the bytes, no newline.
    expect(world.remoteCalls(SENDER_REMOTE.append('marcusrbrown'))[0]?.stdin).toBe(
      formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED),
    )
    const gh = world.ghCalls()
    expect(gh).toHaveLength(1)
    expect(gh[0]?.argv).toEqual(['gh', 'secret', 'set', DEFAULT_SECRET_NAME, '--repo', 'marcusrbrown/example'])
    expect(gh[0]?.stdin).toBe(NEXT_TOKEN)

    expect(result.stdout).toContain(NEXT_FINGERPRINT)
    expect(result.stdout).toContain('marcusrbrown/example')
  })

  it('the token is in stdin and the proof header and nowhere the scan looks (the scan is not vacuous)', async () => {
    const world = createWorld({configured: 'open'})
    await run(
      world,
      ctx => tracesSenderAddAction('fro-bot', {org: 'fro-bot', orgRepo: ['agent']}, ctx, makeDeps(world)),
      {
        secrets: [NEXT_TOKEN],
      },
    )
    const everywhere = world.calls.map(call => `${call.stdin ?? ''}`).join('\n') + JSON.stringify(world.fetchCalls)
    expect(everywhere).toContain(NEXT_TOKEN)
    for (const call of world.calls) expect(call.argv.join(' ')).not.toContain(NEXT_TOKEN)
  })

  it('uses the public route when the host says open and an outside request is routed to the collector', async () => {
    const world = createWorld({configured: 'open'})
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN],
    })
    expect(result.exit).toBeNull()

    const authenticated = world.fetchCalls.filter(call =>
      Object.keys(call.headers).some(key => key.toLowerCase() === 'authorization'),
    )
    expect(authenticated).toHaveLength(1)
    expect(authenticated[0]?.url).toBe(`${ORIGIN}/marcusrbrown/v1/traces`)
    expect(authenticated[0]?.method).toBe('POST')
    expect(authenticated[0]?.headers.authorization).toBe(`Bearer ${NEXT_TOKEN}`)
    // A minimal valid OTLP JSON export, not a made-up span.
    expect(JSON.parse(String(authenticated[0]?.body))).toEqual({resourceSpans: []})
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
  })

  it('falls back to the private receiver when the host says open but the outside cannot reach it', async () => {
    const world = createWorld({configured: 'open', outside: 'down'})
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN],
    })
    expect(result.exit).toBeNull()
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(1)
    expect(world.fetchCalls.every(call => !('authorization' in call.headers))).toBe(true)
  })

  it('uses the private receiver when the host is open but an outside request is held', async () => {
    const world = createWorld({configured: 'open', outside: 'held'})
    await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN],
    })
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(1)
  })

  it('retries while the collector re-reads the file, and succeeds on the first 2xx', async () => {
    const world = createWorld({configured: 'held'})
    world.forced.push(401, 401)
    const deps = makeDeps(world, {attempts: 5})
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, deps), {
      secrets: [NEXT_TOKEN],
    })
    expect(result.exit).toBeNull()
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(3)
    expect(deps.slept).toEqual([5, 5])
    expect(world.ghCalls()).toHaveLength(1)
  })

  it('fails when the proof never answers 2xx: says the token is not live, names the fingerprint, delivers nothing', async () => {
    const world = createWorld({configured: 'held'})
    world.forced.push(401, 401, 401, 401)
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN],
    })
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('not live')
    expect(result.stderr).toContain(NEXT_FINGERPRINT)
    expect(result.stderr).toContain(`traces sender revoke marcusrbrown ${NEXT_FINGERPRINT}`)
    expect(world.ghCalls()).toHaveLength(0)
    expect(result.stdout).not.toContain('Delivered')
  })

  it('fails on a 5xx proof the same way, and on an unreachable one', async () => {
    for (const forced of [503, 'down'] as const) {
      const world = createWorld({configured: 'held'})
      world.forced.push(forced, forced, forced)
      const result = await run(
        world,
        ctx => tracesSenderAddAction('workstation', {}, ctx, makeDeps(world, {isTty: true})),
        {
          secrets: [NEXT_TOKEN],
          printsOn: 'stdout',
        },
      )
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain('not live')
      // Not delivered: nothing printed either.
      expect(result.stdout).not.toContain(NEXT_TOKEN)
    }
  })

  it('refuses an unknown group before any ssh call, fetch or gh call', async () => {
    const world = createWorld()
    const result = await run(world, ctx => tracesSenderAddAction('nobody', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN],
    })
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('marcusrbrown, fro-bot, workstation')
    expect(world.calls).toHaveLength(0)
    expect(world.fetchCalls).toHaveLength(0)
  })

  it('refuses a host that starts with - before any ssh call, and does not echo it', async () => {
    const world = createWorld()
    process.env.TRACES_OTHER = '-oProxyCommand=SECRETVALUE'
    const result = await run(
      world,
      ctx => tracesSenderAddAction('marcusrbrown', {...github(), key: 'TRACES_OTHER'}, ctx, makeDeps(world)),
      {secrets: [NEXT_TOKEN, 'SECRETVALUE']},
    )
    expect(result.exit).toBe(1)
    expect(world.calls).toHaveLength(0)
  })

  describe('delivery targets are checked before anything is issued', () => {
    const refused: [string, string, AddOptions][] = [
      ['no target for a GitHub group', 'marcusrbrown', noOptions],
      ['no target for the other GitHub group', 'fro-bot', noOptions],
      ['a repository that is not OWNER/REPO', 'marcusrbrown', {repo: ['marcusrbrown']}],
      ['a repository starting with a hyphen', 'marcusrbrown', {repo: ['-oops/repo']}],
      ['a repository that has an extra segment', 'marcusrbrown', {repo: ['a/b/c']}],
      ['a repository named .', 'marcusrbrown', {repo: ['marcusrbrown/.']}],
      ['a repository named ..', 'marcusrbrown', {repo: ['marcusrbrown/..']}],
      ['a selected repository named ..', 'fro-bot', {org: 'fro-bot', orgRepo: ['..']}],
      ['a selected repository starting with a hyphen', 'fro-bot', {org: 'fro-bot', orgRepo: ['-x']}],
      ['an organisation with no selected repositories', 'fro-bot', {org: 'fro-bot'}],
      ['selected repositories with no organisation', 'fro-bot', {orgRepo: ['agent']}],
      ['an organisation name starting with a hyphen', 'fro-bot', {org: '-x', orgRepo: ['agent']}],
      ['a bad secret name', 'marcusrbrown', {...github(), secretName: 'lower-case'}],
      ['a secret name starting with a hyphen', 'marcusrbrown', {...github(), secretName: '-X'}],
      ['--print for a GitHub group', 'marcusrbrown', {...github(), print: true}],
      ['a repository for the workstation', 'workstation', {...github(), print: true}],
      ['the workstation on a pipe without --print', 'workstation', noOptions],
    ]

    it.each(refused)('%s', async (_name, group, options) => {
      const world = createWorld()
      const result = await run(world, ctx => tracesSenderAddAction(group, options, ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBe(1)
      expect(world.calls).toHaveLength(0)
      expect(world.fetchCalls).toHaveLength(0)
      expect(result.stderr.length).toBeGreaterThan(0)
    })
  })

  describe('delivery', () => {
    it('sets the secret on every repository and, for an organisation, with selected visibility only', async () => {
      const world = createWorld()
      const options: AddOptions = {
        repo: ['marcusrbrown/one', 'marcusrbrown/two'],
        org: 'fro-bot',
        orgRepo: ['agent', 'infra'],
        secretName: 'MY_TRACE_TOKEN',
      }
      const result = await run(world, ctx => tracesSenderAddAction('fro-bot', options, ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBeNull()
      expect(world.ghCalls().map(call => call.argv)).toEqual([
        ['gh', 'secret', 'set', 'MY_TRACE_TOKEN', '--repo', 'marcusrbrown/one'],
        ['gh', 'secret', 'set', 'MY_TRACE_TOKEN', '--repo', 'marcusrbrown/two'],
        [
          'gh',
          'secret',
          'set',
          'MY_TRACE_TOKEN',
          '--org',
          'fro-bot',
          '--visibility',
          'selected',
          '--repos',
          'agent,infra',
        ],
      ])
      for (const call of world.ghCalls()) expect(call.stdin).toBe(NEXT_TOKEN)
    })

    it('accepts a repository name that starts with a dot, such as .github', async () => {
      const world = createWorld()
      const options: AddOptions = {repo: ['fro-bot/.github'], org: 'fro-bot', orgRepo: ['.github']}
      const result = await run(world, ctx => tracesSenderAddAction('fro-bot', options, ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBeNull()
      expect(world.ghCalls().map(call => call.argv)).toEqual([
        ['gh', 'secret', 'set', 'TRACES_INGEST_TOKEN', '--repo', 'fro-bot/.github'],
        [
          'gh',
          'secret',
          'set',
          'TRACES_INGEST_TOKEN',
          '--org',
          'fro-bot',
          '--visibility',
          'selected',
          '--repos',
          '.github',
        ],
      ])
    })

    it('when gh fails after the host accepted the token: says so, names the fingerprint, exits non-zero, prints no token even on a terminal', async () => {
      const world = createWorld()
      world.gh.exitCode = 1
      world.gh.stderr = `HTTP 403: Resource not accessible by integration ${NEXT_TOKEN}`
      const result = await run(
        world,
        ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world, {isTty: true})),
        {
          secrets: [NEXT_TOKEN],
        },
      )
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain(NEXT_FINGERPRINT)
      expect(result.stderr).toContain('accepted')
      expect(result.stderr).toContain(`traces sender revoke marcusrbrown ${NEXT_FINGERPRINT}`)
      // The file keeps the token: the host did accept it, and the operator decides.
      expect(world.file('marcusrbrown')).toContain(NEXT_TOKEN)
    })

    it('with two targets, a failure on the second names what was delivered and what was not', async () => {
      const world = createWorld()
      world.gh.exitCode = 1
      world.gh.failOnCall = 2
      world.gh.stderr = 'HTTP 404'
      const result = await run(
        world,
        ctx =>
          tracesSenderAddAction('marcusrbrown', {repo: ['marcusrbrown/one', 'marcusrbrown/two']}, ctx, makeDeps(world)),
        {secrets: [NEXT_TOKEN]},
      )
      expect(result.exit).toBe(1)
      expect(result.stdout).toContain('marcusrbrown/one')
      expect(result.stderr).toContain('marcusrbrown/two')
      expect(result.stderr).toContain(NEXT_FINGERPRINT)
    })

    it('a gh that cannot start is a delivery failure, not a crash', async () => {
      const world = createWorld()
      const throwing: SpawnFn = (argv, options) => {
        if (argv[0] === 'gh') throw new Error(`spawn gh ENOENT ${NEXT_TOKEN}`)
        return world.spawn(argv, options)
      }
      const result = await run(
        world,
        ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world, {spawn: throwing})),
        {
          secrets: [NEXT_TOKEN],
        },
      )
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain(NEXT_FINGERPRINT)
    })

    it('prints a workstation token once, with where it goes, only on a terminal', async () => {
      const world = createWorld()
      const result = await run(
        world,
        ctx => tracesSenderAddAction('workstation', noOptions, ctx, makeDeps(world, {isTty: true})),
        {
          secrets: [NEXT_TOKEN],
          printsOn: 'stdout',
        },
      )
      expect(result.exit).toBeNull()
      expect(result.stdout.split(NEXT_TOKEN)).toHaveLength(2)
      expect(result.stdout).toContain(`${ORIGIN}/workstation/v1/traces`)
      expect(result.stdout).toContain(NEXT_FINGERPRINT)
      expect(result.stderr).not.toContain(NEXT_TOKEN)
      expect(world.ghCalls()).toHaveLength(0)
    })

    it('prints a workstation token on a pipe only with --print', async () => {
      const world = createWorld()
      const result = await run(
        world,
        ctx => tracesSenderAddAction('workstation', {print: true}, ctx, makeDeps(world, {isTty: false})),
        {secrets: [NEXT_TOKEN], printsOn: 'stdout'},
      )
      expect(result.exit).toBeNull()
      expect(result.stdout.split(NEXT_TOKEN)).toHaveLength(2)
    })
  })

  describe('rotation', () => {
    it('names the existing fingerprints and the revoke command when the group already had a token', async () => {
      const world = createWorld({files: {marcusrbrown: oldLine(OLD_A)}})
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN, OLD_A],
      })
      expect(result.exit).toBeNull()
      expect(result.stdout).toContain(`traces sender revoke marcusrbrown ${sha12(OLD_A)}`)
      // Two tokens overlap in one file until the old one is revoked.
      expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED))
    })

    it('adds to a deny-all group: keeps the void line, proves the new token, and has no old token to revoke', async () => {
      const deny = voidLine(5)
      const world = createWorld({files: {marcusrbrown: deny}})
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBeNull()
      expect(world.file('marcusrbrown')).toBe(deny + formatTokenLine(NEXT_TOKEN, NEXT_FINGERPRINT, CREATED))
      expect(world.ghCalls()).toHaveLength(1)
      // The void line is not a token the operator holds: nothing to rotate, nothing to revoke.
      expect(result.stdout).not.toContain('already had')
      expect(result.stdout).not.toContain('traces sender revoke')
    })

    it('prints no rotation hint for a group that had no token', async () => {
      const world = createWorld()
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.stdout).not.toContain('traces sender revoke')
    })
  })

  describe('host failures', () => {
    it('stops with no proof and no delivery when the host does not confirm the write', async () => {
      const world = createWorld()
      world.failing.add('append')
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain('did not confirm')
      expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
      expect(world.ghCalls()).toHaveLength(0)
    })

    it('when the reply to the write is lost, names the group, the fingerprint and both commands to find out, never the token', async () => {
      const world = createWorld()
      // The write landed; only the reply was lost.
      world.dropReply.add('append')
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(world.file('marcusrbrown')).toContain(NEXT_TOKEN)
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain('did not confirm')
      expect(result.stderr).toContain('marcusrbrown')
      expect(result.stderr).toContain(NEXT_FINGERPRINT)
      expect(result.stderr).toContain('infra traces sender list')
      expect(result.stderr).toContain(`infra traces sender revoke marcusrbrown ${NEXT_FINGERPRINT}`)
      expect(result.stderr).not.toContain(NEXT_TOKEN)
      expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
      expect(world.ghCalls()).toHaveLength(0)
    })

    it('names the fingerprint when the write fails outright too, since the host may have done part of it', async () => {
      const world = createWorld()
      world.failing.add('append')
      const result = await run(world, ctx => tracesSenderAddAction('fro-bot', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.stderr).toContain(`infra traces sender revoke fro-bot ${NEXT_FINGERPRINT}`)
      expect(result.stderr).toContain('infra traces sender list')
    })

    it('a busy token lock stops the add with its own message: nothing written, nothing to revoke, nothing delivered', async () => {
      const world = createWorld()
      world.busy.add('append')
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBe(1)
      expect(result.stderr).toContain('busy')
      expect(result.stderr).toContain('Nothing was changed')
      expect(result.stderr).not.toContain('did not confirm')
      expect(result.stderr).not.toContain('revoke')
      expect(world.file('marcusrbrown')).toBe('')
      expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
      expect(world.ghCalls()).toHaveLength(0)
    })

    it('stops before writing when the existing token file cannot be read', async () => {
      const world = createWorld()
      world.failing.add('list:marcusrbrown')
      const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
        secrets: [NEXT_TOKEN],
      })
      expect(result.exit).toBe(1)
      expect(world.remoteCalls(SENDER_REMOTE.append('marcusrbrown'))).toHaveLength(0)
    })
  })
})

// ─── list ─────────────────────────────────────────────────────────────────────

describe('traces sender list', () => {
  it('shows each group with fingerprints and dates and never token text', async () => {
    const world = createWorld({
      files: {
        marcusrbrown: oldLine(OLD_A, '2026-10-01T00:00:00.000Z') + oldLine(OLD_B, '2026-11-01T00:00:00.000Z'),
        'fro-bot': oldLine(OLD_C, '2026-11-10T00:00:00.000Z'),
      },
    })
    const result = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {
      secrets: [OLD_A, OLD_B, OLD_C],
    })
    expect(result.exit).toBeNull()
    for (const [token, date] of [
      [OLD_A, '2026-10-01T00:00:00.000Z'],
      [OLD_B, '2026-11-01T00:00:00.000Z'],
      [OLD_C, '2026-11-10T00:00:00.000Z'],
    ] as const) {
      expect(result.stdout).toContain(sha12(token))
      expect(result.stdout).toContain(date)
    }
    expect(result.stdout).toContain('workstation')
    expect(result.stdout).toContain('no tokens')
    // The reading command is the one that never prints token text, and no token came back over ssh at all.
    expect(world.calls.every(call => call.command !== SENDER_REMOTE.lines('marcusrbrown'))).toBe(true)
    for (const call of world.calls) expect(call.stdin).toBeUndefined()
  })

  it('shows a deny-all group as having no tokens, and hides void lines beside real ones', async () => {
    const voidA = voidLine(5)
    const voidB = voidLine(6)
    const world = createWorld({
      files: {marcusrbrown: voidA, 'fro-bot': voidB + oldLine(OLD_C, '2026-11-10T00:00:00.000Z')},
    })
    const result = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {secrets: [OLD_C]})
    expect(result.exit).toBeNull()
    // Two groups have no real token: the deny-all one, and the one nothing has written to.
    expect(result.stdout.match(/\(no tokens\)/g)).toHaveLength(2)
    expect(result.stdout).toContain(sha12(OLD_C))
    for (const line of [voidA, voidB]) {
      const token = line.split(' ')[0] ?? ''
      expect(result.stdout).not.toContain(sha12(token))
      expect(result.stdout).not.toContain(token)
    }
    expect(result.stdout).not.toContain(VOID_TOKEN_PREFIX)
    expect(result.stdout).not.toContain('void')
  })

  it('reports a group it could not read, still lists the others, and exits non-zero', async () => {
    const world = createWorld({files: {workstation: oldLine(OLD_A)}})
    world.failing.add('list:marcusrbrown')
    const result = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {secrets: [OLD_A]})
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('marcusrbrown')
    expect(result.stdout).toContain(sha12(OLD_A))
  })
})

// ─── revoke <group> <fingerprint> ─────────────────────────────────────────────

/** One authenticated request to a group's private receiver, as the proof makes it. */
async function privateStatus(world: World, group: Group, token: string): Promise<string> {
  const child = world.spawn(['ssh', SENDER_REMOTE.probe(group)], {
    env: {},
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: new TextEncoder().encode(token),
  })
  return new Response(child.stdout).text()
}

describe('traces sender revoke', () => {
  const seeded = (): World =>
    createWorld({configured: 'held', files: {marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B) + oldLine(OLD_C)}})

  it('removes exactly the matching line, then says revoked only after the token gets 401', async () => {
    const world = seeded()
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBeNull()
    expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_C))

    // The fingerprint goes on stdin of a fixed command, then the void line for the case that no real token is
    // left; the token was read first, over ssh, for the proof. Two real tokens are left here, so no void is written.
    expect(world.remoteCalls(SENDER_REMOTE.remove('marcusrbrown'))[0]?.stdin).toBe(
      removeInput(sha12(OLD_B), DEFAULT_VOID_LINE),
    )
    expect(result.stdout).not.toContain('no real token')
    expect(world.remoteCalls(SENDER_REMOTE.lines('marcusrbrown'))).toHaveLength(1)
    const probes = world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))
    expect(probes).toHaveLength(1)
    expect(probes[0]?.stdin?.trim()).toBe(OLD_B)

    expect(result.stdout).toContain('revoked')
    expect(result.stdout).toContain(sha12(OLD_B))
    // Order: read, remove, then prove.
    const order = world.calls.map(call => call.command)
    expect(order.indexOf(SENDER_REMOTE.remove('marcusrbrown'))).toBeLessThan(
      order.indexOf(SENDER_REMOTE.probe('marcusrbrown')),
    )
    expect(order.indexOf(SENDER_REMOTE.lines('marcusrbrown'))).toBeLessThan(
      order.indexOf(SENDER_REMOTE.remove('marcusrbrown')),
    )
  })

  it('does not say revoked when the proof answers 200: the token is removed but still accepted', async () => {
    const world = seeded()
    world.stubborn.add(OLD_B)
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('removed from the file but still accepted')
    expect(result.stderr).toContain('traces ingest hold')
    expect(result.stderr).toContain(sha12(OLD_B))
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).not.toContain('revoked')
  })

  it.each([503, 'down'] as const)('does not say revoked when the proof cannot be made (%s)', async forced => {
    const world = seeded()
    world.forced.push(forced, forced, forced)
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('could not be proven')
    expect(`${result.stdout}\n${result.stderr}`.toLowerCase()).not.toContain('revoked')
  })

  it('retries the proof while the collector re-reads the file', async () => {
    const world = seeded()
    world.forced.push(200, 200)
    const deps = makeDeps(world, {attempts: 5})
    const result = await run(world, ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, deps), {
      secrets: [OLD_A, OLD_B, OLD_C],
    })
    expect(result.exit).toBeNull()
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(3)
    expect(result.stdout).toContain('revoked')
  })

  it('fails and lists the fingerprints that exist when nothing matches, changing nothing', async () => {
    const world = seeded()
    const before = world.file('marcusrbrown')
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', 'ffffffffffff', {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    for (const token of [OLD_A, OLD_B, OLD_C]) expect(result.stderr).toContain(sha12(token))
    expect(world.remoteCalls(SENDER_REMOTE.remove('marcusrbrown'))).toHaveLength(0)
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
    expect(world.file('marcusrbrown')).toBe(before)
    expect(result.stdout.toLowerCase()).not.toContain('revoked')
  })

  it('the modelled collector keeps a token it already holds when its file is emptied: only a new file revokes it', async () => {
    // The measured behaviour of the pinned collector, which the scenarios below depend on being modelled.
    const world = createWorld({files: {workstation: oldLine(OLD_A)}})
    expect(await privateStatus(world, 'workstation', OLD_A)).toContain('TRACES_PROBE_STATUS=200')
    writeFileSync(world.path('workstation'), '')
    expect(await privateStatus(world, 'workstation', OLD_A)).toContain('TRACES_PROBE_STATUS=200')
    writeFileSync(world.path('workstation'), voidLine(5))
    expect(await privateStatus(world, 'workstation', OLD_A)).toContain('TRACES_PROBE_STATUS=401')
  })

  it('revoking the last token leaves one void line, never an empty file, and the group refuses the token', async () => {
    const world = createWorld({files: {workstation: oldLine(OLD_A)}})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('workstation', sha12(OLD_A), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A],
      },
    )
    expect(result.exit).toBeNull()
    expect(world.file('workstation')).toBe(DEFAULT_VOID_LINE)
    expect(world.file('workstation')).toMatch(VOID_LINE_PATTERN)
    expect(result.stdout).toContain('revoked')
    expect(result.stdout).toContain('no real token remains')
    expect(result.stdout).toContain('workstation')
    // The void token reached the host on stdin and nowhere else.
    expect(world.remoteCalls(SENDER_REMOTE.remove('workstation'))[0]?.stdin).toBe(
      removeInput(sha12(OLD_A), DEFAULT_VOID_LINE),
    )
    // And the same token, tried again, is refused.
    expect(await privateStatus(world, 'workstation', OLD_A)).toContain('TRACES_PROBE_STATUS=401')
  })

  it('proves over the public route when it is open, with the removed token as the bearer', async () => {
    const world = createWorld({configured: 'open', files: {marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B)}})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_A), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B],
      },
    )
    expect(result.exit).toBeNull()
    const authenticated = world.fetchCalls.filter(call => 'authorization' in call.headers)
    expect(authenticated).toHaveLength(1)
    expect(authenticated[0]?.headers.authorization).toBe(`Bearer ${OLD_A}`)
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
  })

  it('does not touch the public route while it is held', async () => {
    const world = createWorld({configured: 'held', files: {marcusrbrown: oldLine(OLD_A)}})
    await run(world, ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_A), {}, ctx, makeDeps(world)), {
      secrets: [OLD_A],
    })
    expect(world.fetchCalls).toHaveLength(0)
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(1)
  })

  describe('arguments are checked before any ssh call', () => {
    const refused: [string, string | undefined, string | undefined, RevokeOptions][] = [
      ['no group and no --all', undefined, undefined, {}],
      ['an unknown group', 'nobody', sha12(OLD_A), {}],
      ['no fingerprint', 'marcusrbrown', undefined, {}],
      ['a fingerprint that is not 12 hex characters', 'marcusrbrown', 'abc', {}],
      ['a fingerprint with a shell character', 'marcusrbrown', 'abcdef01234;', {}],
      ['a token given where the fingerprint goes', 'marcusrbrown', OLD_A, {}],
      ['--all with a group', 'marcusrbrown', undefined, {all: true}],
      ['--all with a fingerprint', undefined, sha12(OLD_A), {all: true}],
    ]

    it.each(refused)('%s', async (_name, group, fingerprint, options) => {
      const world = seeded()
      const result = await run(
        world,
        ctx => tracesSenderRevokeAction(group, fingerprint, options, ctx, makeDeps(world)),
        {
          secrets: [OLD_A, OLD_B, OLD_C],
        },
      )
      expect(result.exit).toBe(1)
      expect(world.calls).toHaveLength(0)
      expect(world.fetchCalls).toHaveLength(0)
    })

    it('a token given as the fingerprint is not echoed', async () => {
      const world = seeded()
      const result = await run(
        world,
        ctx => tracesSenderRevokeAction('marcusrbrown', OLD_A, {}, ctx, makeDeps(world)),
        {
          secrets: [OLD_A],
        },
      )
      expect(result.stderr).not.toContain(OLD_A)
    })
  })

  it('accepts an upper-case fingerprint', async () => {
    const world = seeded()
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B).toUpperCase(), {}, ctx, makeDeps(world)),
      {secrets: [OLD_A, OLD_B, OLD_C]},
    )
    expect(result.exit).toBeNull()
    expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_C))
  })

  it('a busy token lock stops the revoke with its own message and proves nothing', async () => {
    const world = seeded()
    world.busy.add('remove')
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {secrets: [OLD_A, OLD_B, OLD_C]},
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('busy')
    expect(result.stderr).toContain('Nothing was changed')
    expect(result.stderr).not.toContain('did not confirm')
    expect(world.file('marcusrbrown')).toBe(oldLine(OLD_A) + oldLine(OLD_B) + oldLine(OLD_C))
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(0)
    expect(result.stdout.toLowerCase()).not.toContain('revoked')
  })

  it('fails and proves nothing when the host does not confirm the removal', async () => {
    const world = seeded()
    world.failing.add('remove')
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('did not confirm')
    expect(result.stdout.toLowerCase()).not.toContain('revoked')
  })
})

// ─── revoke --all ─────────────────────────────────────────────────────────────

describe('traces sender revoke --all', () => {
  const files = {
    marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B),
    'fro-bot': oldLine(OLD_C),
  }

  it('with the public route open, makes every file deny-all and proves every old token on its private receiver, never touching the public hostname', async () => {
    const world = createWorld({configured: 'open', outside: 'open', files})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBeNull()
    for (const group of TRACES_GROUPS) {
      expect(world.file(group)).toBe(DEFAULT_VOID_LINE)
      expect(world.file(group)).toMatch(VOID_LINE_PATTERN)
    }

    // The public hostname is never used, and the host's ingest state is not even read.
    expect(world.fetchCalls).toHaveLength(0)
    expect(world.remoteCalls(REMOTE_COMMANDS.readIngestState)).toHaveLength(0)

    const probed = world.calls
      .filter(call => TRACES_GROUPS.some(group => call.command === SENDER_REMOTE.probe(group)))
      .map(call => call.stdin?.trim())
    expect(probed.sort()).toEqual([OLD_A, OLD_B, OLD_C].sort())

    for (const token of [OLD_A, OLD_B, OLD_C]) expect(result.stdout).toContain(sha12(token))
    expect(result.stdout).toContain('GitHub secrets')
  })

  it('works when the route is held or off, and makes a group that had no token deny-all too, not empty', async () => {
    const world = createWorld({configured: 'off', files: {workstation: oldLine(OLD_A)}})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A],
      },
    )
    expect(result.exit).toBeNull()
    expect(world.fetchCalls).toHaveLength(0)
    for (const group of TRACES_GROUPS) expect(world.file(group)).toMatch(VOID_LINE_PATTERN)
  })

  describe('the void lines', () => {
    /** Each call draws bytes filled with the next number, so each group gets its own void token. */
    const sequence = (first: number): ((length: number) => Uint8Array) => {
      let next = first
      return length => new Uint8Array(length).fill(next++)
    }
    const seeded = {
      marcusrbrown: voidLine(5) + oldLine(OLD_A) + oldLine(OLD_B),
      'fro-bot': oldLine(OLD_C),
      workstation: voidLine(6),
    }
    const expectedVoids = TRACES_GROUPS.map((_group, index) => generateVoidToken(randomFilledWith(11 + index)))

    it('leaves each group deny-all with its own fresh void line, different from the one it had, and says no real token remains in each', async () => {
      const world = createWorld({configured: 'held', files: seeded})
      const before = Object.fromEntries(TRACES_GROUPS.map(group => [group, world.file(group)])) as Record<Group, string>
      const result = await run(
        world,
        ctx =>
          tracesSenderRevokeAction(
            undefined,
            undefined,
            {all: true},
            ctx,
            makeDeps(world, {randomBytes: sequence(11)}),
          ),
        {secrets: [OLD_A, OLD_B, OLD_C, ...expectedVoids]},
      )
      expect(result.exit).toBeNull()

      const after = TRACES_GROUPS.map(group => world.file(group))
      TRACES_GROUPS.forEach((group, index) => {
        // Exactly one line, the new void line: no older void line, no real token.
        expect(world.file(group)).toBe(formatVoidLine(expectedVoids[index] ?? '', CREATED))
        expect(world.file(group)).not.toBe(before[group])
        expect(world.file(group).trim().split('\n')).toHaveLength(1)
        // The old void lines are gone too: a revoke does not leave a credential nobody can account for.
        expect(world.file(group)).not.toContain(voidLine(5).split(' ')[0] ?? 'x')
        expect(world.file(group)).not.toContain(voidLine(6).split(' ')[0] ?? 'x')
        expect(result.stdout).toContain(`${group}: no real token remains`)
      })
      // A void line each: the three files differ from each other.
      expect(new Set(after).size).toBe(3)
    })

    it('sends each void line on stdin of the fixed deny command, and prints and logs none of them', async () => {
      const world = createWorld({configured: 'held', files: seeded})
      const result = await run(
        world,
        ctx =>
          tracesSenderRevokeAction(
            undefined,
            undefined,
            {all: true},
            ctx,
            makeDeps(world, {randomBytes: sequence(11)}),
          ),
        {secrets: [OLD_A, OLD_B, OLD_C, ...expectedVoids]},
      )
      expect(result.exit).toBeNull()
      TRACES_GROUPS.forEach((group, index) => {
        const calls = world.remoteCalls(SENDER_REMOTE.deny(group))
        expect(calls).toHaveLength(1)
        // Non-vacuous: the token is on stdin, which the scan in `run` allows and everything else it forbids.
        expect(calls[0]?.stdin).toBe(formatVoidLine(expectedVoids[index] ?? '', CREATED))
        expect(calls[0]?.command).not.toContain(expectedVoids[index] ?? 'x')
      })
      for (const voidToken of expectedVoids) {
        expect(result.stdout).not.toContain(voidToken)
        expect(result.stderr).not.toContain(voidToken)
      }
    })

    it('never lists a group as having a token afterwards', async () => {
      const world = createWorld({configured: 'held', files: seeded})
      await run(
        world,
        ctx =>
          tracesSenderRevokeAction(
            undefined,
            undefined,
            {all: true},
            ctx,
            makeDeps(world, {randomBytes: sequence(11)}),
          ),
        {secrets: [OLD_A, OLD_B, OLD_C, ...expectedVoids]},
      )
      const listed = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {secrets: []})
      expect(listed.stdout.match(/\(no tokens\)/g)).toHaveLength(3)
    })

    it('does not claim a group has no real token when the proof that its token is refused failed', async () => {
      const world = createWorld({configured: 'held', files})
      world.stubborn.add(OLD_C)
      const result = await run(
        world,
        ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
        {secrets: [OLD_A, OLD_B, OLD_C]},
      )
      expect(result.exit).toBe(1)
      expect(result.stdout).not.toContain('fro-bot: no real token remains')
      expect(result.stdout).toContain('marcusrbrown: no real token remains')
    })
  })

  it('names the group and fingerprint of a token that is still accepted, and says to hold ingest', async () => {
    const world = createWorld({configured: 'held', files})
    world.stubborn.add(OLD_C)
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('fro-bot')
    expect(result.stderr).toContain(sha12(OLD_C))
    expect(result.stderr).toContain('removed from the file but still accepted')
    expect(result.stderr).toContain('traces ingest hold')
    expect(result.stdout.toLowerCase()).not.toContain('revoked')
    // The other groups were still made deny-all and proven.
    expect(world.file('marcusrbrown')).toMatch(VOID_LINE_PATTERN)
  })

  it('a busy token lock leaves every group alone, says so for each, and exits non-zero', async () => {
    const world = createWorld({configured: 'held', files})
    world.busy.add('deny')
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {secrets: [OLD_A, OLD_B, OLD_C]},
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('busy')
    expect(result.stderr).not.toContain('did not confirm')
    expect(world.file('marcusrbrown')).toBe(files.marcusrbrown)
    expect(result.stdout.toLowerCase()).not.toContain('revoked')
  })

  it('rewrites no group it could not read first, and exits non-zero', async () => {
    const world = createWorld({configured: 'held', files})
    world.failing.add('lines')
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {
        secrets: [OLD_A, OLD_B, OLD_C],
      },
    )
    expect(result.exit).toBe(1)
    expect(result.stderr).toContain('could not be read')
    expect(world.remoteCalls(SENDER_REMOTE.deny('marcusrbrown'))).toHaveLength(0)
  })

  it('refuses a host that starts with - before any ssh call', async () => {
    const world = createWorld({files})
    process.env.TRACES_OTHER = '-oProxyCommand=evil'
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true, key: 'TRACES_OTHER'}, ctx, makeDeps(world)),
      {secrets: [OLD_A]},
    )
    expect(result.exit).toBe(1)
    expect(world.calls).toHaveLength(0)
  })
})

// ─── One multiplexed ssh connection per command ───────────────────────────────

describe('sender commands reach the host over one multiplexed ssh connection', () => {
  const OLD_FILES = {
    marcusrbrown: oldLine(OLD_A) + oldLine(OLD_B),
    'fro-bot': oldLine(OLD_C),
    workstation: '',
  }

  const sshCalls = (world: World): SpawnCall[] => world.calls.filter(call => call.argv[0] === 'ssh')

  /** The one shared path, and proof the whole command used it and then cleaned up. */
  function expectOneSharedConnection(world: World): string {
    const paths = controlPaths(world.calls)
    expect(paths).toHaveLength(1)
    const [path] = paths
    expect(path).toBeDefined()
    for (const call of sshCalls(world)) {
      expect(call.argv).toContain('ControlMaster=auto')
      expect(call.argv).toContain(`ControlPath=${path}`)
    }
    expect(world.closes).toHaveLength(1)
    expect(world.closes[0]?.controlPath).toBe(path)
    expect(world.closes[0]?.directoryExisted).toBe(true)
    expect(existsSync(dirname(path ?? ''))).toBe(false)
    return path ?? ''
  }

  it('add: the list, the write, the route check and every proof attempt share one ControlPath; gh is not ssh', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    world.forced.push('down', 'down')
    const result = await run(
      world,
      ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world, {attempts: 5})),
      {secrets: [NEXT_TOKEN, OLD_A, OLD_B]},
    )
    expect(result.exit).toBeNull()
    // list, append, route check and three proofs (two forced failures, then the answer): six calls, one connection.
    expect(world.remoteCalls(SENDER_REMOTE.probe('marcusrbrown'))).toHaveLength(3)
    expect(sshCalls(world).length).toBeGreaterThanOrEqual(6)
    expectOneSharedConnection(world)
    for (const call of world.ghCalls()) expect(call.argv.some(arg => arg.startsWith('Control'))).toBe(false)
  })

  it('list: three reads, one connection', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    const result = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {secrets: []})
    expect(result.exit).toBeNull()
    expect(sshCalls(world)).toHaveLength(3)
    expectOneSharedConnection(world)
  })

  it('revoke: read, remove, route check and proof share one connection', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction('marcusrbrown', sha12(OLD_B), {}, ctx, makeDeps(world)),
      {secrets: [OLD_A, OLD_B, OLD_C]},
    )
    expect(result.exit).toBeNull()
    expect(sshCalls(world).length).toBeGreaterThanOrEqual(4)
    expectOneSharedConnection(world)
  })

  it('revoke --all: every group, every rewrite and every proof share one connection', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    const result = await run(
      world,
      ctx => tracesSenderRevokeAction(undefined, undefined, {all: true}, ctx, makeDeps(world)),
      {secrets: [OLD_A, OLD_B, OLD_C]},
    )
    expect(result.exit).toBeNull()
    // Three reads, three rewrites and three proofs: nine calls, which without sharing is nine connections.
    expect(sshCalls(world).length).toBeGreaterThanOrEqual(9)
    expectOneSharedConnection(world)
  })

  it('two command runs use different ControlPaths', async () => {
    const first = createWorld({configured: 'held', files: OLD_FILES})
    const second = createWorld({configured: 'held', files: OLD_FILES})
    await run(first, ctx => tracesSenderListAction({}, ctx, makeDeps(first)), {secrets: []})
    await run(second, ctx => tracesSenderListAction({}, ctx, makeDeps(second)), {secrets: []})
    const one = expectOneSharedConnection(first)
    const two = expectOneSharedConnection(second)
    expect(one).not.toBe(two)
  })

  it('closes the connection once and removes the directory when a call throws', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    const throwing: SpawnFn = (argv, options) => {
      if (argv.at(-1) === SENDER_REMOTE.append('marcusrbrown')) throw new Error('spawn ssh ENOENT')
      return world.spawn(argv, options)
    }
    const result = await run(
      world,
      ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world, {spawn: throwing})),
      {secrets: [NEXT_TOKEN, OLD_A, OLD_B]},
    )
    expect(result.exit).toBe(1)
    expect(world.closes).toHaveLength(1)
    expect(existsSync(dirname(world.closes[0]?.controlPath ?? ''))).toBe(false)
  })

  it('closes the connection once when the command ends with a refusal after ssh was used', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    world.failing.add('append')
    const result = await run(world, ctx => tracesSenderAddAction('marcusrbrown', github(), ctx, makeDeps(world)), {
      secrets: [NEXT_TOKEN, OLD_A, OLD_B],
    })
    expect(result.exit).toBe(1)
    expectOneSharedConnection(world)
  })

  it('tolerates a close that finds no master, and still succeeds', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES, closeBehaviour: 'fail'})
    const result = await run(world, ctx => tracesSenderListAction({}, ctx, makeDeps(world)), {secrets: []})
    expect(result.exit).toBeNull()
    expectOneSharedConnection(world)
  })

  it('makes no close and leaves no directory when the command is refused before any ssh call', async () => {
    const world = createWorld({configured: 'held', files: OLD_FILES})
    const result = await run(world, ctx => tracesSenderAddAction('not-a-group', noOptions, ctx, makeDeps(world)), {
      secrets: [],
    })
    expect(result.exit).toBe(1)
    expect(world.calls).toHaveLength(0)
    expect(world.closes).toHaveLength(0)
  })
})
