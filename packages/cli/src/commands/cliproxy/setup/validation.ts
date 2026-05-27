import type {SetupOptions} from '../setup'
import {parseProviders, type ProviderId} from './providers'

export const MODEL_ID_RE = /^(?:anthropic|openai)\/[a-z\d](?:[a-z\d.\-]*[a-z\d])?$/

const HTTP_TIMEOUT_MS = 10_000

/** Local copy — avoids a circular import with setup.ts (validation → setup → validation). */
function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function validateSetupOptions(options: SetupOptions, isInteractive: boolean): void {
  if (isInteractive) {
    return
  }

  // Validate providers/model first (independent of key/repo/harness)
  if (options.providers) {
    const providers = parseProviders(options.providers)

    if (providers.length > 1 && !options.model) {
      throw new Error('Pass --model <provider/model-id> when selecting multiple providers.')
    }

    if (options.model) {
      const slashIndex = options.model.indexOf('/')
      const prefix = slashIndex === -1 ? options.model : options.model.slice(0, slashIndex)
      if (!providers.includes(prefix as ProviderId)) {
        throw new Error(
          `Model prefix ${prefix} does not match selected providers (${providers.join(', ')}). Valid prefixes: ${providers.join(', ')}/`,
        )
      }
    }
  }

  if (!options.dryRun && !options.key) {
    throw new Error('--key is required when stdin is not a TTY. Provide an existing CLIProxyAPI key value.')
  }

  if (!options.repo) {
    throw new Error('--repo is required when stdin is not a TTY. Provide the target GitHub repository as owner/repo.')
  }

  if (!options.harness) {
    throw new Error('--harness is required when stdin is not a TTY. Choose opencode or claude-code.')
  }

  if (options.harness === 'generic') {
    throw new Error('--harness generic is interactive-only because it requires custom secret names.')
  }
}

/**
 * Verifies that the required models are available on the proxy.
 *
 * Short-circuits immediately for anthropic-only setups — no fetch is made.
 * Never echoes the Authorization header in any error message.
 */
export async function verifyModelsAvailable(
  baseUrl: string,
  key: string,
  providers: ProviderId[],
  model: string,
): Promise<void> {
  // Anthropic-only: no fetch needed
  if (providers.length === 1 && providers[0] === 'anthropic') {
    return
  }

  const endpoint = `${baseUrl}/v1/models`
  const response = await fetch(endpoint, {
    headers: {Authorization: `Bearer ${key}`},
    signal: AbortSignal.timeout(10_000),
  })

  if (response.status === 401 || response.status === 403) {
    throw new Error('Proxy key rejected. Verify with `cliproxy keys list` or rerun setup to create a new one.')
  }

  if (!response.ok) {
    const rawBody = await response.text()
    // Redact any Authorization headers or sk-* token-shaped strings that the server might echo
    const redacted = rawBody
      .replaceAll(/Bearer\s+[^\s"]+/g, 'Bearer <redacted>')
      .replaceAll(/sk-[\w.-]{8,}/g, 'sk-<redacted>')
    const excerpt = redacted.slice(0, 200)
    throw new Error(`/v1/models returned HTTP ${response.status}: ${excerpt}`)
  }

  const json = (await response.json()) as unknown
  const data = (json as Record<string, unknown>)?.data

  if (!Array.isArray(data)) {
    throw new TypeError('Unexpected response from /v1/models: data is not an array.')
  }

  interface ModelEntry {
    id: string
    owned_by: string
  }
  const entries = data as ModelEntry[]

  // OpenAI presence check
  if (providers.includes('openai')) {
    const hasOpenAi = entries.some(e => e.owned_by === 'openai')
    if (!hasOpenAi) {
      throw new Error('No OpenAI models on proxy — is the Codex token loaded? Try `cliproxy login codex`.')
    }
  }

  // Model presence check: strip provider prefix to get bare id
  const slashIndex = model.indexOf('/')
  const bareId = slashIndex === -1 ? model : model.slice(slashIndex + 1)
  const providerPrefix = slashIndex >= 0 ? model.slice(0, slashIndex) : undefined

  const modelPresent = entries.some(e => e.id === bareId)
  if (!modelPresent) {
    // List available ids for the matching provider only
    const matchingIds = providerPrefix
      ? entries.filter(e => e.owned_by === providerPrefix).map(e => e.id)
      : entries.map(e => e.id)
    const available = matchingIds.length > 0 ? matchingIds.join(', ') : '(none)'
    throw new Error(`Model "${bareId}" not found on proxy. Available ${providerPrefix ?? 'models'}: ${available}`)
  }
}

export async function assertProxyReachable(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(baseUrl, {
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`Proxy check failed for ${baseUrl}: HTTP ${response.status}. Is the proxy running and reachable?`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Proxy check failed')) {
      throw error
    }
    throw new Error(`Unable to reach proxy at ${baseUrl}: ${extractErrorMessage(error)}`)
  }
}

export async function assertProxyKeyWorks(baseUrl: string, keyValue: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/v1/models`, {
      headers: {
        authorization: `Bearer ${keyValue}`,
      },
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    })

    if (!response.ok) {
      throw new Error(`Proxy key verification failed with HTTP ${response.status}`)
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Proxy key verification')) {
      throw error
    }
    throw new Error(`Unable to verify proxy key at ${baseUrl}: ${extractErrorMessage(error)}`)
  }
}
