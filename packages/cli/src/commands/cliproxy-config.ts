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

export function registerCliproxyConfig(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy config get',
      'Fetch current CLIProxyAPI config (read-only). To modify, edit config.yaml on the server and restart the container.',
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
}
