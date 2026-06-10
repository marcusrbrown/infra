import {describe, expect, it} from 'bun:test'

import {validateVpnHost} from './host'

describe('validateVpnHost', () => {
  describe('valid hosts', () => {
    it('accepts a plain IPv4 address', () => {
      expect(() => validateVpnHost('1.2.3.4')).not.toThrow()
    })

    it('returns the host string unchanged', () => {
      expect(validateVpnHost('1.2.3.4')).toBe('1.2.3.4')
    })

    it('accepts localhost', () => {
      expect(() => validateVpnHost('localhost')).not.toThrow()
    })

    it('accepts a hostname with hyphens', () => {
      expect(() => validateVpnHost('my-vpn.example.com')).not.toThrow()
    })

    it('accepts a typical Lightsail static IP', () => {
      expect(() => validateVpnHost('52.18.100.200')).not.toThrow()
    })
  })

  describe('invalid hosts', () => {
    it('rejects an empty string', () => {
      expect(() => validateVpnHost('')).toThrow(/empty/)
    })

    it('rejects a leading-hyphen host (ProxyCommand injection vector)', () => {
      expect(() => validateVpnHost('-oProxyCommand=evil')).toThrow(/Invalid VPN_HOST/)
    })

    it('rejects a host with shell metacharacters (semicolon)', () => {
      expect(() => validateVpnHost('host;rm -rf /')).toThrow(/Invalid VPN_HOST/)
    })

    it('rejects a host with shell metacharacters (backtick)', () => {
      expect(() => validateVpnHost('host`id`')).toThrow(/Invalid VPN_HOST/)
    })

    it('rejects a host with spaces', () => {
      expect(() => validateVpnHost('host name')).toThrow(/Invalid VPN_HOST/)
    })

    it('rejects a host with a dollar sign', () => {
      expect(() => validateVpnHost('host$VAR')).toThrow(/Invalid VPN_HOST/)
    })
  })
})
