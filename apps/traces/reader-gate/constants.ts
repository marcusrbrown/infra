// Fixed names, limits and deadlines for the reader gate. The gate runs from a read-only bind mount with no install
// step, so every file here imports only Bun and Node built-ins and its own siblings. The copies of host constants
// below are pinned to `apps/traces/src/host.ts` by a test where the host defines them.

export const PORTS = {proxy: 8090, health: 8091} as const

/** Prefix of a void token line; pinned to `TRACES_VOID_TOKEN_PREFIX` in `host.ts`. */
export const VOID_TOKEN_PREFIX = 'trc_void_'

/** What the deploy writes before the operator installs a real credential. */
export const LANGFUSE_PLACEHOLDER = 'pk-lf-unset:sk-lf-unset'
export const GRAFANA_PLACEHOLDER = 'glsa_unset'

export const CONSUMER_PATTERN = /^[a-z][a-z0-9-]{0,30}$/

/** How often the token file and the credential file are read again. A revoked token is refused within about this long. */
export const RELOAD_INTERVAL_MS = 1000

/** Time the upstream has to send response headers. After it the gate answers 504. Caddy's timeouts must exceed it. */
export const DEADLINE_MS = 60_000

/** Time from the start of the request to the end of the response body. Frees a slot held by a stalled body. */
export const RESPONSE_DEADLINE_MS = 90_000

/** Bun idle timeout in seconds. It must outlast the wait for response headers. */
export const IDLE_TIMEOUT_S = 80

/** Starting values; size them from one representative weekly query against the live stack. */
export const LIMITS = {
  /** Requests per consumer per window, across both routes. */
  requestsPerWindow: 120,
  windowMs: 60_000,
  perConsumerConcurrency: 4,
  globalConcurrency: 8,
  /** Largest request body forwarded. */
  maxBodyBytes: 1_048_576,
  /** Largest query string forwarded. */
  maxQueryBytes: 4096,
} as const

/** Retry-After for a concurrency refusal: a slot frees when a running request ends. */
export const CONCURRENCY_RETRY_AFTER_S = 2

export const HEALTH = {
  /** Time a health probe waits for an upstream. */
  probeTimeoutMs: 3000,
  /** How long a health answer is reused, so the endpoint cannot be used to load the upstreams. */
  cacheMs: 5000,
} as const

/** Time the private check waits for each upstream request. */
export const CHECK_TIMEOUT_MS = 15_000

export const DEFAULTS = {
  tokenFile: '/run/readers/token',
  langfuseBasicFile: '/run/secrets/reader-gate/langfuse-basic',
  langfuseUpstream: 'http://langfuse-web:3000',
  grafanaMcpUpstream: 'http://grafana-mcp:8000',
} as const
