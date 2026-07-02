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

/** Build a well-formed, self-describing `ghact-<runId>-<expiresAt>-<hex>` key for tests. */
function ghactKey(runId: string, expiresAt: number, suffix = 'abcd1234'): string {
  return `ghact-${runId}-${expiresAt}-${suffix}`
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
// reconcile — integration: restart recovery (TIME-BASED, not live-set-based)
// ---------------------------------------------------------------------------

describe('reconcile — integration: restart recovery', () => {
  test('KEEPS an active post-restart key: live-set empty, key expiry is in the future', async () => {
    const now = 1_000_000
    const activeKey = ghactKey('run123', now + 60_000)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    // Live set is empty (broker restarted) — must NOT be consulted for this decision.
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [activeKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    expect(revokeKey).not.toHaveBeenCalled()
  })

  test('REVOKES an expired post-restart key: live-set empty, key expiry is in the past', async () => {
    const now = 1_000_000
    const expiredKey = ghactKey('run123', now - 60_000)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [expiredKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(expiredKey)
  })

  test('live-set membership does NOT protect an expired key — revokes anyway', async () => {
    const now = 1_000_000
    const expiredKey = ghactKey('run-active', now - 1)
    // Key IS in the live set (e.g. stale entry that outlived its own TTL sweep).
    const liveEntry = makeEntry(expiredKey, now + 60_000, 'run-active')

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [liveEntry])
    const listApiKeys = mock(async () => [expiredKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    // The key-name expiry (past) is authoritative — live-set membership is irrelevant.
    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(expiredKey)
  })

  test('boundary: expiry === now → revoke; expiry === now + 1 → keep', async () => {
    const now = 1_000_000
    const atBoundaryKey = ghactKey('run-boundary', now, 'aaaa1111')
    const justAfterKey = ghactKey('run-boundary', now + 1, 'bbbb2222')

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [atBoundaryKey, justAfterKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(atBoundaryKey)
  })
})

// ---------------------------------------------------------------------------
// reconcile — legacy/malformed ghact- keys: never revoked (migration safety)
// ---------------------------------------------------------------------------

describe('reconcile — legacy/malformed ghact- key handling', () => {
  test('does NOT revoke a legacy ghact- key with no numeric expiry segment, logs a warning', async () => {
    const now = 1_000_000
    const legacyKey = 'ghact-run123-abcd'

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [legacyKey])
    const loggerError = mock((_msg: string) => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    await reconcile(now, deps)

    expect(revokeKey).not.toHaveBeenCalled()
    expect(loggerError).toHaveBeenCalledTimes(1)
    const msg: string = loggerError.mock.calls[0]?.[0] ?? ''
    expect(msg).toContain('skipping unparseable ghact- key')
    expect(msg).toContain('legacy/malformed')
    // Only a short prefix of the key is logged, not the full key.
    expect(msg).toContain(legacyKey.slice(0, 12))
  })
})

// ---------------------------------------------------------------------------
// reconcile — safety (critical): NEVER deletes non-ghact- keys
// ---------------------------------------------------------------------------

describe('reconcile — safety: never deletes non-ghact- keys', () => {
  test('only revokes the expired ghact- key; leaves durable key and other consumers untouched', async () => {
    const now = 1_000_000
    const durableKey = 'sk-ant-durable-key-abc123'
    const otherConsumerKey = 'some-other-consumer-key'
    const expiredGhactKey = ghactKey('run-stale', now - 1)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    // Live set is empty (broker restarted)
    const listLive = mock(() => [] as LiveEntry[])
    // cliproxy has all three keys
    const listApiKeys = mock(async () => [durableKey, otherConsumerKey, expiredGhactKey])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    // Only the expired ghact- key is revoked
    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(revokeKey.mock.calls[0]?.[0]).toBe(expiredGhactKey)

    // The durable key and other consumer key are never touched
    const revokedKeys = revokeKey.mock.calls.map(c => c[0])
    expect(revokedKeys).not.toContain(durableKey)
    expect(revokedKeys).not.toContain(otherConsumerKey)
  })

  test('revokes multiple expired ghact- keys but leaves all non-ghact- keys', async () => {
    const now = 1_000_000
    const durableKey = 'sk-ant-durable-key-abc123'
    const expiredKey1 = ghactKey('run-stale-1', now - 1, 'aaaa0001')
    const expiredKey2 = ghactKey('run-stale-2', now - 1, 'bbbb0002')

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [durableKey, expiredKey1, expiredKey2])

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
    }

    await reconcile(now, deps)

    expect(revokeKey).toHaveBeenCalledTimes(2)
    const revokedKeys = revokeKey.mock.calls.map(c => c[0])
    expect(revokedKeys).toContain(expiredKey1)
    expect(revokedKeys).toContain(expiredKey2)
    expect(revokedKeys).not.toContain(durableKey)
  })

  test('does nothing when cliproxy has no ghact- keys', async () => {
    const now = 1_000_000
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

    await reconcile(now, deps)

    expect(revokeKey).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// startupReconcile — integration: startup gate ordering
// ---------------------------------------------------------------------------

describe('startupReconcile — startup gate ordering', () => {
  test('runs reconcile BEFORE markReady — stale key is gone before ready flips', async () => {
    const now = 1_000_000
    const callOrder: string[] = []
    const staleKey = ghactKey('run-stale-boot', now - 1)

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
      clock: () => now,
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
// sweepExpired — error path: revokeKey failure is reported via injected logger
// ---------------------------------------------------------------------------

describe('sweepExpired — error path: revokeKey failure reported via logger', () => {
  test('calls logger.error with key prefix when revokeKey throws during sweepExpired', async () => {
    const now = 1_000_000
    const key = 'ghact-run-fail-abc123xyz'
    const entry = makeEntry(key, now - 1)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {
      throw new Error('upstream revoke failed')
    })
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])
    const loggerError = mock((_msg: string) => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    await sweepExpired(now, deps)

    expect(loggerError).toHaveBeenCalledTimes(1)
    const msg: string = loggerError.mock.calls[0]?.[0] ?? ''
    expect(msg).toContain('[sweeper] sweepExpired: revokeKey failed for key prefix')
    expect(msg).toContain(key.slice(0, 12))
    expect(msg).toContain('upstream revoke failed')
    // Ensure the full key is NOT logged
    expect(msg).not.toContain(key.slice(12))
    // removeKey is NOT called when revoke fails — entry stays for retry
    expect(removeKey).not.toHaveBeenCalled()
  })

  test('revoke fails → entry remains in live set → next tick retries', async () => {
    const now = 1_000_000
    const key = 'ghact-run-retry-abc123xyz'
    const entry = makeEntry(key, now - 1)

    let revokeCallCount = 0
    const revokeKey = mock(async (_key: string, _deps: unknown) => {
      revokeCallCount++
      if (revokeCallCount === 1) {
        throw new Error('transient revoke failure')
      }
      // Second call succeeds
    })
    const removeKey = mock((_key: string) => {})
    // listLive always returns the entry (simulating it stays in the live set)
    const listLive = mock(() => [entry])
    const loggerError = mock((_msg: string) => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    // First tick: revoke fails, entry stays
    await sweepExpired(now, deps)
    expect(revokeKey).toHaveBeenCalledTimes(1)
    expect(removeKey).not.toHaveBeenCalled()
    expect(loggerError).toHaveBeenCalledTimes(1)

    // Second tick: revoke succeeds, entry removed
    await sweepExpired(now + 1, deps)
    expect(revokeKey).toHaveBeenCalledTimes(2)
    expect(removeKey).toHaveBeenCalledTimes(1)
    expect(removeKey.mock.calls[0]?.[0]).toBe(key)
  })
})

// ---------------------------------------------------------------------------
// sweepExpired — auditRevoke is called on successful revoke
// ---------------------------------------------------------------------------

describe('sweepExpired — auditRevoke on successful revoke', () => {
  test('calls auditLogger.log with revoke decision on successful revoke', async () => {
    const now = 1_000_000
    const entry = makeEntry('ghact-run-audit-abc', now - 1, 'run-audit', 'jti-audit')

    const revokeKey = mock(async (_key: string, _deps: unknown) => {})
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [entry])
    const auditLogEvents: unknown[] = []
    const auditLogger = {log: mock((e: unknown) => auditLogEvents.push(e))}

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      auditLogger,
    }

    await sweepExpired(now, deps)

    expect(auditLogger.log).toHaveBeenCalledTimes(1)
    const event = auditLogEvents[0] as {decision: string; runId: string; jti: string; srcIp: string}
    expect(event.decision).toBe('revoke')
    expect(event.runId).toBe('run-audit')
    expect(event.jti).toBe('jti-audit')
    expect(event.srcIp).toBe('sweeper')
  })

  test('does not call auditLogger when revoke fails', async () => {
    const now = 1_000_000
    const entry = makeEntry('ghact-run-fail-audit', now - 1)

    const revokeKey = mock(async (_key: string, _deps: unknown) => {
      throw new Error('revoke failed')
    })
    const auditLogger = {log: mock((_e: unknown) => {})}

    const deps: SweeperDeps = {
      revokeKey,
      removeKey: mock((_key: string) => {}),
      listLive: mock(() => [entry]),
      listApiKeys: mock(async () => []),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      auditLogger,
    }

    await sweepExpired(now, deps)

    expect(auditLogger.log).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// reconcile — error path: listApiKeys failure is caught and logged
// ---------------------------------------------------------------------------

describe('reconcile — error path: listApiKeys failure caught', () => {
  test('logs error and returns (does not throw) when listApiKeys fails', async () => {
    const loggerError = mock((_msg: string) => {})
    const revokeKey = mock(async (_key: string, _deps: unknown) => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey: mock((_key: string) => {}),
      listLive: mock(() => [] as LiveEntry[]),
      listApiKeys: mock(async () => {
        throw new Error('cliproxy unreachable')
      }),
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    // Must not throw
    await expect(reconcile(1_000_000, deps)).resolves.toBeUndefined()

    expect(loggerError).toHaveBeenCalledTimes(1)
    const msg: string = loggerError.mock.calls[0]?.[0] ?? ''
    expect(msg).toContain('[sweeper] reconcile: listApiKeys failed')
    expect(msg).toContain('cliproxy unreachable')
    // revokeKey must not be called when listApiKeys fails
    expect(revokeKey).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// reconcile — error path: revokeKey failure is reported via injected logger
// ---------------------------------------------------------------------------

describe('reconcile — error path: revokeKey failure reported via logger', () => {
  test('calls logger.error with key prefix when revokeKey throws during reconcile', async () => {
    const now = 1_000_000
    const staleKey = ghactKey('run-stale-fail', now - 1, 'abcd1234')

    const revokeKey = mock(async (_key: string, _deps: unknown) => {
      throw new Error('revoke network error')
    })
    const removeKey = mock((_key: string) => {})
    const listLive = mock(() => [] as LiveEntry[])
    const listApiKeys = mock(async () => [staleKey])
    const loggerError = mock((_msg: string) => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey,
      listLive,
      listApiKeys,
      markReady: mock(() => {}),
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    await reconcile(now, deps)

    expect(loggerError).toHaveBeenCalledTimes(1)
    const msg: string = loggerError.mock.calls[0]?.[0] ?? ''
    expect(msg).toContain('[sweeper] reconcile: revokeKey failed for key prefix')
    expect(msg).toContain(staleKey.slice(0, 12))
    expect(msg).toContain('revoke network error')
    // Ensure the full key is NOT logged
    expect(msg).not.toContain(staleKey.slice(12))
  })
})

// ---------------------------------------------------------------------------
// startupReconcile — bounded retry on listApiKeys failure
// ---------------------------------------------------------------------------

describe('startupReconcile — bounded retry on listApiKeys failure', () => {
  test('calls markReady even when all reconcile attempts fail', async () => {
    const loggerError = mock((_msg: string) => {})
    const markReady = mock(() => {})

    const deps: SweeperDeps = {
      revokeKey: mock(async () => {}),
      removeKey: mock(() => {}),
      listLive: mock(() => [] as LiveEntry[]),
      listApiKeys: mock(async () => {
        throw new Error('persistent cliproxy failure')
      }),
      markReady,
      mintDeps: makeMintDeps(),
      logger: {error: loggerError},
    }

    // Must not throw even when all attempts fail
    await expect(startupReconcile(deps)).resolves.toBeUndefined()

    // markReady must still be called
    expect(markReady).toHaveBeenCalledTimes(1)
    // Error must be logged
    expect(loggerError.mock.calls.length).toBeGreaterThan(0)
  })

  test('succeeds on first attempt when listApiKeys works', async () => {
    const now = 1_000_000
    const markReady = mock(() => {})
    const revokeKey = mock(async () => {})

    const deps: SweeperDeps = {
      revokeKey,
      removeKey: mock(() => {}),
      listLive: mock(() => [] as LiveEntry[]),
      listApiKeys: mock(async () => [ghactKey('run-stale', now - 1)]),
      markReady,
      mintDeps: makeMintDeps(),
      clock: () => now,
    }

    await startupReconcile(deps)

    expect(markReady).toHaveBeenCalledTimes(1)
    expect(revokeKey).toHaveBeenCalledTimes(1)
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

  test('reconcile tick revokes expired ghact- keys via injected setInterval', async () => {
    const staleKey = ghactKey('run-reconcile-tick', Date.now() - 1)
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
