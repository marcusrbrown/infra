#!/usr/bin/env bun

import {Buffer} from 'node:buffer'
import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {validateGatewayHost} from './host'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  GATEWAY_HOST: string
}

export interface SecretFile {
  name: string
  content: string
  required: boolean
}

export interface UpstreamPin {
  repo: string
  ref: string
}

export interface PollRegistrationOpts {
  applicationId: string
  guildId: string
  token: string
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  maxAttempts?: number
  intervalMs?: number
  perAttemptTimeoutMs?: number
}

/** Minimal subset of Bun.Subprocess used by this script. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {write: (data: Uint8Array) => void; end: () => void}
  exited: Promise<number>
}

export interface SpawnOpts {
  env: DeployEnv
  stdout: 'pipe'
  stderr: 'pipe'
  stdin?: 'pipe'
}

/** Injectable spawn function — defaults to Bun.spawn. */
export type SpawnFn = (cmd: string[], opts: SpawnOpts) => SpawnResult

export interface MainOpts {
  env?: Record<string, string>
  args?: string[]
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  spawn?: SpawnFn
  maxAttempts?: number
  intervalMs?: number
  /** Number of HTTPS ingress probe attempts when announce is enabled (default: 5). */
  probeAttempts?: number
  /** Interval between probe attempts in ms when announce is enabled (default: 3_000). */
  probeIntervalMs?: number
  /** Per-attempt timeout in ms for the HTTPS ingress probe (default: 5_000). */
  probePerAttemptTimeoutMs?: number
}

export interface DeployArgs {
  dryRun: boolean
  forceRecreate: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REMOTE_DIR = '/opt/gateway'

/**
 * The Docker Compose project name for the gateway stack.
 * Derived from `name: fro-bot` in the upstream fro-bot/agent compose.yaml.
 * Docker Compose prefixes network names with the project name, so the
 * gateway-net network is `fro-bot_gateway-net` on the remote host.
 */
export const COMPOSE_PROJECT_NAME = 'fro-bot'

/**
 * The expected gateway-net subnet after the 172.20→172.21 migration.
 * Any existing network with a different subnet is stale and must be removed
 * before `docker compose pull/up` to prevent Docker IPAM pool overlap errors.
 */
export const GATEWAY_NET_EXPECTED_SUBNET = '172.21.0.0/16'

/**
 * The fully-qualified Docker network name for the gateway-net network.
 * Format: `<project>_<network-key>` where project = COMPOSE_PROJECT_NAME.
 */
export const GATEWAY_NET_FULL_NAME = `${COMPOSE_PROJECT_NAME}_gateway-net`

/**
 * Static container names for the gateway and caddy services in this compose project.
 * Docker Compose names containers as `<project>-<service>-<replica>` (default replica = 1).
 * These are used for direct `docker rm -f` endpoint release because `docker compose rm`
 * requires the service to be present in the current compose config — caddy may be absent
 * when announce/operator is disabled, leaving orphan caddy containers from a prior deploy.
 */
export const GATEWAY_CONTAINER_NAME = `${COMPOSE_PROJECT_NAME}-gateway-1`
export const CADDY_CONTAINER_NAME = `${COMPOSE_PROJECT_NAME}-caddy-1`

// Announce secret file names (kebab-case, matching upstream compose contract).
// Referenced from both buildSecretFileList (content) and buildComposeOverride (bind-mount source).
export const ANNOUNCE_WEBHOOK_SECRET_FILE = 'gateway-webhook-secret'
export const ANNOUNCE_PRESENCE_CHANNEL_FILE = 'gateway-presence-channel-id'

/**
 * Operator auth/config secret specs — single source of truth for the four operator auth secrets.
 *
 * Each entry carries:
 *   - envKey:        the environment variable name (SCREAMING_SNAKE_CASE)
 *   - hostFile:      the kebab-case file name written to the droplet secrets dir
 *   - containerPath: the snake_case path inside the container (/run/secrets/<snake_case>)
 *
 * Used in buildSecretFileList (content materialization), main() buildComposeOverride call
 * (file-name args), and buildComposeOverride (bind-mount source/target).
 */
export const OPERATOR_AUTH_SECRET_SPECS = [
  {
    envKey: 'GATEWAY_OPERATOR_GITHUB_CLIENT_ID',
    hostFile: 'gateway-operator-github-client-id',
    containerPath: '/run/secrets/gateway_operator_github_client_id',
  },
  {
    envKey: 'GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET',
    hostFile: 'gateway-operator-github-client-secret',
    containerPath: '/run/secrets/gateway_operator_github_client_secret',
  },
  {
    envKey: 'GATEWAY_OPERATOR_CSRF_SECRET',
    hostFile: 'gateway-operator-csrf-secret',
    containerPath: '/run/secrets/gateway_operator_csrf_secret',
  },
  {
    envKey: 'GATEWAY_OPERATOR_ALLOWLIST',
    hostFile: 'gateway-operator-allowlist',
    containerPath: '/run/secrets/gateway_operator_allowlist',
  },
] as const
const DEPLOY_DIR = `${REMOTE_DIR}/deploy`
const SECRETS_DIR = `${DEPLOY_DIR}/secrets`
// Checksum lives OUTSIDE deploy/ so git clean -xfd doesn't destroy it
const CHECKSUM_PATH = `${REMOTE_DIR}/.secrets-checksum`
const ENV_PATH = `${DEPLOY_DIR}/.env`
const DEFAULT_REMOTE_USER = 'root'
const CLIPROXY_EGRESS_HOST = 'cliproxy.fro.bot'
// OpenCode fetches its model catalog from models.dev at startup; the sandboxed workspace reaches it through the mitmproxy egress allowlist.
const OPENCODE_CATALOG_HOST = 'models.dev'

/**
 * RFC1123 label: lowercase letters, digits, hyphens; 1-63 chars; no leading/trailing hyphen.
 * Uppercase is rejected up front to avoid mitmproxy normalization surprises.
 */
const RFC1123_LABEL_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'S3_BUCKET',
  'S3_REGION',
  'GATEWAY_HOST',
  'GH_APP_ID',
  'GH_APP_PRIVATE_KEY',
  'WORKSPACE_OPENCODE_TOKEN',
  'WORKSPACE_OPENCODE_AUTH',
  'GATEWAY_TRIGGER_ROLE_ID',
] as const

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Validates required environment variables are present and non-empty.
 * Returns the list of missing variable names.
 * GATEWAY_SSH_KEY is required only when CI=true.
 *
 * Empty and whitespace-only values are treated as missing — this is the
 * fail-closed gate for security-sensitive vars like GATEWAY_TRIGGER_ROLE_ID
 * (an empty value would open the mention loop to all guild members).
 */
export function validateRequiredEnv(env: Record<string, string>): string[] {
  const missing: string[] = []

  for (const key of REQUIRED_ENV_VARS) {
    if (!env[key]?.trim()) {
      missing.push(key)
    }
  }

  if (env.CI === 'true' && !env.GATEWAY_SSH_KEY?.trim()) {
    missing.push('GATEWAY_SSH_KEY')
  }

  return missing
}

/**
 * Narrows a validated env record to a typed object with required keys as non-optional strings.
 * Assumes validateRequiredEnv(env) === [] has already been called.
 */
export interface ValidatedDeployEnv {
  GATEWAY_HOST: string
  DISCORD_TOKEN: string
  DISCORD_APPLICATION_ID: string
  DISCORD_GUILD_ID: string
  S3_BUCKET: string
  S3_REGION: string
  AWS_ACCESS_KEY_ID: string
  AWS_SECRET_ACCESS_KEY: string
  GH_APP_ID: string
  GH_APP_PRIVATE_KEY: string
}

export function narrowValidatedEnv(env: Record<string, string>): ValidatedDeployEnv {
  return {
    GATEWAY_HOST: env.GATEWAY_HOST as string,
    DISCORD_TOKEN: env.DISCORD_TOKEN as string,
    DISCORD_APPLICATION_ID: env.DISCORD_APPLICATION_ID as string,
    DISCORD_GUILD_ID: env.DISCORD_GUILD_ID as string,
    S3_BUCKET: env.S3_BUCKET as string,
    S3_REGION: env.S3_REGION as string,
    AWS_ACCESS_KEY_ID: env.AWS_ACCESS_KEY_ID as string,
    AWS_SECRET_ACCESS_KEY: env.AWS_SECRET_ACCESS_KEY as string,
    GH_APP_ID: env.GH_APP_ID as string,
    GH_APP_PRIVATE_KEY: env.GH_APP_PRIVATE_KEY as string,
  }
}

/**
 * Reads apps/gateway/upstream.json and returns { repo, ref }.
 * Throws on missing or malformed file.
 * Path is parameterizable for tests.
 */
export function resolveUpstreamPin(jsonPath?: string): UpstreamPin {
  const path = jsonPath ?? resolve(import.meta.dir, '..', 'upstream.json')

  let raw: string
  try {
    raw = readFileSync(path, 'utf-8')
  } catch {
    throw new Error(`Cannot read upstream.json at ${path}`)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`upstream.json at ${path} is not valid JSON`)
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as Record<string, unknown>).repo !== 'string' ||
    typeof (parsed as Record<string, unknown>).ref !== 'string'
  ) {
    throw new Error(`upstream.json at ${path} must have string fields "repo" and "ref"`)
  }

  const {repo, ref} = parsed as {repo: string; ref: string}
  return {repo, ref}
}

/**
 * Allow-list regex for WORKSPACE_OPENCODE_MODEL.
 * Accepts: letters, digits, dots, hyphens, underscores, and exactly one slash.
 * Rejects: whitespace, #, =, and any other character outside the safe set.
 */
const MODEL_ALLOWLIST_RE = /^[\w.-]+\/[\w.-]+$/

/**
 * Returns the operator listener state based on the presence of all three operator inputs.
 *
 * - 'enabled':  all three vars (GATEWAY_OPERATOR_BIND_HOST, GATEWAY_OPERATOR_BIND_PORT,
 *               GATEWAY_OPERATOR_PUBLIC_ORIGIN) are present and non-empty.
 * - 'disabled': all three are absent (unset or whitespace-only).
 * - 'invalid':  one or two are present — the all-or-none gate is violated.
 *
 * Mirrors the empty/whitespace-only = absent semantics used by validateRequiredEnv.
 */
export function getOperatorState(env: Record<string, string>): 'enabled' | 'disabled' | 'invalid' {
  const hasBindHost = Boolean(env.GATEWAY_OPERATOR_BIND_HOST?.trim())
  const hasBindPort = Boolean(env.GATEWAY_OPERATOR_BIND_PORT?.trim())
  const hasPublicOrigin = Boolean(env.GATEWAY_OPERATOR_PUBLIC_ORIGIN?.trim())

  const count = [hasBindHost, hasBindPort, hasPublicOrigin].filter(Boolean).length

  if (count === 3) return 'enabled'
  if (count === 0) return 'disabled'
  return 'invalid'
}

/**
 * Validates the operator listener configuration values.
 * Throws with a descriptive message when any value is unsafe or invalid.
 *
 * Rejection rules (mirrors upstream deploy/validate-stack.sh):
 *   - bindHost: rejects 0.0.0.0 (all-interface), 127.x (loopback), 10.x (sandbox-net), IPv6
 *   - bindPort: must be a positive integer in [1, 65535]
 *   - publicOrigin: must be a valid bare HTTPS origin (no path, query, hash, or credentials).
 *     The ratified production convention is https://dashboard.fro.bot, but the validator enforces
 *     URL safety only — any valid bare HTTPS origin is accepted. The host convention is documented
 *     in AGENTS.md and enforced by operator practice, not by this function.
 */
export function validateOperatorConfig(opts: {
  bindHost: string
  bindPort: string
  publicOrigin: string
  /** The expected gateway hostname (GATEWAY_HOST). Accepted for API compatibility; no hostname constraint is enforced. */
  gatewayHost?: string
}): void {
  const {bindHost, bindPort, publicOrigin} = opts

  // Validate bind host
  if (!bindHost) {
    throw new Error('GATEWAY_OPERATOR_BIND_HOST is required when operator listener is enabled.')
  }

  // Reject IP:port format (contains colon but is not IPv6 — e.g. 172.21.0.2:9300)
  // Check this before the IPv6 check to give a more accurate error message.
  if (bindHost.includes(':')) {
    // Distinguish IPv6 (multiple colons or starts with ::) from IP:port (single colon, starts with digit)
    const colonCount = (bindHost.match(/:/g) ?? []).length
    if (colonCount === 1 && /^\d/.test(bindHost)) {
      throw new Error(
        `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" contains a colon — this looks like an IP:port format. ` +
          'Provide only the IPv4 address without a port (e.g. 172.21.0.2). ' +
          'The port is configured separately via GATEWAY_OPERATOR_BIND_PORT.',
      )
    }
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is an IPv6 address. ` +
        'Only IPv4 gateway-net addresses are supported (e.g. 172.21.0.2).',
    )
  }

  // Reject all-interface bind
  if (bindHost === '0.0.0.0') {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is an all-interface bind (0.0.0.0). ` +
        'Use a specific gateway-net IPv4 address (e.g. 172.21.0.2).',
    )
  }

  // Reject loopback (127.x.x.x)
  if (bindHost.startsWith('127.')) {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is a loopback address. ` +
        'The operator listener must bind to a gateway-net address, not loopback.',
    )
  }

  // Reject sandbox-net (10.x.x.x)
  if (bindHost.startsWith('10.')) {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is in the sandbox-net range (10.0.0.0/8). ` +
        'The operator listener must bind to a gateway-net address, not sandbox-net.',
    )
  }

  // Reject 172.20.x.x — this is the known conflicted Docker subnet from the failed operator deploy.
  // The live fro-bot_sandbox-net is declared without explicit IPAM; Docker may allocate from the
  // default bridge address pools, and the failed deploy showed a live/default-pool collision with
  // 172.20.0.0/16. gateway-net uses 172.21.0.0/16 to avoid reusing that conflicted subnet.
  if (bindHost.startsWith('172.20.')) {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is in the 172.20.0.0/16 range. ` +
        '172.20.0.0/16 is the known conflicted Docker subnet from the failed operator deploy — ' +
        'gateway-net uses 172.21.0.0/16 to avoid reusing it. ' +
        'The operator listener must bind to a gateway-net IPv4 address in the 172.21.x.x range ' +
        '(e.g. 172.21.0.2).',
    )
  }

  // Validate bind host is inside gateway-net (172.21.0.0/16).
  // The gateway-net subnet is 172.21.0.0/16 — only 172.21.x.x addresses are valid.
  // This rejects addresses outside the gateway-net range (e.g. 172.22.x.x, 192.168.x.x).
  if (!bindHost.startsWith('172.21.')) {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_HOST "${bindHost}" is not in the gateway-net subnet (172.21.0.0/16). ` +
        'The operator listener must bind to a gateway-net IPv4 address in the 172.21.x.x range ' +
        '(e.g. 172.21.0.2).',
    )
  }

  // Validate port
  if (!bindPort) {
    throw new Error('GATEWAY_OPERATOR_BIND_PORT is required when operator listener is enabled.')
  }

  const parsedPort = Number(bindPort)
  if (
    !Number.isFinite(parsedPort) ||
    !Number.isInteger(parsedPort) ||
    parsedPort < 1 ||
    parsedPort > 65535 ||
    String(parsedPort) !== bindPort.trim()
  ) {
    throw new Error(
      `GATEWAY_OPERATOR_BIND_PORT "${bindPort}" is invalid. ` +
        'Must be a positive integer in [1, 65535] (e.g. "9300").',
    )
  }

  // Validate public origin
  if (!publicOrigin) {
    throw new Error('GATEWAY_OPERATOR_PUBLIC_ORIGIN is required when operator listener is enabled.')
  }

  let parsedOrigin: URL
  try {
    parsedOrigin = new URL(publicOrigin)
  } catch {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" is not a valid URL. ` +
        'Must be a valid HTTPS origin (e.g. "https://dashboard.fro.bot").',
    )
  }

  if (parsedOrigin.protocol !== 'https:') {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" must use https (got "${parsedOrigin.protocol.replace(':', '')}"). ` +
        'The operator listener public origin must be an HTTPS URL.',
    )
  }

  // Reject credentials (username/password) in the origin
  if (parsedOrigin.username || parsedOrigin.password) {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" must not contain credentials (username/password). ` +
        'Must be a bare HTTPS origin (e.g. "https://dashboard.fro.bot").',
    )
  }

  // Reject non-root pathname (must be exactly "/" — the URL constructor normalizes bare host to "/")
  if (parsedOrigin.pathname !== '/') {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" must not contain a path. ` +
        'Must be a bare HTTPS origin with no path, query, or fragment (e.g. "https://dashboard.fro.bot").',
    )
  }

  // Reject query string
  if (parsedOrigin.search) {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" must not contain a query string. ` +
        'Must be a bare HTTPS origin (e.g. "https://dashboard.fro.bot").',
    )
  }

  // Reject hash/fragment
  if (parsedOrigin.hash) {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" must not contain a hash/fragment. ` +
        'Must be a bare HTTPS origin (e.g. "https://dashboard.fro.bot").',
    )
  }

  // Reject explicit non-default HTTPS ports (anything other than 443 or the default).
  // The URL parser normalizes :443 away for https: (parsedOrigin.port === '' for both
  // https://host and https://host:443). Any non-empty port is a non-default port.
  // Current Caddy topology only supports the default HTTPS port (443).
  if (parsedOrigin.port !== '') {
    throw new Error(
      `GATEWAY_OPERATOR_PUBLIC_ORIGIN "${publicOrigin}" specifies a non-default port (:${parsedOrigin.port}). ` +
        'Only the default HTTPS port (443) is supported by the current Caddy topology. ' +
        'Use a bare HTTPS origin without an explicit port (e.g. "https://dashboard.fro.bot").',
    )
  }
}

