import {describe, expect, it} from 'bun:test'

import {validateGatewayHost} from './host'

// ─── validateGatewayHost ──────────────────────────────────────────────────────

describe('validateGatewayHost', () => {
  // ── Valid inputs ────────────────────────────────────────────────────────────

  it('accepts a standard FQDN', () => {
    expect(() => validateGatewayHost('gateway.example.com')).not.toThrow()
    expect(validateGatewayHost('gateway.example.com')).toBe('gateway.example.com')
  })

  it('accepts localhost', () => {
    expect(() => validateGatewayHost('localhost')).not.toThrow()
  })

  it('accepts an IPv4 address', () => {
    expect(() => validateGatewayHost('147.182.133.210')).not.toThrow()
  })

  it('accepts a single-character hostname', () => {
    expect(() => validateGatewayHost('a')).not.toThrow()
  })

  it('accepts a hostname with hyphens', () => {
    expect(() => validateGatewayHost('my-gateway.prod.example.com')).not.toThrow()
  })

  // ── Injection attacks ───────────────────────────────────────────────────────

  it('rejects a leading-hyphen value (ProxyCommand injection vector)', () => {
    expect(() => validateGatewayHost('-oProxyCommand=evil')).toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a value with shell metacharacters (semicolon)', () => {
    expect(() => validateGatewayHost('gateway.example.com;rm -rf')).toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a value with shell metacharacters (backtick)', () => {
    expect(() => validateGatewayHost('gateway.example.com`id`')).toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a value with spaces', () => {
    expect(() => validateGatewayHost('gateway example.com')).toThrow('Invalid GATEWAY_HOST')
  })

  it('rejects a value with an at-sign', () => {
    expect(() => validateGatewayHost('user@gateway.example.com')).toThrow('Invalid GATEWAY_HOST')
  })

  // ── Empty / blank ───────────────────────────────────────────────────────────

  it('rejects an empty string', () => {
    expect(() => validateGatewayHost('')).toThrow('Invalid GATEWAY_HOST')
  })

  // ── Error message sanitization ──────────────────────────────────────────────

  it('truncates the invalid value in the error message to ~30 chars', () => {
    const longMalicious = `-oProxyCommand=${'A'.repeat(100)}`
    let message = ''
    try {
      validateGatewayHost(longMalicious)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    // The excerpt in the message should not exceed 30 chars of the original value
    expect(message).toContain('Invalid GATEWAY_HOST')
    expect(message.length).toBeLessThan(longMalicious.length + 50)
  })
})
