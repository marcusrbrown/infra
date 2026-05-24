import {format} from 'node:util'

export type {ActionCtx} from '../lib/action-ctx'

/**
 * Captured output from a `createCapturedCtx()` invocation.
 */
export interface CapturedOutput {
  stdout: string[]
  stderr: string[]
  exit: {code: number} | null
}

/**
 * Error thrown by `ctx.process.exit()` in the mock context.
 * Mirrors the `GokeProcessExit` pattern from goke — exit always throws
 * so action code cannot silently swallow it.
 */
export class MockProcessExit extends Error {
  readonly code: number

  constructor(code: number) {
    super(`MockProcessExit: process.exit(${code})`)
    this.name = 'MockProcessExit'
    this.code = code
  }
}

/**
 * Minimal surface of `GokeExecutionContext` that the capture fixture provides.
 * Matches `ctx.console.{log,error}`, `ctx.process.{stdout,stderr}.write`,
 * and `ctx.process.exit` — the same shape produced by
 * `createCallToolExecutionContext` in `@goke/mcp`.
 */
export interface CapturedCtx {
  console: {
    log: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  process: {
    stdout: {write: (chunk: string | Uint8Array) => void}
    stderr: {write: (chunk: string | Uint8Array) => void}
    exit: (code: number) => never
  }
}

function decodeChunk(chunk: string | Uint8Array): string {
  if (typeof chunk === 'string') return chunk
  return new TextDecoder().decode(chunk)
}

/**
 * Create a fresh mock `GokeExecutionContext` with output capture.
 *
 * Each call returns an independent `{ctx, captured}` pair — no shared state.
 * Use one call per test to keep tests isolated.
 */
export function createCapturedCtx(): {ctx: CapturedCtx; captured: CapturedOutput} {
  const captured: CapturedOutput = {
    stdout: [],
    stderr: [],
    exit: null,
  }

  const ctx: CapturedCtx = {
    console: {
      log(...args: unknown[]) {
        captured.stdout.push(format(...args))
      },
      error(...args: unknown[]) {
        captured.stderr.push(format(...args))
      },
    },
    process: {
      stdout: {
        write(chunk: string | Uint8Array) {
          captured.stdout.push(decodeChunk(chunk))
        },
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          captured.stderr.push(decodeChunk(chunk))
        },
      },
      exit(code: number): never {
        captured.exit = {code}
        throw new MockProcessExit(code)
      },
    },
  }

  return {ctx, captured}
}

/**
 * Returns `true` when the concatenated stdout contains `marker`.
 *
 * Composable — does not throw. Use with `expect(...).toBe(true)`.
 */
export function expectCapturedToInclude(captured: CapturedOutput, marker: string | RegExp): boolean {
  const text = captured.stdout.join('')
  if (typeof marker === 'string') return text.includes(marker)
  return marker.test(text)
}
