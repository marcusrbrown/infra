#!/usr/bin/env bun

import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {validateDashboardHost} from './host'

// ─── Remote paths ─────────────────────────────────────────────────────────────

const REMOTE_DIR = '/opt/dashboard'
const REMOTE_ENV_PATH = `${REMOTE_DIR}/.env`
const REMOTE_COMPOSE_PATH = `${REMOTE_DIR}/docker-compose.yaml`
const REMOTE_CONFIG_DIR = `${REMOTE_DIR}/config`
const REMOTE_DATA_DIR = `${REMOTE_DIR}/data`
const REMOTE_ROOT_SETUP_COMMAND = [
  'set -eu',
  `if [ -L '${REMOTE_DIR}' ]; then echo 'Refusing dashboard root symlink' >&2; exit 1; fi`,
  `if [ -e '${REMOTE_DIR}' ] && [ ! -d '${REMOTE_DIR}' ]; then echo 'Refusing dashboard root non-directory' >&2; exit 1; fi`,
  `if [ -L '${REMOTE_CONFIG_DIR}' ]; then echo 'Refusing dashboard config symlink' >&2; exit 1; fi`,
  `if [ -e '${REMOTE_CONFIG_DIR}' ] && [ ! -d '${REMOTE_CONFIG_DIR}' ]; then echo 'Refusing dashboard config non-directory' >&2; exit 1; fi`,
  `install -d -m 0755 -o 0 -g 0 '${REMOTE_DIR}'`,
  `install -d -m 0755 -o 0 -g 0 '${REMOTE_CONFIG_DIR}'`,
  `chown 0:0 '${REMOTE_DIR}' '${REMOTE_CONFIG_DIR}'`,
  `[ "$(realpath -e '${REMOTE_DIR}')" = '${REMOTE_DIR}' ]`,
  `[ "$(realpath -e '${REMOTE_CONFIG_DIR}')" = '${REMOTE_CONFIG_DIR}' ]`,
].join('; ')
const REMOTE_DATA_SETUP_COMMAND = [
  'set -eu',
  `if [ -L '${REMOTE_DATA_DIR}' ]; then echo 'Refusing listener data path symlink' >&2; exit 1; fi`,
  `if [ -e '${REMOTE_DATA_DIR}' ] && [ ! -d '${REMOTE_DATA_DIR}' ]; then echo 'Refusing listener data path non-directory' >&2; exit 1; fi`,
  `install -d -m 0700 -o 1000 -g 1000 '${REMOTE_DATA_DIR}'`,
  `chown -R 1000:1000 '${REMOTE_DATA_DIR}'`,
  `chmod 0700 '${REMOTE_DATA_DIR}'`,
  `[ -d '${REMOTE_DATA_DIR}' ] && [ ! -L '${REMOTE_DATA_DIR}' ] && [ "$(realpath -e '${REMOTE_DATA_DIR}')" = '${REMOTE_DATA_DIR}' ]`,
].join('; ')
const REMOTE_CADDYFILE_PATH = `${REMOTE_CONFIG_DIR}/Caddyfile`
const REMOTE_APP_KEY_PATH = `${REMOTE_CONFIG_DIR}/github-app.pem`
const HEALTH_PATH = '/api/healthz'
const DEFAULT_REMOTE_USER = 'root'

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
  env: DeployEnv
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
   * compose content pinned to version@resolvedDigest, and uploads it.
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
 * NOTE: The GitHub App private key is NOT included here. It is uploaded as a
 * separate file (0600) via SSH stdin. The .env references the file path only.
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
}): string {
  const {domain, githubAppId, oauthClientId, oauthClientSecret, operatorLogin, cookieKey, gatewayVpcIp} = opts
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

// ─── SSH helpers ──────────────────────────────────────────────────────────────

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
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=60s']
      : []),
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}

