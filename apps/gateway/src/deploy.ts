#!/usr/bin/env bun

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
}

export interface DeployArgs {
  dryRun: boolean
  forceRecreate: boolean
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REMOTE_DIR = '/opt/gateway'
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
 */
export function buildGatewayEnvFileContents(opts: {objectStoreHosts: string; model: string; config: string}): string {
  const {objectStoreHosts, model, config} = opts

  // Validate model: positive allow-list — exactly one /, non-empty provider + model segments,
  // characters limited to letters, digits, dots, hyphens, underscores.
  // Rejects whitespace, #, =, and any char outside the safe set.
  if (!MODEL_ALLOWLIST_RE.test(model)) {
    throw new Error(
      `WORKSPACE_OPENCODE_MODEL "${model}" is not a valid provider/model identifier. ` +
        'Use the format "provider/model" with characters limited to letters, digits, dots, hyphens, and underscores ' +
        '(e.g. "anthropic/claude-sonnet-4-6" or "openai/gpt-5.5-fast"). ' +
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

  return `OBJECT_STORE_HOSTS=${objectStoreHosts}\nWORKSPACE_OPENCODE_MODEL=${model}\nWORKSPACE_OPENCODE_CONFIG=${escapedConfig}\nWORKSPACE_EGRESS_HOSTS=${CLIPROXY_EGRESS_HOST},${OPENCODE_CATALOG_HOST}\n`
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
    secrets.push({name: 'gateway-webhook-secret', content: env.GATEWAY_WEBHOOK_SECRET ?? '', required: false})
    secrets.push({
      name: 'gateway-presence-channel-id',
      content: env.GATEWAY_PRESENCE_CHANNEL_ID ?? '',
      required: false,
    })
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

/**
 * Builds the compose.override.yaml content that adds a path-scoped Caddy reverse proxy
 * publishing :80/:443 on gateway-net, plus the daemon's announce secret wiring.
 *
 * This file is materialized on the droplet only when announceEnabled. When disabled,
 * git clean -xfd removes any prior copy automatically.
 *
 * Docker Compose merges the gateway service's `volumes:` list by mount-target key —
 * new targets APPEND, same-target REPLACES. The two announce bind mounts added here
 * use new targets (/run/secrets/gateway_webhook_secret and
 * /run/secrets/gateway_presence_channel_id), so upstream's other secret mounts are
 * preserved unchanged.
 */
export function buildComposeOverride(): string {
  return `services:
  gateway:
    environment:
      GATEWAY_WEBHOOK_SECRET_FILE: /run/secrets/gateway_webhook_secret
      GATEWAY_PRESENCE_CHANNEL_ID_FILE: /run/secrets/gateway_presence_channel_id
    volumes:
      - type: bind
        source: ./secrets/gateway-webhook-secret
        target: /run/secrets/gateway_webhook_secret
        read_only: true
        bind:
          create_host_path: false
      - type: bind
        source: ./secrets/gateway-presence-channel-id
        target: /run/secrets/gateway_presence_channel_id
        read_only: true
        bind:
          create_host_path: false
  caddy:
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
volumes:
  caddy_data:
  caddy_config:
`
}

/**
 * Builds the Caddyfile content for the announce ingress.
 *
 * Uses a named matcher (@announce) scoped to /v1/announce so the catch-all
 * respond 404 is a bare directive (not inside a handle block). This is ACME-safe:
 * Caddy uses TLS-ALPN-01 on :443 by default, which never touches HTTP paths, so
 * the 404 directive only affects request routing and cannot shadow ACME challenges.
 *
 * @param host - The gateway hostname (GATEWAY_HOST env var, e.g. gateway.fro.bot)
 */
export function buildCaddyfile(host: string): string {
  return `${host} {
  @announce path /v1/announce
  reverse_proxy @announce gateway:3000
  respond 404
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

// ─── main orchestrator ────────────────────────────────────────────────────────

export async function main(opts: MainOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const args = opts.args ?? process.argv.slice(2)
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const spawnFn = opts.spawn ?? defaultSpawn
  const maxAttempts = opts.maxAttempts ?? 10
  const intervalMs = opts.intervalMs ?? 3000

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

  // Phase 3b: Validate workspace .env vars (MODEL/CONFIG) before any SSH.
  // buildGatewayEnvFileContents throws with a descriptive message on invalid input.
  const missingWorkspace = getMissingWorkspaceEnvVars(env)
  if (missingWorkspace.length > 0) {
    throw new Error(`Missing required environment variables: ${missingWorkspace.join(', ')}`)
  }
  buildGatewayEnvFileContents({
    objectStoreHosts,
    model: env.WORKSPACE_OPENCODE_MODEL ?? '',
    config: env.WORKSPACE_OPENCODE_CONFIG ?? '',
  })

  // Phase 3c: Validate announce both-or-neither gate before any SSH.
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

  if (isDryRun) {
    console.warn('\u001B[1;33m[dry-run]\u001B[0m Planned actions:')
    console.warn(`  1. Ensure droplet workspace at ${REMOTE_DIR} (clone ${repo}@${ref} or fetch+reset)`)
    console.warn(`  2. Compute OBJECT_STORE_HOSTS: ${objectStoreHosts}`)
    console.warn(`  3. Materialize ${buildSecretFileList(env).length} secret files under ${SECRETS_DIR}`)
    console.warn(`  4. Write .env to ${ENV_PATH}`)
    console.warn(`  5. Run init-certs.sh (idempotent)`)
    console.warn(
      `  6. docker compose up -d --build --wait --wait-timeout 120${forceRecreate ? ' --force-recreate' : ''}`,
    )
    console.warn(
      `  7. Poll Discord slash command registration (app=${env.DISCORD_APPLICATION_ID} guild=${env.DISCORD_GUILD_ID})`,
    )
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

    // Phase 5b: Materialize compose.override.yaml + Caddyfile when announce is enabled.
    // These are working-tree files; git clean -xfd (phase 4) already removed any prior copy,
    // so they are only present when announceEnabled. writeRemoteFile overwrites idempotently.
    const announceEnabled = announceState === 'enabled'
    const overrideContent = announceEnabled ? buildComposeOverride() : ''
    const caddyfileContent = announceEnabled ? buildCaddyfile(validated.GATEWAY_HOST) : ''

    if (announceEnabled) {
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

    // Compute current checksum and read prior checksum to detect rotation.
    // Fold override + Caddyfile bytes into the checksum so toggling announce on/off
    // forces --force-recreate (Caddy is created/destroyed on the toggling deploy).
    const checksumInput: SecretFile[] = [...secrets]
    if (announceEnabled) {
      checksumInput.push({name: 'compose.override.yaml', content: overrideContent, required: false})
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

    // Phase 8: docker compose up
    // --remove-orphans: required to retire the Caddy container when announce is toggled off.
    // When disabled, the override is absent (git clean removed it), so Caddy is no longer a
    // declared service. Without --remove-orphans, the container lingers on :443.
    const composeArgs = [
      'docker',
      'compose',
      '--project-directory',
      DEPLOY_DIR,
      'up',
      '-d',
      '--build',
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

    // Phase 10: Persist checksum AFTER compose + registration succeed
    // If either phase 8 or 9 threw, we never reach here — prior checksum stays in place
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
