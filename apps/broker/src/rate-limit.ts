/**
 * Token-bucket rate limiter for the broker mint endpoint.
 *
 * Limits:
 *   - Per-repository: 10 mints per minute
 *   - Global: 50 mints per minute
 *
 * Sized above realistic max-parallel-CI but bounding abuse/DoS.
 *
 * The clock is injectable so tests can control time without real timers.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Rate-limit check result. */
export interface RateLimitResult {
  allowed: boolean
  reason?: string
}

/** Injectable rate limiter interface. */
export interface RateLimiter {
  check: (repositoryId: string) => RateLimitResult
}

/** Options for creating a rate limiter. */
export interface RateLimiterOptions {
  /** Max mints per repository per window. Default: 10. */
  perRepoLimit?: number
  /** Max mints globally per window. Default: 50. */
  globalLimit?: number
  /** Window duration in ms. Default: 60_000 (1 minute). */
  windowMs?: number
  /** Injectable clock returning current epoch ms. Default: Date.now. */
  clock?: () => number
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a token-bucket rate limiter with injectable clock.
 *
 * Returns a RateLimiter whose `check(repositoryId)` method:
 *   1. Resets the global bucket if the window has expired.
 *   2. Resets the per-repo bucket if the window has expired.
 *   3. Returns {allowed: false, reason} if either bucket is exhausted.
 *   4. Increments both buckets and returns {allowed: true}.
 */
export function createRateLimiter(opts: RateLimiterOptions = {}): RateLimiter {
  const {perRepoLimit = 10, globalLimit = 50, windowMs = 60_000, clock = Date.now} = opts

  const repoTokens = new Map<string, {count: number; resetAt: number}>()
  let globalCount = 0
  let globalResetAt = clock() + windowMs

  return {
    check(repositoryId: string): RateLimitResult {
      const now = clock()

      // Reset global bucket if window expired
      if (now >= globalResetAt) {
        globalCount = 0
        globalResetAt = now + windowMs
      }

      // Reset per-repo bucket if window expired
      const repoState = repoTokens.get(repositoryId)
      if (!repoState || now >= repoState.resetAt) {
        repoTokens.set(repositoryId, {count: 0, resetAt: now + windowMs})
      }

      const repo = repoTokens.get(repositoryId)
      if (!repo) {
        // Should not happen — we just set it above, but guard for type safety
        return {allowed: false, reason: 'internal rate limiter error'}
      }

      if (globalCount >= globalLimit) {
        return {allowed: false, reason: 'global rate limit exceeded'}
      }

      if (repo.count >= perRepoLimit) {
        return {allowed: false, reason: `per-repository rate limit exceeded for ${repositoryId}`}
      }

      globalCount++
      repo.count++

      return {allowed: true}
    },
  }
}
