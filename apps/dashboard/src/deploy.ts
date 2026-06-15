#!/usr/bin/env bun

import {chmodSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
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
const DASHBOARD_IMAGE_NAME = 'ghcr.io/marcusrbrown/infra-dashboard'
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
  DASHBOARD_IMAGE_DIGEST: string
  SSH_AUTH_SOCK?: string
  DASHBOARD_SSH_KEY?: string
}

// ─── Exported helpers ─────────────────────────────────────────────────────────

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

/**
 * Validates all required environment variables are present and well-formed.
 * Calls validateDashboardHost on DASHBOARD_DOMAIN before any SSH argv is constructed.
 * Fails closed if DASHBOARD_IMAGE_DIGEST is missing.
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

  // Fail closed: DASHBOARD_IMAGE_DIGEST is required — no fallback to on-droplet build
  const imageDigest = env.DASHBOARD_IMAGE_DIGEST
  if (!imageDigest) {
    throw new Error(
      'DASHBOARD_IMAGE_DIGEST is required but not set. ' +
        'This value is supplied by the CI build-images job. ' +
        'For a local deploy, build and push the image to GHCR first, then set DASHBOARD_IMAGE_DIGEST.',
    )
  }

  // Validate digest format: must be sha256:<64 hex chars>
  // Mirrors apps/gateway/src/deploy.ts DIGEST_RE validation.
  const DIGEST_RE = /^sha256:[0-9a-f]{64}$/
  if (!DIGEST_RE.test(imageDigest)) {
    throw new Error(
      `DASHBOARD_IMAGE_DIGEST has an invalid format: "${imageDigest}". ` +
        'Expected sha256:<64 hex chars> (e.g. sha256:abc...def). ' +
        'This value is supplied by the CI build-images job.',
    )
  }

  // Validate host before any SSH argv construction
  validateDashboardHost(domain)

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
    DASHBOARD_IMAGE_DIGEST: imageDigest,
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
    ...(env.DASHBOARD_SSH_KEY ? {DASHBOARD_SSH_KEY: env.DASHBOARD_SSH_KEY} : {}),
  }
}

/**
 * Builds the contents of the remote .env file.
 * Secrets travel via SSH stdin — this function only assembles the string.
 *
 * NOTE: The GitHub App private key is NOT included here. It is uploaded as a
 * separate file (0600) via SSH stdin. The .env references the file path only.
 *
 * NOTE: Image pinning is NOT done here. The digest-pinned image reference is
 * written to docker-compose.override.yaml via buildComposeOverride, which Docker
 * Compose auto-merges when running from REMOTE_DIR. This ensures the actual
 * container uses the digest-pinned image, not the mutable tag in docker-compose.yaml.
 */
export function buildEnvFileContents(opts: {
  domain: string
  githubAppId: string
  oauthClientId: string
  oauthClientSecret: string
  operatorLogin: string
  cookieKey: string
}): string {
  const {domain, githubAppId, oauthClientId, oauthClientSecret, operatorLogin, cookieKey} = opts
  return (
    `DASHBOARD_DOMAIN=${domain}\n` +
    `DASHBOARD_GITHUB_APP_ID=${githubAppId}\n` +
    `DASHBOARD_GITHUB_APP_KEY_FILE=/run/secrets/github-app.pem\n` +
    `DASHBOARD_OAUTH_CLIENT_ID=${oauthClientId}\n` +
    `DASHBOARD_OAUTH_CLIENT_SECRET=${oauthClientSecret}\n` +
    `DASHBOARD_OPERATOR_LOGIN=${operatorLogin}\n` +
    `DASHBOARD_COOKIE_KEY=${cookieKey}\n`
  )
}

/**
 * Builds the docker-compose.override.yaml content that pins the dashboard image
 * to the CI-pushed digest.
 *
 * Docker Compose auto-merges docker-compose.override.yaml when running from the
 * project directory (REMOTE_DIR). This override replaces the mutable tag in
 * docker-compose.yaml with the immutable digest reference, ensuring the droplet
 * always runs the exact image verified by CI.
 *
 * @param opts - Options object
 * @param opts.imageDigest - The sha256 digest (e.g. "sha256:abc...")
 */
export function buildComposeOverride(opts: {imageDigest: string}): string {
  const {imageDigest} = opts
  return `services:\n  dashboard:\n    image: ${DASHBOARD_IMAGE_NAME}@${imageDigest}\n`
}

