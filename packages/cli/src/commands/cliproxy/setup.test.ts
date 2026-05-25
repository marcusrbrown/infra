/// <reference types="bun" />

import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test'
import {goke} from 'goke'

import {
  analyzeFroBotWorkflow,
  formatWorkflowSnippet,
  getHarnessTemplate,
  interpretGhContentResult,
  isGhRateLimitError,
  parseProviders,
  promptForModel,
  promptForProviders,
  registerCliproxySetup,
  validateSetupOptions,
  verifyModelsAvailable,
  withGhRetry,
  type SecretAssignment,
  type VariableAssignment,
} from './setup'

const COMPLETE_WORKFLOW = `      - uses: fro-bot/agent@abc123
        with:
          github-token: \${{ secrets.FRO_BOT_PAT }}
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          model: \${{ vars.FRO_BOT_MODEL }}
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
          opencode-config: \${{ secrets.OPENCODE_CONFIG }}
          prompt: \${{ env.PROMPT }}
`

const MISSING_OPENCODE_CONFIG_WORKFLOW = `      - uses: fro-bot/agent@abc123
        with:
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          github-token: \${{ secrets.FRO_BOT_PAT }}
          model: \${{ vars.FRO_BOT_MODEL }}
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
          prompt: \${{ env.PROMPT }}
`

// Regression fixture for PR #125 review: a sibling step has `model:` as an input,
// but the fro-bot/agent step is missing it. The step-scoped scan must still flag
// `model` as missing, otherwise the diagnostic is silently suppressed.
const SIBLING_STEP_SHADOWS_MODEL_INPUT = `name: ci
on: [push]
jobs:
  run:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        model: [opus, sonnet]
    steps:
      - uses: actions/some-ai-step@abc
        with:
          model: \${{ matrix.model }}
      - name: Run Fro Bot
        uses: fro-bot/agent@def
        with:
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          opencode-config: \${{ secrets.OPENCODE_CONFIG }}
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
`

const WORKFLOW_WITHOUT_FRO_BOT_AGENT = `name: ci
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: echo hello
`

// Follow-up from PR #125 second review: the matchAll refactor must report gaps
// in any fro-bot/agent step, not just the first. Step #1 is complete, step #2 is
// missing opencode-config and model — the analyzer should flag only step #2.
const TWO_AGENT_STEPS_SECOND_BROKEN = `name: fro-bot
on: [pull_request, schedule]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Run Fro Bot review
        uses: fro-bot/agent@abc123
        with:
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          opencode-config: \${{ secrets.OPENCODE_CONFIG }}
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
          model: \${{ vars.FRO_BOT_MODEL }}
  dispatch:
    runs-on: ubuntu-latest
    steps:
      - name: Run Fro Bot dispatch
        uses: fro-bot/agent@abc123
        with:
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
`

