import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {recordingSpawn} from './__fixtures__/remote-fixture'
import {streamTracesLogs, validateService, validateTail} from './logs'
import {REMOTE_COMMANDS} from './remote'

const ENV_KEYS = ['CI', 'TRACES_SSH_KEY'] as const
let saved: Record<string, string | undefined> = {}

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
  delete process.env.TRACES_SSH_KEY
  delete process.env.CI
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const base = {host: 'traces.example.invalid', service: 'collector', tail: 100, allowCi: false}

describe('validateService and validateTail', () => {
  it('accepts every compose service and nothing else', () => {
    expect(() => validateService('collector')).not.toThrow()
    expect(() => validateService('health-reporter')).not.toThrow()
    for (const bad of ['', 'umami', 'collector; id', '--follow', 'collector extra']) {
      expect(() => validateService(bad)).toThrow('Invalid service')
    }
  })

  it('accepts a whole number from 1 to 10000 only', () => {
    expect(validateTail(1)).toBe(1)
    expect(validateTail(10_000)).toBe(10_000)
    for (const bad of [0, -1, 10_001, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => validateTail(bad)).toThrow('Invalid --tail')
    }
  })
})

describe('streamTracesLogs', () => {
  it('runs docker compose logs for the service over ssh, attached to the terminal, and warns first', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    const warnings: string[] = []
    const result = await streamTracesLogs(base, spawn, undefined, message => warnings.push(message))
    expect(result).toEqual({refused: false, exitCode: 0})
    expect(calls[0]?.command).toBe(REMOTE_COMMANDS.logs('collector', 100))
    expect(calls[0]?.command).toContain('logs --no-color --tail=100 collector')
    expect(calls[0]?.argv.at(-2)).toBe('root@traces.example.invalid')
    expect(calls[0]?.options.stdout).toBe('inherit')
    expect(warnings.join(' ')).toContain('prompt text')
    expect(warnings.join(' ')).toContain('sensitive')
  })

  it('refuses in CI without --allow-ci, and warns and proceeds with it', async () => {
    process.env.CI = 'true'
    const refused = recordingSpawn(() => ({}))
    const messages: string[] = []
    expect(await streamTracesLogs(base, refused.spawn, message => messages.push(message))).toEqual({refused: true})
    expect(refused.calls).toHaveLength(0)
    expect(messages.join('')).toContain('Refusing to stream logs in CI')

    const allowed = recordingSpawn(() => ({}))
    expect((await streamTracesLogs({...base, allowCi: true}, allowed.spawn, undefined, () => undefined)).refused).toBe(
      false,
    )
    expect(allowed.calls).toHaveLength(1)
  })

  it('rejects a bad service, tail or host before any ssh', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await expect(streamTracesLogs({...base, service: 'x; id'}, spawn)).rejects.toThrow('Invalid service')
    await expect(streamTracesLogs({...base, tail: 0}, spawn)).rejects.toThrow('Invalid --tail')
    await expect(
      streamTracesLogs({...base, host: '-oProxyCommand=evil'}, spawn, undefined, () => undefined),
    ).rejects.toThrow('Invalid TRACES_HOST')
    expect(calls).toHaveLength(0)
  })

  it('stays on a plain connection: one long-lived ssh with no control options and no close', async () => {
    const {spawn, calls, closes} = recordingSpawn(() => ({}))
    await streamTracesLogs(base, spawn, undefined, () => undefined)
    const argv = calls[0]?.argv ?? []
    expect(argv.some(arg => arg.startsWith('Control'))).toBe(false)
    expect(argv).not.toContain('-O')
    expect(calls).toHaveLength(1)
    expect(closes).toHaveLength(0)
  })

  it('returns the remote exit code', async () => {
    const {spawn} = recordingSpawn(() => ({exitCode: 3}))
    expect((await streamTracesLogs(base, spawn, undefined, () => undefined)).exitCode).toBe(3)
  })
})
