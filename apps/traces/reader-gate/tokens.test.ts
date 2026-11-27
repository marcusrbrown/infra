import type {StoreEvent} from './tokens'
import {mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {afterEach, beforeEach, describe, expect, test} from 'bun:test'
import {RELOAD_INTERVAL_MS} from './constants'
import {readTextFile} from './io'
import {makeToken, sha256Hex, tokenLine, voidLine} from './testing'
import {createTokenStore, hashToken, parseTokenFile, startReloading} from './tokens'

const alice = makeToken('alice')
const bob = makeToken('bob')

describe('parseTokenFile', () => {
  test('reads token lines into consumer and fingerprint, keyed by hash', () => {
    const result = parseTokenFile(tokenLine(alice, 'systematic') + tokenLine(bob, 'fro-bot-audit'))
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.readers.size).toBe(2)
    expect(result.readers.get(hashToken(alice))).toEqual({
      consumer: 'systematic',
      fingerprint: sha256Hex(alice).slice(0, 12),
    })
    expect(result.readers.get(hashToken(bob))?.consumer).toBe('fro-bot-audit')
  })

  test('the map never holds token text', () => {
    const result = parseTokenFile(tokenLine(alice, 'systematic'))
    if (!result.ok) throw new Error('expected ok')
    expect([...result.readers.keys()]).not.toContain(alice)
  })

  test('a void-only file is valid and empty', () => {
    const result = parseTokenFile(voidLine())
    expect(result).toEqual({ok: true, readers: new Map()})
  })

  test('void lines beside real lines are skipped', () => {
    const result = parseTokenFile(voidLine() + tokenLine(alice, 'systematic'))
    if (!result.ok) throw new Error('expected ok')
    expect(result.readers.size).toBe(1)
  })

  test('blank lines are skipped', () => {
    const result = parseTokenFile(`\n${tokenLine(alice, 'systematic')}\n\n`)
    expect(result.ok).toBe(true)
  })

  test.each(['', '\n', '  \n\t\n'])('empty text %j is refused as empty', text => {
    expect(parseTokenFile(text)).toEqual({ok: false, reason: 'empty'})
  })

  const fp = sha256Hex(alice).slice(0, 12)
  const malformed: [string, string][] = [
    ['sender format with no consumer column', `${alice} ${fp} 2026-11-27T00:00:00.000Z\n`],
    ['an extra column', `${alice} ${fp} systematic 2026-11-27T00:00:00.000Z extra\n`],
    ['a fingerprint that does not match the token', `${alice} 000000000000 systematic 2026-11-27T00:00:00.000Z\n`],
    ['an upper-case consumer', `${alice} ${fp} Systematic 2026-11-27T00:00:00.000Z\n`],
    ['a consumer that starts with a digit', `${alice} ${fp} 1abc 2026-11-27T00:00:00.000Z\n`],
    ['a date that is not a date', `${alice} ${fp} systematic notadate\n`],
    ['a token without the prefix', `abc ${sha256Hex('abc').slice(0, 12)} systematic 2026-11-27T00:00:00.000Z\n`],
    ['a token that is too short', `trc_abc ${sha256Hex('trc_abc').slice(0, 12)} systematic 2026-11-27T00:00:00.000Z\n`],
    [
      'a void-prefixed token that is not marked void',
      `trc_void_${'a'.repeat(43)} ${fp} systematic 2026-11-27T00:00:00.000Z\n`,
    ],
    ['a duplicate token', tokenLine(alice, 'systematic') + tokenLine(alice, 'other')],
    ['binary noise', '\u0000\u0001\u0002\n'],
  ]
  test.each(malformed)('refuses %s', (_name, text) => {
    expect(parseTokenFile(text)).toEqual({ok: false, reason: 'malformed'})
  })

  test('one malformed line refuses the whole file, even beside good lines', () => {
    const text = `${tokenLine(alice, 'systematic')}garbage line here\n`
    expect(parseTokenFile(text)).toEqual({ok: false, reason: 'malformed'})
  })

  test('two lines for one consumer are allowed (the CLI flags them, the gate honours both)', () => {
    const result = parseTokenFile(tokenLine(alice, 'systematic') + tokenLine(bob, 'systematic'))
    expect(result.ok).toBe(true)
  })
})

function memoryStore(initial: string | Error) {
  let current: string | Error = initial
  const events: StoreEvent[] = []
  let reads = 0
  const store = createTokenStore({
    path: '/run/readers/token',
    readText: async () => {
      reads += 1
      if (current instanceof Error) throw current
      return current
    },
    log: event => events.push(event),
  })
  return {
    store,
    events,
    reads: () => reads,
    set: (value: string | Error) => {
      current = value
    },
  }
}

function errnoError(code: string): Error {
  return Object.assign(new Error(code), {code})
}

