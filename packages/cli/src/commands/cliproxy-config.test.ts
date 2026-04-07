import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {buildSetRequest, parseBoolean, parseNumber, resolveManagementKey} from './cliproxy-config'
import {toStringArray} from './cliproxy-keys'
import {requireSshAuthSock, resolveHost} from './cliproxy-login'

describe('cliproxy config helpers', () => {
  describe('parseBoolean', () => {
    it('parses true values case-insensitively', () => {
      expect(parseBoolean('true')).toBe(true)
      expect(parseBoolean('True')).toBe(true)
      expect(parseBoolean('TRUE')).toBe(true)
    })

    it('parses false values case-insensitively', () => {
      expect(parseBoolean('false')).toBe(false)
      expect(parseBoolean('False')).toBe(false)
    })

    it('throws for invalid values', () => {
      expect(() => parseBoolean('wat')).toThrow()
    })
  })

  describe('parseNumber', () => {
    it('parses integers and floats', () => {
      expect(parseNumber('42', 'request-retry')).toBe(42)
      expect(parseNumber('3.14', 'request-retry')).toBe(3.14)
    })

    it('throws TypeError for non-numeric values', () => {
      expect(() => parseNumber('abc', 'request-retry')).toThrow(TypeError)
    })

    it('throws TypeError for NaN', () => {
      expect(() => parseNumber('NaN', 'request-retry')).toThrow(TypeError)
    })

    it('throws TypeError for Infinity', () => {
      expect(() => parseNumber('Infinity', 'request-retry')).toThrow(TypeError)
    })
  })

  describe('buildSetRequest', () => {
    it('builds a boolean debug request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'debug', 'true')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/debug')
      expect(JSON.parse(request.body)).toEqual({value: true})
    })

    it('builds a numeric request-retry request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'request-retry', '3')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/request-retry')
      expect(JSON.parse(request.body)).toEqual({value: 3})
    })

    it('builds a string proxy-url request with {value} body', () => {
      const request = buildSetRequest('https://cliproxy.example.com', 'proxy-url', 'https://x.com')

      expect(request.endpoint).toBe('https://cliproxy.example.com/v0/management/proxy-url')
      expect(JSON.parse(request.body)).toEqual({value: 'https://x.com'})
    })

    it('throws for unsupported fields', () => {
      expect(() => buildSetRequest('https://cliproxy.example.com', 'provider', 'claude')).toThrow()
    })
  })

  describe('resolveManagementKey', () => {
    const originalManagementKey = process.env.CLIPROXY_MANAGEMENT_KEY

    beforeEach(() => {
      delete process.env.CLIPROXY_MANAGEMENT_KEY
    })

    afterEach(() => {
      if (originalManagementKey === undefined) {
        delete process.env.CLIPROXY_MANAGEMENT_KEY
      } else {
        process.env.CLIPROXY_MANAGEMENT_KEY = originalManagementKey
      }
    })

    it('returns explicit input when provided', () => {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'env-key'

      expect(resolveManagementKey('explicit-key')).toBe('explicit-key')
    })

    it('falls back to CLIPROXY_MANAGEMENT_KEY', () => {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'env-key'

      expect(resolveManagementKey()).toBe('env-key')
    })

    it('throws when no key is available', () => {
      expect(() => resolveManagementKey()).toThrow()
    })
  })
})

describe('cliproxy keys helpers', () => {
  describe('toStringArray', () => {
    it('returns string arrays filtered to strings only', () => {
      expect(toStringArray(['a', 'b'])).toEqual(['a', 'b'])
      expect(toStringArray(['a', 1, 'b', false])).toEqual(['a', 'b'])
    })

    it('reads api-keys (hyphenated) from objects', () => {
      expect(toStringArray({'api-keys': ['a', 'b']})).toEqual(['a', 'b'])
    })

    it('reads api_keys (underscored) from objects', () => {
      expect(toStringArray({api_keys: ['a', 'b']})).toEqual(['a', 'b'])
    })

    it('prefers api-keys over api_keys', () => {
      expect(toStringArray({'api-keys': ['x'], api_keys: ['y']})).toEqual(['x'])
    })

    it('returns an empty array for unsupported payloads', () => {
      expect(toStringArray(null)).toEqual([])
      expect(toStringArray(undefined)).toEqual([])
      expect(toStringArray(123)).toEqual([])
    })
  })
})

describe('cliproxy login helpers', () => {
  describe('resolveHost', () => {
    const originalHost = process.env.CLIPROXY_DOMAIN

    beforeEach(() => {
      delete process.env.CLIPROXY_DOMAIN
    })

    afterEach(() => {
      if (originalHost === undefined) {
        delete process.env.CLIPROXY_DOMAIN
      } else {
        process.env.CLIPROXY_DOMAIN = originalHost
      }
    })

    it('returns explicit input when provided', () => {
      process.env.CLIPROXY_DOMAIN = 'env.example.com'

      expect(resolveHost('explicit.example.com')).toBe('explicit.example.com')
    })

    it('falls back to CLIPROXY_DOMAIN', () => {
      process.env.CLIPROXY_DOMAIN = 'env.example.com'

      expect(resolveHost()).toBe('env.example.com')
    })

    it('falls back to the default host', () => {
      expect(resolveHost()).toBe('cliproxy.fro.bot')
    })
  })

  describe('requireSshAuthSock', () => {
    const originalSshAuthSock = process.env.SSH_AUTH_SOCK

    beforeEach(() => {
      delete process.env.SSH_AUTH_SOCK
    })

    afterEach(() => {
      if (originalSshAuthSock === undefined) {
        delete process.env.SSH_AUTH_SOCK
      } else {
        process.env.SSH_AUTH_SOCK = originalSshAuthSock
      }
    })

    it('returns SSH_AUTH_SOCK when set', () => {
      process.env.SSH_AUTH_SOCK = '/tmp/agent.sock'

      expect(requireSshAuthSock()).toBe('/tmp/agent.sock')
    })

    it('throws when SSH_AUTH_SOCK is missing', () => {
      expect(() => requireSshAuthSock()).toThrow()
    })
  })
})
