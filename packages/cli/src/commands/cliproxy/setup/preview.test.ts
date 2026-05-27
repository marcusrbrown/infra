/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'

import {formatDryRunPreview} from './preview'
import {getHarnessTemplate} from './templates'

const KEY = 'sk-placeholder'
const BASE_URL = 'https://cliproxy.fro.bot'

describe('formatDryRunPreview', () => {
  it('renders the dry-run header with repo and providers', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Dry run: cliproxy setup --harness opencode')
    expect(preview).toContain('Repository: owner/repo')
    expect(preview).toContain('Providers: anthropic')
  })

  it('renders planned secrets with byte sizes', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Planned secrets:')
    expect(preview).toContain('OPENCODE_AUTH_JSON')
    expect(preview).toContain('OPENCODE_CONFIG')
    expect(preview).toContain('OMO_PROVIDERS')
  })

  it('renders planned variables', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Planned variables:')
    expect(preview).toContain('FRO_BOT_MODEL')
  })

  it('renders proxy key as <proxy-key> placeholder, NOT the actual key value', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('<proxy-key>')
    expect(preview).not.toContain(KEY)
  })

  it('renders "No mutations will be performed." footer', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('No mutations will be performed.')
  })

  it('dual-provider preview lists both providers', () => {
    const template = getHarnessTemplate('opencode', {
      keyValue: KEY,
      baseUrl: BASE_URL,
      providers: ['anthropic', 'openai'],
      model: 'openai/gpt-5.4-mini',
    })
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic', 'openai'],
      model: 'openai/gpt-5.4-mini',
      template,
    })

    expect(preview).toContain('anthropic')
    expect(preview).toContain('openai')
    expect(preview).not.toContain(KEY)
  })

  it('secret values in preview do NOT contain the actual key value', () => {
    // Even if the template has the key embedded in JSON, the preview must redact it
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    // The actual key must not appear anywhere in the preview output
    expect(preview).not.toContain(KEY)
  })

  // ── byte-count contract tests (plan Unit 8 scenarios) ────────────────────

  it('anthropic-only: OPENCODE_AUTH_JSON is 51 bytes with sk-placeholder key', () => {
    const template = getHarnessTemplate('opencode', {
      keyValue: KEY,
      baseUrl: BASE_URL,
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
    })
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Providers: anthropic')
    expect(preview).toContain('OPENCODE_AUTH_JSON (51 bytes)')
    expect(preview).toContain('<proxy-key>')
  })

  it('dual-provider: OPENCODE_AUTH_JSON is 98 bytes with sk-placeholder key', () => {
    const template = getHarnessTemplate('opencode', {
      keyValue: KEY,
      baseUrl: BASE_URL,
      providers: ['anthropic', 'openai'],
      model: 'anthropic/claude-sonnet-4-6',
    })
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic', 'openai'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Providers: anthropic, openai')
    expect(preview).toContain('OPENCODE_AUTH_JSON (98 bytes)')
  })
})
