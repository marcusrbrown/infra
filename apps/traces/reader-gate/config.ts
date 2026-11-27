// Gate configuration: four environment variables with the contract's defaults. The limits and deadlines are code
// constants (`constants.ts`), not environment variables.

import {DEFAULTS} from './constants'

export interface GateConfig {
  tokenFile: string
  langfuseBasicFile: string
  langfuseUpstream: string
  grafanaMcpUpstream: string
}

export type Env = Record<string, string | undefined>

/** An upstream is an origin: http or https, no credentials, path, query or fragment. Returns it without a trailing slash. */
function parseUpstream(name: string, value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error(`${name} is not a URL`)
  }
  const plain =
    url.pathname === '/' && url.search === '' && url.hash === '' && url.username === '' && url.password === ''
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || !plain || value.endsWith('?') || value.endsWith('#')) {
    throw new Error(`${name} must be an http or https origin with no credentials, path, query or fragment`)
  }
  return url.origin
}

export function loadConfig(env: Env): GateConfig {
  return {
    tokenFile: env.READER_TOKEN_FILE ?? DEFAULTS.tokenFile,
    langfuseBasicFile: env.LANGFUSE_BASIC_FILE ?? DEFAULTS.langfuseBasicFile,
    langfuseUpstream: parseUpstream('LANGFUSE_UPSTREAM', env.LANGFUSE_UPSTREAM ?? DEFAULTS.langfuseUpstream),
    grafanaMcpUpstream: parseUpstream('GRAFANA_MCP_UPSTREAM', env.GRAFANA_MCP_UPSTREAM ?? DEFAULTS.grafanaMcpUpstream),
  }
}
