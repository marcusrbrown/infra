// The reader token store. The token file holds one line per reader:
//
//   <token> <fp12> <consumer> <iso-date>        a reader
//   <void token> void <iso-date>                 a void line: no reader
//
// The store reads the file by path about once a second and swaps the whole set in one assignment. It fails closed:
// a missing, empty, unreadable or malformed file leaves it with no tokens, at start and after every reload. That
// differs on purpose from the collector, which keeps its last good list. Tokens are held as SHA-256 hashes, so no
// token text is kept in memory and a lookup does not compare token bytes.

import {createHash} from 'node:crypto'

import {CONSUMER_PATTERN, RELOAD_INTERVAL_MS, VOID_TOKEN_PREFIX} from './constants'
import {errorCode} from './io'

export interface ReaderIdentity {
  consumer: string
  fingerprint: string
}

export type ParseResult =
  {ok: true; readers: ReadonlyMap<string, ReaderIdentity>} | {ok: false; reason: 'empty' | 'malformed'}

export type StoreStatus =
  | {state: 'loaded'; tokens: number}
  | {state: 'denying'; reason: 'not-loaded' | 'missing' | 'unreadable' | 'empty' | 'malformed'}

export type StoreEvent =
  | {type: 'reader-gate-store'; state: 'loaded'; tokens: number}
  | {type: 'reader-gate-store'; state: 'denying'; reason: string}

const TOKEN_PATTERN = /^trc_[\w-]{32,128}$/
const FINGERPRINT_LENGTH = 12

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** Parse the whole file. Any malformed line refuses the file: a half-understood list must not grant access. */
export function parseTokenFile(text: string): ParseResult {
  const lines = text.split('\n').filter(line => line.trim() !== '')
  if (lines.length === 0) return {ok: false, reason: 'empty'}

  const readers = new Map<string, ReaderIdentity>()
  for (const line of lines) {
    const fields = line.split(' ')
    const token = fields[0] ?? ''
    if (token.startsWith(VOID_TOKEN_PREFIX)) {
      if (!isVoidLine(fields)) return {ok: false, reason: 'malformed'}
      continue
    }
    if (fields.length !== 4 || !TOKEN_PATTERN.test(token)) return {ok: false, reason: 'malformed'}
    const [, fingerprint = '', consumer = '', date = ''] = fields
    const hash = hashToken(token)
    if (fingerprint !== hash.slice(0, FINGERPRINT_LENGTH)) return {ok: false, reason: 'malformed'}
    if (!CONSUMER_PATTERN.test(consumer) || !isDate(date)) return {ok: false, reason: 'malformed'}
    if (readers.has(hash)) return {ok: false, reason: 'malformed'}
    readers.set(hash, {consumer, fingerprint})
  }
  return {ok: true, readers}
}

function isVoidLine(fields: string[]): boolean {
  return fields.length === 3 && fields[1] === 'void' && isDate(fields[2] ?? '') && TOKEN_PATTERN.test(fields[0] ?? '')
}

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(value) && !Number.isNaN(Date.parse(value))
}

export interface TokenStore {
  /** The reader that holds this token, or null. Synchronous: it reads the set the last refresh left. */
  lookup: (token: string) => ReaderIdentity | null
  refresh: () => Promise<void>
  status: () => StoreStatus
}

export interface TokenStoreDeps {
  path: string
  readText: (path: string) => Promise<string>
  log: (event: StoreEvent) => void
}

export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  let readers: ReadonlyMap<string, ReaderIdentity> = new Map()
  let status: StoreStatus = {state: 'denying', reason: 'not-loaded'}
  let inFlight: Promise<void> | undefined
  let lastLogged = ''

  function apply(next: StoreStatus, nextReaders: ReadonlyMap<string, ReaderIdentity>): void {
    readers = nextReaders
    status = next
    const key = JSON.stringify(next)
    if (key === lastLogged) return
    lastLogged = key
    deps.log(
      next.state === 'loaded'
        ? {type: 'reader-gate-store', state: 'loaded', tokens: next.tokens}
        : {type: 'reader-gate-store', state: 'denying', reason: next.reason},
    )
  }

  async function load(): Promise<void> {
    let text: string
    try {
      text = await deps.readText(deps.path)
    } catch (error) {
      apply({state: 'denying', reason: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'}, new Map())
      return
    }
    const parsed = parseTokenFile(text)
    if (!parsed.ok) {
      apply({state: 'denying', reason: parsed.reason}, new Map())
      return
    }
    apply({state: 'loaded', tokens: parsed.readers.size}, parsed.readers)
  }

  return {
    lookup: token => readers.get(hashToken(token)) ?? null,
    refresh: () => {
      inFlight ??= load().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
    status: () => status,
  }
}

export interface ReloadTimers {
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
}

/** Refresh now, then on every interval. Returns a function that stops it. */
export function startReloading(
  store: Pick<TokenStore, 'refresh'>,
  timers: ReloadTimers,
  intervalMs: number = RELOAD_INTERVAL_MS,
): () => void {
  const tick = (): void => {
    store.refresh().catch(() => {})
  }
  tick()
  const handle = timers.setInterval(tick, intervalMs)
  return () => timers.clearInterval(handle)
}
