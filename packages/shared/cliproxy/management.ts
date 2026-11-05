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

// ─── OpenAI-compatibility upstream helpers ────────────────────────────────────

/** A model exposed by an `openai-compatibility` upstream. */
export interface OpenAICompatModel {
  name: string
  alias: string
}

/**
 * One entry of the CLIProxyAPI `openai-compatibility` section.
 *
 * `prefix`, `headers` and `disabled` are optional on the tracked (desired) side;
 * `normalizeOpenAICompatEntry` fills them in so desired and live entries compare equal.
 * Server-added fields (`auth-index`) are not part of this type.
 */
export interface OpenAICompatEntry {
  name: string
  prefix?: string
  'base-url': string
  'api-key-entries': {'api-key': string}[]
  models: OpenAICompatModel[]
  headers?: Record<string, string>
  disabled?: boolean
}

const OPENAI_COMPAT_ENDPOINT = '/v0/management/openai-compatibility'

/** Longest response-body excerpt placed in an error message. */
const ERROR_BODY_LIMIT = 200

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Parse one raw `openai-compatibility` entry into a normalized {@link OpenAICompatEntry}.
 *
 * - Drops server-added fields such as `auth-index` (and any other unknown field).
 * - Defaults `prefix` to '', `headers` to {}, `disabled` to false and a missing model `alias` to ''.
 * - Throws on a malformed shape. Errors name the field path only — never a field value, since
 *   `api-key` values are secrets.
 */
export function normalizeOpenAICompatEntry(raw: unknown, index = 0): OpenAICompatEntry {
  const at = `openai-compatibility[${index}]`
  if (!isRecord(raw)) {
    throw new TypeError(`${at} is not an object`)
  }

  if (typeof raw.name !== 'string' || raw.name === '') {
    throw new TypeError(`${at}.name is missing or not a non-empty string`)
  }
  if (typeof raw['base-url'] !== 'string' || raw['base-url'] === '') {
    throw new TypeError(`${at}.base-url is missing or not a non-empty string`)
  }
  if (raw.prefix !== undefined && raw.prefix !== null && typeof raw.prefix !== 'string') {
    throw new TypeError(`${at}.prefix is not a string`)
  }
  if (raw.disabled !== undefined && raw.disabled !== null && typeof raw.disabled !== 'boolean') {
    throw new TypeError(`${at}.disabled is not a boolean`)
  }

  const rawKeys = raw['api-key-entries'] ?? []
  if (!Array.isArray(rawKeys)) {
    throw new TypeError(`${at}.api-key-entries is not an array`)
  }
  const apiKeyEntries = rawKeys.map((item: unknown, keyIndex) => {
    if (!isRecord(item) || typeof item['api-key'] !== 'string') {
      throw new TypeError(`${at}.api-key-entries[${keyIndex}].api-key is missing or not a string`)
    }
    return {'api-key': item['api-key']}
  })

  const rawModels = raw.models ?? []
  if (!Array.isArray(rawModels)) {
    throw new TypeError(`${at}.models is not an array`)
  }
  const models = rawModels.map((item: unknown, modelIndex): OpenAICompatModel => {
    if (!isRecord(item) || typeof item.name !== 'string' || item.name === '') {
      throw new TypeError(`${at}.models[${modelIndex}].name is missing or not a non-empty string`)
    }
    if (item.alias !== undefined && item.alias !== null && typeof item.alias !== 'string') {
      throw new TypeError(`${at}.models[${modelIndex}].alias is not a string`)
    }
    return {name: item.name, alias: item.alias ?? ''}
  })

  const rawHeaders = raw.headers ?? {}
  if (!isRecord(rawHeaders)) {
    throw new TypeError(`${at}.headers is not an object`)
  }
  const headers: Record<string, string> = {}
  for (const [headerName, headerValue] of Object.entries(rawHeaders)) {
    if (typeof headerValue !== 'string') {
      throw new TypeError(`${at}.headers.${headerName} is not a string`)
    }
    headers[headerName] = headerValue
  }

  return {
    name: raw.name,
    prefix: raw.prefix ?? '',
    'base-url': raw['base-url'],
    'api-key-entries': apiKeyEntries,
    models,
    headers,
    disabled: raw.disabled ?? false,
  }
}

/** Replace every secret occurrence in `text` and cap its length for use in an error message. */
function scrubForError(text: string, secrets: readonly string[]): string {
  let scrubbed = text
  for (const secret of secrets) {
    if (secret !== '') scrubbed = scrubbed.split(secret).join('[redacted]')
  }
  return scrubbed.length > ERROR_BODY_LIMIT ? `${scrubbed.slice(0, ERROR_BODY_LIMIT)}…` : scrubbed
}

/**
 * Read back the `openai-compatibility` list from the CLIProxyAPI management API.
 * The GET response wraps the list as `{"openai-compatibility": [...]}`; a null or absent
 * field is an empty section. Entries are normalized (see {@link normalizeOpenAICompatEntry}).
 *
 * Throws on a malformed payload rather than returning [] — a mutating caller treats [] as
 * "empty section, safe to bootstrap". The management key and live `api-key` values are
 * NEVER included in thrown error messages.
 */
