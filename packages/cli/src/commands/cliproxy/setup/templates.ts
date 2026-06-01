/// <reference types="bun" />

import type {GenericSecretNames} from './prompts'
import type {ProviderId} from './providers'
import {z} from 'zod'
import {PROVIDER_DEFAULTS} from './providers'

export const harnessSchema = z.enum(['opencode', 'claude-code', 'generic'])
export type Harness = z.infer<typeof harnessSchema>

export interface SecretAssignment {
  name: string
  value: string
}

export interface VariableAssignment {
  name: string
  value: string
}

export interface HarnessTemplate {
  secrets: SecretAssignment[]
  variables: VariableAssignment[]
}

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

export function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

export function getHarnessTemplate(
  harness: Harness,
  values: {
    keyValue?: string
    baseUrl?: string
    genericSecretNames?: GenericSecretNames
    providers?: ProviderId[]
    model?: string
  } = {},
): HarnessTemplate {
  const keyValue = values.keyValue ?? 'sk-placeholder'
  const baseUrl = stripTrailingSlash(values.baseUrl ?? DEFAULT_CLIPROXY_URL)

  if (harness === 'opencode') {
    // Normalize provider list: default to anthropic-only, always sort anthropic first
    const rawProviders = values.providers ?? ['anthropic']
    // Stable ordering: anthropic always before openai regardless of input order
    const PROVIDER_ORDER: ProviderId[] = ['anthropic', 'openai']
    const providers = PROVIDER_ORDER.filter(p => rawProviders.includes(p))

    // Resolve model
    let model: string
    if (values.model) {
      model = values.model
    } else if (providers.length === 1) {
      model = PROVIDER_DEFAULTS[providers[0] as ProviderId]
    } else {
      throw new Error('model required when multiple providers selected')
    }

    // Build auth JSON object (anthropic-first insertion order)
    const authObj: Record<string, {type: string; key: string}> = {}
    for (const p of providers) {
      authObj[p] = {type: 'api', key: keyValue}
    }

    // Build config JSON object (anthropic-first insertion order)
    const providerConfig: Record<string, {options: {baseURL: string}}> = {}
    for (const p of providers) {
      providerConfig[p] = {options: {baseURL: `${baseUrl}/v1`}}
    }

    return {
      secrets: [
        {
          name: 'OPENCODE_AUTH_JSON',
          value: JSON.stringify(authObj),
        },
        {
          name: 'OPENCODE_CONFIG',
          value: JSON.stringify({provider: providerConfig}),
        },
      ],
      variables: [
        {
          name: 'FRO_BOT_MODEL',
          value: model,
        },
      ],
    }
  }

  if (harness === 'claude-code') {
    return {
      secrets: [
        {
          name: 'ANTHROPIC_API_KEY',
          value: keyValue,
        },
      ],
      variables: [],
    }
  }

  if (!values.genericSecretNames) {
    throw new Error('Generic harness requires custom secret names.')
  }

  return {
    secrets: [
      {name: values.genericSecretNames.apiKeySecretName, value: keyValue},
      {name: values.genericSecretNames.baseUrlSecretName, value: `${baseUrl}/v1`},
    ],
    variables: [],
  }
}

export function formatTemplateSummary(template: HarnessTemplate): string {
  const secretLines = template.secrets.map(secret => `- secret ${secret.name}`)
  const variableLines = template.variables.map(variable => `- variable ${variable.name}`)
  return [...secretLines, ...variableLines].join('\n')
}

export function collectCollisions(
  template: HarnessTemplate,
  existingSecrets: string[],
  existingVariables: string[],
): string[] {
  const collisions: string[] = []

  for (const secret of template.secrets) {
    if (existingSecrets.includes(secret.name)) {
      collisions.push(`secret ${secret.name}`)
    }
  }

  for (const variable of template.variables) {
    if (existingVariables.includes(variable.name)) {
      collisions.push(`variable ${variable.name}`)
    }
  }

  return collisions
}
