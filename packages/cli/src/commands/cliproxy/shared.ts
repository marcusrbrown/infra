// Shared HTTP helpers for cliproxy commands.

export const HTTP_TIMEOUT_MS = 10_000

// Permissive parser for /v0/management/api-keys list responses. Returns [] on every
// unknown shape. Use ONLY for display paths (e.g. `cliproxy keys list`) where
// empty-on-malformed is acceptable. Mutating callers (createManagementApiKey,
// deleteManagementApiKey, `cliproxy keys add`) must use parseManagementKeyList
// below — the permissive default would cause a destructive PUT to replace the
// entire key list with just the new key.
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

// Strict parser for /v0/management/api-keys list responses used by mutating callers.
// Falls back to throw on any unknown shape — never returns [] on malformed input.
// Accepts string[], {api-keys: string[]}, or {api_keys: string[]}. Throws on every other shape.
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

export function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('x-management-key', key)
  headers.set('content-type', 'application/json')
  return headers
}

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

  // JSON parse failures must surface — permissive parsing here caused a data-loss
  // class bug (PR #312 Fro Bot review): bad management JSON would silently become
  // null, then toStringArray(null) → [], then a destructive PUT would replace the
  // entire key list with just the new key.
  try {
    return await response.json()
  } catch (parseError) {
    const message = parseError instanceof Error ? parseError.message : String(parseError)
    throw new Error(`${init.method ?? 'GET'} ${endpoint} returned malformed JSON: ${message}`)
  }
}
