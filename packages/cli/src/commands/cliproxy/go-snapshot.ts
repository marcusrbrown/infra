import type {OpenCodeGoSettings, ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'

import type {FetchLike} from '../../status/github-api'

import {parseSettings, parseSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'

import {GITHUB_REPOSITORY} from '../../status/github-api'

/**
 * The current OpenCode Go privacy snapshot and tracked settings, read from the repository's `main` branch at run time.
 *
 * The published CLI inlines both files as they were on release day, while the repository changes them by PR with no
 * release (a privacy refresh, an emergency disable). `cliproxy status` therefore judges against these copies and uses
 * the bundled ones only when a read fails.
 *
 * The read is deliberately narrow: one fixed URL built from constants (no input, no environment), GET only, no
 * credential of any kind (a raw-content host never sees a token), one attempt, bounded in time and size. Whatever
 * comes back goes through the same strict parser the deploy and the monitor use; a response that does not parse is a
 * failed read, never a policy. Failures carry a fixed reason, never a body or an error message.
 */

const GO_SNAPSHOT_REF = 'main'
const GO_SNAPSHOT_FILE = 'packages/shared/opencode-go/privacy-snapshot.json'
const GO_SETTINGS_FILE = 'packages/shared/opencode-go/settings.json'

export const GO_SNAPSHOT_URL = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GO_SNAPSHOT_REF}/${GO_SNAPSHOT_FILE}`
export const GO_SETTINGS_URL = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GO_SNAPSHOT_REF}/${GO_SETTINGS_FILE}`
/** Shared by both reads; each read gets its own signal. */
export const GO_SNAPSHOT_TIMEOUT_MS = 5000
/** The committed snapshot is about 5 KB; this leaves room for growth without buffering anything absurd. */
export const GO_SNAPSHOT_MAX_BYTES = 128 * 1024
/** The committed settings are two short fields. */
export const GO_SETTINGS_MAX_BYTES = 4 * 1024

type GoReadFailureReason = 'network' | 'timeout' | 'oversize' | 'not-json' | `http-${number}`

export type GoSnapshotFailureReason = GoReadFailureReason | 'invalid-snapshot'
export type GoSettingsFailureReason = GoReadFailureReason | 'invalid-settings'

export type GoSnapshotFetch = {ok: true; snapshot: ParsedSnapshot} | {ok: false; reason: GoSnapshotFailureReason}
export type GoSettingsFetch = {ok: true; settings: OpenCodeGoSettings} | {ok: false; reason: GoSettingsFailureReason}

/**
 * Settle with `promise`, or reject with the signal's reason once it aborts. A fetch implementation that does not wire
 * the signal into a response body (or into the request itself) would otherwise leave the read hanging.
 */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, {once: true})
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort))
  })
}

/** The body as text, or `undefined` when it is larger than the cap (checked on the declared length and while reading). */
async function readCappedText(response: Response, signal: AbortSignal, maxBytes: number): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    response.body?.cancel().catch(() => undefined)
    return undefined
  }

  const reader = response.body?.getReader()
  if (reader === undefined) return ''

  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const {done, value} = await abortable(reader.read(), signal)
      if (done) break
      total += value.byteLength
      if (total > maxBytes) return undefined
      chunks.push(value)
    }
    return await abortable(new Blob(chunks).text(), signal)
  } finally {
    // Not awaited: a stalled source may never settle its cancel.
    reader.cancel().catch(() => undefined)
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

type GoFileRead<T, Invalid extends string> = {ok: true; value: T} | {ok: false; reason: GoReadFailureReason | Invalid}

/** One attempt at one fixed URL, parsed by `parse`. Never throws; a parse failure is `invalid`, never a value. */
async function readGoFile<T, Invalid extends string>(
  url: string,
  maxBytes: number,
  fetchFn: FetchLike,
  timeoutMs: number,
  parse: (raw: unknown) => T,
  invalid: Invalid,
): Promise<GoFileRead<T, Invalid>> {
  try {
    const signal = AbortSignal.timeout(timeoutMs)
    const response = await abortable(fetchFn(url, {redirect: 'error', signal}), signal)
    if (!response.ok) {
      // Not awaited: a stalled body must not hold the read past its timeout.
      response.body?.cancel().catch(() => undefined)
      return {ok: false, reason: `http-${response.status}`}
    }

    const text = await readCappedText(response, signal, maxBytes)
    if (text === undefined) return {ok: false, reason: 'oversize'}

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return {ok: false, reason: 'not-json'}
    }

    try {
      return {ok: true, value: parse(raw)}
    } catch {
      return {ok: false, reason: invalid}
    }
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'timeout' : 'network'}
  }
}

/** One attempt, no retry: the bundled copy is the fallback. Never throws. */
export async function fetchCurrentGoSnapshot(
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = GO_SNAPSHOT_TIMEOUT_MS,
): Promise<GoSnapshotFetch> {
  const read = await readGoFile(
    GO_SNAPSHOT_URL,
    GO_SNAPSHOT_MAX_BYTES,
    fetchFn,
    timeoutMs,
    parseSnapshot,
    'invalid-snapshot',
  )
  return read.ok ? {ok: true, snapshot: read.value} : read
}

/** The settings counterpart of {@link fetchCurrentGoSnapshot}: same rules, the bundled settings are the fallback. */
export async function fetchCurrentGoSettings(
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = GO_SNAPSHOT_TIMEOUT_MS,
): Promise<GoSettingsFetch> {
  const read = await readGoFile(
    GO_SETTINGS_URL,
    GO_SETTINGS_MAX_BYTES,
    fetchFn,
    timeoutMs,
    parseSettings,
    'invalid-settings',
  )
  return read.ok ? {ok: true, settings: read.value} : read
}
