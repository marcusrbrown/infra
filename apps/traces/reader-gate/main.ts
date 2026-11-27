// Service entrypoint: `bun /app/main.ts`. It wires the real file reads, fetch, clock and timers into the handlers and
// opens two listeners:
//
//   0.0.0.0:8090   the proxy, reached from Caddy
//   0.0.0.0:8091   GET /healthz, per-upstream reachability, no secrets
//
// The health listener opens first and does not depend on the token file, the credential file or either upstream, so
// the compose healthcheck (which counts any HTTP answer as healthy) stays green while the gate is set up or an upstream
// is down. The gate has no other listener and no metrics port. Not started by any test.

import type {CredentialEvent} from './credentials'
import type {StoreEvent} from './tokens'
import {loadConfig} from './config'
import {DEADLINE_MS, HEALTH, IDLE_TIMEOUT_S, LIMITS, PORTS, RESPONSE_DEADLINE_MS} from './constants'
import {createCredentialStore} from './credentials'
import {createHealthHandler} from './health'
import {readTextFile} from './io'
import {createLimits} from './limits'
import {createServer} from './server'
import {createTokenStore, startReloading} from './tokens'

function log(event: object): void {
  process.stdout.write(`${JSON.stringify({ts: new Date().toISOString(), ...event})}\n`)
}

export async function start(env: Record<string, string | undefined> = process.env): Promise<void> {
  const config = loadConfig(env)
  const upstreams = {langfuse: config.langfuseUpstream, grafana: config.grafanaMcpUpstream}

  Bun.serve({
    port: PORTS.health,
    hostname: '0.0.0.0',
    fetch: createHealthHandler({
      fetch: (url, init) => fetch(url, init),
      upstreams,
      clock: () => Date.now(),
      cacheMs: HEALTH.cacheMs,
      probeTimeoutMs: HEALTH.probeTimeoutMs,
    }),
  })

  const store = createTokenStore({
    path: config.tokenFile,
    readText: readTextFile,
    log: (event: StoreEvent) => log(event),
  })
  const credentials = createCredentialStore({
    path: config.langfuseBasicFile,
    readText: readTextFile,
    log: (event: CredentialEvent) => log(event),
  })
  const timers = {
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (handle: unknown) => clearInterval(handle as Timer),
  }
  startReloading(store, timers)
  startReloading(credentials, timers)
  await Promise.all([store.refresh(), credentials.refresh()])

  const handler = createServer({
    store,
    credentials: {langfuse: credentials.current},
    limits: createLimits({
      clock: () => Date.now(),
      requestsPerWindow: LIMITS.requestsPerWindow,
      windowMs: LIMITS.windowMs,
      perConsumerConcurrency: LIMITS.perConsumerConcurrency,
      globalConcurrency: LIMITS.globalConcurrency,
    }),
    fetch: (url, init) => fetch(url, init),
    clock: () => Date.now(),
    schedule: (fn, ms) => {
      const handle = setTimeout(fn, ms)
      return () => clearTimeout(handle)
    },
    upstreams,
    log: event => log(event),
    deadlines: {headersMs: DEADLINE_MS, responseMs: RESPONSE_DEADLINE_MS, maxBodyBytes: LIMITS.maxBodyBytes},
  })

  Bun.serve({
    port: PORTS.proxy,
    hostname: '0.0.0.0',
    idleTimeout: IDLE_TIMEOUT_S,
    maxRequestBodySize: LIMITS.maxBodyBytes,
    fetch: handler,
  })
  log({type: 'reader-gate-start', proxy: PORTS.proxy, health: PORTS.health})
}

if (import.meta.main) {
  await start()
}