/**
 * Returns the announce state based on the presence of both announce inputs.
 *
 * - 'enabled':  both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID are
 *               present and non-empty (whitespace-only = absent).
 * - 'disabled': both are absent (unset or whitespace-only).
 * - 'invalid':  exactly one is present — the both-or-neither gate is violated.
 *
 * Mirrors the empty/whitespace-only = absent semantics used by validateRequiredEnv.
 */
export function getAnnounceState(env: Record<string, string>): 'enabled' | 'disabled' | 'invalid' {
  const hasWebhookSecret = Boolean(env.GATEWAY_WEBHOOK_SECRET?.trim())
  const hasChannelId = Boolean(env.GATEWAY_PRESENCE_CHANNEL_ID?.trim())

  if (hasWebhookSecret && hasChannelId) return 'enabled'
  if (!hasWebhookSecret && !hasChannelId) return 'disabled'
  return 'invalid'
}

/** Strict base64url character set: A-Z, a-z, 0-9, -, _ (no padding, no whitespace). */
const BASE64URL_RE = /^[\w-]+$/

/**
 * Returns the operator auth/config state based on the presence of all four auth vars.
 *
 * - 'enabled':  all four vars are present and non-empty (whitespace-only = absent).
 * - 'disabled': all four are absent (unset or whitespace-only).
 * - 'invalid':  one to three are present — the all-or-none gate is violated.
 */
export function getOperatorAuthState(env: Record<string, string>): 'enabled' | 'disabled' | 'invalid' {
  const hasClientId = Boolean(env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID?.trim())
  const hasClientSecret = Boolean(env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET?.trim())
  const hasCsrfSecret = Boolean(env.GATEWAY_OPERATOR_CSRF_SECRET?.trim())
  const hasAllowlist = Boolean(env.GATEWAY_OPERATOR_ALLOWLIST?.trim())

  const count = [hasClientId, hasClientSecret, hasCsrfSecret, hasAllowlist].filter(Boolean).length

  if (count === 4) return 'enabled'
  if (count === 0) return 'disabled'
  return 'invalid'
}

/**
 * Validates the operator auth/config values.
 * Throws with a descriptive message on any validation failure.
 *
 * - githubClientId: non-empty string.
 * - githubClientSecret: non-empty string.
 * - csrfSecret: strict base64url (no padding, no whitespace/newlines), decoded byte length ≥ 32.
 * - allowlist: non-empty; blank/whitespace-only lines and full-line `#` comments (after optional
 *   leading whitespace) are ignored; at least one numeric GitHub user ID must remain after
 *   filtering; non-numeric non-comment lines are rejected. Mirrors upstream fro-bot/agent v0.69.0
 *   allowlist parser semantics.
 */
export function validateOperatorAuthConfig(opts: {
  githubClientId: string
  githubClientSecret: string
  csrfSecret: string
  allowlist: string
}): void {
  const {githubClientId, githubClientSecret, csrfSecret, allowlist} = opts

  if (!githubClientId) {
    throw new Error('GATEWAY_OPERATOR_GITHUB_CLIENT_ID is required and must be non-empty.')
  }

  if (!githubClientSecret) {
    throw new Error('GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET is required and must be non-empty.')
  }

  if (!csrfSecret) {
    throw new Error(
      'GATEWAY_OPERATOR_CSRF_SECRET is required. Must be strict base64url (no padding, no whitespace), decoded byte length ≥ 32.',
    )
  }

  if (!BASE64URL_RE.test(csrfSecret)) {
    throw new Error(
      `GATEWAY_OPERATOR_CSRF_SECRET contains invalid characters. ` +
        'Must be strict base64url: only A-Z, a-z, 0-9, -, _ (no padding =, no whitespace, no newlines).',
    )
  }

  // Decode and check byte length. base64url → base64 → Buffer.
  const base64 = csrfSecret.replaceAll('-', '+').replaceAll('_', '/')
  const decoded = Buffer.from(base64, 'base64')
  if (decoded.length < 32) {
    throw new Error(
      `GATEWAY_OPERATOR_CSRF_SECRET decodes to ${decoded.length} bytes; minimum is 32. ` +
        'Generate a 32-byte random value encoded as base64url (no padding).',
    )
  }

  if (!allowlist) {
    throw new Error('GATEWAY_OPERATOR_ALLOWLIST is required and must be non-empty.')
  }

  // Upstream fro-bot/agent v0.69.0 allowlist parser semantics:
  //   - blank/whitespace-only lines are ignored
  //   - full-line comments beginning with # (after optional whitespace) are ignored
  //   - at least one numeric GitHub user ID must remain after filtering
  const lines = allowlist.split('\n')
  let effectiveCount = 0
  for (const [i, line] of lines.entries()) {
    const trimmed = line.trim()
    // Skip blank/whitespace-only lines and full-line # comments
    if (trimmed === '' || trimmed.startsWith('#')) continue
    if (!/^\d+$/.test(trimmed)) {
      throw new Error(
        `GATEWAY_OPERATOR_ALLOWLIST line ${i + 1} "${line}" is not a numeric GitHub user ID. ` +
          'Each line must contain only digits.',
      )
    }
    effectiveCount++
  }

  if (effectiveCount === 0) {
    throw new Error(
      'GATEWAY_OPERATOR_ALLOWLIST contains no numeric GitHub user IDs after ignoring blank lines and comments. ' +
        'At least one numeric user ID is required.',
    )
  }
}

/**
 * Returns the VPC state based on the presence of both VPC IP vars.
 *
 * - 'enabled':  both GATEWAY_VPC_IP and DASHBOARD_VPC_IP are present and non-empty.
 * - 'disabled': both are absent (unset or whitespace-only).
 * - 'invalid':  exactly one is present — the all-or-none gate is violated.
 *
 * These vars are only meaningful when the operator listener is enabled.
 * Mirrors the empty/whitespace-only = absent semantics used by validateRequiredEnv.
 */
export function getOperatorVpcState(env: Record<string, string>): 'enabled' | 'disabled' | 'invalid' {
  const hasGatewayVpcIp = Boolean(env.GATEWAY_VPC_IP?.trim())
  const hasDashboardVpcIp = Boolean(env.DASHBOARD_VPC_IP?.trim())

  const count = [hasGatewayVpcIp, hasDashboardVpcIp].filter(Boolean).length

  if (count === 2) return 'enabled'
  if (count === 0) return 'disabled'
  return 'invalid'
}

/**
 * Validates a VPC IPv4 address value.
 * Throws with a descriptive message when the value is unsafe or invalid.
 *
 * Rejection rules:
 *   - Empty or whitespace-only: required.
 *   - Dash-prefixed: SSH flag injection risk (mirrors validateGatewayHost).
 *   - 0.0.0.0: all-interface bind — VPC IPs must be specific addresses.
 *   - Non-IPv4 format: must match dotted-decimal IPv4 (four octets, digits only).
 *   - IPv6 or IP:port format: not accepted.
 *
 * @param value - The raw value to validate.
 * @param varName - The env var name, used in error messages (e.g. 'GATEWAY_VPC_IP').
 */
export function validateVpcIp(value: string, varName: string): void {
  const trimmed = value.trim()

  if (!trimmed) {
    throw new Error(`${varName} is required but is empty or whitespace-only.`)
  }

  // Reject dash-prefixed values (SSH flag injection risk — mirrors validateGatewayHost).
  if (trimmed.startsWith('-')) {
    throw new Error(
      `${varName} "${trimmed}" starts with a dash. ` +
        'SSH treats dash-prefixed values as flags (including -oProxyCommand=). ' +
        'Provide a valid VPC IPv4 address (e.g. 10.116.0.3).',
    )
  }

  // Reject all-interface bind.
  if (trimmed === '0.0.0.0') {
    throw new Error(
      `${varName} "${trimmed}" is an all-interface address (0.0.0.0). ` +
        'Provide a specific VPC IPv4 address (e.g. 10.116.0.3).',
    )
  }

  // Reject IPv6 (contains colon but not a single-colon IP:port).
  if (trimmed.includes(':')) {
    const colonCount = (trimmed.match(/:/g) ?? []).length
    if (colonCount === 1 && /^\d/.test(trimmed)) {
      throw new Error(
        `${varName} "${trimmed}" contains a colon — this looks like an IP:port format. ` +
          'Provide only the IPv4 address without a port (e.g. 10.116.0.3).',
      )
    }
    throw new Error(
      `${varName} "${trimmed}" is an IPv6 address. ` + 'Only IPv4 VPC addresses are supported (e.g. 10.116.0.3).',
    )
  }

  // Require dotted-decimal IPv4 format: four groups of 1–3 digits, no trailing dot.
  if (!/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
    throw new Error(
      `${varName} "${trimmed}" is not a valid IPv4 address. ` +
        'Provide a dotted-decimal IPv4 address (e.g. 10.116.0.3).',
    )
  }
}

/**
 * Returns the list of missing WORKSPACE_OPENCODE_MODEL / WORKSPACE_OPENCODE_CONFIG
 * variable names. The name reflects what it returns — a list of missing vars.
 */
export function getMissingWorkspaceEnvVars(env: Record<string, string>): string[] {
  const missing: string[] = []
  if (!env.WORKSPACE_OPENCODE_MODEL?.trim()) {
    missing.push('WORKSPACE_OPENCODE_MODEL')
  }
  if (!env.WORKSPACE_OPENCODE_CONFIG?.trim()) {
    missing.push('WORKSPACE_OPENCODE_CONFIG')
  }
  return missing
}

/** Maximum allowed value for WORKSPACE_OPENCODE_READY_TIMEOUT_MS (10 minutes in ms). */
export const READY_TIMEOUT_MAX_MS = 600_000

/**
 * Validates WORKSPACE_OPENCODE_READY_TIMEOUT_MS.
 *
 * - Absent or exact empty string → returns undefined (upstream default of 60000 applies).
 * - Whitespace-only string → throws (malformed, not absent).
 * - Valid positive integer string in [1, 600000] → returns the parsed number.
 * - Non-numeric, zero, negative, float, above max, NaN, Infinity, or unsafe integer → throws.
 *
 * Mirrors upstream behavior: empty/absent uses default; non-numeric/zero/negative fails startup.
 */
export function validateReadyTimeout(value: string | undefined): number | undefined {
  if (value === undefined || value === '') return undefined

  const trimmed = value.trim()

  // Whitespace-only is malformed (not absent)
  if (trimmed === '') {
    throw new Error(
      `WORKSPACE_OPENCODE_READY_TIMEOUT_MS "${value}" is invalid (whitespace-only). ` +
        `Must be a positive integer in milliseconds between 1 and ${READY_TIMEOUT_MAX_MS} (e.g. "60000"), ` +
        'or absent/empty to use the upstream default of 60000ms.',
    )
  }

  const parsed = Number(trimmed)

  if (
    !Number.isFinite(parsed) ||
    !Number.isInteger(parsed) ||
    !Number.isSafeInteger(parsed) ||
    parsed <= 0 ||
    parsed > READY_TIMEOUT_MAX_MS ||
    String(parsed) !== trimmed
  ) {
    throw new Error(
      `WORKSPACE_OPENCODE_READY_TIMEOUT_MS "${value}" is invalid. ` +
        `Must be a positive integer in milliseconds between 1 and ${READY_TIMEOUT_MAX_MS} (e.g. "60000"). ` +
        'Absent or empty uses the upstream default of 60000ms. ' +
        'Zero, negative, non-integer, NaN, Infinity, unsafe integers, and values above the maximum are rejected.',
    )
  }

  return parsed
}

/**
 * Builds the contents of the remote .env file for the gateway deploy.
 *
 * WORKSPACE_OPENCODE_CONFIG encoding:
 *   The workspace compose.yaml reads this via ${WORKSPACE_OPENCODE_CONFIG:-}
 *   (docker-compose variable interpolation from .env). To prevent compose from
 *   expanding $ sequences inside the JSON value, every $ is doubled to $$.
 *   docker-compose converts $$ → $ when passing the value to the container,
 *   so the container receives the original JSON intact.
 *
 *   A shell metacharacter deny-list is NOT applied to CONFIG — valid JSON
 *   requires " $ \ which such a list would reject. Instead: JSON.parse
 *   structural check + no embedded newlines + size cap.
 *
 *   WORKSPACE_OPENCODE_MODEL is validated via MODEL_ALLOWLIST_RE — a positive
 *   allow-list that accepts only letters, digits, dots, hyphens, underscores,
 *   and exactly one slash (e.g. anthropic/claude-sonnet-4-6).
 *
 * WORKSPACE_OPENCODE_READY_TIMEOUT_MS (v0.53.1+):
 *   Optional. When set, emitted as-is so the workspace supervisor uses the
 *   operator-specified timeout instead of the upstream default (60000ms).
 *   Validated by validateReadyTimeout before reaching here; also validated
 *   directly here to guard against callers that bypass validateReadyTimeout.
 */