export async function readBackOpenAICompat({
  baseUrl,
  key,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  fetch?: typeof globalThis.fetch
}): Promise<OpenAICompatEntry[]> {
  const response = await fetchFn(`${baseUrl}${OPENAI_COMPAT_ENDPOINT}`, {
    method: 'GET',
    headers: managementHeaders(key),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(
      `GET ${OPENAI_COMPAT_ENDPOINT} failed with HTTP ${response.status}: ${scrubForError(responseBody, [key])}`,
    )
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    // The parser message can quote a fragment of the body, which holds live api-key values.
    throw new Error(`GET ${OPENAI_COMPAT_ENDPOINT} returned malformed JSON`)
  }

  if (!isRecord(payload)) {
    throw new TypeError(`GET ${OPENAI_COMPAT_ENDPOINT} returned an unexpected shape: expected an object`)
  }

  const list = payload['openai-compatibility']
  if (list === undefined || list === null) return []
  if (!Array.isArray(list)) {
    throw new TypeError(
      `GET ${OPENAI_COMPAT_ENDPOINT} returned an unexpected shape: openai-compatibility is not an array`,
    )
  }

  return list.map((raw: unknown, index) => normalizeOpenAICompatEntry(raw, index))
}

/**
 * Replace the whole `openai-compatibility` list via a bare-array PUT.
 *
 * The body IS the array — not wrapped in `{items: ...}` (rejected by the server). A bare `[]`
 * is ACCEPTED by the server and clears the section, so this throws before sending anything when
 * `body` is empty: this guard is the only protection against wiping the section.
 *
 * The management key and `api-key` values are NEVER included in thrown error messages.
 */
export async function applyOpenAICompat({
  baseUrl,
  key,
  body,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  body: readonly OpenAICompatEntry[]
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  if (body.length === 0) {
    throw new Error(
      `Refusing to PUT an empty ${OPENAI_COMPAT_ENDPOINT} list: the server would accept it and clear the section`,
    )
  }

  const response = await fetchFn(`${baseUrl}${OPENAI_COMPAT_ENDPOINT}`, {
    method: 'PUT',
    headers: managementHeaders(key),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    const secrets = [key, ...body.flatMap(entry => entry['api-key-entries'].map(item => item['api-key']))]
    throw new Error(
      `PUT ${OPENAI_COMPAT_ENDPOINT} failed with HTTP ${response.status}: ${scrubForError(responseBody, secrets)}`,
    )
  }
}

/**
 * Enable or disable one `openai-compatibility` entry by name via PATCH.
 * The body is exactly `{name, value: {disabled}}`. A disabled entry's models leave `/v1/models`
 * within about 180 ms while the management GET still lists the entry.
 *
 * The management key is NEVER included in thrown error messages.
 */
export async function patchOpenAICompatDisabled({
  baseUrl,
  key,
  name,
  disabled,
  fetch: fetchFn = globalThis.fetch,
}: {
  baseUrl: string
  key: string
  name: string
  disabled: boolean
  fetch?: typeof globalThis.fetch
}): Promise<void> {
  const response = await fetchFn(`${baseUrl}${OPENAI_COMPAT_ENDPOINT}`, {
    method: 'PATCH',
    headers: managementHeaders(key),
    body: JSON.stringify({name, value: {disabled}}),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  })

  if (!response.ok) {
    const responseBody = await response.text()
    throw new Error(
      `PATCH ${OPENAI_COMPAT_ENDPOINT} failed with HTTP ${response.status}: ${scrubForError(responseBody, [key])}`,
    )
  }
}

function sameStringSet(a: Iterable<string>, b: Iterable<string>): boolean {
  const setA = new Set(a)
  const setB = new Set(b)
  if (setA.size !== setB.size) return false
  for (const item of setA) {
    if (!setB.has(item)) return false
  }
  return true
}

/**
 * Order-insensitive equality for two `openai-compatibility` entries, after normalization
 * (missing `prefix`/`headers`/`disabled` default to ''/{}/false).
 *
 * - Models compare as a set of `{name, alias}`.
 * - API keys compare as a set of `api-key` values.
 * - Headers compare as a map (key order is irrelevant).
 */
export function setEqualOpenAICompatEntry(desired: OpenAICompatEntry, actual: OpenAICompatEntry): boolean {
  const a = normalizeOpenAICompatEntry(desired)
  const b = normalizeOpenAICompatEntry(actual)

  if (a.name !== b.name || a.prefix !== b.prefix || a['base-url'] !== b['base-url'] || a.disabled !== b.disabled) {
    return false
  }

  const modelKey = (model: OpenAICompatModel): string => JSON.stringify([model.name, model.alias])
  if (!sameStringSet(a.models.map(modelKey), b.models.map(modelKey))) return false

  if (
    !sameStringSet(
      a['api-key-entries'].map(item => item['api-key']),
      b['api-key-entries'].map(item => item['api-key']),
    )
  ) {
    return false
  }

  const headersA = Object.entries(a.headers ?? {})
  const headersB = Object.entries(b.headers ?? {})
  if (headersA.length !== headersB.length) return false
  const mapB = new Map(headersB)
  return headersA.every(([name, value]) => mapB.get(name) === value)
}

/**
 * Order-insensitive equality for two `openai-compatibility` lists, matching entries by `name`.
 * Returns false if counts or names differ, or any matched pair differs.
 */
export function setEqualOpenAICompat(
  desired: readonly OpenAICompatEntry[],
  actual: readonly OpenAICompatEntry[],
): boolean {
  if (desired.length !== actual.length) return false

  const actualByName = new Map(actual.map(entry => [entry.name, entry]))
  if (actualByName.size !== actual.length) return false

  const seen = new Set<string>()
  for (const entry of desired) {
    if (seen.has(entry.name)) return false
    seen.add(entry.name)
    const match = actualByName.get(entry.name)
    if (match === undefined || !setEqualOpenAICompatEntry(entry, match)) return false
  }
  return true
}
