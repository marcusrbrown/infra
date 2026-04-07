import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {resolveManagementKey} from './cliproxy-config'
import {toStringArray} from './cliproxy-keys'
import {requireSshAuthSock, resolveHost} from './cliproxy-login'

describe('cliproxy config helpers', () => {
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
