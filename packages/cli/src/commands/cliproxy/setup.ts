/// <reference types="bun" />

import type {goke} from 'goke'

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
}

interface SetupPlan {
  repo: string
  harness: Harness
  keyValue: string
  keyName?: string
  createKey: boolean
  template: HarnessTemplate
}

function resolveBaseUrl(input?: string): string {
  return stripTrailingSlash(input ?? process.env.CLIPROXY_URL ?? DEFAULT_CLIPROXY_URL)
}

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
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

  await verifyModelsAvailable(baseUrl, keyValue, providers, model)

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
        if (!options.dryRun) {
          await withSpinner('Checking GitHub CLI availability', async () => {
            await assertGhInstalled()
            await assertGhAuthenticated()
          })

          await withSpinner('Checking CLIProxyAPI reachability', async () => {
            await assertProxyReachable(baseUrl)
          })
        }

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
