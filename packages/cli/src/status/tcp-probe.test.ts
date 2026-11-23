import {EventEmitter} from 'node:events'

import {describe, expect, it} from 'bun:test'

import {
  classifyConnectError,
  createNetConnect,
  parseProbeHost,
  tcpReach,
  type TcpConnect,
  type TcpFailureReason,
} from './tcp-probe'

// TEST-NET-3 (RFC 5737): never a real address.
const HOST = '203.0.113.7'

function failingWith(code: string): TcpConnect {
  return async () => {
    throw Object.assign(new Error(`connect ${code} ${HOST}:22`), {code})
  }
}

describe('parseProbeHost', () => {
  it.each([undefined, '', '   ', '\n'])('treats %p as missing', value => {
    expect(parseProbeHost(value)).toEqual({kind: 'missing'})
  })

  it.each([HOST, 'vpn.example.com', 'localhost', 'a'])('accepts %p', value => {
    expect(parseProbeHost(value)).toEqual({kind: 'valid', host: value})
  })

  it('trims surrounding whitespace, so a secret saved with a newline still works', () => {
    expect(parseProbeHost(`${HOST}\n`)).toEqual({kind: 'valid', host: HOST})
  })

  it.each([
    ['a port', `${HOST}:22`],
    ['a scheme', `ssh://${HOST}`],
    ['a leading dash (ssh would read it as a flag)', '-oProxyCommand=x'],
    ['a path', `${HOST}/x`],
    ['a space inside', `${HOST} x`],
    ['an IPv6 literal', '2001:db8::1'],
    ['a user', `root@${HOST}`],
    ['an over-long name', `${'a'.repeat(254)}`],
  ])('rejects %s', (_label, value) => {
    expect(parseProbeHost(value)).toEqual({kind: 'invalid'})
  })
})

describe('classifyConnectError', () => {
  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ECONNREFUSED', 'refused'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['ECONNRESET', 'error'],
    ['EWHATEVER', 'error'],
  ] as [string, TcpFailureReason][])('maps %s to %s', (code, reason) => {
    expect(classifyConnectError(Object.assign(new Error('x'), {code}))).toBe(reason)
  })

  it.each([new Error('no code'), 'a string', null, undefined, {code: 42}])('maps %p to error', value => {
    expect(classifyConnectError(value)).toBe('error')
  })
})

describe('tcpReach', () => {
  it('passes when the connection is accepted, connecting to the host and port once', async () => {
    const targets: {host: string; port: number}[] = []
    const outcome = await tcpReach(HOST, 22, {
      timeoutMs: 1000,
      connect: async target => {
        targets.push(target)
      },
    })

    expect(outcome.ok).toBe(true)
    expect(targets).toEqual([{host: HOST, port: 22}])
    expect(outcome.durationMs).toBeGreaterThanOrEqual(0)
  })

  it.each([
    ['ETIMEDOUT', 'timeout'],
    ['ECONNREFUSED', 'refused'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENOTFOUND', 'dns'],
    ['ECONNRESET', 'error'],
  ])('reports %s as the fixed reason %s', async (code, reason) => {
    const outcome = await tcpReach(HOST, 22, {timeoutMs: 1000, retries: 0, connect: failingWith(code)})

    expect(outcome).toMatchObject({ok: false, reason})
    // The outcome is a closed shape: no error text, no address.
    expect(JSON.stringify(outcome)).not.toContain(HOST)
    expect(JSON.stringify(outcome)).not.toContain('connect')
  })

  it('reports a connect that never settles as a timeout, and aborts the signal it handed out', async () => {
    let aborted = false
    const outcome = await tcpReach(HOST, 22, {
      timeoutMs: 20,
      retries: 0,
      connect: (_target, signal) => {
        signal.addEventListener('abort', () => {
          aborted = true
        })
        return new Promise<void>(() => undefined)
      },
    })

    expect(outcome).toMatchObject({ok: false, reason: 'timeout'})
    expect(aborted).toBe(true)
  })

  it('retries once after a timeout or unknown error, and passes if the retry connects', async () => {
    let calls = 0
    const outcome = await tcpReach(HOST, 22, {
      timeoutMs: 1000,
      retries: 1,
      connect: async () => {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('x'), {code: 'ETIMEDOUT'})
      },
    })

    expect(outcome.ok).toBe(true)
    expect(calls).toBe(2)
  })

  it('never retries a refusal: the host answered', async () => {
    let calls = 0
    const outcome = await tcpReach(HOST, 22, {
      timeoutMs: 1000,
      retries: 1,
      connect: async () => {
        calls += 1
        throw Object.assign(new Error('x'), {code: 'ECONNREFUSED'})
      },
    })

    expect(outcome).toMatchObject({ok: false, reason: 'refused'})
    expect(calls).toBe(1)
  })

  it('reports the last attempt when every attempt fails', async () => {
    let calls = 0
    const outcome = await tcpReach(HOST, 22, {
      timeoutMs: 1000,
      retries: 1,
      connect: async () => {
        calls += 1
        throw Object.assign(new Error('x'), {code: calls === 1 ? 'ETIMEDOUT' : 'EHOSTUNREACH'})
      },
    })

    expect(outcome).toMatchObject({ok: false, reason: 'unreachable'})
    expect(calls).toBe(2)
  })
})

/** The smallest socket the connector needs. It has no `write` or `read`, so using either would throw. */
class FakeSocket extends EventEmitter {
  destroyed = 0
  destroy(): this {
    this.destroyed += 1
    return this
  }
}

function setup() {
  const socket = new FakeSocket()
  const created: unknown[] = []
  const connect = createNetConnect(options => {
    created.push(options)
    return socket
  })
  return {socket, created, connect}
}

describe('createNetConnect (the default connector, driven through a fake socket)', () => {
  it('resolves on connect and closes the socket at once, sending and reading nothing', async () => {
    const {socket, created, connect} = setup()
    const pending = connect({host: HOST, port: 22}, new AbortController().signal)
    socket.emit('connect')

    await pending
    expect(created).toEqual([{host: HOST, port: 22}])
    expect(socket.destroyed).toBe(1)
  })

  it('rejects with the socket error, and closes the socket', async () => {
    const {socket, connect} = setup()
    const pending = connect({host: HOST, port: 22}, new AbortController().signal)
    socket.emit('error', Object.assign(new Error('x'), {code: 'ECONNREFUSED'}))

    await expect(pending).rejects.toMatchObject({code: 'ECONNREFUSED'})
    expect(socket.destroyed).toBe(1)
  })

  it('destroys the socket and rejects when the signal aborts before it connects', async () => {
    const {socket, connect} = setup()
    const controller = new AbortController()
    const pending = connect({host: HOST, port: 22}, controller.signal)
    controller.abort()

    await expect(pending).rejects.toBeDefined()
    expect(socket.destroyed).toBe(1)
  })

  it('rejects at once for a signal that is already aborted', async () => {
    const {connect} = setup()

    await expect(connect({host: HOST, port: 22}, AbortSignal.abort())).rejects.toBeDefined()
  })
})
