import {describe, expect, it} from 'bun:test'

import {validateDashboardHost} from './host'

describe('validateDashboardHost', () => {
  it('accepts a standard FQDN', () => {
    expect(() => validateDashboardHost('dashboard.fro.bot')).not.toThrow()
    expect(validateDashboardHost('dashboard.fro.bot')).toBe('dashboard.fro.bot')
  })

  it('accepts localhost', () => {
    expect(() => validateDashboardHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateDashboardHost('147.182.133.210')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateDashboardHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateDashboardHost('my-dashboard.prod.example.com')).not.toThrow()
  })

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateDashboardHost('-oProxyCommand=evil')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateDashboardHost('dashboard.fro.bot;rm -rf')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateDashboardHost('dashboard.fro.bot`id`')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateDashboardHost('dashboard fro.bot')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateDashboardHost('user@dashboard.fro.bot')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('rejects an empty string', () => {
    expect(() => validateDashboardHost('')).toThrow('Invalid DASHBOARD_DOMAIN')
  })

  it('omits the rejected value entirely from the error message', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateDashboardHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The value is never echoed (it may be a misdirected secret) — only the constraint is shown.
    expect(message).toContain('Invalid DASHBOARD_DOMAIN')
    expect(message).not.toContain('ProxyCommand')
    expect(message).not.toContain('AAAA')
  })

  // ── Secret value redaction ───────────────────────────────────────────────────

  it('does not echo the rejected value in the error message', () => {
    const secretValue = 'AWS_SECRET_KEY=AKIA1234567890EXAMPLE'
    let message = ''
    try {
      validateDashboardHost(secretValue)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid DASHBOARD_DOMAIN')
    expect(message).not.toContain('AKIA1234567890EXAMPLE')
    expect(message).not.toContain('AWS_SECRET_KEY')
  })
})
