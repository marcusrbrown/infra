/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {
  analyzeFroBotWorkflow,
  getHarnessTemplate,
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
    it('returns no missing inputs when all four are wired', () => {
      const result = analyzeFroBotWorkflow(COMPLETE_WORKFLOW)

      expect(result.exists).toBe(true)
      expect(result.missingInputs).toEqual([])
    })

    it('detects a missing opencode-config input', () => {
      const result = analyzeFroBotWorkflow(MISSING_OPENCODE_CONFIG_WORKFLOW)

      expect(result.exists).toBe(true)
      expect(result.missingInputs).toEqual(['opencode-config'])
    })

    it('returns all four inputs as missing for empty content', () => {
      const result = analyzeFroBotWorkflow('')

      expect(result.exists).toBe(true)
      expect(result.missingInputs).toEqual(['auth-json', 'opencode-config', 'omo-providers', 'model'])
    })

    it('ignores inputs that appear only in unrelated positions (e.g. comments or text)', () => {
      const content = `This doc mentions opencode-config but the fro-bot/agent step is missing it.`

      const result = analyzeFroBotWorkflow(content)

      expect(result.missingInputs).toContain('opencode-config')
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
