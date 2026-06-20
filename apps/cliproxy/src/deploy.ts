#!/usr/bin/env bun

import {existsSync} from 'node:fs'
import {resolve} from 'node:path'

import {
  applyOAuthModelAlias,
  readBackOAuthModelAlias,
  readOAuthModelAliasFromConfig,
  setEqualOAuthModelAlias,
} from '@marcusrbrown/infra-shared/cliproxy/management'

const DEFAULT_REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/cliproxy'

interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  SSH_AUTH_SOCK: string
  CLIPROXY_DOMAIN: string
  CLIPROXY_MANAGEMENT_KEY: string
}

function resolveDeployFiles(): {compose: string; config: string; caddy: string} {
  const appRoot = resolve(import.meta.dir, '..')

  return {
    compose: resolve(appRoot, 'docker-compose.yaml'),
    config: resolve(appRoot, 'config/config.yaml'),
    caddy: resolve(appRoot, 'config/Caddyfile'),
  }
}

function getDeployEnv(): DeployEnv {
  const path = process.env.PATH
  const home = process.env.HOME
  const sshAuthSock = process.env.SSH_AUTH_SOCK
  const host = process.env.CLIPROXY_DOMAIN

  if (!path) {
    throw new Error('PATH is required for deploy')
  }

  if (!home) {
    throw new Error('HOME is required for deploy')
  }

  if (!sshAuthSock) {
    throw new Error('SSH_AUTH_SOCK is required for deploy. Start ssh-agent and load your key first.')
  }

  if (!host) {
    throw new Error('CLIPROXY_DOMAIN is required for deploy.')
  }

  return {
    PATH: path,
    HOME: home,
    SSH_AUTH_SOCK: sshAuthSock,
    CLIPROXY_DOMAIN: host,
    CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY ?? '',
  }
}

function validatePreconditions(): {compose: string; config: string; caddy: string} {
  const files = resolveDeployFiles()

  if (!existsSync(files.compose)) {
    throw new Error(`Missing deploy file: ${files.compose}`)
  }

  if (!existsSync(files.config)) {
    throw new Error(`Missing deploy file: ${files.config}`)
  }

  if (!existsSync(files.caddy)) {
    throw new Error(`Missing deploy file: ${files.caddy}`)
  }

  getDeployEnv()

  return files
}

async function runCommand(label: string, command: string[], env: DeployEnv): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = Bun.spawn(command, {
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

function sshCommand(host: string, command: string): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${DEFAULT_REMOTE_USER}@${host}`, command]
}

function scpCommand(host: string, source: string, destination: string): string[] {
  return [
    'scp',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    source,
    `${DEFAULT_REMOTE_USER}@${host}:${destination}`,
  ]
}

async function remoteFileExists(host: string, path: string, env: DeployEnv): Promise<boolean> {
  const proc = Bun.spawn(sshCommand(host, `test -f '${path}'`), {env, stdout: 'pipe', stderr: 'pipe'})
  const exitCode = await proc.exited
  return exitCode === 0
}

async function healthCheck(env: DeployEnv): Promise<void> {
  const host = env.CLIPROXY_DOMAIN
  const url = `https://${host}/v0/management/config`

  const headers = new Headers()
  if (env.CLIPROXY_MANAGEMENT_KEY) {
    headers.set('x-management-key', env.CLIPROXY_MANAGEMENT_KEY)
  }

  // healthCheck runs after compose-up (irreversible),
  // give slow startup 30s room while still bounding the wait.
  const response = await fetch(url, {headers, signal: AbortSignal.timeout(30_000)})

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Health check failed (${response.status} ${response.statusText}) at ${url}: ${body}`)
  }

  console.warn(`\u001B[1;32m✓\u001B[0m Health check passed: ${url}`)
}

export async function preflightManagementKeyCheck(env: DeployEnv, files: {config: string}): Promise<void> {
  const key = env.CLIPROXY_MANAGEMENT_KEY
  const host = env.CLIPROXY_DOMAIN

  if (!key) {
    // If the alias block is non-empty, fail early BEFORE compose-up rather
    // than wasting ~90s and failing mid-deploy in applyOAuthModelAliasStep.
    const desired = readOAuthModelAliasFromConfig(files.config)
    if (desired.claude.length > 0) {
      throw new Error(
        'oauth-model-alias block present in config.yaml but CLIPROXY_MANAGEMENT_KEY is not set — aliases cannot be applied. Set CLIPROXY_MANAGEMENT_KEY or remove the block.',
      )
    }
    console.warn('\u001B[1;33m⚠\u001B[0m  CLIPROXY_MANAGEMENT_KEY not set — skipping pre-deploy validation')
    return
  }

  const url = `https://${host}/v0/management/config`
  const headers = new Headers()
  headers.set('x-management-key', key)

  try {
    const response = await fetch(url, {headers, signal: AbortSignal.timeout(10_000)})

    if (response.ok) {
      console.warn('\u001B[1;32m✓\u001B[0m Pre-deploy validation passed: management key accepted')
      return
    }

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        "Management key is invalid. Verify CLIPROXY_MANAGEMENT_KEY matches MANAGEMENT_PASSWORD in the server's /opt/cliproxy/.env",
      )
    }

    throw new Error(`Proxy is unhealthy (HTTP ${response.status}). Resolve before deploying.`)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Management key')) {
      throw error
    }
    if (error instanceof Error && error.message.includes('Proxy is unhealthy')) {
      throw error
    }
    // Network errors (ECONNREFUSED, DNS failure, timeout) — server not yet running
    console.warn('\u001B[1;33m⚠\u001B[0m  Could not reach proxy — skipping pre-deploy validation (first deploy?)')
  }
}

