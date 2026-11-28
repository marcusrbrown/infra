import {describe, expect, test} from 'bun:test'

import {loadConfig} from './config'

describe('loadConfig', () => {
  test('defaults are the contract values', () => {
    expect(loadConfig({})).toEqual({
      tokenFile: '/run/readers/token',
      langfuseBasicFile: '/run/secrets/reader-gate/langfuse-basic',
      grafanaMcpCallerFile: '/run/secrets/mcp-caller/token',
      langfuseUpstream: 'http://langfuse-web:3000',
      grafanaMcpUpstream: 'http://grafana-mcp:8000',
    })
  })

  test('reads the five environment variables', () => {
    expect(
      loadConfig({
        READER_TOKEN_FILE: '/x/token',
        LANGFUSE_BASIC_FILE: '/x/basic',
        GRAFANA_MCP_CALLER_FILE: '/x/caller',
        LANGFUSE_UPSTREAM: 'http://lf:1',
        GRAFANA_MCP_UPSTREAM: 'https://gm.example:2/',
      }),
    ).toEqual({
      tokenFile: '/x/token',
      langfuseBasicFile: '/x/basic',
      grafanaMcpCallerFile: '/x/caller',
      langfuseUpstream: 'http://lf:1',
      grafanaMcpUpstream: 'https://gm.example:2',
    })
  })

  test.each([
    ['not a URL', 'langfuse-web:3000'],
    ['a non-http scheme', 'ftp://lf:1'],
    ['embedded credentials', 'http://user:pw@lf:1'],
    ['a path', 'http://lf:1/api'],
    ['a query', 'http://lf:1/?a=1'],
    ['a fragment', 'http://lf:1/#x'],
    ['an empty value', ''],
  ])('refuses an upstream with %s', (_name, value) => {
    expect(() => loadConfig({LANGFUSE_UPSTREAM: value})).toThrow(/LANGFUSE_UPSTREAM/)
    expect(() => loadConfig({GRAFANA_MCP_UPSTREAM: value})).toThrow(/GRAFANA_MCP_UPSTREAM/)
  })

  test('the error never echoes the offending value', () => {
    let message = ''
    try {
      loadConfig({LANGFUSE_UPSTREAM: 'http://user:hunter2@lf:1'})
    } catch (error) {
      message = String(error)
    }
    expect(message).toContain('LANGFUSE_UPSTREAM')
    expect(message).not.toContain('hunter2')
  })
})
