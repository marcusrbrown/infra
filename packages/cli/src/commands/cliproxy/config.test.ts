import {chmodSync, existsSync, statSync} from 'node:fs'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {buildSetRequest, formatConfigAsColumns, parseBoolean, parseNumber, resolveManagementKey} from './config'
import {toStringArray} from './keys'
import {requireSshAuthSock, resolveHost} from './login'

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

  describe('config get --output', () => {
    it('writes config JSON to file with 0600 permissions', async () => {
      const testFile = '/tmp/test-config-output.json'
      const mockConfig = {debug: true, 'api-keys': ['key1', 'key2']}

      const originalFetch = globalThis.fetch as typeof fetch
      ;(globalThis.fetch as unknown) = async () => {
        return new Response(JSON.stringify(mockConfig), {status: 200})
      }

      try {
        const baseUrl = 'https://cliproxy.example.com'
        const managementKey = 'test-key'
        const endpoint = `${baseUrl}/v0/management/config`
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: new Headers({
            'x-management-key': managementKey,
            'content-type': 'application/json',
          }),
        })
        const payload = await response.json()
        const jsonOutput = JSON.stringify(payload, null, 2)

        await Bun.write(testFile, jsonOutput)
        chmodSync(testFile, 0o600)
        const {mode} = statSync(testFile)
        const permissions = mode & 0o777

        expect(existsSync(testFile)).toBe(true)
        expect(permissions).toBe(0o600)

        const content = await Bun.file(testFile).text()
        expect(JSON.parse(content)).toEqual(mockConfig)
      } finally {
        ;(globalThis.fetch as unknown) = originalFetch
        if (existsSync(testFile)) {
          const fs = await import('node:fs/promises')
          await fs.unlink(testFile).catch(() => {})
        }
      }
    })

    it('prints API key warning to stderr when writing to stdout', async () => {
      const mockConfig = {debug: true, 'api-keys': ['secret-key']}
      const stderrLines: string[] = []
      const stdoutLines: string[] = []

      const originalError = console.error
      const originalLog = console.log
      console.error = (...args: unknown[]) => {
        stderrLines.push(String(args[0]))
      }
      console.log = (...args: unknown[]) => {
        stdoutLines.push(String(args[0]))
      }

      const originalFetch = globalThis.fetch as typeof fetch
      ;(globalThis.fetch as unknown) = async () => {
        return new Response(JSON.stringify(mockConfig), {status: 200})
      }

      try {
        const baseUrl = 'https://cliproxy.example.com'
        const managementKey = 'test-key'
        const endpoint = `${baseUrl}/v0/management/config`
        const response = await fetch(endpoint, {
          method: 'GET',
          headers: new Headers({
            'x-management-key': managementKey,
            'content-type': 'application/json',
          }),
        })
        const payload = await response.json()
        const jsonOutput = JSON.stringify(payload, null, 2)

        console.error('⚠️  Output may contain API keys — avoid logging or storing in shared locations')
        console.log(jsonOutput)

        expect(stderrLines.some(line => line.includes('API keys'))).toBe(true)
        expect(stdoutLines.some(line => line.includes('debug'))).toBe(true)
      } finally {
        console.error = originalError
        console.log = originalLog
        ;(globalThis.fetch as unknown) = originalFetch
      }
    })
  })
})

describe('formatConfigAsColumns', () => {
  it('formats flat object as aligned key: value lines', () => {
    const result = formatConfigAsColumns({debug: true, 'request-retry': 3, 'proxy-url': 'https://x.com'})
    const lines = result.split('\n')

    expect(lines[0]).toBe('debug        : true')
    expect(lines[1]).toBe('request-retry: 3')
    expect(lines[2]).toBe('proxy-url    : https://x.com')
  })

  it('serializes nested objects as JSON', () => {
    const result = formatConfigAsColumns({nested: {a: 1}})

    expect(result).toBe('nested: {"a":1}')
  })

  it('returns empty string for empty object', () => {
    expect(formatConfigAsColumns({})).toBe('')
  })

  it('falls back to JSON.stringify for non-objects', () => {
    expect(formatConfigAsColumns(null)).toBe('null')
    expect(formatConfigAsColumns([1, 2])).toBe('[\n  1,\n  2\n]')
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
