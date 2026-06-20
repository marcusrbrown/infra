import {readFileSync} from 'node:fs'

import {parse as parseYaml} from 'yaml'

// ─── Types ────────────────────────────────────────────────────────────────────

/** A single model alias entry mapping a client-facing name to an upstream model. */
export interface OAuthModelAliasEntry {
  name: string
  alias: string
  fork: boolean
}

/**
 * The `oauth-model-alias` configuration object.
 * Keyed by provider; only `claude` is supported today.
 */
export interface OAuthModelAlias {
  claude: OAuthModelAliasEntry[]
}

// ─── HTTP primitives ──────────────────────────────────────────────────────────

/** Default HTTP timeout for management API requests (10 seconds). */
export const HTTP_TIMEOUT_MS = 10_000

/**
 * Permissive parser for /v0/management/api-keys list responses. Returns [] on every
 * unknown shape. Use ONLY for display paths (e.g. `cliproxy keys list`) where
 * empty-on-malformed is acceptable. Mutating callers (createManagementApiKey,
 * deleteManagementApiKey, `cliproxy keys add`) must use parseManagementKeyList
 * below — the permissive default would cause a destructive PUT to replace the
 * entire key list with just the new key.
 */
export function toStringArray(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    return payload.filter((item): item is string => typeof item === 'string')
  }

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const value = obj['api-keys'] ?? obj.api_keys
    if (Array.isArray(value)) {
      return value.filter((item): item is string => typeof item === 'string')
    }
  }

  return []
}

/**
 * Strict parser for /v0/management/api-keys list responses used by mutating callers.
 * Falls back to throw on any unknown shape — never returns [] on malformed input.
 * Accepts string[], {api-keys: string[]}, or {api_keys: string[]}. Throws on every other shape.
 */
export function parseManagementKeyList(payload: unknown): string[] {
  if (Array.isArray(payload)) {
    if (!payload.every((item): item is string => typeof item === 'string')) {
      throw new Error(
        `Unexpected management key-list shape: top-level array contains non-string entries (got ${JSON.stringify(payload).slice(0, 100)})`,
      )
    }
    return payload
  }

  if (payload !== null && typeof payload === 'object') {
    const obj = payload as Record<string, unknown>
    const value = obj['api-keys'] ?? obj.api_keys
    if (Array.isArray(value) && value.every((item): item is string => typeof item === 'string')) {
      return value
    }
  }

  throw new Error(
    `Unexpected management key-list shape: expected string[] or {api-keys: string[]} (got ${JSON.stringify(payload).slice(0, 100)})`,
  )
}

/** Build management API request headers with the management key and JSON content-type. */
export function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('x-management-key', key)
  headers.set('content-type', 'application/json')
  return headers
}

/**
 * Fetch a JSON endpoint with a timeout. Throws on non-2xx or malformed JSON.
 * Returns null on 204 No Content.
 *
 * JSON parse failures must surface — permissive parsing here caused a data-loss
 * class bug (PR #312 Fro Bot review): bad management JSON would silently become
 * null, then toStringArray(null) → [], then a destructive PUT would replace the
 * entire key list with just the new key.
 */
