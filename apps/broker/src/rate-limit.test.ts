/**
 * Tests for the token-bucket rate limiter.
 *
 * All tests use an injectable clock — no real timers, no Date.now().
 */

import {describe, expect, test} from 'bun:test'
import {createRateLimiter} from './rate-limit'

// ---------------------------------------------------------------------------
// Per-repo bucket
// ---------------------------------------------------------------------------

describe('rate limiter — per-repo bucket', () => {
  test('allows up to perRepoLimit requests per window', () => {
    const now = 0
    const limiter = createRateLimiter({perRepoLimit: 3, globalLimit: 100, windowMs: 60_000, clock: () => now})

    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(true)
    // 4th request exceeds per-repo limit
    const result = limiter.check('repo-1')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/per-repository rate limit exceeded/)
  })

  test('per-repo buckets are independent', () => {
    const now = 0
    const limiter = createRateLimiter({perRepoLimit: 2, globalLimit: 100, windowMs: 60_000, clock: () => now})

    expect(limiter.check('repo-a').allowed).toBe(true)
    expect(limiter.check('repo-a').allowed).toBe(true)
    // repo-a exhausted
    expect(limiter.check('repo-a').allowed).toBe(false)
    // repo-b still has capacity
    expect(limiter.check('repo-b').allowed).toBe(true)
    expect(limiter.check('repo-b').allowed).toBe(true)
    expect(limiter.check('repo-b').allowed).toBe(false)
  })

  test('per-repo bucket resets after window expires', () => {
    let now = 0
    const windowMs = 60_000
    const limiter = createRateLimiter({perRepoLimit: 2, globalLimit: 100, windowMs, clock: () => now})

    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(false)

    // Advance past the window
    now = windowMs + 1
    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Global bucket
// ---------------------------------------------------------------------------

describe('rate limiter — global bucket', () => {
  test('allows up to globalLimit requests across all repos', () => {
    const now = 0
    const limiter = createRateLimiter({perRepoLimit: 100, globalLimit: 3, windowMs: 60_000, clock: () => now})

    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-2').allowed).toBe(true)
    expect(limiter.check('repo-3').allowed).toBe(true)
    // 4th request exceeds global limit
    const result = limiter.check('repo-4')
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/global rate limit exceeded/)
  })

  test('global bucket resets after window expires', () => {
    let now = 0
    const windowMs = 60_000
    const limiter = createRateLimiter({perRepoLimit: 100, globalLimit: 2, windowMs, clock: () => now})

    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-2').allowed).toBe(true)
    expect(limiter.check('repo-3').allowed).toBe(false)

    // Advance past the window
    now = windowMs + 1
    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-2').allowed).toBe(true)
    expect(limiter.check('repo-3').allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Default limits
// ---------------------------------------------------------------------------

describe('rate limiter — default limits', () => {
  test('default perRepoLimit is 10', () => {
    const now = 0
    const limiter = createRateLimiter({globalLimit: 1000, clock: () => now})

    for (let i = 0; i < 10; i++) {
      expect(limiter.check('repo-1').allowed).toBe(true)
    }
    expect(limiter.check('repo-1').allowed).toBe(false)
  })

  test('default globalLimit is 50', () => {
    const now = 0
    const limiter = createRateLimiter({perRepoLimit: 1000, clock: () => now})

    for (let i = 0; i < 50; i++) {
      expect(limiter.check(`repo-${i}`).allowed).toBe(true)
    }
    expect(limiter.check('repo-overflow').allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Window boundary
// ---------------------------------------------------------------------------

describe('rate limiter — window boundary', () => {
  test('request exactly at window boundary resets the bucket', () => {
    let now = 0
    const windowMs = 60_000
    const limiter = createRateLimiter({perRepoLimit: 1, globalLimit: 100, windowMs, clock: () => now})

    expect(limiter.check('repo-1').allowed).toBe(true)
    expect(limiter.check('repo-1').allowed).toBe(false)

    // Exactly at the boundary
    now = windowMs
    expect(limiter.check('repo-1').allowed).toBe(true)
  })
})
