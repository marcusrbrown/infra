#!/usr/bin/env bun

import {appendFileSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

const DROPLET_NAME = 'gateway'
const DROPLET_IMAGE = 'docker-24-04'
const DROPLET_SIZE = 's-1vcpu-2gb'
const DROPLET_REGION = 'nyc1'
const REMOTE_USER = process.env.REMOTE_USER ?? 'root'

export interface ProvisionArgs {
  force: boolean
  checkExists: boolean
}

export interface DropletExistenceState {
  name: string
  exists: boolean
}

// ---------------------------------------------------------------------------
// Pure-logic helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Checks that doctl is available on PATH. Throws with install instructions if not.
 */
export function validateDoctl(): void {
  if (!Bun.which('doctl')) {
    throw new Error(
      'doctl is required. Install it first: https://docs.digitalocean.com/reference/doctl/how-to/install/',
    )
  }
}

/**
 * Validates that all required environment variables are present.
 * Returns the list of missing variable names (empty = all present).
 */
export function validateRequiredEnv(env: Partial<Record<string, string>>): string[] {
  const required = ['DIGITALOCEAN_ACCESS_TOKEN', 'GATEWAY_HOST']
  return required.filter(key => !env[key])
}

/**
 * Checks whether a droplet with the given name exists in the DigitalOcean account.
 * Runs `doctl compute droplet list` via Bun.spawn.
 */
export async function dropletExists(name: string): Promise<boolean> {
  const proc = Bun.spawn(['doctl', 'compute', 'droplet', 'list', '--format', 'Name', '--no-header'], {
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`Failed to list droplets`)
  }
  const names = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
  return names.includes(name)
}

/**
 * Non-mutating state probe for agents/CI. This intentionally only lists
 * droplets; it does not validate provision-only environment, create anything,
 * pin host keys, or wait for SSH.
 */
export async function checkDropletExistence(name = DROPLET_NAME): Promise<DropletExistenceState> {
  return {name, exists: await dropletExists(name)}
}

/**
 * Parses provisioning arguments. Unknown flags are rejected so automated callers
 * don't accidentally get a default mutating run after a typo.
 */
export function parseProvisionArgs(args: string[]): ProvisionArgs {
  const known = new Set(['--force', '--check-exists'])
  const unknown = args.filter(arg => !known.has(arg))

  if (unknown.length > 0) {
    throw new Error(`Unknown provision argument(s): ${unknown.join(', ')}. Supported: --force, --check-exists`)
  }

  return {
    force: args.includes('--force'),
    checkExists: args.includes('--check-exists'),
  }
}

/**
 * Appends domain (unhashed) and IP (hashed) host key entries to the given known_hosts file.
 * Idempotent: if entries for this host are already present, skips the append.
 */
export async function pinHostKeys(domain: string, ip: string, knownHostsPath: string): Promise<void> {
  const existing = readFileSync(knownHostsPath, 'utf-8')
  const marker = `# gateway droplet (${ip} / ${domain})`

  if (existing.includes(marker)) {
    console.log(`\u001B[1;34m==>\u001B[0m Host keys already pinned for ${ip}`)
    return
  }

  const domainKeys = await runCapture(['ssh-keyscan', domain])
  const ipKeys = await runCapture(['ssh-keyscan', '-H', ip])

  const newBlock = `\n${marker}\n${domainKeys}\n${ipKeys}\n`
  appendFileSync(knownHostsPath, newBlock)
  console.log(`\u001B[1;32m✓\u001B[0m Pinned host keys for ${ip} / ${domain} in .github/known_hosts`)
  console.log('  Commit the updated .github/known_hosts before running CI deploy.')
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function runCapture(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr.trim() || `Command failed: ${command.join(' ')}`)
  }
  return stdout.trim()
}

async function run(label: string, command: string[]): Promise<void> {
  console.log(`\u001B[1;34m==>\u001B[0m ${label}`)
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (stdout.trim()) console.log(stdout.trim())
  if (code !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) console.error(stderr.trim())
    process.exit(1)
  }
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

function ssh(host: string, command: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    `${REMOTE_USER}@${host}`,
    command,
  ]
}

