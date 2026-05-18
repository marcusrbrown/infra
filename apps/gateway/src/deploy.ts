#!/usr/bin/env bun

import {readFileSync} from 'node:fs'
import {resolve} from 'node:path'

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
}

/** Minimal subset of Bun.Subprocess used by this script. */
export interface SpawnResult {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

/** Injectable spawn function — defaults to Bun.spawn. */
export type SpawnFn = (cmd: string[], opts: {env: DeployEnv; stdout: 'pipe'; stderr: 'pipe'}) => SpawnResult

export interface MainOpts {
  env?: Record<string, string>
  args?: string[]
  fetch?: typeof globalThis.fetch
  sleep?: (ms: number) => Promise<void>
  spawn?: SpawnFn
  maxAttempts?: number
  intervalMs?: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

const REMOTE_DIR = '/opt/gateway'
const DEPLOY_DIR = `${REMOTE_DIR}/deploy`
const SECRETS_DIR = `${DEPLOY_DIR}/secrets`
const CHECKSUM_PATH = `${DEPLOY_DIR}/.secrets-checksum`
const ENV_PATH = `${DEPLOY_DIR}/.env`
const DEFAULT_REMOTE_USER = 'root'

const REQUIRED_ENV_VARS = [
  'DISCORD_TOKEN',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'DISCORD_APPLICATION_ID',
  'DISCORD_GUILD_ID',
  'S3_BUCKET',
  'S3_REGION',
  'GATEWAY_HOST',
] as const

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Validates required environment variables are present.
 * Returns the list of missing variable names.
 * GATEWAY_SSH_KEY is required only when CI=true.
 */
export function validateRequiredEnv(env: Record<string, string>): string[] {
  const missing: string[] = []

  for (const key of REQUIRED_ENV_VARS) {
    if (!env[key]) {
      missing.push(key)
    }
  }

  if (env.CI === 'true' && !env.GATEWAY_SSH_KEY) {
    missing.push('GATEWAY_SSH_KEY')
  }

  return missing
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
    // Strip scheme and path from endpoint URL
    const url = new URL(env.S3_ENDPOINT)
    return `${bucket}.${url.hostname}`
  }

