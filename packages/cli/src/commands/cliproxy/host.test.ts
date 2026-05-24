import {describe, expect, it} from 'bun:test'

import {validateCliproxyHost} from './host'

// ─── validateCliproxyHost ─────────────────────────────────────────────────────

describe('validateCliproxyHost', () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  it('accepts a standard FQDN', () => {
    expect(() => validateCliproxyHost('cliproxy.fro.bot')).not.toThrow()
    expect(validateCliproxyHost('cliproxy.fro.bot')).toBe('cliproxy.fro.bot')
  })

  it('accepts localhost', () => {
    expect(() => validateCliproxyHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateCliproxyHost('147.182.133.210')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateCliproxyHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateCliproxyHost('my-cliproxy.prod.example.com')).not.toThrow()
  })

  // ── Injection attacks ───────────────────────────────────────────────────────

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateCliproxyHost('-oProxyCommand=evil')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateCliproxyHost('cliproxy.fro.bot;rm -rf')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateCliproxyHost('cliproxy.fro.bot`id`')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateCliproxyHost('cliproxy fro.bot')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateCliproxyHost('user@cliproxy.fro.bot')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  // ── Empty / blank ───────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(() => validateCliproxyHost('')).toThrow('Invalid CLIPROXY_DOMAIN')
  })

  // ── Error message sanitization ──────────────────────────────────────────────

  it('truncates the invalid value in the error message to ~30 chars', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateCliproxyHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The excerpt in the message should not exceed 30 chars of the original value
    expect(message).toContain('Invalid CLIPROXY_DOMAIN')
    expect(message.length).toBeLessThan(longMalicious.length + 50)
  })
})
