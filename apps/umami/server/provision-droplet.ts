#!/usr/bin/env bun

import {join, resolve} from 'node:path'

import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  pinHostKeys,
  run,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {validateUmamiHost} from '../src/host'

const DROPLET_NAME = 'umami'
const DROPLET_IMAGE = 'docker-20-04'
const DROPLET_SIZE = 's-1vcpu-1gb'
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
// Umami-specific helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Validates that all required environment variables are present.
 * Returns the list of missing variable names (empty = all present).
 */
export function validateRequiredEnv(env: Partial<Record<string, string>>): string[] {
  const required = ['DIGITALOCEAN_ACCESS_TOKEN', 'UMAMI_DOMAIN']
  return required.filter(key => !env[key])
}

/**
 * Non-mutating state probe for agents/CI. Only lists droplets — does not
 * validate provision-only environment, create anything, pin host keys, or
 * wait for SSH.
 */
export async function checkDropletExistence(name = DROPLET_NAME): Promise<DropletExistenceState> {
  return {name, exists: await dropletExists(name)}
}

/**
 * Parses provisioning arguments. Unknown flags are rejected so automated
 * callers don't accidentally get a default mutating run after a typo.
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
 * Returns the SSH key fingerprint for the umami key.
 * Accepts an optional keyName override; falls back to UMAMI_SSH_KEY_NAME env
 * var, then to the default 'fro-bot-umami'.
 */
export async function getUmamiSshFingerprint(keyName?: string): Promise<string> {
  const name = keyName ?? process.env.UMAMI_SSH_KEY_NAME ?? 'fro-bot-umami'
  return getSshFingerprint(name, {envVarName: 'UMAMI_SSH_KEY_NAME', defaultKeyName: 'fro-bot-umami'})
}

function printOperatorSetupMessage(dropletIp: string, umamiHost: string): void {
  console.log('\n\u001B[1;32m✓\u001B[0m Umami droplet provisioned\n')
  console.log(`Droplet IP: ${dropletIp}`)
  console.log(`\nBefore triggering a CI deploy, set the following in the \u001B[1mumami\u001B[0m GitHub Environment:\n`)
  console.log('  Required secrets:')
  console.log('    UMAMI_SSH_KEY            — private key for SSH access to the droplet')
  console.log(`    UMAMI_DOMAIN             — ${umamiHost}`)
  console.log('\nCommit the updated .github/known_hosts before triggering a CI deploy.')
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

  const umamiHost = validateUmamiHost(process.env.UMAMI_DOMAIN ?? '')

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
    const fingerprint = await getUmamiSshFingerprint()
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
  await waitForSsh(dropletIp, REMOTE_USER)

  const knownHostsPath = resolve(join(import.meta.dir, '..', '..', '..', '.github', 'known_hosts'))
  await pinHostKeys(umamiHost, dropletIp, knownHostsPath, {
    marker: `# umami droplet (${dropletIp} / ${umamiHost})`,
  })

  printOperatorSetupMessage(dropletIp, umamiHost)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
