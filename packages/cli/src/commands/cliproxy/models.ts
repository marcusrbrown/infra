import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import {requestJson} from '@marcusrbrown/infra-shared/cliproxy/management'
import {z} from 'zod'

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
    created: z.number().optional(),
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
 * Derives the provider string for a model entry.
 * Prefers owned_by when present and non-empty; falls back to PROVIDER_ID_PATTERNS
 * matching against the bare id; falls back to 'unknown'.
 * Display/validation-only — never an auth or trust signal.
 */
function deriveProvider(entry: ModelEntry): string {
  if (entry.owned_by !== undefined && entry.owned_by.trim() !== '') {
    return entry.owned_by
  }
  // Strip any existing provider/ prefix before pattern matching
  const bareId = stripProviderPrefix(entry.id)
  for (const [provider, pattern] of Object.entries(PROVIDER_ID_PATTERNS)) {
    if (pattern.test(bareId)) return provider
  }
  return 'unknown'
}

/**
 * Strips an existing `provider/` prefix from a raw id, if present.
 * Defensive: handles entries that already have a prefix so we don't double-prefix.
 */
function stripProviderPrefix(id: string): string {
  const slashIdx = id.indexOf('/')
  if (slashIdx === -1) return id
  // Only strip if the prefix looks like a known provider or 'unknown'
  const prefix = id.slice(0, slashIdx)
  if (prefix === 'unknown' || isValidProvider(prefix)) {
    return id.slice(slashIdx + 1)
  }
  return id
}

/**
 * Decides whether a /v1/models entry belongs to a provider.
 * Prefers owned_by when present; falls back to id prefix / known bare-id
 * patterns when absent. Display/validation-only — never an auth or trust signal.
 */
function entryMatchesProvider(entry: ModelEntry, provider: string): boolean {
  return deriveProvider(entry) === provider
}

/**
 * Sort entries: grouped by provider (ascending), within each group by created asc.
 * Entries with missing/non-number created sort last within their group.
 */
function sortEntries(entries: ModelEntry[]): ModelEntry[] {
  // Annotate with derived provider for stable grouping
  const annotated = entries.map(e => ({entry: e, provider: deriveProvider(e)}))

  // Sort: provider asc, then created asc (missing created → Infinity → sorts last)
  annotated.sort((a, b) => {
    const providerCmp = a.provider.localeCompare(b.provider)
    if (providerCmp !== 0) return providerCmp
    const aCreated = typeof a.entry.created === 'number' ? a.entry.created : Infinity
    const bCreated = typeof b.entry.created === 'number' ? b.entry.created : Infinity
    return aCreated - bCreated
  })

  return annotated.map(a => a.entry)
}

/**
 * Formats a model entry for plain output: `provider/raw_id`.
 */
function formatPlainLine(entry: ModelEntry): string {
  const provider = deriveProvider(entry)
  const rawId = stripProviderPrefix(entry.id)
  return `${provider}/${rawId}`
}

interface VerboseEntry {
  id: string
  provider: string
  raw_id: string
  created: string | null
}

/**
 * Formats a model entry for verbose JSON output.
 */
function formatVerboseEntry(entry: ModelEntry): VerboseEntry {
  const provider = deriveProvider(entry)
  const rawId = stripProviderPrefix(entry.id)
  return {
    id: `${provider}/${rawId}`,
    provider,
    raw_id: rawId,
    created: typeof entry.created === 'number' ? new Date(entry.created * 1000).toISOString() : null,
  }
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

    // Sort: provider-grouped (asc), date-asc within each group
    entries = sortEntries(entries)

    if (options.verbose) {
      // --verbose: emit a single JSON array (pretty-printed) of the fields we have.
      // Always valid JSON — empty/zero-match → [].
      const verboseEntries = entries.map(formatVerboseEntry)
      ctx.console.log(JSON.stringify(verboseEntries, null, 2))
      return
    }

    if (entries.length === 0) {
      ctx.console.log(
        options.provider === undefined ? 'No models.' : `No models found for provider ${options.provider}.`,
      )
      return
    }

    for (const entry of entries) {
      ctx.console.log(formatPlainLine(entry))
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    ctx.console.error(message)
    ctx.process.exit(1)
  }
}

export function registerCliproxyModels(cli: ReturnType<typeof goke>): void {
  cli
    .command('cliproxy models [provider]', 'List the models CLIProxyAPI serves.')
    .option(
      '--url [url]',
      z.string().describe('Base URL for CLIProxyAPI. Falls back to CLIPROXY_URL or https://cliproxy.fro.bot.'),
    )
    .option('--key [key]', z.string().describe('API key (bearer). Falls back to CLIPROXY_API_KEY when omitted.'))
    .option('--verbose', 'Show owned_by and created date for each model.')
    .example('# List all models served by CLIProxyAPI')
    .example('infra cliproxy models')
    .example('# Filter to Anthropic models only')
    .example('infra cliproxy models anthropic')
    .example('# Show verbose output with owned_by and created date')
    .example('infra cliproxy models --verbose')
    .example('# Filter to OpenAI models with verbose output')
    .example('infra cliproxy models openai --verbose')
    .action((provider, options, ctx) =>
      cliproxyModelsAction({...options, provider: provider as string | undefined}, ctx),
    )
}