describe('token store', () => {
  test('denies everything before the first read', () => {
    const {store} = memoryStore(tokenLine(alice, 'systematic'))
    expect(store.lookup(alice)).toBeNull()
    expect(store.status()).toEqual({state: 'denying', reason: 'not-loaded'})
  })

  test('accepts a listed token after a refresh, and nothing else', async () => {
    const {store} = memoryStore(tokenLine(alice, 'systematic'))
    await store.refresh()
    expect(store.lookup(alice)).toEqual({consumer: 'systematic', fingerprint: sha256Hex(alice).slice(0, 12)})
    expect(store.lookup(bob)).toBeNull()
    expect(store.lookup('')).toBeNull()
    expect(store.status()).toEqual({state: 'loaded', tokens: 1})
  })

  test('a sender-style token that is not in the reader file is refused', async () => {
    const {store} = memoryStore(tokenLine(alice, 'systematic'))
    await store.refresh()
    expect(store.lookup(makeToken('sender-group-token'))).toBeNull()
  })

  test.each([
    ['missing', errnoError('ENOENT'), 'missing'],
    ['unreadable', errnoError('EACCES'), 'unreadable'],
    ['empty', '', 'empty'],
    ['malformed', 'not a token file\n', 'malformed'],
  ] as const)('a %s file at start denies every token', async (_name, content, reason) => {
    const {store} = memoryStore(content)
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
    expect(store.status()).toEqual({state: 'denying', reason})
  })

  test('a void-only file loads with zero tokens and denies', async () => {
    const {store} = memoryStore(voidLine())
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
    expect(store.status()).toEqual({state: 'loaded', tokens: 0})
  })

  test.each([
    ['missing', errnoError('ENOENT')],
    ['unreadable', errnoError('EACCES')],
    ['empty', ''],
    ['malformed', 'garbage\n'],
  ] as const)('a reload that finds the file %s removes every token', async (_name, content) => {
    const harness = memoryStore(tokenLine(alice, 'systematic') + tokenLine(bob, 'other'))
    await harness.store.refresh()
    expect(harness.store.lookup(alice)).not.toBeNull()
    harness.set(content)
    await harness.store.refresh()
    expect(harness.store.lookup(alice)).toBeNull()
    expect(harness.store.lookup(bob)).toBeNull()
  })

  test('a reload that drops one token removes only that token', async () => {
    const harness = memoryStore(tokenLine(alice, 'systematic') + tokenLine(bob, 'other'))
    await harness.store.refresh()
    harness.set(tokenLine(bob, 'other'))
    await harness.store.refresh()
    expect(harness.store.lookup(alice)).toBeNull()
    expect(harness.store.lookup(bob)?.consumer).toBe('other')
  })

  test('recovers when a good file comes back', async () => {
    const harness = memoryStore('garbage\n')
    await harness.store.refresh()
    harness.set(tokenLine(alice, 'systematic'))
    await harness.store.refresh()
    expect(harness.store.lookup(alice)?.consumer).toBe('systematic')
  })

  test('overlapping refreshes read the file once', async () => {
    const harness = memoryStore(tokenLine(alice, 'systematic'))
    await Promise.all([harness.store.refresh(), harness.store.refresh(), harness.store.refresh()])
    expect(harness.reads()).toBe(1)
    await harness.store.refresh()
    expect(harness.reads()).toBe(2)
  })

  test('logs state changes only, never token text or fingerprints', async () => {
    const harness = memoryStore(tokenLine(alice, 'systematic'))
    await harness.store.refresh()
    await harness.store.refresh()
    harness.set('garbage\n')
    await harness.store.refresh()
    await harness.store.refresh()
    expect(harness.events).toEqual([
      {type: 'reader-gate-store', state: 'loaded', tokens: 1},
      {type: 'reader-gate-store', state: 'denying', reason: 'malformed'},
    ])
    expect(JSON.stringify(harness.events)).not.toContain(alice)
  })
})

describe('startReloading', () => {
  test('refreshes at once, then on every interval tick, and stops on request', async () => {
    const harness = memoryStore(tokenLine(alice, 'systematic'))
    let tick: (() => void) | undefined
    let interval = 0
    let cleared = false
    const stop = startReloading(harness.store, {
      setInterval: (fn, ms) => {
        tick = fn
        interval = ms
        return 7
      },
      clearInterval: handle => {
        expect(handle).toBe(7)
        cleared = true
      },
    })
    expect(interval).toBe(RELOAD_INTERVAL_MS)
    await Bun.sleep(0)
    expect(harness.reads()).toBe(1)
    tick?.()
    await Bun.sleep(0)
    expect(harness.reads()).toBe(2)
    stop()
    expect(cleared).toBe(true)
  })
})

function realStore(path: string) {
  return createTokenStore({path, readText: readTextFile, log: () => {}})
}

describe('token store on real files', () => {
  let dir = ''
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'reader-gate-'))
  })
  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  test('a rename-replace that removes a token makes it unknown on the next reload', async () => {
    const path = join(dir, 'token')
    writeFileSync(path, tokenLine(alice, 'systematic') + tokenLine(bob, 'other'))
    const store = realStore(path)
    await store.refresh()
    expect(store.lookup(alice)).not.toBeNull()

    writeFileSync(`${path}.tmp`, tokenLine(bob, 'other'))
    renameSync(`${path}.tmp`, path)
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
    expect(store.lookup(bob)).not.toBeNull()
  })

  test('a rename-replace with a void line denies every token', async () => {
    const path = join(dir, 'token')
    writeFileSync(path, tokenLine(alice, 'systematic'))
    const store = realStore(path)
    await store.refresh()
    writeFileSync(`${path}.tmp`, voidLine())
    renameSync(`${path}.tmp`, path)
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
  })

  test('a malformed file after a reload denies every token', async () => {
    const path = join(dir, 'token')
    writeFileSync(path, tokenLine(alice, 'systematic'))
    const store = realStore(path)
    await store.refresh()
    writeFileSync(`${path}.tmp`, `${tokenLine(alice, 'systematic')}half a li`)
    renameSync(`${path}.tmp`, path)
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
  })

  test('a path that does not exist denies', async () => {
    const store = realStore(join(dir, 'absent'))
    await store.refresh()
    expect(store.status()).toEqual({state: 'denying', reason: 'missing'})
  })

  test('a path that cannot be read as a file denies as unreadable', async () => {
    const path = join(dir, 'a-directory')
    mkdirSync(path)
    const store = realStore(path)
    await store.refresh()
    expect(store.lookup(alice)).toBeNull()
    expect(store.status()).toEqual({state: 'denying', reason: 'unreadable'})
  })
})