export function buildGatewayEnvFileContents(opts: {
  objectStoreHosts: string
  model: string
  config: string
  readyTimeoutMs?: number
}): string {
  const {objectStoreHosts, model, config, readyTimeoutMs} = opts

  // Validate model: positive allow-list — exactly one /, non-empty provider + model segments,
  // characters limited to letters, digits, dots, hyphens, underscores.
  // Rejects whitespace, #, =, and any char outside the safe set.
  if (!MODEL_ALLOWLIST_RE.test(model)) {
    throw new Error(
      `WORKSPACE_OPENCODE_MODEL "${model}" is not a valid provider/model identifier. ` +
        'Use the format "provider/model" with characters limited to letters, digits, dots, hyphens, and underscores ' +
        '(e.g. "anthropic/claude-sonnet-4-6" or "openai/gpt-5.5"). ' +
        'Whitespace, #, =, and other special characters are not allowed.',
    )
  }

  // Validate config: must be valid JSON, single-line, within size cap
  if (config.includes('\n') || config.includes('\r')) {
    throw new Error(
      'WORKSPACE_OPENCODE_CONFIG must not contain embedded newlines — it must be a single-line JSON value.',
    )
  }
  if (config.length > 16_384) {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG is too large (${config.length} bytes; max 16384). Reduce the config size before deploying.`,
    )
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(config)
  } catch {
    throw new Error(
      'WORKSPACE_OPENCODE_CONFIG is not valid JSON. Provide a valid JSON object (e.g. {"provider":{...}}).',
    )
  }

  // Reject non-plain-object values (null, arrays, primitives)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(
      'WORKSPACE_OPENCODE_CONFIG must be a JSON object (e.g. {"provider":{...}}), not a primitive, null, or array.',
    )
  }

  // Derive provider prefix from WORKSPACE_OPENCODE_MODEL (substring before the first /).
  // MODEL_ALLOWLIST_RE already guarantees exactly one '/' and non-empty segments,
  // so the split always produces a non-empty string at index 0.
  // Require config.provider[providerPrefix].options.baseURL to route through the cliproxy
  // egress proxy: a valid https URL whose host is exactly CLIPROXY_EGRESS_HOST and whose
  // path ends in /v1. This is the egress-routing security guard — a bare /v1 suffix check
  // is insufficient (https://api.openai.com/v1 would bypass the proxy).
  const providerPrefix = model.split('/')[0] ?? ''
  const configObj = parsed as Record<string, unknown>
  const providerEntry = (configObj.provider as Record<string, unknown> | undefined)?.[providerPrefix]
  const options = (providerEntry as Record<string, unknown> | undefined)?.options
  const baseURL = (options as Record<string, unknown> | undefined)?.baseURL

  if (typeof baseURL !== 'string' || !baseURL) {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG must include config.provider["${providerPrefix}"].options.baseURL ` +
        `as a non-empty string (e.g. "https://${CLIPROXY_EGRESS_HOST}/v1"). ` +
        'Without this, the workspace would bypass the cliproxy egress proxy and make direct upstream API calls.',
    )
  }

  let parsedURL: URL
  try {
    parsedURL = new URL(baseURL)
  } catch {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG provider["${providerPrefix}"].options.baseURL is not a valid URL: ${JSON.stringify(baseURL)}. ` +
        `Expected "https://${CLIPROXY_EGRESS_HOST}/v1".`,
    )
  }

  if (parsedURL.protocol !== 'https:') {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG provider["${providerPrefix}"].options.baseURL must use https (got ${JSON.stringify(parsedURL.protocol.replace(':', ''))}). ` +
        `Expected "https://${CLIPROXY_EGRESS_HOST}/v1".`,
    )
  }

  if (parsedURL.hostname !== CLIPROXY_EGRESS_HOST) {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG provider["${providerPrefix}"].options.baseURL must route through cliproxy.fro.bot ` +
        `(got ${JSON.stringify(parsedURL.hostname)}). Expected "https://${CLIPROXY_EGRESS_HOST}/v1".`,
    )
  }

  if (!baseURL.endsWith('/v1')) {
    throw new Error(
      `WORKSPACE_OPENCODE_CONFIG provider["${providerPrefix}"].options.baseURL must end in "/v1" ` +
        `(got ${JSON.stringify(baseURL)}). Expected "https://${CLIPROXY_EGRESS_HOST}/v1".`,
    )
  }

  // Escape $ → $$ so docker-compose interpolation does not expand $VAR sequences.
  // docker-compose converts $$ → $ when passing the value to the container.
  // Note: String.replaceAll('$', '$$') does NOT work — '$$' in a string replacement
  // is a special pattern meaning "insert a literal $", so it's a no-op. Use split/join.
  const escapedConfig = config.split('$').join('$$')

  // Validate readyTimeoutMs if provided — must be a safe positive integer within bounds.
  // validateReadyTimeout handles string input; here we guard the numeric form directly.
  if (
    readyTimeoutMs !== undefined &&
    (!Number.isFinite(readyTimeoutMs) ||
      !Number.isInteger(readyTimeoutMs) ||
      !Number.isSafeInteger(readyTimeoutMs) ||
      readyTimeoutMs <= 0 ||
      readyTimeoutMs > READY_TIMEOUT_MAX_MS)
  ) {
    throw new Error(
      `WORKSPACE_OPENCODE_READY_TIMEOUT_MS ${readyTimeoutMs} is invalid. ` +
        `Must be a positive integer in milliseconds between 1 and ${READY_TIMEOUT_MAX_MS}. ` +
        'Zero, negative, non-integer, NaN, Infinity, unsafe integers, and values above the maximum are rejected.',
    )
  }

  const readyTimeoutLine = readyTimeoutMs === undefined ? '' : `\nWORKSPACE_OPENCODE_READY_TIMEOUT_MS=${readyTimeoutMs}`

  return `OBJECT_STORE_HOSTS=${objectStoreHosts}\nWORKSPACE_OPENCODE_MODEL=${model}\nWORKSPACE_OPENCODE_CONFIG=${escapedConfig}\nWORKSPACE_EGRESS_HOSTS=${CLIPROXY_EGRESS_HOST},${OPENCODE_CATALOG_HOST}${readyTimeoutLine}\n`
}

/**
 * Computes the OBJECT_STORE_HOSTS value from env.
 * Priority:
 *   1. Explicit OBJECT_STORE_HOSTS override → verbatim
 *   2. S3_ENDPOINT set → object-store endpoint pattern: <bucket>.<endpoint-host>
 *   3. Default → AWS pattern: <bucket>.s3.<region>.amazonaws.com
 */
export function computeObjectStoreHosts(env: Record<string, string>): string {
  if (env.OBJECT_STORE_HOSTS) {
    return env.OBJECT_STORE_HOSTS
  }

  const bucket = env.S3_BUCKET ?? ''

  if (env.S3_ENDPOINT) {
    // S3 client uses forcePathStyle: true — requests go to hostname/bucket, not bucket.hostname.
    // Return hostname only (no bucket prefix) so mitmproxy allowlist matches the actual request host.
    const url = new URL(env.S3_ENDPOINT)
    return url.hostname
  }

  const region = env.S3_REGION ?? ''
  return `${bucket}.s3.${region}.amazonaws.com`
}

/**
 * Validates that OBJECT_STORE_HOSTS is a comma-separated list of RFC1123 hostnames.
 * Empty string is allowed (treated as "no override").
 * Throws with the offending host name when validation fails.
 *
 * Rules per label: [a-z0-9-], length 1-63, no leading/trailing hyphen.
 * Uppercase is rejected up front to avoid mitmproxy normalization surprises.
 */
export function validateObjectStoreHosts(value: string): void {
  if (!value) return

  const hosts = value.split(',').map(h => h.trim())

  for (const host of hosts) {
    if (!host) {
      throw new Error(`OBJECT_STORE_HOSTS contains an empty hostname (check for leading/trailing commas): "${value}"`)
    }

    const labels = host.split('.')

    for (const label of labels) {
      if (!label) {
        throw new Error(
          `OBJECT_STORE_HOSTS hostname "${host}" contains an empty label (double dot or leading/trailing dot): "${value}"`,
        )
      }

      if (!RFC1123_LABEL_RE.test(label)) {
        let reason: string
        if (/[A-Z]/.test(label)) {
          reason = 'contains uppercase letter (RFC1123 hostnames must be lowercase)'
        } else if (/_/.test(label)) {
          reason = 'contains underscore (not allowed in RFC1123 hostnames)'
        } else if (label.startsWith('-')) {
          reason = 'label starts with a hyphen'
        } else if (label.endsWith('-')) {
          reason = 'label ends with a hyphen'
        } else if (label.length > 63) {
          reason = `label exceeds 63 characters (${label.length} chars)`
        } else {
          reason = 'contains invalid characters (only [a-z0-9-] allowed per label)'
        }
        throw new Error(`OBJECT_STORE_HOSTS hostname "${host}" is invalid: ${reason}. Full value: "${value}"`)
      }
    }

    if (host.length > 253) {
      throw new Error(`OBJECT_STORE_HOSTS hostname "${host}" exceeds 253 characters. Full value: "${value}"`)
    }
  }
}

/**
 * Normalizes a PEM private key that may be stored single-line with literal `\n`
 * escape sequences (the convenient form for a .env file) into a real multi-line
 * PEM, and ensures a trailing newline.
 *
 * Safe for both sources: a valid PEM body is base64 + header/footer dashes and
 * never contains a literal backslash-n, so the unescape is a no-op for a value
 * that already has real newlines (e.g. a GitHub Environment secret). The trailing
 * newline also repairs GitHub Actions stripping trailing whitespace from secrets.
 */
export function normalizePemPrivateKey(value: string): string {
  if (!value) return value
  let normalized = value
  if (normalized.includes(String.raw`\n`)) {
    normalized = normalized.replaceAll(String.raw`\r\n`, '\n').replaceAll(String.raw`\n`, '\n')
  }
  if (!normalized.endsWith('\n')) {
    normalized = `${normalized}\n`
  }
  return normalized
}

/**
 * Builds the list of secret files to materialize on the droplet.
 * Required secrets get the actual value; optional secrets that are
 * unset get '' (empty placeholder).
 *
 * `github-app-private-key` is run through normalizePemPrivateKey so the PEM can
 * be supplied either as a real multi-line value (CI / GitHub Environment) or as
 * a single-line `\n`-escaped value (convenient in a local .env).
 */
export function buildSecretFileList(env: Record<string, string>): SecretFile[] {
  const required: {name: string; envKey: string; transform?: (value: string) => string}[] = [
    {name: 'discord-token', envKey: 'DISCORD_TOKEN'},
    {name: 'discord-application-id', envKey: 'DISCORD_APPLICATION_ID'},
    {name: 'discord-guild-id', envKey: 'DISCORD_GUILD_ID'},
    {name: 'aws-access-key-id', envKey: 'AWS_ACCESS_KEY_ID'},
    {name: 'aws-secret-access-key', envKey: 'AWS_SECRET_ACCESS_KEY'},
    {name: 's3-bucket', envKey: 'S3_BUCKET'},
    {name: 's3-region', envKey: 'S3_REGION'},
    {name: 'github-app-id', envKey: 'GH_APP_ID'},
    {name: 'github-app-private-key', envKey: 'GH_APP_PRIVATE_KEY', transform: normalizePemPrivateKey},
    {name: 'workspace-opencode-token', envKey: 'WORKSPACE_OPENCODE_TOKEN'},
    {name: 'workspace-opencode-auth', envKey: 'WORKSPACE_OPENCODE_AUTH'},
  ]

  const optional: {name: string; envKey: string; transform?: (value: string) => string}[] = [
    {name: 's3-endpoint', envKey: 'S3_ENDPOINT'},
    {name: 'aws-session-token', envKey: 'AWS_SESSION_TOKEN'},
    {name: 'discord-privileged-intents', envKey: 'DISCORD_PRIVILEGED_INTENTS'},
    {name: 'workspace-opencode-url', envKey: 'WORKSPACE_OPENCODE_URL'},
    // gateway-trigger-role-id: env var is in REQUIRED_ENV_VARS (fail-closed authz gate),
    // but the file-list entry is optional-shaped so an empty value writes an empty file
    // (upstream compose treats it as optional; we enforce non-empty via REQUIRED_ENV_VARS).
    {name: 'gateway-trigger-role-id', envKey: 'GATEWAY_TRIGGER_ROLE_ID'},
  ]

  const secrets: SecretFile[] = []

  for (const {name, envKey, transform} of required) {
    const raw = env[envKey] ?? ''
    secrets.push({name, content: transform ? transform(raw) : raw, required: true})
  }

  for (const {name, envKey, transform} of optional) {
    const raw = env[envKey] ?? ''
    secrets.push({name, content: transform ? transform(raw) : raw, required: false})
  }

  // Announce secret files: only materialized when BOTH inputs are present and non-empty.
  // When disabled (both absent), push neither. When invalid (exactly one set), main()
  // throws before reaching here, so this branch is never reached in that case.
  if (getAnnounceState(env) === 'enabled') {
    secrets.push({name: ANNOUNCE_WEBHOOK_SECRET_FILE, content: env.GATEWAY_WEBHOOK_SECRET ?? '', required: false})
    secrets.push({
      name: ANNOUNCE_PRESENCE_CHANNEL_FILE,
      content: env.GATEWAY_PRESENCE_CHANNEL_ID ?? '',
      required: false,
    })
  }

  // Operator auth/config secret files: only materialized when operator listener is enabled
  // AND all four auth/config vars are present. When operator is disabled, no auth files are
  // emitted. When invalid (partial set), main() throws before reaching here.
  if (getOperatorState(env) === 'enabled' && getOperatorAuthState(env) === 'enabled') {
    for (const spec of OPERATOR_AUTH_SECRET_SPECS) {
      secrets.push({
        name: spec.hostFile,
        content: env[spec.envKey] ?? '',
        required: false,
      })
    }
  }

  return secrets
}

/**
 * Computes a stable SHA-256 hex checksum over the secret file contents.
 * Order-sensitive: reordering inputs produces a different checksum.
 */
export function computeSecretsChecksum(secrets: SecretFile[]): string {
  const hasher = new Bun.CryptoHasher('sha256')
  for (const secret of secrets) {
    hasher.update(`${secret.name}:${secret.content}\n`)
  }
  return hasher.digest('hex')
}

// Pinned Caddy image digest — same as apps/cliproxy/docker-compose.yaml and apps/umami/docker-compose.yaml.
// Renovate tracks the digest in those files; keep in sync when Renovate bumps them.
const CADDY_IMAGE = 'caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794'

export interface ComposeOverrideOpts {
  /** Digest of the gateway image pushed to GHCR (e.g. "sha256:abc..."). */
  gatewayDigest: string
  /** Digest of the workspace image pushed to GHCR (e.g. "sha256:def..."). */
  workspaceDigest: string
  /** When true, adds the Caddy reverse proxy and announce secret wiring. */
  announceEnabled: boolean
  /**
   * When set, the validated ready timeout value (ms). Unused by the override itself —
   * the override always emits the Docker Compose interpolation expression
   * `${WORKSPACE_OPENCODE_READY_TIMEOUT_MS:-}` so the workspace container receives
   * the value from the .env file written by buildGatewayEnvFileContents.
   * Present in opts for documentation/traceability; the override expression is always emitted.
   */
  readyTimeoutMs?: number
  /**
   * When true, adds the operator listener env entries and static gateway-net IP to the
   * gateway service. Requires operatorBindHost, operatorBindPort, and operatorPublicOrigin.
   */
  operatorEnabled?: boolean
  /** The gateway-net IPv4 address for the operator listener bind host. */
  operatorBindHost?: string
  /** The operator listener port. */
  operatorBindPort?: string
  /** The HTTPS origin for the operator public surface (e.g. "https://operator.example.com"). */
  operatorPublicOrigin?: string
  /**
   * When true, emits the four operator auth _FILE env vars and bind mounts.
   * Requires all four operatorXxxFile fields to be non-empty.
   */
  operatorAuthEnabled?: boolean
  /** Kebab-case secret file name for the GitHub OAuth client ID. */
  operatorGithubClientIdFile?: string
  /** Kebab-case secret file name for the GitHub OAuth client secret. */
  operatorGithubClientSecretFile?: string
  /** Kebab-case secret file name for the CSRF secret. */
  operatorCsrfSecretFile?: string
  /** Kebab-case secret file name for the allowlist. */
  operatorAllowlistFile?: string
  /** Optional tuning: comma-separated same-origin post-auth paths. */
  operatorOauthAllowedReturnPaths?: string
  /** Optional tuning: OAuth state TTL in ms. */
  operatorOauthStateTtlMs?: string
  /** Optional tuning: max outstanding OAuth attempts. */
  operatorOauthMaxOutstandingAttempts?: string
  /**
   * The gateway's VPC IPv4 address (GATEWAY_VPC_IP). When set alongside operatorEnabled,
   * the gateway service publishes the operator listener port on this VPC IP only
   * (`${operatorVpcIp}:${operatorBindPort}:${operatorBindPort}`), never on 0.0.0.0.
   * The daemon stays bound to its gateway-net address (operatorBindHost); this is a
   * host-side Docker port publish, not a daemon rebind.
   */
  operatorVpcIp?: string
}

const GATEWAY_IMAGE_NAME = 'ghcr.io/marcusrbrown/infra-gateway'
const WORKSPACE_IMAGE_NAME = 'ghcr.io/marcusrbrown/infra-workspace'

/**
 * Builds the compose.override.yaml content.
 *
 * Always emits `image:` digest pins for the `gateway` and `workspace` services so
 * the droplet pulls the prebuilt GHCR artifacts and never builds from source.
 * Docker Compose deep-merges the override; the upstream `build:` stanzas remain
 * present but are inert without `--build`.
 *
 * When announceEnabled, also adds a path-scoped Caddy reverse proxy publishing
 * :80/:443 on gateway-net, plus the daemon's announce secret wiring.
 *
 * Docker Compose merges the gateway service's `volumes:` list by mount-target key —
 * new targets APPEND, same-target REPLACES. The two announce bind mounts added here
 * use new targets (/run/secrets/gateway_webhook_secret and
 * /run/secrets/gateway_presence_channel_id), so upstream's other secret mounts are
 * preserved unchanged.
 *
 * When announceEnabled is false, git clean -xfd removes any prior Caddyfile
 * automatically. The override file itself is always written (image pins are required
 * on every deploy). --remove-orphans retires the Caddy container when announce is
 * toggled off.
 */
export function buildComposeOverride(opts: ComposeOverrideOpts): string {
  const {
    gatewayDigest,
    workspaceDigest,
    announceEnabled,
    operatorEnabled,
    operatorBindHost,
    operatorBindPort,
    operatorPublicOrigin,
    operatorAuthEnabled,
    operatorGithubClientIdFile,
    operatorGithubClientSecretFile,
    operatorCsrfSecretFile,
    operatorAllowlistFile,
    operatorOauthAllowedReturnPaths,
    operatorOauthStateTtlMs,
    operatorOauthMaxOutstandingAttempts,
    operatorVpcIp,
  } = opts

  // Caddy is needed when either announce or operator is enabled.
  const caddyEnabled = announceEnabled || Boolean(operatorEnabled)

  // Build the gateway service environment section (announce + operator)
  const announceEnvLines = announceEnabled
    ? `      GATEWAY_WEBHOOK_SECRET_FILE: /run/secrets/gateway_webhook_secret
      GATEWAY_PRESENCE_CHANNEL_ID_FILE: /run/secrets/gateway_presence_channel_id`
    : ''

  const operatorEnvLines =
    operatorEnabled && operatorBindHost && operatorBindPort && operatorPublicOrigin
      ? `      GATEWAY_OPERATOR_BIND_HOST: ${operatorBindHost}
      GATEWAY_OPERATOR_BIND_PORT: ${operatorBindPort}
      GATEWAY_OPERATOR_PUBLIC_ORIGIN: ${operatorPublicOrigin}`
      : ''

  // Operator auth _FILE env vars: only emitted when operatorAuthEnabled is true.
  // All four file-name opts are required — missing/empty/whitespace-only is a programming bug; throw fast.
  if (operatorAuthEnabled) {
    const missing = (
      [
        ['operatorGithubClientIdFile', operatorGithubClientIdFile],
        ['operatorGithubClientSecretFile', operatorGithubClientSecretFile],
        ['operatorCsrfSecretFile', operatorCsrfSecretFile],
        ['operatorAllowlistFile', operatorAllowlistFile],
      ] as [string, string | undefined][]
    )
      .filter(([, v]) => !v?.trim())
      .map(([k]) => k)
    if (missing.length > 0) {
      throw new Error(
        `buildComposeOverride: operatorAuthEnabled is true but the following file-name opts are missing or empty: ${missing.join(', ')}`,
      )
    }
  }

  // Derive _FILE env vars from OPERATOR_AUTH_SECRET_SPECS — single source of truth for env key → container path.
  const operatorAuthFileLines = operatorAuthEnabled
    ? OPERATOR_AUTH_SECRET_SPECS.map(spec => `      ${spec.envKey}_FILE: ${spec.containerPath}`).join('\n')
    : ''

  // Optional tuning vars: plain env entries, only when present.
  const operatorOauthTuningLines = operatorAuthEnabled
    ? [
        operatorOauthAllowedReturnPaths
          ? `      GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS: ${operatorOauthAllowedReturnPaths}`
          : '',
        operatorOauthStateTtlMs ? `      GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS: ${operatorOauthStateTtlMs}` : '',
        operatorOauthMaxOutstandingAttempts
          ? `      GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS: ${operatorOauthMaxOutstandingAttempts}`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  const envLines = [announceEnvLines, operatorEnvLines, operatorAuthFileLines, operatorOauthTuningLines]
    .filter(Boolean)
    .join('\n')
  const environmentSection = envLines
    ? `
    environment:
${envLines}`
    : ''

  const announceVolumes = announceEnabled
    ? `
      - type: bind
        source: ./secrets/${ANNOUNCE_WEBHOOK_SECRET_FILE}
        target: /run/secrets/gateway_webhook_secret
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ./secrets/${ANNOUNCE_PRESENCE_CHANNEL_FILE}
        target: /run/secrets/gateway_presence_channel_id
        read_only: true
        bind:
          create_host_path: false`
    : ''

  // Operator auth bind mounts: only emitted when operatorAuthEnabled is true.
  // Derived from OPERATOR_AUTH_SECRET_SPECS — single source of truth for host file → container path.
  const operatorAuthVolumes = operatorAuthEnabled
    ? OPERATOR_AUTH_SECRET_SPECS.map(
        spec => `
      - type: bind
        source: ./secrets/${spec.hostFile}
        target: ${spec.containerPath}
        read_only: true
        bind:
          create_host_path: false`,
      ).join('')
    : ''

  const allVolumes = announceVolumes + operatorAuthVolumes
  const volumesSection2 = allVolumes
    ? `
    volumes:${allVolumes}`
    : ''

  // Static gateway-net IP for deterministic operator listener bind address.
  // When operator is enabled, the gateway service gets a static ipv4_address on gateway-net
  // so GATEWAY_OPERATOR_BIND_HOST is always a known, stable address.
  const gatewayNetworksSection =
    operatorEnabled && operatorBindHost
      ? `
    networks:
      gateway-net:
        ipv4_address: ${operatorBindHost}`
      : ''

  // VPC-scoped host port publish for the operator listener.
  // Published on the gateway's VPC IP only — never on 0.0.0.0 or all interfaces.
  // The daemon stays bound to its gateway-net address (operatorBindHost); this is a
  // host-side Docker port publish, not a daemon rebind.
  // Only emitted when operator is enabled AND the VPC IP is configured.
  const portsSection =
    operatorEnabled && operatorVpcIp && operatorBindPort
      ? `
    ports:
      - '${operatorVpcIp}:${operatorBindPort}:${operatorBindPort}'`
      : ''

  const caddySection = caddyEnabled
    ? `  caddy:
    image: ${CADDY_IMAGE}
    restart: unless-stopped
    ports:
      - '80:80'
      - '443:443'
    networks:
      - gateway-net
    volumes:
      - caddy_data:/data
      - caddy_config:/config
      - ./Caddyfile:/etc/caddy/Caddyfile:ro
    depends_on:
      - gateway
`
    : ''

  // workspace-repos is always declared — it persists cloned repo checkouts across
  // container recreation and daemon upgrades. `docker compose down -v` destroys it.
  // Caddy-enabled stacks (announce or operator) also declare caddy_data and caddy_config.
  const volumesSection = caddyEnabled
    ? `volumes:
  caddy_data:
  caddy_config:
  workspace-repos:
`
    : `volumes:
  workspace-repos:
`

  // When operator is enabled, declare a top-level networks section with explicit IPAM
  // so the static ipv4_address assignment has a deterministic subnet contract.
  // The /16 subnet covers the 172.21.x.x range used by the upstream gateway-net.
  // NOTE: 172.20.0.0/16 is intentionally NOT used here — it is the known conflicted Docker
  // subnet from the failed operator deploy. The upstream fro-bot_sandbox-net is declared without
  // explicit IPAM; Docker may allocate from the default bridge address pools, and the failed deploy
  // showed a live/default-pool collision with 172.20.0.0/16. Docker rejects overlapping IPAM pools
  // with "Pool overlaps with other one on this address space".
  const networksSection = operatorEnabled
    ? `networks:
  gateway-net:
    ipam:
      config:
        - subnet: 172.21.0.0/16
`
    : ''

  return `services:
  gateway:
    image: ${GATEWAY_IMAGE_NAME}@${gatewayDigest}${environmentSection}${volumesSection2}${portsSection}${gatewayNetworksSection}
  workspace:
    image: ${WORKSPACE_IMAGE_NAME}@${workspaceDigest}
    environment:
      WORKSPACE_OPENCODE_READY_TIMEOUT_MS: \${WORKSPACE_OPENCODE_READY_TIMEOUT_MS:-}
    volumes:
      - workspace-repos:/workspace/repos
${caddySection}${volumesSection}${networksSection}`
}

/**
 * Options for the Caddyfile route generation.
 */
export interface CaddyfileOperatorOpts {
  /**
   * When true, adds the /v1/announce route.
   * When false (or omitted), the /v1/announce route is NOT emitted.
   * For backward compatibility, when the entire opts object is omitted,
   * the legacy behavior (announce route present) is preserved.
   */
  announceEnabled?: boolean
  /** When true, adds the /operator/* route. */
  operatorEnabled: boolean
  /** The operator listener target (e.g. "172.21.0.2:9300"). */
  operatorTarget?: string
}

/**
 * Builds the Caddyfile content for the announce ingress and/or operator routing.
 *
 * Uses mutually-exclusive `handle` blocks so Caddy's directive-ordering cannot
 * reorder the catch-all respond 404 ahead of the reverse_proxy. The path-specific
 * handles are evaluated first (higher specificity), the catch-all last.
 *
 * ACME-safe: Caddy serves HTTP-01 challenges on :80 via an auto-injected route
 * ahead of user routes, and TLS-ALPN-01 on :443 never touches HTTP paths. The
 * catch-all 404 is inside the :443 host block and does not shadow ACME challenges.
 *
 * Route generation:
 *   - announce-only (announceEnabled=true, operatorEnabled=false): /v1/announce + catch-all
 *   - operator-only (announceEnabled=false, operatorEnabled=true): /operator/* + flush_interval -1 + catch-all
 *   - both: /v1/announce + /operator/* + catch-all
 *   - neither: not called by main() (no Caddy when both disabled)
 *
 * When opts is omitted entirely (legacy call), the /v1/announce route is emitted
 * for backward compatibility.
 *
 * @param host - The gateway hostname (GATEWAY_HOST env var, e.g. gateway.fro.bot)
 * @param opts - Optional routing config; when omitted, legacy announce-only behavior applies
 */
export function buildCaddyfile(host: string, opts?: CaddyfileOperatorOpts): string {
  // When opts is omitted entirely, preserve legacy behavior (announce route present).
  const announceEnabled = opts === undefined ? true : Boolean(opts.announceEnabled)
  const operatorEnabled = Boolean(opts?.operatorEnabled)

  const announceBlock = announceEnabled
    ? `  handle /v1/announce {
    reverse_proxy gateway:3000
  }
`
    : ''

  const operatorBlock =
    operatorEnabled && opts?.operatorTarget
      ? `  handle /operator/* {
    reverse_proxy ${opts.operatorTarget} {
      flush_interval -1
    }
  }
`
      : ''

  return `${host} {
${announceBlock}${operatorBlock}  handle {
    respond 404
  }
}
`
}

/**
 * Parses deploy CLI arguments into explicit booleans and rejects unknown flags.
 * Keeping this as a pure helper makes agent/CI invocations predictable instead
 * of silently ignoring a misspelled destructive-ish flag.
 */
export function parseDeployArgs(args: string[]): DeployArgs {
  const known = new Set(['--dry-run', '--force-recreate'])
  const unknown = args.filter(arg => !known.has(arg))

  if (unknown.length > 0) {
    throw new Error(`Unknown deploy argument(s): ${unknown.join(', ')}. Supported: --dry-run, --force-recreate`)
  }

  return {
    dryRun: args.includes('--dry-run'),
    forceRecreate: args.includes('--force-recreate'),
  }
}

/**
 * Sanitizes an error by replacing any occurrence of a secret value with a
 * redacted placeholder. Used to prevent secret leakage in spawn error messages.
 */
export function redactSecretsFromError(error: unknown, secrets: SecretFile[]): Error {
  const base = error instanceof Error ? error.message : String(error)
  let sanitized = base
  for (const secret of secrets) {
    if (secret.content) {
      // Escape the secret content for use in a regex
      const escaped = secret.content.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
      sanitized = sanitized.replaceAll(new RegExp(escaped, 'g'), `<redacted:${secret.name}>`)
    }
  }
  return new Error(sanitized)
}

/**
 * Asserts that the running container's RepoDigests include the expected digest.
 *
 * Pure helper — no SSH, no side effects. Throws with an actionable message when
 * the running image does not match the CI-pushed digest. Used after `docker compose up`
 * to confirm the droplet is running the prebuilt GHCR artifact, not a stale or
 * locally-built image.
 *
 * @param actualRepoDigests - Array of RepoDigest strings from `docker inspect --format '{{json .RepoDigests}}'`
 * @param expectedDigest - The sha256 digest that must appear in at least one entry (e.g. "sha256:abc...")
 * @param serviceName - Human-readable service name for error messages (e.g. "gateway", "workspace")
 */
export function assertRunningImageDigest(
  actualRepoDigests: string[],
  expectedDigest: string,
  serviceName: string,
): void {
  const matched = actualRepoDigests.some(d => d.includes(expectedDigest))
  if (!matched) {
    throw new Error(
      `Running ${serviceName} image digest does not match the expected CI-pushed digest.\n` +
        `  Expected: ${expectedDigest}\n` +
        `  Actual RepoDigests: ${actualRepoDigests.length > 0 ? actualRepoDigests.join(', ') : '(empty)'}\n` +
        `The droplet may be running a stale or locally-built image. ` +
        `Re-run the deploy to pull the correct GHCR artifact.`,
    )
  }
}

/**
 * Polls the Discord API for slash command registration.
 * Returns { commands: string[] } on success; throws on timeout.
 * Token is passed via Authorization header only — never in URLs or errors.
 *
 * Status handling:
 *   200 + non-empty commands → success
 *   200 + empty commands     → keep polling
 *   429                      → honor Retry-After header; abort if wait > 60s
 *   5xx                      → retry with normal interval; counts against maxAttempts
 *   401/403/404              → abort immediately (naming app/guild, never token)
 *   other 4xx                → abort immediately with status + IDs
 */
export async function pollRegistration(opts: PollRegistrationOpts): Promise<{commands: string[]}> {
  const {
    applicationId,
    guildId,
    token,
    fetch: fetchFn = globalThis.fetch,
    sleep = (ms: number) => new Promise(r => setTimeout(r, ms)),
    maxAttempts = 10,
    intervalMs = 3000,
    perAttemptTimeoutMs = Math.max(6000, intervalMs * 2),
  } = opts

  const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), perAttemptTimeoutMs)

    let response: Response
    try {
      response = await fetchFn(url, {
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        signal: ac.signal,
      })
    } catch (error) {
      clearTimeout(timer)
      // AbortError from per-attempt timeout — treat as transient, retry with normal backoff
      if (error instanceof Error && error.name === 'AbortError') {
        if (attempt < maxAttempts) {
          await sleep(intervalMs)
        }
        continue
      }
      throw error
    }
    clearTimeout(timer)

    const status = response.status

    if (status === 200) {
      const commands = (await response.json()) as {name: string}[]
      if (commands.length > 0) {
        return {commands: commands.map(c => c.name)}
      }
      // Empty list — keep polling
      if (attempt < maxAttempts) {
        await sleep(intervalMs)
      }
      continue
    }

    if (status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After')
      const retryAfterSec = retryAfterHeader ? Number.parseFloat(retryAfterHeader) : Number.NaN
      const retryAfterMs = Number.isFinite(retryAfterSec) ? retryAfterSec * 1000 : intervalMs

      if (retryAfterMs > 60_000) {
        throw new Error(
          `Discord rate-limit too long to wait (Retry-After: ${retryAfterSec}s) for application=${applicationId} guild=${guildId}`,
        )
      }

      // Don't count this attempt against maxAttempts — just wait and retry
      attempt--
      await sleep(retryAfterMs)
      continue
    }

    if (status >= 500) {
      // Transient server error — retry with normal interval
      if (attempt < maxAttempts) {
        await sleep(intervalMs)
      }
      continue
    }

    if (status === 401 || status === 403 || status === 404) {
      throw new Error(
        `Discord API returned HTTP ${status} for application=${applicationId} guild=${guildId}. ` +
          'Check that the bot token and application/guild IDs are correct.',
      )
    }

    // Other 4xx — abort immediately
    throw new Error(`Discord API returned HTTP ${status} for application=${applicationId} guild=${guildId}`)
  }

  throw new Error(
    `Slash command registration timed out after ${maxAttempts} attempts for application=${applicationId} guild=${guildId}`,
  )
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

