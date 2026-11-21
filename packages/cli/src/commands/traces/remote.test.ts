import {Buffer} from 'node:buffer'
import {existsSync, statSync} from 'node:fs'
import {dirname} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {CAN_LOCK, controlPathOf, controlPaths, createScratchHost, recordingSpawn} from './__fixtures__/remote-fixture'
import {TRACES_APP_DIR} from './host'
import {
  buildRemoteArgv,
  buildTunnelArgv,
  CONTROL_PERSIST,
  DEPLOY_FINISHED_SENTINEL,
  DEPLOY_UNFINISHED_SENTINEL,
  hasSentinel,
  ingestStateSentinel,
  LOCK_BUSY_SENTINEL,
  OPEN_REFUSED_SENTINEL,
  REMOTE_COMMANDS,
  runRemote,
  TRACES_DEPLOY_MARKER,
  TRACES_INGEST_LOCK,
  TRACES_PENDING_RESTARTS,
  withRemoteSession,
  type IngestState,
  type SpawnFn,
} from './remote'

let savedKey: string | undefined

beforeEach(() => {
  savedKey = process.env.TRACES_SSH_KEY
  delete process.env.TRACES_SSH_KEY
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TRACES_SSH_KEY
  else process.env.TRACES_SSH_KEY = savedKey
})

/** Every remote command the traces commands can send, with each parameter set to a value it takes. */
const commands: [string, string][] = [
  ['composePs', REMOTE_COMMANDS.composePs],
  ['reporterDetail', REMOTE_COMMANDS.reporterDetail],
  ['readIngestState', REMOTE_COMMANDS.readIngestState],
  ['readDeployState', REMOTE_COMMANDS.readDeployState],
  ['logs', REMOTE_COMMANDS.logs('collector', 100)],
  ['write held', REMOTE_COMMANDS.writeIngestState('held')],
  ['write open', REMOTE_COMMANDS.writeIngestState('open')],
]

/** The one descriptor redirect the ingest scripts make: descriptor 9 onto the lock file. */
const LOCK_REDIRECT = 'exec 9>>"$l"'
const withoutLockRedirect = (command: string): string => command.replace(LOCK_REDIRECT, '')

describe('remote command hygiene', () => {
  it.each(commands)('%s: no redirect to the null device or any device file, no deletion', (_name, command) => {
    expect(command).not.toContain('/dev/')
    expect(command).not.toMatch(/\d?>&?\s*\/dev/)
    expect(withoutLockRedirect(command)).not.toMatch(/(^|[\s;&|])\d>/)
    expect(command).not.toContain('&>')
    expect(command).not.toMatch(/\brm\b/)
  })

  it.each(commands)('%s: no shell-quoting hazard from a caller value', (_name, command) => {
    expect(command).not.toContain('$@')
    expect(command).not.toContain('eval')
    expect(command).not.toContain('`')
  })

  it('only the state write redirects at all: into its temporary file, and descriptor 9 onto the lock file', () => {
    for (const [name, command] of commands) {
      const redirects = [...withoutLockRedirect(command).matchAll(/>/g)].length
      if (name.startsWith('write ')) {
        expect(command).toContain('> "$t"')
        expect(command).toContain(LOCK_REDIRECT)
        expect(command).toContain(`l=${TRACES_INGEST_LOCK}`)
        expect(redirects).toBe(1)
      } else {
        expect(redirects).toBe(0)
      }
    }
  })

  it('the state write works inside the app directory and ends with its sentinel', () => {
    for (const state of ['held', 'open'] as const) {
      const command = REMOTE_COMMANDS.writeIngestState(state)
      const steps = command.split('; ')
      expect(steps[0]).toBe('set -e')
      expect(steps[1]).toBe(`cd ${TRACES_APP_DIR}`)
      expect(steps.at(-1)).toBe(`echo ${ingestStateSentinel(state)}`)
      // The temporary file is created in the app directory, then moved over `.env`.
      expect(command).toContain('t=$(mktemp ./.env.XXXXXX)')
      expect(command).toContain('mv "$t" .env')
      // `.env` must exist: this never creates one.
      expect(command).toContain('test -f .env')
    }
  })

  it('the state write recreates only Caddy, without its dependencies', () => {
    const command = REMOTE_COMMANDS.writeIngestState('held')
    const up = command.split('; ').find(step => step.includes(' up '))
    expect(up).toBe(`docker compose --project-directory ${TRACES_APP_DIR} up -d --force-recreate --no-deps caddy`)
  })

  it('carries no value from the caller: the state is a fixed word and the new line travels on stdin', () => {
    const states: IngestState[] = ['held', 'open']
    for (const state of states)
      expect(REMOTE_COMMANDS.writeIngestState(state)).not.toContain('TRACES_INGEST_STATE=held\n')
    expect(REMOTE_COMMANDS.writeIngestState('held')).not.toBe(REMOTE_COMMANDS.writeIngestState('open'))
  })

  it('every command that touches compose names the app directory', () => {
    for (const [, command] of commands) {
      if (command.includes('docker compose')) expect(command).toContain(`--project-directory ${TRACES_APP_DIR}`)
    }
  })

  it('the reporter read is an exec of wget on the loopback listener, followed by its sentinel', () => {
    expect(REMOTE_COMMANDS.reporterDetail).toContain(
      'exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail',
    )
    expect(REMOTE_COMMANDS.reporterDetail.endsWith('echo TRACES_DETAIL_END')).toBe(true)
  })
})

