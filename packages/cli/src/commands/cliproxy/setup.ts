/// <reference types="bun" />

import type {goke} from 'goke'

import type {ActionCtx} from '../../lib/action-ctx'

import {cancel, confirm, intro, log, note, outro, select, text} from '@clack/prompts'
import {z} from 'zod'

import {resolveManagementKey} from './config'
import {
  applyGhValue,
  assertGhAuthenticated,
  assertGhInstalled,
  assertRepoAccess,
  createManagementApiKey,
  deleteManagementApiKey,
  listExistingGhNames,
  withGhRetry,
  withSpinner,
} from './setup/gh'
import {formatDryRunPreview} from './setup/preview'
import {buildApiKeyValue, cancelAndExit, ensureRepoFormat, promptGenericSecretNames, promptValue} from './setup/prompts'
import {parseProviders, promptForModel, promptForProviders, PROVIDER_DEFAULTS, type ProviderId} from './setup/providers'
import {runSmokeTest} from './setup/smoke-test'
import {
  collectCollisions,
  formatTemplateSummary,
  getHarnessTemplate,
  harnessSchema,
  stripTrailingSlash,
  type Harness,
  type HarnessTemplate,
} from './setup/templates'
import {
  assertProxyKeyWorks,
  assertProxyReachable,
  MODEL_ID_RE,
  validateSetupOptions,
  verifyModelsAvailable,
} from './setup/validation'
import {checkFroBotWorkflow, formatWorkflowSnippet} from './setup/workflow-analyzer'

export {formatDryRunPreview, type DryRunPreviewOptions} from './setup/preview'
export {validateSetupOptions, verifyModelsAvailable} from './setup/validation'

const DEFAULT_CLIPROXY_URL = 'https://cliproxy.fro.bot'

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
  ackKeyReuse?: boolean
}

interface SetupPlan {
  repo: string
  harness: Harness
  keyValue: string
  keyName?: string
  createKey: boolean
  template: HarnessTemplate
}

// Internal: test-only DI surface. Not part of the published API.
export interface RunSetupDeps {
  interactive?: boolean
  baseUrl?: string
  ctx?: ActionCtx
  resolveManagementKey?: typeof resolveManagementKey
  gh?: {
    assertGhInstalled: typeof assertGhInstalled
    assertGhAuthenticated: typeof assertGhAuthenticated
    assertRepoAccess: typeof assertRepoAccess
    listExistingGhNames: typeof listExistingGhNames
    createManagementApiKey: typeof createManagementApiKey
    deleteManagementApiKey: typeof deleteManagementApiKey
    applyGhValue: typeof applyGhValue
    withGhRetry: typeof withGhRetry
  }
  prompts?: {
    promptValue: typeof promptValue
    confirm: typeof confirm
    intro: typeof intro
    note: typeof note
    outro: typeof outro
  }
  smoke?: {
    runSmokeTest: typeof runSmokeTest
  }
  validation?: {
    assertProxyReachable: typeof assertProxyReachable
    assertProxyKeyWorks: typeof assertProxyKeyWorks
    verifyModelsAvailable: typeof verifyModelsAvailable
  }
}

