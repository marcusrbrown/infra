/**
 * Tests for the live-set module.
 *
 * The live set is the in-memory seam between the mint endpoint (Unit 3) and
 * the sweeper (Unit 4). These tests verify the module's contract in isolation.
 */

import {afterEach, describe, expect, it} from 'bun:test'
import {isReady, listLive, markReady, recordMint, removeKey, resetLiveSetForTest} from './live-set'

afterEach(() => {
  resetLiveSetForTest()
})

describe('live-set', () => {
  describe('recordMint / listLive', () => {
    it('records an entry and returns it in listLive', () => {
      const entry = {
        key: 'ghact-run1-abc',
        runId: 'run1',
        jti: 'jti-1',
        expiresAt: Date.now() + 60_000,
      }
      recordMint(entry)
      const live = listLive()
      expect(live).toHaveLength(1)
      expect(live[0]).toEqual(entry)
    })

    it('returns a snapshot — mutating the returned array does not corrupt internal state', () => {
      recordMint({key: 'ghact-run2-xyz', runId: 'run2', jti: 'jti-2', expiresAt: Date.now() + 60_000})
      const snapshot = listLive()
      snapshot.push({key: 'injected', runId: 'evil', jti: 'evil-jti', expiresAt: 0})
      expect(listLive()).toHaveLength(1)
    })

    it('records multiple entries independently', () => {
      recordMint({key: 'ghact-run3-a', runId: 'run3', jti: 'jti-3a', expiresAt: Date.now() + 60_000})
      recordMint({key: 'ghact-run3-b', runId: 'run3', jti: 'jti-3b', expiresAt: Date.now() + 60_000})
      expect(listLive()).toHaveLength(2)
    })
  })

  describe('removeKey', () => {
    it('removes an existing entry by key', () => {
      recordMint({key: 'ghact-run4-del', runId: 'run4', jti: 'jti-4', expiresAt: Date.now() + 60_000})
      removeKey('ghact-run4-del')
      expect(listLive()).toHaveLength(0)
    })

    it('is a no-op when the key is not present', () => {
      recordMint({key: 'ghact-run5-keep', runId: 'run5', jti: 'jti-5', expiresAt: Date.now() + 60_000})
      removeKey('ghact-run5-nonexistent')
      expect(listLive()).toHaveLength(1)
    })
  })

  describe('ready flag', () => {
    it('starts as not ready', () => {
      expect(isReady()).toBe(false)
    })

    it('becomes ready after markReady()', () => {
      markReady()
      expect(isReady()).toBe(true)
    })

    it('stays ready after multiple markReady() calls', () => {
      markReady()
      markReady()
      expect(isReady()).toBe(true)
    })
  })
})