// ─── The ingest lock and the deploy hold ──────────────────────────────────────────────────────

describe('the ingest state scripts take the ingest lock', () => {
  const open = REMOTE_COMMANDS.writeIngestState('open')
  const hold = REMOTE_COMMANDS.writeIngestState('held')
  const take = `flock -w 30 9 || { echo ${LOCK_BUSY_SENTINEL}; exit 1; }`
  const refusal = `if [ -e ${TRACES_DEPLOY_MARKER} ] || [ -e ${TRACES_PENDING_RESTARTS} ]; then echo ${OPEN_REFUSED_SENTINEL}; exit 0; fi`

  it.each([
    ['open', open],
    ['hold', hold],
  ])(
    '%s takes the lock for 30 s before it reads or writes anything, and a busy lock has its own sentinel',
    (_n, command) => {
      expect(command).toContain(`l=${TRACES_INGEST_LOCK}`)
      expect(command).toContain(take)
      expect(command.indexOf(take)).toBeLessThan(command.indexOf('test -f .env'))
      expect(command.indexOf(take)).toBeLessThan(command.indexOf('mktemp'))
      expect(command.indexOf(take)).toBeLessThan(command.indexOf('mv "$t" .env'))
      expect(command).not.toContain('flock -u')
      expect(command).not.toContain('flock -n')
    },
  )

  it('open refuses on the host, inside the same locked script, after the lock and before any write', () => {
    expect(open).toContain(refusal)
    expect(open.indexOf(take)).toBeLessThan(open.indexOf(refusal))
    expect(open.indexOf(refusal)).toBeLessThan(open.indexOf('mktemp'))
    expect(open.indexOf(refusal)).toBeLessThan(open.indexOf('mv "$t" .env'))
    expect(open.indexOf(refusal)).toBeLessThan(open.indexOf(' up -d '))
    // One script: the check and the write are not two ssh calls.
    expect(open).toContain(`echo ${ingestStateSentinel('open')}`)
  })

  it('hold never looks at the deploy files', () => {
    expect(hold).not.toContain(TRACES_DEPLOY_MARKER)
    expect(hold).not.toContain(TRACES_PENDING_RESTARTS)
    expect(hold).not.toContain(OPEN_REFUSED_SENTINEL)
  })

  it('the deploy-state probe reads only: no lock, no write', () => {
    const probe = REMOTE_COMMANDS.readDeployState
    expect(probe).toContain(TRACES_DEPLOY_MARKER)
    expect(probe).toContain(TRACES_PENDING_RESTARTS)
    expect(probe).not.toContain('flock')
    expect(probe).toContain(DEPLOY_UNFINISHED_SENTINEL)
    expect(probe).toContain(DEPLOY_FINISHED_SENTINEL)
  })

  it('the sentinels are distinct from each other and from the state sentinels', () => {
    const all = [
      LOCK_BUSY_SENTINEL,
      OPEN_REFUSED_SENTINEL,
      DEPLOY_FINISHED_SENTINEL,
      DEPLOY_UNFINISHED_SENTINEL,
      ingestStateSentinel('held'),
      ingestStateSentinel('open'),
    ]
    expect(new Set(all).size).toBe(all.length)
  })
})

