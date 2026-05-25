/// <reference types="bun" />

import type {SpinnerResult} from '@clack/prompts'
import type {goke} from 'goke'

import {cancel, confirm, intro, isCancel, log, multiselect, note, outro, select, spinner, text} from '@clack/prompts'
import {z} from 'zod'

import {resolveManagementKey} from './config'
import {toStringArray} from './keys'

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'
const HTTP_TIMEOUT_MS = 10_000

const harnessSchema = z.enum(['opencode', 'claude-code', 'generic'])
const ghRepoViewSchema = z.object({
  nameWithOwner: z.string(),
  viewerPermission: z.string(),
})
const ghNameListSchema = z.array(z.object({name: z.string()}))

export type Harness = z.infer<typeof harnessSchema>

const providerIdSchema = z.enum(['anthropic', 'openai'])
export type ProviderId = z.infer<typeof providerIdSchema>

const MODEL_ID_RE = /^(?:anthropic|openai)\/[a-z\d][a-z\d.\-]*$/

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

const PROVIDER_DEFAULTS: Record<ProviderId, string> = {
  anthropic: 'anthropic/claude-sonnet-4-6',
  openai: 'openai/gpt-5.4-mini',
}

const CUSTOM_MODEL_SENTINEL = '__custom__'

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

export interface SetupOptions {
  key?: string
  repo?: string
  harness?: Harness
  /** Raw comma-separated provider list string (e.g. "anthropic,openai"). Use parseProviders() to validate. */
  providers?: string
  model?: string
  force?: boolean
  dryRun?: boolean
  verifySmoke?: boolean
}

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

interface GenericSecretNames {
  apiKeySecretName: string
  baseUrlSecretName: string
}

interface SetupPlan {
  repo: string
  harness: Harness
  keyValue: string
  keyName?: string
  createKey: boolean
  template: HarnessTemplate
}

interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
}

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value
}

