#!/usr/bin/env bun

import {join, resolve} from 'node:path'

import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  materializeIdentityFile,
  pinHostKeys,
  run,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {validateGatewayHost} from '../src/host'

const DROPLET_NAME = 'gateway'
const DROPLET_IMAGE = 'docker-20-04'
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
// Gateway-specific helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Validates that all required environment variables are present.
 * Returns the list of missing variable names (empty = all present).
 */
export function validateRequiredEnv(env: Partial<Record<string, string>>): string[] {
  const required = ['DIGITALOCEAN_ACCESS_TOKEN', 'GATEWAY_HOST']
  return required.filter(key => !env[key])
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
 * Returns the SSH key fingerprint for the gateway key.
 * Accepts an optional keyName override; falls back to GATEWAY_SSH_KEY_NAME env var,
 * then to the default 'fro-bot-gateway'.
 */
export async function getGatewaySshFingerprint(keyName?: string): Promise<string> {
  const name = keyName ?? process.env.GATEWAY_SSH_KEY_NAME ?? 'fro-bot-gateway'
  return getSshFingerprint(name, {envVarName: 'GATEWAY_SSH_KEY_NAME', defaultKeyName: 'fro-bot-gateway'})
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
// SSH identity seam (exported for testability)
// ---------------------------------------------------------------------------

export interface EstablishSshAccessDeps {
  waitForSsh?: (host: string, user: string, opts?: {identityFile?: string}) => Promise<void>
}

/**
 * Materializes the SSH key (if provided) into a temp file and calls waitForSsh.
 * Cleans up the temp file in a `finally` block regardless of outcome.
 * Injectable deps allow tests to assert identity file threading without live SSH.
 */
export async function establishSshAccess(
  dropletIp: string,
  privateKey: string | undefined,
  deps: EstablishSshAccessDeps = {},
): Promise<void> {
  const resolvedWaitForSsh = deps.waitForSsh ?? waitForSsh
  const identity = privateKey ? materializeIdentityFile(privateKey) : undefined
  try {
    await resolvedWaitForSsh(dropletIp, REMOTE_USER, {identityFile: identity?.path})
  } finally {
    identity?.cleanup()
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const {force, checkExists} = parseProvisionArgs(process.argv.slice(2))

  await validateDoctl({checkAuth: true})

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

  const gatewayHost = validateGatewayHost(process.env.GATEWAY_HOST ?? '')

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
    const fingerprint = await getGatewaySshFingerprint()
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

  const dropletIp = await getDropletIpWithWait(DROPLET_NAME)
  await establishSshAccess(dropletIp, process.env.GATEWAY_SSH_KEY)

  const knownHostsPath = resolve(join(import.meta.dir, '..', '..', '..', '.github', 'known_hosts'))
  await pinHostKeys(gatewayHost, dropletIp, knownHostsPath, {
    marker: `# gateway droplet (${dropletIp} / ${gatewayHost})`,
  })

  printOperatorSetupMessage(dropletIp, gatewayHost)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
