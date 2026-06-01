/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'

import {
  collectCollisions,
  formatTemplateSummary,
  getHarnessTemplate,
  harnessSchema,
  stripTrailingSlash,
  type HarnessTemplate,
  type SecretAssignment,
  type VariableAssignment,
} from './templates'

// ── stripTrailingSlash (new unit tests — RED first) ──────────────────────────

describe('stripTrailingSlash', () => {
  it('removes a trailing slash', () => {
    expect(stripTrailingSlash('https://example.com/')).toBe('https://example.com')
  })

  it('is a no-op when there is no trailing slash', () => {
    expect(stripTrailingSlash('https://example.com')).toBe('https://example.com')
  })

  it('returns empty string for empty input', () => {
    expect(stripTrailingSlash('')).toBe('')
  })

  it('removes only one trailing slash', () => {
    expect(stripTrailingSlash('https://example.com//')).toBe('https://example.com/')
  })
})

// ── harnessSchema (new unit test) ────────────────────────────────────────────

describe('harnessSchema', () => {
  it('parses valid harness values', () => {
    expect(harnessSchema.parse('opencode')).toBe('opencode')
    expect(harnessSchema.parse('claude-code')).toBe('claude-code')
    expect(harnessSchema.parse('generic')).toBe('generic')
  })

  it('throws on invalid harness value', () => {
    expect(() => harnessSchema.parse('unknown')).toThrow()
  })
})

// ── collectCollisions (new unit tests — RED first) ───────────────────────────

describe('collectCollisions', () => {
  const template: HarnessTemplate = {
    secrets: [
      {name: 'OPENCODE_AUTH_JSON', value: 'x'},
      {name: 'OPENCODE_CONFIG', value: 'y'},
    ],
    variables: [{name: 'FRO_BOT_MODEL', value: 'z'}],
  }

  it('returns empty array when no collisions', () => {
    expect(collectCollisions(template, [], [])).toEqual([])
  })

  it('detects a colliding secret', () => {
    const result = collectCollisions(template, ['OPENCODE_AUTH_JSON'], [])
    expect(result).toContain('secret OPENCODE_AUTH_JSON')
  })

  it('detects a colliding variable', () => {
    const result = collectCollisions(template, [], ['FRO_BOT_MODEL'])
    expect(result).toContain('variable FRO_BOT_MODEL')
  })

  it('detects multiple collisions', () => {
    const result = collectCollisions(template, ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG'], ['FRO_BOT_MODEL'])
    expect(result).toHaveLength(3)
    expect(result).toContain('secret OPENCODE_AUTH_JSON')
    expect(result).toContain('secret OPENCODE_CONFIG')
    expect(result).toContain('variable FRO_BOT_MODEL')
  })

  it('ignores non-colliding existing names', () => {
    const result = collectCollisions(template, ['SOME_OTHER_SECRET'], ['SOME_OTHER_VAR'])
    expect(result).toEqual([])
  })
})

// ── formatTemplateSummary (new unit tests — RED first) ───────────────────────

describe('formatTemplateSummary', () => {
  it('lists secrets and variables with their prefixes', () => {
    const template: HarnessTemplate = {
      secrets: [{name: 'OPENCODE_AUTH_JSON', value: 'x'}],
      variables: [{name: 'FRO_BOT_MODEL', value: 'y'}],
    }
    const summary = formatTemplateSummary(template)
    expect(summary).toContain('secret OPENCODE_AUTH_JSON')
    expect(summary).toContain('variable FRO_BOT_MODEL')
  })

  it('returns only secret lines when no variables', () => {
    const template: HarnessTemplate = {
      secrets: [{name: 'ANTHROPIC_API_KEY', value: 'x'}],
      variables: [],
    }
    const summary = formatTemplateSummary(template)
    expect(summary).toBe('- secret ANTHROPIC_API_KEY')
  })

  it('returns empty string for empty template', () => {
    const template: HarnessTemplate = {secrets: [], variables: []}
    expect(formatTemplateSummary(template)).toBe('')
  })
})

// ── getHarnessTemplate (pure-move from setup.test.ts L162) ───────────────────

describe('getHarnessTemplate', () => {
  it('returns the expected OpenCode secret and variable names', () => {
    const template = getHarnessTemplate('opencode')

    expect(template.secrets.map((entry: SecretAssignment) => entry.name)).toEqual([
      'OPENCODE_AUTH_JSON',
      'OPENCODE_CONFIG',
    ])
    expect(template.variables.map((entry: VariableAssignment) => entry.name)).toEqual(['FRO_BOT_MODEL'])
  })

  it('uses a provider-prefixed FRO_BOT_MODEL default value', () => {
    const template = getHarnessTemplate('opencode', {keyValue: 'sk-test'})
    const modelEntry = template.variables.find((entry: VariableAssignment) => entry.name === 'FRO_BOT_MODEL')

    expect(modelEntry?.value).toMatch(/^anthropic\//)
  })

  it('does not include an OMO_PROVIDERS secret', () => {
    const template = getHarnessTemplate('opencode', {keyValue: 'sk-test'})
    const secretNames = template.secrets.map((entry: SecretAssignment) => entry.name)

    expect(secretNames).not.toContain('OMO_PROVIDERS')
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

// ── getHarnessTemplate provider-aware (pure-move from setup.test.ts L508) ────

describe('getHarnessTemplate provider-aware', () => {
  // Frozen byte-identical string for the anthropic-only regression test.
  // This is the EXACT output of getHarnessTemplate('opencode', {keyValue: 'test-key'})
  // baseline anthropic-only output. Any change to this string is a breaking regression.
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

    it('no providers/model args → OMO_PROVIDERS is not emitted', () => {
      const template = getHarnessTemplate('opencode', {keyValue: 'test-key'})
      const secretNames = template.secrets.map((e: SecretAssignment) => e.name)

      expect(secretNames).not.toContain('OMO_PROVIDERS')
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

    it("providers: ['openai'], model: 'openai/gpt-5.4-mini' → OMO_PROVIDERS is not emitted", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-openai-key',
        providers: ['openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const secretNames = template.secrets.map((e: SecretAssignment) => e.name)

      expect(secretNames).not.toContain('OMO_PROVIDERS')
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

    it("providers: ['anthropic', 'openai'] → OMO_PROVIDERS is not emitted", () => {
      const template = getHarnessTemplate('opencode', {
        keyValue: 'sk-dual',
        providers: ['anthropic', 'openai'],
        model: 'openai/gpt-5.4-mini',
      })
      const secretNames = template.secrets.map((e: SecretAssignment) => e.name)

      expect(secretNames).not.toContain('OMO_PROVIDERS')
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
