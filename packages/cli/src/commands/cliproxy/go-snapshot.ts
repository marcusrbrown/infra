import type {ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'

import type {FetchLike} from '../../status/github-api'

import {parseSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'

import {GITHUB_REPOSITORY} from '../../status/github-api'

/**
 * The current OpenCode Go privacy snapshot, read from the repository's `main` branch at run time.
 *
 * The published CLI inlines the snapshot as it was on release day, while the repository refreshes it by PR with no
 * release. `cliproxy status` therefore judges against this copy and uses the bundled one only when this read fails.
 *
 * The read is deliberately narrow: one fixed URL built from constants (no input, no environment), GET only, no
 * credential of any kind (a raw-content host never sees a token), one attempt, bounded in time and size. Whatever
 * comes back goes through the same strict parser the deploy and the monitor use; a response that does not parse is a
 * failed read, never a policy. Failures carry a fixed reason, never a body or an error message.
 */

const GO_SNAPSHOT_REF = 'main'
const GO_SNAPSHOT_FILE = 'packages/shared/opencode-go/privacy-snapshot.json'

export const GO_SNAPSHOT_URL = `https://raw.githubusercontent.com/${GITHUB_REPOSITORY}/${GO_SNAPSHOT_REF}/${GO_SNAPSHOT_FILE}`
export const GO_SNAPSHOT_TIMEOUT_MS = 5000
/** The committed snapshot is about 5 KB; this leaves room for growth without buffering anything absurd. */
export const GO_SNAPSHOT_MAX_BYTES = 128 * 1024

export type GoSnapshotFailureReason =
  'network' | 'timeout' | 'oversize' | 'not-json' | 'invalid-snapshot' | `http-${number}`

export type GoSnapshotFetch = {ok: true; snapshot: ParsedSnapshot} | {ok: false; reason: GoSnapshotFailureReason}

/** The body as text, or `undefined` when it is larger than the cap (checked on the declared length and while reading). */
async function readCappedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > GO_SNAPSHOT_MAX_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }

  const reader = response.body?.getReader()
  if (reader === undefined) return ''

  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const {done, value} = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > GO_SNAPSHOT_MAX_BYTES) {
      await reader.cancel().catch(() => undefined)
      return undefined
    }
    chunks.push(value)
  }
  return new Blob(chunks).text()
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')
}

/** One attempt, no retry: the bundled copy is the fallback. Never throws. */
export async function fetchCurrentGoSnapshot(
  fetchFn: FetchLike = (input, init) => fetch(input, init),
  timeoutMs: number = GO_SNAPSHOT_TIMEOUT_MS,
): Promise<GoSnapshotFetch> {
  try {
    const response = await fetchFn(GO_SNAPSHOT_URL, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return {ok: false, reason: `http-${response.status}`}
    }

    const text = await readCappedText(response)
    if (text === undefined) return {ok: false, reason: 'oversize'}

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return {ok: false, reason: 'not-json'}
    }

    try {
      return {ok: true, snapshot: parseSnapshot(raw)}
    } catch {
      return {ok: false, reason: 'invalid-snapshot'}
    }
  } catch (error) {
    return {ok: false, reason: isTimeout(error) ? 'timeout' : 'network'}
  }
}
