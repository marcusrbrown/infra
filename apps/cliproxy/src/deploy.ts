#!/usr/bin/env bun

import {existsSync} from 'node:fs'
import {resolve} from 'node:path'

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
  console.log(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = Bun.spawn(command, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (stdout.trim()) {
    console.log(stdout.trim())
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

  const response = await fetch(url, {headers})

  if (!response.ok) {
    const body = await response.text()
    throw new Error(`Health check failed (${response.status} ${response.statusText}) at ${url}: ${body}`)
  }

  console.log(`\u001B[1;32m✓\u001B[0m Health check passed: ${url}`)
}

async function preflightManagementKeyCheck(env: DeployEnv): Promise<void> {
  const key = env.CLIPROXY_MANAGEMENT_KEY
  const host = env.CLIPROXY_DOMAIN

  if (!key) {
    console.warn('\u001B[1;33m⚠\u001B[0m  CLIPROXY_MANAGEMENT_KEY not set — skipping pre-deploy validation')
    return
  }

  const url = `https://${host}/v0/management/config`
  const headers = new Headers()
  headers.set('x-management-key', key)

  try {
    const response = await fetch(url, {headers, signal: AbortSignal.timeout(10_000)})

    if (response.ok) {
      console.log('\u001B[1;32m✓\u001B[0m Pre-deploy validation passed: management key accepted')
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

async function deploy(): Promise<void> {
  const files = validatePreconditions()
  const env = getDeployEnv()
  const host = env.CLIPROXY_DOMAIN
  const forceConfig = process.argv.includes('--force-config')

  await runCommand('Creating remote directories', sshCommand(host, `mkdir -p ${REMOTE_DIR}/config`), env)

  // Validate management key before uploading files or restarting containers
  await preflightManagementKeyCheck(env)

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
    console.log(
      '\u001B[1;34m==>\u001B[0m Skipping config/config.yaml (exists on server, use --force-config to overwrite)',
    )
  }

  await runCommand(
    'Updating Docker Compose stack',
    // --wait blocks until cli-proxy-api reports healthy per its Docker healthcheck
    // (start_period: 10s, retries: 3). --wait-timeout caps the block at 90s.
    // The healthCheck() below is the app-level verification layer on top.
    sshCommand(host, `cd ${REMOTE_DIR} && docker compose pull && docker compose up -d --wait --wait-timeout 90`),
    env,
  )

  await healthCheck(env)
}

deploy().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
