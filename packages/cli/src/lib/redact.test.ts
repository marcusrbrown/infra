import {describe, expect, it} from 'bun:test'

import {redactHost} from './redact'

describe('redactHost', () => {
  it('leaves text unchanged for an empty host', () => {
    const text = 'ssh: connection failed'

    expect(redactHost(text, '')).toBe(text)
  })

  it('matches OpenSSH lowercasing case-insensitively', () => {
    expect(redactHost('Could not resolve hostname cliproxy.fro.bot', 'CLIProxy.Fro.Bot')).toBe(
      'Could not resolve hostname <host>',
    )
  })

  it('escapes dots without over-redacting', () => {
    const text = 'aXexampleYcom a.example.com'

    expect(redactHost(text, 'a.example.com')).toBe('aXexampleYcom <host>')
  })

  it('matches hyphenated hosts', () => {
    expect(redactHost('ssh gateway.fro-bot: permission denied', 'gateway.fro-bot')).toBe(
      'ssh <host>: permission denied',
    )
  })

  it('redacts every occurrence', () => {
    expect(redactHost('gateway.fro.bot gateway.fro.bot', 'gateway.fro.bot')).toBe('<host> <host>')
  })

  it('treats regex metacharacters as literal host text', () => {
    const cases = [
      ['a+b', 'a+b aXb'],
      ['x$y', 'x$y xAy'],
      ['p(q)', 'p(q) pXq'],
      [String.raw`a\b`, String.raw`a\b aXb`],
    ] as const

    for (const [host, text] of cases) {
      expect(redactHost(text, host)).toBe(text.replace(host, '<host>'))
    }
  })

  it('does not leak a secret-shaped host value', () => {
    const secret = 'AWS_SECRET_ACCESS_KEY=super-secret-value'
    const output = redactHost(`ssh failed: ${secret}; retrying ${secret}`, secret)

    expect(output).not.toContain(secret)
  })

  it('redacts a host substring inside a longer token', () => {
    expect(redactHost('lookup failed for cliproxy.fro.bot.internal', 'cliproxy.fro.bot')).toBe(
      'lookup failed for <host>.internal',
    )
  })
})
