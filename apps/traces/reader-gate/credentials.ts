import {Buffer} from 'node:buffer'
// The Langfuse Viewer credential the gate adds to every Langfuse request. It lives in a host file as
// `<public key>:<secret key>`. The deploy writes a placeholder until the operator installs a real pair. The store
// re-reads the file by path so a rotation is picked up without a restart. Grafana MCP reads its own token file, so
// the gate holds no Grafana credential.

import {LANGFUSE_PLACEHOLDER} from './constants'
import {errorCode} from './io'

export type CredentialReason = 'missing' | 'unreadable' | 'placeholder' | 'malformed'

export type LangfuseCredential = {ok: true; authorization: string} | {ok: false; reason: CredentialReason}

export type CredentialEvent =
  | {type: 'reader-gate-credential'; name: 'langfuse'; state: 'installed'}
  | {type: 'reader-gate-credential'; name: 'langfuse'; state: 'unavailable'; reason: CredentialReason}

const PRINTABLE = /^[\x21-\x7E]+$/

export function parseLangfuseBasic(text: string): LangfuseCredential {
  const pair = text.trim()
  if (pair === LANGFUSE_PLACEHOLDER) return {ok: false, reason: 'placeholder'}
  const [publicKey = '', secretKey = '', ...extra] = pair.split(':')
  if (!PRINTABLE.test(pair) || publicKey === '' || secretKey === '' || extra.length > 0) {
    return {ok: false, reason: 'malformed'}
  }
  return {ok: true, authorization: `Basic ${Buffer.from(pair).toString('base64')}`}
}

export interface CredentialStoreDeps {
  path: string
  readText: (path: string) => Promise<string>
  log: (event: CredentialEvent) => void
}

export interface CredentialStore {
  current: () => LangfuseCredential
  refresh: () => Promise<void>
}

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore {
  let credential: LangfuseCredential = {ok: false, reason: 'missing'}
  let lastLogged = ''
  let inFlight: Promise<void> | undefined

  function apply(next: LangfuseCredential): void {
    credential = next
    const key = next.ok ? 'installed' : next.reason
    if (key === lastLogged) return
    lastLogged = key
    deps.log(
      next.ok
        ? {type: 'reader-gate-credential', name: 'langfuse', state: 'installed'}
        : {type: 'reader-gate-credential', name: 'langfuse', state: 'unavailable', reason: next.reason},
    )
  }

  async function load(): Promise<void> {
    try {
      apply(parseLangfuseBasic(await deps.readText(deps.path)))
    } catch (error) {
      apply({ok: false, reason: errorCode(error) === 'ENOENT' ? 'missing' : 'unreadable'})
    }
  }

  return {
    current: () => credential,
    refresh: () => {
      inFlight ??= load().finally(() => {
        inFlight = undefined
      })
      return inFlight
    },
  }
}