/**
 * Returns the SSH option flags for the given key path.
 * When keyPath is set (CI mode): uses -i <path> + IdentitiesOnly=yes exclusively.
 * When keyPath is undefined (local mode): no -i flags; relies on SSH_AUTH_SOCK.
 */
function sshIdentityOptions(keyPath: string | undefined): string[] {
  if (keyPath) {
    return ['-i', keyPath, '-o', 'IdentitiesOnly=yes']
  }
  return []
}

function sshCommand(host: string, command: string, keyPath?: string, controlPath?: string): string[] {
  return [
    'ssh',
    ...sshIdentityOptions(keyPath),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    ...(controlPath
      ? ['-o', `ControlMaster=auto`, '-o', `ControlPath=${controlPath}`, '-o', `ControlPersist=300`]
      : []),
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}

function buildDeployEnv(env: Record<string, string>): DeployEnv {
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '/root',
    GATEWAY_HOST: env.GATEWAY_HOST ?? '',
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
  }
}

function defaultSpawn(cmd: string[], opts: SpawnOpts): SpawnResult {
  return Bun.spawn(cmd, opts)
}

async function runCommand(
  label: string,
  command: string[],
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
): Promise<{stdout: string; stderr: string}> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = spawnFn(command, {env: deployEnv, stdout: 'pipe', stderr: 'pipe'})

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }

  return {stdout, stderr}
}

