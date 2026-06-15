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
    expect(() => validateDashboardHost('192.168.1.1')).not.toThrow()
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

  it('does NOT echo the invalid value in the error message (may be a misdirected secret)', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateDashboardHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('Invalid DASHBOARD_DOMAIN')
    // The invalid value must NOT appear in the error message
    expect(message).not.toContain('-oProxyCommand')
    expect(message).not.toContain('AAAA')
  })
})
