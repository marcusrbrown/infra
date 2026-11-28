import {describe, expect, test} from 'bun:test'

import {TRACES_VOID_TOKEN_PREFIX} from '../src/host'
import {
  CONSUMER_PATTERN,
  DEADLINE_MS,
  DEFAULTS,
  GRAFANA_MCP_CALLER_HEADER,
  GRAFANA_PLACEHOLDER,
  IDLE_TIMEOUT_S,
  LANGFUSE_PLACEHOLDER,
  LIMITS,
  PORTS,
  RELOAD_INTERVAL_MS,
  RESPONSE_DEADLINE_MS,
  VOID_TOKEN_PREFIX,
} from './constants'

describe('constants', () => {
  test('the void prefix copy matches the host constant', () => {
    expect(VOID_TOKEN_PREFIX).toBe(TRACES_VOID_TOKEN_PREFIX)
  })

  test('the listeners are the contract ports', () => {
    expect(PORTS).toEqual({proxy: 8090, health: 8091})
  })

  test('the deadline to response headers is 60 s', () => {
    expect(DEADLINE_MS).toBe(60_000)
  })

  test('the timeouts nest: headers, whole response, idle', () => {
    expect(RESPONSE_DEADLINE_MS).toBeGreaterThan(DEADLINE_MS)
    expect(IDLE_TIMEOUT_S * 1000).toBeGreaterThan(DEADLINE_MS)
  })

  test('the store reloads about every second', () => {
    expect(RELOAD_INTERVAL_MS).toBe(1000)
  })

  test('limits are positive integers and the global cap covers one consumer', () => {
    for (const value of Object.values(LIMITS)) {
      expect(Number.isInteger(value)).toBe(true)
      expect(value).toBeGreaterThan(0)
    }
    expect(LIMITS.globalConcurrency).toBeGreaterThanOrEqual(LIMITS.perConsumerConcurrency)
  })

  test('placeholders carry the unset marker the deploy writes', () => {
    expect(LANGFUSE_PLACEHOLDER).toBe('pk-lf-unset:sk-lf-unset')
    expect(GRAFANA_PLACEHOLDER).toBe('glsa_unset')
  })

  test('the Grafana MCP caller header is a fixed custom name, never Authorization, and the file is in its own directory', () => {
    expect(GRAFANA_MCP_CALLER_HEADER).toBe('x-reader-gate-token')
    expect(GRAFANA_MCP_CALLER_HEADER).toBe(GRAFANA_MCP_CALLER_HEADER.toLowerCase())
    expect(DEFAULTS.grafanaMcpCallerFile).toBe('/run/secrets/mcp-caller/token')
  })

  test('consumer names follow the kebab pattern', () => {
    for (const ok of ['systematic', 'fro-bot-audit', 'a', 'a0-b1']) expect(CONSUMER_PATTERN.test(ok)).toBe(true)
    for (const bad of ['', 'Systematic', '1abc', '-a', 'a_b', 'a b', 'a'.repeat(32)])
      expect(CONSUMER_PATTERN.test(bad)).toBe(false)
  })
})