describe('the ingest state scripts, run for real on a scratch host', () => {
  const OPEN_STDIN = 'TRACES_INGEST_STATE=open\n'
  const HELD_STDIN = 'TRACES_INGEST_STATE=held\n'
  const cleanups: (() => void)[] = []
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup()
  })
  function scratch() {
    const host = createScratchHost()
    cleanups.push(host.cleanup)
    return host
  }

  const requiresLock = CAN_LOCK ? it : it.skip

  requiresLock('open with neither file present writes the line and recreates only Caddy', () => {
    const host = scratch()
    const result = host.run(REMOTE_COMMANDS.writeIngestState('open'), OPEN_STDIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(ingestStateSentinel('open'))
    expect(host.env()).toBe('FOO=bar\nTRACES_INGEST_STATE=open\n')
    expect(host.dockerCalls()).toEqual([
      `compose --project-directory ${host.dir} up -d --force-recreate --no-deps caddy`,
    ])
    expect(host.strays()).toEqual([])
  })

  requiresLock.each([
    ['the deploy marker', '.deploy-in-progress'],
    ['the pending-restarts file', '.pending-restarts'],
  ])('open with %s present is refused, exit 0, and changes nothing', (_label, file) => {
    const host = scratch()
    host.touch(file)
    const result = host.run(REMOTE_COMMANDS.writeIngestState('open'), OPEN_STDIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(OPEN_REFUSED_SENTINEL)
    expect(result.stdout).not.toContain(ingestStateSentinel('open'))
    expect(host.env()).toBe('FOO=bar\nTRACES_INGEST_STATE=held\n')
    expect(host.dockerCalls()).toEqual([])
    expect(host.strays()).toEqual([])
  })

  requiresLock('open with both files present is refused too', () => {
    const host = scratch()
    host.touch('.deploy-in-progress')
    host.touch('.pending-restarts')
    expect(host.run(REMOTE_COMMANDS.writeIngestState('open'), OPEN_STDIN).stdout).toContain(OPEN_REFUSED_SENTINEL)
    expect(host.dockerCalls()).toEqual([])
  })

  requiresLock.each([
    ['the deploy marker', ['.deploy-in-progress']],
    ['the pending-restarts file', ['.pending-restarts']],
    ['both', ['.deploy-in-progress', '.pending-restarts']],
    ['neither', []],
  ])('hold with %s present is never refused', (_label, files) => {
    const host = scratch()
    for (const file of files) host.touch(file)
    const result = host.run(REMOTE_COMMANDS.writeIngestState('held'), HELD_STDIN)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(ingestStateSentinel('held'))
    expect(result.stdout).not.toContain(OPEN_REFUSED_SENTINEL)
    expect(host.dockerCalls()).toHaveLength(1)
  })

  requiresLock('a lock another process holds makes open fail with its own sentinel and change nothing', async () => {
    const host = scratch()
    const release = await host.holdLock(TRACES_INGEST_LOCK)
    try {
      // The script waits 30 s; the test shortens the wait. The text assertions above pin the real value.
      const command = REMOTE_COMMANDS.writeIngestState('open').replace('flock -w 30 9', 'flock -w 1 9')
      const result = host.run(command, OPEN_STDIN)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain(LOCK_BUSY_SENTINEL)
      expect(host.env()).toBe('FOO=bar\nTRACES_INGEST_STATE=held\n')
      expect(host.dockerCalls()).toEqual([])
    } finally {
      release()
    }
  })

  requiresLock('a lock another process holds makes hold fail the same way, not silently', async () => {
    const host = scratch()
    const release = await host.holdLock(TRACES_INGEST_LOCK)
    try {
      const command = REMOTE_COMMANDS.writeIngestState('held').replace('flock -w 30 9', 'flock -w 1 9')
      const result = host.run(command, HELD_STDIN)
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain(LOCK_BUSY_SENTINEL)
      expect(host.dockerCalls()).toEqual([])
    } finally {
      release()
    }
  })

  it.each([
    ['neither file', [], DEPLOY_FINISHED_SENTINEL],
    ['the marker', ['.deploy-in-progress'], DEPLOY_UNFINISHED_SENTINEL],
    ['the pending restarts', ['.pending-restarts'], DEPLOY_UNFINISHED_SENTINEL],
  ] as const)('the deploy-state probe with %s prints the matching sentinel', (_label, files, sentinel) => {
    const host = scratch()
    for (const file of files) host.touch(file)
    const result = host.run(REMOTE_COMMANDS.readDeployState)
    expect(hasSentinel(result, sentinel)).toBe(true)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
  })
})

