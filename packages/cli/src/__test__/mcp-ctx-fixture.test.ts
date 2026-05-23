import {describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude} from './mcp-ctx-fixture'

describe('createCapturedCtx', () => {
  describe('ctx.console.log', () => {
    it('populates captured.stdout with a single string arg', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.console.log('hello')
      expect(captured.stdout).toEqual(['hello'])
    })

    it('space-joins multiple args matching console.log behavior', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.console.log('foo', 'bar', 42)
      expect(captured.stdout).toEqual(['foo bar 42'])
    })
  })

  describe('ctx.process.stdout.write', () => {
    it('pushes a string chunk to captured.stdout', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.process.stdout.write('chunk')
      expect(captured.stdout).toEqual(['chunk'])
    })

    it('decodes a Uint8Array chunk as utf-8 and pushes to captured.stdout', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.process.stdout.write(new TextEncoder().encode('buf'))
      expect(captured.stdout).toEqual(['buf'])
    })
  })

  describe('ctx.process.stderr.write', () => {
    it('pushes a string chunk to captured.stderr', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.process.stderr.write('err-chunk')
      expect(captured.stderr).toEqual(['err-chunk'])
    })
  })

  describe('ctx.console.error', () => {
    it('pushes formatted string to captured.stderr', () => {
      const {ctx, captured} = createCapturedCtx()
      ctx.console.error('oops', 99)
      expect(captured.stderr).toEqual(['oops 99'])
    })
  })

  describe('ctx.process.exit', () => {
    it('throws after populating captured.exit with code 1', () => {
      const {ctx, captured} = createCapturedCtx()
      let threw = false
      try {
        ctx.process.exit(1)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(captured.exit).toEqual({code: 1})
    })

    it('also throws for exit code 0', () => {
      const {ctx, captured} = createCapturedCtx()
      let threw = false
      try {
        ctx.process.exit(0)
      } catch {
        threw = true
      }
      expect(threw).toBe(true)
      expect(captured.exit).toEqual({code: 0})
    })
  })

  it('starts with empty stdout, stderr, and null exit', () => {
    const {captured} = createCapturedCtx()
    expect(captured.stdout).toEqual([])
    expect(captured.stderr).toEqual([])
    expect(captured.exit).toBeNull()
  })
})

describe('expectCapturedToInclude', () => {
  it('returns true when stdout contains the string marker', () => {
    const {ctx, captured} = createCapturedCtx()
    ctx.console.log('hello world')
    expect(expectCapturedToInclude(captured, 'hello')).toBe(true)
  })

  it('returns false when stdout does not contain the string marker', () => {
    const {ctx, captured} = createCapturedCtx()
    ctx.console.log('goodbye')
    expect(expectCapturedToInclude(captured, 'hello')).toBe(false)
  })

  it('returns true when stdout matches a regex marker', () => {
    const {ctx, captured} = createCapturedCtx()
    ctx.console.log('hello world')
    expect(expectCapturedToInclude(captured, /^hello/)).toBe(true)
  })

  it('returns false when stdout does not match a regex marker', () => {
    const {ctx, captured} = createCapturedCtx()
    ctx.console.log('hello world')
    expect(expectCapturedToInclude(captured, /^world/)).toBe(false)
  })
})