/**
 * Asserts that the running container's RepoDigests include the expected digest.
 *
 * Pure helper — no SSH, no side effects. Throws with an actionable message when
 * the running image does not match the CI-pushed digest.
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
      `Running ${serviceName} image digest does not match the expected CI-pushed digest.\n` +
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
 * 1. Validate env (throws before any SSH on failure) — fails closed on missing DASHBOARD_IMAGE_DIGEST
 * 2. Validate host (SSH argv injection defense)
 * 3. DNS preflight
 * 4. ControlMaster SSH multiplexing setup (dual-tmpdir: key under os.tmpdir(), socket under /tmp)
 * 5. Remote prep: mkdir -p /opt/dashboard/config
 * 6. Materialize /opt/dashboard/.env via SSH stdin (includes DASHBOARD_GITHUB_APP_KEY_FILE path)
 * 7. Write docker-compose.override.yaml via SSH stdin (pins image to digest)
 * 8. scp docker-compose.yaml + config/Caddyfile
 * 9. Upload GitHub App private key via SSH stdin to /opt/dashboard/config/github-app.pem (0600)
 *    SECURITY: PEM bytes flow through stdin ONLY — never in argv, never in a local temp file
 * 10. chown 1000:1000 github-app.pem so the container's node user (UID 1000) can read it
 * 11. docker compose pull (pulls digest-pinned GHCR image via override)
 * 12. docker compose up -d --no-build --wait dashboard (app health gate first)
 * 13. Verify RepoDigests: assert running image includes DASHBOARD_IMAGE_DIGEST (fail closed)
 * 14. docker compose up -d --no-build --wait caddy (public exposure after app healthy)
 * 15. Probe https://$DASHBOARD_DOMAIN/api/healthz — bounded retry; warning-only on ACME lag
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
  // DASHBOARD_IMAGE_DIGEST missing → throws here (fail closed)
  const validated = validateEnv(env)

  const host = validated.DASHBOARD_DOMAIN
  const imageDigest = validated.DASHBOARD_IMAGE_DIGEST

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

    // Phase 3: Remote prep
    await runCommand(
      'Creating remote directories',
      sshCommand(host, `mkdir -p ${REMOTE_CONFIG_DIR}`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 4: Materialize /opt/dashboard/.env via SSH stdin
    // The .env includes DASHBOARD_GITHUB_APP_KEY_FILE (file path) — NOT the PEM content.
    // Image pinning is handled by the compose override (Phase 4b), not the .env.
    const envContents = buildEnvFileContents({
      domain: host,
      githubAppId: validated.DASHBOARD_GITHUB_APP_ID,
      oauthClientId: validated.DASHBOARD_OAUTH_CLIENT_ID,
      oauthClientSecret: validated.DASHBOARD_OAUTH_CLIENT_SECRET,
      operatorLogin: validated.DASHBOARD_OPERATOR_LOGIN,
      cookieKey: validated.DASHBOARD_COOKIE_KEY,
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

    // Phase 4b: Write docker-compose.override.yaml (digest pin)
    // Docker Compose auto-merges docker-compose.override.yaml when running from REMOTE_DIR.
    // This override replaces the mutable tag in docker-compose.yaml with the immutable
    // digest reference, ensuring the droplet always runs the exact CI-pushed image.
    const overrideContent = buildComposeOverride({imageDigest})
    await writeRemoteFile(
      `Writing ${REMOTE_DIR}/docker-compose.override.yaml`,
      host,
      `${REMOTE_DIR}/docker-compose.override.yaml`,
      overrideContent,
      deployEnv,
      spawnFn,
      keyPath,
      controlPath,
    )

    // Phase 5: scp docker-compose.yaml and Caddyfile
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

    // Phase 6: Upload GitHub App private key via SSH stdin (SECURITY-CRITICAL)
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

    // Phase 7: docker compose pull (pulls digest-pinned GHCR image via override)
    await runCommand(
      'Pulling Docker images',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose pull`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8: Start dashboard only (Caddy NOT started — no public exposure yet).
    // --no-build enforces digest-pinned image; never builds from source on the droplet.
    await runCommand(
      'Starting dashboard (internal only)',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait dashboard`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 9: Verify RepoDigests — fail closed if running image doesn't match expected digest.
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

    // Phase 10: Start Caddy — now safe to expose publicly (app is healthy + digest verified).
    await runCommand(
      'Starting Caddy (public exposure)',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose up -d --no-build --wait caddy`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 11: Public HTTPS probe (warning-only — Caddy ACME cert may still be issuing)
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
