/// <reference types="bun" />

import {cancel, isCancel, multiselect, select, text} from '@clack/prompts'
import {z} from 'zod'

const providerIdSchema = z.enum(['anthropic', 'openai'])
export type ProviderId = z.infer<typeof providerIdSchema>

const MODEL_ID_RE = /^(?:anthropic|openai)\/[a-z\d](?:[a-z\d.\-]*[a-z\d])?$/

/**
 * Parse a comma-separated provider list string into a validated ProviderId array.
 * Rejects empty input, unknown providers, and duplicates.
 */
export function parseProviders(input: string): ProviderId[] {
  const parts = input
    .split(',')
    .map(p => p.trim())
    .filter(Boolean)

  if (parts.length === 0) {
    throw new Error('--providers must not be empty. Supported values: anthropic, openai')
  }

  const parsed = parts.map(p => {
    const result = providerIdSchema.safeParse(p)
    if (!result.success) {
      throw new Error(`Unknown provider "${p}". Supported values: anthropic, openai`)
    }
    return result.data
  })

  const deduped = new Set(parsed)
  if (deduped.size < parsed.length) {
    throw new Error(`--providers contains duplicate values: ${parsed.join(',')}`)
  }

  return parsed
}

export const PROVIDER_DEFAULTS: Record<ProviderId, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-5.4-mini',
}

const CUSTOM_MODEL_SENTINEL = '__custom__'

function cancelAndExit(message = 'Setup cancelled.'): never {
  cancel(message)
  process.exit(0)
}

/**
 * Interactively prompt the user to select one or more providers.
 * Anthropic is pre-checked. Empty selection re-prompts.
 */
export async function promptForProviders(): Promise<ProviderId[]> {
  let providers: ProviderId[] = []

  do {
    const result = await multiselect<ProviderId>({
      message: 'Select providers to configure',
      options: [
        {value: 'anthropic', label: 'Anthropic'},
        {value: 'openai', label: 'OpenAI'},
      ],
      initialValues: ['anthropic'],
      required: false,
    })

    if (isCancel(result)) {
      cancelAndExit('Setup cancelled before selecting providers.')
    }

    providers = result as ProviderId[]
  } while (providers.length === 0)

  return providers
}

/**
 * Interactively prompt the user to select a default model.
 * When only one provider is selected, returns that provider's default immediately.
 * When multiple providers are selected, shows a select with preset options and a custom entry.
 */
export async function promptForModel(providers: ProviderId[]): Promise<string> {
  if (providers.length === 1) {
    return PROVIDER_DEFAULTS[providers[0] as ProviderId]
  }

  const chosen = await select<string>({
    message: 'Choose a default model',
    options: [
      {value: 'openai/gpt-5.4-mini', label: 'openai/gpt-5.4-mini'},
      {value: 'anthropic/claude-sonnet-4-6', label: 'anthropic/claude-sonnet-4-6'},
      {value: CUSTOM_MODEL_SENTINEL, label: 'Enter custom model ID...'},
    ],
  })

  if (isCancel(chosen)) {
    cancelAndExit('Setup cancelled before selecting a model.')
  }

  if (chosen === CUSTOM_MODEL_SENTINEL) {
    return promptForCustomModel()
  }

  return chosen as string
}

async function promptForCustomModel(): Promise<string> {
  let modelId: string | undefined

  do {
    const result = await text({
      message: 'Enter a custom model ID (e.g. openai/gpt-5.4-mini)',
      placeholder: 'provider/model-name',
      validate: value => {
        if (!MODEL_ID_RE.test(value ?? '')) {
          return 'Model ID must match provider/model-name (lowercase, digits, dots, hyphens only)'
        }
        return undefined
      },
    })

    if (isCancel(result)) {
      cancelAndExit('Setup cancelled before entering a custom model ID.')
    }

    const candidate = result as string
    if (MODEL_ID_RE.test(candidate)) {
      modelId = candidate
    }
    // If the mock bypasses clack's internal validate and returns a bad value,
    // loop again to re-prompt.
  } while (!modelId)

  return modelId
}
