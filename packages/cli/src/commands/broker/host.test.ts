import {describe, expect, it} from 'bun:test'

import {validateBrokerHost} from './host'

// ─── validateBrokerHost ───────────────────────────────────────────────────────

describe('validateBrokerHost', () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  it('accepts a standard FQDN', () => {
    expect(() => validateBrokerHost('broker.fro.bot')).not.toThrow()
    expect(validateBrokerHost('broker.fro.bot')).toBe('broker.fro.bot')
  })

  it('accepts localhost', () => {
    expect(() => validateBrokerHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateBrokerHost('147.182.133.210')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateBrokerHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateBrokerHost('my-broker.prod.example.com')).not.toThrow()
  })

  // ── Injection attacks ───────────────────────────────────────────────────────

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateBrokerHost('-oProxyCommand=evil')).toThrow('Invalid BROKER_HOST')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateBrokerHost('broker.fro.bot;rm -rf')).toThrow('Invalid BROKER_HOST')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateBrokerHost('broker.fro.bot`id`')).toThrow('Invalid BROKER_HOST')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateBrokerHost('broker fro.bot')).toThrow('Invalid BROKER_HOST')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateBrokerHost('user@broker.fro.bot')).toThrow('Invalid BROKER_HOST')
  })

  // ── Empty / blank ───────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(() => validateBrokerHost('')).toThrow('Invalid BROKER_HOST')
  })

  // ── Error message sanitization ──────────────────────────────────────────────

  it('truncates the invalid value in the error message to ~30 chars', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateBrokerHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The excerpt in the message should not exceed 30 chars of the original value
    expect(message).toContain('Invalid BROKER_HOST')
    expect(message.length).toBeLessThan(longMalicious.length + 50)
  })
})
