import {describe, expect, it} from 'bun:test'

import {validateGatewayHost} from './host'

describe('validateGatewayHost', () => {
  describe('valid hosts', () => {
    it('accepts a plain FQDN', () => {
      expect(() => validateGatewayHost('gateway.fro.bot')).not.toThrow()
    })

    it('returns the host string unchanged', () => {
      expect(validateGatewayHost('gateway.fro.bot')).toBe('gateway.fro.bot')
    })

    it('accepts localhost', () => {
      expect(() => validateGatewayHost('localhost')).not.toThrow()
    })

    it('accepts an IPv4 address', () => {
      expect(() => validateGatewayHost('147.182.133.210')).not.toThrow()
    })

    it('accepts a hostname with hyphens', () => {
      expect(() => validateGatewayHost('my-gateway.example.com')).not.toThrow()
    })
  })

  describe('invalid hosts', () => {
    it('rejects an empty string', () => {
      expect(() => validateGatewayHost('')).toThrow(/empty/)
    })

    it('rejects a leading-hyphen host (ProxyCommand injection vector)', () => {
      expect(() => validateGatewayHost('-oProxyCommand=evil')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('rejects a host with shell metacharacters (semicolon)', () => {
      expect(() => validateGatewayHost('host;rm -rf /')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('rejects a host with shell metacharacters (backtick)', () => {
      expect(() => validateGatewayHost('host`id`')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('rejects a host with spaces', () => {
      expect(() => validateGatewayHost('host name')).toThrow(/Invalid GATEWAY_HOST/)
    })

    it('rejects a host with a dollar sign', () => {
      expect(() => validateGatewayHost('host$VAR')).toThrow(/Invalid GATEWAY_HOST/)
    })
  })
})
