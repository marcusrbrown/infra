import type {CredentialEvent} from './credentials'
import {Buffer} from 'node:buffer'

import {describe, expect, test} from 'bun:test'
import {LANGFUSE_PLACEHOLDER} from './constants'
import {createCallerTokenStore, createCredentialStore, parseCallerToken, parseLangfuseBasic} from './credentials'

const PAIR = 'pk-lf-1111aaaa:sk-lf-2222bbbb'

describe('parseLangfuseBasic', () => {
  test('builds a Basic header from the pair', () => {
    expect(parseLangfuseBasic(PAIR)).toEqual({ok: true, authorization: `Basic ${Buffer.from(PAIR).toString('base64')}`})
  })

  test('a trailing newline is trimmed', () => {
    expect(parseLangfuseBasic(`${PAIR}\n`)).toEqual({
      ok: true,
      authorization: `Basic ${Buffer.from(PAIR).toString('base64')}`,
    })
  })

  test('the placeholder is refused as a placeholder', () => {
    expect(parseLangfuseBasic(LANGFUSE_PLACEHOLDER)).toEqual({ok: false, reason: 'placeholder'})
    expect(parseLangfuseBasic(`${LANGFUSE_PLACEHOLDER}\n`)).toEqual({ok: false, reason: 'placeholder'})
  })

  test.each([
    ['empty', ''],
    ['whitespace', '  \n'],
    ['no colon', 'pk-lf-only'],
    ['two colons', 'a:b:c'],
    ['empty public key', ':sk-lf-x'],
    ['empty secret key', 'pk-lf-x:'],
    ['inner whitespace', 'pk-lf-x :sk-lf-y'],
    ['two lines', `${PAIR}\nsecond`],
    ['control characters', 'pk-lf-x:sk\u0000-y'],
  ])('refuses %s as malformed', (_name, text) => {
    expect(parseLangfuseBasic(text)).toEqual({ok: false, reason: 'malformed'})
  })
})

function errnoError(code: string): Error {
  return Object.assign(new Error(code), {code})
}

function build(initial: string | Error) {
  let current: string | Error = initial
  const events: CredentialEvent[] = []
  const store = createCredentialStore({
    path: '/run/secrets/reader-gate/langfuse-basic',
    readText: async () => {
      if (current instanceof Error) throw current
      return current
    },
    log: event => events.push(event),
  })
  return {
    store,
    events,
    set: (value: string | Error) => {
      current = value
    },
  }
}

describe('credential store', () => {
  test('is unavailable until the first read', () => {
    const {store} = build(PAIR)
    expect(store.current()).toEqual({ok: false, reason: 'missing'})
  })

  test('serves the installed pair after a refresh', async () => {
    const {store} = build(PAIR)
    await store.refresh()
    expect(store.current()).toMatchObject({ok: true})
  })

  test('picks up a rotated pair and drops to unavailable when the file goes bad', async () => {
    const harness = build(PAIR)
    await harness.store.refresh()
    harness.set('pk-lf-new:sk-lf-new')
    await harness.store.refresh()
    expect(harness.store.current()).toEqual({
      ok: true,
      authorization: `Basic ${Buffer.from('pk-lf-new:sk-lf-new').toString('base64')}`,
    })
    harness.set(LANGFUSE_PLACEHOLDER)
    await harness.store.refresh()
    expect(harness.store.current()).toEqual({ok: false, reason: 'placeholder'})
  })

  test.each([
    ['missing', errnoError('ENOENT'), 'missing'],
    ['unreadable', errnoError('EACCES'), 'unreadable'],
  ] as const)('a %s file is unavailable', async (_name, error, reason) => {
    const {store} = build(error)
    await store.refresh()
    expect(store.current()).toEqual({ok: false, reason})
  })

  test('logs state changes without the value', async () => {
    const harness = build(PAIR)
    await harness.store.refresh()
    await harness.store.refresh()
    harness.set(LANGFUSE_PLACEHOLDER)
    await harness.store.refresh()
    expect(harness.events).toEqual([
      {type: 'reader-gate-credential', name: 'langfuse', state: 'installed'},
      {type: 'reader-gate-credential', name: 'langfuse', state: 'unavailable', reason: 'placeholder'},
    ])
    expect(JSON.stringify(harness.events)).not.toContain('pk-lf')
  })
})

const CALLER = 'Zk3-_aBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789abc'

describe('parseCallerToken', () => {
  test('takes the whole trimmed value as the token', () => {
    expect(parseCallerToken(CALLER)).toEqual({ok: true, token: CALLER})
    expect(parseCallerToken(`${CALLER}\n`)).toEqual({ok: true, token: CALLER})
  })

  test.each([
    ['empty', ''],
    ['whitespace', ' \n\t'],
    ['inner whitespace', 'abc def'],
    ['two lines', `${CALLER}\nsecond`],
    ['control characters', 'abc\u0000def'],
    ['non-ASCII', 'abc\u00E9def'],
  ])('refuses %s as malformed', (_name, text) => {
    expect(parseCallerToken(text)).toEqual({ok: false, reason: 'malformed'})
  })
})

function buildCaller(initial: string | Error) {
  let current: string | Error = initial
  const events: CredentialEvent[] = []
  const store = createCallerTokenStore({
    path: '/run/secrets/mcp-caller/token',
    readText: async () => {
      if (current instanceof Error) throw current
      return current
    },
    log: event => events.push(event),
  })
  return {
    store,
    events,
    set: (value: string | Error) => {
      current = value
    },
  }
}

describe('caller token store', () => {
  test('is unavailable until the first read, then serves the token', async () => {
    const {store} = buildCaller(`${CALLER}\n`)
    expect(store.current()).toEqual({ok: false, reason: 'missing'})
    await store.refresh()
    expect(store.current()).toEqual({ok: true, token: CALLER})
  })

  test('picks up a rotated token, and drops to unavailable when the file goes bad', async () => {
    const harness = buildCaller(CALLER)
    await harness.store.refresh()
    harness.set('rotated-token')
    await harness.store.refresh()
    expect(harness.store.current()).toEqual({ok: true, token: 'rotated-token'})
    harness.set('')
    await harness.store.refresh()
    expect(harness.store.current()).toEqual({ok: false, reason: 'malformed'})
  })

  test.each([
    ['missing', errnoError('ENOENT'), 'missing'],
    ['unreadable', errnoError('EACCES'), 'unreadable'],
  ] as const)('a %s file is unavailable', async (_name, error, reason) => {
    const {store} = buildCaller(error)
    await store.refresh()
    expect(store.current()).toEqual({ok: false, reason})
  })

  test('logs state changes under its own name, and never the value', async () => {
    const harness = buildCaller(CALLER)
    await harness.store.refresh()
    await harness.store.refresh()
    harness.set('')
    await harness.store.refresh()
    expect(harness.events).toEqual([
      {type: 'reader-gate-credential', name: 'grafana-mcp-caller', state: 'installed'},
      {type: 'reader-gate-credential', name: 'grafana-mcp-caller', state: 'unavailable', reason: 'malformed'},
    ])
    expect(JSON.stringify(harness.events)).not.toContain(CALLER)
  })
})