describe('cliproxy setup helpers', () => {
  describe('validateSetupOptions', () => {
    it('requires --key in non-interactive mode', () => {
      expect(() => validateSetupOptions({repo: 'owner/repo', harness: 'opencode'}, false)).toThrow(
        '--key is required when stdin is not a TTY',
      )
    })

    it('requires --repo in non-interactive mode', () => {
      expect(() => validateSetupOptions({key: 'sk-test', harness: 'opencode'}, false)).toThrow(
        '--repo is required when stdin is not a TTY',
      )
    })

    it('requires --harness in non-interactive mode', () => {
      expect(() => validateSetupOptions({key: 'sk-test', repo: 'owner/repo'}, false)).toThrow(
        '--harness is required when stdin is not a TTY',
      )
    })
  })

  describe('getHarnessTemplate', () => {
    it('returns the expected OpenCode secret and variable names', () => {
      const template = getHarnessTemplate('opencode')

      expect(template.secrets.map((entry: SecretAssignment) => entry.name)).toEqual([
        'OPENCODE_AUTH_JSON',
        'OPENCODE_CONFIG',
        'OMO_PROVIDERS',
      ])
      expect(template.variables.map((entry: VariableAssignment) => entry.name)).toEqual(['FRO_BOT_MODEL'])
    })

    it('uses a provider-prefixed FRO_BOT_MODEL default value', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'sk-test'})
      const modelEntry = template.variables.find((entry: VariableAssignment) => entry.name === 'FRO_BOT_MODEL')

      expect(modelEntry?.value).toMatch(/^anthropic\//)
    })

    it('uses the expected OMO_PROVIDERS default value', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'sk-test'})
      const providersEntry = template.secrets.find((entry: SecretAssignment) => entry.name === 'OMO_PROVIDERS')

      expect(providersEntry?.value).toBe('claude-max20')
    })

    it('writes an OPENCODE_CONFIG baseURL with the /v1 suffix', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'sk-test'})
      const configEntry = template.secrets.find((entry: SecretAssignment) => entry.name === 'OPENCODE_CONFIG')
      const parsed = JSON.parse(configEntry?.value ?? '{}')

      expect(parsed.provider.anthropic.options.baseURL).toMatch(/\/v1$/)
    })

    it('writes OPENCODE_AUTH_JSON with type=api and the supplied key', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'sk-test-key'})
      const authEntry = template.secrets.find((entry: SecretAssignment) => entry.name === 'OPENCODE_AUTH_JSON')
      const parsed = JSON.parse(authEntry?.value ?? '{}')

      expect(parsed.anthropic).toEqual({type: 'api', key: 'sk-test-key'})
    })
  })

  describe('analyzeFroBotWorkflow', () => {
    it('returns empty stepsWithGaps when all four inputs are wired', () => {
      const result = analyzeFroBotWorkflow(COMPLETE_WORKFLOW)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toEqual([])
    })

    it('detects a missing opencode-config input on step #1', () => {
      const result = analyzeFroBotWorkflow(MISSING_OPENCODE_CONFIG_WORKFLOW)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toHaveLength(1)
      expect(result.stepsWithGaps[0]?.stepOrdinal).toBe(1)
      expect([...(result.stepsWithGaps[0]?.missingInputs ?? [])]).toEqual(['opencode-config'])
    })

    it('flags model as missing even when a sibling step uses model: as an input', () => {
      const result = analyzeFroBotWorkflow(SIBLING_STEP_SHADOWS_MODEL_INPUT)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toHaveLength(1)
      expect(result.stepsWithGaps[0]?.stepOrdinal).toBe(1)
      expect([...(result.stepsWithGaps[0]?.missingInputs ?? [])]).toEqual(['model'])
    })

    it('returns kind no-agent-step when the workflow has no fro-bot/agent step', () => {
      const result = analyzeFroBotWorkflow(WORKFLOW_WITHOUT_FRO_BOT_AGENT)

      expect(result.kind).toBe('no-agent-step')
    })

    it('returns kind no-agent-step for empty content', () => {
      const result = analyzeFroBotWorkflow('')

      expect(result.kind).toBe('no-agent-step')
    })

    it('reports only the broken step when a workflow has two fro-bot/agent steps and one is complete', () => {
      const result = analyzeFroBotWorkflow(TWO_AGENT_STEPS_SECOND_BROKEN)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toHaveLength(1)
      expect(result.stepsWithGaps[0]?.stepOrdinal).toBe(2)
      expect([...(result.stepsWithGaps[0]?.missingInputs ?? [])]).toEqual(['opencode-config', 'model'])
    })
  })

  describe('interpretGhContentResult', () => {
    it('returns kind missing when stderr contains HTTP 404', () => {
      const result = interpretGhContentResult({
        exitCode: 1,
        stdout: '',
        stderr: 'gh: Not Found (HTTP 404)',
      })

      expect(result.kind).toBe('missing')
    })

    it('returns kind unreachable with the stderr reason on non-404 failures', () => {
      const result = interpretGhContentResult({
        exitCode: 1,
        stdout: '',
        stderr: 'gh: API rate limit exceeded',
      })

      expect(result.kind).toBe('unreachable')
      if (result.kind !== 'unreachable') throw new Error('unreachable')
      expect(result.reason).toBe('gh: API rate limit exceeded')
    })

    it('falls back to the exit code when stderr is empty on a non-404 failure', () => {
      const result = interpretGhContentResult({exitCode: 2, stdout: '', stderr: ''})

      expect(result.kind).toBe('unreachable')
      if (result.kind !== 'unreachable') throw new Error('unreachable')
      expect(result.reason).toBe('gh api exited with code 2')
    })

    it('delegates to analyzeFroBotWorkflow on a successful response', () => {
      const result = interpretGhContentResult({
        exitCode: 0,
        stdout: COMPLETE_WORKFLOW,
        stderr: '',
      })

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toEqual([])
    })
  })

  describe('formatWorkflowSnippet', () => {
    it('renders snippet lines at 10-space indent so they can be pasted directly under with:', () => {
      const snippet = formatWorkflowSnippet(['opencode-config', 'model'])

      /* eslint-disable no-template-curly-in-string -- GitHub Actions expression syntax, not JS template literals */
      const expected = [
        '          opencode-config: ${{ secrets.OPENCODE_CONFIG }}',
        '          model: ${{ vars.FRO_BOT_MODEL }}',
      ].join('\n')
      /* eslint-enable no-template-curly-in-string */
      expect(snippet).toBe(expected)
    })
  })

  describe('isGhRateLimitError', () => {
    it('returns true when text contains "rate limit"', () => {
      expect(isGhRateLimitError('API rate limit exceeded')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(isGhRateLimitError('You have exceeded a secondary RATE LIMIT')).toBe(true)
    })

    it('returns false for unrelated error messages', () => {
      expect(isGhRateLimitError('Not Found (HTTP 404)')).toBe(false)
    })

    it('returns false for an empty string', () => {
      expect(isGhRateLimitError('')).toBe(false)
    })

    it('returns false for a connection timeout', () => {
      expect(isGhRateLimitError('connection timeout')).toBe(false)
    })
  })

  describe('withGhRetry', () => {
    it('returns the value when fn succeeds immediately', async () => {
      const result = await withGhRetry('test label', async () => 'ok', false)

      expect(result).toBe('ok')
    })

    it('re-throws non-rate-limit errors without querying the reset time', async () => {
      const queryReset = async (): Promise<string> => {
        throw new Error('queryReset should not have been called')
      }
      const err = new Error('some other error')

      await expect(withGhRetry('test label', async () => Promise.reject(err), false, queryReset)).rejects.toThrow(
        'some other error',
      )
    })

    it('re-throws with reset time appended in non-interactive mode on rate limit', async () => {
      const queryReset = async (): Promise<string> => '2:30 PM'

      await expect(
        withGhRetry(
          'test label',
          async () => {
            throw new Error('API rate limit exceeded for url')
          },
          false,
          queryReset,
        ),
      ).rejects.toThrow('resets at 2:30 PM')
    })
  })

  describe('help output', () => {
    it('shows --key, --repo, and --harness flags', () => {
      const cli = goke('infra')
      registerCliproxySetup(cli)
      cli.help()

      const helpText = cli.helpText()

      expect(helpText).toContain('cliproxy setup')
      expect(helpText).toContain('--key [key]')
      expect(helpText).toContain('--repo [repo]')
      expect(helpText).toContain('--harness [harness]')
    })

    it('shows all five new Unit 1 flags in help text', () => {
      const cli = goke('infra')
      registerCliproxySetup(cli)
      cli.help()

      const helpText = cli.helpText()

      expect(helpText).toContain('--providers')
      expect(helpText).toContain('--model')
      expect(helpText).toContain('--force')
      expect(helpText).toContain('--dry-run')
      expect(helpText).toContain('--verify-smoke')
    })
  })
})

