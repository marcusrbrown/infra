import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {recordingSpawn} from './__fixtures__/remote-fixture'
import {TUNNEL_PORTS} from './host'
import {openTracesTunnel, TUNNEL_URLS} from './open'
import {buildTunnelArgv} from './remote'

let savedKey: string | undefined

beforeEach(() => {
  savedKey = process.env.TRACES_SSH_KEY
  delete process.env.TRACES_SSH_KEY
})

afterEach(() => {
  if (savedKey === undefined) delete process.env.TRACES_SSH_KEY
  else process.env.TRACES_SSH_KEY = savedKey
})

describe('traces open', () => {
  it('hands ssh exactly one -N command forwarding only Langfuse and Grafana from loopback', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await openTracesTunnel('traces.example.invalid', spawn, () => undefined)

    expect(calls).toHaveLength(1)
    expect(calls[0]?.argv).toEqual([
      'ssh',
      '-N',
      '-o',
      'BatchMode=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      'ConnectTimeout=10',
      ...buildKnownHostsArgs(),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-L',
      '127.0.0.1:3000:127.0.0.1:3000',
      '-L',
      '127.0.0.1:3001:127.0.0.1:3001',
      'root@traces.example.invalid',
    ])
  })

  it('forwards no port beyond the two, and uses no other forwarding or agent option', async () => {
    const {spawn, calls} = recordingSpawn(() => ({}))
    await openTracesTunnel('traces.example.invalid', spawn, () => undefined)
    const argv = calls[0]?.argv ?? []

    const forwards = argv.flatMap((arg, index) => (arg === '-L' ? [argv[index + 1]] : []))
    expect(forwards).toEqual(['127.0.0.1:3000:127.0.0.1:3000', '127.0.0.1:3001:127.0.0.1:3001'])
    for (const forbidden of ['-R', '-D', '-W', '-A', '-g', '-X', '-Y', '-J', '-w'])
      expect(argv).not.toContain(forbidden)
    // The host is the last argument and nothing runs on it.
    expect(argv.at(-1)).toBe('root@traces.example.invalid')
    // An argv array handed to the spawner, never a shell string.
    expect(argv).not.toContain('sh')
    expect(argv).not.toContain('-c')
  })

  it('keeps the local ports equal to the host ports Langfuse and Grafana are configured for', () => {
    expect(TUNNEL_PORTS).toEqual({langfuse: 3000, grafana: 3001})
    expect(TUNNEL_URLS).toEqual({langfuse: 'http://localhost:3000', grafana: 'http://localhost:3001'})
  })

  it('prints the two local URLs before it connects', async () => {
    const printed: string[] = []
    const {spawn, calls} = recordingSpawn(() => ({}))
    await openTracesTunnel('traces.example.invalid', spawn, line => {
      printed.push(line)
      expect(calls).toHaveLength(0)
    })
    expect(printed.join('\n')).toContain('http://localhost:3000')
    expect(printed.join('\n')).toContain('http://localhost:3001')
  })

  it('attaches ssh to this terminal and returns its exit code', async () => {
    const {spawn, calls} = recordingSpawn(() => ({exitCode: 255}))
    const result = await openTracesTunnel('traces.example.invalid', spawn, () => undefined)
    expect(result.exitCode).toBe(255)
    expect(calls[0]?.options.stdout).toBe('inherit')
    expect(calls[0]?.options.stderr).toBe('inherit')
  })

  it('validates the host before printing or spawning anything', async () => {
    const printed: string[] = []
    const {spawn, calls} = recordingSpawn(() => ({}))
    for (const bad of ['-oProxyCommand=evil', '', 'host;id', 'a b', 'user@host']) {
      await expect(openTracesTunnel(bad, spawn, line => printed.push(line))).rejects.toThrow('Invalid TRACES_HOST')
    }
    expect(calls).toHaveLength(0)
    expect(printed).toEqual([])
  })

  it('adds the identity file when a key is set in the environment, and removes it afterwards', async () => {
    process.env.TRACES_SSH_KEY = 'placeholder-not-a-real-key'
    const {spawn, calls} = recordingSpawn(() => ({}))
    await openTracesTunnel('traces.example.invalid', spawn, () => undefined)
    const argv = calls[0]?.argv ?? []
    const index = argv.indexOf('-i')
    expect(index).toBeGreaterThan(-1)
    expect(argv).toContain('IdentitiesOnly=yes')
    const keyPath = argv[index + 1] ?? ''
    expect(await Bun.file(keyPath).exists()).toBe(false)
  })

  it('builds the same argv the command runs', () => {
    const {argv, cleanup} = buildTunnelArgv('traces.example.invalid', TUNNEL_PORTS)
    cleanup()
    expect(argv.filter(arg => arg === '-L')).toHaveLength(2)
  })
})
