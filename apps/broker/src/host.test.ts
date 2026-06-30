import {describe, expect, it} from 'bun:test'

import {validateBrokerHost} from './host'

describe('validateBrokerHost', () => {
  describe('valid hosts', () => {
    it('accepts a plain IPv4 address', () => {
      expect(() => validateBrokerHost('1.2.3.4')).not.toThrow()
    })

    it('returns the host string unchanged', () => {
      expect(validateBrokerHost('1.2.3.4')).toBe('1.2.3.4')
    })

    it('accepts localhost', () => {
      expect(() => validateBrokerHost('localhost')).not.toThrow()
    })

    it('accepts a hostname with hyphens', () => {
      expect(() => validateBrokerHost('broker.fro.bot')).not.toThrow()
    })

    it('accepts a typical DigitalOcean droplet IP', () => {
      expect(() => validateBrokerHost('167.99.100.200')).not.toThrow()
    })

    it('accepts a normal FQDN', () => {
      expect(validateBrokerHost('broker.fro.bot')).toBe('broker.fro.bot')
    })
  })

  describe('invalid hosts', () => {
    it('rejects an empty string', () => {
      expect(() => validateBrokerHost('')).toThrow(/empty/)
    })

    it('rejects a leading-hyphen host (ProxyCommand injection vector)', () => {
      expect(() => validateBrokerHost('-oProxyCommand=evil')).toThrow(/Invalid BROKER_HOST/)
    })

    it('includes a sanitized 30-char excerpt in the error message', () => {
      const longBadHost = '-oProxyCommand=evil_command_here_and_more'
      try {
        validateBrokerHost(longBadHost)
        throw new Error('should have thrown')
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        // Excerpt is truncated to 30 chars: '-oProxyCommand=evil_command_he' (30 chars)
        expect(msg).toContain('-oProxyCommand=evil_command_he')
        // Full string is not echoed (it's longer than 30 chars)
        expect(msg).not.toContain('and_more')
      }
    })

    it('rejects a host with shell metacharacters (semicolon)', () => {
      expect(() => validateBrokerHost('host;rm -rf /')).toThrow(/Invalid BROKER_HOST/)
    })

    it('rejects a host with shell metacharacters (backtick)', () => {
      expect(() => validateBrokerHost('host`id`')).toThrow(/Invalid BROKER_HOST/)
    })

    it('rejects a host with spaces', () => {
      expect(() => validateBrokerHost('host name')).toThrow(/Invalid BROKER_HOST/)
    })

    it('rejects a host with a dollar sign', () => {
      expect(() => validateBrokerHost('host$VAR')).toThrow(/Invalid BROKER_HOST/)
    })

    it('rejects a host with an at-sign', () => {
      expect(() => validateBrokerHost('user@host')).toThrow(/Invalid BROKER_HOST/)
    })

    it('rejects a host with a slash', () => {
      expect(() => validateBrokerHost('host/path')).toThrow(/Invalid BROKER_HOST/)
    })
  })
})
