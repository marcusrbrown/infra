// Per-consumer request budget and concurrency caps, plus a global concurrency cap. A fixed window per consumer, as in
// the broker's limiter, with three additions: idle windows are evicted, a held slot counts against both caps until it
// is released, and a refusal says which limit it hit so the caller can be told when to retry.

import {CONCURRENCY_RETRY_AFTER_S} from './constants'

export interface LimitsOptions {
  clock: () => number
  requestsPerWindow: number
  windowMs: number
  perConsumerConcurrency: number
  globalConcurrency: number
}

export type AcquireResult =
  | {ok: true; release: () => void}
  | {ok: false; reason: 'rate' | 'consumer-concurrency' | 'global-concurrency'; retryAfterSeconds: number}

export interface Limits {
  acquire: (consumer: string) => AcquireResult
  stats: () => {tracked: number; active: number}
}

interface Window {
  count: number
  resetAt: number
  active: number
}

export function createLimits(options: LimitsOptions): Limits {
  const {clock, requestsPerWindow, windowMs, perConsumerConcurrency, globalConcurrency} = options
  const windows = new Map<string, Window>()
  let active = 0
  let nextSweepAt = clock() + windowMs

  /** Drop every window that has ended and holds no slot. */
  function sweep(now: number): void {
    if (now < nextSweepAt) return
    nextSweepAt = now + windowMs
    for (const [consumer, window] of windows) {
      if (window.active === 0 && now >= window.resetAt) windows.delete(consumer)
    }
  }

  return {
    acquire(consumer) {
      const now = clock()
      sweep(now)

      let window = windows.get(consumer)
      if (!window) {
        window = {count: 0, resetAt: now + windowMs, active: 0}
        windows.set(consumer, window)
      } else if (now >= window.resetAt) {
        window.count = 0
        window.resetAt = now + windowMs
      }

      if (active >= globalConcurrency) {
        return {ok: false, reason: 'global-concurrency', retryAfterSeconds: CONCURRENCY_RETRY_AFTER_S}
      }
      if (window.active >= perConsumerConcurrency) {
        return {ok: false, reason: 'consumer-concurrency', retryAfterSeconds: CONCURRENCY_RETRY_AFTER_S}
      }
      if (window.count >= requestsPerWindow) {
        return {ok: false, reason: 'rate', retryAfterSeconds: Math.max(1, Math.ceil((window.resetAt - now) / 1000))}
      }

      window.count += 1
      window.active += 1
      active += 1
      let released = false
      const held = window
      return {
        ok: true,
        release: () => {
          if (released) return
          released = true
          held.active -= 1
          active -= 1
        },
      }
    },
    stats: () => ({tracked: windows.size, active}),
  }
}