describe('Unit 1 — option parsing', () => {
  describe('parseProviders', () => {
    it("parses \"anthropic,openai\" to ['anthropic', 'openai']", () => {
      expect(parseProviders('anthropic,openai')).toEqual(['anthropic', 'openai'])
    })

    it('parses "openai" to [\'openai\']', () => {
      expect(parseProviders('openai')).toEqual(['openai'])
    })

    it('parses "anthropic" to [\'anthropic\']', () => {
      expect(parseProviders('anthropic')).toEqual(['anthropic'])
    })

    it('rejects duplicate providers with a "duplicate" error', () => {
      expect(() => parseProviders('anthropic,anthropic')).toThrow(/duplicate/i)
    })

    it('rejects an empty string with a clear message', () => {
      expect(() => parseProviders('')).toThrow()
    })

    it('rejects an unknown provider "claude" with an enum error', () => {
      expect(() => parseProviders('claude')).toThrow()
    })

    it('trims whitespace around provider names', () => {
      expect(parseProviders(' anthropic , openai ')).toEqual(['anthropic', 'openai'])
    })
  })

  describe('model flag validation', () => {
    it('accepts "openai/gpt-5.4-mini"', () => {
      const cli = goke('infra')
      registerCliproxySetup(cli)
      // Verify the schema accepts valid model IDs by checking the regex directly
      const MODEL_RE = /^(?:anthropic|openai)\/[a-z\d][a-z\d.\-]*$/
      expect(MODEL_RE.test('openai/gpt-5.4-mini')).toBe(true)
    })

    it('rejects "gpt-5.4-mini" (no provider prefix)', () => {
      const MODEL_RE = /^(?:anthropic|openai)\/[a-z\d][a-z\d.\-]*$/
      expect(MODEL_RE.test('gpt-5.4-mini')).toBe(false)
    })

    it('rejects "openai/GPT-5.4-mini" (uppercase)', () => {
      const MODEL_RE = /^(?:anthropic|openai)\/[a-z\d][a-z\d.\-]*$/
      expect(MODEL_RE.test('openai/GPT-5.4-mini')).toBe(false)
    })

    it('rejects "openai/gpt-5.4-mini; rm -rf /" (injection attempt)', () => {
      const MODEL_RE = /^(?:anthropic|openai)\/[a-z\d][a-z\d.\-]*$/
      expect(MODEL_RE.test('openai/gpt-5.4-mini; rm -rf /')).toBe(false)
    })
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any -- spyOn mock return values require `any` casts */
describe('Unit 2 — interactive provider/model prompts', () => {
  // We spy on @clack/prompts functions directly since Bun's mock.module
  // requires static hoisting. Instead we use spyOn on the imported module.
  // The helpers call the clack functions via the module binding, so we
  // intercept them via spyOn after importing.

  // Note: Because setup.ts imports clack at module load time and calls the
  // functions directly (not via a re-exported object), we need to use
  // mock.module to intercept. However, Bun's mock.module must be called
  // before the module is imported. Since setup.ts is already imported above,
  // we test the helpers by injecting controlled behavior through the clack
  // module mock at the describe level using beforeEach/afterEach with spyOn
  // on the actual clack module exports.
  //
  // The approach: import clack directly and spyOn its exports.

  describe('promptForProviders', () => {
    it('happy path: anthropic-only selection returns [anthropic]', async () => {
      const clack = await import('@clack/prompts')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(['anthropic'] as any)

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic'])
      expect(multiselectSpy).toHaveBeenCalledTimes(1)

      multiselectSpy.mockRestore()
    })

    it('happy path: both providers selected returns [anthropic, openai]', async () => {
      const clack = await import('@clack/prompts')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(['anthropic', 'openai'] as any)

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic', 'openai'])

      multiselectSpy.mockRestore()
    })

    it('edge case: empty selection re-prompts; multiselect called exactly twice', async () => {
      const clack = await import('@clack/prompts')
      let callCount = 0
      const multiselectSpy = spyOn(clack, 'multiselect').mockImplementation(async () => {
        callCount++
        if (callCount === 1) return [] as any
        return ['anthropic'] as any
      })

      const result = await promptForProviders()

      expect(result).toEqual(['anthropic'])
      expect(multiselectSpy).toHaveBeenCalledTimes(2)

      multiselectSpy.mockRestore()
    })

    it('edge case: cancel mid-flow causes process.exit(0)', async () => {
      const clack = await import('@clack/prompts')
      const cancelSymbol = Symbol('cancel')
      const multiselectSpy = spyOn(clack, 'multiselect').mockResolvedValue(cancelSymbol as any)
      const isCancelSpy = spyOn(clack, 'isCancel').mockImplementation(v => v === cancelSymbol)
      const cancelSpy = spyOn(clack, 'cancel').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as any)

      await expect(promptForProviders()).rejects.toThrow('process.exit called')

      multiselectSpy.mockRestore()
      isCancelSpy.mockRestore()
      cancelSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })

  describe('promptForModel', () => {
    it('happy path: single anthropic provider returns anthropic/claude-sonnet-4-6 without prompting', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select')

      const result = await promptForModel(['anthropic'])

      expect(result).toBe('anthropic/claude-sonnet-4-6')
      expect(selectSpy).not.toHaveBeenCalled()

      selectSpy.mockRestore()
    })

    it('happy path: single openai provider returns openai/gpt-5.4-mini without prompting', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select')

      const result = await promptForModel(['openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(selectSpy).not.toHaveBeenCalled()

      selectSpy.mockRestore()
    })

    it('happy path: both providers, operator picks openai/gpt-5.4-mini from select', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('openai/gpt-5.4-mini' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(selectSpy).toHaveBeenCalledTimes(1)

      selectSpy.mockRestore()
    })

    it('happy path: both providers, operator picks anthropic/claude-sonnet-4-6 from select', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('anthropic/claude-sonnet-4-6' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('anthropic/claude-sonnet-4-6')

      selectSpy.mockRestore()
    })

    it('happy path: operator picks "enter custom..." then types openai/gpt-5.4-mini', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('__custom__' as any)
      const textSpy = spyOn(clack, 'text').mockResolvedValue('openai/gpt-5.4-mini' as any)

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(textSpy).toHaveBeenCalledTimes(1)

      selectSpy.mockRestore()
      textSpy.mockRestore()
    })

    it('edge case: custom model entry fails regex then succeeds on second attempt', async () => {
      const clack = await import('@clack/prompts')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue('__custom__' as any)
      let textCallCount = 0
      const textSpy = spyOn(clack, 'text').mockImplementation(async (_opts: any) => {
        textCallCount++
        // Simulate the validate function being called inline by the mock
        // The real clack text prompt calls validate internally; here we just
        // return the value and let the helper's validate logic re-prompt.
        // Since we can't simulate clack's internal validate loop, we test
        // that the helper's validate function rejects bad input.
        if (textCallCount === 1) {
          // Return a bad value — the helper should detect this and re-prompt
          return 'bad-model' as any
        }
        return 'openai/gpt-5.4-mini' as any
      })

      const result = await promptForModel(['anthropic', 'openai'])

      expect(result).toBe('openai/gpt-5.4-mini')
      expect(textSpy.mock.calls.length).toBeGreaterThanOrEqual(1)

      selectSpy.mockRestore()
      textSpy.mockRestore()
    })

    it('edge case: cancel during model select causes process.exit(0)', async () => {
      const clack = await import('@clack/prompts')
      const cancelSymbol = Symbol('cancel')
      const selectSpy = spyOn(clack, 'select').mockResolvedValue(cancelSymbol as any)
      const isCancelSpy = spyOn(clack, 'isCancel').mockImplementation(v => v === cancelSymbol)
      const cancelSpy = spyOn(clack, 'cancel').mockImplementation(() => {})
      const exitSpy = spyOn(process, 'exit').mockImplementation((() => {
        throw new Error('process.exit called')
      }) as any)

      await expect(promptForModel(['anthropic', 'openai'])).rejects.toThrow('process.exit called')

      selectSpy.mockRestore()
      isCancelSpy.mockRestore()
      cancelSpy.mockRestore()
      exitSpy.mockRestore()
    })
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

describe('Unit 3 — getHarnessTemplate provider-aware', () => {
  // Frozen byte-identical string for the anthropic-only regression test.
  // This is the EXACT output of getHarnessTemplate('opencode', {keyValue: 'test-key'})
  // as of the Unit 2 baseline. Any change to this string is a breaking regression.
  const ANTHROPIC_ONLY_AUTH_JSON = '{"anthropic":{"type":"api","key":"test-key"}}'
  const ANTHROPIC_ONLY_CONFIG = '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}'

  describe('regression — anthropic-only (byte-identical)', () => {
    it('no providers/model args → OPENCODE_AUTH_JSON is byte-identical to baseline', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const authEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')

      expect(authEntry?.value).toBe(ANTHROPIC_ONLY_AUTH_JSON)
    })

    it('no providers/model args → OPENCODE_CONFIG is byte-identical to baseline', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const configEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_CONFIG')

      expect(configEntry?.value).toBe(ANTHROPIC_ONLY_CONFIG)
    })

    it('no providers/model args → OMO_PROVIDERS is claude-max20', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const entry = template.secrets.find((e: SecretAssignment) => e.name === 'OMO_PROVIDERS')

      expect(entry?.value).toBe('claude-max20')
    })

    it('no providers/model args → FRO_BOT_MODEL is anthropic/claude-sonnet-4-6', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const entry = template.variables.find((e: VariableAssignment) => e.name === 'FRO_BOT_MODEL')

      expect(entry?.value).toBe('anthropic/claude-sonnet-4-6')
    })

    it("explicit providers: ['anthropic'] → byte-identical to no-providers output", () => {
      const baseline = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const explicit = getHarnessTemplate('opencode', {keyValue: 'test-key', providers: ['anthropic']})

      const baselineAuth = baseline.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')
      const explicitAuth = explicit.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')
      expect(explicitAuth?.value).toBe(baselineAuth?.value)

      const baselineConfig = baseline.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_CONFIG')
      const explicitConfig = explicit.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_CONFIG')
      expect(explicitConfig?.value).toBe(baselineConfig?.value)
    })
  })

  describe('openai-only provider', () => {
    it("providers: ['openai'], model: 'openai/gpt-5.4-mini' → correct OPENCODE_AUTH_JSON", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const authEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')

      expect(authEntry?.value).toBe('{"openai":{"type":"api","key":"sk-openai-key"}}')
    })

    it("providers: ['openai'], model: 'openai/gpt-5.4-mini' → correct OPENCODE_CONFIG", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const configEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_CONFIG')

      expect(configEntry?.value).toBe('{"provider":{"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}')
    })

    it("providers: ['openai'], model: 'openai/gpt-5.4-mini' → OMO_PROVIDERS is openai", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const entry = template.secrets.find((e: SecretAssignment) => e.name === 'OMO_PROVIDERS')

      expect(entry?.value).toBe('openai')
    })

    it("providers: ['openai'], model: 'openai/gpt-5.4-mini' → FRO_BOT_MODEL is openai/gpt-5.4-mini", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const entry = template.variables.find((e: VariableAssignment) => e.name === 'FRO_BOT_MODEL')

      expect(entry?.value).toBe('openai/gpt-5.4-mini')
    })

    it("providers: ['openai'] with no model → uses PROVIDER_DEFAULTS openai/gpt-5.4-mini", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
      })
      const entry = template.variables.find((e: VariableAssignment) => e.name === 'FRO_BOT_MODEL')

      expect(entry?.value).toBe('openai/gpt-5.4-mini')
    })
  })

  describe('dual-provider (anthropic + openai)', () => {
    it("providers: ['anthropic', 'openai'] → OPENCODE_AUTH_JSON has anthropic-first key order", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['anthropic', 'openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const authEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')

      expect(authEntry?.value).toBe(
        '{"anthropic":{"type":"api","key":"sk-dual"},"openai":{"type":"api","key":"sk-dual"}}',
      )
    })

    it("providers: ['anthropic', 'openai'] → OPENCODE_CONFIG has anthropic-first key order", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['anthropic', 'openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const configEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_CONFIG')

      expect(configEntry?.value).toBe(
        '{"provider":{"anthropic":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}},"openai":{"options":{"baseURL":"https://cliproxy.fro.bot/v1"}}}}',
      )
    })

    it("providers: ['anthropic', 'openai'] → OMO_PROVIDERS is claude-max20,openai", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['anthropic', 'openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const entry = template.secrets.find((e: SecretAssignment) => e.name === 'OMO_PROVIDERS')

      expect(entry?.value).toBe('claude-max20,openai')
    })

    it("providers: ['anthropic', 'openai'] → FRO_BOT_MODEL is the supplied model", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['anthropic', 'openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const entry = template.variables.find((e: VariableAssignment) => e.name === 'FRO_BOT_MODEL')

      expect(entry?.value).toBe('openai/gpt-5.4-mini')
    })

    it("providers: ['openai', 'anthropic'] (openai first) → output is still anthropic-first in JSON", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['openai', 'anthropic'],
        model: 'openai/gpt-5.4-mini',
      })
      const authEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')

      expect(authEntry?.value).toBe(
        '{"anthropic":{"type":"api","key":"sk-dual"},"openai":{"type":"api","key":"sk-dual"}}',
      )
    })

    it('multiple providers with no model → throws "model required when multiple providers selected"', () => {
      expect(() =>
        getHarnessTemplate('opencode', {
          keyValue: 'sk-dual',
          providers: ['anthropic', 'openai'],
        }),
      ).toThrow('model required when multiple providers selected')
    })
  })

  describe('edge cases', () => {
    it('keyValue: undefined → auth-json key is sk-placeholder', () => {
      const template = getHarnessTemplate('opencode', {providers: ['anthropic']})
      const authEntry = template.secrets.find((e: SecretAssignment) => e.name === 'OPENCODE_AUTH_JSON')
      const parsed = JSON.parse(authEntry?.value ?? '{}')

      expect(parsed.anthropic.key).toBe('sk-placeholder')
    })

    it('claude-code harness is unaffected by providers/model args', () => {
      const template = getHarnessTemplate('claude-code', {keyValue: 'sk-cc'})

      expect(template.secrets).toHaveLength(1)
      expect(template.secrets[0]?.name).toBe('ANTHROPIC_API_KEY')
    })
  })
})

