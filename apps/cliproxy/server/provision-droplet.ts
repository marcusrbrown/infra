#!/usr/bin/env bun

import {randomBytes} from 'node:crypto'
import {resolve} from 'node:path'

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

const DROPLET_NAME = 'cliproxy'
const DROPLET_IMAGE = 'docker-20-04'
const DROPLET_SIZE = 's-1vcpu-1gb'
const DROPLET_REGION = 'nyc1'
const CLIPROXY_DOMAIN = process.env.CLIPROXY_DOMAIN ?? 'cliproxy.fro.bot'

// Disallowed characters in CLIPROXY_DOMAIN: newlines (heredoc termination),
// shell metacharacters ($, `, |, ;, &), and quotes/backslash.
const DOMAIN_DISALLOWED_RE = /[\n`$|;&'"\\]/

/**
 * Validates a CLIPROXY_DOMAIN value. Throws if it contains characters that
 * could terminate a heredoc early or inject shell commands.
 */
export function validateCliproxyDomain(domain: string): string {
  if (DOMAIN_DISALLOWED_RE.test(domain)) {
    throw new Error(`CLIPROXY_DOMAIN contains disallowed characters: ${JSON.stringify(domain.slice(0, 40))}`)
  }

  return domain
}

const REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/cliproxy'

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
// Internal helper functions — each accepts an optional identityFile
// ---------------------------------------------------------------------------

async function createDropletIfMissing(): Promise<boolean> {
  const exists = await dropletExists(DROPLET_NAME)
  if (exists) {
    console.log(`\u001B[1;34m==>\u001B[0m Droplet ${DROPLET_NAME} already exists — skipping creation`)
    return true
  }

  const keyName = process.env.CLIPROXY_SSH_KEY_NAME ?? 'fro-bot-cliproxy'
  const fingerprint = await getSshFingerprint(keyName, {
    envVarName: 'CLIPROXY_SSH_KEY_NAME',
    defaultKeyName: 'fro-bot-cliproxy',
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

async function validateDns(dropletIp: string): Promise<void> {
  try {
    const resolved = await Bun.dns.lookup(CLIPROXY_DOMAIN)
    const firstResolved = resolved[0]?.address

    if (firstResolved !== dropletIp) {
      console.warn(`DNS not configured. Point cliproxy.fro.bot to ${dropletIp} before running deploy.`)
    }
  } catch {
    console.warn(`DNS not configured. Point cliproxy.fro.bot to ${dropletIp} before running deploy.`)
  }
}

function resolveLocalFiles(): {compose: string; config: string; caddy: string} {
  const appRoot = resolve(import.meta.dir, '..')

  return {
    compose: resolve(appRoot, 'docker-compose.yaml'),
    config: resolve(appRoot, 'config/config.yaml'),
    caddy: resolve(appRoot, 'config/Caddyfile'),
  }
}

export async function copyComposeFiles(host: string, identityFile?: string): Promise<void> {
  const files = resolveLocalFiles()
  const opts = identityFile ? {identityFile} : undefined

  await run('Creating remote directories', ssh(host, `mkdir -p ${REMOTE_DIR}/config`, REMOTE_USER, opts))
  await run(
    'Uploading docker-compose.yaml',
    scp(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`, REMOTE_USER, opts),
  )
  await run(
    'Uploading config/config.yaml',
    scp(host, files.config, `${REMOTE_DIR}/config/config.yaml`, REMOTE_USER, opts),
  )
  await run('Uploading config/Caddyfile', scp(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`, REMOTE_USER, opts))
}

export async function writeRemoteEnvFile(host: string, identityFile?: string): Promise<string> {
  const managementPassword = randomBytes(32).toString('hex')
  const envFile = `CLIPROXY_DOMAIN=${CLIPROXY_DOMAIN}\nMANAGEMENT_PASSWORD=${managementPassword}\n`
  const opts = identityFile ? {identityFile} : undefined

  // Pipe contents through stdin — never embed in the command string.
  // This prevents heredoc-termination injection if any env var contains newlines.
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

  return managementPassword
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
  deps: PerformProvisioningDeps = {},
): Promise<string> {
  const resolvedWaitForSsh = deps.waitForSsh ?? waitForSsh
  const resolvedPinHostKeys = deps.pinHostKeys ?? pinHostKeys
  const resolvedCopyComposeFiles = deps.copyComposeFiles ?? copyComposeFiles
  const resolvedWriteRemoteEnvFile = deps.writeRemoteEnvFile ?? writeRemoteEnvFile
  const resolvedDeployCompose = deps.deployCompose ?? deployCompose

  const {identityFile, cleanup} = resolveProvisionIdentity(privateKey)

  try {
    await resolvedWaitForSsh(dropletIp, REMOTE_USER, {identityFile})
    const knownHostsPath = resolve(import.meta.dir, '..', '..', '..', '.github', 'known_hosts')
    await resolvedPinHostKeys(CLIPROXY_DOMAIN, dropletIp, knownHostsPath, {
      marker: `# cliproxy droplet (${dropletIp} / ${CLIPROXY_DOMAIN})`,
    })
    await validateDns(dropletIp)
    await resolvedCopyComposeFiles(dropletIp, identityFile)
    const managementPassword = await resolvedWriteRemoteEnvFile(dropletIp, identityFile)
    await resolvedDeployCompose(dropletIp, identityFile)
    return managementPassword
  } finally {
    cleanup()
  }
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function provision(): Promise<void> {
  await validateDoctl({checkAuth: true})
  const dropletAlreadyExisted = await createDropletIfMissing()

  if (dropletAlreadyExisted && !process.argv.includes('--force')) {
    console.log('Droplet already exists. Use --force to overwrite remote config and secrets.')
    process.exit(0)
  }

  if (dropletAlreadyExisted && process.argv.includes('--force')) {
    console.warn('⚠️  --force: Overwriting remote config and .env on existing droplet')
  }

  const dropletIp = await getDropletIpWithWait(DROPLET_NAME)

  const managementPassword = await performProvisioning(dropletIp, process.env.CLIPROXY_SSH_KEY)

  console.log('\n\u001B[1;32m✓\u001B[0m CLIProxy droplet provisioned\n')
  console.log(`Droplet IP: ${dropletIp}`)
  console.log(`Management key: ${managementPassword}`)
  console.log(
    '\n⚠️  Save this key — it cannot be recovered. Set it as CLIPROXY_MANAGEMENT_KEY in GitHub secrets and local .env',
  )
  console.log('\nCommit the updated .github/known_hosts before triggering a CI deploy.')
}

if (import.meta.main) {
  validateCliproxyDomain(CLIPROXY_DOMAIN)
  provision().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
