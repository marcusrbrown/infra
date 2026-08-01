#!/usr/bin/env bun

import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {validateDashboardHost} from './host'
import {runRemoteTransaction, type RemoteDeployPayload} from './remote-deploy'

const HEALTH_PATH = '/api/healthz'

// ─── Shell metacharacter deny-list ────────────────────────────────────────────
// These characters are dangerous when interpolated into remote shell context.
const SHELL_METACHAR_RE = /[\n\r`$|;&'"\\]/

// CalVer: YYYY.MM.N — four-digit year, two-digit month, non-negative integer patch.
const CALVER_RE = /^\d{4}\.\d{2}\.\d+$/

// ─── Types ───────────────────────────────────────────────────────────────────

/** Minimal subset of Bun.Subprocess used by this script. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {write: (data: Uint8Array) => void; end: () => void}
  exited: Promise<number>
}

export interface SpawnOpts {
  env: Readonly<Record<string, string>>
  stdout: 'pipe'
  stderr: 'pipe'
  stdin?: 'pipe'
}

/** Injectable spawn function — defaults to Bun.spawn. */
export type SpawnFn = (cmd: string[], opts: SpawnOpts) => SpawnResult

export interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  DASHBOARD_DOMAIN: string
}

export interface DeployOpts {
  env?: Record<string, string>
  spawn?: SpawnFn
  /** Injectable DNS resolver — throws if host doesn't resolve. */
  resolve?: (host: string) => Promise<void>
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  /** Number of public HTTPS probe attempts (default: 10). */
  probeAttempts?: number
  /** Interval between probe attempts in ms (default: 5_000). */
  probeIntervalMs?: number
  /**
   * CalVer version to deploy (e.g. "2026.06.47").
   * When set, the deploy resolves the image digest from GHCR, generates
   * compose content pinned to version@resolvedDigest for the remote transaction.
   * When empty/absent, the committed docker-compose.yaml is the source of truth.
   */
  version?: string
  /**
   * Expected sha256 digest for the versioned image (e.g. "sha256:abc...").
   * When set alongside version, the resolved digest must match this value exactly.
   * When empty, the resolved digest is used without a cross-check.
   */
  digest?: string
  /**
   * Local path to write the updated docker-compose.yaml after a successful
   * versioned deploy. When omitted, no local file is written — callers that
   * need the write (production entry point, tests asserting the write) must
   * pass this explicitly.
   *
   * Only written on the versioned path (when version is set) and only after
   * the full deploy completes successfully.
   */
  localComposePath?: string
}

/** Validated, typed environment required for deploy. */
export interface ValidatedEnv {
  PATH: string
  HOME: string
  DASHBOARD_DOMAIN: string
  DASHBOARD_GITHUB_APP_ID: string
  DASHBOARD_GITHUB_APP_KEY: string
  DASHBOARD_OAUTH_CLIENT_ID: string
  DASHBOARD_OAUTH_CLIENT_SECRET: string
  DASHBOARD_OPERATOR_LOGIN: string
  DASHBOARD_COOKIE_KEY: string
  SSH_AUTH_SOCK?: string
  DASHBOARD_SSH_KEY?: string
  GATEWAY_VPC_IP?: string
}

// ─── Exported helpers ─────────────────────────────────────────────────────────

/**
 * Validates that a version string is a well-formed CalVer (YYYY.MM.N).
 *
 * Accepts: strings matching `^\d{4}\.\d{2}\.\d+$` (e.g. "2026.06.47").
 * Rejects: "latest", semver, injection strings, empty strings, and anything
 *   that does not match the CalVer pattern.
 *
 * @throws {Error} when the version is not a valid CalVer string.
 */
export function validateCalVer(version: string): void {
  if (!version || !CALVER_RE.test(version)) {
    throw new Error(
      `Invalid version "${version}": must be a CalVer string matching YYYY.MM.N (e.g. 2026.06.47). ` +
        `"latest", semver, and injection strings are not accepted.`,
    )
  }
}

// sha256 digest: exactly "sha256:" followed by 64 lowercase hex characters.
const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

/**
 * Validates the explicit input mode for a deploy invocation.
 *
 * Valid modes:
 *   a) All release inputs empty (version, digest) — no-version fallback.
 *   b) version (CalVer) + optional digest.
 *
 * Invalid:
 *   - digest without version (digest-only)
 *   - malformed digest (must match ^sha256:[0-9a-f]{64}$)
 *
 * This is enforced before env validation and SSH so the error is surfaced early.
 *
 * @throws {Error} when the input combination is invalid.
 */
export function validateInputMode(version: string, digest: string): void {
  const hasVersion = Boolean(version)
  const hasDigest = Boolean(digest)

  // Mode (a): all empty — no-version fallback, nothing to validate here.
  if (!hasVersion && !hasDigest) return

  // Mode (b) requires version. Reject digest-only.
  if (!hasVersion) {
    throw new Error(
      `Invalid deploy input mode: version is required when digest is set. ` +
        `Either omit all inputs (no-version fallback) or provide version with an optional digest.`,
    )
  }

  // Validate digest format when provided.
  if (hasDigest && !DIGEST_RE.test(digest)) {
    throw new Error(
      `Invalid digest "${digest}": must match sha256:<64 hex chars> (e.g. sha256:abc...def). ` +
        `Malformed digests are not accepted.`,
    )
  }
}

/**
 * Generates docker-compose.yaml content with the image line replaced to pin
 * the given version and digest.
 *
 * Replaces the `image: ghcr.io/fro-bot/dashboard:...` line with
 * `image: ghcr.io/fro-bot/dashboard:<version>@<digest>`.
 *
 * @throws {Error} when digest is malformed (must match ^sha256:[0-9a-f]{64}$).
 * @throws {Error} when no fro-bot/dashboard image line is found in the content.
 * @throws {Error} when more than one fro-bot/dashboard image line is found (drift guard).
 */
export function generateComposeContent(originalContent: string, version: string, digest: string): string {
  if (!digest || !DIGEST_RE.test(digest)) {
    throw new Error(
      `Invalid digest "${digest}": must match sha256:<64 hex chars> (e.g. sha256:abc...def). ` +
        `Malformed digests are not accepted.`,
    )
  }

  const lines = originalContent.split('\n')
  let matchCount = 0

  const newLines = lines.map(line => {
    if (line.includes('fro-bot/dashboard')) {
      matchCount++
      // Preserve leading whitespace
      const indent = line.match(/^(\s*)/)?.[1] ?? ''
      return `${indent}image: ghcr.io/fro-bot/dashboard:${version}@${digest}`
    }
    return line
  })

  if (matchCount === 0) {
    throw new Error(
      'Could not find a fro-bot/dashboard image line in docker-compose.yaml. ' +
        'Cannot generate versioned compose content.',
    )
  }

  if (matchCount > 1) {
    throw new Error(
      `Found ${matchCount} fro-bot/dashboard image lines in docker-compose.yaml — expected exactly one. ` +
        `Multiple matches risk silent multi-service drift. Inspect the compose file and ensure only one service uses this image.`,
    )
  }

  return newLines.join('\n')
}

/**
 * Parses the sha256 digest from a docker-compose image line.
 *
 * Matches the `@sha256:<64 hex chars>` portion of an image reference such as:
 *   `image: ghcr.io/fro-bot/dashboard:2026.06.15@sha256:d3dd...`
 *
 * Returns the full `sha256:<hex>` string, or null if no digest is present.
 * No YAML parser dependency — simple regex on the image line.
 */
export function parseComposeImageDigest(line: string): string | null {
  const match = /@(sha256:[0-9a-f]{64})/.exec(line)
  return match?.[1] ?? null
}

/**
 * Reads the dashboard image digest from the committed docker-compose.yaml.
 *
 * Scans for the `dashboard:` service's `image:` line and extracts the
 * `@sha256:<hex>` digest. Throws if the compose file cannot be read or
 * the dashboard image line has no pinned digest.
 */
function readComposeDigest(): string {
  const composePath = join(import.meta.dir, '..', 'docker-compose.yaml')
  const content = readFileSync(composePath, 'utf8')

  // Find the dashboard service image line — look for fro-bot/dashboard with a digest
  for (const line of content.split('\n')) {
    if (line.includes('fro-bot/dashboard')) {
      const digest = parseComposeImageDigest(line)
      if (digest) return digest
    }
  }

  throw new Error(
    'Could not find a pinned sha256 digest for the dashboard image in apps/dashboard/docker-compose.yaml. ' +
      'Ensure the image line contains @sha256:<64 hex chars>.',
  )
}

/**
 * Validates that a secret value contains no shell metacharacters that would be
 * dangerous when interpolated into a remote shell context.
 *
 * @throws {Error} with the variable name and the offending character.
 */
export function validateSecretValue(value: string, name: string): void {
  const match = SHELL_METACHAR_RE.exec(value)
  if (match) {
    throw new Error(`${name} contains a disallowed shell metacharacter. Remove shell metacharacters before deploying.`)
  }
}

// IPv4 address: four decimal octets 0-255 separated by dots, nothing else.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

/**
 * Validates that GATEWAY_VPC_IP is a well-formed IPv4 address.
 *
 * Accepts: dotted-decimal IPv4 addresses with all octets in 0-255.
 * Rejects: empty strings, hostnames, IPv6, values starting with `-`,
 *   values with shell metacharacters, and malformed octets.
 *
 * @throws {Error} when the value is not a valid IPv4 address.
 * @returns The validated IP string (unchanged).
 */
export function validateGatewayVpcIp(ip: string): string {
  if (!ip) {
    throw new Error('GATEWAY_VPC_IP is required when set: value is empty')
  }

  const match = IPV4_RE.exec(ip)
  if (!match) {
    throw new Error(
      'GATEWAY_VPC_IP must be a valid IPv4 address (e.g. 10.116.0.3). ' +
        'Hostnames, IPv6 addresses, and non-IP values are not accepted.',
    )
  }

  // Validate each octet is in range 0-255
  for (let i = 1; i <= 4; i++) {
    const octet = Number(match[i])
    if (octet > 255) {
      throw new Error(
        'GATEWAY_VPC_IP must be a valid IPv4 address (e.g. 10.116.0.3). ' +
          `Octet ${i} (${String(match[i])}) is out of range 0-255.`,
      )
    }
  }

  return ip
}

/**
 * Validates all required environment variables are present and well-formed.
 * Calls validateDashboardHost on DASHBOARD_DOMAIN before any SSH argv is constructed.
 * Digest is sourced from the committed docker-compose.yaml, not from env.
 *
 * @throws {Error} with a specific message naming the missing/invalid variable.
 * @returns A typed ValidatedEnv with all required fields guaranteed non-empty.
 */
export function validateEnv(env: Record<string, string>): ValidatedEnv {
  const path = env.PATH
  if (!path) {
    throw new Error('PATH is required for deploy')
  }

  const home = env.HOME
  if (!home) {
    throw new Error('HOME is required for deploy')
  }

  // SSH context: local mode needs SSH_AUTH_SOCK; CI mode needs DASHBOARD_SSH_KEY
  if (!env.SSH_AUTH_SOCK && !env.DASHBOARD_SSH_KEY) {
    throw new Error('SSH context is required: set SSH_AUTH_SOCK (local mode) or DASHBOARD_SSH_KEY (CI mode)')
  }

  const domain = env.DASHBOARD_DOMAIN
  if (!domain) {
    throw new Error('DASHBOARD_DOMAIN is required for deploy')
  }

  const githubAppId = env.DASHBOARD_GITHUB_APP_ID
  if (!githubAppId) {
    throw new Error('DASHBOARD_GITHUB_APP_ID is required for deploy')
  }

  const githubAppKey = env.DASHBOARD_GITHUB_APP_KEY
  if (!githubAppKey) {
    throw new Error('DASHBOARD_GITHUB_APP_KEY is required for deploy')
  }

  const oauthClientId = env.DASHBOARD_OAUTH_CLIENT_ID
  if (!oauthClientId) {
    throw new Error('DASHBOARD_OAUTH_CLIENT_ID is required for deploy')
  }

  const oauthClientSecret = env.DASHBOARD_OAUTH_CLIENT_SECRET
  if (!oauthClientSecret) {
    throw new Error('DASHBOARD_OAUTH_CLIENT_SECRET is required for deploy')
  }

  const operatorLogin = env.DASHBOARD_OPERATOR_LOGIN
  if (!operatorLogin) {
    throw new Error('DASHBOARD_OPERATOR_LOGIN is required for deploy')
  }

  const cookieKey = env.DASHBOARD_COOKIE_KEY
  if (!cookieKey) {
    throw new Error('DASHBOARD_COOKIE_KEY is required for deploy')
  }

  // Validate host before any SSH argv construction
  validateDashboardHost(domain)

  // GATEWAY_VPC_IP is optional — only validated when present and non-empty.
  // When absent, the /operator/* Caddy route will fail to start (Caddy cannot
  // expand {$GATEWAY_VPC_IP}); this is intentional fail-closed behavior.
  const gatewayVpcIp = env.GATEWAY_VPC_IP
  if (gatewayVpcIp) {
    validateGatewayVpcIp(gatewayVpcIp)
  }

  return {
    PATH: path,
    HOME: home,
    DASHBOARD_DOMAIN: domain,
    DASHBOARD_GITHUB_APP_ID: githubAppId,
    DASHBOARD_GITHUB_APP_KEY: githubAppKey,
    DASHBOARD_OAUTH_CLIENT_ID: oauthClientId,
    DASHBOARD_OAUTH_CLIENT_SECRET: oauthClientSecret,
    DASHBOARD_OPERATOR_LOGIN: operatorLogin,
    DASHBOARD_COOKIE_KEY: cookieKey,
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
    ...(env.DASHBOARD_SSH_KEY ? {DASHBOARD_SSH_KEY: env.DASHBOARD_SSH_KEY} : {}),
    ...(gatewayVpcIp ? {GATEWAY_VPC_IP: gatewayVpcIp} : {}),
  }
}

/**
 * Builds the contents of the remote .env file.
 * Secrets travel via SSH stdin — this function only assembles the string.
 *
 * NOTE: The GitHub App private key is NOT included here. It is published as a
 * separate file (0600) by the lock-owning remote transaction. The .env references
 * the file path only.
 *
 * NOTE: Image pinning is done via the committed docker-compose.yaml digest pin,
 * not via an override file or env var.
 *
 * NOTE: GATEWAY_VPC_IP is included when provided so the Caddy container can
 * expand {$GATEWAY_VPC_IP} in the Caddyfile /operator/* route target. Both
 * the caddy and dashboard services read from the same .env file.
 */
export function buildEnvFileContents(opts: {
  domain: string
  githubAppId: string
  oauthClientId: string
  oauthClientSecret: string
  operatorLogin: string
  cookieKey: string
  gatewayVpcIp?: string
  /**
   * Raw, unvalidated `DASHBOARD_OPERATOR_PUSH_ENABLED` input. Only the exact
   * string "true" renders the flag line; any other value (absent, "false",
   * whitespace/case variants, non-boolean text) is treated as disabled and
   * omitted entirely. No VAPID key material or endpoint pointer is ever
   * derived from or related to this value — the dashboard reads its own
   * public key from the gateway's authenticated route at runtime.
   */
  operatorPushEnabled?: string
}): string {
  const {
    domain,
    githubAppId,
    oauthClientId,
    oauthClientSecret,
    operatorLogin,
    cookieKey,
    gatewayVpcIp,
    operatorPushEnabled,
  } = opts
  const lines = [
    `DASHBOARD_DOMAIN=${domain}`,
    `DASHBOARD_GITHUB_APP_ID=${githubAppId}`,
    `DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem`,
    `DASHBOARD_OAUTH_CLIENT_ID=${oauthClientId}`,
    `DASHBOARD_OAUTH_CLIENT_SECRET=${oauthClientSecret}`,
    `DASHBOARD_OAUTH_REDIRECT_URI=https://${domain}/auth/callback`,
    `DASHBOARD_OPERATOR_LOGIN=${operatorLogin}`,
    `DASHBOARD_COOKIE_KEY=${cookieKey}`,
    `DASHBOARD_OPERATOR_UI_ENABLED=true`,
    `DASHBOARD_GATEWAY_OPERATOR_SESSION_ENABLED=true`,
    ...(gatewayVpcIp ? [`GATEWAY_VPC_IP=${gatewayVpcIp}`] : []),
    ...(operatorPushEnabled === 'true' ? [`DASHBOARD_OPERATOR_PUSH_ENABLED=true`] : []),
    '',
  ]
  return lines.join('\n')
}

