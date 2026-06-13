import {readFileSync, statSync} from 'node:fs'
import {describe, expect, it} from 'bun:test'

import {buildIdentityArgs, materializeIdentityFile} from './ssh-identity'

// ─── materializeIdentityFile ──────────────────────────────────────────────────

describe('materializeIdentityFile', () => {
  it('writes the key to a temp file and returns a path', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {path, cleanup} = materializeIdentityFile(key)

    try {
      expect(path).toBeTruthy()
      const stat = statSync(path)
      expect(stat.isFile()).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('writes the file with mode 0600', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {path, cleanup} = materializeIdentityFile(key)

    try {
      const stat = statSync(path)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      cleanup()
    }
  })

  it('ensures the key file ends with a newline', () => {
    const keyWithoutNewline = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----'
    const {path, cleanup} = materializeIdentityFile(keyWithoutNewline)

    try {
      const text = readFileSync(path, 'utf8')
      expect(text.endsWith('\n')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('does not double-add a newline when key already ends with one', () => {
    const keyWithNewline = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {path, cleanup} = materializeIdentityFile(keyWithNewline)

    try {
      const text = readFileSync(path, 'utf8')
      expect(text.endsWith('\n\n')).toBe(false)
      expect(text.endsWith('\n')).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('cleanup removes the temp file and directory', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {path, cleanup} = materializeIdentityFile(key)
    const dir = path.slice(0, path.lastIndexOf('/'))

    cleanup()

    // Both the key file and its containing temp dir must be gone.
    expect(() => statSync(path)).toThrow()
    expect(() => statSync(dir)).toThrow()
  })

  it('cleanup is idempotent (calling twice does not throw)', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {cleanup} = materializeIdentityFile(key)

    cleanup()
    expect(() => cleanup()).not.toThrow()
  })
})

// ─── buildIdentityArgs ────────────────────────────────────────────────────────

describe('buildIdentityArgs', () => {
  it('returns [-i, <path>, -o, IdentitiesOnly=yes] when a key is provided', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {args, cleanup} = buildIdentityArgs(key)

    try {
      expect(args).toHaveLength(4)
      expect(args[0]).toBe('-i')
      expect(args[1]).toBeTruthy() // path to temp file
      expect(args[2]).toBe('-o')
      expect(args[3]).toBe('IdentitiesOnly=yes')
    } finally {
      cleanup()
    }
  })

  it('returns empty args and a no-op cleanup when key is empty string', () => {
    const {args, cleanup} = buildIdentityArgs('')

    expect(args).toHaveLength(0)
    expect(() => cleanup()).not.toThrow()
  })

  it('returns empty args and a no-op cleanup when key is whitespace-only', () => {
    const {args, cleanup} = buildIdentityArgs('   \n  ')

    expect(args).toHaveLength(0)
    expect(() => cleanup()).not.toThrow()
  })

  it('returns empty args and a no-op cleanup when key is undefined', () => {
    const {args, cleanup} = buildIdentityArgs(undefined)

    expect(args).toHaveLength(0)
    expect(() => cleanup()).not.toThrow()
  })

  it('the -i path points to a real 0600 file', () => {
    const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nfakekey\n-----END OPENSSH PRIVATE KEY-----\n'
    const {args, cleanup} = buildIdentityArgs(key)

    try {
      const keyPath = args[1]
      expect(keyPath).toBeTruthy()
      const stat = statSync(keyPath as string)
      const mode = stat.mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      cleanup()
    }
  })
})
