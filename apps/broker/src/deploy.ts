#!/usr/bin/env bun

/**
 * Broker deploy script.
 *
 * Deploys the broker stack to the broker droplet. Follows the same pattern as
 * apps/cliproxy/src/deploy.ts with these broker-specific additions:
 *
 * - Preflight: durable management key present + cliproxy management API reachable
 *   + api-keys readable — all checked BEFORE any compose change.
 * - Single SSH ControlPath threaded through all SSH/SCP calls.
 * - Secrets materialized via SSH stdin (never argv).
 * - Post-deploy GET /healthz probe.
 *
 * Broker→cliproxy reachability: the broker runs on its OWN separate DigitalOcean
 * droplet (not co-located with cliproxy). Therefore the broker reaches cliproxy
 * over the PUBLIC internet via cliproxy.fro.bot — NOT via an internal docker
 * network. The hairpin concern (DO droplets don't NAT-loopback) only applies to
 * same-host container-to-container calls; it does not apply here because the
 * broker and cliproxy are on separate droplets. The broker container calls
 * https://cliproxy.fro.bot directly.
 */

import {existsSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {validateBrokerHost} from './host'

const DEFAULT_REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/broker'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  SSH_AUTH_SOCK: string
  BROKER_HOST: string
  CLIPROXY_MANAGEMENT_URL: string
  CLIPROXY_MANAGEMENT_KEY: string
}

// ---------------------------------------------------------------------------
// Injectable deps seam (for tests)
// ---------------------------------------------------------------------------

/**
 * Minimal fetch signature. Using a structural type rather than
 * `typeof globalThis.fetch` avoids requiring the `preconnect` property
 * that Bun adds to the global fetch.
 */
