/**
 * Tests for the sweeper — TTL backstop + reconcile sweep.
 *
 * All collaborators are injected; no real network, no real timers.
 * Tests follow RED → GREEN → REFACTOR order per the plan.
 */

import type {LiveEntry} from './live-set'
import type {SweeperDeps, SweeperOpts} from './sweeper'

import {describe, expect, mock, test} from 'bun:test'
import {reconcile, startSweeper, startupReconcile, sweepExpired} from './sweeper'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const TEST_MGMT_URL = 'https://cliproxy.example.test'
const TEST_MGMT_KEY = 'test-management-key'

/** Build a minimal MintDeps-compatible object. */
function makeMintDeps() {
  return {managementUrl: TEST_MGMT_URL, managementKey: TEST_MGMT_KEY}
}

/** Build a LiveEntry with the given key and expiresAt. */
function makeEntry(key: string, expiresAt: number, runId = 'run-1', jti = 'jti-1'): LiveEntry {
  return {key, runId, jti, expiresAt}
}

// ---------------------------------------------------------------------------
// sweepExpired — happy path: entry past TTL is swept
// ---------------------------------------------------------------------------

describe('sweepExpired — happy path: entry past TTL', () => {
  test('revokes and removes an entry whose expiresAt <= now', async () => {
    const now = 1_000_000
    const entry = makeEntry('ghact-run-1-abc', now - 1) // expired 1ms ago

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await sweepExpired(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe('ghact-run-1-abc')
    expect(removeKey).toHaveBeenCalledTimes(1)
    expect(removeKey.mock.calls[0]?.[0]).toBe('ghact-run-1-abc')
  })

  test('revokes and removes an entry whose expiresAt === now (boundary)', async () => {
    const now = 1_000_000
    const entry = makeEntry('ghact-run-boundary-xyz', now) // exactly at boundary

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await sweepExpired(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(removeKey).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// sweepExpired — edge: entry within TTL is left alone
// ---------------------------------------------------------------------------

describe('sweepExpired — edge: entry within TTL', () => {
  test('does not revoke or remove an entry whose expiresAt > now', async () => {
    const now = 1_000_000
    const entry = makeEntry('ghact-run-active-abc', now + 60_000) // 60s in the future

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await sweepExpired(now, deps)

    expect(revokeKey).not.toHaveBeenCalled()
    expect(removeKey).not.toHaveBeenCalled()
  })

  test('sweeps only expired entries when mixed with active ones', async () => {
    const now = 1_000_000
    const expired = makeEntry('ghact-run-expired-abc', now - 1)
    const active = makeEntry('ghact-run-active-xyz', now + 60_000)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [expired, active])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await sweepExpired(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe('ghact-run-expired-abc')
    expect(removeKey).toHaveBeenCalledTimes(1)
    expect(removeKey.mock.calls[0]?.[0]).toBe('ghact-run-expired-abc')
  })
})

// ---------------------------------------------------------------------------
// sweepExpired — integration: crashed run scenario
// ---------------------------------------------------------------------------

describe('sweepExpired — integration: crashed run', () => {
  test('sweeps a minted key whose run never signalled end, once now > expiresAt', async () => {
    const mintTime = 1_000_000
    const ttlMs = 30 * 60 * 1000 // 30 min
    const expiresAt = mintTime + ttlMs

    // Simulate: key was minted, run crashed, no revoke signal came
    const entry = makeEntry('ghact-run-crashed-abc', expiresAt)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    // Before TTL: not swept
    await sweepExpired(expiresAt - 1, deps)
    expect(revokeKey).not.toHaveBeenCalled()

    // At TTL: swept
    await sweepExpired(expiresAt, deps)
    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe('ghact-run-crashed-abc')
    expect(removeKey).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// reconcile — integration: restart recovery
// ---------------------------------------------------------------------------

describe('reconcile — integration: restart recovery', () => {
  test('revokes a ghact- key present in cliproxy but absent from live set', async () => {
    const staleKey = 'ghact-run-stale-abc'

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    // Live set is empty (broker restarted)
    const listLive = mock(() => [] as LiveEntry[])
    // cliproxy still has the stale key
    const listApiKeys = mock(async () => [staleKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(staleKey)
  })

  test('does not revoke a ghact- key that IS in the live set (active run)', async () => {
    const activeKey = 'ghact-run-active-abc'
    const activeEntry = makeEntry(activeKey, Date.now() + 60_000)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [activeEntry])
    const listApiKeys = mock(async () => [activeKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(deps)

    expect(revokeKey).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// reconcile — safety (critical): NEVER deletes non-ghact- keys
// ---------------------------------------------------------------------------

describe('reconcile — safety: never deletes non-ghact- keys', () => {
  test('only revokes the stale ghact- key; leaves durable key and other consumers untouched', async () => {
    const durableKey = 'sk-ant-durable-key-abc123'
    const otherConsumerKey = 'some-other-consumer-key'
    const staleGhactKey = 'ghact-run-stale-xyz'

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    // Live set is empty (broker restarted)
    const listLive = mock(() => [] as LiveEntry[])
    // cliproxy has all three keys
    const listApiKeys = mock(async () => [durableKey, otherConsumerKey, staleGhactKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(deps)

    // Only the stale ghact- key is revoked
    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(staleGhactKey)

    // The durable key and other consumer key are never touched
    const revokedKeys = revokeKey.mock.calls.map(c => c[0])
    expect(revokedKeys).not.toContain(durableKey)
    expect(revokedKeys).not.toContain(otherConsumerKey)
  })

  test('revokes multiple stale ghact- keys but leaves all non-ghact- keys', async () => {
    const durableKey = 'sk-ant-durable-key-abc123'
    const staleKey1 = 'ghact-run-stale-1-abc'
    const staleKey2 = 'ghact-run-stale-2-xyz'

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [durableKey, staleKey1, staleKey2])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(deps)

    expect(revokeKey).toHaveBeenCalledTimes(2)
    const revokedKeys = revokeKey.mock.calls.map(c => c[0])
    expect(revokedKeys).toContain(staleKey1)
    expect(revokedKeys).toContain(staleKey2)
    expect(revokedKeys).not.toContain(durableKey)
  })

  test('does nothing when cliproxy has no ghact- keys', async () => {
    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => ['sk-ant-durable-key', 'other-consumer-key'])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(deps)

    expect(revokeKey).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// startupReconcile — integration: startup gate ordering
// ---------------------------------------------------------------------------

describe('startupReconcile — startup gate ordering', () => {
  test('runs reconcile BEFORE markReady — stale key is gone before ready flips', async () => {
    const callOrder: string[] = []
    const staleKey = 'ghact-run-stale-boot-abc'

    const revokeKey = mock(async (_key: string, _deps: unknown) => {
      callOrder.push('revokeKey')
    })
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => {
      callOrder.push('listApiKeys')
      return [staleKey]
    })
    const markReady = mock(() => {
      callOrder.push('markReady')
    })

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady,
      mintDeps: makeMintDeps(),
    }

    await startupReconcile(deps)

    // listApiKeys and revokeKey must both happen before markReady
    const markReadyIdx = callOrder.indexOf('markReady')
    const listApiKeysIdx = callOrder.indexOf('listApiKeys')
    const revokeKeyIdx = callOrder.indexOf('revokeKey')

    expect(markReadyIdx).toBeGreaterThan(-1)
    expect(listApiKeysIdx).toBeGreaterThan(-1)
    expect(revokeKeyIdx).toBeGreaterThan(-1)

    expect(listApiKeysIdx).toBeLessThan(markReadyIdx)
    expect(revokeKeyIdx).toBeLessThan(markReadyIdx)
  })

  test('calls markReady exactly once even when no stale keys exist', async () => {
    const markReady = mock(() => {})

    const deps: SweeperDeps = {
      revokeKey: mock(async () => {}),
      removeKey: mock(() => {}),
      listLive: mock(() => [] as LiveEntry[]),
      listApiKeys: mock(async () => []),
      markReady,
      mintDeps: makeMintDeps(),
    }

    await startupReconcile(deps)

    expect(markReady).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// startSweeper — periodic ticks via injected timer
// ---------------------------------------------------------------------------

describe('startSweeper — periodic ticks', () => {
  test('calls sweepExpired on each sweep tick via injected setInterval', async () => {
    let sweepTickFn: (() => void) | undefined
    let intervalId = 0

    const setIntervalMock = mock((_fn: () => void, _ms: number) => {
      intervalId++
      // First call is the sweep interval; capture it
      if (intervalId === 1) sweepTickFn = _fn
      return intervalId
    })
    const clearIntervalMock = mock((_id: number) => {})

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const now = 2_000_000
    const expiredEntry = makeEntry('ghact-run-tick-abc', now - 1)
    const listLive = mock(() => [expiredEntry])
    const listApiKeys = mock(async () => [])
    const markReady = mock(() => {})
    const clock = mock(() => now)

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady,
      mintDeps: makeMintDeps(),
    }

    const opts: SweeperOpts = {
      sweepIntervalMs: 60_000,
      reconcileIntervalMs: 300_000,
      setInterval: setIntervalMock as unknown as typeof setInterval,
      clearInterval: clearIntervalMock as unknown as typeof clearInterval,
      clock,
    }

    const stop = startSweeper(deps, opts)

    // Simulate a sweep tick (first interval registered)
    expect(sweepTickFn).toBeDefined()
    if (!sweepTickFn) throw new Error('sweepTickFn not captured')
    await sweepTickFn()

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe('ghact-run-tick-abc')

    // Stop clears the intervals
    stop()
    expect(clearIntervalMock).toHaveBeenCalled()
  })

  test('stop handle clears all intervals', () => {
    const clearedIds: number[] = []
    let idCounter = 0

    const setIntervalMock = mock((_fn: () => void, _ms: number) => ++idCounter)
    const clearIntervalMock = mock((id: number) => {
      clearedIds.push(id)
    })

    const deps: SweeperDeps = {
      revokeKey: mock(async () => {}),
      removeKey: mock(() => {}),
      listLive: mock(() => [] as LiveEntry[]),
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    const opts: SweeperOpts = {
      sweepIntervalMs: 60_000,
      reconcileIntervalMs: 300_000,
      setInterval: setIntervalMock as unknown as typeof setInterval,
      clearInterval: clearIntervalMock as unknown as typeof clearInterval,
      clock: () => Date.now(),
    }

    const stop = startSweeper(deps, opts)
    stop()

    // Both intervals (sweep + reconcile) must be cleared
    expect(clearIntervalMock).toHaveBeenCalledTimes(2)
    // All returned IDs must have been cleared
    expect(clearedIds).toHaveLength(2)
  })

  test('reconcile tick revokes stale ghact- keys via injected setInterval', async () => {
    const staleKey = 'ghact-run-reconcile-tick-abc'
    let reconcileTickFn: (() => void) | undefined
    let callCount = 0

    const setIntervalMock = mock((fn: () => void, _ms: number) => {
      callCount++
      // Second call is the reconcile interval
      if (callCount === 2) reconcileTickFn = fn
      return callCount
    })
    const clearIntervalMock = mock((_id: number) => {})

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [staleKey])
    const markReady = mock(() => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady,
      mintDeps: makeMintDeps(),
    }

    const opts: SweeperOpts = {
      sweepIntervalMs: 60_000,
      reconcileIntervalMs: 300_000,
      setInterval: setIntervalMock as unknown as typeof setInterval,
      clearInterval: clearIntervalMock as unknown as typeof clearInterval,
      clock: () => Date.now(),
    }

    startSweeper(deps, opts)

    // Trigger the reconcile tick
    expect(reconcileTickFn).toBeDefined()
    if (!reconcileTickFn) throw new Error('reconcileTickFn not captured')
    await reconcileTickFn()

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(staleKey)
  })
})
