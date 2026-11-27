import type {AcquireResult} from './limits'

import {describe, expect, test} from 'bun:test'
import {createLimits} from './limits'

function setup(options: Partial<Parameters<typeof createLimits>[0]> = {}) {
  let now = 1_000_000
  const limits = createLimits({
    clock: () => now,
    requestsPerWindow: 3,
    windowMs: 60_000,
    perConsumerConcurrency: 2,
    globalConcurrency: 3,
    ...options,
  })
  return {
    limits,
    advance: (ms: number) => {
      now += ms
    },
  }
}

function expectOk(result: AcquireResult): () => void {
  if (!result.ok) throw new Error(`expected a lease, got ${result.reason}`)
  return result.release
}

describe('request budget', () => {
  test('allows the budget, then answers rate with a Retry-After to the window end', () => {
    const {limits, advance} = setup({perConsumerConcurrency: 10, globalConcurrency: 10})
    for (let i = 0; i < 3; i += 1) expectOk(limits.acquire('alice'))()
    advance(20_000)
    const denied = limits.acquire('alice')
    expect(denied).toEqual({ok: false, reason: 'rate', retryAfterSeconds: 40})
  })

  test('one consumer over budget does not affect another', () => {
    const {limits} = setup({perConsumerConcurrency: 10, globalConcurrency: 10})
    for (let i = 0; i < 3; i += 1) expectOk(limits.acquire('alice'))()
    expect(limits.acquire('alice').ok).toBe(false)
    expect(limits.acquire('bob').ok).toBe(true)
  })

  test('the window resets after windowMs', () => {
    const {limits, advance} = setup({perConsumerConcurrency: 10, globalConcurrency: 10})
    for (let i = 0; i < 3; i += 1) expectOk(limits.acquire('alice'))()
    expect(limits.acquire('alice').ok).toBe(false)
    advance(60_000)
    expect(limits.acquire('alice').ok).toBe(true)
  })

  test('Retry-After is at least one second', () => {
    const {limits, advance} = setup({perConsumerConcurrency: 10, globalConcurrency: 10})
    for (let i = 0; i < 3; i += 1) expectOk(limits.acquire('alice'))()
    advance(59_900)
    expect(limits.acquire('alice')).toEqual({ok: false, reason: 'rate', retryAfterSeconds: 1})
  })
})

describe('concurrency', () => {
  test('the per-consumer cap answers consumer-concurrency, and a release frees a slot', () => {
    const {limits} = setup({requestsPerWindow: 100})
    const a = expectOk(limits.acquire('alice'))
    expectOk(limits.acquire('alice'))
    const denied = limits.acquire('alice')
    expect(denied).toMatchObject({ok: false, reason: 'consumer-concurrency'})
    expect(denied.ok ? 0 : denied.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    a()
    expect(limits.acquire('alice').ok).toBe(true)
  })

  test('the global cap answers global-concurrency across consumers', () => {
    const {limits} = setup({requestsPerWindow: 100})
    expectOk(limits.acquire('alice'))
    expectOk(limits.acquire('bob'))
    expectOk(limits.acquire('carol'))
    expect(limits.acquire('dave')).toMatchObject({ok: false, reason: 'global-concurrency'})
  })

  test('releasing twice frees only one slot', () => {
    const {limits} = setup({requestsPerWindow: 100})
    const a = expectOk(limits.acquire('alice'))
    expectOk(limits.acquire('alice'))
    a()
    a()
    expect(limits.acquire('alice').ok).toBe(true)
    expect(limits.acquire('alice').ok).toBe(false)
  })

  test('a request refused for concurrency does not spend budget', () => {
    const {limits} = setup({perConsumerConcurrency: 1, globalConcurrency: 10})
    const a = expectOk(limits.acquire('alice'))
    for (let i = 0; i < 10; i += 1) expect(limits.acquire('alice').ok).toBe(false)
    a()
    expect(limits.acquire('alice').ok).toBe(true)
  })

  test('a request refused for budget holds no slot', () => {
    const {limits} = setup({requestsPerWindow: 1, perConsumerConcurrency: 5, globalConcurrency: 5})
    expectOk(limits.acquire('alice'))()
    expect(limits.acquire('alice').ok).toBe(false)
    expect(limits.stats().active).toBe(0)
  })

  test('a held slot outlives its window and still counts', () => {
    const {limits, advance} = setup({requestsPerWindow: 100, perConsumerConcurrency: 1})
    expectOk(limits.acquire('alice'))
    advance(120_000)
    expect(limits.acquire('alice')).toMatchObject({ok: false, reason: 'consumer-concurrency'})
  })
})

describe('eviction', () => {
  test('idle consumers from an old window are dropped, held ones are kept', () => {
    const {limits, advance} = setup({requestsPerWindow: 100, perConsumerConcurrency: 10, globalConcurrency: 100})
    expectOk(limits.acquire('held'))
    for (let i = 0; i < 50; i += 1) expectOk(limits.acquire(`idle-${i}`))()
    expect(limits.stats().tracked).toBe(51)
    advance(61_000)
    expectOk(limits.acquire('fresh'))()
    expect(limits.stats().tracked).toBe(2)
  })

  test('the table never grows past the number of consumers seen in the live window', () => {
    const {limits, advance} = setup({requestsPerWindow: 100, perConsumerConcurrency: 10, globalConcurrency: 100})
    for (let window = 0; window < 5; window += 1) {
      for (let i = 0; i < 20; i += 1) expectOk(limits.acquire(`c-${window}-${i}`))()
      advance(61_000)
    }
    expectOk(limits.acquire('last'))()
    expect(limits.stats().tracked).toBeLessThanOrEqual(1)
  })
})