export async function getSshFingerprint(keyName?: string): Promise<string> {
  const name = keyName ?? process.env.GATEWAY_SSH_KEY_NAME ?? 'fro-bot-gateway'
  const raw = await runCapture(['doctl', 'compute', 'ssh-key', 'list', '--format', 'Name,FingerPrint', '--no-header'])

  // Each row: "<Name padded with spaces>  <FingerPrint>"
  // The Name column can contain spaces, @, and dots, so we treat the last
  // whitespace-delimited token as the fingerprint and everything before it as the name.
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const lastSpace = trimmed.lastIndexOf(' ')
    if (lastSpace === -1) continue
    const rowName = trimmed.slice(0, lastSpace).trim()
    const fingerprint = trimmed.slice(lastSpace + 1).trim()
    if (rowName === name) {
      return fingerprint
    }
  }

  throw new Error(
    `SSH key named "${name}" not found in DigitalOcean account. ` +
      `Run \`doctl compute ssh-key list\` to see available keys, ` +
      `or set GATEWAY_SSH_KEY_NAME to override the default ("fro-bot-gateway").`,
  )
}

async function getDropletIpWithWait(): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const ip = await runCapture([
      'doctl',
      'compute',
      'droplet',
      'get',
      DROPLET_NAME,
      '--format',
      'PublicIPv4',
      '--no-header',
    ])
    if (ip) {
      return ip
    }
    await sleep(5_000)
  }

  throw new Error('Timed out waiting for droplet IPv4 address')
}

async function waitForSsh(host: string): Promise<void> {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const proc = Bun.spawn(ssh(host, 'echo ready'), {stdout: 'pipe', stderr: 'pipe'})
    const code = await proc.exited
    if (code === 0) {
      return
    }
    await sleep(5_000)
  }

  throw new Error('Timed out waiting for SSH connectivity to droplet')
}

function printOperatorSetupMessage(dropletIp: string, gatewayHost: string): void {
  console.log('\n\u001B[1;32m✓\u001B[0m Gateway droplet provisioned\n')
  console.log(`Droplet IP: ${dropletIp}`)
  console.log(
    `\nBefore triggering a CI deploy, set the following in the \u001B[1mgateway\u001B[0m GitHub Environment:\n`,
  )
  console.log('  Required secrets:')
  console.log('    GATEWAY_SSH_KEY          — private key for SSH access to the droplet')
  console.log('    DISCORD_TOKEN            — Discord bot token')
  console.log('    AWS_ACCESS_KEY_ID        — S3-compatible storage access key')
  console.log('    AWS_SECRET_ACCESS_KEY    — S3-compatible storage secret key')
  console.log('    DISCORD_APPLICATION_ID   — Discord application ID')
  console.log('    DISCORD_GUILD_ID         — Discord guild (server) ID')
  console.log('    S3_BUCKET                — S3 bucket name')
  console.log('    S3_REGION                — S3 region')
  console.log('\n  Optional secrets/variables:')
  console.log('    S3_ENDPOINT              — S3-compatible endpoint URL (omit for AWS)')
  console.log('    OBJECT_STORE_HOSTS       — explicit allowlist for object store hosts')
  console.log('\n  Required variables:')
  console.log(`    GATEWAY_HOST             — ${gatewayHost}`)
  console.log('\nCommit the updated .github/known_hosts before triggering a CI deploy.')
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const {force, checkExists} = parseProvisionArgs(process.argv.slice(2))

  validateDoctl()

  if (checkExists) {
    console.log(JSON.stringify(await checkDropletExistence()))
    return
  }

  const missing = validateRequiredEnv(process.env as Record<string, string>)
  if (missing.length > 0) {
    console.error(`\u001B[1;31mError:\u001B[0m Missing required environment variables: ${missing.join(', ')}`)
    console.error('Set them before running this script.')
    process.exit(1)
  }

  const gatewayHost = process.env.GATEWAY_HOST ?? ''

  await run('Validating doctl authentication', ['doctl', 'account', 'get'])

  const exists = await dropletExists(DROPLET_NAME)

  if (exists && !force) {
    console.error(
      `\u001B[1;31mError:\u001B[0m Droplet "${DROPLET_NAME}" already exists. Use --force to proceed anyway.`,
    )
    process.exit(1)
  }

  if (exists && force) {
    console.warn(`⚠️  --force: Proceeding despite existing droplet "${DROPLET_NAME}"`)
  }

  if (!exists) {
    const fingerprint = await getSshFingerprint()
    await run(`Creating droplet ${DROPLET_NAME}`, [
      'doctl',
      'compute',
      'droplet',
      'create',
      DROPLET_NAME,
      '--image',
      DROPLET_IMAGE,
      '--size',
      DROPLET_SIZE,
      '--region',
      DROPLET_REGION,
      '--ssh-keys',
      fingerprint,
      '--wait',
    ])
  }

  const dropletIp = await getDropletIpWithWait()
  await waitForSsh(dropletIp)

  const knownHostsPath = resolve(join(import.meta.dir, '..', '..', '..', '.github', 'known_hosts'))
  await pinHostKeys(gatewayHost, dropletIp, knownHostsPath)

  printOperatorSetupMessage(dropletIp, gatewayHost)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
