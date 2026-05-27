/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'

import {
  analyzeFroBotWorkflow,
  findFroBotAgentStepBodies,
  formatWorkflowSnippet,
  interpretGhContentResult,
} from './workflow-analyzer'

// ─── Fixtures ─────────────────────────────────────────────────────────────────

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

// openai model prefix regression fixtures
const WORKFLOW_WITH_OPENAI_MODEL = `      - uses: fro-bot/agent@abc123
        with:
          github-token: \${{ secrets.FRO_BOT_PAT }}
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          model: openai/gpt-5.4-mini
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
          opencode-config: \${{ secrets.OPENCODE_CONFIG }}
          prompt: \${{ env.PROMPT }}
`

// Dual-provider hints: omo-providers value contains "openai", model is openai/...
const WORKFLOW_WITH_DUAL_PROVIDER_HINTS = `name: fro-bot
on: [pull_request]
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Run Fro Bot
        uses: fro-bot/agent@abc123
        with:
          github-token: \${{ secrets.FRO_BOT_PAT }}
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          model: openai/gpt-5.4-mini
          omo-providers: anthropic,openai
          opencode-config: \${{ secrets.OPENCODE_CONFIG }}
          prompt: \${{ env.PROMPT }}
`

// Missing opencode-config but with openai model prefix — gap detection must still fire
const MISSING_OPENCODE_CONFIG_OPENAI_MODEL_WORKFLOW = `      - uses: fro-bot/agent@abc123
        with:
          auth-json: \${{ secrets.OPENCODE_AUTH_JSON }}
          github-token: \${{ secrets.FRO_BOT_PAT }}
          model: openai/gpt-5.4-mini
          omo-providers: \${{ secrets.OMO_PROVIDERS }}
          prompt: \${{ env.PROMPT }}
`

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('cliproxy setup helpers', () => {
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

  describe('analyzer regression for openai model prefix', () => {
    it('returns empty stepsWithGaps for a workflow with openai/... model and all four inputs', () => {
      const result = analyzeFroBotWorkflow(WORKFLOW_WITH_OPENAI_MODEL)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toEqual([])
    })

    it('returns empty stepsWithGaps for a dual-provider workflow with openai/... model', () => {
      const result = analyzeFroBotWorkflow(WORKFLOW_WITH_DUAL_PROVIDER_HINTS)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toEqual([])
    })

    it('detects missing opencode-config even when model is openai/...', () => {
      const result = analyzeFroBotWorkflow(MISSING_OPENCODE_CONFIG_OPENAI_MODEL_WORKFLOW)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toHaveLength(1)
      expect(result.stepsWithGaps[0]?.stepOrdinal).toBe(1)
      expect([...(result.stepsWithGaps[0]?.missingInputs ?? [])]).toEqual(['opencode-config'])
    })

    it('detects missing opencode-config when model is anthropic/... (sanity regression)', () => {
      const result = analyzeFroBotWorkflow(MISSING_OPENCODE_CONFIG_WORKFLOW)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      expect(result.stepsWithGaps).toHaveLength(1)
      expect(result.stepsWithGaps[0]?.stepOrdinal).toBe(1)
      expect([...(result.stepsWithGaps[0]?.missingInputs ?? [])]).toEqual(['opencode-config'])
    })

    it('does not emit any enable-omo warning for openai model workflows', () => {
      const openaiResult = analyzeFroBotWorkflow(WORKFLOW_WITH_OPENAI_MODEL)
      const dualResult = analyzeFroBotWorkflow(WORKFLOW_WITH_DUAL_PROVIDER_HINTS)

      // The analyzer result shape has no warning category — only stepsWithGaps.
      // Verify the result object has exactly the expected keys (kind + stepsWithGaps).
      expect(Object.keys(openaiResult)).toEqual(['kind', 'stepsWithGaps'])
      expect(Object.keys(dualResult)).toEqual(['kind', 'stepsWithGaps'])
    })

    it('REQUIRED_OPENCODE_INPUTS covers exactly auth-json, opencode-config, omo-providers, model (no enable-omo)', () => {
      // Infer the required inputs from fixture-based testing: a workflow with exactly
      // these four inputs and no others (besides github-token and prompt) passes with zero gaps.
      const result = analyzeFroBotWorkflow(WORKFLOW_WITH_OPENAI_MODEL)

      expect(result.kind).toBe('analyzed')
      if (result.kind !== 'analyzed') throw new Error('unreachable')
      // Zero gaps confirms the four inputs in the fixture are sufficient — enable-omo is NOT required.
      expect(result.stepsWithGaps).toEqual([])
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
})

describe('findFroBotAgentStepBodies', () => {
  it('returns empty array for content with no fro-bot/agent step', () => {
    const bodies = findFroBotAgentStepBodies(WORKFLOW_WITHOUT_FRO_BOT_AGENT)

    expect(bodies).toEqual([])
  })

  it('returns empty array for empty content', () => {
    const bodies = findFroBotAgentStepBodies('')

    expect(bodies).toEqual([])
  })

  it('returns one entry for a single fro-bot/agent step', () => {
    const bodies = findFroBotAgentStepBodies(COMPLETE_WORKFLOW)

    expect(bodies).toHaveLength(1)
    expect(bodies[0]?.stepOrdinal).toBe(1)
    expect(bodies[0]?.body).toContain('fro-bot/agent@')
  })

  it('returns two entries for a workflow with two fro-bot/agent steps', () => {
    const bodies = findFroBotAgentStepBodies(TWO_AGENT_STEPS_SECOND_BROKEN)

    expect(bodies).toHaveLength(2)
    expect(bodies[0]?.stepOrdinal).toBe(1)
    expect(bodies[1]?.stepOrdinal).toBe(2)
  })

  it('scopes each body to only its own step — sibling step with: block is excluded', () => {
    const bodies = findFroBotAgentStepBodies(SIBLING_STEP_SHADOWS_MODEL_INPUT)

    // Only one fro-bot/agent step in this fixture
    expect(bodies).toHaveLength(1)
    // The sibling step's `model:` key must NOT appear in the fro-bot/agent step body
    expect(bodies[0]?.body).not.toContain('matrix.model')
  })
})