/**
 * Asserts that the running container's RepoDigests include the expected digest.
 *
 * Pure helper — no SSH, no side effects. Throws with an actionable message when
 * the running image does not match the digest pinned in docker-compose.yaml.
 *
 * @param actualRepoDigests - Array of RepoDigest strings from `docker inspect --format '{{json .RepoDigests}}'`
 * @param expectedDigest - The sha256 digest that must appear in at least one entry (e.g. "sha256:abc...")
 * @param serviceName - Human-readable service name for error messages (e.g. "dashboard")
 */
export function assertRunningImageDigest(
  actualRepoDigests: string[],
  expectedDigest: string,
  serviceName: string,
): void {
  const matched = actualRepoDigests.some(d => d.includes(expectedDigest))
  if (!matched) {
    throw new Error(
      `Running ${serviceName} image digest does not match the expected digest from docker-compose.yaml.\n` +
        `  Expected: ${expectedDigest}\n` +
        `  Actual RepoDigests: ${actualRepoDigests.length > 0 ? actualRepoDigests.join(', ') : '(empty)'}\n` +
        `The droplet may be running a stale or locally-built image. ` +
        `Re-run the deploy to pull the correct GHCR artifact.`,
    )
  }
}

function buildDeployEnv(env: Record<string, string>): DeployEnv {
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '/root',
    DASHBOARD_DOMAIN: env.DASHBOARD_DOMAIN ?? '',
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

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }

  return {stdout, stderr}
}