describe('constants match the app', async () => {
  const hostSource = await Bun.file(new URL('../../../../../apps/traces/src/host.ts', import.meta.url)).text()
  const expand = (value: string): string => value.replaceAll(['$', '{TRACES_APP_DIR}'].join(''), TRACES_APP_DIR)
  const valueOf = (name: string): string | undefined => {
    const match = new RegExp(`${name}\\s*=\\s*(['"\`])(.*?)\\1`).exec(hostSource)
    return match?.[2] === undefined ? undefined : expand(match[2])
  }

  it.each([
    ['TRACES_DEPLOY_MARKER', TRACES_DEPLOY_MARKER, '/mnt/traces/app/.deploy-in-progress'],
    ['TRACES_PENDING_RESTARTS', TRACES_PENDING_RESTARTS, '/mnt/traces/app/.pending-restarts'],
    ['TRACES_INGEST_LOCK', TRACES_INGEST_LOCK, '/mnt/traces/app/.ingest.lock'],
  ])('%s is the path apps/traces names', (name, copy, contract) => {
    expect(copy).toBe(contract)
    expect(valueOf(name)).toBe(copy)
  })
})

describe('buildRemoteArgv', () => {
  it('puts the validated host and then the remote command last, and nothing else varies', () => {
    const {argv, cleanup} = buildRemoteArgv('traces.example.invalid', 'true')
    cleanup()
    expect(argv.at(-2)).toBe('root@traces.example.invalid')
    expect(argv.at(-1)).toBe('true')
    expect(argv[0]).toBe('ssh')
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv.some(arg => arg.startsWith('UserKnownHostsFile='))).toBe(true)
    expect(argv).not.toContain('StrictHostKeyChecking=no')
  })

  it('refuses a bad host for both the command and the tunnel', () => {
    for (const bad of ['-oProxyCommand=evil', '', 'a b', 'a;b']) {
      expect(() => buildRemoteArgv(bad, 'true')).toThrow('Invalid TRACES_HOST')
      expect(() => buildTunnelArgv(bad, {langfuse: 3000, grafana: 3001})).toThrow('Invalid TRACES_HOST')
    }
  })
})

describe('runRemote', () => {
  it('sends stdin as bytes and never puts it in the argv', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await runRemote('traces.example.invalid', 'cat', {spawn, stdin: 'SECRET-LINE-PLACEHOLDER\n'})
    expect(calls[0]?.stdin).toBe('SECRET-LINE-PLACEHOLDER\n')
    expect(calls[0]?.argv.join(' ')).not.toContain('SECRET-LINE-PLACEHOLDER')
  })

  it('does not connect stdin when none is given', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await runRemote('traces.example.invalid', 'true', {spawn})
    expect(calls[0]?.options.stdin).toBeUndefined()
  })

  it('removes the host from standard error', async () => {
    const {spawn} = recordingSpawn(() => ({
      stderr: 'ssh: connect to host Traces.Example.Invalid port 22',
      exitCode: 255,
    }))
    const result = await runRemote('traces.example.invalid', 'true', {spawn})
    expect(result.exitCode).toBe(255)
    expect(result.stderr).not.toContain('nvalid')
    expect(result.stderr).toContain('<host>')
  })

  it('passes only PATH, HOME and the agent socket to the child', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    process.env.TRACES_SSH_KEY = ''
    await runRemote('traces.example.invalid', 'true', {spawn})
    const keys = Object.keys(calls[0]?.options.env ?? {})
    for (const key of keys) expect(['PATH', 'HOME', 'SSH_AUTH_SOCK']).toContain(key)
  })
})

