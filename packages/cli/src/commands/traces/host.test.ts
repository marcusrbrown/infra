import {describe, expect, it} from 'bun:test'

import {
  READER_GRAFANA_PLACEHOLDER,
  READER_LANGFUSE_PLACEHOLDER,
  resolveTracesHost,
  resolveTracesOrigin,
  TRACES_APP_DIR,
  TRACES_DEFAULT_HOST,
  TRACES_GRAFANA_MCP_TOKEN_FILE,
  TRACES_GROUPS,
  TRACES_READER_DIR,
  TRACES_READER_LANGFUSE_FILE,
  TRACES_READER_LOCK,
  TRACES_READER_TOKEN_FILE,
  TRACES_SERVICES,
  validateTracesHost,
} from './host'

describe('validateTracesHost', () => {
  it('accepts a hostname, an FQDN and localhost', () => {
    expect(validateTracesHost('traces.fro.bot')).toBe('traces.fro.bot')
    expect(validateTracesHost('localhost')).toBe('localhost')
    expect(validateTracesHost('a')).toBe('a')
  })

  it('rejects empty, leading-hyphen and out-of-alphabet values', () => {
    for (const bad of ['', '-oProxyCommand=evil', 'host;id', 'a b', 'user@host', 'host`id`', '$(id)']) {
      expect(() => validateTracesHost(bad)).toThrow('Invalid TRACES_HOST')
    }
  })

  it('never echoes the rejected value', () => {
    expect(() => validateTracesHost('-oProxyCommand=SECRET123')).toThrow(/^(?!.*SECRET123)/s)
  })
})

describe('resolveTracesHost and resolveTracesOrigin', () => {
  it('prefers the named variable, then TRACES_HOST, then the public hostname', () => {
    expect(resolveTracesHost({OTHER: 'other.example.invalid', TRACES_HOST: 'x.example.invalid'}, 'OTHER')).toBe(
      'other.example.invalid',
    )
    expect(resolveTracesHost({TRACES_HOST: 'x.example.invalid'})).toBe('x.example.invalid')
    expect(resolveTracesHost({})).toBe(TRACES_DEFAULT_HOST)
  })

  it('validates whatever it resolves', () => {
    expect(() => resolveTracesHost({TRACES_HOST: '-oProxyCommand=evil'})).toThrow('Invalid TRACES_HOST')
    expect(() => resolveTracesHost({}, 'ABSENT_BUT_DEFAULTED')).not.toThrow()
    expect(() => resolveTracesOrigin({TRACES_DOMAIN: 'bad host'})).toThrow('Invalid TRACES_HOST')
  })

  it('builds the origin from the domain and defaults to the public hostname', () => {
    expect(resolveTracesOrigin({})).toBe('https://traces.fro.bot')
    expect(resolveTracesOrigin({TRACES_DOMAIN: 'traces.example.invalid'})).toBe('https://traces.example.invalid')
  })
})

// The constants this file repeats come from the app and the compose file. `packages/` never imports `apps/`,
// so these tests read the sources as text.
describe('constants match the app', async () => {
  const hostSource = await Bun.file(new URL('../../../../../apps/traces/src/host.ts', import.meta.url)).text()
  const composeSource = await Bun.file(
    new URL('../../../../../apps/traces/docker-compose.yaml', import.meta.url),
  ).text()

  it('the app directory is the one apps/traces lays out', () => {
    const mount = /TRACES_VOLUME_MOUNT = '([^']+)'/.exec(hostSource)?.[1]
    expect(mount).toBeDefined()
    expect(hostSource).toContain(['TRACES_APP_DIR = `$', '{TRACES_VOLUME_MOUNT}/app`'].join(''))
    expect(TRACES_APP_DIR).toBe(`${mount}/app`)
  })

  it('the sender groups are the app sender groups', () => {
    const groups = /SENDER_GROUPS = \[([^\]]+)\]/.exec(hostSource)?.[1]
    const parsed = (groups ?? '').split(',').map(entry => entry.trim().replaceAll("'", ''))
    expect([...TRACES_GROUPS] as string[]).toEqual(parsed)
  })

  it('the log services are exactly the compose services', () => {
    const services = Object.keys((Bun.YAML.parse(composeSource) as {services: Record<string, unknown>}).services)
    expect([...TRACES_SERVICES].sort() as string[]).toEqual(services.sort())
  })

  it('the reader files and placeholders are the ones apps/traces lays out', () => {
    const constant = (name: string): string | undefined => {
      const literal = new RegExp(`${name} = '([^']+)'`).exec(hostSource)?.[1]
      if (literal !== undefined) return literal
      return new RegExp(`${name} = \`([^\`]+)\``).exec(hostSource)?.[1]
    }
    const appDir = ['$', '{TRACES_APP_DIR}'].join('')
    const readerDir = ['$', '{TRACES_READER_DIR}'].join('')
    expect(constant('TRACES_READER_DIR')).toBe(`${appDir}/readers`)
    expect(constant('TRACES_READER_TOKEN_FILE')).toBe(`${readerDir}/token`)
    expect(constant('TRACES_READER_LOCK')).toBe(`${readerDir}/.lock`)
    expect(constant('TRACES_READER_LANGFUSE_FILE')).toBe(`${appDir}/secrets/reader-gate/langfuse-basic`)
    expect(constant('TRACES_GRAFANA_MCP_TOKEN_FILE')).toBe(`${appDir}/secrets/grafana-mcp/token`)
    expect(constant('READER_LANGFUSE_PLACEHOLDER')).toBe(READER_LANGFUSE_PLACEHOLDER)
    expect(constant('READER_GRAFANA_PLACEHOLDER')).toBe(READER_GRAFANA_PLACEHOLDER)

    expect(TRACES_READER_DIR).toBe(`${TRACES_APP_DIR}/readers`)
    expect(TRACES_READER_TOKEN_FILE).toBe(`${TRACES_READER_DIR}/token`)
    expect(TRACES_READER_LOCK).toBe(`${TRACES_READER_DIR}/.lock`)
    expect(TRACES_READER_LANGFUSE_FILE).toBe(`${TRACES_APP_DIR}/secrets/reader-gate/langfuse-basic`)
    expect(TRACES_GRAFANA_MCP_TOKEN_FILE).toBe(`${TRACES_APP_DIR}/secrets/grafana-mcp/token`)
  })

  it('the reporter detail command targets the loopback port and path the reporter serves', async () => {
    const reporter = await Bun.file(new URL('../../../../../apps/traces/src/health-report.ts', import.meta.url)).text()
    expect(reporter).toContain('detail: 8081')
    expect(reporter).toContain("DETAIL_PATH = '/detail'")
  })
})
