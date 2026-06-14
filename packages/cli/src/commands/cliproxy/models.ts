import type {ActionCtx} from '../../lib/action-ctx'

import {z} from 'zod'

import {requestJson} from './shared'

declare const process: {
  env: Record<string, string | undefined>
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

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

type ModelEntry = z.infer<typeof modelEntrySchema>

// Known bare-id patterns per provider, used only when owned_by is absent
// (e.g. CLIProxyAPI v7 omits owned_by from /v1/models entries).
const PROVIDER_ID_PATTERNS: Record<string, RegExp> = {
  openai: /^(?:gpt-|o1-|o3-|codex)/i,
  anthropic: /^claude-/i,
}

const VALID_PROVIDERS = ['anthropic', 'openai'] as const
type ValidProvider = (typeof VALID_PROVIDERS)[number]

function isValidProvider(value: string): value is ValidProvider {
  return (VALID_PROVIDERS as readonly string[]).includes(value)
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

export interface ModelsOptions {
  url?: string
  key?: string
  verbose?: boolean
  provider?: string
}

export async function cliproxyModelsAction(options: ModelsOptions, ctx: ActionCtx): Promise<void> {
  try {
    const baseUrl = stripTrailingSlash(options.url ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)

    // Trusted URL: the canonical configured/default host, trailing-slash-normalized.
    // Ambient env keys must ONLY follow to this trusted destination to prevent
    // secret exfiltration when an agent passes an attacker-controlled --url.
    const trustedUrl = stripTrailingSlash(process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
    const urlIsExplicitlyOverridden = options.url !== undefined && baseUrl !== trustedUrl

    // An explicit --key is always honored (operator knows what they're doing).
    // An ambient env key is only forwarded when the resolved baseUrl is trusted.
    const key = options.key ?? (urlIsExplicitlyOverridden ? undefined : process.env.CLIPROXY_API_KEY)

    if (!key) {
      throw new Error('No API key. Provide --key or set CLIPROXY_API_KEY.')
    }

    // Validate provider before any HTTP call
    if (options.provider !== undefined && !isValidProvider(options.provider)) {
      throw new Error(`Unknown provider "${options.provider}". Use anthropic or openai.`)
    }

    const endpoint = `${baseUrl}/v1/models`
    const raw = await requestJson(endpoint, {
      headers: {Authorization: `Bearer ${key}`},
    })

    const parseResult = modelsResponseSchema.safeParse(raw)
    if (!parseResult.success) {
      const message = parseResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; ')
      throw new Error(`Malformed /v1/models response: ${message}`)
    }

    let entries = parseResult.data.data

    if (options.provider !== undefined) {
      entries = entries.filter(e => entryMatchesProvider(e, options.provider as string))
    }

    if (entries.length === 0) {
      ctx.console.log(
        options.provider === undefined ? 'No models.' : `No models found for provider ${options.provider}.`,
      )
      return
    }

    if (options.verbose) {
      // Aligned columns: id, owned_by (or '-' if absent), created as ISO date
      const idWidth = Math.max(...entries.map(e => e.id.length), 2)
      const ownerWidth = Math.max(...entries.map(e => (e.owned_by ?? '-').length), 8)

      for (const entry of entries) {
        const id = entry.id.padEnd(idWidth)
        const owner = (entry.owned_by ?? '-').padEnd(ownerWidth)
        const date = typeof entry.created === 'number' ? new Date(entry.created * 1000).toISOString().slice(0, 10) : '-'
        ctx.console.log(`${id}  ${owner}  ${date}`)
      }
    } else {
      for (const entry of entries) {
        ctx.console.log(entry.id)
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
  }
}
