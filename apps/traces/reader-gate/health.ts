// The health listener. `GET /healthz` reports whether each upstream answers, as `{ok, langfuse, grafana}` and nothing
// else: it carries no secrets and no token, credential or consumer state, so other containers on the edge network may
// read it. The answer is cached for a few seconds and shared by concurrent requests, so the endpoint cannot be used to
// load the upstreams.

export interface HealthDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>
  upstreams: {langfuse: string; grafana: string}
  clock: () => number
  cacheMs: number
  probeTimeoutMs: number
}

interface Answer {
  ok: boolean
  langfuse: boolean
  grafana: boolean
}

const LANGFUSE_PATH = '/api/public/health'
const GRAFANA_PATH = '/healthz'

export function createHealthHandler(deps: HealthDeps): (req: Request) => Promise<Response> {
  let cached: {at: number; answer: Answer} | undefined
  let inFlight: Promise<Answer> | undefined

  async function probe(url: string): Promise<boolean> {
    try {
      const res = await deps.fetch(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(deps.probeTimeoutMs),
      })
      res.body?.cancel().catch(() => {})
      return res.ok
    } catch {
      return false
    }
  }

  async function probeAll(): Promise<Answer> {
    const [langfuse, grafana] = await Promise.all([
      probe(`${deps.upstreams.langfuse}${LANGFUSE_PATH}`),
      probe(`${deps.upstreams.grafana}${GRAFANA_PATH}`),
    ])
    return {ok: langfuse && grafana, langfuse, grafana}
  }

  async function answer(): Promise<Answer> {
    const now = deps.clock()
    if (cached && now - cached.at < deps.cacheMs) return cached.answer
    inFlight ??= probeAll()
      .then(result => {
        cached = {at: deps.clock(), answer: result}
        return result
      })
      .finally(() => {
        inFlight = undefined
      })
    return inFlight
  }

  return async req => {
    const url = new URL(req.url)
    if (url.pathname !== '/healthz') return new Response('not found', {status: 404})
    if (req.method !== 'GET') return new Response('method not allowed', {status: 405, headers: {allow: 'GET'}})
    const result = await answer()
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 503,
      headers: {'content-type': 'application/json', 'cache-control': 'no-store'},
    })
  }
}