/** Sleep helper — injectable in tests to avoid real delays. */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Apply the `oauth-model-alias` block from the tracked config to the live proxy
 * via the management API. Runs after `docker compose up -d --wait` (the management
 * API is reachable) and before `healthCheck`.
 *
 * - Empty alias block → skip (nothing to apply).
 * - Non-empty block + missing management key → hard-fail (operator intent is clear).
 * - PUT → read-back (with bounded retry for hot-reload race) → set-equality check → hard-fail on mismatch.
 * - Fork verification via /v1/models is best-effort: warns on mismatch, never throws.
 */
export async function applyOAuthModelAliasStep(
  env: DeployEnv,
  files: {config: string},
  fetchImpl: typeof globalThis.fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const desired = readOAuthModelAliasFromConfig(files.config)

  if (desired.claude.length === 0) {
    console.warn('\u001B[1;34m==>\u001B[0m Skipping oauth-model-alias (no entries in config)')
    return
  }

  const key = env.CLIPROXY_MANAGEMENT_KEY
  if (!key) {
    throw new Error(
      'oauth-model-alias block is present in config.yaml but CLIPROXY_MANAGEMENT_KEY is not set — cannot apply aliases. Set CLIPROXY_MANAGEMENT_KEY to proceed.',
    )
  }

  const baseUrl = `https://${env.CLIPROXY_DOMAIN}`

  console.warn(`\u001B[1;34m==>\u001B[0m Applying ${desired.claude.length} oauth-model-alias entries`)
  await applyOAuthModelAlias({baseUrl, key, body: desired, fetch: fetchImpl})

  // Bounded retry for hot-reload race — daemon may reload config async after PUT.
  // Retry up to 3 times on mismatch only; HTTP errors from readback propagate immediately.
  const MAX_ATTEMPTS = 3
  const BACKOFFS = [0, 500, 1000] // ms before each attempt (0 = immediate first try)
  let lastMismatchError: Error | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const backoff = BACKOFFS[attempt] ?? 0
    if (backoff > 0) {
      await sleepFn(backoff)
    }

    const actual = await readBackOAuthModelAlias({baseUrl, key, fetch: fetchImpl})
    if (setEqualOAuthModelAlias(desired, actual)) {
      lastMismatchError = null
      break
    }

    // Show full canonical key per entry (name + alias + fork) so mismatches
    // where only name or fork differs are visible, not just alias.
    const desiredLines = desired.claude.map(e => `    name=${e.name} alias=${e.alias} fork=${e.fork}`).join('\n')
    const actualLines = actual.claude.map(e => `    name=${e.name} alias=${e.alias} fork=${e.fork}`).join('\n')
    lastMismatchError = new Error(
      `oauth-model-alias read-back mismatch after PUT.\n` +
        `  desired (${desired.claude.length} entries):\n${desiredLines}\n` +
        `  actual  (${actual.claude.length} entries):\n${actualLines}`,
    )
  }

  if (lastMismatchError) {
    throw lastMismatchError
  }

  // Fork verification: best-effort only — requires a downstream api-key, not the management key.
  // The management read-back above already proves the aliases were stored.
  const apiKey = process.env.CLIPROXY_API_KEY
  if (apiKey) {
    try {
      const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
        headers: {Authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(10_000),
      })
      if (modelsResponse.ok) {
        const modelsPayload: unknown = await modelsResponse.json()
        const modelsData =
          modelsPayload !== null && typeof modelsPayload === 'object' && 'data' in modelsPayload
            ? (modelsPayload as {data: unknown}).data
            : undefined
        const modelIds: string[] = Array.isArray(modelsData)
          ? modelsData
              .map((m: unknown) =>
                m !== null && typeof m === 'object' && 'id' in m && typeof (m as {id: unknown}).id === 'string'
                  ? (m as {id: string}).id
                  : '',
              )
              .filter(Boolean)
          : []
        const missing = desired.claude.flatMap(e => {
          const absent: string[] = []
          if (!modelIds.includes(e.alias)) absent.push(e.alias)
          if (!modelIds.includes(e.name)) absent.push(e.name)
          return absent
        })
        if (missing.length > 0) {
          console.warn(
            `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models missing expected IDs: ${missing.join(', ')} (aliases stored; this may be a propagation delay)`,
          )
        }
      } else {
        console.warn(
          `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models returned HTTP ${modelsResponse.status} — skipping fork check (aliases stored)`,
        )
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(
        `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models probe failed (${msg}) — skipping (aliases stored)`,
      )
    }
  } else {
    console.warn(
      '\u001B[1;34m==>\u001B[0m Fork verification skipped (CLIPROXY_API_KEY not set; management read-back already proved aliases were stored)',
    )
  }

  console.warn(`\u001B[1;32m✓\u001B[0m Applied ${desired.claude.length} oauth-model-alias entries successfully`)
}

