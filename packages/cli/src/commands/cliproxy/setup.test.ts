/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'
import {goke} from 'goke'

import {
  getHarnessTemplate,
  registerCliproxySetup,
  validateSetupOptions,
  type SecretAssignment,
  type VariableAssignment,
} from './setup'

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