function scpCommand(
  localPath: string,
  host: string,
  remotePath: string,
  keyPath?: string,
  controlPath?: string,
): string[] {
  return [
    'scp',
    ...sshIdentityOptions(keyPath),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...(controlPath
      ? ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=60s']
      : []),
    localPath,
    `${DEFAULT_REMOTE_USER}@${host}:${remotePath}`,
  ]
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
 * Content is NEVER placed in the shell command argv — it flows through stdin only.
 *
 * SECURITY: This is the only safe way to transfer secret bytes (PEM keys, tokens)
 * to the remote host. Never use argv for secret content.
 */
async function writeRemoteFile(
  label: string,
  host: string,
  remotePath: string,
  content: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

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
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw new Error(`Command failed with exit code ${exitCode}: ${label}`)
  }

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }
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

  throw new Error(
    `Could not parse image digest from imagetools inspect output for ${imageRef}.\n` +
      `Output: ${trimmed.slice(0, 200)}`,
  )
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
 *   against dispatched digest (if provided), generate compose content pinned to
 *   version@resolvedDigest, upload via SSH stdin.
 *
 * **No-version fallback** (no version):
 *   Read digest from committed docker-compose.yaml; scp the committed file.
 *
 * Order of operations:
 * 1. Pre-gate: validate input mode, digest shape, and CalVer
 * 2. Validate env (throws before any SSH on failure)
 * 3. Validate host (SSH argv injection defense)
 * 4. DNS preflight
 * 5. ControlMaster SSH multiplexing setup (dual-tmpdir: key under os.tmpdir(), socket under /tmp)
 * 6. Versioned: resolve digest via imagetools inspect + cross-check; generate compose content
 *    No-version: read digest from committed docker-compose.yaml
 * 7. Remote prep: constant-only fail-closed validation/convergence for /opt/dashboard and
 *    /opt/dashboard/config; reject symlinks and existing non-directories before mutation,
 *    create both as root-owned real directories, and verify their physical paths with realpath -e
 * 8. Remote prep: reject a symlink or existing non-directory at /opt/dashboard/data, then
 *    install it with mode 0700 and owner 1000:1000, recursively chown existing contents, reapply
 *    mode 0700 to the root, and verify it remains a real directory
 * 9. Materialize /opt/dashboard/.env via SSH stdin (includes DASHBOARD_GITHUB_APP_KEY_FILE path)
 * 10. Versioned: upload generated compose via SSH stdin
 *    No-version: scp committed docker-compose.yaml
 *    Both: scp config/Caddyfile
 * 11. Upload GitHub App private key via SSH stdin to /opt/dashboard/config/github-app.pem (0600)
 *     SECURITY: PEM bytes flow through stdin ONLY — never in argv, never in a local temp file
 * 12. chown 1000:1000 github-app.pem so the container's node user (UID 1000) can read it
 * 13. rm -f /opt/dashboard/docker-compose.override.yaml (idempotent legacy cleanup)
 * 14. docker compose pull (pulls digest-pinned GHCR image from docker-compose.yaml)
 * 15. docker compose up -d --no-build --wait dashboard (app health gate first)
 * 16. Verify RepoDigests: assert running image includes selected digest (fail closed)
 * 17. docker compose up -d --no-build --wait caddy (public exposure after app healthy)
 * 18. Probe https://$DASHBOARD_DOMAIN/api/healthz — bounded retry; warning-only on ACME lag
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

  // Phase 3: DNS preflight
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
  // ControlMaster socket lives under a SHORT /tmp-rooted dir to stay well under the
  // 104-byte sun_path limit for unix-domain sockets. On macOS, os.tmpdir() returns a
  // long path like /var/folders/td/f1mm.../T/ which causes ControlPath to exceed 104
  // bytes → ssh fails with "ControlPath too long". The private key file stays in the
  // secure os.tmpdir()-rooted dir (user-owned mode-700); only the socket moves to /tmp.
  let controlTmpDir: string | undefined

  try {
    // Key dir: secure, user-owned, under os.tmpdir() (may be long on macOS — that's fine
    // for a regular file path; the 104-byte limit only applies to unix-domain sockets).
    keyTmpDir = mkdtempSync(join(tmpdir(), 'dashboard-deploy-key-'))

    // Control socket dir: always under /tmp so the socket path stays short.
    controlTmpDir = mkdtempSync(join('/tmp', 'dash-cm-'))

    if (env.DASHBOARD_SSH_KEY) {
      keyPath = join(keyTmpDir, 'id')
      const keyContent = env.DASHBOARD_SSH_KEY.endsWith('\n') ? env.DASHBOARD_SSH_KEY : `${env.DASHBOARD_SSH_KEY}\n`
      writeFileSync(keyPath, keyContent, {mode: 0o600})
      // Defensive chmod in case umask narrowed the initial mode
      chmodSync(keyPath, 0o600)
    }

    // ControlPath socket lives inside controlTmpDir (short /tmp-rooted path).
    // %C expands to a hash of the connection tuple.
    const controlPath = join(controlTmpDir, 'cm-%C')

    // Phase 2: Determine image digest and compose content
    // - Versioned path: resolve digest from GHCR, compare to dispatched digest, generate compose
    // - No-version fallback: read digest from committed docker-compose.yaml, scp the file
    let imageDigest: string
    let composeContentForUpload: string | null = null // null = use scp of committed file

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

      // Generate compose content with version@resolvedDigest.
      // Always read from the committed file (source of truth for the template).
      // localComposePath (if provided) is the write-back target after success.
      const committedComposePath = join(import.meta.dir, '..', 'docker-compose.yaml')
      const originalCompose = readFileSync(committedComposePath, 'utf8')
      composeContentForUpload = generateComposeContent(originalCompose, version, resolvedDigest)
    } else {
      // No-version fallback: read digest from committed docker-compose.yaml
      imageDigest = readComposeDigest()
    }

    // Phase 4: Remote prep
    await runCommand(
      'Creating remote directories',
      sshCommand(host, REMOTE_ROOT_SETUP_COMMAND, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 4b: Converge persistent listener storage ownership and permissions.
    // This is the authority for both existing and newly provisioned hosts.
    await runCommand(
      'Creating remote listener data directory',
      sshCommand(host, REMOTE_DATA_SETUP_COMMAND, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 5: Materialize /opt/dashboard/.env via SSH stdin
    // The .env includes DASHBOARD_GITHUB_APP_KEY_FILE (file path) — NOT the PEM content.
    // Image pinning is handled by the digest in docker-compose.yaml, not the .env.
    const envContents = buildEnvFileContents({
      domain: host,
      githubAppId: validated.DASHBOARD_GITHUB_APP_ID,
      oauthClientId: validated.DASHBOARD_OAUTH_CLIENT_ID,
      oauthClientSecret: validated.DASHBOARD_OAUTH_CLIENT_SECRET,
      operatorLogin: validated.DASHBOARD_OPERATOR_LOGIN,
      cookieKey: validated.DASHBOARD_COOKIE_KEY,
      gatewayVpcIp: validated.GATEWAY_VPC_IP,
    })
    await writeRemoteFile(
      `Writing ${REMOTE_ENV_PATH}`,
      host,
      REMOTE_ENV_PATH,
      envContents,
      deployEnv,
      spawnFn,
      keyPath,
      controlPath,
    )

    // Phase 6: Upload docker-compose.yaml and Caddyfile
    const localCaddyfile = join(import.meta.dir, '..', 'config', 'Caddyfile')

    if (composeContentForUpload === null) {
      // No-version fallback: scp the committed docker-compose.yaml
      const committedComposePath = join(import.meta.dir, '..', 'docker-compose.yaml')
      await runCommand(
        'Copying docker-compose.yaml',
        scpCommand(committedComposePath, host, REMOTE_COMPOSE_PATH, keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
    } else {
      // Versioned path: upload generated compose content via SSH stdin
      await writeRemoteFile(
        `Writing ${REMOTE_COMPOSE_PATH} (versioned: ${version}@${imageDigest.slice(0, 19)}...)`,
        host,
        REMOTE_COMPOSE_PATH,
        composeContentForUpload,
        deployEnv,
        spawnFn,
        keyPath,
        controlPath,
      )
    }

    await runCommand(
      'Copying Caddyfile',
      scpCommand(localCaddyfile, host, REMOTE_CADDYFILE_PATH, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 7: Upload GitHub App private key via SSH stdin (SECURITY-CRITICAL)
    // The PEM bytes flow through stdin ONLY — never in argv, never in a local temp file.
    // umask 077 ensures the file is created with 0600 permissions.
    // We also explicitly chmod 0600 after write for defense-in-depth.
    const normalizedPem = validated.DASHBOARD_GITHUB_APP_KEY.endsWith('\n')
      ? validated.DASHBOARD_GITHUB_APP_KEY
      : `${validated.DASHBOARD_GITHUB_APP_KEY}\n`

    await writeRemoteFile(
      `Writing ${REMOTE_APP_KEY_PATH} (GitHub App private key)`,
      host,
      REMOTE_APP_KEY_PATH,
      normalizedPem,
      deployEnv,
      spawnFn,
      keyPath,
      controlPath,
    )

    // Explicit chmod 0600 for defense-in-depth (umask 077 already sets this, but be explicit)
    await runCommand(
      `Setting permissions on ${REMOTE_APP_KEY_PATH}`,
      sshCommand(host, `chmod 0600 '${REMOTE_APP_KEY_PATH}'`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // chown 1000:1000 so the container's node user (UID 1000) can read the key.
    // docker-compose.yaml runs the dashboard container as `user: node` (UID 1000).
    // The bind mount maps host UID 1000 → container UID 1000, so chown on the host
    // makes the file readable by the node process inside the container.
    // Combined with 0600, only UID 1000 (node) can read the key — least-privilege.
    await runCommand(
      `Setting ownership on ${REMOTE_APP_KEY_PATH} (node user UID 1000)`,
      sshCommand(host, `chown 1000:1000 '${REMOTE_APP_KEY_PATH}'`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 7.5: Remove stale legacy override file (idempotent).
    // Old deploys wrote /opt/dashboard/docker-compose.override.yaml which Docker Compose
    // auto-merges if present. The image pin now lives in the committed docker-compose.yaml,
    // so the override must be removed before `docker compose pull` to prevent any stale
    // image reference in the override from winning and causing confusing digest verification
    // failures.
    await runCommand(
      'Removing stale docker-compose.override.yaml (legacy cleanup)',
      sshCommand(host, `rm -f ${REMOTE_DIR}/docker-compose.override.yaml`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8: docker compose pull (pulls digest-pinned GHCR image from docker-compose.yaml)
    await runCommand(
      'Pulling Docker images',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose pull`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 9: Start dashboard only (Caddy NOT started — no public exposure yet).
    // --no-build enforces digest-pinned image; never builds from source on the droplet.
    // --wait-timeout 120 bounds the health-check wait and surfaces clear timeout errors.
    await runCommand(
      'Starting dashboard (internal only)',
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait --wait-timeout 120 dashboard`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    // Phase 10: Verify RepoDigests — fail closed if running image doesn't match expected digest.
    // Two-step inspect: containers have no .RepoDigests field — inspect the image instead.
    //   1. Resolve the container's image SHA via `docker inspect --format '{{.Image}}' <container>`
    //   2. Inspect the IMAGE's RepoDigests via `docker inspect --format '{{json .RepoDigests}}' <imageSHA>`
    const {stdout: imageSha} = await runCommand(
      'Resolving running image SHA: dashboard',
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker inspect --format '{{.Image}}' $(docker compose ps -q dashboard)`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    const {stdout: repoDigestsJson} = await runCommand(
      'Verifying running image digest: dashboard',
      sshCommand(host, `docker inspect --format '{{json .RepoDigests}}' ${imageSha.trim()}`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

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

    assertRunningImageDigest(repoDigests, imageDigest, 'dashboard')
    console.warn('\u001B[1;32m✓\u001B[0m dashboard image digest verified')

    // Phase 11: Start Caddy — now safe to expose publicly (app is healthy + digest verified).
    // --wait-timeout 120 bounds the health-check wait and surfaces clear timeout errors.
    await runCommand(
      'Starting Caddy (public exposure)',
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait --wait-timeout 120 caddy`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    // Phase 12b: Same-origin /operator/health advisory check (non-blocking).
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

    // Phase 12: Public HTTPS probe (warning-only — Caddy ACME cert may still be issuing)
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

    // Versioned path: write the generated compose content back to the local file.
    // This is the audit record committed by the workflow's audit PR step.
    // Only written after the full deploy completes successfully — never on failure.
    // Only written when localComposePath is explicitly provided (production entry point passes it;
    // tests that don't need the write omit it for isolation).
    if (composeContentForUpload !== null && localComposePath !== undefined) {
      writeFileSync(localComposePath, composeContentForUpload, 'utf8')
      console.warn(`\u001B[1;32m✓\u001B[0m Updated local compose pin: ${localComposePath}`)
    }

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