export async function requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
  const response = await fetch(endpoint, {
    ...init,
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${init.method ?? 'GET'} ${endpoint} failed with HTTP ${response.status}: ${body}`)
  }

  // 204 No Content is a valid empty response for some mutations.
  if (response.status === 204) return null

  try {
    return await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`${init.method ?? 'GET'} ${endpoint} returned malformed JSON: ${message}`)
  }
}

// ─── OAuth model alias helpers ────────────────────────────────────────────────

/** Empty alias object — used as the canonical "nothing configured" value. */
function emptyAlias(): OAuthModelAlias {
  return {claude: []}
}

/**
 * Coerce a raw `fork` field value to boolean.
 * Accepts: true, false, "true", "false".
 * Returns undefined for any other value (signals rejection).
 *
 * The server read-back may return fork as a JSON string "true"/"false" instead
 * of a boolean — this normalizes both representations.
 */
function coerceFork(value: unknown): boolean | undefined {
  if (value === true || value === false) return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/**
 * Parse and validate an array of raw claude alias entries.
 *
 * - Accepts `fork` as boolean OR string "true"/"false" (server read-back may return strings).
 * - Rejects entries with missing/empty name or alias, or unrecognized fork values.
 * - Calls `onDrop(index)` for each rejected entry so callers can warn.
 */
export function parseClaudeEntries(raw: unknown, onDrop?: (index: number) => void): OAuthModelAliasEntry[] {
  if (!Array.isArray(raw)) return []

  const result: OAuthModelAliasEntry[] = []
  for (const [i, entry] of raw.entries()) {
    if (entry === null || typeof entry !== 'object') {
      onDrop?.(i)
      continue
    }
    const e = entry as Record<string, unknown>
    const name = e.name
    const alias = e.alias
    const forkCoerced = coerceFork(e.fork)

    if (
      typeof name !== 'string' ||
      name === '' ||
      typeof alias !== 'string' ||
      alias === '' ||
      forkCoerced === undefined
    ) {
      onDrop?.(i)
      continue
    }

    result.push({name, alias, fork: forkCoerced})
  }
  return result
}

/**
 * Read the `oauth-model-alias` block from a CLIProxyAPI config YAML file.
 * Returns an empty alias object when the key is absent or the file has no alias block.
 * Warns via console.warn when entries are dropped due to malformed shape.
 */
export function readOAuthModelAliasFromConfig(configPath: string): OAuthModelAlias {
  const raw = readFileSync(configPath, 'utf8')
  const parsed = parseYaml(raw) as Record<string, unknown> | null

  if (!parsed || typeof parsed !== 'object') {
    return emptyAlias()
  }

  const aliasBlock = parsed['oauth-model-alias']
  if (!aliasBlock || typeof aliasBlock !== 'object') {
    return emptyAlias()
  }

  const block = aliasBlock as Record<string, unknown>
  const claudeEntries = block.claude

  if (!Array.isArray(claudeEntries)) {
    return emptyAlias()
  }

  const dropped: number[] = []
  const claude = parseClaudeEntries(claudeEntries, index => dropped.push(index))

  if (dropped.length > 0) {
    console.warn(
      `\u001B[1;33m⚠\u001B[0m  oauth-model-alias: dropped ${dropped.length} malformed entr${dropped.length === 1 ? 'y' : 'ies'} at index ${dropped.join(', ')} in ${configPath} (missing/invalid name, alias, or fork field)`,
    )
  }

  return {claude}
}

/**
 * Apply an `OAuthModelAlias` to the CLIProxyAPI management API via a bare-object PUT.
 *
 * The body IS the OAuthModelAlias object `{claude: [...]}` — NOT wrapped in
 * `{value: ...}` or `{oauth-model-alias: ...}`. Those wrappers return 200 but
 * store nothing (verified live).
 *
 * The management key is NEVER included in thrown error messages.
 */
export async function applyOAuthModelAlias({
  baseUrl,
  key,
  body,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  body: OAuthModelAlias
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/oauth-model-alias`
  const response = await fetchFn(endpoint, {
    method: 'PUT',
    headers: managementHeaders(key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`PUT /v0/management/oauth-model-alias failed with HTTP ${response.status}: ${responseBody}`)
  }
}

/**
 * Read back the current `oauth-model-alias` from the CLIProxyAPI management API.
 * The GET response wraps the value as `{"oauth-model-alias": {...}}`.
 * Returns an empty alias when the field is null or absent.
 * Tolerates `fork` returned as string "true"/"false" (server shape variance).
 */
export async function readBackOAuthModelAlias({
  baseUrl,
  key,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  fetch?: typeof globalThis.fetch
}): Promise<OAuthModelAlias> {
  const endpoint = `${baseUrl}/v0/management/oauth-model-alias`
  const response = await fetchFn(endpoint, {
    method: 'GET',
    headers: managementHeaders(key),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(`GET /v0/management/oauth-model-alias failed with HTTP ${response.status}: ${responseBody}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`GET /v0/management/oauth-model-alias returned malformed JSON: ${message}`)
  }

  if (!payload || typeof payload !== 'object') {
    return emptyAlias()
  }

  const wrapper = payload as Record<string, unknown>
  const aliasValue = wrapper['oauth-model-alias']

  if (!aliasValue || typeof aliasValue !== 'object') {
    return emptyAlias()
  }

  const aliasObj = aliasValue as Record<string, unknown>
  const claudeEntries = aliasObj.claude

  if (!Array.isArray(claudeEntries)) {
    return emptyAlias()
  }

  // No onDrop warning here — server shape variance (string fork) is expected and normalized silently.
  const claude = parseClaudeEntries(claudeEntries)

  return {claude}
}

/**
 * Order-insensitive set equality for two `OAuthModelAlias` objects.
 * Compares the `claude` arrays by `name`, `alias`, and `fork`.
 * Returns false if counts differ or any entry differs.
 */
export function setEqualOAuthModelAlias(desired: OAuthModelAlias, actual: OAuthModelAlias): boolean {
  if (desired.claude.length !== actual.claude.length) {
    return false
  }

  // Build a canonical key for each entry
  const entryKey = (e: OAuthModelAliasEntry): string => `${e.name}|${e.alias}|${e.fork}`

  const desiredKeys = new Set(desired.claude.map(entryKey))
  const actualKeys = new Set(actual.claude.map(entryKey))

  if (desiredKeys.size !== actualKeys.size) {
    return false
  }

  for (const key of desiredKeys) {
    if (!actualKeys.has(key)) {
      return false
    }
  }

  return true
}
