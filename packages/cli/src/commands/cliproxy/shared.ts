// Shared HTTP helpers for cliproxy commands.

export const HTTP_TIMEOUT_MS = 10_000

/**
 * Normalise a CLIProxyAPI management-key list response to a plain string array.
 * Handles both top-level arrays and object-shaped payloads ({api-keys:[...]} or {api_keys:[...]}).
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

  try {
    return await response.json()
  } catch {
    return null
  }
}
