import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {recordingSpawn} from './__fixtures__/remote-fixture'
import {TRACES_APP_DIR} from './host'
import {
  buildRemoteArgv,
  buildTunnelArgv,
  hasSentinel,
  ingestStateSentinel,
  REMOTE_COMMANDS,
  runRemote,
  type IngestState,
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
  ['logs', REMOTE_COMMANDS.logs('collector', 100)],
  ['write held', REMOTE_COMMANDS.writeIngestState('held')],
  ['write open', REMOTE_COMMANDS.writeIngestState('open')],
]

describe('remote command hygiene', () => {
  it.each(commands)('%s: no redirect to the null device or any device file, no deletion', (_name, command) => {
    expect(command).not.toContain('/dev/')
    expect(command).not.toMatch(/\d?>&?\s*\/dev/)
    expect(command).not.toMatch(/(^|[\s;&|])\d>/)
    expect(command).not.toContain('&>')
    expect(command).not.toMatch(/\brm\b/)
  })

  it.each(commands)('%s: no shell-quoting hazard from a caller value', (_name, command) => {
    expect(command).not.toContain('$@')
    expect(command).not.toContain('eval')
    expect(command).not.toContain('`')
  })

  it('only the state write redirects at all, and only into its temporary file', () => {
    for (const [name, command] of commands) {
      const redirects = [...command.matchAll(/>/g)].length
      if (name.startsWith('write ')) {
        expect(command).toContain('> "$t"')
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