  const region = env.S3_REGION ?? ''
  return `${bucket}.s3.${region}.amazonaws.com`
}

/**
 * Builds the list of secret files to materialize on the droplet.
 * Required secrets get the actual value; optional secrets that are
 * unset get '' (empty placeholder).
 */
export function buildSecretFileList(env: Record<string, string>): SecretFile[] {
  const required: {name: string; envKey: string}[] = [
    {name: 'discord_token', envKey: 'DISCORD_TOKEN'},
    {name: 'aws_access_key_id', envKey: 'AWS_ACCESS_KEY_ID'},
    {name: 'aws_secret_access_key', envKey: 'AWS_SECRET_ACCESS_KEY'},
    {name: 'discord_application_id', envKey: 'DISCORD_APPLICATION_ID'},
    {name: 'discord_guild_id', envKey: 'DISCORD_GUILD_ID'},
  ]

  const optional: {name: string; envKey: string}[] = [
    {name: 'discord_operator_role_id', envKey: 'DISCORD_OPERATOR_ROLE_ID'},
  ]

  const secrets: SecretFile[] = []

  for (const {name, envKey} of required) {
    secrets.push({name, content: env[envKey] ?? '', required: true})
  }

  for (const {name, envKey} of optional) {
    secrets.push({name, content: env[envKey] ?? '', required: false})
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

/**
 * Polls the Discord API for slash command registration.
 * Returns { commands: string[] } on success; throws on timeout.
 * Token is passed via Authorization header only — never in URLs or errors.
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
  } = opts

  const url = `https://discord.com/api/v10/applications/${applicationId}/guilds/${guildId}/commands`

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = await fetchFn(url, {
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
    })

    if (!response.ok) {
      throw new Error(`Discord API returned HTTP ${response.status} for application=${applicationId} guild=${guildId}`)
    }

    const commands = (await response.json()) as {name: string}[]

    if (commands.length > 0) {
      return {commands: commands.map(c => c.name)}
    }

    if (attempt < maxAttempts) {
      await sleep(intervalMs)
    }
  }

  throw new Error(
    `Slash command registration timed out after ${maxAttempts} attempts for application=${applicationId} guild=${guildId}`,
  )
}

// ─── SSH helpers ──────────────────────────────────────────────────────────────

function sshCommand(host: string, command: string): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${DEFAULT_REMOTE_USER}@${host}`, command]
}

function buildDeployEnv(env: Record<string, string>): DeployEnv {
  return {
    PATH: env.PATH ?? '/usr/bin:/bin',
    HOME: env.HOME ?? '/root',
    GATEWAY_HOST: env.GATEWAY_HOST ?? '',
    ...(env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: env.SSH_AUTH_SOCK} : {}),
  }
}

function defaultSpawn(cmd: string[], opts: {env: DeployEnv; stdout: 'pipe'; stderr: 'pipe'}): SpawnResult {
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

async function remoteGitExists(host: string, deployEnv: DeployEnv, spawnFn: SpawnFn): Promise<boolean> {
  const proc = spawnFn(sshCommand(host, `test -d '${REMOTE_DIR}/.git'`), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  return exitCode === 0
}

async function readRemoteChecksum(host: string, deployEnv: DeployEnv, spawnFn: SpawnFn): Promise<string> {
  const proc = spawnFn(sshCommand(host, `cat '${CHECKSUM_PATH}' 2>/dev/null || echo ''`), {
    env: deployEnv,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  await proc.exited
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

  const isDryRun = args.includes('--dry-run')
  const forceRecreate = args.includes('--force-recreate')

  // Phase 1: Validate env
  // SSH_AUTH_SOCK check in local mode (not CI)
  if (env.CI !== 'true' && !env.SSH_AUTH_SOCK) {
    throw new Error('SSH_AUTH_SOCK is required in local mode. Start ssh-agent and load your key first.')
  }

  const missing = validateRequiredEnv(env)
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`)
  }

  // Phase 2: Resolve upstream pin
  const {repo, ref} = resolveUpstreamPin()

  if (isDryRun) {
    console.warn('\u001B[1;33m[dry-run]\u001B[0m Planned actions:')
    console.warn(`  1. Ensure droplet workspace at ${REMOTE_DIR} (clone ${repo}@${ref} or fetch+reset)`)
    console.warn(`  2. Compute OBJECT_STORE_HOSTS: ${computeObjectStoreHosts(env)}`)
    console.warn(`  3. Materialize ${buildSecretFileList(env).length} secret files under ${SECRETS_DIR}`)
    console.warn(`  4. Write .env to ${ENV_PATH}`)
    console.warn(`  5. Run init-certs.sh (idempotent)`)
    console.warn(`  6. docker compose up -d --wait --wait-timeout 120${forceRecreate ? ' --force-recreate' : ''}`)
    console.warn(
      `  7. Poll Discord slash command registration (app=${env.DISCORD_APPLICATION_ID} guild=${env.DISCORD_GUILD_ID})`,
    )
    console.warn('\u001B[1;33m[dry-run]\u001B[0m No remote side effects performed.')
    return
  }

  const host = env.GATEWAY_HOST!
  const deployEnv = buildDeployEnv(env)

  // Phase 3: Ensure droplet workspace
  await runCommand(
    'Creating remote workspace directory',
    sshCommand(host, `mkdir -p ${REMOTE_DIR}`),
    deployEnv,
    spawnFn,
  )

  const gitExists = await remoteGitExists(host, deployEnv, spawnFn)

  if (gitExists) {
    await runCommand(
      `Fetching latest from ${repo}`,
      sshCommand(host, `cd ${REMOTE_DIR} && git fetch --tags`),
      deployEnv,
      spawnFn,
    )
    await runCommand(
      `Resetting to ${ref}`,
      sshCommand(host, `cd ${REMOTE_DIR} && git reset --hard ${ref}`),
      deployEnv,
      spawnFn,
    )
    await runCommand(
      'Cleaning untracked files',
      sshCommand(host, `cd ${REMOTE_DIR} && git clean -xfd`),
      deployEnv,
      spawnFn,
    )
  } else {
    await runCommand(
      `Cloning ${repo} at ${ref}`,
      sshCommand(host, `git clone --depth 1 --branch ${ref} https://github.com/${repo}.git ${REMOTE_DIR}`),
      deployEnv,
      spawnFn,
    )
  }

  // Phase 4: Compute OBJECT_STORE_HOSTS
  const objectStoreHosts = computeObjectStoreHosts(env)

  // Phase 5: Materialize secrets
  const secrets = buildSecretFileList(env)
  await runCommand('Creating secrets directory', sshCommand(host, `mkdir -p ${SECRETS_DIR}`), deployEnv, spawnFn)

  for (const secret of secrets) {
    await runCommand(
      `Writing secret: ${secret.name}`,
      sshCommand(host, `umask 077; cat > ${SECRETS_DIR}/${secret.name} << 'SECRETEOF'\n${secret.content}\nSECRETEOF`),
      deployEnv,
      spawnFn,
    )
  }

  // Compute current checksum
  const currentChecksum = computeSecretsChecksum(secrets)

  // Read prior checksum BEFORE overwriting, to detect rotation
  const priorChecksum = await readRemoteChecksum(host, deployEnv, spawnFn)
  const checksumChanged = priorChecksum !== currentChecksum

  // Persist new checksum
  await runCommand(
    'Persisting secrets checksum',
    sshCommand(host, `echo ${currentChecksum} > ${CHECKSUM_PATH}`),
    deployEnv,
    spawnFn,
  )

  // Phase 6: Materialize .env
  await runCommand(
    'Writing .env',
    sshCommand(host, `echo 'OBJECT_STORE_HOSTS=${objectStoreHosts}' > ${ENV_PATH}`),
    deployEnv,
    spawnFn,
  )

  // Phase 7: Run init-certs.sh (idempotent)
  await runCommand(
    'Running init-certs.sh',
    sshCommand(host, `cd ${DEPLOY_DIR} && bash init-certs.sh`),
    deployEnv,
    spawnFn,
  )

  // Phase 8: docker compose up
  const composeArgs = [
    'docker',
    'compose',
    '--project-directory',
    DEPLOY_DIR,
    'up',
    '-d',
    '--wait',
    '--wait-timeout',
    '120',
  ]
  if (forceRecreate || checksumChanged) {
    composeArgs.push('--force-recreate')
  }

  await runCommand('Starting Docker Compose stack', sshCommand(host, composeArgs.join(' ')), deployEnv, spawnFn)

  // Phase 9: Post-deploy probe — poll Discord slash command registration
  const applicationId = env.DISCORD_APPLICATION_ID!
  const guildId = env.DISCORD_GUILD_ID!
  const token = env.DISCORD_TOKEN!

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

  console.warn(`\u001B[1;32m✓\u001B[0m Registered commands: ${commands.join(', ')}`)

  // Phase 10: Auth-tier warning
  const nonPingCommands = commands.filter(c => c !== 'ping')
  if (nonPingCommands.length > 0 && !env.DISCORD_OPERATOR_ROLE_ID) {
    console.warn(
      `\u001B[1;33m⚠\u001B[0m  Non-ping commands registered (${nonPingCommands.join(', ')}) but DISCORD_OPERATOR_ROLE_ID is not set. ` +
        'Operator-tier authorization is not enforced. Set DISCORD_OPERATOR_ROLE_ID when upstream ships role-gating.',
    )
  }

  console.warn('\u001B[1;32m✓\u001B[0m Deploy complete.')
}

// ─── Entry point ─────────────────────────────────────────────────────────────

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
