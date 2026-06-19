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
const REMOTE_CADDYFILE_PATH = `${REMOTE_CONFIG_DIR}/Caddyfile`
const REMOTE_APP_KEY_PATH = `${REMOTE_CONFIG_DIR}/github-app.pem`
const HEALTH_PATH = '/api/healthz'
const DEFAULT_REMOTE_USER = 'root'

// ─── Shell metacharacter deny-list ────────────────────────────────────────────
// These characters are dangerous when interpolated into remote shell context.
const SHELL_METACHAR_RE = /[\n\r`$|;&'"\\]/

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

// ─── Main deploy orchestrator ─────────────────────────────────────────────────

/**
 * Deploys the Dashboard stack to the remote droplet.
 *
 * Order of operations:
 * 1. Validate env (throws before any SSH on failure)
 * 2. Validate host (SSH argv injection defense)
 * 3. Read expected digest from committed docker-compose.yaml (fail closed if not pinned)
 * 4. DNS preflight
 * 5. ControlMaster SSH multiplexing setup (dual-tmpdir: key under os.tmpdir(), socket under /tmp)
 * 6. Remote prep: mkdir -p /opt/dashboard/config
 * 7. Materialize /opt/dashboard/.env via SSH stdin (includes DASHBOARD_GITHUB_APP_KEY_FILE path)
 * 8. scp docker-compose.yaml + config/Caddyfile
 * 9. Upload GitHub App private key via SSH stdin to /opt/dashboard/config/github-app.pem (0600)
 *    SECURITY: PEM bytes flow through stdin ONLY — never in argv, never in a local temp file
 * 10. chown 1000:1000 github-app.pem so the container's node user (UID 1000) can read it
 * 11. rm -f /opt/dashboard/docker-compose.override.yaml (idempotent legacy cleanup — old deploys
 *     wrote this file; Docker Compose auto-merges it if present, which would override the image pin)
 * 12. docker compose pull (pulls digest-pinned GHCR image from docker-compose.yaml)
 * 13. docker compose up -d --no-build --wait dashboard (app health gate first)
 * 14. Verify RepoDigests: assert running image includes digest from docker-compose.yaml (fail closed)
 * 15. docker compose up -d --no-build --wait caddy (public exposure after app healthy)
 * 16. Probe https://$DASHBOARD_DOMAIN/api/healthz — bounded retry; warning-only on ACME lag
 */
export async function deploy(opts: DeployOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const spawnFn = opts.spawn ?? defaultSpawn
  const resolveFn = opts.resolve ?? defaultResolve
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const probeAttempts = opts.probeAttempts ?? 10
  const probeIntervalMs = opts.probeIntervalMs ?? 5_000

  // Phase 1: Validate env — throws before any SSH on failure
  const validated = validateEnv(env)

  const host = validated.DASHBOARD_DOMAIN

  // Phase 2: Read expected digest from committed docker-compose.yaml (fail closed)
  const imageDigest = readComposeDigest()

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

    // Phase 4: Remote prep
    await runCommand(
      'Creating remote directories',
      sshCommand(host, `mkdir -p ${REMOTE_CONFIG_DIR}`, keyPath, controlPath),
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

    // Phase 6: scp docker-compose.yaml and Caddyfile
    const localCompose = join(import.meta.dir, '..', 'docker-compose.yaml')
    const localCaddyfile = join(import.meta.dir, '..', 'config', 'Caddyfile')

    await runCommand(
      'Copying docker-compose.yaml',
      scpCommand(localCompose, host, REMOTE_COMPOSE_PATH, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

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
    await runCommand(
      'Starting dashboard (internal only)',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait dashboard`, keyPath, controlPath),
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
    await runCommand(
      'Starting Caddy (public exposure)',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait caddy`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 12b: Same-origin /operator/health 200 check.
    //
    // Gated on GATEWAY_VPC_IP being set — this indicates the /operator/* Caddy route is active.
    // When GATEWAY_VPC_IP is absent, the route is not configured and this check is skipped.
    //
    // The dashboard deploy owns the /operator/* Caddy route and runs after the gateway deploy.
    // Once Caddy is up (Phase 11), the runner can probe https://dashboard.fro.bot/operator/health
    // from the public internet — the route proxies through Caddy → VPC → gateway operator daemon.
    //
    // Fail closed: /operator/health != 200 → deploy throws.
    // This proves the same-origin path works end-to-end (Caddy route + VPC reach + daemon guard).
    //
    // The public-denied gateway.fro.bot:9300 check and DO firewall readback belong to the
    // gateway deploy (Phase 8e). The DOCKER-USER readback belongs to Phase 8c of the gateway deploy.
    if (validated.GATEWAY_VPC_IP) {
      const operatorHealthUrl = `https://${host}/operator/health`
      console.warn(`\u001B[1;34m==>\u001B[0m Probing same-origin operator health endpoint: ${operatorHealthUrl}`)
      let operatorHealthOk = false
      let operatorHealthStatus = 0
      try {
        const response = await fetchFn(operatorHealthUrl, {
          signal: AbortSignal.timeout(10_000),
        })
        operatorHealthStatus = response.status
        if (response.status === 200) {
          operatorHealthOk = true
        }
      } catch (error) {
        // Connection/TLS error — treat as a failure (not a warning-only path like /api/healthz)
        throw new Error(
          `Same-origin operator health check failed: could not reach ${operatorHealthUrl}. ` +
            `Ensure the gateway deploy has completed (VPC port publish + DOCKER-USER + DO firewall) ` +
            `before deploying the dashboard /operator/* route. ` +
            `Original error: ${error instanceof Error ? error.message : String(error)}`,
        )
      }
      if (!operatorHealthOk) {
        throw new Error(
          `Same-origin operator health check failed: ${operatorHealthUrl} returned HTTP ${operatorHealthStatus} (expected 200). ` +
            `The /operator/* Caddy route is active but the gateway operator daemon is not healthy. ` +
            `Check the gateway operator service and ensure the VPC path is correctly configured.`,
        )
      }
      console.warn(`\u001B[1;32m✓\u001B[0m Same-origin operator health check passed: ${operatorHealthUrl} → 200`)
    }

    // Phase 12: Public HTTPS probe (warning-only — Caddy ACME cert may still be issuing)
    let probeOk = false
    for (let attempt = 1; attempt <= probeAttempts; attempt++) {
      try {
        const response = await fetchFn(`https://${host}${HEALTH_PATH}`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (response.ok) {
          probeOk = true
          break
        }
      } catch {
        // Transient failure — retry
      }

      if (attempt < probeAttempts) {
        await sleepFn(probeIntervalMs)
      }
    }

    if (probeOk) {
      console.warn(`\u001B[1;32m✓\u001B[0m Public HTTPS probe succeeded: https://${host}${HEALTH_PATH}`)
    } else {
      console.warn(
        `\u001B[1;33m[warn]\u001B[0m containers healthy; TLS cert still issuing — ` +
          `verify at https://${host}${HEALTH_PATH}`,
      )
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
  deploy().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