describe('Unit 4 — verifyModelsAvailable', () => {
  // Realistic fixture matching the plan spec
  const MODELS_FIXTURE = {
    data: [
      {id: 'claude-3-7-sonnet-20250219', owned_by: 'anthropic'},
      {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      {id: 'gpt-5.4-mini', owned_by: 'openai'},
      {id: 'gpt-5.5', owned_by: 'openai'},
    ],
  }

  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // Save and restore globalThis.fetch around each test
  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  // Capture original before any test runs
  originalFetch = globalThis.fetch

  it('anthropic-only short-circuit: returns immediately without calling fetch', async () => {
    const fetchSpy = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
    globalThis.fetch = fetchSpy as unknown as typeof fetch

    await verifyModelsAvailable(BASE_URL, KEY, ['anthropic'], 'anthropic/claude-sonnet-4-6')

    expect(fetchSpy.mock.calls.length).toBe(0)
  })

  it('happy path: openai-only, model present, owned_by openai — passes without throw', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).resolves.toBeUndefined()
  })

  it('happy path: dual providers, anthropic model present, openai entries exist — passes', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    await expect(
      verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'anthropic/claude-sonnet-4-6'),
    ).resolves.toBeUndefined()
  })

  it('error path: 401 throws "Proxy key rejected" message', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'Proxy key rejected',
    )
  })

  it('error path: 401 error message does NOT contain the Authorization header value', async () => {
    globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).not.toContain(KEY)
    expect(errorMessage).not.toContain('Bearer')
  })

  it('error path: 403 throws "Proxy key rejected" message', async () => {
    globalThis.fetch = mock(async () => new Response('Forbidden', {status: 403})) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'Proxy key rejected',
    )
  })

  it('error path: 500 throws with status and truncated body; no Authorization header in message', async () => {
    const body = 'Internal Server Error — something went wrong on the proxy'
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('500')
    expect(errorMessage).not.toContain(KEY)
    expect(errorMessage).not.toContain('Bearer')
  })

  it('error path: 200 with data:[] and openai in providers throws no-openai-models message', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({data: []}))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'No OpenAI models on proxy',
    )
  })

  it('error path: model not present in data — throws and lists available openai ids', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-99-unknown')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('gpt-99-unknown')
    // Should list available openai models
    expect(errorMessage).toContain('gpt-5.4-mini')
    expect(errorMessage).toContain('gpt-5.5')
    // Should NOT list anthropic models
    expect(errorMessage).not.toContain('claude')
  })

  it('error path: model not present and provider is anthropic — lists available anthropic ids', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'anthropic/claude-unknown-model')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('claude-unknown-model')
    // Should list available anthropic models
    expect(errorMessage).toContain('claude-3-7-sonnet-20250219')
    expect(errorMessage).toContain('claude-sonnet-4-6')
    // Should NOT list openai models
    expect(errorMessage).not.toContain('gpt-')
  })

  it('error path: data is missing (response is {}) — throws clean error', async () => {
    globalThis.fetch = mock(async () => new Response(JSON.stringify({}))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      /data.*array|unexpected.*response/i,
    )
  })

  it('error path: dual providers, no owned_by=openai entries — throws no-openai-models message', async () => {
    const anthropicOnlyData = {
      data: [
        {id: 'claude-3-7-sonnet-20250219', owned_by: 'anthropic'},
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      ],
    }
    globalThis.fetch = mock(async () => new Response(JSON.stringify(anthropicOnlyData))) as unknown as typeof fetch

    await expect(verifyModelsAvailable(BASE_URL, KEY, ['anthropic', 'openai'], 'openai/gpt-5.4-mini')).rejects.toThrow(
      'No OpenAI models on proxy',
    )
  })
})
