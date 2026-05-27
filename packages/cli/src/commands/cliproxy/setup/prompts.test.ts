/// <reference types="bun" />

import {describe, expect, it} from 'bun:test'

import {buildApiKeyValue, ensureRepoFormat, ensureSecretName} from './prompts'

describe('ensureRepoFormat', () => {
  it('happy path: returns owner/repo unchanged', () => {
    expect(ensureRepoFormat('owner/repo')).toBe('owner/repo')
  })

  it('error path: throws on whitespace in value', () => {
    expect(() => ensureRepoFormat('owner repo')).toThrow()
  })

  it('error path: throws on extra slash', () => {
    expect(() => ensureRepoFormat('owner/repo/extra')).toThrow()
  })

  it('error path: throws on empty string', () => {
    expect(() => ensureRepoFormat('')).toThrow()
  })
})

describe('ensureSecretName', () => {
  it('happy path: returns VALID_NAME unchanged', () => {
    expect(ensureSecretName('VALID_NAME', 'secret')).toBe('VALID_NAME')
  })

  it('error path: throws on lowercase name', () => {
    expect(() => ensureSecretName('lower_case', 'secret')).toThrow()
  })

  it('error path: throws on name with hyphens', () => {
    expect(() => ensureSecretName('with-dash', 'secret')).toThrow()
  })

  it('error path: throws when name starts with a digit', () => {
    expect(() => ensureSecretName('123_START_DIGIT', 'secret')).toThrow()
  })
})

describe('buildApiKeyValue', () => {
  it('happy path: slugifies key name and appends uuid suffix', () => {
    const result = buildApiKeyValue('my repo ci!')
    expect(result).toMatch(/^sk-my-repo-ci-[a-f0-9]+$/)
  })

  it('edge case: empty string falls back to cliproxy slug', () => {
    const result = buildApiKeyValue('')
    expect(result).toMatch(/^sk-cliproxy-[a-f0-9]+$/)
  })

  it('edge case: uppercased input is lowercased in slug', () => {
    const result = buildApiKeyValue('UPPERCASE')
    expect(result).toMatch(/^sk-uppercase-[a-f0-9]+$/)
  })
})