async function deploy(opts: {fetch?: typeof globalThis.fetch} = {}): Promise<void> {
  const files = validatePreconditions()
  const env = getDeployEnv()
  const host = env.CLIPROXY_DOMAIN
  const forceConfig = process.argv.includes('--force-config')
  const fetchImpl = opts.fetch ?? globalThis.fetch

  await runCommand('Creating remote directories', sshCommand(host, `mkdir -p ${REMOTE_DIR}/config`), env)

  // Validate management key before uploading files or restarting containers.
  // Also reads alias block and throws early if key missing + block non-empty.
  await preflightManagementKeyCheck(env, files)

  await runCommand(
    'Uploading docker-compose.yaml',
    scpCommand(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`),
    env,
  )
  await runCommand('Uploading config/Caddyfile', scpCommand(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`), env)

  // config.yaml contains runtime state (API keys, settings) managed via the management API.
  // Only upload on first deploy or when explicitly forced. Overwriting would wipe API keys.
  const configExists = await remoteFileExists(host, `${REMOTE_DIR}/config/config.yaml`, env)
  if (!configExists || forceConfig) {
    const label = forceConfig ? 'Uploading config/config.yaml (forced)' : 'Uploading config/config.yaml (first deploy)'
    await runCommand(label, scpCommand(host, files.config, `${REMOTE_DIR}/config/config.yaml`), env)
  } else {
    console.warn(
      '\u001B[1;34m==>\u001B[0m Skipping config/config.yaml (exists on server, use --force-config to overwrite)',
    )
  }

  await runCommand(
    'Updating Docker Compose stack',
    // --wait blocks until caddy reports healthy; caddy's healthcheck probes
    // http://cli-proxy-api:8317/healthz, so a healthy caddy transitively proves
    // the proxy is serving. --wait-timeout caps the block at 90s.
    sshCommand(host, `cd ${REMOTE_DIR} && docker compose pull && docker compose up -d --wait --wait-timeout 90`),
    env,
  )

  // Apply oauth-model-alias after the stack is healthy (management API reachable)
  // and before healthCheck so a failed alias apply fails the deploy.
  await applyOAuthModelAliasStep(env, files, fetchImpl)

  await healthCheck(env)
}

deploy().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