// ─── One multiplexed connection per command ───────────────────────────────────────────────────
//
// The host rate-limits new ssh connections (`ufw limit 22/tcp`: six from one source in 30 seconds and the
// seventh is refused for about 30 seconds), so a command that makes several calls must make them over one.

const HOST = 'traces.example.invalid'
const CONTROL_OPTIONS = ['ControlMaster=auto', 'ControlPersist=']

describe('the control options on the ssh argv', () => {
  it('a call with a control path carries ControlMaster=auto, that ControlPath and a short ControlPersist', () => {
    const {argv, cleanup} = buildRemoteArgv(HOST, 'true', '/tmp/tr-abc123/cm')
    cleanup()
    expect(argv).toContain('ControlMaster=auto')
    expect(argv).toContain('ControlPath=/tmp/tr-abc123/cm')
    expect(argv).toContain(`ControlPersist=${CONTROL_PERSIST}`)
    // Each option is the value of its own -o, never glued into another argument.
    for (const value of ['ControlMaster=auto', 'ControlPath=/tmp/tr-abc123/cm', `ControlPersist=${CONTROL_PERSIST}`]) {
      expect(argv[argv.indexOf(value) - 1]).toBe('-o')
    }
  })

  it('keeps host-key checking, the pinned keys and the command last when it multiplexes', () => {
    const {argv, cleanup} = buildRemoteArgv(HOST, 'true', '/tmp/tr-abc123/cm')
    cleanup()
    expect(argv).toContain('StrictHostKeyChecking=yes')
    expect(argv).toContain('BatchMode=yes')
    expect(argv.some(arg => arg.startsWith('UserKnownHostsFile='))).toBe(true)
    expect(argv.at(-2)).toBe(`root@${HOST}`)
    expect(argv.at(-1)).toBe('true')
  })

  it('a call without a control path carries none of the three options', () => {
    const {argv, cleanup} = buildRemoteArgv(HOST, 'true')
    cleanup()
    for (const option of CONTROL_OPTIONS) expect(argv.some(arg => arg.startsWith(option))).toBe(false)
    expect(argv.some(arg => arg.startsWith('ControlPath='))).toBe(false)
  })

  it('the tunnel carries none of them: a tunnel on a shared master would die with it', () => {
    const {argv, cleanup} = buildTunnelArgv(HOST, {langfuse: 3000, grafana: 3001})
    cleanup()
    for (const option of [...CONTROL_OPTIONS, 'ControlPath=']) {
      expect(argv.some(arg => arg.startsWith(option))).toBe(false)
    }
  })

  it('ControlPersist is short: long enough to bridge the gaps in one command, short enough not to outlive it', () => {
    expect(CONTROL_PERSIST).toBe('30s')
  })
})

/**
 * An ssh spawner whose calls stay running until `release(name, exitCode)`, and that counts how many run at once.
 * `throwOn` names the calls whose spawn itself throws. A close (`ssh -O exit`) is counted and noted in the event order.
 */
function heldSpawn({throwOn = []}: {throwOn?: string[]} = {}) {
  const events: string[] = []
  const holds = new Map<string, (exitCode: number) => void>()
  let running = 0
  let maxRunning = 0
  const spawn: SpawnFn = argv => {
    if (argv.includes('-O')) {
      events.push('close')
      return {stdout: null, stderr: null, exited: Promise.resolve(0)}
    }
    const name = argv.at(-1) ?? ''
    events.push(`start ${name}`)
    if (throwOn.includes(name)) throw new Error('spawn ssh ENOENT')
    running += 1
    maxRunning = Math.max(maxRunning, running)
    const exited = new Promise<number>(resolve => {
      holds.set(name, exitCode => {
        running -= 1
        events.push(`end ${name}`)
        resolve(exitCode)
      })
    })
    return {stdout: null, stderr: null, exited}
  }
  return {
    spawn,
    release: (name: string, exitCode: number) => holds.get(name)?.(exitCode),
    starts: () => events.filter(event => event.startsWith('start ')).map(event => event.slice('start '.length)),
    running: () => running,
    maxRunning: () => maxRunning,
    closes: () => events.filter(event => event === 'close').length,
    lastEvent: () => events.at(-1),
  }
}