export type FetchFn = (url: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface DeployDeps {
  /** fetch implementation — defaults to globalThis.fetch. */
  fetch?: FetchFn
  /** Bun.spawn implementation — defaults to Bun.spawn. */
  spawn?: typeof Bun.spawn
}

// ---------------------------------------------------------------------------
// Env resolution
// ---------------------------------------------------------------------------

export function getDeployEnv(): DeployEnv {
  const path = process.env.PATH
  const home = process.env.HOME
  const sshAuthSock = process.env.SSH_AUTH_SOCK
  const brokerHost = process.env.BROKER_HOST

  if (!path) throw new Error('PATH is required for deploy')
  if (!home) throw new Error('HOME is required for deploy')
  if (!sshAuthSock) throw new Error('SSH_AUTH_SOCK is required for deploy. Start ssh-agent and load your key first.')
  if (!brokerHost) throw new Error('BROKER_HOST is required for deploy.')

  return {
    PATH: path,
    HOME: home,
    SSH_AUTH_SOCK: sshAuthSock,
    BROKER_HOST: brokerHost,
    CLIPROXY_MANAGEMENT_URL: process.env.CLIPROXY_MANAGEMENT_URL ?? 'https://cliproxy.fro.bot',
    CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY ?? '',
  }
}

// ---------------------------------------------------------------------------
// File resolution
// ---------------------------------------------------------------------------

function resolveDeployFiles(): {compose: string; caddy: string} {
  const appRoot = resolve(import.meta.dir, '..')

  return {
    compose: resolve(appRoot, 'docker-compose.yaml'),
    caddy: resolve(appRoot, 'config/Caddyfile'),
  }
}

function validatePreconditions(): {compose: string; caddy: string} {
  const files = resolveDeployFiles()

  if (!existsSync(files.compose)) {
    throw new Error(`Missing deploy file: ${files.compose}`)
  }

  if (!existsSync(files.caddy)) {
    throw new Error(`Missing deploy file: ${files.caddy}`)
  }

  getDeployEnv()

  return files
}

// ---------------------------------------------------------------------------
// SSH/SCP command builders (with ControlPath threading)
// ---------------------------------------------------------------------------

/**
 * Builds an SSH command array with a shared ControlPath socket.
 * The ControlPath allows connection multiplexing — all SSH calls in a deploy
 * share a single authenticated connection, avoiding repeated auth and
 * reducing the risk of hitting UFW's rate limit (6 connections/30s).
 */
export function sshCommand(host: string, command: string, controlPath: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    `ControlPath=${controlPath}`,
    '-o',
    'ControlMaster=auto',
    '-o',
    'ControlPersist=60',
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}

export function scpCommand(host: string, source: string, destination: string, controlPath: string): string[] {
  return [
    'scp',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    `ControlPath=${controlPath}`,
    source,
    `${DEFAULT_REMOTE_USER}@${host}:${destination}`,
  ]
}

// ---------------------------------------------------------------------------
// ControlPath management
// ---------------------------------------------------------------------------

/**
 * Generates a unique ControlPath socket path under /tmp.
 * The path is unique per deploy invocation to avoid stale socket conflicts.
 */
export function makeControlPath(host: string): string {
  const ts = Date.now()
  return join(tmpdir(), `broker-deploy-${host}-${ts}.sock`)
}

// ---------------------------------------------------------------------------
// Command runner
// ---------------------------------------------------------------------------

async function runCommand(label: string, command: string[], env: DeployEnv, deps: DeployDeps = {}): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const spawnFn = deps.spawn ?? Bun.spawn
  const proc = spawnFn(command, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

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
}

// ---------------------------------------------------------------------------
// Preflight checks
// ---------------------------------------------------------------------------

/**
 * Preflight: verify the cliproxy management key is present and the cliproxy
 * management API is reachable and can list api-keys.
 *
 * Aborts BEFORE any compose change if:
 *   - CLIPROXY_MANAGEMENT_KEY is not set
 *   - cliproxy management API is unreachable or returns 401/403
 *   - api-keys list is not readable
 *
 * This is the fail-closed preflight: no compose change happens until we know
 * the management API is healthy and the keys are present.
 */
export async function preflightChecks(env: DeployEnv, deps: DeployDeps = {}): Promise<void> {
  const fetchFn: FetchFn = deps.fetch ?? globalThis.fetch

  if (!env.CLIPROXY_MANAGEMENT_KEY) {
    throw new Error('CLIPROXY_MANAGEMENT_KEY is not set — cannot verify cliproxy reachability before deploy.')
  }

  const apiKeysUrl = `${env.CLIPROXY_MANAGEMENT_URL}/v0/management/api-keys`

  try {
    const response = await fetchFn(apiKeysUrl, {
      method: 'GET',
      headers: {'x-management-key': env.CLIPROXY_MANAGEMENT_KEY},
      signal: AbortSignal.timeout(10_000),
    })

    if (response.status === 401 || response.status === 403) {
      throw new Error('CLIPROXY_MANAGEMENT_KEY is invalid — verify it matches the cliproxy server config.')
    }

    if (!response.ok) {
      throw new Error(`cliproxy management API returned HTTP ${response.status} — resolve before deploying.`)
    }

    console.warn(
      '\u001B[1;32m✓\u001B[0m Pre-deploy validation passed: cliproxy management API reachable and api-keys readable',
    )
  } catch (error: unknown) {
    if (
      error instanceof Error &&
      (error.message.includes('CLIPROXY_MANAGEMENT_KEY is invalid') ||
        error.message.includes('cliproxy management API returned HTTP'))
    ) {
      throw error
    }
    // Network errors (ECONNREFUSED, DNS failure, timeout) — server not yet running
    throw new Error(
      `cliproxy management API is unreachable at ${env.CLIPROXY_MANAGEMENT_URL} — resolve before deploying. (${error instanceof Error ? error.message : String(error)})`,
    )
  }
}

// ---------------------------------------------------------------------------
// Post-deploy health check
// ---------------------------------------------------------------------------

/**
 * Post-deploy health check: GET /healthz on the broker.
 * Runs after compose-up (irreversible), gives slow startup 30s room.
 */
export async function healthCheck(env: DeployEnv, deps: DeployDeps = {}): Promise<void> {
  const fetchFn: FetchFn = deps.fetch ?? globalThis.fetch
  const host = env.BROKER_HOST
  const url = `https://${host}/healthz`

  const response = await fetchFn(url, {signal: AbortSignal.timeout(30_000)})

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Health check failed (${response.status} ${response.statusText}) at ${url}: ${body}`)
  }

  console.warn(`\u001B[1;32m✓\u001B[0m Health check passed: ${url}`)
}

// ---------------------------------------------------------------------------
// Secret materialization via stdin
// ---------------------------------------------------------------------------

/**
 * Writes the broker .env file to the remote host via SSH stdin.
 * Secret bytes travel via stdin only — NEVER in argv.
 */
export async function writeRemoteEnvFile(
  host: string,
  env: DeployEnv,
  controlPath: string,
  deps: DeployDeps = {},
): Promise<void> {
  const envFile = `${[
    `BROKER_HOST=${env.BROKER_HOST}`,
    `CLIPROXY_MANAGEMENT_URL=${env.CLIPROXY_MANAGEMENT_URL}`,
    `CLIPROXY_MANAGEMENT_KEY=${env.CLIPROXY_MANAGEMENT_KEY}`,
  ].join('\n')}\n`

  const spawnFn = deps.spawn ?? Bun.spawn
  const proc = spawnFn(sshCommand(host, `cat > ${REMOTE_DIR}/.env`, controlPath), {
    stdin: 'pipe',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  proc.stdin.write(envFile)
  proc.stdin.end()

  const exitCode = await proc.exited
  if (exitCode !== 0) {
    throw new Error(`Writing remote .env file failed (exit ${exitCode})`)
  }

  console.warn('\u001B[1;34m==>\u001B[0m Writing remote .env file')
}

// ---------------------------------------------------------------------------
// Main deploy orchestration
// ---------------------------------------------------------------------------

export async function deploy(deps: DeployDeps = {}): Promise<void> {
  const files = validatePreconditions()
  const env = getDeployEnv()
  const host = env.BROKER_HOST

  // Validate host before any SSH argv construction.
  validateBrokerHost(host)

  // Generate a single ControlPath for all SSH/SCP calls in this deploy.
  const controlPath = makeControlPath(host)

  // Preflight: verify management keys and cliproxy reachability BEFORE any compose change.
  await preflightChecks(env, deps)

  // Create remote directories.
  await runCommand(
    'Creating remote directories',
    sshCommand(host, `mkdir -p ${REMOTE_DIR}/config`, controlPath),
    env,
    deps,
  )

  // Upload compose and Caddyfile.
  await runCommand(
    'Uploading docker-compose.yaml',
    scpCommand(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`, controlPath),
    env,
    deps,
  )
  await runCommand(
    'Uploading config/Caddyfile',
    scpCommand(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`, controlPath),
    env,
    deps,
  )

  // Materialize secrets via stdin (never argv).
  await writeRemoteEnvFile(host, env, controlPath, deps)

  // Pull and start the stack.
  await runCommand(
    'Updating Docker Compose stack',
    sshCommand(
      host,
      `cd ${REMOTE_DIR} && docker compose pull && docker compose up -d --wait --wait-timeout 90`,
      controlPath,
    ),
    env,
    deps,
  )

  // Post-deploy health check.
  await healthCheck(env, deps)
}

if (import.meta.main) {
  deploy().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