/**
 * Default DNS resolver using Bun's built-in DNS.
 */
async function defaultResolve(host: string): Promise<void> {
  const results = await Bun.dns.lookup(host)
  if (!results || results.length === 0) {
    throw new Error(`DNS resolution returned no results for ${host}`)
  }
}

/**
 * Resolves the top-level multi-arch digest for a versioned GHCR image.
 *
 * Uses `docker buildx imagetools inspect <image>:<version> --format '{{ .Manifest.Digest }}'`
 * to retrieve the top-level index/manifest digest. Falls back to parsing
 * plain `Digest: sha256:<hex>` output if the template format is unavailable.
 *
 * @throws {Error} when the digest cannot be resolved or parsed.
 */
async function resolveImageDigest(version: string, spawnFn: SpawnFn, deployEnv: DeployEnv): Promise<string> {
  const imageRef = `ghcr.io/fro-bot/dashboard:${version}`
  const {stdout} = await runCommand(
    `Resolving image digest for ${imageRef}`,
    ['docker', 'buildx', 'imagetools', 'inspect', imageRef, '--format', '{{ .Manifest.Digest }}'],
    deployEnv,
    spawnFn,
  )

  const trimmed = stdout.trim()

  // Primary: template output is the digest directly (e.g. "sha256:abc...")
  if (/^sha256:[0-9a-f]{64}$/.test(trimmed)) {
    return trimmed
  }

  // Fallback: parse "Digest: sha256:<hex>" from plain output
  const fallbackMatch = /Digest:\s*(sha256:[0-9a-f]{64})/.exec(trimmed)
  if (fallbackMatch?.[1]) {
    return fallbackMatch[1]
  }

  throw new Error(`Could not parse image digest from imagetools inspect output for ${imageRef}.`)
}

