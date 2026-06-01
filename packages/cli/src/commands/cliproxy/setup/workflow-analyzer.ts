import type {CommandResult} from './gh'

import {runGh} from './gh'

// ─── Types ────────────────────────────────────────────────────────────────────

export type FroBotWorkflowCheck =
  | {kind: 'missing'}
  | {kind: 'unreachable'; reason: string}
  | {kind: 'no-agent-step'}
  | {
      kind: 'analyzed'
      stepsWithGaps: readonly {stepOrdinal: number; missingInputs: readonly string[]}[]
    }

// ─── Constants ────────────────────────────────────────────────────────────────

// github-token and prompt are intentionally excluded from this check:
// github-token is harness-agnostic (PAT wiring, not secret-routing) and prompt is
// workflow-defined (the user's prompt body, not a harness default).
//
// NOTE: `enable-omo: true` is NOT a required input.
// For proxy-routed providers configured via OPENCODE_CONFIG.provider.<name>.options.baseURL,
// the fro-bot/agent action honors auth.json directly (regardless of oMo state).
// Source: fro-bot/agent@v0.44.3+ action.yaml lines 99-104; verified by librarian 2026-05-25.
const REQUIRED_OPENCODE_INPUTS = ['auth-json', 'opencode-config', 'model'] as const
type RequiredOpencodeInput = (typeof REQUIRED_OPENCODE_INPUTS)[number]

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Slice the workflow content into one entry per `fro-bot/agent` step. Handles
 * both the `- name:\n  uses: ...` and `- uses: ...` step shapes. Returns an
 * empty array if no fro-bot/agent step is present.
 *
 * Step-scoped slicing prevents false-passes where a same-named input key in a
 * sibling step (strategy.matrix, custom actions, reusable workflow with:
 * blocks) could mask a genuine gap in fro-bot/agent's wiring.
 */
export function findFroBotAgentStepBodies(content: string): {stepOrdinal: number; body: string}[] {
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

// ─── Exports ──────────────────────────────────────────────────────────────────

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

export async function checkFroBotWorkflow(repo: string): Promise<FroBotWorkflowCheck> {
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
  const inputMap = {
    'auth-json': 'auth-json: ${{ secrets.OPENCODE_AUTH_JSON }}',
    'opencode-config': 'opencode-config: ${{ secrets.OPENCODE_CONFIG }}',
    model: 'model: ${{ vars.FRO_BOT_MODEL }}',
  } satisfies Record<RequiredOpencodeInput, string>
  /* eslint-enable no-template-curly-in-string */
  return missingInputs.map(input => `          ${(inputMap as Record<string, string>)[input]}`).join('\n')
}
