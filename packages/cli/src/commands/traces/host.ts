// ─── Traces host validation and resolution ────────────────────────────────────
//
// Validates TRACES_HOST values before they are passed as ssh argv arguments.
// A value starting with `-` would be interpreted by ssh as an option flag,
// enabling ProxyCommand injection and local code execution.
//
// This is the CLI-side copy. The deploy-side validator and the host layout live in apps/traces/src/host.ts;
// `packages/` never imports `apps/`, and a test pins the repeated constants to that file.

const VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i

/**
 * Validates a candidate TRACES_HOST value against a strict hostname allowlist.
 *
 * Accepts: hostnames, FQDNs, IPv4 addresses, `localhost`.
 * Rejects: empty strings, values starting with `-`, and anything containing
 * characters outside `[A-Za-z0-9.-]`.
 *
 * @throws {Error} when empty or not a valid hostname. The rejected value is
 *   never included in the message (it may be a misdirected secret).
 * @returns The validated host string (unchanged).
 */
export function validateTracesHost(host: string): string {
  if (!host) {
    throw new Error('Invalid TRACES_HOST: value is empty')
  }

  if (!VALID_HOST_RE.test(host)) {
    // Do NOT echo the value: it may be a secret that was redirected via --key.
    throw new Error(
      `Invalid TRACES_HOST: value is not a valid hostname (must match ${String.raw`[A-Za-z0-9][A-Za-z0-9.\-]*`})`,
    )
  }

  return host
}

/** The one public hostname: ingest and the health path. */
export const TRACES_DEFAULT_HOST = 'traces.fro.bot'

/** The app directory on the host (compose file, `.env`, configs, secrets); pinned to `TRACES_APP_DIR` in apps/traces. */
export const TRACES_APP_DIR = '/mnt/traces/app'

/** The sender groups; pinned to `SENDER_GROUPS` in apps/traces. */
export const TRACES_GROUPS = ['marcusrbrown', 'fro-bot', 'workstation'] as const

/** The compose services, which `traces logs` accepts; pinned to the compose file by a test. */
export const TRACES_SERVICES = [
  'caddy',
  'collector',
  'langfuse-web',
  'langfuse-worker',
  'clickhouse',
  'minio',
  'redis',
  'postgres',
  'tempo',
  'grafana',
  'health-reporter',
] as const

export type TracesService = (typeof TRACES_SERVICES)[number]

/** Loopback ports on the host that the tunnel forwards. Langfuse's and Grafana's configured URLs fix both. */
export const TUNNEL_PORTS = {langfuse: 3000, grafana: 3001} as const

export interface HostEnv {
  [key: string]: string | undefined
}

/**
 * The SSH host: the `--key` environment variable if given, else TRACES_HOST, else the public hostname.
 * The result is validated, so a bad value never reaches an ssh argv.
 */
export function resolveTracesHost(env: HostEnv, keyName?: string): string {
  const name = keyName ?? 'TRACES_HOST'
  return validateTracesHost(env[name] ?? TRACES_DEFAULT_HOST)
}

/** The origin senders and the operator reach from outside: `https://` plus a validated hostname. */
export function resolveTracesOrigin(env: HostEnv): string {
  return `https://${validateTracesHost(env.TRACES_DOMAIN ?? TRACES_DEFAULT_HOST)}`
}
