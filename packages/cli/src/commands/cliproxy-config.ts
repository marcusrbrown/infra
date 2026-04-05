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

  throw new Error('debug expects a boolean value: true or false')
}

export function parseNumber(value: string, field: string): number {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} expects a numeric value`)
  }

  return parsed
}

export function buildSetRequest(baseUrl: string, field: string, rawValue: string): {endpoint: string; body: string} {
  if (field === 'debug') {
    return {
      endpoint: `${baseUrl}/v0/management/debug`,
      body: JSON.stringify({debug: parseBoolean(rawValue)}),
    }
  }

  if (field === 'request-retry') {
    return {
      endpoint: `${baseUrl}/v0/management/request-retry`,
      body: JSON.stringify({request_retry: parseNumber(rawValue, 'request-retry')}),
    }
  }

  if (field === 'proxy-url') {
    return {
      endpoint: `${baseUrl}/v0/management/proxy-url`,
      body: JSON.stringify({proxy_url: rawValue}),
    }
  }

  throw new Error(
    `Key "${field}" is not mutable via API. Only debug, request-retry, and proxy-url are supported. Edit config.yaml directly for other keys.`,
  )
}

export function registerCliproxyConfig(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy config get', 'Fetch current CLIProxyAPI management config and print it as formatted JSON.')
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
      'cliproxy config set <key> <value>',
      'Update mutable CLIProxyAPI config values through management endpoints (debug, request-retry, proxy-url).',
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
    .example('# Enable debug mode via management API')
    .example('infra cliproxy config set debug true')
    .example('# Update request retry budget to 3')
    .example('infra cliproxy config set request-retry 3')
    .example('# Point proxy upstream to a different URL')
    .example('infra cliproxy config set proxy-url https://example.com')
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
