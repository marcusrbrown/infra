import {describe, expect, it} from 'bun:test'

import {validateUmamiHost} from './host'

describe('validateUmamiHost', () => {
  it('accepts a standard FQDN', () => {
    expect(() => validateUmamiHost('metrics.fro.bot')).not.toThrow()
    expect(validateUmamiHost('metrics.fro.bot')).toBe('metrics.fro.bot')
  })

  it('accepts localhost', () => {
    expect(() => validateUmamiHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateUmamiHost('147.182.133.210')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateUmamiHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateUmamiHost('my-metrics.prod.example.com')).not.toThrow()
  })

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateUmamiHost('-oProxyCommand=evil')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateUmamiHost('metrics.fro.bot;rm -rf')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateUmamiHost('metrics.fro.bot`id`')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateUmamiHost('metrics fro.bot')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateUmamiHost('user@metrics.fro.bot')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('rejects an empty string', () => {
    expect(() => validateUmamiHost('')).toThrow('Invalid UMAMI_DOMAIN')
  })

  it('truncates the invalid value in the error message to ~30 chars', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateUmamiHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid UMAMI_DOMAIN')
    expect(message.length).toBeLessThan(longMalicious.length + 50)
  })
})
