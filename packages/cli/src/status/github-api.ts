import type {z} from 'zod'

/**
 * Minimal read-only GitHub REST transport shared by the deploy-state and monitor readers.
 *
 * - `fetch` is injectable; there is no `gh` subprocess at runtime.
 * - The token travels only in the `Authorization` header of requests to the API origin. It is never put in a
 *   URL, an error, or an observation, and it is never sent to a redirect target.
 * - Every failure collapses to `{ok: false}`: callers map that to an `api-error` observation and never see
 *   status text, bodies or error messages.
 */

export const GITHUB_API_ORIGIN = 'https://api.github.com'
export const GITHUB_REPOSITORY = 'marcusrbrown/infra'
export const GITHUB_REQUEST_TIMEOUT_MS = 10_000
/** Upper bound on a job log we are willing to buffer. Real monitor logs are tens of kilobytes. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

export interface GitHubReadOptions {
  /** `GITHUB_TOKEN`. Absent or blank means the reader reports `not_measured` without any request. */
  token: string | undefined
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike
  /** The read time; becomes `observedAt`. */
  now?: Date
}

export type ApiResult<T> = {ok: true; data: T} | {ok: false}

export function hasToken(token: string | undefined): token is string {
  return token !== undefined && token.trim() !== ''
}

/** `GITHUB_TOKEN`, falling back to `GH_TOKEN`; a blank value counts as unset. */
export function resolveGithubToken(env: Record<string, string | undefined>): string | undefined {
  return [env.GITHUB_TOKEN, env.GH_TOKEN].find(hasToken)
}

function apiHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'marcusrbrown-infra-status',
  }
}

/** GET `path` on the API origin and parse the JSON body. Any error, non-2xx or schema mismatch is `{ok: false}`. */
export async function githubGetJson<T>(
  fetchFn: FetchLike,
  token: string,
  path: string,
  schema: z.ZodType<T>,
): Promise<ApiResult<T>> {
  try {
    const response = await fetchFn(`${GITHUB_API_ORIGIN}${path}`, {
      headers: apiHeaders(token),
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    })
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined)
      return {ok: false}
    }
    const parsed = schema.safeParse(await response.json())
    return parsed.success ? {ok: true, data: parsed.data} : {ok: false}
  } catch {
    return {ok: false}
  }
}

async function readBoundedText(response: Response): Promise<string | undefined> {
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_LOG_BYTES) {
    await response.body?.cancel().catch(() => undefined)
    return undefined
  }
  const text = await response.text()
  return text.length > MAX_LOG_BYTES ? undefined : text
}

/**
 * GET a job log. The API answers 302 with a short-lived signed URL; follow it by hand so the token is never
 * forwarded to the storage host. A direct 200 is accepted too. The signed URL must be https.
 */
export async function githubGetLogText(fetchFn: FetchLike, token: string, path: string): Promise<ApiResult<string>> {
  try {
    const first = await fetchFn(`${GITHUB_API_ORIGIN}${path}`, {
      headers: apiHeaders(token),
      redirect: 'manual',
      signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS),
    })

    if (first.status === 200) {
      const text = await readBoundedText(first)
      return text === undefined ? {ok: false} : {ok: true, data: text}
    }

    await first.body?.cancel().catch(() => undefined)
    const location = first.headers.get('location')
    if (first.status !== 302 || location === null || !location.startsWith('https://')) {
      return {ok: false}
    }

    const second = await fetchFn(location, {signal: AbortSignal.timeout(GITHUB_REQUEST_TIMEOUT_MS)})
    if (!second.ok) {
      await second.body?.cancel().catch(() => undefined)
      return {ok: false}
    }
    const text = await readBoundedText(second)
    return text === undefined ? {ok: false} : {ok: true, data: text}
  } catch {
    return {ok: false}
  }
}
