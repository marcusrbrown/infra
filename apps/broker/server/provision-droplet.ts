#!/usr/bin/env bun

import {chmodSync, mkdirSync, writeFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  materializeIdentityFile,
  pinHostKeys,
  run,
  scp,
  ssh,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {validateBrokerHost} from '../src/host'

const DROPLET_NAME = 'broker'
const DROPLET_IMAGE = 'docker-20-04'
const DROPLET_SIZE = 's-1vcpu-1gb'
const DROPLET_REGION = 'nyc1'
const BROKER_DOMAIN = process.env.BROKER_DOMAIN ?? 'broker.fro.bot'

const REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/broker'

// ---------------------------------------------------------------------------
// Identity resolution (exported for testability)
// ---------------------------------------------------------------------------

export interface ProvisionIdentity {
  /** Temp file path of the materialized key, or undefined when no key was given. */
  identityFile: string | undefined
  /** Removes the temp file. No-op when identityFile is undefined. */
  cleanup: () => void
}

/**
 * Materializes the SSH private key (if provided) into a temp file and returns
 * a cleanup handle. Returns an identity with no path and a no-op cleanup when
 * key material is absent (ssh-agent path).
 */
export function resolveProvisionIdentity(privateKey: string | undefined): ProvisionIdentity {
  if (!privateKey || privateKey.trim().length === 0) {
    return {identityFile: undefined, cleanup: () => {}}
  }

  const {path, cleanup} = materializeIdentityFile(privateKey)
  return {identityFile: path, cleanup}
}

// ---------------------------------------------------------------------------
// Internal helper functions
// ---------------------------------------------------------------------------

async function createDropletIfMissing(): Promise<boolean> {
  const exists = await dropletExists(DROPLET_NAME)
  if (exists) {
    console.log(`\u001B[1;34m==>\u001B[0m Droplet ${DROPLET_NAME} already exists — skipping creation`)
    return true
  }

  const keyName = process.env.BROKER_SSH_KEY_NAME ?? 'fro-bot-broker'
  const fingerprint = await getSshFingerprint(keyName, {
    envVarName: 'BROKER_SSH_KEY_NAME',
    defaultKeyName: 'fro-bot-broker',
  })
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
  return false
}

export async function copyComposeFiles(host: string, identityFile?: string): Promise<void> {
  const appRoot = resolve(import.meta.dir, '..')
  const compose = resolve(appRoot, 'docker-compose.yaml')
  const caddy = resolve(appRoot, 'config/Caddyfile')
  const opts = identityFile ? {identityFile} : undefined

  await run('Creating remote directories', ssh(host, `mkdir -p ${REMOTE_DIR}/config`, REMOTE_USER, opts))
  await run('Uploading docker-compose.yaml', scp(host, compose, `${REMOTE_DIR}/docker-compose.yaml`, REMOTE_USER, opts))
  await run('Uploading config/Caddyfile', scp(host, caddy, `${REMOTE_DIR}/config/Caddyfile`, REMOTE_USER, opts))
}

/**
 * Writes the broker .env file to the remote host via SSH stdin.
 *
 * Contains:
 *   - CLIPROXY_MANAGEMENT_KEY: the broker→cliproxy management key (secret)
 *   - BROKER_HOST: the broker's own FQDN
 *   - BROKER_AUD: the broker-minted OIDC audience value
 *
 * SECURITY: all secret bytes travel via SSH stdin only — NEVER in argv.
 * The remote command is `cat > <path>`: the path is in argv (not secret),
 * and the env file contents are piped through stdin.
 */
export async function writeRemoteEnvFile(
  host: string,
  managementKey: string,
  brokerHost: string,
  brokerAud: string,
  identityFile?: string,
): Promise<void> {
  const envFile = `${[`CLIPROXY_MANAGEMENT_KEY=${managementKey}`, `BROKER_HOST=${brokerHost}`, `BROKER_AUD=${brokerAud}`].join('\n')}\n`

  const opts = identityFile ? {identityFile} : undefined

  // Pipe contents through stdin — never embed in the command string.
  const proc = Bun.spawn(ssh(host, `cat > ${REMOTE_DIR}/.env`, REMOTE_USER, opts), {
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

  console.log('\u001B[1;34m==>\u001B[0m Writing remote .env file')
}

export async function installDocker(host: string, identityFile?: string): Promise<void> {
  const opts = identityFile ? {identityFile} : undefined
  // docker-20-04 image already has Docker; this is a no-op guard for other images.
  await run('Verifying Docker installation', ssh(host, 'docker --version', REMOTE_USER, opts))
}

export async function deployCompose(host: string, identityFile?: string): Promise<void> {
  const opts = identityFile ? {identityFile} : undefined
  await run('Starting Docker Compose stack', ssh(host, `cd ${REMOTE_DIR} && docker compose up -d`, REMOTE_USER, opts))
}

// ---------------------------------------------------------------------------
// Full provisioning orchestration seam (exported for testability)
// ---------------------------------------------------------------------------

export interface PerformProvisioningDeps {
  waitForSsh?: typeof waitForSsh
  pinHostKeys?: typeof pinHostKeys
  copyComposeFiles?: typeof copyComposeFiles
  writeRemoteEnvFile?: typeof writeRemoteEnvFile
  installDocker?: typeof installDocker
  deployCompose?: typeof deployCompose
}

/**
 * Performs the SSH-reliant provisioning steps after the droplet IP is known.
 * Materializes the SSH key (if provided) into a temp file, passes it through
 * all SSH/SCP helper calls, and cleans it up in a `finally` block.
 *
 * Injectable deps allow tests to assert identity file threading without live
 * SSH connections. Production callers omit deps and get the real implementations.
 */
export async function performProvisioning(
  dropletIp: string,
  privateKey: string | undefined,
  managementKey: string,
  brokerHost: string,
  brokerAud: string,
  deps: PerformProvisioningDeps = {},
): Promise<void> {
  const resolvedWaitForSsh = deps.waitForSsh ?? waitForSsh
  const resolvedPinHostKeys = deps.pinHostKeys ?? pinHostKeys
  const resolvedCopyComposeFiles = deps.copyComposeFiles ?? copyComposeFiles
  const resolvedWriteRemoteEnvFile = deps.writeRemoteEnvFile ?? writeRemoteEnvFile
  const resolvedInstallDocker = deps.installDocker ?? installDocker
  const resolvedDeployCompose = deps.deployCompose ?? deployCompose

  const {identityFile, cleanup} = resolveProvisionIdentity(privateKey)

  try {
    await resolvedWaitForSsh(dropletIp, REMOTE_USER, {identityFile})
    const knownHostsPath = resolve(import.meta.dir, '..', '..', '..', '.github', 'known_hosts')
    await resolvedPinHostKeys(BROKER_DOMAIN, dropletIp, knownHostsPath, {
      marker: `# broker droplet (${dropletIp} / ${BROKER_DOMAIN})`,
    })
    await resolvedCopyComposeFiles(dropletIp, identityFile)
    await resolvedWriteRemoteEnvFile(dropletIp, managementKey, brokerHost, brokerAud, identityFile)
    await resolvedInstallDocker(dropletIp, identityFile)
    await resolvedDeployCompose(dropletIp, identityFile)
  } finally {
    cleanup()
  }
}

// ---------------------------------------------------------------------------
// Management key file helper (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Writes the management key to `<repoRoot>/.broker-management-key` with mode 0600.
 * Returns the absolute path to the written file.
 *
 * The key value is NEVER printed to stdout — only the file path is surfaced to the operator.
 */
export async function writeManagementKeyFile(repoRoot: string, key: string): Promise<string> {
  mkdirSync(repoRoot, {recursive: true})
  const filePath = join(repoRoot, '.broker-management-key')
  writeFileSync(filePath, key, {mode: 0o600})
  chmodSync(filePath, 0o600)
  return filePath
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function provision(): Promise<void> {
  await validateDoctl({checkAuth: true})

  // Validate the broker host before any SSH argv construction.
  validateBrokerHost(BROKER_DOMAIN)

  const dropletAlreadyExisted = await createDropletIfMissing()

  if (dropletAlreadyExisted && !process.argv.includes('--force')) {
    console.log('Droplet already exists. Use --force to overwrite remote config and secrets.')
    process.exit(0)
  }

  if (dropletAlreadyExisted && process.argv.includes('--force')) {
    console.warn('⚠️  --force: Overwriting remote config and .env on existing droplet')
  }

  const dropletIp = await getDropletIpWithWait(DROPLET_NAME)

  // Required secrets from environment
  const managementKey = process.env.CLIPROXY_MANAGEMENT_KEY
  if (!managementKey) {
    throw new Error('CLIPROXY_MANAGEMENT_KEY is required — the broker→cliproxy management key')
  }

  const brokerAud = process.env.BROKER_AUD
  if (!brokerAud) {
    throw new Error('BROKER_AUD is required — the broker-minted OIDC audience value')
  }

  await performProvisioning(dropletIp, process.env.BROKER_SSH_KEY, managementKey, BROKER_DOMAIN, brokerAud)

  const repoRoot = resolve(import.meta.dir, '../../..')
  const keyFilePath = await writeManagementKeyFile(repoRoot, managementKey)

  console.log('\n\u001B[1;32m✓\u001B[0m Broker droplet provisioned\n')
  console.log(`Droplet IP: ${dropletIp}`)
  console.log(`Management key written to: ${keyFilePath} (mode 0600)`)
  console.log(
    '\n⚠️  Save this key now — it cannot be recovered. Copy it into CLIPROXY_MANAGEMENT_KEY (GitHub secret + local .env), then delete the file.',
  )
  console.log('\nCommit the updated .github/known_hosts before triggering a CI deploy.')
}

if (import.meta.main) {
  provision().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
