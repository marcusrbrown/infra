#!/usr/bin/env bun

import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {validateUmamiHost} from './host'

// ─── Umami API endpoint constants ─────────────────────────────────────────────
// TODO: verify exact v3.2.0 endpoint against running image on first deploy
const UMAMI_LOGIN_PATH = '/api/auth/login'
const UMAMI_PASSWORD_PATH = '/api/me/password'

// ─── Remote paths ─────────────────────────────────────────────────────────────

const REMOTE_DIR = '/opt/umami'
const REMOTE_ENV_PATH = `${REMOTE_DIR}/.env`
const REMOTE_COMPOSE_PATH = `${REMOTE_DIR}/docker-compose.yaml`
const REMOTE_CONFIG_DIR = `${REMOTE_DIR}/config`
const REMOTE_CADDYFILE_PATH = `${REMOTE_CONFIG_DIR}/Caddyfile`
const REMOTE_FINGERPRINT_PATH = `${REMOTE_DIR}/.db-password-fingerprint`
const REMOTE_RETENTION_DIR = `${REMOTE_DIR}/retention`
const REMOTE_RETENTION_RELEASES_DIR = `${REMOTE_RETENTION_DIR}/releases`
const REMOTE_RETENTION_STAGING_DIR = `${REMOTE_RETENTION_DIR}/staging`
const REMOTE_RETENTION_SYSTEMD_STAGING_DIR = `${REMOTE_RETENTION_DIR}/systemd-staging`
const REMOTE_RETENTION_CURRENT_PATH = `${REMOTE_RETENTION_DIR}/current`
const REMOTE_RETENTION_SERVICE_PATH = '/etc/systemd/system/umami-retention.service'
const REMOTE_RETENTION_TIMER_PATH = '/etc/systemd/system/umami-retention.timer'
const DEFAULT_REMOTE_USER = 'root'

// ─── Fingerprint salt ─────────────────────────────────────────────────────────
// A fixed salt so the fingerprint is deterministic across deploys but not a
// raw hash of the password (adds a tiny bit of preimage resistance).
const FINGERPRINT_SALT = 'umami-db-pw-v1'

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
  UMAMI_DOMAIN: string
}

