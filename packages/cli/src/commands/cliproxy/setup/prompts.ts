/// <reference types="bun" />

import * as clack from '@clack/prompts'

export interface GenericSecretNames {
  apiKeySecretName: string
  baseUrlSecretName: string
}

export function ensureRepoFormat(value: string): string {
  const trimmed = value.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error('Repository must be in owner/repo format.')
  }
  return trimmed
}

export function ensureSecretName(value: string, label: string): string {
  const trimmed = value.trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be SCREAMING_SNAKE_CASE.`)
  }
  return trimmed
}

export function cancelAndExit(message = 'Setup cancelled.'): never {
  clack.cancel(message)
  process.exit(0)
}

export async function promptValue<T extends string | boolean>(
  promise: Promise<T | symbol>,
  cancelMessage?: string,
): Promise<T> {
  const value = await promise
  if (clack.isCancel(value)) {
    cancelAndExit(cancelMessage)
  }
  return value
}

export function buildApiKeyValue(keyName: string): string {
  const slug = (
    keyName
      .trim()
      .toLowerCase()
      .match(/[a-z0-9]+/g) ?? []
  )
    .join('-')
    .slice(0, 24)
  const random = crypto.randomUUID().split('-').join('')
  return `sk-${slug || 'cliproxy'}-${random}`
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export async function promptGenericSecretNames(): Promise<GenericSecretNames> {
  const apiKeySecretName = ensureSecretName(
    await promptValue(
      clack.text({
        message: 'Name for the API key secret',
        placeholder: 'CLIPROXY_API_KEY',
        validate: value => {
          try {
            ensureSecretName(value ?? '', 'API key secret name')
            return undefined
          } catch (error) {
            return extractErrorMessage(error)
          }
        },
      }),
      'Setup cancelled before choosing the generic API key secret name.',
    ),
    'API key secret name',
  )

  const baseUrlSecretName = ensureSecretName(
    await promptValue(
      clack.text({
        message: 'Name for the proxy base URL secret',
        placeholder: 'CLIPROXY_BASE_URL',
        validate: value => {
          try {
            ensureSecretName(value ?? '', 'Base URL secret name')
            return undefined
          } catch (error) {
            return extractErrorMessage(error)
          }
        },
      }),
      'Setup cancelled before choosing the generic base URL secret name.',
    ),
    'Base URL secret name',
  )

  return {apiKeySecretName, baseUrlSecretName}
}
