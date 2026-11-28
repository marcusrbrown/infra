import {Buffer} from 'node:buffer'
// The two host-held values the gate adds to what it forwards:
//
//   - the Langfuse Viewer credential, added to every Langfuse request. It lives in a host file as
//     `<public key>:<secret key>`; the deploy writes a placeholder until the operator installs a real pair.
//   - the Grafana MCP caller token, added to every Grafana MCP request. It is the one value the gate and the server share:
//     the server refuses a request that does not carry it. The deploy creates it once and never replaces it.
//
// Each store re-reads its file by path so a rotation is picked up without a restart. The caller token is not a Grafana
// credential: Grafana MCP reads its own service-account token file, so the gate holds no Grafana credential.

import {LANGFUSE_PLACEHOLDER} from './constants'
import {errorCode} from './io'

export type CredentialReason = 'missing' | 'unreadable' | 'placeholder' | 'malformed'

export type LangfuseCredential = {ok: true; authorization: string} | {ok: false; reason: CredentialReason}

export type CallerToken = {ok: true; token: string} | {ok: false; reason: CredentialReason}

export type CredentialName = 'langfuse' | 'grafana-mcp-caller'

export type CredentialEvent =
  | {type: 'reader-gate-credential'; name: CredentialName; state: 'installed'}
  | {type: 'reader-gate-credential'; name: CredentialName; state: 'unavailable'; reason: CredentialReason}

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

/** The caller token is the file's one printable word. Empty, blank, several words or control characters are malformed. */
export function parseCallerToken(text: string): CallerToken {
  const token = text.trim()
  return PRINTABLE.test(token) ? {ok: true, token} : {ok: false, reason: 'malformed'}
}

export interface CredentialStoreDeps {
  path: string
  readText: (path: string) => Promise<string>
  log: (event: CredentialEvent) => void
}

export interface CredentialStore<Credential> {
  current: () => Credential
  refresh: () => Promise<void>
}

type Parsed = {ok: true} | {ok: false; reason: CredentialReason}

function createStore<Credential extends Parsed>(
  deps: CredentialStoreDeps,
  name: CredentialName,
  parse: (text: string) => Credential,
): CredentialStore<Credential | {ok: false; reason: CredentialReason}> {
  let credential: Credential | {ok: false; reason: CredentialReason} = {ok: false, reason: 'missing'}
  let lastLogged = ''
  let inFlight: Promise<void> | undefined

  function apply(next: Credential | {ok: false; reason: CredentialReason}): void {
    credential = next
    const key = next.ok ? 'installed' : next.reason
    if (key === lastLogged) return
    lastLogged = key
    deps.log(
      next.ok
        ? {type: 'reader-gate-credential', name, state: 'installed'}
        : {type: 'reader-gate-credential', name, state: 'unavailable', reason: next.reason},
    )
  }

  async function load(): Promise<void> {
    try {
      apply(parse(await deps.readText(deps.path)))
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

export function createCredentialStore(deps: CredentialStoreDeps): CredentialStore<LangfuseCredential> {
  return createStore(deps, 'langfuse', parseLangfuseBasic)
}

export function createCallerTokenStore(deps: CredentialStoreDeps): CredentialStore<CallerToken> {
  return createStore(deps, 'grafana-mcp-caller', parseCallerToken)
}
