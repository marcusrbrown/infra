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

function resolveManagementKey(input?: string): string {
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

export function toStringArray(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter(item => typeof item === 'string')
  }

  if (payload && typeof payload === 'object') {
    const value = (payload as Record<string, unknown>).api_keys
    if (Array.isArray(value)) {
      return value.filter(item => typeof item === 'string')
    }
  }

  return []
}

export function registerCliproxyKeys(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy keys list', 'List CLIProxyAPI API keys from the management API.')
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
      const endpoint = `${baseUrl}/v0/management/api-keys`
      const payload = await requestJson(endpoint, {
        method: 'GET',
        headers: managementHeaders(managementKey),
      })

      console.log(JSON.stringify(toStringArray(payload), null, 2))
    })

  cli
    .command(
      'cliproxy keys add <key>',
      'Add an API key by fetching current keys, appending the value, and replacing full key set.',
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
    .example('# Add a new API key to the current key set')
    .example('infra cliproxy keys add sk-live-123')
    .action(async (apiKeyToAdd, options) => {
      const baseUrl = resolveBaseUrl(options.url)
      const managementKey = resolveManagementKey(options.key)
      const endpoint = `${baseUrl}/v0/management/api-keys`

      const currentPayload = await requestJson(endpoint, {
        method: 'GET',
        headers: managementHeaders(managementKey),
      })
      const currentKeys = toStringArray(currentPayload)

      if (currentKeys.includes(apiKeyToAdd)) {
        console.log('Key already present; no update required.')
        return
      }

      const nextKeys = [...currentKeys, apiKeyToAdd]
      const updatedPayload = await requestJson(endpoint, {
        method: 'PUT',
        headers: managementHeaders(managementKey),
        body: JSON.stringify({api_keys: nextKeys}),
      })

      console.log(JSON.stringify(updatedPayload ?? {api_keys: nextKeys}, null, 2))
    })

  cli
    .command('cliproxy keys remove <key>', 'Remove an API key via management API endpoint query parameter.')
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
    .example('# Remove an API key from CLIProxyAPI')
    .example('infra cliproxy keys remove sk-live-123')
    .action(async (apiKeyToRemove, options) => {
      const baseUrl = resolveBaseUrl(options.url)
      const managementKey = resolveManagementKey(options.key)
      const params = new URLSearchParams({value: apiKeyToRemove})
      const endpoint = `${baseUrl}/v0/management/api-keys?${params.toString()}`

      const payload = await requestJson(endpoint, {
        method: 'DELETE',
        headers: managementHeaders(managementKey),
      })

      console.log(JSON.stringify(payload, null, 2))
    })
}