// ─── Main deploy orchestrator ─────────────────────────────────────────────────

/**
 * Deploys the Dashboard stack to the remote droplet.
 *
 * Two modes:
 *
 * **Versioned path** (version provided):
 *   Pre-gate: validate CalVer and digest shape (no secrets required).
 *   Then: resolve digest via `docker buildx imagetools inspect`, cross-check
 *   against dispatched digest (if provided), and generate compose content pinned
 *   to version@resolvedDigest locally.
 *
 * **No-version fallback** (no version):
 *   Read the digest and committed docker-compose.yaml locally.
 *
 * Order of operations:
 * 1. Pre-gate: validate input mode, digest shape, and CalVer
 * 2. Validate env (throws before any SSH on failure)
 * 3. Validate host (SSH argv injection defense)
 * 4. DNS preflight
 * 5. CI-only SSH key materialization under os.tmpdir()
 * 6. Versioned: resolve digest via imagetools inspect + cross-check; generate compose content
 *    No-version: read digest from committed docker-compose.yaml
 * 7. Read the committed Caddyfile and build the .env and PEM payload locally
 * 8. Start one SSH process with the framed payload. The transaction acquires the lock,
 *    captures baseline evidence, prunes, and enforces the first gate; acquires staged
 *    images and verifies exact digests; enforces the second gate; publishes active files
 *    with Compose last; converges dashboard and Caddy with runtime verification; then unlocks.
 * 9. Run advisory operator/public probes and versioned local audit write-back after unlock.
 */
