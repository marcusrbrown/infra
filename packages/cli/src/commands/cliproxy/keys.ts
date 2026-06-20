import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import {
  managementHeaders,
  parseManagementKeyList,
  requestJson,
  toStringArray,
} from '@marcusrbrown/infra-shared/cliproxy/management'
import {z} from 'zod'

export {toStringArray} from '@marcusrbrown/infra-shared/cliproxy/management'

/** Minimal ctx surface consumed by cliproxy keys actions. Satisfied by both GokeExecutionContext and CapturedCtx. */
// ActionCtx imported from lib/action-ctx — single source of truth for action ctx shape

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

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

export interface KeysListOptions {
  url?: string
  key?: string
  json?: boolean
}

export async function cliproxyKeysListAction(options: KeysListOptions, ctx: ActionCtx): Promise<string[]> {
  try {
    const baseUrl = resolveBaseUrl(options.url)
    const managementKey = resolveManagementKey(options.key)
    const endpoint = `${baseUrl}/v0/management/api-keys`
    const payload = await requestJson(endpoint, {
      method: 'GET',
      headers: managementHeaders(managementKey),
    })

    const keys = toStringArray(payload)
    ctx.console.error('⚠️  Output contains API keys — avoid logging or storing in shared locations')

    if (options.json) {
      ctx.console.log(JSON.stringify(keys, null, 2))
    } else if (keys.length === 0) {
      ctx.console.log('No API keys configured')
    } else {
      for (const [index, apiKey] of keys.entries()) {
        ctx.console.log(`${index + 1}. ${apiKey}`)
      }
    }

    return keys
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
    return [] // unreachable; satisfies TS that all paths return
  }
}

export interface KeysAddOptions {
  url?: string
  key?: string
}

export async function cliproxyKeysAddAction(
  apiKeyToAdd: string,
  options: KeysAddOptions,
  ctx: ActionCtx,
): Promise<void> {
  try {
    const baseUrl = resolveBaseUrl(options.url)
    const managementKey = resolveManagementKey(options.key)
    const endpoint = `${baseUrl}/v0/management/api-keys`

    const currentPayload = await requestJson(endpoint, {
      method: 'GET',
      headers: managementHeaders(managementKey),
    })
    // Strict parse: a malformed or unexpected GET response must fail closed before the
    // destructive PUT replaces the entire key list. Permissive parsing would collapse
    // unknown shapes to [] and overwrite existing keys.
    const currentKeys = parseManagementKeyList(currentPayload)

    if (currentKeys.includes(apiKeyToAdd)) {
      ctx.console.log('Key already present; no update required.')
      return
    }

    const nextKeys = [...currentKeys, apiKeyToAdd]
    await requestJson(endpoint, {
      method: 'PUT',
      headers: managementHeaders(managementKey),
      body: JSON.stringify(nextKeys),
    })

    ctx.console.log(`Added key "${apiKeyToAdd}". Current key count: ${nextKeys.length}.`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
  }
}

export interface KeysRemoveOptions {
  url?: string
  key?: string
}

export async function cliproxyKeysRemoveAction(
  apiKeyToRemove: string,
  options: KeysRemoveOptions,
  ctx: ActionCtx,
): Promise<void> {
  try {
    const baseUrl = resolveBaseUrl(options.url)
    const managementKey = resolveManagementKey(options.key)
    const params = new URLSearchParams({value: apiKeyToRemove})
    const endpoint = `${baseUrl}/v0/management/api-keys?${params.toString()}`

    const payload = await requestJson(endpoint, {
      method: 'DELETE',
      headers: managementHeaders(managementKey),
    })

    ctx.console.log(JSON.stringify(payload, null, 2))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
  }
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
      z.string().describe('Management API key. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .option('--json', 'Output raw JSON array instead of a numbered list.')
    .action(cliproxyKeysListAction)

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
      z.string().describe('Management API key. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .example('# Add a new API key to the current key set')
    .example('infra cliproxy keys add sk-live-123')
    .action(cliproxyKeysAddAction)

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
      z.string().describe('Management API key. Falls back to CLIPROXY_MANAGEMENT_KEY when omitted.'),
    )
    .example('# Remove an API key from CLIProxyAPI')
    .example('infra cliproxy keys remove sk-live-123')
    .action(cliproxyKeysRemoveAction)
}