describe('withRemoteSession', () => {
  it('every call in a session carries the same ControlPath, and no secret is in the argv', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await withRemoteSession(spawn, async session => {
      await runRemote(HOST, 'one', {spawn, session})
      await runRemote(HOST, 'two', {spawn, session, stdin: 'SECRET-LINE-PLACEHOLDER\n'})
      await runRemote(HOST, 'three', {spawn, session})
    })
    expect(calls).toHaveLength(3)
    const paths = controlPaths(calls)
    expect(paths).toHaveLength(1)
    expect(paths[0]).toBeDefined()
    for (const call of calls) expect(call.argv).toContain('ControlMaster=auto')
    expect(calls.map(call => call.argv.join(' ')).join('\n')).not.toContain('SECRET-LINE-PLACEHOLDER')
  })

  it('two runs use different ControlPaths, each in its own private directory', async () => {
    const first = recordingSpawn(() => ({}))
    const second = recordingSpawn(() => ({}))
    const modes: number[] = []
    for (const {spawn} of [first, second]) {
      await withRemoteSession(spawn, async session => {
        await runRemote(HOST, 'true', {spawn, session})
        modes.push(statSync(dirname(session.controlPath)).mode & 0o777)
      })
    }
    const [one] = controlPaths(first.calls)
    const [two] = controlPaths(second.calls)
    expect(one).toBeDefined()
    expect(two).toBeDefined()
    expect(one).not.toBe(two)
    expect(dirname(one ?? '')).not.toBe(dirname(two ?? ''))
    expect(modes).toEqual([0o700, 0o700])
  })

  it('keeps the socket path short enough for a unix socket on macOS (about 104 bytes)', async () => {
    await withRemoteSession(recordingSpawn(() => ({})).spawn, async session => {
      expect(session.controlPath.startsWith('/tmp/')).toBe(true)
      // ssh appends a random suffix of about 17 characters to the path while it binds the socket.
      expect(Buffer.byteLength(session.controlPath) + 20).toBeLessThan(104)
    })
  })

  it('closes the master once, on the same socket, then removes the directory', async () => {
    const {spawn, calls, closes} = recordingSpawn(() => ({}))
    let directory = ''
    await withRemoteSession(spawn, async session => {
      directory = dirname(session.controlPath)
      await runRemote(HOST, 'a', {spawn, session})
      await runRemote(HOST, 'b', {spawn, session})
      expect(closes).toHaveLength(0)
    })
    expect(calls).toHaveLength(2)
    expect(closes).toHaveLength(1)
    expect(closes[0]?.controlPath).toBe(controlPathOf(calls[0]?.argv ?? []))
    expect(closes[0]?.argv.slice(0, 1)).toEqual(['ssh'])
    expect(closes[0]?.argv).toContain('exit')
    expect(closes[0]?.argv.at(-1)).toBe(`root@${HOST}`)
    // The socket was still there to name when the close was made; the directory goes after it.
    expect(closes[0]?.directoryExisted).toBe(true)
    expect(existsSync(directory)).toBe(false)
  })

  it('closes once and removes the directory when the body throws, and the error still propagates', async () => {
    const {spawn, closes} = recordingSpawn(() => ({}))
    let directory = ''
    await expect(
      withRemoteSession(spawn, async session => {
        directory = dirname(session.controlPath)
        await runRemote(HOST, 'a', {spawn, session})
        throw new Error('the command failed')
      }),
    ).rejects.toThrow('the command failed')
    expect(closes).toHaveLength(1)
    expect(existsSync(directory)).toBe(false)
  })

  it('closes once when the spawner itself throws on a call', async () => {
    const {spawn: inner, closes} = recordingSpawn(() => ({}))
    const spawn: SpawnFn = (argv, options) => {
      if (argv.at(-1) === 'boom') throw new Error('spawn ssh ENOENT')
      return inner(argv, options)
    }
    let directory = ''
    await expect(
      withRemoteSession(spawn, async session => {
        directory = dirname(session.controlPath)
        await runRemote(HOST, 'boom', {spawn, session})
      }),
    ).rejects.toThrow('spawn ssh ENOENT')
    expect(closes).toHaveLength(1)
    expect(existsSync(directory)).toBe(false)
  })

  it.each(['fail', 'throw'] as const)('a close that %ss is tolerated and the directory still goes', async behaviour => {
    const {spawn, closes} = recordingSpawn(() => ({}), behaviour)
    let directory = ''
    const value = await withRemoteSession(spawn, async session => {
      directory = dirname(session.controlPath)
      await runRemote(HOST, 'a', {spawn, session})
      return 'result'
    })
    expect(value).toBe('result')
    expect(closes).toHaveLength(1)
    expect(existsSync(directory)).toBe(false)
  })

  it('does not spend a close when no call went out, and still removes the directory', async () => {
    const {spawn, closes} = recordingSpawn(() => ({}))
    let directory = ''
    await withRemoteSession(spawn, async session => {
      directory = dirname(session.controlPath)
      expect(existsSync(directory)).toBe(true)
    })
    expect(closes).toHaveLength(0)
    expect(existsSync(directory)).toBe(false)
  })

  it('does not spend a close when the host was refused before any ssh was built', async () => {
    const {spawn, closes} = recordingSpawn(() => ({}))
    await expect(
      withRemoteSession(spawn, session => runRemote('-oProxyCommand=evil', 'true', {spawn, session})),
    ).rejects.toThrow('Invalid TRACES_HOST')
    expect(closes).toHaveLength(0)
  })

  it('the first call runs alone, so concurrent callers share one master instead of each making a connection', async () => {
    const events: string[] = []
    const releases: (() => void)[] = []
    const spawn: SpawnFn = (argv, options) => {
      const name = argv.at(-1) ?? ''
      if (argv.includes('-O')) return {stdout: null, stderr: null, exited: Promise.resolve(0)}
      events.push(`start ${name}`)
      const exited = new Promise<number>(resolve => {
        releases.push(() => {
          events.push(`end ${name}`)
          resolve(0)
        })
      })
      return {
        stdout: options.stdout === 'pipe' ? new Response('').body : null,
        stderr: options.stderr === 'pipe' ? new Response('').body : null,
        exited,
      }
    }
    const done = withRemoteSession(spawn, session =>
      Promise.all([
        runRemote(HOST, 'first', {spawn, session}),
        runRemote(HOST, 'second', {spawn, session}),
        runRemote(HOST, 'third', {spawn, session}),
      ]),
    )
    await Bun.sleep(10)
    // Only the first has started: the others wait for it, because only then does the master exist.
    expect(events).toEqual(['start first'])
    releases[0]?.()
    await Bun.sleep(10)
    expect(events.slice(0, 2)).toEqual(['start first', 'end first'])
    expect(events.filter(event => event.startsWith('start'))).toEqual(['start first', 'start second', 'start third'])
    for (const release of releases.slice(1)) release()
    await done
  })

  describe('while no call has connected yet', () => {
    const settle = () => Bun.sleep(10)
    const names = ['first', 'second', 'third', 'fourth', 'fifth']
    const runAll = (held: ReturnType<typeof heldSpawn>) =>
      withRemoteSession(held.spawn, session =>
        Promise.all(names.map(name => runRemote(HOST, name, {spawn: held.spawn, session}))),
      )

    it('a first call that exits 255 leaves the queued calls running one at a time until one connects, then all together', async () => {
      const held = heldSpawn()
      const done = runAll(held)
      await settle()
      expect(held.starts()).toEqual(['first'])

      held.release('first', 255)
      await settle()
      expect(held.starts()).toEqual(['first', 'second'])
      expect(held.running()).toBe(1)

      held.release('second', 255)
      await settle()
      expect(held.starts()).toEqual(['first', 'second', 'third'])
      expect(held.running()).toBe(1)

      // The third connects and becomes the master: the rest now go out together on its socket.
      held.release('third', 0)
      await settle()
      expect(held.starts()).toEqual(['first', 'second', 'third', 'fourth', 'fifth'])
      expect(held.running()).toBe(2)
      expect(held.maxRunning()).toBe(2)

      held.release('fourth', 0)
      held.release('fifth', 0)
      const results = await done
      expect(results.map(result => result.exitCode)).toEqual([255, 255, 0, 0, 0])
    })

    it('never runs two calls at once while every call fails to connect', async () => {
      const held = heldSpawn()
      const done = runAll(held)
      for (const name of names) {
        await settle()
        expect(held.running()).toBe(1)
        held.release(name, 255)
      }
      await done
      expect(held.starts()).toEqual(names)
      expect(held.maxRunning()).toBe(1)
    })

    it('a first call that exits non-zero but did connect (the remote command failed) frees the rest at once', async () => {
      const held = heldSpawn()
      const done = runAll(held)
      await settle()
      held.release('first', 1)
      await settle()
      expect(held.starts()).toEqual(names)
      for (const name of names.slice(1)) held.release(name, 0)
      await done
    })

    it('a first call that throws leaves the queued calls serial, and the close and clean-up wait for every one of them', async () => {
      const held = heldSpawn({throwOn: ['first']})
      let directory = ''
      const done = withRemoteSession(held.spawn, session => {
        directory = dirname(session.controlPath)
        return Promise.all(names.map(name => runRemote(HOST, name, {spawn: held.spawn, session})))
      })
      // Collect the outcome without awaiting it: the body rejects as soon as the first call throws.
      const outcome = done.then(
        () => 'resolved',
        (error: unknown) => (error instanceof Error ? error.message : 'rejected'),
      )
      await settle()
      // The body has already failed, yet the queued calls are still going: nothing is closed or removed under them.
      expect(held.starts()).toEqual(['first', 'second'])
      expect(held.running()).toBe(1)
      expect(held.closes()).toBe(0)
      expect(existsSync(directory)).toBe(true)

      held.release('second', 255)
      await settle()
      expect(held.starts()).toEqual(['first', 'second', 'third'])
      expect(held.closes()).toBe(0)

      held.release('third', 0)
      await settle()
      // Third connected, so the last two go together, and teardown is still waiting for them.
      expect(held.starts()).toEqual(names)
      expect(held.closes()).toBe(0)
      expect(existsSync(directory)).toBe(true)

      held.release('fourth', 0)
      await settle()
      expect(held.closes()).toBe(0)
      held.release('fifth', 0)
      expect(await outcome).toBe('spawn ssh ENOENT')
      expect(held.closes()).toBe(1)
      expect(held.lastEvent()).toBe('close')
      expect(existsSync(directory)).toBe(false)
    })
  })

  it('a first call that fails does not stop the others from running', async () => {
    const {spawn, calls} = recordingSpawn(call => (call.command === 'first' ? {exitCode: 255} : {}))
    const results = await withRemoteSession(spawn, session =>
      Promise.all([runRemote(HOST, 'first', {spawn, session}), runRemote(HOST, 'second', {spawn, session})]),
    )
    expect(results.map(result => result.exitCode)).toEqual([255, 0])
    expect(calls).toHaveLength(2)
  })

  it('refuses to share a session between two hosts', async () => {
    const {spawn} = recordingSpawn(() => ({}))
    await expect(
      withRemoteSession(spawn, async session => {
        await runRemote(HOST, 'a', {spawn, session})
        await runRemote('other.example.invalid', 'b', {spawn, session})
      }),
    ).rejects.toThrow('one host')
  })

  it('runRemote without a session adds no control options', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await runRemote(HOST, 'true', {spawn})
    expect(controlPaths(calls)).toEqual([undefined])
  })
})

describe('hasSentinel', () => {
  const result = (stdout: string, exitCode = 0) => ({exitCode, stdout, stderr: ''})

  it('needs exit 0 and a line that is exactly the sentinel', () => {
    expect(hasSentinel(result('x\nTRACES_INGEST_STATE_SET=held\n'), 'TRACES_INGEST_STATE_SET=held')).toBe(true)
    expect(hasSentinel(result('TRACES_INGEST_STATE_SET=held\n', 1), 'TRACES_INGEST_STATE_SET=held')).toBe(false)
    expect(hasSentinel(result('prefixTRACES_INGEST_STATE_SET=held\n'), 'TRACES_INGEST_STATE_SET=held')).toBe(false)
    expect(hasSentinel(result('TRACES_INGEST_STATE_SET=open\n'), 'TRACES_INGEST_STATE_SET=held')).toBe(false)
    expect(hasSentinel(result(''), 'TRACES_INGEST_STATE_SET=held')).toBe(false)
  })
})
