import type {goke} from 'goke'

import {z} from 'zod'

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const HTTP_TIMEOUT_MS = 10_000

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveBaseUrl(input?: string): string {
  return stripTrailingSlash(input ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
}

export function resolveManagementKey(input?: string): string {
  const key = input ?? process.env.CLIPROXY_MANAGEMENT_KEY

  if (!key) {
    throw new Error('Management API key is required. Pass --key or set CLIPROXY_MANAGEMENT_KEY.')
  }

  return key
}

function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('authorization', `Bearer ${key}`)
  headers.set('x-management-key', key)
  headers.set('content-type', 'application/json')
  return headers
}

async function requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${init.method ?? 'GET'} ${endpoint} failed with HTTP ${response.status}: ${body}`)
  }

  try {
    return await response.json()
  } catch {
    return null
  }
}

export function parseBoolean(value: string): boolean {
  const normalized = value.toLowerCase()
  if (normalized === 'true') {
    return true
  }

  if (normalized === 'false') {
    return false
  }

  throw new Error(`Expected a boolean value (true/false), got: "${value}"`)
}

export function parseNumber(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} expects a numeric value, got: "${value}"`)
  }

  return parsed
}

type FieldType = 'boolean' | 'number' | 'string'

interface FieldSpec {
  path: string
  type: FieldType
}

const MUTABLE_FIELDS: Record<string, FieldSpec> = {
  debug: {path: '/debug', type: 'boolean'},
  'request-retry': {path: '/request-retry', type: 'number'},
  'max-retry-interval': {path: '/max-retry-interval', type: 'number'},
  'proxy-url': {path: '/proxy-url', type: 'string'},
  'request-log': {path: '/request-log', type: 'boolean'},
  'ws-auth': {path: '/ws-auth', type: 'boolean'},
  'logging-to-file': {path: '/logging-to-file', type: 'boolean'},
  'usage-statistics-enabled': {path: '/usage-statistics-enabled', type: 'boolean'},
  'force-model-prefix': {path: '/force-model-prefix', type: 'boolean'},
}

export function buildSetRequest(baseUrl: string, field: string, rawValue: string): {endpoint: string; body: string} {
  const spec = MUTABLE_FIELDS[field]
  if (!spec) {
    const supported = Object.keys(MUTABLE_FIELDS).join(', ')
    throw new Error(`"${field}" is not a supported mutable field. Supported: ${supported}`)
  }

  let value: boolean | number | string
  if (spec.type === 'boolean') {
    value = parseBoolean(rawValue)
  } else if (spec.type === 'number') {
    value = parseNumber(rawValue, field)
  } else {
    value = rawValue
  }

  return {
    endpoint: `${baseUrl}/v0/management${spec.path}`,
    body: JSON.stringify({value}),
  }
}

export function registerCliproxyConfig(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy config get', 'Fetch current CLIProxyAPI config as JSON.')
    .option(
      '--url [url]',
      z
        .string()
        .describe(
          'Base URL for CLIProxyAPI management requests. Falls back to CLIPROXY_URL or https://cliproxy.fro.bot.',
        ),
    )
    .option(
      '--key [key]',
      z.string().describe('Management API bearer token. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .action(async options => {
      const baseUrl = resolveBaseUrl(options.url)
      const managementKey = resolveManagementKey(options.key)
      const endpoint = `${baseUrl}/v0/management/config`
      const payload = await requestJson(endpoint, {
        method: 'GET',
        headers: managementHeaders(managementKey),
      })

      console.log(JSON.stringify(payload, null, 2))
    })

  cli
    .command(
      'cliproxy config set <field> <value>',
      'Update a mutable CLIProxyAPI config field via its dedicated management endpoint.',
    )
    .option(
      '--url [url]',
      z
        .string()
        .describe(
          'Base URL for CLIProxyAPI management requests. Falls back to CLIPROXY_URL or https://cliproxy.fro.bot.',
        ),
    )
    .option(
      '--key [key]',
      z.string().describe('Management API bearer token. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .example('infra cliproxy config set debug true')
    .example('infra cliproxy config set request-retry 5')
    .example('infra cliproxy config set proxy-url https://proxy.example.com')
    .action(async (field, value, options) => {
      const baseUrl = resolveBaseUrl(options.url)
      const managementKey = resolveManagementKey(options.key)
      const request = buildSetRequest(baseUrl, field, value)

      const payload = await requestJson(request.endpoint, {
        method: 'PUT',
        headers: managementHeaders(managementKey),
        body: request.body,
      })

      console.log(JSON.stringify(payload, null, 2))
    })
}