/**
 * Writes content to a remote path via SSH stdin pipe.
 * The content is never placed in the shell command argv — it flows through stdin only.
 * On failure, any captured stderr/stdout is sanitized to remove secret values.
 */
async function writeRemoteFile(
  label: string,
  host: string,
  remotePath: string,
  content: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  secrets: SecretFile[],
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  // umask 077 ensures the file is created with 600 permissions.
  // Content arrives via stdin — never in the shell command string.
  const proc = spawnFn(sshCommand(host, `umask 077; cat > '${remotePath}'`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })

  if (!proc.stdin) {
    throw new Error(`Spawn did not provide stdin pipe for: ${label}`)
  }

  proc.stdin.write(new TextEncoder().encode(content))
  proc.stdin.end()

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    // Sanitize captured output before logging — it may contain secret bytes
    const sanitizedStderr = secrets.reduce(
      (acc, s) => (s.content ? acc.replaceAll(s.content, `<redacted:${s.name}>`) : acc),
      stderr.trim(),
    )
    if (sanitizedStderr) {
      console.error(sanitizedStderr)
    }
    const rawError = new Error(`Command failed with exit code ${exitCode}: ${label}`)
    throw redactSecretsFromError(rawError, secrets)
  }

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }
}

async function remoteGitExists(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<boolean> {
  const proc = spawnFn(sshCommand(host, `test -d '${REMOTE_DIR}/.git'`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

async function readRemoteChecksum(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<string> {
  const proc = spawnFn(sshCommand(host, `cat '${CHECKSUM_PATH}' 2>/dev/null || echo ''`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Failed to read remote checksum from ${CHECKSUM_PATH} (exit ${exitCode}): ${stderr.trim()}`)
  }
  return stdout.trim()
}

/**
 * Inspects the remote `fro-bot_gateway-net` Docker network and removes it if
 * it exists with a stale subnet (anything other than GATEWAY_NET_EXPECTED_SUBNET).
 *
 * Runs on every deploy (not just operator deploys). The live `fro-bot_gateway-net`
 * may have a stale subnet from a previous operator deploy. The upstream
 * fro-bot_sandbox-net is declared without explicit IPAM; Docker may allocate from
 * the default bridge address pools, and the failed operator deploy showed a
 * live/default-pool collision with 172.20.0.0/16. gateway-net uses 172.21.0.0/16
 * to avoid reusing that conflicted subnet.
 *
 * Behavior:
 *   - Network missing (inspect exits non-zero) → OK, skip removal
 *   - Network exists with correct subnet (172.21.0.0/16) → OK, skip removal
 *   - Network exists with any other subnet → attempt removal:
 *       a. First `docker network rm` attempt.
 *       b. If it fails with "active endpoints" (gateway/caddy still attached):
 *          remove the gateway and caddy containers via `docker rm -f fro-bot-gateway-1`
 *          and `docker rm -f fro-bot-caddy-1` (direct container removal by known static
 *          names), then retry `docker network rm`.
 *          NOTE: `docker compose rm` is NOT used here because caddy may be absent from
 *          the current compose config (when announce/operator is disabled), causing
 *          `docker compose rm ... caddy` to fail with "no such service". Direct `docker rm -f`
 *          tolerates orphan caddy containers from prior announce/operator deploys.
 *          NOTE: `docker compose stop` alone is NOT sufficient — stopped containers
 *          can still keep active endpoints. Docker network endpoints are tied to
 *          container lifetime/network attachment, not run state. Only removing the
 *          containers releases their network endpoints.
 *       c. If container removal or second rm fails → throw (fail-closed, deploy aborts
 *          before up). The error message explicitly states that gateway/caddy
 *          containers were removed so the operator knows the service state and can
 *          rerun the deploy (which will recreate them via `docker compose up -d`).
 *
 * Shell safety: the network name (GATEWAY_NET_FULL_NAME) is a static constant
 * containing only alphanumeric characters, underscores, and hyphens — safe to
 * embed in a shell command string without quoting risks.
 */
export async function removeStaleGatewayNet(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  // Step 1: Inspect the network to check if it exists and what subnet it has.
  // `docker network inspect` exits non-zero when the network does not exist.
  const inspectProc = spawnFn(
    sshCommand(host, `docker network inspect ${GATEWAY_NET_FULL_NAME}`, keyPath, controlPath),
    {env: deployEnv, stdout: 'pipe', stderr: 'pipe'},
  )
  const inspectStdout = await new Response(inspectProc.stdout).text()
  const inspectExitCode = await inspectProc.exited

  if (inspectExitCode !== 0) {
    // Network does not exist — nothing to clean up
    console.warn(`\u001B[1;34m==>\u001B[0m ${GATEWAY_NET_FULL_NAME} not found — no stale network cleanup needed`)
    return
  }

  // Step 2: Parse the subnet from the inspect output.
  let existingSubnet = ''
  try {
    const parsed = JSON.parse(inspectStdout.trim()) as unknown
    if (Array.isArray(parsed) && parsed.length > 0) {
      const network = parsed[0] as Record<string, unknown>
      const ipam = network.IPAM as Record<string, unknown> | undefined
      const config = ipam?.Config as Record<string, unknown>[] | undefined
      existingSubnet = (config?.[0]?.Subnet as string | undefined) ?? ''
    }
  } catch {
    // If we can't parse the subnet, treat as stale to be safe (fail-closed)
    existingSubnet = ''
  }

  if (existingSubnet === GATEWAY_NET_EXPECTED_SUBNET) {
    // Network already has the correct subnet — no cleanup needed
    console.warn(
      `\u001B[1;32m✓\u001B[0m ${GATEWAY_NET_FULL_NAME} already has correct subnet (${existingSubnet}) — no cleanup needed`,
    )
    return
  }

  // Step 3: Remove the stale network.
  console.warn(
    `\u001B[1;33m[warn]\u001B[0m ${GATEWAY_NET_FULL_NAME} has stale subnet (${existingSubnet || 'unknown'}), expected ${GATEWAY_NET_EXPECTED_SUBNET} — removing after compose pull / before compose up`,
  )

  const rmProc = spawnFn(sshCommand(host, `docker network rm ${GATEWAY_NET_FULL_NAME}`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const rmStderr = await new Response(rmProc.stderr).text()
  const rmExitCode = await rmProc.exited

  if (rmExitCode === 0) {
    console.warn(`\u001B[1;32m✓\u001B[0m Removed stale ${GATEWAY_NET_FULL_NAME} network`)
    return
  }

  // Step 3b: First rm failed. If the error is "active endpoints", stop the services
  // that own those endpoints (gateway and caddy in this topology), then retry rm.
  // Any other failure is treated as fatal (fail-closed).
  if (!rmStderr.includes('active endpoints')) {
    throw new Error(
      `Failed to remove stale ${GATEWAY_NET_FULL_NAME} network (exit ${rmExitCode}): ${rmStderr.trim()}. ` +
        `Stop any containers using this network and retry the deploy.`,
    )
  }

  console.warn(
    `\u001B[1;33m[warn]\u001B[0m ${GATEWAY_NET_FULL_NAME} has active endpoints — removing gateway and caddy containers to release endpoints before retry`,
  )

  // Remove only the containers that can own endpoints on gateway-net.
  // We use `docker rm -f <container-name>` on the known static container names rather than
  // `docker compose rm -f -s gateway caddy` because:
  //   1. `docker compose rm` requires the service to be present in the current compose config.
  //      When caddy is disabled (no announce/operator), the freshly written override omits
  //      the caddy service, so `docker compose rm ... caddy` would fail with "no such service".
  //   2. `docker rm -f` on a non-existent container exits non-zero but we treat that as OK
  //      (the container is already gone — endpoint already released).
  //   3. This approach is scoped to exactly the two containers that can own gateway-net
  //      endpoints: fro-bot-gateway-1 and fro-bot-caddy-1.
  // `docker compose stop` alone is NOT sufficient: stopped containers can still keep active
  // endpoints — Docker network endpoints are tied to container lifetime/network attachment,
  // not run state. Only removing the containers releases their network endpoints.
  // The subsequent `docker compose up -d` (later in the deploy) recreates gateway+caddy.
  for (const containerName of [GATEWAY_CONTAINER_NAME, CADDY_CONTAINER_NAME]) {
    const rmProc = spawnFn(sshCommand(host, `docker rm -f ${containerName}`, keyPath, controlPath), {
      env: deployEnv,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const rmContainerStderr = await new Response(rmProc.stderr).text()
    const rmContainerExitCode = await rmProc.exited
    if (rmContainerExitCode !== 0 && !rmContainerStderr.includes('No such container')) {
      // Non-zero exit is OK if the container simply doesn't exist (already removed / never created).
      // Any other error (permission denied, daemon unreachable, etc.) is fatal — fail closed.
      throw new Error(
        `Failed to remove container ${containerName} to release ${GATEWAY_NET_FULL_NAME} endpoints (exit ${rmContainerExitCode}): ${rmContainerStderr.trim()}. ` +
          `Stop any containers using this network and retry the deploy.`,
      )
    }
  }

  // Step 3c: Retry network removal after containers are removed.
  const rmRetryProc = spawnFn(sshCommand(host, `docker network rm ${GATEWAY_NET_FULL_NAME}`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const rmRetryStderr = await new Response(rmRetryProc.stderr).text()
  const rmRetryExitCode = await rmRetryProc.exited

  if (rmRetryExitCode !== 0) {
    throw new Error(
      `Failed to remove stale ${GATEWAY_NET_FULL_NAME} network after removing gateway/caddy containers (exit ${rmRetryExitCode}): ${rmRetryStderr.trim()}. ` +
        `The gateway and caddy containers have been removed. ` +
        `Rerun the deploy to recreate them, or run: docker compose --project-directory ${DEPLOY_DIR} up -d gateway caddy`,
    )
  }

  console.warn(
    `\u001B[1;32m✓\u001B[0m Removed stale ${GATEWAY_NET_FULL_NAME} network (after removing gateway/caddy containers)`,
  )
}

// ─── main orchestrator ────────────────────────────────────────────────────────

export async function main(opts: MainOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const args = opts.args ?? process.argv.slice(2)
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const spawnFn = opts.spawn ?? defaultSpawn
  const maxAttempts = opts.maxAttempts ?? 10
  const intervalMs = opts.intervalMs ?? 3000
  const probeAttempts = opts.probeAttempts ?? 5
  const probeIntervalMs = opts.probeIntervalMs ?? 3_000
  const probePerAttemptTimeoutMs = opts.probePerAttemptTimeoutMs ?? 5_000

  const {dryRun: isDryRun, forceRecreate} = parseDeployArgs(args)

  // Phase 1: Validate env
  // SSH_AUTH_SOCK check in local mode (not CI)
  if (env.CI !== 'true' && !env.SSH_AUTH_SOCK) {
    throw new Error('SSH_AUTH_SOCK is required in local mode. Start ssh-agent and load your key first.')
  }

  const missing = validateRequiredEnv(env)
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  const validated = narrowValidatedEnv(env)

  // Phase 2: Resolve upstream pin
  const {repo, ref} = resolveUpstreamPin()

  // Phase 3 (pre-flight): Validate OBJECT_STORE_HOSTS before any SSH
  const objectStoreHosts = computeObjectStoreHosts(env)
  validateObjectStoreHosts(objectStoreHosts)

  // Phase 3b: Validate workspace .env vars (MODEL/CONFIG/READY_TIMEOUT) before any SSH.
  // buildGatewayEnvFileContents throws with a descriptive message on invalid input.
  const missingWorkspace = getMissingWorkspaceEnvVars(env)
  if (missingWorkspace.length > 0) {
    throw new Error(`Missing required environment variables: ${missingWorkspace.join(', ')}`)
  }
  // validateReadyTimeout throws on non-numeric/zero/negative values; absent/empty → undefined.
  const readyTimeoutMs = validateReadyTimeout(env.WORKSPACE_OPENCODE_READY_TIMEOUT_MS)
  buildGatewayEnvFileContents({
    objectStoreHosts,
    model: env.WORKSPACE_OPENCODE_MODEL ?? '',
    config: env.WORKSPACE_OPENCODE_CONFIG ?? '',
    readyTimeoutMs,
  })

  // Phase 3c: Validate image digests before any SSH.
  // GATEWAY_IMAGE_DIGEST and WORKSPACE_IMAGE_DIGEST are required on every deploy —
  // they are supplied by the CI build-images job and used to pin the pulled images.
  // Failing fast here prevents a silent fall-through to on-droplet building.
  // Both digests are validated against /^sha256:[0-9a-f]{64}$/ to guard the
  // compose override `image:@<digest>` and the Phase 9c verification.
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
  const gatewayDigest = env.GATEWAY_IMAGE_DIGEST?.trim()
  const workspaceDigest = env.WORKSPACE_IMAGE_DIGEST?.trim()
  if (!gatewayDigest) {
    throw new Error(
      'GATEWAY_IMAGE_DIGEST is required but not set. ' +
        'This value is supplied by the CI build-images job. ' +
        'For a local deploy, build and push the image to GHCR first, then set GATEWAY_IMAGE_DIGEST.',
    )
  }
  if (!DIGEST_RE.test(gatewayDigest)) {
    throw new Error(
      `GATEWAY_IMAGE_DIGEST has an invalid format: "${gatewayDigest}". ` +
        'Expected sha256:<64 hex chars> (e.g. sha256:abc...def). ' +
        'This value is supplied by the CI build-images job outputs.digest.',
    )
  }
  if (!workspaceDigest) {
    throw new Error(
      'WORKSPACE_IMAGE_DIGEST is required but not set. ' +
        'This value is supplied by the CI build-images job. ' +
        'For a local deploy, build and push the image to GHCR first, then set WORKSPACE_IMAGE_DIGEST.',
    )
  }
  if (!DIGEST_RE.test(workspaceDigest)) {
    throw new Error(
      `WORKSPACE_IMAGE_DIGEST has an invalid format: "${workspaceDigest}". ` +
        'Expected sha256:<64 hex chars> (e.g. sha256:abc...def). ' +
        'This value is supplied by the CI build-images job outputs.digest.',
    )
  }

  // Phase 3d: Validate announce both-or-neither gate before any SSH.
  // Exactly one of the announce inputs being set is an invalid configuration —
  // fail fast with a clear message naming the missing input.
  const announceState = getAnnounceState(env)
  if (announceState === 'invalid') {
    const missingAnnounce = env.GATEWAY_WEBHOOK_SECRET?.trim()
      ? 'GATEWAY_PRESENCE_CHANNEL_ID'
      : 'GATEWAY_WEBHOOK_SECRET'
    throw new Error(
      `Announce inputs must be set together (both-or-neither). Missing: ${missingAnnounce}. ` +
        'Set both GATEWAY_WEBHOOK_SECRET and GATEWAY_PRESENCE_CHANNEL_ID, or leave both unset.',
    )
  }

  // Phase 3e: Validate operator listener config before any SSH.
  // All three vars must be present together (all-or-none gate).
  // When enabled, validate the bind host/port/origin values for unsafe topology.
  const operatorState = getOperatorState(env)
  if (operatorState === 'invalid') {
    const hasBindHost = Boolean(env.GATEWAY_OPERATOR_BIND_HOST?.trim())
    const hasBindPort = Boolean(env.GATEWAY_OPERATOR_BIND_PORT?.trim())
    const hasPublicOrigin = Boolean(env.GATEWAY_OPERATOR_PUBLIC_ORIGIN?.trim())
    const missing = [
      !hasBindHost && 'GATEWAY_OPERATOR_BIND_HOST',
      !hasBindPort && 'GATEWAY_OPERATOR_BIND_PORT',
      !hasPublicOrigin && 'GATEWAY_OPERATOR_PUBLIC_ORIGIN',
    ]
      .filter(Boolean)
      .join(', ')
    throw new Error(
      `Operator listener inputs must be set together (all-or-none). Missing: ${missing}. ` +
        'Set all three of GATEWAY_OPERATOR_BIND_HOST, GATEWAY_OPERATOR_BIND_PORT, and GATEWAY_OPERATOR_PUBLIC_ORIGIN, or leave all unset.',
    )
  }
  if (operatorState === 'enabled') {
    validateOperatorConfig({
      bindHost: env.GATEWAY_OPERATOR_BIND_HOST ?? '',
      bindPort: env.GATEWAY_OPERATOR_BIND_PORT ?? '',
      publicOrigin: env.GATEWAY_OPERATOR_PUBLIC_ORIGIN ?? '',
      gatewayHost: env.GATEWAY_HOST,
    })
  }

  // Phase 3f: Validate operator auth/config gate before any SSH.
  // When operator listener is enabled, all four auth/config vars are required (v0.69.0 contract).
  // 'disabled' (0 of 4) is not valid when listener is enabled — fail-closed.
  // 'invalid' (1–3 of 4) is a partial set — fail-closed.
  // Rollback: clear both listener trio AND auth vars together; listener trio present + auth absent is not valid.
  if (operatorState === 'enabled') {
    const operatorAuthState = getOperatorAuthState(env)
    if (operatorAuthState !== 'enabled') {
      // Both 'disabled' and 'invalid' are rejected when listener is enabled.
      const hasClientId = Boolean(env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID?.trim())
      const hasClientSecret = Boolean(env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET?.trim())
      const hasCsrfSecret = Boolean(env.GATEWAY_OPERATOR_CSRF_SECRET?.trim())
      const hasAllowlist = Boolean(env.GATEWAY_OPERATOR_ALLOWLIST?.trim())
      const missingAuth = [
        !hasClientId && 'GATEWAY_OPERATOR_GITHUB_CLIENT_ID',
        !hasClientSecret && 'GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET',
        !hasCsrfSecret && 'GATEWAY_OPERATOR_CSRF_SECRET',
        !hasAllowlist && 'GATEWAY_OPERATOR_ALLOWLIST',
      ]
        .filter(Boolean)
        .join(', ')
      throw new Error(
        `Operator listener is enabled but auth/config vars are missing: ${missingAuth}. ` +
          'All four of GATEWAY_OPERATOR_GITHUB_CLIENT_ID, GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET, ' +
          'GATEWAY_OPERATOR_CSRF_SECRET, and GATEWAY_OPERATOR_ALLOWLIST are required when the operator listener is enabled. ' +
          'To disable the operator listener, clear all three of GATEWAY_OPERATOR_BIND_HOST, GATEWAY_OPERATOR_BIND_PORT, and GATEWAY_OPERATOR_PUBLIC_ORIGIN.',
      )
    }
    validateOperatorAuthConfig({
      githubClientId: env.GATEWAY_OPERATOR_GITHUB_CLIENT_ID ?? '',
      githubClientSecret: env.GATEWAY_OPERATOR_GITHUB_CLIENT_SECRET ?? '',
      csrfSecret: env.GATEWAY_OPERATOR_CSRF_SECRET ?? '',
      allowlist: env.GATEWAY_OPERATOR_ALLOWLIST ?? '',
    })
  }

  // Phase 3g: Validate VPC IP all-or-none gate before any SSH.
  // GATEWAY_VPC_IP and DASHBOARD_VPC_IP are only meaningful when the operator listener is enabled.
  // When the operator is enabled, both must be present together (all-or-none).
  // When the operator is disabled, VPC vars are ignored (no gate).
  if (operatorState === 'enabled') {
    const operatorVpcState = getOperatorVpcState(env)
    if (operatorVpcState === 'invalid') {
      const hasGatewayVpcIp = Boolean(env.GATEWAY_VPC_IP?.trim())
      const hasDashboardVpcIp = Boolean(env.DASHBOARD_VPC_IP?.trim())
      const missing = [!hasGatewayVpcIp && 'GATEWAY_VPC_IP', !hasDashboardVpcIp && 'DASHBOARD_VPC_IP']
        .filter(Boolean)
        .join(', ')
      throw new Error(
        `VPC IP inputs must be set together (all-or-none) when the operator listener is enabled. Missing: ${missing}. ` +
          'Set both GATEWAY_VPC_IP and DASHBOARD_VPC_IP, or leave both unset to disable the VPC port publish.',
      )
    }
    if (operatorVpcState === 'enabled') {
      validateVpcIp(env.GATEWAY_VPC_IP ?? '', 'GATEWAY_VPC_IP')
      validateVpcIp(env.DASHBOARD_VPC_IP ?? '', 'DASHBOARD_VPC_IP')
    }
  }

  if (isDryRun) {
    const announceEnabled = announceState === 'enabled'
    const operatorEnabledDry = operatorState === 'enabled'
    const operatorAuthEnabledDry = operatorEnabledDry && getOperatorAuthState(env) === 'enabled'
    const caddyEnabledDry = announceEnabled || operatorEnabledDry
    const caddyWiringDesc = [announceEnabled ? 'announce' : '', operatorEnabledDry ? 'operator' : '']
      .filter(Boolean)
      .join('+')
    console.warn('\u001B[1;33m[dry-run]\u001B[0m Planned actions:')
    console.warn(`  1. Ensure droplet workspace at ${REMOTE_DIR} (clone ${repo}@${ref} or fetch+reset)`)
    console.warn(`  2. Compute OBJECT_STORE_HOSTS: ${objectStoreHosts}`)
    console.warn(`  3. Materialize ${buildSecretFileList(env).length} secret files under ${SECRETS_DIR}`)
    console.warn(
      `  3b. Write compose.override.yaml with image pins (gateway@${gatewayDigest}, workspace@${workspaceDigest})${caddyEnabledDry ? ` + Caddy/${caddyWiringDesc} wiring` : ''}`,
    )
    if (caddyEnabledDry) {
      console.warn(`  3c. Caddy enabled (${caddyWiringDesc}) — materialize Caddyfile under ${DEPLOY_DIR}`)
    }
    if (operatorAuthEnabledDry) {
      const callbackUrl = `${env.GATEWAY_OPERATOR_PUBLIC_ORIGIN}/operator/auth/github/callback`
      console.warn(`  [preflight] Expected OAuth callback URL: ${callbackUrl}`)
      console.warn(`  [preflight] Verify this URL is registered in the GitHub OAuth App settings before enablement.`)
    }
    console.warn(`  3d. Run upstream stack validation: cd ${REMOTE_DIR} && bash deploy/validate-stack.sh`)
    console.warn(`  4. Write .env to ${ENV_PATH}`)
    console.warn(`  5. Run init-certs.sh (idempotent)`)
    console.warn(`  6. docker compose pull (pull prebuilt GHCR images — before any container disruption)`)
    console.warn(
      `  6b. Remove stale ${GATEWAY_NET_FULL_NAME} network if subnet differs from ${GATEWAY_NET_EXPECTED_SUBNET} (after pull, before up)`,
    )
    console.warn(
      `  7. docker compose up -d --no-build --wait --wait-timeout 120 --remove-orphans${forceRecreate ? ' --force-recreate' : ''}`,
    )
    console.warn(
      `  8. Poll Discord slash command registration (app=${env.DISCORD_APPLICATION_ID} guild=${env.DISCORD_GUILD_ID})`,
    )
    console.warn(`  9. Verify running image digests match CI-pushed digests`)
    console.warn('\u001B[1;33m[dry-run]\u001B[0m No remote side effects performed.')
    return
  }

  const host = validated.GATEWAY_HOST
  validateGatewayHost(host)
  const deployEnv = buildDeployEnv(env)

  // CI mode: write GATEWAY_SSH_KEY to a tmp file with mode 0o600.
  // Local mode: keyPath stays undefined; SSH_AUTH_SOCK is forwarded via deployEnv.
  let keyPath: string | undefined
  let keyTmpDir: string | undefined
  // ControlMaster socket lives under a SHORT /tmp-rooted dir to stay well under the
  // 104-byte sun_path limit for unix-domain sockets. On macOS, os.tmpdir() returns a
  // long path like /var/folders/td/f1mm.../T/ which causes ControlPath to exceed 104
  // bytes → ssh fails with "ControlPath too long". The private key file stays in the
  // secure os.tmpdir()-rooted dir (user-owned mode-700); only the socket moves to /tmp.
  let controlTmpDir: string | undefined

  try {
    // Key dir: secure, user-owned, under os.tmpdir() (may be long on macOS — that's fine
    // for a regular file path; the 104-byte limit only applies to unix-domain sockets).
    keyTmpDir = mkdtempSync(join(tmpdir(), 'gateway-deploy-key-'))

    // Control socket dir: always under /tmp so the socket path stays short.
    controlTmpDir = mkdtempSync(join('/tmp', 'gw-cm-'))

    if (env.CI === 'true' && env.GATEWAY_SSH_KEY) {
      try {
        keyPath = join(keyTmpDir, 'id')
        const keyContent = env.GATEWAY_SSH_KEY.endsWith('\n') ? env.GATEWAY_SSH_KEY : `${env.GATEWAY_SSH_KEY}\n`
        writeFileSync(keyPath, keyContent, {mode: 0o600})
        // Defensive chmod in case umask narrowed the initial mode
        chmodSync(keyPath, 0o600)
      } catch (error) {
        if (keyTmpDir) {
          rmSync(keyTmpDir, {recursive: true, force: true})
          keyTmpDir = undefined
        }
        throw error
      }
    }

    // ControlPath socket lives inside controlTmpDir (short /tmp-rooted path).
    // %C expands to a hash of the connection tuple.
    const controlPath = join(controlTmpDir, 'cm-%C')

    // Phase 4: Ensure droplet workspace
    await runCommand(
      'Creating remote workspace directory',
      sshCommand(host, `mkdir -p ${REMOTE_DIR}`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    const gitExists = await remoteGitExists(host, deployEnv, spawnFn, keyPath, controlPath)

    if (gitExists) {
      await runCommand(
        `Fetching latest from ${repo}`,
        sshCommand(host, `cd ${REMOTE_DIR} && git fetch --tags`, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
      await runCommand(
        `Resetting to ${ref}`,
        sshCommand(host, `cd ${REMOTE_DIR} && git reset --hard ${ref}`, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
      await runCommand(
        'Cleaning untracked files',
        sshCommand(host, `cd ${REMOTE_DIR} && git clean -xfd`, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
    } else {
      await runCommand(
        `Cloning ${repo} at ${ref}`,
        sshCommand(
          host,
          `git clone --depth 1 --branch ${ref} https://github.com/${repo}.git ${REMOTE_DIR}`,
          keyPath,
          controlPath,
        ),
        deployEnv,
        spawnFn,
      )
    }

    // Phase 5: Materialize secrets
    const secrets = buildSecretFileList(env)
    await runCommand(
      'Creating secrets directory',
      sshCommand(host, `mkdir -p ${SECRETS_DIR}`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    for (const secret of secrets) {
      await writeRemoteFile(
        `Writing secret: ${secret.name}`,
        host,
        `${SECRETS_DIR}/${secret.name}`,
        secret.content,
        deployEnv,
        spawnFn,
        secrets,
        keyPath,
        controlPath,
      )
    }

    // Phase 5b: Materialize compose.override.yaml (always) + Caddyfile (when Caddy is enabled).
    // The override is written on EVERY deploy because it carries the image digest pins
    // for gateway and workspace — without it, compose would use build: semantics.
    // git clean -xfd (phase 4) removed any prior copy; writeRemoteFile overwrites idempotently.
    // Caddy is enabled when announce OR operator is enabled (caddyEnabled = announceEnabled || operatorEnabled).
    const announceEnabled = announceState === 'enabled'
    const operatorEnabled = operatorState === 'enabled'
    const caddyEnabled = announceEnabled || operatorEnabled
    const operatorBindHost = operatorEnabled ? (env.GATEWAY_OPERATOR_BIND_HOST ?? '') : undefined
    const operatorBindPort = operatorEnabled ? (env.GATEWAY_OPERATOR_BIND_PORT ?? '') : undefined
    const operatorPublicOrigin = operatorEnabled ? (env.GATEWAY_OPERATOR_PUBLIC_ORIGIN ?? '') : undefined
    const operatorAuthEnabled = operatorEnabled && getOperatorAuthState(env) === 'enabled'
    // VPC port publish: only when operator is enabled AND both VPC IPs are configured.
    const operatorVpcIp =
      operatorEnabled && getOperatorVpcState(env) === 'enabled' ? (env.GATEWAY_VPC_IP ?? '') : undefined
    const overrideContent = buildComposeOverride({
      gatewayDigest,
      workspaceDigest,
      announceEnabled,
      operatorEnabled,
      operatorBindHost,
      operatorBindPort,
      operatorPublicOrigin,
      operatorAuthEnabled,
      operatorVpcIp,
      // Derive file names from OPERATOR_AUTH_SECRET_SPECS — single source of truth.
      operatorGithubClientIdFile: operatorAuthEnabled ? OPERATOR_AUTH_SECRET_SPECS[0].hostFile : undefined,
      operatorGithubClientSecretFile: operatorAuthEnabled ? OPERATOR_AUTH_SECRET_SPECS[1].hostFile : undefined,
      operatorCsrfSecretFile: operatorAuthEnabled ? OPERATOR_AUTH_SECRET_SPECS[2].hostFile : undefined,
      operatorAllowlistFile: operatorAuthEnabled ? OPERATOR_AUTH_SECRET_SPECS[3].hostFile : undefined,
      operatorOauthAllowedReturnPaths: operatorAuthEnabled
        ? env.GATEWAY_OPERATOR_OAUTH_ALLOWED_RETURN_PATHS || undefined
        : undefined,
      operatorOauthStateTtlMs: operatorAuthEnabled ? env.GATEWAY_OPERATOR_OAUTH_STATE_TTL_MS || undefined : undefined,
      operatorOauthMaxOutstandingAttempts: operatorAuthEnabled
        ? env.GATEWAY_OPERATOR_OAUTH_MAX_OUTSTANDING_ATTEMPTS || undefined
        : undefined,
    })
    const operatorTarget =
      operatorEnabled && operatorBindHost && operatorBindPort ? `${operatorBindHost}:${operatorBindPort}` : undefined
    const caddyfileContent = caddyEnabled
      ? buildCaddyfile(validated.GATEWAY_HOST, {
          announceEnabled,
          operatorEnabled,
          operatorTarget,
        })
      : ''

    await writeRemoteFile(
      'Writing compose.override.yaml',
      host,
      `${DEPLOY_DIR}/compose.override.yaml`,
      overrideContent,
      deployEnv,
      spawnFn,
      secrets,
      keyPath,
      controlPath,
    )

    if (caddyEnabled) {
      await writeRemoteFile(
        'Writing Caddyfile',
        host,
        `${DEPLOY_DIR}/Caddyfile`,
        caddyfileContent,
        deployEnv,
        spawnFn,
        secrets,
        keyPath,
        controlPath,
      )
    }

    // Phase 5c: Run upstream stack validation.
    // deploy/validate-stack.sh performs static network-topology and persistence invariant
    // checks on the upstream base compose stack. It runs AFTER compose.override.yaml (and
    // Caddyfile when Caddy is enabled) are materialized so the validator sees the final
    // merged stack — including the image pins and network wiring written in Phase 5b.
    //
    // The script lives in the upstream repo at deploy/validate-stack.sh and is run from
    // REMOTE_DIR (the repo root) so the relative path deploy/validate-stack.sh resolves
    // correctly. Running from DEPLOY_DIR would require deploy/deploy/validate-stack.sh.
    //
    // Fail-closed: a non-zero exit aborts the deploy before docker compose pull/up and
    // before checksum persistence. This ensures unsafe topology is never deployed.
    await runCommand(
      'Running upstream stack validation (deploy/validate-stack.sh)',
      sshCommand(host, `cd ${REMOTE_DIR} && bash deploy/validate-stack.sh`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 5d: Infra-owned rendered-config validation gate (operator deploys only).
    // When the operator listener is enabled, run `docker compose config --format json` on the
    // remote to get the fully-merged compose config and validate the operator topology invariants:
    //   - gateway has static ipv4_address on gateway-net equal to GATEWAY_OPERATOR_BIND_HOST
    //   - gateway keeps sandbox-net
    //   - workspace is sandbox-net only (not gateway-net/egress-net)
    //   - caddy is gateway-net only
    //   - caddy publishes only 80/443 host ports
    //   - gateway port 9300: allowlist gate — when VPC publish is enabled, the ONLY accepted
    //     published 9300 mapping is exactly ${GATEWAY_VPC_IP}:9300:9300; any other host-bind
    //     (0.0.0.0, [::], bare 9300:9300, any non-VPC host) is rejected. When VPC publish is
    //     disabled, no 9300 host port is accepted at all. Fail-closed on anything unexpected.
    //   - top-level gateway-net IPAM includes the expected subnet (172.21.0.0/16)
    //
    // This gate runs AFTER upstream validate-stack.sh (which validates the base stack) and
    // BEFORE docker compose pull/up and checksum persistence. Non-zero exit aborts the deploy.
    // Non-operator deploys skip this gate entirely — no needless complexity.
    //
    // Shell safety: uses a single-quoted heredoc (<<'SCRIPT'...SCRIPT) so the outer shell
    // does NOT expand $CONFIG or $(...) before the inner bash runs. The expected bind host
    // and VPC IP are interpolated at script-build time (before SSH), not inside the heredoc.
    // Tooling: uses Python (always available on Ubuntu/Debian) to parse JSON — avoids
    // bun, node, and jq which are not guaranteed on the droplet.
    if (operatorEnabled && operatorBindHost) {
      // operatorBindHost is validated before reaching here (validateOperatorConfig).
      // It is a safe 172.21.x.x IPv4 address — safe to embed in the heredoc body.
      const expectedBindHost = operatorBindHost
      // operatorVpcIp is validated before reaching here (validateVpcIp) when set.
      // It is a safe dotted-decimal IPv4 address — safe to embed in the heredoc body.
      const expectedVpcIp = operatorVpcIp ?? ''
      const validateScript = `bash <<'SCRIPT'
set -euo pipefail
CONFIG=$(docker compose --project-directory ${DEPLOY_DIR} config --format json)
if [ $? -ne 0 ] || [ -z "$CONFIG" ]; then
  echo "FAIL: docker compose config failed or returned empty output"
  exit 1
fi
GW_IP=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); n=c.get('services',{}).get('gateway',{}).get('networks',{}).get('gateway-net',{}); print(n.get('ipv4_address',''))")
if [ "$GW_IP" != "${expectedBindHost}" ]; then echo "FAIL: gateway gateway-net ipv4_address is '$GW_IP', expected '${expectedBindHost}'"; exit 1; fi
GW_SUBNET=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); cfg=c.get('networks',{}).get('gateway-net',{}).get('ipam',{}).get('config',[]); print(cfg[0].get('subnet','') if cfg else '')")
if [ "$GW_SUBNET" != "172.21.0.0/16" ]; then echo "FAIL: gateway-net IPAM subnet is '$GW_SUBNET', expected '172.21.0.0/16'"; exit 1; fi
GW_PORT_9300=$(echo "$CONFIG" | python3 -c "
import json,sys
c=json.load(sys.stdin)
ports=c.get('services',{}).get('gateway',{}).get('ports',[])
for p in ports:
  if isinstance(p,dict) and str(p.get('target',''))=='9300':
    host_ip=str(p.get('host_ip',''))
    published=str(p.get('published',''))
    print(host_ip+':'+published+':9300')
    sys.exit(0)
print('')
")
if [ -n "${expectedVpcIp}" ]; then
  if [ "$GW_PORT_9300" != "${expectedVpcIp}:9300:9300" ]; then echo "FAIL: gateway 9300 port publish is '$GW_PORT_9300', expected exactly '${expectedVpcIp}:9300:9300' (VPC-scoped only; 0.0.0.0, [::], and bare 9300:9300 are rejected)"; exit 1; fi
else
  if [ -n "$GW_PORT_9300" ]; then echo "FAIL: gateway publishes 9300 host port '$GW_PORT_9300' but VPC publish is not configured (no GATEWAY_VPC_IP set)"; exit 1; fi
fi
GW_SANDBOX=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); nets=list(c.get('services',{}).get('gateway',{}).get('networks',{}).keys()); print('yes' if 'sandbox-net' in nets else 'no')")
if [ "$GW_SANDBOX" != "yes" ]; then echo "FAIL: gateway is missing sandbox-net (required for workspace communication)"; exit 1; fi
WS_NETS=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); nets=list(c.get('services',{}).get('workspace',{}).get('networks',{}).keys()); print(','.join(nets))")
if echo "$WS_NETS" | grep -qE 'gateway-net|egress-net'; then echo "FAIL: workspace must be sandbox-net only, but has: $WS_NETS"; exit 1; fi
CADDY_NETS=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); nets=list(c.get('services',{}).get('caddy',{}).get('networks',{}).keys()); print(','.join(nets))")
if [ "$CADDY_NETS" != "gateway-net" ]; then echo "FAIL: caddy must be gateway-net only, but has: $CADDY_NETS"; exit 1; fi
CADDY_PORTS=$(echo "$CONFIG" | python3 -c "import json,sys; c=json.load(sys.stdin); ports=c.get('services',{}).get('caddy',{}).get('ports',[]); published=[str(p.get('published','')) for p in ports if isinstance(p,dict)]; print(','.join(published))")
if [ "$CADDY_PORTS" != "80,443" ] && [ "$CADDY_PORTS" != "443,80" ]; then echo "FAIL: caddy must publish only ports 80 and 443, but has: $CADDY_PORTS"; exit 1; fi
echo "OK: infra rendered-config validation passed"
SCRIPT`
      await runCommand(
        'Running infra rendered-config validation (operator topology invariants)',
        sshCommand(host, validateScript, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
    }

    // Compute current checksum and read prior checksum to detect rotation.
    // The override is always included (image pins change when digests change, which
    // should force recreate). Caddyfile is included whenever Caddy is enabled
    // (announce OR operator), so toggling either on/off forces --force-recreate.
    const checksumInput: SecretFile[] = [
      ...secrets,
      {name: 'compose.override.yaml', content: overrideContent, required: false},
    ]
    if (caddyEnabled) {
      checksumInput.push({name: 'Caddyfile', content: caddyfileContent, required: false})
    }
    const currentChecksum = computeSecretsChecksum(checksumInput)
    const priorChecksum = await readRemoteChecksum(host, deployEnv, spawnFn, keyPath, controlPath)
    const checksumChanged = priorChecksum !== currentChecksum

    // Phase 6: Materialize .env via stdin pipe (OBJECT_STORE_HOSTS already validated above)
    const envFileContents = buildGatewayEnvFileContents({
      objectStoreHosts,
      model: env.WORKSPACE_OPENCODE_MODEL ?? '',
      config: env.WORKSPACE_OPENCODE_CONFIG ?? '',
      readyTimeoutMs,
    })
    await writeRemoteFile(
      'Writing .env',
      host,
      ENV_PATH,
      envFileContents,
      deployEnv,
      spawnFn,
      secrets,
      keyPath,
      controlPath,
    )

    // Phase 7: Run init-certs.sh (idempotent)
    await runCommand(
      'Running init-certs.sh',
      sshCommand(host, `cd ${DEPLOY_DIR} && bash init-certs.sh`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8: Pull prebuilt GHCR images, then bring up the stack without building.
    // The compose.override.yaml written in phase 5b pins gateway and workspace to the
    // CI-pushed digests. docker compose pull fetches those exact images; docker compose up
    // with --no-build uses the pulled images and never triggers an on-droplet build.
    // A missing/unpullable image errors here (does not fall back to building).
    //
    // --remove-orphans: required to retire the Caddy container when announce is toggled off.
    // When announce is disabled, Caddy is not declared in the override, so without
    // --remove-orphans the container lingers on :443.
    await runCommand(
      'Pulling prebuilt images from GHCR',
      sshCommand(host, `docker compose --project-directory ${DEPLOY_DIR} pull`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8b: Remove stale gateway-net network (all deploys).
    // Runs AFTER docker compose pull so images are already cached before any container disruption.
    // If the image pull fails, gateway/caddy containers are never removed — no avoidable downtime.
    //
    // The live `fro-bot_gateway-net` Docker network may have a stale subnet from a previous
    // operator deploy (e.g. 172.20.0.0/16 — the known conflicted subnet from the failed operator
    // deploy). If the existing network differs from the expected 172.21.0.0/16 subnet, Docker will
    // refuse to create the new network with "Pool overlaps with other one on this address space".
    // We inspect the existing network and remove it if stale — after pull and before compose up so
    // the compose up can recreate it with the correct subnet.
    //
    // Behavior:
    //   - Network missing → OK, skip removal
    //   - Network exists with correct subnet (172.21.0.0/16) → OK, skip removal
    //   - Network exists with any other subnet → remove it; throw on failure (fail-closed)
    //
    // This phase runs AFTER docker compose pull (Phase 8) and BEFORE docker compose up.
    // Non-operator deploys skip Phase 5d but still run this phase.
    await removeStaleGatewayNet(host, deployEnv, spawnFn, keyPath, controlPath)

    const composeArgs = [
      'docker',
      'compose',
      '--project-directory',
      DEPLOY_DIR,
      'up',
      '-d',
      '--no-build',
      '--wait',
      '--wait-timeout',
      '120',
      '--remove-orphans',
    ]
    if (forceRecreate || checksumChanged) {
      composeArgs.push('--force-recreate')
    }

    await runCommand(
      'Starting Docker Compose stack',
      sshCommand(host, composeArgs.join(' '), keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8c: DOCKER-USER source restriction (operator + VPC enabled only).
    //
    // The DOCKER-USER iptables chain sees traffic AFTER Docker DNAT, so we match on
    // the post-DNAT destination (the container IP + port) rather than conntrack
    // original-dst. This avoids requiring the conntrack module and is the standard
    // pattern for DOCKER-USER rules.
    //
    // ALLOW rule: -d <operatorBindHost> --dport 9300 -s <dashboardVpcIp> -j RETURN
    // DROP rule:  -d <operatorBindHost> --dport 9300 -j DROP
    //
    // Both are inserted idempotently with -C || -I before any terminal RETURN.
    // ALLOW is inserted at position 1 (before DROP), DROP at position 2.
    //
    // This phase runs AFTER docker compose up because Docker recreates DOCKER-USER-adjacent
    // chains on daemon restart / compose up — applying before would be wiped.
    //
    // The VPC interface is detected at deploy time via `ip route get <DASHBOARD_VPC_IP>`.
    // Fail closed if the interface cannot be detected (VPN lesson: never hardcode eth1).
    //
    // Multiplexed over the existing ControlMaster connection to avoid ufw's
    // 6-new-connections/30s lockout across the multi-SSH-call flow.
    if (operatorEnabled && getOperatorVpcState(env) === 'enabled') {
      const dashboardVpcIp = env.DASHBOARD_VPC_IP ?? ''
      const containerIp = operatorBindHost ?? ''
      const operatorPort = operatorBindPort ?? '9300'

      // Detect the VPC interface at deploy time — never hardcode (VPN lesson).
      // `ip route get <DASHBOARD_VPC_IP>` returns the route used to reach the dashboard
      // droplet, including the local interface name in "dev <iface>".
      let routeOutput: string
      try {
        const result = await runCommand(
          'Detecting VPC interface for DOCKER-USER rule',
          sshCommand(host, `ip route get ${dashboardVpcIp}`, keyPath, controlPath),
          deployEnv,
          spawnFn,
        )
        routeOutput = result.stdout
      } catch (error) {
        throw new Error(
          `Cannot detect VPC interface for DASHBOARD_VPC_IP ${dashboardVpcIp}: ` +
            `'ip route get ${dashboardVpcIp}' failed. ` +
            'Ensure the gateway droplet is on the same VPC as the dashboard droplet. ' +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      const ifaceMatch = routeOutput.match(/\bdev\s+(\S+)/)
      const vpcIface = ifaceMatch?.[1]
      if (!vpcIface) {
        throw new Error(
          `Cannot detect VPC interface for DASHBOARD_VPC_IP ${dashboardVpcIp}: ` +
            `'ip route get ${dashboardVpcIp}' returned no 'dev <iface>' field. ` +
            'Ensure the gateway droplet is on the same VPC as the dashboard droplet.',
        )
      }

      // Idempotent DOCKER-USER rule application.
      // -C checks if the rule exists; if not (exit 1), -I inserts it.
      // ALLOW rule inserted at position 1, DROP at position 2 (ALLOW before DROP).
      // Both rules match post-DNAT destination (container IP) + dport 9300.
      // The ALLOW rule additionally restricts source to DASHBOARD_VPC_IP.
      // The DROP rule drops all other sources reaching dport 9300.
      const dockerUserScript = [
        'set -euo pipefail',
        // ALLOW rule: source=DASHBOARD_VPC_IP, dest=container IP, dport=9300, jump=RETURN
        `iptables -C DOCKER-USER -i ${vpcIface} -s ${dashboardVpcIp} -d ${containerIp} -p tcp --dport ${operatorPort} -j RETURN 2>/dev/null || iptables -I DOCKER-USER 1 -i ${vpcIface} -s ${dashboardVpcIp} -d ${containerIp} -p tcp --dport ${operatorPort} -j RETURN`,
        // DROP rule: all sources, dest=container IP, dport=9300, jump=DROP
        `iptables -C DOCKER-USER -d ${containerIp} -p tcp --dport ${operatorPort} -j DROP 2>/dev/null || iptables -I DOCKER-USER 2 -d ${containerIp} -p tcp --dport ${operatorPort} -j DROP`,
      ].join('\n')

      await runCommand(
        'Applying DOCKER-USER source restriction (idempotent)',
        sshCommand(host, dockerUserScript, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )

      // Read back the DOCKER-USER chain and verify the exact rule is in place.
      // Presence alone is insufficient — a wrong-but-present rule (wrong source/dest/ordering)
      // must fail verification. Assert: ALLOW rule has source==DASHBOARD_VPC_IP, dport 9300,
      // jump RETURN, and sits before the DROP rule.
      const {stdout: chainOutput} = await runCommand(
        'Reading back DOCKER-USER chain for verification',
        sshCommand(host, `iptables -nvL DOCKER-USER --line-numbers`, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )

      // Parse the chain output to find the ALLOW and DROP rules for dport 9300.
      // `iptables -nvL --line-numbers` output format:
      //   num   pkts bytes target     prot opt in     out     source               destination   [options]
      //   1        0     0 RETURN     tcp  --  eth1   *       10.116.0.5           172.21.0.2    tcp dpt:9300
      // We look for lines with dpt:<port> targeting the container IP.
      const lines = chainOutput.split('\n')
      let allowLineNum = -1
      let dropLineNum = -1

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('Chain') || trimmed.startsWith('num') || trimmed.startsWith('target'))
          continue

        // Check if this line is for dport 9300 targeting the container IP
        if (!trimmed.includes(`dpt:${operatorPort}`) || !trimmed.includes(containerIp)) continue

        // Extract fields: num pkts bytes target prot opt in out source destination [options]
        const fields = trimmed.split(/\s+/)
        const lineNum = Number.parseInt(fields[0] ?? '', 10)
        if (!Number.isFinite(lineNum)) continue

        // With --line-numbers: fields[0]=num, fields[1]=pkts, fields[2]=bytes, fields[3]=target,
        // fields[4]=prot, fields[5]=opt, fields[6]=in, fields[7]=out, fields[8]=source, fields[9]=destination
        const target = fields[3] ?? ''
        const source = fields[8] ?? ''

        if (target === 'RETURN' && source === dashboardVpcIp) {
          allowLineNum = lineNum
        } else if (target === 'DROP') {
          dropLineNum = lineNum
        }
      }

      if (allowLineNum === -1) {
        throw new Error(
          `DOCKER-USER ALLOW rule verification failed: no RETURN rule found with source=${dashboardVpcIp} ` +
            `dport=${operatorPort} dest=${containerIp} in DOCKER-USER chain. ` +
            `Chain output:\n${chainOutput}`,
        )
      }

      if (dropLineNum !== -1 && allowLineNum > dropLineNum) {
        throw new Error(
          `DOCKER-USER rule ordering verification failed: ALLOW rule (line ${allowLineNum}) must appear ` +
            `before DROP rule (line ${dropLineNum}) in DOCKER-USER chain. ` +
            `Chain output:\n${chainOutput}`,
        )
      }

      const dropSuffix = dropLineNum === -1 ? '' : `, DROP all-else at line ${dropLineNum}`
      console.warn(
        `\u001B[1;32m✓\u001B[0m DOCKER-USER source restriction verified: ALLOW source=${dashboardVpcIp} dport=${operatorPort} at line ${allowLineNum}${dropSuffix}`,
      )
    }

    // Phase 9: Post-deploy probe — poll Discord slash command registration
    const applicationId = validated.DISCORD_APPLICATION_ID
    const guildId = validated.DISCORD_GUILD_ID
    const token = validated.DISCORD_TOKEN

    console.warn(
      `\u001B[1;34m==>\u001B[0m Polling slash command registration (application=${applicationId} guild=${guildId})`,
    )

    const {commands} = await pollRegistration({
      applicationId,
      guildId,
      token,
      fetch: fetchFn,
      sleep: sleepFn,
      maxAttempts,
      intervalMs,
    })

    // Phase 9b: Post-deploy HTTPS ingress probe — warning-only, only when announce is enabled.
    // The endpoint is HMAC-gated: an unsigned POST returns HTTP 400, which proves TLS terminated
    // and Caddy routed correctly. Any 2xx or 4xx is treated as healthy. Connection/TLS errors
    // (including per-attempt AbortController timeout) mean the cert is still issuing
    // (ACME can take 30-60s+); we warn and let the deploy succeed.
    // Each attempt is bounded by probePerAttemptTimeoutMs via AbortController (mirrors pollRegistration).
    if (announceEnabled) {
      const probeUrl = `https://${host}/v1/announce`
      console.warn(`\u001B[1;34m==>\u001B[0m Probing HTTPS ingress: ${probeUrl}`)
      let probeOk = false
      for (let attempt = 1; attempt <= probeAttempts; attempt++) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), probePerAttemptTimeoutMs)
        try {
          const response = await fetchFn(probeUrl, {
            method: 'POST',
            body: '{}',
            headers: {'Content-Type': 'application/json'},
            signal: ac.signal,
          })
          clearTimeout(timer)
          const status = response.status
          // Any HTTP response (2xx or 4xx) proves TLS terminated + Caddy routed → healthy.
          // 400 is the expected response for an unsigned POST to the HMAC-gated endpoint.
          if (status >= 200 && status < 500) {
            probeOk = true
            break
          }
        } catch {
          clearTimeout(timer)
          // Connection/TLS error or AbortError from per-attempt timeout — cert may still be issuing; retry
        }
        if (attempt < probeAttempts) {
          await sleepFn(probeIntervalMs)
        }
      }
      if (probeOk) {
        console.warn(`\u001B[1;32m✓\u001B[0m HTTPS ingress probe succeeded: ${probeUrl}`)
      } else {
        console.warn(
          `\u001B[1;33m[warn]\u001B[0m HTTPS ingress probe did not succeed — cert may still be issuing. ` +
            `Verify with: curl -sI ${probeUrl}`,
        )
      }
    }

    // Phase 9b2: Post-deploy operator health probe — warning-only, only when operator is enabled.
    // Probes GET /operator/health through the gateway-side Caddy route (https://<GATEWAY_HOST>/operator/health).
    // The dashboard→gateway private path is not yet active; the gateway Caddy /operator/* route is the
    // correct liveness origin for this topology stage. GATEWAY_OPERATOR_PUBLIC_ORIGIN (dashboard origin)
    // is NOT used here — it is only used for the OAuth callback preflight in dry-run output.
    // See docs/plans/2026-06-18-001-feat-dashboard-operator-same-origin-plan.md and AGENTS.md.
    // Requires HTTP 200 — the /operator/health route contract is a health check that returns 200 on success.
    // 3xx/4xx/5xx are not treated as success (unlike the announce probe which accepts any 2xx/4xx).
    // Connection/TLS errors are treated as transient (cert may still be issuing); we warn and continue.
    if (operatorEnabled) {
      const operatorHealthUrl = `https://${host}/operator/health`
      console.warn(`\u001B[1;34m==>\u001B[0m Probing operator health endpoint`)
      let operatorProbeOk = false
      for (let attempt = 1; attempt <= probeAttempts; attempt++) {
        const ac = new AbortController()
        const timer = setTimeout(() => ac.abort(), probePerAttemptTimeoutMs)
        try {
          const response = await fetchFn(operatorHealthUrl, {signal: ac.signal})
          clearTimeout(timer)
          const status = response.status
          // Require exactly HTTP 200 — the health route contract says 200 = healthy.
          // 3xx/4xx/5xx are routing failures or service errors, not success.
          if (status === 200) {
            operatorProbeOk = true
            break
          }
        } catch {
          clearTimeout(timer)
        }
        if (attempt < probeAttempts) {
          await sleepFn(probeIntervalMs)
        }
      }
      if (operatorProbeOk) {
        console.warn(`\u001B[1;32m✓\u001B[0m Operator health probe succeeded: ${operatorHealthUrl}`)
      } else {
        console.warn(
          `\u001B[1;33m[warn]\u001B[0m Operator health probe did not succeed — service may still be starting. ` +
            `Verify with: curl -sI ${operatorHealthUrl}`,
        )
      }
    }

    // Phase 9c: Verify running image digests match the CI-pushed GHCR digests.
    // This confirms the droplet is running the prebuilt artifact, not a stale or
    // locally-built image. Throws if the digest does not match — deploy fails loudly.
    //
    // Two-step inspect: containers have no .RepoDigests field — inspecting a container
    // directly returns a template error and empty stdout. Instead:
    //   1. Resolve the container's image SHA via `docker inspect --format '{{.Image}}' <container>`
    //   2. Inspect the IMAGE's RepoDigests via `docker inspect --format '{{json .RepoDigests}}' <imageSHA>`
    for (const [service, expectedDigest] of [
      ['gateway', gatewayDigest],
      ['workspace', workspaceDigest],
    ] as const) {
      // Step 1: resolve container → image SHA
      const {stdout: imageSha} = await runCommand(
        `Resolving running image SHA: ${service}`,
        sshCommand(
          host,
          `docker inspect --format '{{.Image}}' $(docker compose --project-directory ${DEPLOY_DIR} ps -q ${service})`,
          keyPath,
          controlPath,
        ),
        deployEnv,
        spawnFn,
      )
      // Step 2: inspect the IMAGE's RepoDigests
      const {stdout: repoDigestsJson} = await runCommand(
        `Verifying running image digest: ${service}`,
        sshCommand(host, `docker inspect --format '{{json .RepoDigests}}' ${imageSha.trim()}`, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
      // Narrow the parsed JSON: must be string[] — anything else is treated as empty
      // so assertRunningImageDigest throws its actionable mismatch error (not a TypeError).
      let repoDigests: string[]
      try {
        const parsed: unknown = JSON.parse(repoDigestsJson.trim())
        if (Array.isArray(parsed) && parsed.every(item => typeof item === 'string')) {
          repoDigests = parsed
        } else {
          repoDigests = []
        }
      } catch {
        repoDigests = []
      }
      assertRunningImageDigest(repoDigests, expectedDigest, service)
      console.warn(`\u001B[1;32m✓\u001B[0m ${service} image digest verified`)
    }

    // Phase 10: Persist checksum AFTER compose + registration + digest verification succeed
    // If any of phase 8, 9, or 9c threw, we never reach here — prior checksum stays in place
    // so the next deploy correctly detects secrets as changed and forces recreate.
    await writeRemoteFile(
      'Persisting secrets checksum',
      host,
      CHECKSUM_PATH,
      currentChecksum,
      deployEnv,
      spawnFn,
      secrets,
      keyPath,
      controlPath,
    )

    console.warn(`\u001B[1;32m✓\u001B[0m Registered commands: ${commands.join(', ')}`)

    console.warn('\u001B[1;32m✓\u001B[0m Deploy complete.')
  } finally {
    // Clean up both tmp directories regardless of success or failure.
    if (keyTmpDir) {
      rmSync(keyTmpDir, {recursive: true, force: true})
    }
    if (controlTmpDir) {
      rmSync(controlTmpDir, {recursive: true, force: true})
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