export async function deploy(opts: DeployOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const spawnFn = opts.spawn ?? defaultSpawn
  const resolveFn = opts.resolve ?? defaultResolve
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const probeAttempts = opts.probeAttempts ?? 10
  const probeIntervalMs = opts.probeIntervalMs ?? 5_000
  const version = opts.version ?? ''
  const dispatchedDigest = opts.digest ?? ''
  // localComposePath: when provided, the versioned deploy writes the generated
  // compose content back here after success (for the workflow audit PR step).
  // When undefined, the write is skipped — callers that need the write (production
  // entry point, tests asserting the write) must pass this explicitly.
  const localComposePath = opts.localComposePath

  // ── Pre-gate: no-secret validation (runs before environment gate) ──────────
  // These checks require no secrets and can run before the environment gate.

  // Input mode: enforce valid combinations before CalVer checks.
  validateInputMode(version, dispatchedDigest)

  // CalVer validation: reject invalid version strings before any SSH/spawn.
  if (version) {
    validateCalVer(version)
  }

  // Phase 1: Validate env — throws before any SSH on failure
  const validated = validateEnv(env)

  const host = validated.DASHBOARD_DOMAIN

  // Boundary-validate secret values before any SSH
  validateSecretValue(validated.DASHBOARD_OAUTH_CLIENT_SECRET, 'DASHBOARD_OAUTH_CLIENT_SECRET')
  validateSecretValue(validated.DASHBOARD_COOKIE_KEY, 'DASHBOARD_COOKIE_KEY')
  // NOTE: DASHBOARD_GITHUB_APP_KEY is a PEM — it contains newlines which would fail
  // validateSecretValue. That's intentional: the PEM goes via stdin only, never shell-interpolated.

  // Phase 2: DNS preflight
  try {
    await resolveFn(host)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`DNS preflight failed for ${host}: ${msg}`)
  }

  const deployEnv = buildDeployEnv(env)

  // CI mode: write DASHBOARD_SSH_KEY to a tmp file with mode 0o600.
  // Local mode: keyPath stays undefined; SSH_AUTH_SOCK is forwarded via deployEnv.
  let keyPath: string | undefined
  let keyTmpDir: string | undefined

  try {
    if (env.DASHBOARD_SSH_KEY) {
      keyTmpDir = mkdtempSync(join(tmpdir(), 'dashboard-deploy-key-'))
      keyPath = join(keyTmpDir, 'id')
      const keyContent = env.DASHBOARD_SSH_KEY.endsWith('\n') ? env.DASHBOARD_SSH_KEY : `${env.DASHBOARD_SSH_KEY}\n`
      writeFileSync(keyPath, keyContent, {mode: 0o600})
      // Defensive chmod in case umask narrowed the initial mode
      chmodSync(keyPath, 0o600)
    }

    // Phase 3: Determine image digest and compose content locally.
    // - Versioned path: resolve digest from GHCR, compare to dispatched digest, generate compose
    // - No-version fallback: read digest and committed compose locally
    let imageDigest: string
    let composeContentForRemote: string
    const committedComposePath = join(import.meta.dir, '..', 'docker-compose.yaml')
    const committedCompose = readFileSync(committedComposePath, 'utf8')

    if (version) {
      // Versioned path: resolve top-level digest via imagetools inspect
      const resolvedDigest = await resolveImageDigest(version, spawnFn, deployEnv)

      // Cross-check: if a dispatched digest was provided, it must match the resolved digest
      if (dispatchedDigest && resolvedDigest !== dispatchedDigest) {
        throw new Error(
          `Image digest mismatch for ghcr.io/fro-bot/dashboard:${version}.\n` +
            `  Dispatched digest: ${dispatchedDigest}\n` +
            `  Resolved digest:   ${resolvedDigest}\n` +
            `The dispatched digest does not match the current GHCR image. ` +
            `Re-dispatch with the correct digest or omit the digest field.`,
        )
      }

      imageDigest = resolvedDigest

      // Generate compose content with version@resolvedDigest from the committed template.
      composeContentForRemote = generateComposeContent(committedCompose, version, resolvedDigest)
    } else {
      // No-version fallback: the committed compose is the remote payload source of truth.
      imageDigest = readComposeDigest()
      composeContentForRemote = committedCompose
    }

    // Phase 4: Build every remote file locally before opening the SSH transaction.
    // The .env includes DASHBOARD_GITHUB_APP_KEY_FILE (file path), not the PEM content.
    const envContents = buildEnvFileContents({
      domain: host,
      githubAppId: validated.DASHBOARD_GITHUB_APP_ID,
      oauthClientId: validated.DASHBOARD_OAUTH_CLIENT_ID,
      oauthClientSecret: validated.DASHBOARD_OAUTH_CLIENT_SECRET,
      operatorLogin: validated.DASHBOARD_OPERATOR_LOGIN,
      cookieKey: validated.DASHBOARD_COOKIE_KEY,
      gatewayVpcIp: validated.GATEWAY_VPC_IP,
      // Independently-controlled, non-secret server-side push flag. Read raw from
      // process env — never validated/normalized beyond the exact-match check inside
      // buildEnvFileContents. No VAPID material is read here or anywhere in this file.
      operatorPushEnabled: env.DASHBOARD_OPERATOR_PUSH_ENABLED,
    })
    const localCaddyfile = join(import.meta.dir, '..', 'config', 'Caddyfile')
    const caddyfileContents = readFileSync(localCaddyfile, 'utf8')

    // The PEM bytes flow through the framed stdin payload only — never in argv or a local temp file.
    const normalizedPem = validated.DASHBOARD_GITHUB_APP_KEY.endsWith('\n')
      ? validated.DASHBOARD_GITHUB_APP_KEY
      : `${validated.DASHBOARD_GITHUB_APP_KEY}\n`

    const payload: RemoteDeployPayload = {
      env: envContents,
      compose: composeContentForRemote,
      caddyfile: caddyfileContents,
      githubAppKey: normalizedPem,
      expectedDashboardDigest: imageDigest,
    }

    // Phase 5: One remote transaction owns the lock and every host mutation.
    // The lock remains held through dashboard health/digest verification and Caddy convergence.
    console.warn('\u001B[1;34m==>\u001B[0m Running locked dashboard remote transaction')
    const remoteTransactionResult = await runRemoteTransaction({
      host,
      payload,
      env: deployEnv,
      keyPath,
      spawn: spawnFn,
    })

    // The remote boundary has already filtered stdout to the deterministic stage
    // and evidence allowlist. Never log raw remote stdout/stderr here.
    for (const evidenceLine of remoteTransactionResult.evidence) {
      console.warn(evidenceLine)
    }

    console.warn('\u001B[1;32m✓\u001B[0m Remote dashboard transaction converged')

    // Post-transaction: same-origin /operator/health advisory check (non-blocking).
    //
    // Gated on GATEWAY_VPC_IP being set — this indicates the /operator/* Caddy route is active.
    // When GATEWAY_VPC_IP is absent, the route is not configured and this check is skipped.
    //
    // The gateway bridge is deployed independently; the dashboard deploy must not depend on
    // gateway readiness. A non-200 result (or unreachable endpoint) emits a warning and
    // continues — it does NOT fail the deploy. The dashboard is standalone.
    //
    // When the probe succeeds (200), the success is logged as confirmation that the
    // same-origin path is working end-to-end (Caddy route + VPC reach + gateway daemon).
    //
    // The public-denied gateway.fro.bot:9300 check and DO firewall readback belong to the
    // gateway deploy (Phase 8e). The DOCKER-USER readback belongs to Phase 8c of the gateway deploy.
    if (validated.GATEWAY_VPC_IP) {
      // Bounded retry loop — DO firewall propagation and Caddy↔backend startup timing can
      // cause transient failures. Mirrors the /api/healthz probe pattern (probeAttempts /
      // probeIntervalMs). Advisory only: never throws regardless of outcome.
      const operatorHealthUrl = `https://${host}/operator/health`
      console.warn(`\u001B[1;34m==>\u001B[0m Probing same-origin operator health endpoint: ${operatorHealthUrl}`)
      let operatorHealthOk = false
      let lastOperatorHealthStatus = 0
      let lastOperatorHealthError: string | undefined

      for (let attempt = 1; attempt <= probeAttempts; attempt++) {
        try {
          const response = await fetchFn(operatorHealthUrl, {
            signal: AbortSignal.timeout(10_000),
          })
          lastOperatorHealthStatus = response.status
          if (response.status === 200) {
            operatorHealthOk = true
            break
          }
        } catch (error) {
          lastOperatorHealthError = error instanceof Error ? error.message : String(error)
        }

        if (attempt < probeAttempts) {
          await sleepFn(probeIntervalMs)
        }
      }

      if (operatorHealthOk) {
        console.warn(`\u001B[1;32m✓\u001B[0m Same-origin operator health check passed: ${operatorHealthUrl} → 200`)
      } else if (lastOperatorHealthError) {
        console.warn(
          `\u001B[1;33m[warn]\u001B[0m Same-origin operator health check did not pass after ${probeAttempts} attempt(s): ` +
            `could not reach ${operatorHealthUrl}. ` +
            `The gateway bridge may not be live yet or the firewall has not propagated. ` +
            `Last error: ${lastOperatorHealthError}`,
        )
      } else {
        console.warn(
          `\u001B[1;33m[warn]\u001B[0m Same-origin operator health check did not pass after ${probeAttempts} attempt(s): ` +
            `${operatorHealthUrl} returned HTTP ${lastOperatorHealthStatus} (expected 200). ` +
            `The gateway bridge may not be live yet — verify the gateway deploy has completed.`,
        )
      }
    }

    // Post-transaction: public HTTPS probe (warning-only — Caddy ACME cert may still be issuing)
    let probeOk = false
    let lastProbeStatus = 0
    let lastProbeError: string | undefined
    for (let attempt = 1; attempt <= probeAttempts; attempt++) {
      try {
        const response = await fetchFn(`https://${host}${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(10_000),
        })
        lastProbeStatus = response.status
        if (response.ok) {
          probeOk = true
          break
        }
      } catch (error) {
        lastProbeError = error instanceof Error ? error.message : String(error)
      }

      if (attempt < probeAttempts) {
        await sleepFn(probeIntervalMs)
      }
    }

    if (probeOk) {
      console.warn(`\u001B[1;32m✓\u001B[0m Public HTTPS probe succeeded: https://${host}${HEALTH_PATH}`)
    } else if (lastProbeError) {
      console.warn(
        `\u001B[1;33m[warn]\u001B[0m containers healthy; TLS cert may still be issuing — ` +
          `verify at https://${host}${HEALTH_PATH}. ` +
          `Last error: ${lastProbeError}`,
      )
    } else {
      console.warn(
        `\u001B[1;33m[warn]\u001B[0m containers healthy; TLS cert may still be issuing — ` +
          `verify at https://${host}${HEALTH_PATH}. ` +
          `Last HTTP status: ${lastProbeStatus}`,
      )
    }

    // Post-transaction audit: write the generated compose content back to the local file.
    // This is the audit record committed by the workflow's audit PR step.
    // Only written after the full deploy completes successfully — never on failure.
    // Only written when localComposePath is explicitly provided (production entry point passes it;
    // tests that don't need the write omit it for isolation).
    if (version && localComposePath !== undefined) {
      writeFileSync(localComposePath, composeContentForRemote, 'utf8')
      console.warn(`\u001B[1;32m✓\u001B[0m Updated local compose pin: ${localComposePath}`)
    }

    console.warn('\u001B[1;32m✓\u001B[0m Deploy complete.')
  } finally {
    // Clean up CI key material regardless of success or failure.
    if (keyTmpDir) {
      rmSync(keyTmpDir, {recursive: true, force: true})
    }
  }
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  deploy({
    version: process.env.DEPLOY_VERSION ?? '',
    digest: process.env.DEPLOY_DIGEST ?? '',
    // Pass the committed compose path explicitly so the versioned deploy writes
    // the updated pin back for the workflow's audit PR step.
    localComposePath: join(import.meta.dir, '..', 'docker-compose.yaml'),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
