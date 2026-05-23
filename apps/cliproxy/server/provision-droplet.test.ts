import {describe, expect, it} from 'bun:test'

import {validateCliproxyDomain} from './provision-droplet'

// ---------------------------------------------------------------------------
// validateCliproxyDomain
// ---------------------------------------------------------------------------

describe('validateCliproxyDomain', () => {
  it('accepts a valid domain', () => {
    expect(validateCliproxyDomain('cliproxy.fro.bot')).toBe('cliproxy.fro.bot')
  })

  it('accepts a plain hostname', () => {
    expect(validateCliproxyDomain('example.com')).toBe('example.com')
  })

  it('throws on a value containing a newline (heredoc termination)', () => {
    expect(() => validateCliproxyDomain('cliproxy.fro.bot\nENVFILE\nevil')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a dollar sign (variable expansion)', () => {
    expect(() => validateCliproxyDomain('host$PATH')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a backtick (command substitution)', () => {
    expect(() => validateCliproxyDomain('host`id`')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a pipe (command chaining)', () => {
    expect(() => validateCliproxyDomain('host|cat /etc/passwd')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a semicolon (command separator)', () => {
    expect(() => validateCliproxyDomain('host;rm -rf /')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing an ampersand (background execution)', () => {
    expect(() => validateCliproxyDomain('host&evil')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a single quote', () => {
    expect(() => validateCliproxyDomain("host'evil")).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a double quote', () => {
    expect(() => validateCliproxyDomain('host"evil')).toThrow(/disallowed characters/)
  })

  it('throws on a value containing a backslash', () => {
    expect(() => validateCliproxyDomain(String.raw`host\evil`)).toThrow(/disallowed characters/)
  })
})
