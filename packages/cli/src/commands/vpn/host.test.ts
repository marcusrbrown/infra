import {describe, expect, it} from 'bun:test'

import {validateVpnHost} from './host'

// ─── validateVpnHost ──────────────────────────────────────────────────────────

describe('validateVpnHost', () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  it('accepts a standard FQDN', () => {
    expect(() => validateVpnHost('vpn.example.com')).not.toThrow()
    expect(validateVpnHost('vpn.example.com')).toBe('vpn.example.com')
  })

  it('accepts localhost', () => {
    expect(() => validateVpnHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateVpnHost('1.2.3.4')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateVpnHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateVpnHost('my-vpn.prod.example.com')).not.toThrow()
  })

  // ── Injection attacks ───────────────────────────────────────────────────────

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateVpnHost('-oProxyCommand=evil')).toThrow('Invalid VPN_HOST')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateVpnHost('vpn.example.com;rm -rf')).toThrow('Invalid VPN_HOST')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateVpnHost('vpn.example.com`id`')).toThrow('Invalid VPN_HOST')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateVpnHost('vpn example.com')).toThrow('Invalid VPN_HOST')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateVpnHost('user@vpn.example.com')).toThrow('Invalid VPN_HOST')
  })

  // ── Empty / blank ───────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(() => validateVpnHost('')).toThrow('Invalid VPN_HOST')
  })

  // ── Error message sanitization ──────────────────────────────────────────────

  it('omits the rejected value entirely from the error message', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateVpnHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The value is never echoed (it may be a misdirected secret) — only the constraint is shown.
    expect(message).toContain('Invalid VPN_HOST')
    expect(message).not.toContain('ProxyCommand')
    expect(message).not.toContain('AAAA')
  })

  // ── Secret value redaction ───────────────────────────────────────────────────

  it('does not echo the rejected value in the error message', () => {
    const secretValue = 'AWS_SECRET_KEY=AKIA1234567890EXAMPLE'
    let message = ''
    try {
      validateVpnHost(secretValue)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid VPN_HOST')
    expect(message).not.toContain('AKIA1234567890EXAMPLE')
    expect(message).not.toContain('AWS_SECRET_KEY')
  })
})