export interface DeployOpts {
  env?: Record<string, string>
  spawn?: SpawnFn
  /** Injectable parent root for the deploy workspace; defaults to os.tmpdir(). */
  tempRoot?: string
  /** Injectable DNS resolver — throws if host doesn't resolve. */
  resolve?: (host: string) => Promise<void>
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  sleep?: (ms: number) => Promise<void>
  /** Number of public HTTPS probe attempts (default: 6). */
  probeAttempts?: number
  /** Interval between probe attempts in ms (default: 10_000). */
  probeIntervalMs?: number
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

/** Validated, typed environment required for deploy. */
export interface ValidatedEnv {
  PATH: string
  HOME: string
  UMAMI_DOMAIN: string
  UMAMI_APP_SECRET: string
  UMAMI_DB_PASSWORD: string
  UMAMI_ADMIN_PASSWORD: string
  SSH_AUTH_SOCK?: string
  UMAMI_SSH_KEY?: string
}

/**
 * Validates all required environment variables are present and well-formed.
 * Calls validateUmamiHost on UMAMI_DOMAIN before any SSH argv is constructed.
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

  // SSH context: local mode needs SSH_AUTH_SOCK; CI mode needs UMAMI_SSH_KEY
  if (!env.SSH_AUTH_SOCK && !env.UMAMI_SSH_KEY) {
    throw new Error('SSH context is required: set SSH_AUTH_SOCK (local mode) or UMAMI_SSH_KEY (CI mode)')
  }

  const domain = env.UMAMI_DOMAIN
  if (!domain) {
    throw new Error('UMAMI_DOMAIN is required for deploy')
  }

  const appSecret = env.UMAMI_APP_SECRET
  if (!appSecret) {
    throw new Error('UMAMI_APP_SECRET is required for deploy')
  }

  const dbPassword = env.UMAMI_DB_PASSWORD
  if (!dbPassword) {
    throw new Error('UMAMI_DB_PASSWORD is required for deploy')
  }

  const adminPassword = env.UMAMI_ADMIN_PASSWORD
  if (!adminPassword) {
    throw new Error('UMAMI_ADMIN_PASSWORD is required for deploy')
  }

  if (adminPassword.length < 8) {
    throw new Error(
      'UMAMI_ADMIN_PASSWORD must be at least 8 characters — Umami v3.1.0 rejects shorter passwords on the password-change endpoint',
    )
  }

  // Validate host before any SSH argv construction
  validateUmamiHost(domain)

  return {
    PATH: path,
    HOME: home,
    UMAMI_DOMAIN: domain,
    UMAMI_APP_SECRET: appSecret,
    UMAMI_DB_PASSWORD: dbPassword,
    UMAMI_ADMIN_PASSWORD: adminPassword,
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
    ...(env.UMAMI_SSH_KEY ? {UMAMI_SSH_KEY: env.UMAMI_SSH_KEY} : {}),
  }
}

/**
 * Builds the contents of the remote .env file.
 * Secrets travel via SSH stdin — this function only assembles the string.
 *
 * G4: The DB password is percent-encoded in DATABASE_URL (URL-reserved chars
 * like @ : / # % would corrupt the connection string if left raw).
 * POSTGRES_PASSWORD stays raw — Postgres reads it literally from env.
 */
export function buildEnvFileContents(opts: {appSecret: string; dbPassword: string; domain: string}): string {
  const encodedDbPassword = encodeURIComponent(opts.dbPassword)
  return (
    `APP_SECRET=${opts.appSecret}\n` +
    `POSTGRES_PASSWORD=${opts.dbPassword}\n` +
    `DATABASE_URL=postgresql://umami:${encodedDbPassword}@db:5432/umami\n` +
    `UMAMI_DOMAIN=${opts.domain}\n`
  )
}

/**
 * Computes a salted SHA-256 fingerprint of the DB password.
 * The fingerprint is written to the remote sentinel file — never the password itself.
 */
export function computeDbPasswordFingerprint(password: string): string {
  const hasher = new Bun.CryptoHasher('sha256')
  hasher.update(`${FINGERPRINT_SALT}:${password}`)
  return hasher.digest('hex')
}

export interface RetentionRuntimeArtifacts {
  retentionScript: Uint8Array
  retentionCheckSql: Uint8Array
  retentionApplySql: Uint8Array
  retentionServiceUnit: Uint8Array
  retentionTimerUnit: Uint8Array
}

/** Computes the content address for one complete five-file retention deployment set. */
export function computeRetentionReleaseHash(artifacts: RetentionRuntimeArtifacts): string {
  const hasher = new Bun.CryptoHasher('sha256')

  for (const [name, contents] of [
    ['retention.sh', artifacts.retentionScript],
    ['retention-check.sql', artifacts.retentionCheckSql],
    ['retention.sql', artifacts.retentionApplySql],
    ['umami-retention.service', artifacts.retentionServiceUnit],
    ['umami-retention.timer', artifacts.retentionTimerUnit],
  ] as const) {
    hasher.update(`${name}\0`)
    hasher.update(contents)
    hasher.update('\0')
  }

  return hasher.digest('hex')
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
    UMAMI_DOMAIN: env.UMAMI_DOMAIN ?? '',
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

async function runCommandStatus(
  label: string,
  command: string[],
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
): Promise<{stdout: string; stderr: string; exitCode: number}> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = spawnFn(command, {env: deployEnv, stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }

  return {stdout, stderr, exitCode}
}

/**
 * Writes content to a remote path via SSH stdin pipe.
 * Content is NEVER placed in the shell command argv — it flows through stdin only.
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
 * Reads the remote DB-password fingerprint sentinel.
 *
 * G3: Distinguishes three states:
 *   - Sentinel absent (file-not-found, exit 1 with "No such file") → returns '' (first deploy)
 *   - Sentinel present (exit 0) → returns its hash
 *   - SSH/read failure (exit non-zero for a reason other than missing file) → throws
 *
 * Runs `cat <path>` WITHOUT `|| echo ''` so the exit code is meaningful.
 */
async function readRemoteFingerprint(
  host: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<string> {
  const proc = spawnFn(sshCommand(host, `cat '${REMOTE_FINGERPRINT_PATH}'`, keyPath, controlPath), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (exitCode === 0) {
    return stdout.trim()
  }

  // Distinguish file-not-found (first deploy) from SSH/permission failures.
  // "No such file" covers both Linux and macOS cat error messages.
  const combinedOutput = (stdout + stderr).toLowerCase()
  if (combinedOutput.includes('no such file')) {
    // Sentinel absent — legitimate first deploy
    return ''
  }

  // Any other non-zero exit is a transport or permission failure — fail closed.
  throw new Error(
    `Failed to read fingerprint sentinel from remote (exit ${exitCode}). ` +
      'This may indicate an SSH transport failure or permission error. ' +
      'Resolve the SSH connectivity issue before deploying.',
  )
}

/**
 * Attempts to rotate the Umami admin password from the default 'umami' to
 * UMAMI_ADMIN_PASSWORD. Idempotent: if the default login is cleanly rejected
 * (HTTP 401/403 → curl exit 22), the password is already rotated — skip.
 *
 * G1 — fails CLOSED:
 *   - Connection/transport failure (curl exit 7, or docker exec failure) → THROW.
 *     We cannot determine cred state; deploy must fail.
 *   - HTTP auth rejection (curl exit 22 with auth body) → skip (already rotated).
 *   - Login succeeds (exit 0 + token) → proceed to update + verify.
 *
 * G2 — called BEFORE Caddy starts (no public default-credential window).
 *
 * G5 — bearer token travels via stdin (curl config file), never argv.
 *
 * Exec reachability: curls run inside the umami container via
 * `docker compose exec -T umami curl ...` so port 3000 is reachable on the
 * internal compose network. The -T flag disables TTY so stdin piping works.
 */
async function rotateAdminPassword(
  host: string,
  adminPassword: string,
  deployEnv: DeployEnv,
  spawnFn: SpawnFn,
  keyPath?: string,
  controlPath?: string,
): Promise<void> {
  console.warn('\u001B[1;34m==>\u001B[0m Attempting admin password rotation (idempotent)')

  // Step 1: Try default login with --fail-with-body so HTTP >=400 → non-zero exit.
  // Body travels via stdin; curl runs inside the umami container.
  const loginBody = JSON.stringify({username: 'admin', password: 'umami'})
  const loginCmd = sshCommand(
    host,
    `cd ${REMOTE_DIR} && docker compose exec -T umami curl -s --fail-with-body -X POST -H 'Content-Type: application/json' --data @- http://localhost:3000${UMAMI_LOGIN_PATH}`,
    keyPath,
    controlPath,
  )
  const loginProc = spawnFn(loginCmd, {env: deployEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})

  if (!loginProc.stdin) {
    throw new Error('Spawn did not provide stdin pipe for admin login')
  }

  loginProc.stdin.write(new TextEncoder().encode(loginBody))
  loginProc.stdin.end()

  const loginStdout = await new Response(loginProc.stdout).text()
  const loginExit = await loginProc.exited

  // Exit 22 = HTTP error (--fail-with-body) → clean auth rejection → already rotated.
  // Exit 0 = HTTP 200 → check for token.
  // Any other non-zero (7 = connection refused, 255 = ssh failure, etc.) → throw.
  if (loginExit !== 0 && loginExit !== 22) {
    throw new Error(
      `Cannot reach umami to verify/rotate admin credentials (exit ${loginExit}). ` +
        'Ensure the umami container is healthy before deploying.',
    )
  }

  if (loginExit === 22) {
    // Clean HTTP auth rejection — password already rotated.
    console.warn('\u001B[1;33m[info]\u001B[0m Default admin login rejected — password already rotated, skipping.')
    return
  }

  // Exit 0 — parse token from response.
  let token: string | null = null
  try {
    const parsed = JSON.parse(loginStdout) as {token?: string | null}
    token = parsed.token ?? null
  } catch {
    token = null
  }

  if (!token) {
    // Exit 0 but no token — treat as already rotated (unexpected but safe to skip).
    console.warn(
      '\u001B[1;33m[info]\u001B[0m Default admin login returned no token — password already rotated, skipping.',
    )
    return
  }

  // Step 2: Write a curl config file inside the container via stdin so the
  // bearer token never appears in argv (G5). The config file is written to
  // /tmp/uc inside the umami container, used for the update curl, then removed.
  const curlConfigContent = `header = "Authorization: Bearer ${token}"\n`
  const writeCurlConfigCmd = sshCommand(
    host,
    `cd ${REMOTE_DIR} && docker compose exec -T umami sh -c 'umask 077; cat > /tmp/uc'`,
    keyPath,
    controlPath,
  )
  const writeCurlConfigProc = spawnFn(writeCurlConfigCmd, {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'pipe',
  })

  if (!writeCurlConfigProc.stdin) {
    throw new Error('Spawn did not provide stdin pipe for curl config write')
  }

  writeCurlConfigProc.stdin.write(new TextEncoder().encode(curlConfigContent))
  writeCurlConfigProc.stdin.end()

  await new Response(writeCurlConfigProc.stdout).text()
  const writeCurlConfigExit = await writeCurlConfigProc.exited

  if (writeCurlConfigExit !== 0) {
    throw new Error('Failed to write curl config file inside umami container for password update')
  }

  // Step 3: Update password. New password travels via stdin; token via curl config file.
  // Cleanup of /tmp/uc happens in the same sh -c regardless of curl exit code.
  const updateBody = JSON.stringify({currentPassword: 'umami', newPassword: adminPassword})
  const updateCmd = sshCommand(
    host,
    `cd ${REMOTE_DIR} && docker compose exec -T umami sh -c 'curl -s --fail-with-body -X POST -H '"'"'Content-Type: application/json'"'"' -K /tmp/uc --data @- http://localhost:3000${UMAMI_PASSWORD_PATH}; rc=$?; rm -f /tmp/uc; exit $rc'`,
    keyPath,
    controlPath,
  )
  const updateProc = spawnFn(updateCmd, {env: deployEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})

  if (!updateProc.stdin) {
    throw new Error('Spawn did not provide stdin pipe for password update')
  }

  updateProc.stdin.write(new TextEncoder().encode(updateBody))
  updateProc.stdin.end()

  await new Response(updateProc.stdout).text()
  const updateExit = await updateProc.exited

  if (updateExit !== 0) {
    throw new Error(`Admin password update failed (exit ${updateExit}). Deploy aborted.`)
  }

  // Step 4: Verify — re-login with the NEW password must succeed.
  const verifyNewBody = JSON.stringify({username: 'admin', password: adminPassword})
  const verifyNewCmd = sshCommand(
    host,
    `cd ${REMOTE_DIR} && docker compose exec -T umami curl -s --fail-with-body -X POST -H 'Content-Type: application/json' --data @- http://localhost:3000${UMAMI_LOGIN_PATH}`,
    keyPath,
    controlPath,
  )
  const verifyNewProc = spawnFn(verifyNewCmd, {env: deployEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})

  if (!verifyNewProc.stdin) {
    throw new Error('Spawn did not provide stdin pipe for rotation verification (new password)')
  }

  verifyNewProc.stdin.write(new TextEncoder().encode(verifyNewBody))
  verifyNewProc.stdin.end()

  const verifyNewStdout = await new Response(verifyNewProc.stdout).text()
  const verifyNewExit = await verifyNewProc.exited

  if (verifyNewExit !== 0) {
    throw new Error(
      'Admin password rotation verification failed: new password login was rejected. ' +
        'The password may not have been updated correctly. Investigate manually.',
    )
  }

  let verifyNewToken: string | null = null
  try {
    const parsed = JSON.parse(verifyNewStdout) as {token?: string | null}
    verifyNewToken = parsed.token ?? null
  } catch {
    verifyNewToken = null
  }

  if (!verifyNewToken) {
    throw new Error(
      'Admin password rotation verification failed: new password login returned no token. ' + 'Investigate manually.',
    )
  }

  // Step 5: Verify — re-login with the DEFAULT password must now FAIL (exit 22).
  const verifyDefaultBody = JSON.stringify({username: 'admin', password: 'umami'})
  const verifyDefaultCmd = sshCommand(
    host,
    `cd ${REMOTE_DIR} && docker compose exec -T umami curl -s --fail-with-body -X POST -H 'Content-Type: application/json' --data @- http://localhost:3000${UMAMI_LOGIN_PATH}`,
    keyPath,
    controlPath,
  )
  const verifyDefaultProc = spawnFn(verifyDefaultCmd, {env: deployEnv, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})

  if (!verifyDefaultProc.stdin) {
    throw new Error('Spawn did not provide stdin pipe for rotation verification (default password)')
  }

  verifyDefaultProc.stdin.write(new TextEncoder().encode(verifyDefaultBody))
  verifyDefaultProc.stdin.end()

  await new Response(verifyDefaultProc.stdout).text()
  const verifyDefaultExit = await verifyDefaultProc.exited

  if (verifyDefaultExit === 0) {
    // Default password still works — rotation did not stick.
    throw new Error(
      'Admin password rotation verification failed: default password still accepted after rotation. ' +
        'The password update may not have persisted. Investigate manually.',
    )
  }

  console.warn('\u001B[1;32m✓\u001B[0m Admin password rotated and verified successfully.')
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
 * Deploys the Umami analytics stack to the remote droplet.
 *
 * Order of operations:
 * 1. Validate env (throws before any SSH on failure)
 * 2. DNS preflight
 * 3. ControlMaster SSH multiplexing setup
 * 4. Remote prep: mkdir -p /opt/umami/config
 * 5. DB-password fingerprint guard (G3: fails on SSH error, not just mismatch)
 * 6. Materialize /opt/umami/.env via SSH stdin
 * 7. scp docker-compose.yaml + Caddyfile
 * 8. docker compose pull (all images)
 * 9. docker compose up -d --wait db umami (internal only — Caddy NOT started yet)
 * 10. Admin password rotation (G1: fail-closed; G2: before Caddy; G5: token via stdin)
 * 11. docker compose up -d --wait caddy (now expose publicly)
 * 12. Write DB-password fingerprint sentinel (hash only, never password)
 * 13. Upload and validate retention artifacts and systemd units; daemon-reload;
 *     restart an active timer or start an already-enabled inactive timer
 * 14. Public HTTPS probe (warning-only on failure — Caddy ACME cert may still be issuing)
 */
export async function deploy(opts: DeployOpts = {}): Promise<void> {
  const env = opts.env ?? (process.env as Record<string, string>)
  const spawnFn = opts.spawn ?? defaultSpawn
  const resolveFn = opts.resolve ?? defaultResolve
  const fetchFn = opts.fetch ?? globalThis.fetch
  const sleepFn = opts.sleep ?? ((ms: number) => new Promise(r => setTimeout(r, ms)))
  const probeAttempts = opts.probeAttempts ?? 6
  const probeIntervalMs = opts.probeIntervalMs ?? 10_000

  // Phase 1: Validate env — throws before any SSH on failure
  const validated = validateEnv(env)

  // After validateEnv passes, these are guaranteed non-empty strings
  const host = validated.UMAMI_DOMAIN
  const appSecret = validated.UMAMI_APP_SECRET
  const dbPassword = validated.UMAMI_DB_PASSWORD
  const adminPassword = validated.UMAMI_ADMIN_PASSWORD

  // Boundary-validate all secret values before any SSH
  validateSecretValue(appSecret, 'UMAMI_APP_SECRET')
  validateSecretValue(dbPassword, 'UMAMI_DB_PASSWORD')
  validateSecretValue(adminPassword, 'UMAMI_ADMIN_PASSWORD')

  // Phase 2: DNS preflight
  try {
    await resolveFn(host)
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    throw new Error(`DNS preflight failed for ${host}: ${msg}`)
  }

  const deployEnv = buildDeployEnv(env)

  // CI mode: write UMAMI_SSH_KEY to a tmp file with mode 0o600.
  // Local mode: keyPath stays undefined; SSH_AUTH_SOCK is forwarded via deployEnv.
  let keyPath: string | undefined
  let tmpDir: string | undefined

  try {
    // Always create a tmpdir — used for ControlPath socket in both CI and local mode.
    tmpDir = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'umami-deploy-'))

    if (env.UMAMI_SSH_KEY) {
      keyPath = join(tmpDir, 'id')
      const keyContent = env.UMAMI_SSH_KEY.endsWith('\n') ? env.UMAMI_SSH_KEY : `${env.UMAMI_SSH_KEY}\n`
      writeFileSync(keyPath, keyContent, {mode: 0o600})
      // Defensive chmod in case umask narrowed the initial mode
      chmodSync(keyPath, 0o600)
    }

    // ControlPath socket lives inside tmpDir
    const controlPath = join(tmpDir, 'cm-%r@%h:%p')

    // Phase 3: Remote prep
    await runCommand(
      'Creating remote directories',
      sshCommand(host, `mkdir -p ${REMOTE_CONFIG_DIR}`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 4: DB-password fingerprint guard (G3: SSH errors throw, not bypass)
    const currentFingerprint = computeDbPasswordFingerprint(dbPassword)
    const existingFingerprint = await readRemoteFingerprint(host, deployEnv, spawnFn, keyPath, controlPath)

    if (existingFingerprint && existingFingerprint !== currentFingerprint) {
      throw new Error(
        'DB password fingerprint mismatch: the UMAMI_DB_PASSWORD does not match the fingerprint stored on the ' +
          'droplet. Changing the Postgres password requires manual rotation — see the ALTER USER rotation runbook ' +
          'in apps/umami/AGENTS.md. Deploy aborted.',
      )
    }

    // Phase 5: Materialize /opt/umami/.env via SSH stdin
    const envContents = buildEnvFileContents({appSecret, dbPassword, domain: host})
    await writeRemoteFile(
      'Writing /opt/umami/.env',
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

    // Phase 7: docker compose pull (all images)
    await runCommand(
      'Pulling Docker images',
      sshCommand(host, `cd ${REMOTE_DIR} && docker compose pull`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Phase 8: Start db + umami only (Caddy NOT started — no public exposure yet).
    // G2: Caddy is withheld until after admin rotation so there is no window
    // where the default admin credentials are reachable from the public internet.
    await runCommand(
      'Starting db and umami (internal only)',
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker compose up -d --wait --wait-timeout 180 db umami`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    // Phase 9: Admin password rotation (G1: fail-closed; G2: before Caddy; G5: token via stdin)
    // Rotation curls run inside the umami container via `docker compose exec -T umami`
    // so port 3000 is reachable on the internal compose network.
    await rotateAdminPassword(host, adminPassword, deployEnv, spawnFn, keyPath, controlPath)

    // Phase 10: Start Caddy — now safe to expose publicly (rotation complete).
    await runCommand(
      'Starting Caddy (public exposure)',
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker compose up -d --wait --wait-timeout 180 caddy`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    // Phase 11: Write fingerprint sentinel AFTER db+umami healthy
    await writeRemoteFile(
      'Writing DB password fingerprint sentinel',
      host,
      REMOTE_FINGERPRINT_PATH,
      currentFingerprint,
      deployEnv,
      spawnFn,
      keyPath,
      controlPath,
    )

    // Phase 12: upload and validate a content-addressed retention release and
    // stage systemd units away from their live paths.
    const localRetentionScript = join(import.meta.dir, '..', 'retention.sh')
    const localRetentionCheckSql = join(import.meta.dir, '..', 'retention-check.sql')
    const localRetentionApplySql = join(import.meta.dir, '..', 'retention.sql')
    const localRetentionService = join(import.meta.dir, '..', 'systemd', 'umami-retention.service')
    const localRetentionTimer = join(import.meta.dir, '..', 'systemd', 'umami-retention.timer')

    const retentionReleaseHash = computeRetentionReleaseHash({
      retentionScript: readFileSync(localRetentionScript),
      retentionCheckSql: readFileSync(localRetentionCheckSql),
      retentionApplySql: readFileSync(localRetentionApplySql),
      retentionServiceUnit: readFileSync(localRetentionService),
      retentionTimerUnit: readFileSync(localRetentionTimer),
    })
    const remoteRetentionStagingReleasePath = `${REMOTE_RETENTION_STAGING_DIR}/${retentionReleaseHash}`
    const remoteRetentionReleasePath = `${REMOTE_RETENTION_RELEASES_DIR}/${retentionReleaseHash}`
    const remoteRetentionSystemdStagingReleasePath = `${REMOTE_RETENTION_SYSTEMD_STAGING_DIR}/${retentionReleaseHash}`
    const remoteRetentionCurrentCandidatePath = `${REMOTE_RETENTION_CURRENT_PATH}.next-${retentionReleaseHash}`
    const remoteRetentionCurrentRollbackPath = `${REMOTE_RETENTION_CURRENT_PATH}.rollback-${retentionReleaseHash}`
    const remoteRetentionServiceStagingPath = `${remoteRetentionSystemdStagingReleasePath}/umami-retention.service`
    const remoteRetentionTimerStagingPath = `${remoteRetentionSystemdStagingReleasePath}/umami-retention.timer`
    const remoteRetentionServiceInstallTempPath = `${REMOTE_RETENTION_SERVICE_PATH}.tmp-${retentionReleaseHash}`
    const remoteRetentionTimerInstallTempPath = `${REMOTE_RETENTION_TIMER_PATH}.tmp-${retentionReleaseHash}`

    await runCommand(
      'Preparing retention release and unit staging directories',
      sshCommand(
        host,
        `mkdir -p '${remoteRetentionStagingReleasePath}' '${REMOTE_RETENTION_RELEASES_DIR}' '${remoteRetentionSystemdStagingReleasePath}'`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Copying retention runner',
      scpCommand(localRetentionScript, host, `${remoteRetentionStagingReleasePath}/retention.sh`, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Copying retention check SQL',
      scpCommand(
        localRetentionCheckSql,
        host,
        `${remoteRetentionStagingReleasePath}/retention-check.sql`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Copying retention apply SQL',
      scpCommand(
        localRetentionApplySql,
        host,
        `${remoteRetentionStagingReleasePath}/retention.sql`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Copying retention service unit',
      scpCommand(localRetentionService, host, remoteRetentionServiceStagingPath, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Copying retention timer unit',
      scpCommand(localRetentionTimer, host, remoteRetentionTimerStagingPath, keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    // Staged payloads and units are root-owned with explicit modes before any
    // validation. The live current link and /etc/systemd files remain untouched
    // while uploads and static runtime validation are in progress.
    await runCommand(
      'Setting retention artifact ownership and permissions',
      sshCommand(
        host,
        [
          `chown root:root '${remoteRetentionStagingReleasePath}' '${remoteRetentionStagingReleasePath}/retention.sh' '${remoteRetentionStagingReleasePath}/retention-check.sql' '${remoteRetentionStagingReleasePath}/retention.sql' '${remoteRetentionServiceStagingPath}' '${remoteRetentionTimerStagingPath}'`,
          `chmod 0755 '${remoteRetentionStagingReleasePath}' '${remoteRetentionStagingReleasePath}/retention.sh'`,
          `chmod 0644 '${remoteRetentionStagingReleasePath}/retention-check.sql' '${remoteRetentionStagingReleasePath}/retention.sql' '${remoteRetentionServiceStagingPath}' '${remoteRetentionTimerStagingPath}'`,
        ].join(' && '),
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Validating retention runner and artifact modes',
      sshCommand(
        host,
        [
          `bash -n '${remoteRetentionStagingReleasePath}/retention.sh'`,
          `test "$(stat -c '%a' '${remoteRetentionStagingReleasePath}/retention.sh')" = 755`,
          `test "$(stat -c '%a' '${remoteRetentionStagingReleasePath}/retention-check.sql')" = 644`,
          `test "$(stat -c '%a' '${remoteRetentionStagingReleasePath}/retention.sql')" = 644`,
          `test "$(stat -c '%a' '${remoteRetentionServiceStagingPath}')" = 644`,
          `test "$(stat -c '%a' '${remoteRetentionTimerStagingPath}')" = 644`,
        ].join(' && '),
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Atomically promoting retention release and verifying staged units',
      sshCommand(
        host,
        [
          'set -Eeuo pipefail',
          `staging='${remoteRetentionStagingReleasePath}'`,
          `release='${remoteRetentionReleasePath}'`,
          `current='${REMOTE_RETENTION_CURRENT_PATH}'`,
          `candidate='${remoteRetentionCurrentCandidatePath}'`,
          `rollback='${remoteRetentionCurrentRollbackPath}'`,
          'previous_target=""',
          String.raw`if [[ -L "$current" ]]; then previous_target="$(readlink "$current")"; elif [[ -e "$current" ]]; then printf 'error: retention current path is not a symlink: %s\n' "$current" >&2; exit 1; fi`,
          'restore_current() { if [[ -n "$previous_target" ]]; then rm -f "$rollback"; ln -s "$previous_target" "$rollback"; mv -Tf "$rollback" "$current"; else rm -f "$current"; fi; }',
          'rollback_on_error() { rc=$?; trap - EXIT; if ((rc != 0)); then restore_current; fi; exit "$rc"; }',
          'trap rollback_on_error EXIT',
          'if [[ "$previous_target" != "$release" ]]; then',
          '  if [[ -e "$release" || -L "$release" ]]; then',
          String.raw`    if [[ ! -d "$release" ]]; then printf 'error: retention release path is not a directory: %s\n' "$release" >&2; exit 1; fi`,
          '    rm -rf "$staging"',
          '  else',
          '    mv -T "$staging" "$release"',
          '  fi',
          '  rm -f "$candidate"',
          '  ln -s "$release" "$candidate"',
          '  mv -Tf "$candidate" "$current"',
          'else',
          '  rm -rf "$staging"',
          'fi',
          `timeout 60s systemd-analyze verify '${remoteRetentionServiceStagingPath}' '${remoteRetentionTimerStagingPath}'`,
          'trap - EXIT',
        ].join('\n'),
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Installing retention service unit atomically',
      sshCommand(
        host,
        `install -o root -g root -m 0644 '${remoteRetentionServiceStagingPath}' '${remoteRetentionServiceInstallTempPath}' && mv -Tf '${remoteRetentionServiceInstallTempPath}' '${REMOTE_RETENTION_SERVICE_PATH}'`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    // After verification, an install failure intentionally leaves the complete
    // new runtime current: both unit versions reference stable current, and daemon-reload has not occurred.
    await runCommand(
      'Installing retention timer unit atomically',
      sshCommand(
        host,
        `install -o root -g root -m 0644 '${remoteRetentionTimerStagingPath}' '${remoteRetentionTimerInstallTempPath}' && mv -Tf '${remoteRetentionTimerInstallTempPath}' '${REMOTE_RETENTION_TIMER_PATH}'`,
        keyPath,
        controlPath,
      ),
      deployEnv,
      spawnFn,
    )

    await runCommand(
      'Reloading systemd manager for retention units',
      sshCommand(host, 'timeout 60s systemctl daemon-reload', keyPath, controlPath),
      deployEnv,
      spawnFn,
    )

    const activeTimerStatus = await runCommandStatus(
      'Checking retention timer activity',
      sshCommand(host, 'timeout 60s systemctl is-active umami-retention.timer', keyPath, controlPath),
      deployEnv,
      spawnFn,
    )
    const activeTimerState = activeTimerStatus.stdout.trim()

    if (activeTimerStatus.exitCode === 0 && activeTimerState === 'active') {
      await runCommand(
        'Restarting active retention timer',
        sshCommand(host, 'timeout 60s systemctl restart umami-retention.timer', keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
    } else {
      const inactiveState =
        activeTimerStatus.exitCode === 3 && ['inactive', 'failed', 'dead'].includes(activeTimerState)
      if (!inactiveState) {
        const detail = activeTimerStatus.stderr.trim()
        throw new Error(
          `Failed to determine retention timer activity (exit ${activeTimerStatus.exitCode}, state ${activeTimerState || 'unknown'}).${detail ? ` ${detail}` : ''}`,
        )
      }

      const enabledTimerStatus = await runCommandStatus(
        'Checking retention timer enablement',
        sshCommand(host, 'timeout 60s systemctl is-enabled umami-retention.timer', keyPath, controlPath),
        deployEnv,
        spawnFn,
      )
      const enabledTimerState = enabledTimerStatus.stdout.trim()

      if (enabledTimerStatus.exitCode === 0 && ['enabled', 'enabled-runtime'].includes(enabledTimerState)) {
        await runCommand(
          'Starting enabled retention timer',
          sshCommand(host, 'timeout 60s systemctl start umami-retention.timer', keyPath, controlPath),
          deployEnv,
          spawnFn,
        )
      } else if (enabledTimerStatus.exitCode === 1 && ['disabled', 'static', 'indirect'].includes(enabledTimerState)) {
        console.warn('\u001B[1;33m[info]\u001B[0m Retention timer is disabled; leaving first-install state unchanged.')
      } else {
        const detail = enabledTimerStatus.stderr.trim()
        throw new Error(
          `Failed to determine retention timer enablement (exit ${enabledTimerStatus.exitCode}, state ${enabledTimerState || 'unknown'}).${detail ? ` ${detail}` : ''}`,
        )
      }
    }

    // Phase 13: Public HTTPS probe (warning-only — Caddy ACME cert may still be issuing)
    let probeOk = false
    for (let attempt = 1; attempt <= probeAttempts; attempt++) {
      try {
        const response = await fetchFn(`https://${host}/api/heartbeat`, {
          signal: AbortSignal.timeout(10_000),
        })
        if (response.ok) {
          const body = (await response.json()) as {ok?: boolean}
          if (body.ok === true) {
            probeOk = true
            break
          }
        }
      } catch {
        // Transient failure — retry
      }

      if (attempt < probeAttempts) {
        await sleepFn(probeIntervalMs)
      }
    }

    if (probeOk) {
      console.warn(`\u001B[1;32m✓\u001B[0m Public HTTPS probe succeeded: https://${host}/api/heartbeat`)
    } else {
      console.warn(
        `\u001B[1;33m[warn]\u001B[0m containers healthy; TLS cert still issuing — ` +
          `verify at https://${host}/api/heartbeat`,
      )
    }

    console.warn('\u001B[1;32m✓\u001B[0m Deploy complete.')
  } finally {
    // Clean up the tmp dir regardless of success or failure
    if (tmpDir) {
      rmSync(tmpDir, {recursive: true, force: true})
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