function resolveBaseUrl(input?: string): string {
  return stripTrailingSlash(input ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Redact a bearer token for display in interactive prompts — never show raw key values.
// Exported for direct unit testing of the redaction contract. The redacted form is
// what gets shown in the interactive R8 prompt; the raw key must never reach the prompt UI.
export function redactKey(key: string): string {
  if (key.length < 12) return 'sk-***'
  return `${key.slice(0, 3)}***${key.slice(-4)}`
}

async function buildInteractivePlan(
  options: SetupOptions,
  baseUrl: string,
  promptsImpl: Required<RunSetupDeps>['prompts'],
): Promise<SetupPlan> {
  const createKey = !options.key
  const keyName = createKey
    ? await promptsImpl.promptValue(
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
    (await promptsImpl.promptValue(
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
        await promptsImpl.promptValue(
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
export function requiresDestructiveProviderChangeConfirmation(providers: ProviderId[]): boolean {
  return !(providers.length === 1 && providers[0] === 'anthropic')
}

// Deprecated: use requiresDestructiveProviderChangeConfirmation. Will be removed in a future major.
export const mustConfirmDestructive = requiresDestructiveProviderChangeConfirmation

export async function buildNonInteractivePlan(
  options: SetupOptions,
  baseUrl: string,
  deps?: Pick<RunSetupDeps, 'validation'>,
): Promise<SetupPlan> {
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

  const verifyModels = deps?.validation?.verifyModelsAvailable ?? verifyModelsAvailable

  // Destructive overwrite gate: non-anthropic-only requires --force in non-interactive mode.
  // Check BEFORE verifyModelsAvailable to avoid a network call when the gate will reject anyway.
  if (requiresDestructiveProviderChangeConfirmation(providers) && !options.force) {
    throw new Error(
      `Refusing destructive provider change on ${options.repo ?? ''} without --force. Selected providers ${providers.join(', ')} would overwrite existing GitHub secret values (OPENCODE_AUTH_JSON, OPENCODE_CONFIG, OMO_PROVIDERS, FRO_BOT_MODEL). Note: --force authorizes overwriting these GitHub secret values; it does NOT rotate the underlying CLIProxyAPI proxy bearer token (which is preserved byte-for-byte when --key is supplied).`,
    )
  }

  await verifyModels(baseUrl, keyValue, providers, model)

  return {
    repo,
    harness,
    keyValue,
    createKey: false,
    template: getHarnessTemplate(harness, {keyValue, baseUrl, providers, model}),
  }
}

// Default real implementations for DI
const realGh: Required<RunSetupDeps>['gh'] = {
  assertGhInstalled,
  assertGhAuthenticated,
  assertRepoAccess,
  listExistingGhNames,
  createManagementApiKey,
  deleteManagementApiKey,
  applyGhValue,
  withGhRetry,
}

const realPrompts: Required<RunSetupDeps>['prompts'] = {
  promptValue,
  confirm,
  intro,
  note,
  outro,
}

const realSmoke: Required<RunSetupDeps>['smoke'] = {
  runSmokeTest,
}

const realValidation: Required<RunSetupDeps>['validation'] = {
  assertProxyReachable,
  assertProxyKeyWorks,
  verifyModelsAvailable,
}

const realCtx: ActionCtx = {
  console: {
    log: (...args: unknown[]) => {
      console.log(...args)
    },
    error: (...args: unknown[]) => {
      console.error(...args)
    },
  },
  process: {
    stdout: {write: (chunk: string) => process.stdout.write(chunk)},
    stderr: {write: (chunk: string) => process.stderr.write(chunk)},
    exit: (code: number) => process.exit(code),
  },
}

// Internal: test-only DI surface. Not part of the published API.
export async function runSetupCommand(options: SetupOptions, deps: RunSetupDeps = {}): Promise<void> {
  const interactive = deps.interactive ?? Boolean(process.stdin.isTTY)
  const baseUrl = deps.baseUrl ?? resolveBaseUrl()
  // ctxInjected distinguishes MCP-mounted callers (which need ctx.console.error to surface errors
  // through the MCP transport) from bare CLI callers (where cli.ts top-level catch already logs).
  // Without this distinction, CLI users see the error twice.
  const ctxInjected = deps.ctx !== undefined
  const ctx = deps.ctx ?? realCtx
  const gh = deps.gh ?? realGh
  const prompts = deps.prompts ?? realPrompts
  const smoke = deps.smoke ?? realSmoke
  const validation = deps.validation ?? realValidation
  const mgmtKeyResolver = deps.resolveManagementKey ?? resolveManagementKey

  // --dry-run: short-circuit before validation so it works with no flags.
  // Never blocks on stdin — safe to run anywhere.
  if (options.dryRun) {
    const providers: ProviderId[] = options.providers ? parseProviders(options.providers) : ['anthropic']
    const model = options.model ?? PROVIDER_DEFAULTS[providers[0] as ProviderId]
    const harness = options.harness ?? 'opencode'
    const repo = options.repo ?? '<repo not specified>'
    const keyValue = options.key ?? 'sk-placeholder'
    ctx.console.log(
      formatDryRunPreview({
        repo,
        harness,
        providers,
        model,
        template: getHarnessTemplate(harness, {keyValue, baseUrl, providers, model}),
      }),
    )
    return
  }

  validateSetupOptions(options, interactive)

  if (interactive) {
    prompts.intro('CLIProxyAPI setup wizard')
  }

  try {
    await withSpinner('Checking GitHub CLI availability', async () => {
      await gh.assertGhInstalled()
      await gh.assertGhAuthenticated()
    })

    await withSpinner('Checking CLIProxyAPI reachability', async () => {
      await validation.assertProxyReachable(baseUrl)
    })

    const plan = interactive
      ? await buildInteractivePlan(options, baseUrl, prompts)
      : await buildNonInteractivePlan(options, baseUrl, {validation})

    if (plan.createKey) {
      mgmtKeyResolver()
    }

    await gh.withGhRetry(
      `Checking GitHub access for ${plan.repo}`,
      async () => {
        await gh.assertRepoAccess(plan.repo)
      },
      interactive,
    )

    if (options.key) {
      log.info('Using the provided API key value directly. No new CLIProxyAPI key will be created.')
    }

    if (interactive) {
      prompts.note(
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

      const shouldContinue = await prompts.promptValue(
        prompts.confirm({
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

    const [existingSecrets, existingVariables] = await gh.withGhRetry(
      'Checking existing GitHub secrets and variables',
      async () =>
        Promise.all([gh.listExistingGhNames(plan.repo, 'secret'), gh.listExistingGhNames(plan.repo, 'variable')]),
      interactive,
    )

    // Key-reuse acknowledgment guard: bearer token must not appear in prompt text
    if (options.key && existingSecrets.includes('OPENCODE_AUTH_JSON')) {
      if (interactive) {
        const proceed = await prompts.promptValue(
          prompts.confirm({
            message: `You supplied --key ${redactKey(options.key)}. Verify it matches the bearer token inside the existing OPENCODE_AUTH_JSON on ${plan.repo}. Continue?`,
            active: 'yes',
            inactive: 'no',
            initialValue: false,
          }),
          'Setup cancelled. Run with --ack-key-reuse to bypass interactive confirmation.',
        )
        if (!proceed) {
          cancelAndExit('Setup cancelled. Run with --ack-key-reuse to bypass interactive confirmation.')
        }
      } else if (!options.ackKeyReuse) {
        throw new Error(
          `Refusing key-reuse without explicit acknowledgment. Pass --ack-key-reuse to confirm that --key matches the bearer token inside the existing OPENCODE_AUTH_JSON on ${plan.repo}. (The CLI cannot verify this because GitHub secrets are write-only.)`,
        )
      }
    }

    const collisions = collectCollisions(plan.template, existingSecrets, existingVariables)

    if (collisions.length > 0) {
      if (!interactive && !options.force) {
        throw new Error(
          `Refusing to overwrite existing GitHub values in ${plan.repo}: ${collisions.join(', ')}. Pass --force to confirm. Note: --force only authorizes overwriting these GitHub secret values; it does NOT rotate the underlying CLIProxyAPI proxy bearer token (which is preserved byte-for-byte when --key is supplied).`,
        )
      }

      if (!interactive && options.force) {
        log.warn(`Overwriting existing GitHub values: ${collisions.join(', ')}`)
        // proceed
      }

      if (interactive) {
        log.warn(`Existing GitHub values will be overwritten: ${collisions.join(', ')}`)
        const overwrite = await prompts.promptValue(
          prompts.confirm({
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
    const managementKey = plan.createKey ? mgmtKeyResolver() : undefined

    if (plan.createKey && managementKey) {
      await withSpinner('Creating a new CLIProxyAPI key', async () => {
        await gh.createManagementApiKey(baseUrl, managementKey, plan.keyValue)
        keyCreatedByThisRun = true
      })
    }

    try {
      await gh.withGhRetry(
        'Writing GitHub secrets and variables',
        async spinnerInstance => {
          for (const secret of plan.template.secrets) {
            spinnerInstance.message(`Setting secret ${secret.name}`)
            await gh.applyGhValue('secret', secret.name, plan.repo, secret.value)
          }

          for (const variable of plan.template.variables) {
            spinnerInstance.message(`Setting variable ${variable.name}`)
            await gh.applyGhValue('variable', variable.name, plan.repo, variable.value)
          }
        },
        interactive,
      )

      await withSpinner('Verifying the new key through the proxy', async () => {
        await validation.assertProxyKeyWorks(baseUrl, plan.keyValue)
      })

      if (plan.harness === 'opencode') {
        const workflow = await gh.withGhRetry(
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
          await gh.deleteManagementApiKey(baseUrl, managementKey, plan.keyValue)
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
      prompts.outro(`Setup complete for ${plan.repo}. The ${plan.harness} harness can now use ${baseUrl}/v1.`)
    } else {
      log.success(`Setup complete for ${plan.repo}.`)
    }

    // ── Smoke test (opt-in, non-blocking) ──────────────────────────────
    if (options.verifySmoke) {
      const smokeResult = await withSpinner('Running smoke test', async () =>
        smoke.runSmokeTest(plan.repo, plan.template.variables.find(v => v.name === 'FRO_BOT_MODEL')?.value ?? ''),
      ).catch(async error => {
        // withSpinner re-throws; catch here so smoke test never gates setup
        return {
          kind: 'unverified' as const,
          message: `Smoke test error: ${extractErrorMessage(error)}`,
          runUrl: undefined,
        }
      })

      // Machine-parseable hook for MCP/agent consumers
      ctx.console.log(`[smoke-test] kind=${smokeResult.kind}`)

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
    // MCP-mounted callers need ctx.console.error to surface the message through the MCP transport.
    // Bare CLI callers leave it to cli.ts's top-level catch — emitting here too would double-log.
    if (ctxInjected) {
      ctx.console.error(message)
    }
    if (interactive) {
      cancel(message)
    }
    throw error
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
          'Comma-separated list of providers to enable. Default: anthropic. Supported values: anthropic, openai. Example: --providers anthropic,openai',
        ),
    )
    .option(
      '--model [model]',
      z
        .string()
        .regex(MODEL_ID_RE)
        .describe(
          'Override the default model. Must be provider-prefixed and lowercase. Required when multiple providers selected. Examples: anthropic/claude-sonnet-4-6, openai/gpt-4o',
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
    .option(
      '--ack-key-reuse',
      z
        .boolean()
        .default(false)
        .describe(
          'Acknowledge that --key matches the bearer token inside the existing OPENCODE_AUTH_JSON. Required in non-interactive mode when --key is supplied for a repo with existing OPENCODE_AUTH_JSON.',
        ),
    )
    .example('# Preview planned actions without applying any changes (no flags required)')
    .example('infra cliproxy setup --dry-run')
    .example('# Run the interactive onboarding wizard')
    .example('infra cliproxy setup')
    .example('# Run non-interactively with an existing key (anthropic-only)')
    .example('infra cliproxy setup --repo owner/repo --harness opencode --key sk-existing --force')
    .example('# Enable both providers non-interactively (requires --force and --model)')
    .example(
      'infra cliproxy setup --repo owner/repo --harness opencode --providers anthropic,openai --model openai/gpt-5.4-mini --key sk-existing --ack-key-reuse --force',
    )
    .action(async (options, ctx) => {
      await runSetupCommand(options, {ctx})
    })
}