function resolveBaseUrl(input?: string): string {
  return stripTrailingSlash(input ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
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

  if (!options.key) {
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

    // OMO_PROVIDERS token map
    const OMO_TOKEN: Record<ProviderId, string> = {
      anthropic: 'claude-max20',
      openai: 'openai',
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

    const omoProviders = providers.map(p => OMO_TOKEN[p]).join(',')

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
        {
          name: 'OMO_PROVIDERS',
          value: omoProviders,
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

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ensureRepoFormat(value: string): string {
  const trimmed = value.trim()
  if (!/^[^/\s]+\/[^/\s]+$/.test(trimmed)) {
    throw new Error('Repository must be in owner/repo format.')
  }
  return trimmed
}

function ensureSecretName(value: string, label: string): string {
  const trimmed = value.trim()
  if (!/^[A-Z][A-Z0-9_]*$/.test(trimmed)) {
    throw new Error(`${label} must be SCREAMING_SNAKE_CASE.`)
  }
  return trimmed
}

function cancelAndExit(message = 'Setup cancelled.'): never {
  cancel(message)
  process.exit(0)
}

async function promptValue<T extends string | boolean>(
  promise: Promise<T | symbol>,
  cancelMessage?: string,
): Promise<T> {
  const value = await promise
  if (isCancel(value)) {
    cancelAndExit(cancelMessage)
  }
  return value
}

async function withSpinner<T>(message: string, run: (spinnerInstance: SpinnerResult) => Promise<T>): Promise<T> {
  const spinnerInstance = spinner()
  spinnerInstance.start(message)

  try {
    const result = await run(spinnerInstance)
    spinnerInstance.stop(message)
    return result
  } catch (error) {
    spinnerInstance.error(`${message} failed`)
    throw error
  }
}

async function runCommand(command: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([command, ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return {stdout, stderr, exitCode}
}

async function runGh(args: string[]): Promise<CommandResult> {
  return runCommand('gh', args)
}

export function isGhRateLimitError(text: string): boolean {
  return /rate limit/i.test(text)
}

/**
 * Query the GitHub API rate limit reset time. The `rate_limit` endpoint is
 * exempt from rate limiting itself, so this should succeed even when the
 * primary GraphQL limit is exhausted. Returns a formatted local time string
 * or a fallback phrase when the endpoint is unreachable.
 */
async function queryRateLimitReset(): Promise<string> {
  try {
    const result = await runGh(['api', 'rate_limit'])
    if (result.exitCode === 0) {
      const parsed = JSON.parse(result.stdout) as {
        resources?: {graphql?: {reset?: number}; core?: {reset?: number}}
      }
      const reset = parsed.resources?.graphql?.reset ?? parsed.resources?.core?.reset
      if (reset) {
        return new Date(reset * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})
      }
    }
  } catch {
    // Fall through to generic phrase
  }
  return 'an unknown time'
}

/**
 * Run a GitHub API operation wrapped in a spinner, retrying indefinitely on
 * rate-limit errors when in interactive mode. In non-interactive mode the
 * error is re-thrown with the reset time appended so the caller can surface
 * it without prompting.
 */
export async function withGhRetry<T>(
  label: string,
  fn: (spinnerInstance: SpinnerResult) => Promise<T>,
  interactive: boolean,
  queryReset: () => Promise<string> = queryRateLimitReset,
): Promise<T> {
  for (;;) {
    try {
      return await withSpinner(label, fn)
    } catch (error) {
      const message = extractErrorMessage(error)
      if (!isGhRateLimitError(message)) {
        throw error
      }
      const reset = await queryReset()
      if (!interactive) {
        throw new Error(`${message} — GitHub API rate limit resets at ${reset}. Re-run when ready.`)
      }
      log.warn(`GitHub API rate limit exceeded. Resets at ${reset}.`)
      const retry = await promptValue(
        confirm({
          message: 'Retry this step when ready?',
          active: 'retry',
          inactive: 'abort',
          initialValue: true,
        }),
        'Setup aborted after rate limit.',
      )
      if (!retry) {
        cancelAndExit('Setup aborted after GitHub API rate limit.')
      }
    }
  }
}

async function assertGhInstalled(): Promise<void> {
  if (!Bun.which('gh')) {
    throw new Error('GitHub CLI is required for cliproxy setup. Install gh first: https://cli.github.com/')
  }
}

async function assertGhAuthenticated(): Promise<void> {
  const result = await runGh(['auth', 'status'])
  if (result.exitCode !== 0) {
    throw new Error(`GitHub CLI is not authenticated. Run "gh auth login" first. ${result.stderr.trim()}`.trim())
  }
}

async function assertRepoAccess(repo: string): Promise<void> {
  const result = await runGh(['repo', 'view', repo, '--json', 'nameWithOwner,viewerPermission'])
  if (result.exitCode !== 0) {
    throw new Error(`Unable to access ${repo}. ${result.stderr.trim()}`.trim())
  }

  const parsed = ghRepoViewSchema.parse(JSON.parse(result.stdout))
  const writePermissions = new Set(['ADMIN', 'MAINTAIN', 'WRITE'])

  if (!writePermissions.has(parsed.viewerPermission)) {
    throw new Error(
      `GitHub CLI does not have write access to ${parsed.nameWithOwner}. Current permission: ${parsed.viewerPermission}.`,
    )
  }
}

async function listExistingGhNames(repo: string, kind: 'secret' | 'variable'): Promise<string[]> {
  const result = await runGh([kind, 'list', '--repo', repo, '--json', 'name'])
  if (result.exitCode !== 0) {
    throw new Error(`Unable to list existing GitHub ${kind}s for ${repo}. ${result.stderr.trim()}`.trim())
  }

  return ghNameListSchema.parse(JSON.parse(result.stdout)).map(entry => entry.name)
}

export type FroBotWorkflowCheck =
  | {kind: 'missing'}
  | {kind: 'unreachable'; reason: string}
  | {kind: 'no-agent-step'}
  | {
      kind: 'analyzed'
      stepsWithGaps: readonly {stepOrdinal: number; missingInputs: readonly string[]}[]
    }

// github-token and prompt are intentionally excluded from this check:
// github-token is harness-agnostic (PAT wiring, not secret-routing) and prompt is
// workflow-defined (the user's prompt body, not a harness default).
//
// NOTE: `enable-omo: true` is NOT a required input.
// For proxy-routed providers configured via OPENCODE_CONFIG.provider.<name>.options.baseURL,
// the fro-bot/agent action honors auth.json directly (regardless of oMo state).
// Source: fro-bot/agent@v0.44.3+ action.yaml lines 99-104; verified by librarian 2026-05-25.
const REQUIRED_OPENCODE_INPUTS = ['auth-json', 'opencode-config', 'omo-providers', 'model'] as const

/**
 * Slice the workflow content into one entry per `fro-bot/agent` step. Handles
 * both the `- name:\n  uses: ...` and `- uses: ...` step shapes. Returns an
 * empty array if no fro-bot/agent step is present.
 *
 * Step-scoped slicing prevents false-passes where a same-named input key in a
 * sibling step (strategy.matrix, custom actions, reusable workflow with:
 * blocks) could mask a genuine gap in fro-bot/agent's wiring.
 */
function findFroBotAgentStepBodies(content: string): {stepOrdinal: number; body: string}[] {
  const bodies: {stepOrdinal: number; body: string}[] = []
  const pattern = /^(\s*(?:-\s+)?)uses:\s*fro-bot\/agent@/gm

  for (const match of content.matchAll(pattern)) {
    if (match.index === undefined || match[1] === undefined) continue

    const stepBodyIndent = match[1].length
    const dashIndent = Math.max(0, stepBodyIndent - 2)
    const lines = content.slice(match.index).split('\n')
    const stepLines: string[] = [lines[0] ?? '']

    for (let index = 1; index < lines.length; index += 1) {
      const line = lines[index] ?? ''
      if (!line.trim()) {
        stepLines.push(line)
        continue
      }
      const firstNonSpace = line.search(/\S/)
      if (firstNonSpace === dashIndent && line.trimStart().startsWith('-')) break
      if (firstNonSpace < dashIndent) break
      stepLines.push(line)
    }

    bodies.push({stepOrdinal: bodies.length + 1, body: stepLines.join('\n')})
  }

  return bodies
}

export function analyzeFroBotWorkflow(workflowContent: string): FroBotWorkflowCheck {
  const steps = findFroBotAgentStepBodies(workflowContent)

  if (steps.length === 0) {
    return {kind: 'no-agent-step'}
  }

  const stepsWithGaps = steps
    .map(step => ({
      stepOrdinal: step.stepOrdinal,
      missingInputs: REQUIRED_OPENCODE_INPUTS.filter(input => {
        const inputPattern = new RegExp(String.raw`^\s+${input}:`, 'm')
        return !inputPattern.test(step.body)
      }),
    }))
    .filter(step => step.missingInputs.length > 0)

  return {kind: 'analyzed', stepsWithGaps}
}

/**
 * Extracted pure helper: turn a `gh api /repos/.../contents/<file>` result into
 * a FroBotWorkflowCheck. Separated from checkFroBotWorkflow so tests can exercise
 * the 404-vs-transport-error logic without mocking Bun.spawn.
 */
export function interpretGhContentResult(result: CommandResult): FroBotWorkflowCheck {
  if (result.exitCode === 0) {
    return analyzeFroBotWorkflow(result.stdout)
  }

  // gh prints `gh: Not Found (HTTP 404)` on 404; anything else is auth/network/5xx.
  if (/HTTP 404/.test(result.stderr)) {
    return {kind: 'missing'}
  }

  return {
    kind: 'unreachable',
    reason: result.stderr.trim() || `gh api exited with code ${result.exitCode}`,
  }
}

async function checkFroBotWorkflow(repo: string): Promise<FroBotWorkflowCheck> {
  const result = await runGh([
    'api',
    '--header',
    'Accept: application/vnd.github.raw',
    `/repos/${repo}/contents/.github/workflows/fro-bot.yaml`,
  ])

  return interpretGhContentResult(result)
}

// Snippet uses 10-space indent to match the canonical `with:` block depth
// in marcusrbrown/infra/.github/workflows/fro-bot.yaml, so users can paste
// directly under their step's `with:` key without re-indenting.
export function formatWorkflowSnippet(missingInputs: readonly string[]): string {
  /* eslint-disable no-template-curly-in-string -- GitHub Actions expression syntax, not JS template literals */
  const inputMap: Record<string, string> = {
    'auth-json': 'auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}',
    'opencode-config': 'opencode-config: ${{ secrets.OPENCODE_CONFIG }}',
    'omo-providers': 'omo-providers: ${{ secrets.OMO_PROVIDERS }}',
    model: 'model: ${{ vars.FRO_BOT_MODEL }}',
  }
  /* eslint-enable no-template-curly-in-string */
  return missingInputs.map(input => `          ${inputMap[input]}`).join('\n')
}

/**
 * Pre-mutation validator: probes /v1/models to assert the resolved model is
 * available and (when providers includes openai) that at least one OpenAI model
 * is present on the proxy.
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

async function assertProxyReachable(baseUrl: string): Promise<void> {
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

async function assertProxyKeyWorks(baseUrl: string, keyValue: string): Promise<void> {
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

async function requestJson(endpoint: string, init: RequestInit): Promise<unknown> {
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

function managementHeaders(key: string): Headers {
  const headers = new Headers()
  headers.set('x-management-key', key)
  headers.set('content-type', 'application/json')
  return headers
}

function buildApiKeyValue(keyName: string): string {
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

async function createManagementApiKey(baseUrl: string, managementKey: string, keyValue: string): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const currentPayload = await requestJson(endpoint, {
    method: 'GET',
    headers: managementHeaders(managementKey),
  })
  const currentKeys = toStringArray(currentPayload)

  if (currentKeys.includes(keyValue)) {
    return
  }

  await requestJson(endpoint, {
    method: 'PUT',
    headers: managementHeaders(managementKey),
    body: JSON.stringify([...currentKeys, keyValue]),
  })
}

async function deleteManagementApiKey(baseUrl: string, managementKey: string, keyValue: string): Promise<void> {
  const endpoint = `${baseUrl}/v0/management/api-keys`
  const currentPayload = await requestJson(endpoint, {
    method: 'GET',
    headers: managementHeaders(managementKey),
  })
  const currentKeys = toStringArray(currentPayload)
  const filtered = currentKeys.filter(k => k !== keyValue)

  if (filtered.length === currentKeys.length) {
    return
  }

  await requestJson(endpoint, {
    method: 'PUT',
    headers: managementHeaders(managementKey),
    body: JSON.stringify(filtered),
  })
}

async function applyGhValue(kind: 'secret' | 'variable', name: string, repo: string, value: string): Promise<void> {
  if (kind === 'secret') {
    const child = Bun.spawn(['gh', 'secret', 'set', name, '--repo', repo], {
      stdin: new Blob([value]).stream(),
      stdout: 'pipe',
      stderr: 'pipe',
      env: process.env,
    })

    const [stderr, exitCode] = await Promise.all([new Response(child.stderr).text(), child.exited])

    if (exitCode !== 0) {
      throw new Error(`gh secret set ${name} failed: ${stderr.trim()}`.trim())
    }
    return
  }

  const result = await runGh([kind, 'set', name, '--repo', repo, '--body', value])
  if (result.exitCode !== 0) {
    throw new Error(`gh ${kind} set ${name} failed: ${result.stderr.trim()}`.trim())
  }
}

function formatTemplateSummary(template: HarnessTemplate): string {
  const secretLines = template.secrets.map(secret => `- secret ${secret.name}`)
  const variableLines = template.variables.map(variable => `- variable ${variable.name}`)
  return [...secretLines, ...variableLines].join('\n')
}

function collectCollisions(
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

async function promptGenericSecretNames(): Promise<GenericSecretNames> {
  const apiKeySecretName = ensureSecretName(
    await promptValue(
      text({
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
      text({
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

async function buildInteractivePlan(options: SetupOptions, baseUrl: string): Promise<SetupPlan> {
  const createKey = !options.key
  const keyName = createKey
    ? await promptValue(
        text({
          message: 'Name this new CLIProxyAPI key',
          placeholder: 'my-repo-ci',
          validate: value => ((value ?? '').trim().length > 0 ? undefined : 'Key name is required.'),
        }),
        'Setup cancelled before naming the key.',
      )
    : undefined

  const harness =
    options.harness ??
    (await promptValue(
      select<Harness>({
        message: 'Choose the harness to configure',
        options: [
          {value: 'opencode', label: 'OpenCode'},
          {value: 'claude-code', label: 'Claude Code'},
          {value: 'generic', label: 'Generic'},
        ],
      }),
      'Setup cancelled before selecting a harness.',
    ))

  const repo = options.repo
    ? ensureRepoFormat(options.repo)
    : ensureRepoFormat(
        await promptValue(
          text({
            message: 'Target GitHub repository',
            placeholder: 'owner/repo',
            validate: value => {
              try {
                ensureRepoFormat(value ?? '')
                return undefined
              } catch (error) {
                return extractErrorMessage(error)
              }
            },
          }),
          'Setup cancelled before choosing a repository.',
        ),
      )

  let providers: ProviderId[] | undefined
  let model: string | undefined

  if (harness === 'opencode') {
    providers = await promptForProviders()
    model = await promptForModel(providers)
  }

  const keyValue = options.key ?? buildApiKeyValue(keyName ?? 'cliproxy')
  const genericSecretNames = harness === 'generic' ? await promptGenericSecretNames() : undefined

  return {
    repo,
    harness,
    keyValue,
    keyName,
    createKey,
    template: getHarnessTemplate(harness, {keyValue, baseUrl, genericSecretNames, providers, model}),
  }
}

/**
 * Returns true when the provider list includes anything beyond anthropic-only.
 * Anthropic-only repos see no behavior change (G7 invariant).
 */
export function mustConfirmDestructive(providers: ProviderId[]): boolean {
  return !(providers.length === 1 && providers[0] === 'anthropic')
}

export interface DryRunPreviewOptions {
  repo: string
  harness: Harness
  providers: ProviderId[]
  model: string
  template: HarnessTemplate
}

/**
 * Format a dry-run preview string. The proxy key value is NEVER included —
 * it is rendered as `<proxy-key>` in all positions.
 */
export function formatDryRunPreview(opts: DryRunPreviewOptions): string {
  const {repo, harness, providers, model, template} = opts

  const lines: string[] = [
    `Dry run: cliproxy setup --harness ${harness}`,
    `Repository: ${repo}`,
    `Providers: ${providers.join(', ')}`,
    `Model: ${model}`,
    'Planned secrets:',
  ]

  for (const secret of template.secrets) {
    const size = new TextEncoder().encode(secret.value).byteLength
    lines.push(`  - ${secret.name} (${size} bytes)`)
  }

  lines.push('Planned variables:')
  for (const variable of template.variables) {
    lines.push(`  - ${variable.name} = ${variable.value}`)
  }

  lines.push('Proxy key (redacted): <proxy-key>')
  lines.push('No mutations will be performed.')

  return lines.join('\n')
}

export async function buildNonInteractivePlan(options: SetupOptions, baseUrl: string): Promise<SetupPlan> {
  const harness = harnessSchema.parse(options.harness)
  const repo = ensureRepoFormat(options.repo ?? '')
  const keyValue = options.key ?? ''

  const providers: ProviderId[] = options.providers ? parseProviders(options.providers) : ['anthropic']

  let model: string
  if (options.model) {
    model = options.model
  } else if (providers.length === 1) {
    model = PROVIDER_DEFAULTS[providers[0] as ProviderId]
  } else {
    // Unreachable: validateSetupOptions enforces model when providers.length > 1
    throw new Error('Pass --model <provider/model-id> when selecting multiple providers.')
  }

  // --dry-run: skip verifyModelsAvailable and force check; return plan for preview
  if (options.dryRun) {
    return {
      repo,
      harness,
      keyValue,
      createKey: false,
      template: getHarnessTemplate(harness, {keyValue: keyValue || 'sk-placeholder', baseUrl, providers, model}),
    }
  }

  if (providers.includes('openai')) {
    await verifyModelsAvailable(baseUrl, keyValue, providers, model)
  }

  // Destructive overwrite gate: non-anthropic-only requires --force in non-interactive mode
  if (mustConfirmDestructive(providers) && !options.force) {
    throw new Error(
      'Pass `--force` to confirm overwriting existing OPENCODE_AUTH_JSON/OPENCODE_CONFIG/OMO_PROVIDERS/FRO_BOT_MODEL. Run with `--dry-run` first to preview.',
    )
  }

  return {
    repo,
    harness,
    keyValue,
    createKey: false,
    template: getHarnessTemplate(harness, {keyValue, baseUrl, providers, model}),
  }
}

// ─── Smoke test runner ────────────────────────────────────────────────────────

export type SmokeResult =
  | {kind: 'pass'; message: string; runUrl: string}
  | {kind: 'fail'; message: string; runUrl: string}
  | {kind: 'unverified'; message: string; runUrl?: string}

interface GhRunEntry {
  databaseId: number
  status: string
  conclusion: string | null
  url: string
  createdAt: string
}

/** Options for testability: override poll delays and trigger time. */
interface SmokeTestInternals {
  /** Override per-poll delay in ms (default: real backoff schedule). */
  _testDelayMs?: number
  /** Override the trigger timestamp used for createdAt heuristic. */
  _testTriggerTime?: Date
}

/**
 * Run an optional post-mutation smoke test by triggering `fro-bot.yaml` and
 * polling for completion. Returns a non-blocking SmokeResult — never throws.
 *
 * Race-safe: captures the highest existing run ID before triggering, then
 * filters poll results to runs with databaseId > baselineId. When no prior
 * runs exist (baselineId=null), falls back to createdAt > triggerTime.
 *
 * Known edge case: if a concurrent contributor's run appears before ours,
 * we pick the highest databaseId above baseline — this may misattribute
 * the concurrent run as ours. This is the best heuristic available without
 * a run-specific correlation ID from `gh workflow run`.
 */
export async function runSmokeTest(
  repo: string,
  _model: string,
  internals: SmokeTestInternals = {},
): Promise<SmokeResult> {
  const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 60_000]
  const delayFn = async (ms: number): Promise<void> => {
    if (internals._testDelayMs !== undefined) {
      if (internals._testDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, internals._testDelayMs))
      }
      return
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  const repoUrl = `https://github.com/${repo}`

  // ── Step 1: Capture baseline run ID ──────────────────────────────────────
  let baselineId: number | null = null
  try {
    const baselineChild = Bun.spawn(
      ['gh', 'run', 'list', '--workflow=fro-bot.yaml', '--repo', repo, '--limit', '1', '--json', 'databaseId'],
      {stdout: 'pipe', stderr: 'pipe', env: process.env},
    )
    const [baselineStdout, , baselineExit] = await Promise.all([
      new Response(baselineChild.stdout).text(),
      new Response(baselineChild.stderr).text(),
      baselineChild.exited,
    ])
    if (baselineExit === 0) {
      const parsed = JSON.parse(baselineStdout) as {databaseId: number}[]
      if (parsed.length > 0 && parsed[0]) {
        baselineId = parsed[0].databaseId
      }
    }
    // If baseline call fails, baselineId stays null — we'll use createdAt heuristic
  } catch {
    // Network/parse error — continue with null baseline
  }

  // ── Step 2: Trigger the workflow ──────────────────────────────────────────
  const triggerTime = internals._testTriggerTime ?? new Date()

  const triggerChild = Bun.spawn(
    ['gh', 'workflow', 'run', 'fro-bot.yaml', '--repo', repo, '-f', 'prompt=reply with exactly: ack'],
    {stdout: 'pipe', stderr: 'pipe', env: process.env},
  )
  const [, triggerStderr, triggerExit] = await Promise.all([
    new Response(triggerChild.stdout).text(),
    new Response(triggerChild.stderr).text(),
    triggerChild.exited,
  ])

  if (triggerExit !== 0) {
    const redacted = triggerStderr.slice(0, 200)
    return {kind: 'unverified', message: `gh workflow run failed: ${redacted}`}
  }

  // ── Step 3: Poll for the new run ──────────────────────────────────────────
  let latestMatchedRun: GhRunEntry | undefined

  for (const BACKOFF_M of BACKOFF_MS) {
    await delayFn(BACKOFF_M ?? 60_000)

    let pollRuns: GhRunEntry[] = []
    try {
      const pollChild = Bun.spawn(
        [
          'gh',
          'run',
          'list',
          '--workflow=fro-bot.yaml',
          '--repo',
          repo,
          '--limit',
          '5',
          '--json',
          'databaseId,status,conclusion,url,createdAt',
        ],
        {stdout: 'pipe', stderr: 'pipe', env: process.env},
      )
      const [pollStdout, , pollExit] = await Promise.all([
        new Response(pollChild.stdout).text(),
        new Response(pollChild.stderr).text(),
        pollChild.exited,
      ])
      if (pollExit === 0) {
        pollRuns = JSON.parse(pollStdout) as GhRunEntry[]
      }
    } catch {
      // Parse/network error — retry on next poll
      continue
    }

    // Filter to runs triggered after our baseline
    const candidates = pollRuns.filter(run => {
      if (baselineId !== null) {
        return run.databaseId > baselineId
      }
      // No baseline: use createdAt heuristic
      return new Date(run.createdAt) > triggerTime
    })

    if (candidates.length === 0) {
      // Our run not visible yet — keep polling
      continue
    }

    // Pick the highest databaseId from candidates (most likely ours)
    const matched = candidates.reduce((best, run) => (run.databaseId > best.databaseId ? run : best))
    latestMatchedRun = matched

    const {status, conclusion, url: runUrl} = matched

    // Environment approval gate
    if (status === 'waiting' || (status === 'pending' && /approval/i.test(conclusion ?? ''))) {
      return {kind: 'unverified', message: `Workflow requires environment approval at ${runUrl}`, runUrl}
    }

    if (status === 'completed') {
      if (conclusion === 'success') {
        // Best-effort log grep for "ack"
        let logNote = ''
        try {
          const logChild = Bun.spawn(['gh', 'run', 'view', String(matched.databaseId), '--log', '--repo', repo], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: process.env,
          })
          const [logStdout, , logExit] = await Promise.all([
            new Response(logChild.stdout).text(),
            new Response(logChild.stderr).text(),
            logChild.exited,
          ])
          if (logExit !== 0) {
            logNote = ' (log fetch failed, but run conclusion is success)'
          } else if (!/\back\b/i.test(logStdout)) {
            logNote = ' (log fetch succeeded but "ack" not found in output)'
          }
        } catch {
          logNote = ' (log fetch failed, but run conclusion is success)'
        }
        return {kind: 'pass', message: `Smoke test passed${logNote}`, runUrl}
      }

      return {kind: 'fail', message: `Run completed with conclusion=${conclusion ?? 'unknown'}`, runUrl}
    }

    // Still in progress (queued, in_progress) — continue polling
  }

  // All polls exhausted
  if (latestMatchedRun) {
    return {
      kind: 'unverified',
      message: `Smoke test did not complete in 5 minutes; check ${latestMatchedRun.url}`,
      runUrl: latestMatchedRun.url,
    }
  }

  return {
    kind: 'unverified',
    message: `Smoke test trigger not yet visible; check ${repoUrl}/actions`,
  }
}

export function registerCliproxySetup(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'cliproxy setup',
      'Interactively onboard a GitHub repository to CLIProxyAPI by creating or reusing a key and wiring the required GitHub secrets and variables.',
    )
    .option(
      '--key [key]',
      z
        .string()
        .describe(
          'Existing CLIProxyAPI API key value. When provided, setup skips key creation and reuses this key for GitHub secrets.',
        ),
    )
    .option(
      '--repo [repo]',
      z.string().describe('Target GitHub repository in owner/repo format. Skips the repository prompt when provided.'),
    )
    .option(
      '--harness [harness]',
      harnessSchema.describe(
        'Harness template to configure. Choose opencode, claude-code, or generic. Generic remains interactive-only.',
      ),
    )
    .option(
      '--providers [providers]',
      z
        .string()
        .describe(
          'Comma-separated list of providers to enable. Supported values: anthropic, openai. Example: --providers anthropic,openai',
        ),
    )
    .option(
      '--model [model]',
      z
        .string()
        .regex(MODEL_ID_RE)
        .describe(
          'Override the default model. Must be provider-prefixed and lowercase. Examples: anthropic/claude-sonnet-4-6, openai/gpt-4o',
        ),
    )
    .option(
      '--force',
      z.boolean().optional().describe('Overwrite existing GitHub secrets and variables without prompting.'),
    )
    .option('--dry-run', z.boolean().optional().describe('Print the plan without applying any changes.'))
    .option(
      '--verify-smoke',
      z.boolean().optional().describe('Run a smoke test against the proxy after setup completes.'),
    )
    .example('# Run the interactive onboarding wizard')
    .example('infra cliproxy setup')
    .example('# Run non-interactively with an existing key')
    .example('infra cliproxy setup --key sk-test --repo owner/repo --harness opencode')
    .example('# Enable both providers non-interactively')
    .example('infra cliproxy setup --key sk-test --repo owner/repo --harness opencode --providers anthropic,openai')
    .action(async options => {
      const interactive = Boolean(process.stdin.isTTY)
      const baseUrl = resolveBaseUrl()

      validateSetupOptions(options, interactive)

      if (interactive) {
        intro('CLIProxyAPI setup wizard')
      }

      try {
        await withSpinner('Checking GitHub CLI availability', async () => {
          await assertGhInstalled()
          await assertGhAuthenticated()
        })

        await withSpinner('Checking CLIProxyAPI reachability', async () => {
          await assertProxyReachable(baseUrl)
        })

        const plan = interactive
          ? await buildInteractivePlan(options, baseUrl)
          : await buildNonInteractivePlan(options, baseUrl)

        if (options.dryRun) {
          const providers: ProviderId[] = options.providers ? parseProviders(options.providers) : ['anthropic']
          const model = options.model ?? PROVIDER_DEFAULTS[providers[0] as ProviderId]
          console.log(
            formatDryRunPreview({
              repo: plan.repo,
              harness: plan.harness,
              providers,
              model,
              template: plan.template,
            }),
          )
          return
        }

        if (plan.createKey) {
          resolveManagementKey()
        }

        await withGhRetry(
          `Checking GitHub access for ${plan.repo}`,
          async () => {
            await assertRepoAccess(plan.repo)
          },
          interactive,
        )

        if (options.key) {
          log.info('Using the provided API key value directly. No new CLIProxyAPI key will be created.')
        }

        if (interactive) {
          note(
            [
              `Proxy: ${baseUrl}`,
              `Repository: ${plan.repo}`,
              `Harness: ${plan.harness}`,
              plan.createKey ? `New key name: ${plan.keyName}` : 'Using existing key value',
              'GitHub values to write:',
              formatTemplateSummary(plan.template),
            ].join('\n'),
            'Setup summary',
          )

          const shouldContinue = await promptValue(
            confirm({
              message: 'Proceed with GitHub secret and variable updates?',
              active: 'yes',
              inactive: 'no',
              initialValue: true,
            }),
            'Setup cancelled before applying GitHub values.',
          )

          if (!shouldContinue) {
            cancelAndExit('No changes applied.')
          }
        }

        const [existingSecrets, existingVariables] = await withGhRetry(
          'Checking existing GitHub secrets and variables',
          async () =>
            Promise.all([listExistingGhNames(plan.repo, 'secret'), listExistingGhNames(plan.repo, 'variable')]),
          interactive,
        )
        const collisions = collectCollisions(plan.template, existingSecrets, existingVariables)

        if (collisions.length > 0) {
          if (!interactive && !options.force) {
            throw new Error(
              `Refusing to overwrite existing GitHub values in non-interactive mode: ${collisions.join(', ')}. Pass --force to confirm.`,
            )
          }

          if (!interactive && options.force) {
            log.warn(`Overwriting existing GitHub values: ${collisions.join(', ')}`)
            // proceed
          }

          if (interactive) {
            log.warn(`Existing GitHub values will be overwritten: ${collisions.join(', ')}`)
            const overwrite = await promptValue(
              confirm({
                message: 'Overwrite the existing GitHub values?',
                active: 'overwrite',
                inactive: 'cancel',
                initialValue: false,
              }),
              'Setup cancelled instead of overwriting existing values.',
            )

            if (!overwrite) {
              cancelAndExit('Existing GitHub values left unchanged.')
            }
          }
        }

        let keyCreatedByThisRun = false
        const managementKey = plan.createKey ? resolveManagementKey() : undefined

        if (plan.createKey && managementKey) {
          await withSpinner('Creating a new CLIProxyAPI key', async () => {
            await createManagementApiKey(baseUrl, managementKey, plan.keyValue)
            keyCreatedByThisRun = true
          })
        }

        try {
          await withGhRetry(
            'Writing GitHub secrets and variables',
            async spinnerInstance => {
              for (const secret of plan.template.secrets) {
                spinnerInstance.message(`Setting secret ${secret.name}`)
                await applyGhValue('secret', secret.name, plan.repo, secret.value)
              }

              for (const variable of plan.template.variables) {
                spinnerInstance.message(`Setting variable ${variable.name}`)
                await applyGhValue('variable', variable.name, plan.repo, variable.value)
              }
            },
            interactive,
          )

          await withSpinner('Verifying the new key through the proxy', async () => {
            await assertProxyKeyWorks(baseUrl, plan.keyValue)
          })

          if (plan.harness === 'opencode') {
            const workflow = await withGhRetry(
              `Checking ${plan.repo} fro-bot.yaml wiring`,
              async () => {
                return checkFroBotWorkflow(plan.repo)
              },
              interactive,
            )

            switch (workflow.kind) {
              case 'missing': {
                log.warn(
                  `No .github/workflows/fro-bot.yaml found in ${plan.repo}. The secrets and variables are set, but Fro Bot won't run until the workflow exists and passes them as inputs. See marcusrbrown/infra/.github/workflows/fro-bot.yaml for a reference.`,
                )
                break
              }
              case 'unreachable': {
                log.warn(
                  `Could not check .github/workflows/fro-bot.yaml in ${plan.repo}: ${workflow.reason}. The secrets and variables are set, but the workflow wiring was not verified. Re-run 'infra cliproxy setup' later to confirm, or inspect the file directly.`,
                )
                break
              }
              case 'no-agent-step': {
                log.warn(
                  `${plan.repo} .github/workflows/fro-bot.yaml exists but has no 'fro-bot/agent' step. Add one that passes the secrets and variables just written. See marcusrbrown/infra/.github/workflows/fro-bot.yaml for a reference.`,
                )
                break
              }
              case 'analyzed': {
                for (const step of workflow.stepsWithGaps) {
                  const missing = [...step.missingInputs]
                  log.warn(
                    [
                      `${plan.repo} .github/workflows/fro-bot.yaml fro-bot/agent step #${step.stepOrdinal} is missing ${missing.length} required input${
                        missing.length > 1 ? 's' : ''
                      } (${missing.join(', ')}).`,
                      `Without ${missing.includes('opencode-config') ? 'opencode-config, the baseURL override is ignored and Fro Bot hits api.anthropic.com with the proxy key, which fails with 401' : 'these, the secrets you just wrote will not reach OpenCode'}.`,
                      '',
                      `Add under the 'with:' block of the 'fro-bot/agent' step:`,
                      formatWorkflowSnippet(missing),
                    ].join('\n'),
                  )
                }
                break
              }
              default: {
                const _exhaustive: never = workflow
                throw new Error(`Unhandled FroBotWorkflowCheck kind: ${JSON.stringify(_exhaustive)}`)
              }
            }
          }
        } catch (mutationError) {
          if (keyCreatedByThisRun && managementKey) {
            try {
              await deleteManagementApiKey(baseUrl, managementKey, plan.keyValue)
              log.warn('Rolled back the newly created CLIProxyAPI key after failure.')
            } catch {
              log.warn(
                'Failed to roll back the newly created CLIProxyAPI key. Remove it manually via: infra cliproxy keys remove',
              )
            }
          }
          throw mutationError
        }

        if (interactive) {
          outro(`Setup complete for ${plan.repo}. The ${plan.harness} harness can now use ${baseUrl}/v1.`)
        } else {
          log.success(`Setup complete for ${plan.repo}.`)
        }

        // ── Smoke test (opt-in, non-blocking) ──────────────────────────────
        if (options.verifySmoke) {
          const smokeResult = await withSpinner('Running smoke test', async () =>
            runSmokeTest(plan.repo, plan.template.variables.find(v => v.name === 'FRO_BOT_MODEL')?.value ?? ''),
          ).catch(async error => {
            // withSpinner re-throws; catch here so smoke test never gates setup
            return {
              kind: 'unverified' as const,
              message: `Smoke test error: ${extractErrorMessage(error)}`,
              runUrl: undefined,
            }
          })

          switch (smokeResult.kind) {
            case 'pass': {
              log.success(`✓ ${smokeResult.message}${smokeResult.runUrl ? ` — ${smokeResult.runUrl}` : ''}`)
              break
            }
            case 'fail': {
              log.warn(`✗ ${smokeResult.message}${smokeResult.runUrl ? ` — ${smokeResult.runUrl}` : ''}`)
              break
            }
            case 'unverified': {
              log.warn(`⚠ ${smokeResult.message}${smokeResult.runUrl ? ` — ${smokeResult.runUrl}` : ''}`)
              break
            }
            default: {
              const _exhaustive: never = smokeResult
              throw new Error(`Unhandled SmokeResult kind: ${JSON.stringify(_exhaustive)}`)
            }
          }
        }
      } catch (error) {
        const message = extractErrorMessage(error)
        if (interactive) {
          cancel(message)
        }
        throw error
      }
    })
}
