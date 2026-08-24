import type {SetupOptions} from './index'

import {z} from 'zod'

import {parseProviders, type ProviderId} from './providers'

// Permissive schema: unknown fields preserved via passthrough().
// owned_by is optional — CLIProxyAPI v7 may omit it; provider is inferred from id instead.
const modelEntrySchema = z
  .object({
    id: z.string(),
    owned_by: z.string().optional(),
  })
  .passthrough()

const modelsResponseSchema = z
  .object({
    data: z.array(modelEntrySchema),
  })
  .passthrough()

export const MODEL_ID_RE = /^(?:anthropic|openai)\/[a-z\d](?:[a-z\d.\-]*[a-z\d])?$/

const HTTP_TIMEOUT_MS = 10_000

type ModelEntry = z.infer<typeof modelEntrySchema>

// Known bare-id patterns per provider, used only when owned_by is absent
// (e.g. CLIProxyAPI v7 omits owned_by from /v1/models entries).
const PROVIDER_ID_PATTERNS: Record<string, RegExp> = {
  openai: /^(?:gpt-|o1-|o3-|codex)/i,
  anthropic: /^claude-/i,
}

/**
 * Decides whether a /v1/models entry belongs to a provider.
 * Prefers owned_by when present; falls back to id prefix / known bare-id
 * patterns when absent. Display/validation-only — never an auth or trust signal.
 */
function entryMatchesProvider(entry: ModelEntry, provider: string): boolean {
  if (entry.owned_by !== undefined && entry.owned_by.trim() !== '') {
    return entry.owned_by === provider
  }
  const id = entry.id ?? ''
  if (id.startsWith(`${provider}/`)) {
    return true
  }
  const pattern = PROVIDER_ID_PATTERNS[provider]
  return pattern === undefined ? false : pattern.test(id)
}

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
    // Redact the literal key value, Authorization headers, and sk-* shaped tokens
    const redacted = (key.length > 0 ? rawBody.replaceAll(key, '<redacted>') : rawBody)
      .replaceAll(/Bearer\s+[^\s"]+/g, 'Bearer <redacted>')
      .replaceAll(/sk-[\w.-]{8,}/g, 'sk-<redacted>')
    const excerpt = redacted.slice(0, 200)
    throw new Error(`/v1/models returned HTTP ${response.status}: ${excerpt}`)
  }

  const json = (await response.json()) as unknown

  let parsed: z.infer<typeof modelsResponseSchema>
  try {
    parsed = modelsResponseSchema.parse(json)
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
        : extractErrorMessage(error)
    throw new Error(`Malformed /v1/models response: ${message}`)
  }

  const entries = parsed.data

  // OpenAI presence check.
  if (providers.includes('openai')) {
    const hasOpenAi = entries.some(e => entryMatchesProvider(e, 'openai'))
    if (!hasOpenAi) {
      throw new Error('No OpenAI models on proxy — is the Codex token loaded? Try `cliproxy login codex`.')
    }
  }

  // Model presence check: strip provider prefix to get bare id
  const slashIndex = model.indexOf('/')
  const bareId = slashIndex === -1 ? model : model.slice(slashIndex + 1)
  const providerPrefix = slashIndex === -1 ? undefined : model.slice(0, slashIndex)

  const modelPresent = entries.some(e => e.id === bareId || e.id === model)
  if (!modelPresent) {
    // List available ids for the matching provider only
    const matchingIds = providerPrefix
      ? entries.filter(e => entryMatchesProvider(e, providerPrefix)).map(e => e.id)
      : entries.map(e => e.id)
    const available = matchingIds.length > 0 ? matchingIds.join(', ') : '(none)'
    throw new Error(`Model "${bareId}" not found on proxy. Available ${providerPrefix ?? 'models'}: ${available}`)
  }
}

export async function assertProxyReachable(baseUrl: string): Promise<void> {
  try {
    const response = await fetch(`${baseUrl}/healthz`, {
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
