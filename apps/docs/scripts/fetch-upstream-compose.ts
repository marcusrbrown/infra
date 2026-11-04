import {mkdirSync, readFileSync, renameSync, rmSync, writeFileSync} from 'node:fs'
import {dirname, join, resolve} from 'node:path'

// Downloads fro-bot/agent's deploy/compose.yaml at the ref pinned in apps/gateway/upstream.json into a ref-keyed path
// under the gitignored .cache. The diagram drift check reads that file. One data file is fetched, with no token: an
// upstream checkout would put upstream's tests where `bun test --recursive` runs them. CI and the autoheal run call
// this through `bun run fetch:upstream-compose`; the drift checker imports the shared definitions below.

export const UPSTREAM_PIN_PATH = 'apps/gateway/upstream.json'
export const UPSTREAM_CACHE_DIR = '.cache/upstream-compose'
/** The whole string must be a release tag; there is no `m` flag, so a second line cannot ride along. */
export const UPSTREAM_REF_PATTERN = /^v\d+\.\d+\.\d+$/
const FETCH_TIMEOUT_MS = 30_000

export function upstreamComposeUrl(ref: string): string {
  return `https://raw.githubusercontent.com/fro-bot/agent/${ref}/deploy/compose.yaml`
}

export function upstreamComposeCachePath(ref: string): string {
  return `${UPSTREAM_CACHE_DIR}/${ref}/compose.yaml`
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Reads the pinned ref and requires it to be a release tag. Throws a plain `Error` that names the pin file. */
export function readPinnedRef(repoRoot: string): string {
  let pin: unknown
  try {
    pin = JSON.parse(readFileSync(join(repoRoot, UPSTREAM_PIN_PATH), 'utf8'))
  } catch (error) {
    const reason =
      error instanceof SyntaxError ? `not valid JSON (${error.message})` : `cannot read (${errorText(error)})`
    throw new Error(`${UPSTREAM_PIN_PATH}: ${reason}`, {cause: error})
  }
  const ref = typeof pin === 'object' && pin !== null && 'ref' in pin ? pin.ref : undefined
  if (typeof ref !== 'string' || !UPSTREAM_REF_PATTERN.test(ref)) {
    throw new Error(`${UPSTREAM_PIN_PATH}: \`ref\` must be a release tag like v1.2.3 (found ${JSON.stringify(ref)})`)
  }
  return ref
}

/** The part of `fetch` this script uses, so a test can pass a fake. */
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface FetchUpstreamOptions {
  readonly repoRoot: string
  /** Injectable for tests; defaults to the global `fetch`. */
  readonly fetch?: FetchLike
}

/**
 * Downloads the upstream compose for the pinned ref and returns the absolute path it wrote. The ref is validated
 * before any request. A non-2xx response or an empty body fails, and the file is written to a temp file and renamed
 * so a reader never sees a partial download.
 */
export async function fetchUpstreamCompose({
  repoRoot,
  fetch: fetchImpl = globalThis.fetch,
}: FetchUpstreamOptions): Promise<string> {
  const ref = readPinnedRef(repoRoot)
  const url = upstreamComposeUrl(ref)
  const response = await fetchImpl(url, {signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)})
  if (!response.ok) throw new Error(`GET ${url} failed: ${response.status} ${response.statusText}`.trimEnd())
  const body = await response.text()
  if (body.trim() === '') throw new Error(`GET ${url} returned an empty body`)

  const target = join(repoRoot, upstreamComposeCachePath(ref))
  const temp = `${target}.${process.pid}.tmp`
  mkdirSync(dirname(target), {recursive: true})
  try {
    writeFileSync(temp, body)
    renameSync(temp, target)
  } catch (error) {
    rmSync(temp, {force: true})
    throw error
  }
  return target
}

if (import.meta.main) {
  try {
    const written = await fetchUpstreamCompose({repoRoot: resolve(import.meta.dir, '../../..')})
    process.stdout.write(`wrote ${written}\n`)
  } catch (error) {
    process.stderr.write(`${errorText(error)}\n`)
    process.exit(1)
  }
}
