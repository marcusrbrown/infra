/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {
  analyzeFroBotWorkflow,
  formatWorkflowSnippet,
  getHarnessTemplate,
  interpretGhContentResult,
  registerCliproxySetup,
  validateSetupOptions,
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
  })
})
