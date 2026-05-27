/// <reference types="bun" />

import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test'

import {isGhRateLimitError, withGhRetry} from './gh'

// ─── isGhRateLimitError ──────────────────────────────────────────────────────

describe('isGhRateLimitError', () => {
  it('returns true when text contains "rate limit"', () => {
    expect(isGhRateLimitError('API rate limit exceeded')).toBe(true)
  })

  it('is case-insensitive', () => {
    expect(isGhRateLimitError('You have exceeded a secondary RATE LIMIT')).toBe(true)
  })

  it('returns false for unrelated error messages', () => {
    expect(isGhRateLimitError('Not Found (HTTP 404)')).toBe(false)
  })

  it('returns false for an empty string', () => {
    expect(isGhRateLimitError('')).toBe(false)
  })

  it('returns false for a connection timeout', () => {
    expect(isGhRateLimitError('connection timeout')).toBe(false)
  })
})

// ─── withGhRetry ─────────────────────────────────────────────────────────────

describe('withGhRetry', () => {
  it('returns the value when fn succeeds immediately', async () => {
    const result = await withGhRetry('test label', async () => 'ok', false)

    expect(result).toBe('ok')
  })

  it('re-throws non-rate-limit errors without querying the reset time', async () => {
    const queryReset = async (): Promise<string> => {
      throw new Error('queryReset should not have been called')
    }
    const err = new Error('some other error')

    await expect(withGhRetry('test label', async () => Promise.reject(err), false, queryReset)).rejects.toThrow(
      'some other error',
    )
  })

  it('re-throws with reset time appended in non-interactive mode on rate limit', async () => {
    const queryReset = async (): Promise<string> => '2:30 PM'

    await expect(
      withGhRetry(
        'test label',
        async () => {
          throw new Error('API rate limit exceeded for url')
        },
        false,
        queryReset,
      ),
    ).rejects.toThrow('resets at 2:30 PM')
  })
})

// ─── applyGhValue stdin-pipe-not-body invariant (PR #102) ────────────────────

describe('applyGhValue', () => {
  afterEach(() => {
    mock.restore()
  })

  it('pipes secret value via stdin — never uses --body flag', async () => {
    const {applyGhValue} = await import('./gh')

    let capturedArgs: string[] = []
    let capturedStdin: ReadableStream<Uint8Array> | undefined

    const spawnSpy = spyOn(Bun, 'spawn').mockImplementation(((cmds: string[], opts?: {stdin?: unknown}) => {
      capturedArgs = cmds
      capturedStdin = opts?.stdin as ReadableStream<Uint8Array> | undefined
      // Return a minimal fake child process
      return {
        stdout: new Response('').body,
        stderr: new Response('').body,
        exited: Promise.resolve(0),
        stdin: null,
        pid: 0,
        killed: false,
        exitCode: 0,
        signalCode: null,
        kill: () => {},
        ref: () => {},
        unref: () => {},
        readable: new Response('').body,
      }
    }) as unknown as typeof Bun.spawn)

    await applyGhValue('secret', 'MY_SECRET', 'owner/repo', 'my-value')

    expect(capturedArgs).toContain('gh')
    expect(capturedArgs).toContain('secret')
    expect(capturedArgs).toContain('set')
    expect(capturedArgs).toContain('MY_SECRET')
    expect(capturedArgs).toContain('--repo')
    expect(capturedArgs).toContain('owner/repo')
    // The critical invariant: --body must NOT be in the args
    expect(capturedArgs).not.toContain('--body')
    // stdin must be provided (value piped via stdin)
    expect(capturedStdin).toBeDefined()

    spawnSpy.mockRestore()
  })
})
