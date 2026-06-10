#!/usr/bin/env bun

/**
 * Lightsail provisioner for the fro-bot-vpn WireGuard egress box.
 *
 * Idempotent: aborts if the instance already exists unless --force is passed.
 * Partial-state repair: if the instance exists but static IP or firewall is
 * missing, repairs them without re-creating the instance (requires --force).
 *
 * Ed25519 note: ImportKeyPairCommand is called with the raw OpenSSH public key
 * text (NOT btoa-encoded — see importKeyPairIdempotent for details). Lightsail
 * accepts Ed25519 keys passed as raw OpenSSH text; this has been empirically
 * confirmed against live AWS Lightsail eu-west-1. If Lightsail rejects Ed25519
 * at runtime for some other reason, fall back to an RSA key for this box only
 * and record the outcome in apps/vpn/AGENTS.md.
 * No RSA fallback is implemented here — that is a runtime concern, not a
 * compile-time one.
 */

import {join, resolve} from 'node:path'

import {
  AllocateStaticIpCommand,
  AttachStaticIpCommand,
  CreateInstancesCommand,
  GetBlueprintsCommand,
  GetBundlesCommand,
  GetInstanceCommand,
  GetInstancesCommand,
  GetStaticIpCommand,
  ImportKeyPairCommand,
  LightsailClient,
  PutInstancePublicPortsCommand,
} from '@aws-sdk/client-lightsail'
import {
  materializeIdentityFile,
  pinHostKeys,
  sleep,
  ssh,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const INSTANCE_NAME = 'fro-bot-vpn'
const KEY_PAIR_NAME = 'fro-bot-vpn-key'
const STATIC_IP_NAME = 'fro-bot-vpn-ip'
const AVAILABILITY_ZONE = 'eu-west-1a'
const REMOTE_USER = 'ubuntu'

// Firewall ruleset: set-exact (replaces the whole set).
// SSH 22 MUST be included — PutInstancePublicPorts replaces the entire ruleset,
// so omitting SSH 22 would lock out the operator. This is a tested invariant.
const FIREWALL_PORTS = [
  {fromPort: 22, toPort: 22, protocol: 'tcp' as const},
  {fromPort: 51820, toPort: 51820, protocol: 'udp' as const},
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// A send-function type that accepts any Lightsail SDK command and returns a
// promise of the response. This seam allows tests to inject a fake without
// constructing a real LightsailClient.
// We use LightsailClient['send'] to get the exact overloaded signature the SDK
// exposes, which accepts Command<...> instances and returns ServiceOutputTypes.
export type LightsailSendFn = LightsailClient['send']

export interface ProvisionArgs {
  force: boolean
}

export interface ProvisionDeps {
  /** Lightsail send function (real client or test fake). */
  send: LightsailSendFn
  /** Ed25519 public key string (e.g. "ssh-ed25519 AAAA..."). */
  publicKey: string
  /** SSH private key material for waitForSsh + WireGuard install. */
  privateKey: string | undefined
  /** Absolute path to .github/known_hosts for host-key pinning. */
  knownHostsPath: string
  /** Poll interval in ms for instance state polling (default 5000). */
  pollIntervalMs?: number
  /** Whether to proceed even if the instance already exists. */
  force?: boolean
  /** Injectable waitForSsh (defaults to shared helper). */
  waitForSsh?: (ip: string, user: string, opts?: {identityFile?: string}) => Promise<void>
  /** Injectable SSH command runner for WireGuard install. */
  runSsh?: (command: string, ip: string, identityFile?: string) => Promise<void>
  /** Injectable pinHostKeys (defaults to shared helper). */
  pinHostKeys?: (domain: string, ip: string, knownHostsPath: string, opts: {marker: string}) => Promise<void>
  /** Injectable IP printer (defaults to console.log). */
  printIp?: (ip: string) => void
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Validates that all required VPN AWS environment variables are present.
 * Returns the list of missing variable names (empty = all present).
 *
 * Uses VPN_AWS_ACCESS_KEY_ID and VPN_AWS_SECRET_ACCESS_KEY — distinct from the
 * gateway's standard AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY (S3-scoped, lacks
 * Lightsail permissions). Set up a dedicated least-privilege Lightsail IAM user
 * and place its credentials in VPN_AWS_ACCESS_KEY_ID / VPN_AWS_SECRET_ACCESS_KEY.
 */
export function validateRequiredEnv(env: Partial<Record<string, string>>): string[] {
  const required = ['VPN_AWS_ACCESS_KEY_ID', 'VPN_AWS_SECRET_ACCESS_KEY']
  return required.filter(key => !env[key])
}

/**
 * Parses provisioning arguments. Unknown flags are rejected so automated callers
 * don't accidentally get a default mutating run after a typo.
 */
export function parseProvisionArgs(args: string[]): ProvisionArgs {
  const known = new Set(['--force'])
  const unknown = args.filter(arg => !known.has(arg))

  if (unknown.length > 0) {
    throw new Error(`Unknown provision argument(s): ${unknown.join(', ')}. Supported: --force`)
  }

  return {
    force: args.includes('--force'),
  }
}

/**
 * Picks the newest active Ubuntu LTS blueprint from the list.
 * Filters by group containing 'ubuntu', isActive=true, platform=LINUX_UNIX.
 * Sorts by version string descending (lexicographic — works for "20.04", "22.04", "24.04").
 * Throws an actionable error if no matching blueprint is found.
 */
export function findUbuntuBlueprint(
  blueprints: {
    blueprintId?: string
    name?: string
    group?: string
    isActive?: boolean
    platform?: string
    version?: string
  }[],
): string {
  const candidates = blueprints.filter(
    b =>
      b.isActive === true &&
      b.blueprintId &&
      (b.group?.toLowerCase().includes('ubuntu') || b.name?.toLowerCase().includes('ubuntu')),
  )

  if (candidates.length === 0) {
    throw new Error('No active Ubuntu blueprint found. Run GetBlueprintsCommand to see available blueprints.')
  }

  // Sort by version descending — newest LTS first
  candidates.sort((a, b) => {
    const av = a.version ?? ''
    const bv = b.version ?? ''
    return bv.localeCompare(av, undefined, {numeric: true})
  })

  const chosen = candidates[0]
  if (!chosen?.blueprintId) {
    throw new Error('No active Ubuntu blueprint found.')
  }

  return chosen.blueprintId
}

/**
 * Picks the cheapest active LINUX_UNIX bundle from the list.
 * Filters by isActive=true, supportedPlatforms includes LINUX_UNIX.
 * Sorts by price ascending.
 * Throws an actionable error if no matching bundle is found.
 */
export function findSmallestIpv4Bundle(
  bundles: {
    bundleId?: string
    price?: number
    isActive?: boolean
    supportedPlatforms?: string[]
  }[],
): string {
  const candidates = bundles.filter(
    b => b.isActive === true && b.bundleId && b.supportedPlatforms?.includes('LINUX_UNIX'),
  )

  if (candidates.length === 0) {
    throw new Error('No active LINUX_UNIX bundle found. Run GetBundlesCommand to see available bundles.')
  }

  // Sort by price ascending — cheapest first
  candidates.sort((a, b) => (a.price ?? 0) - (b.price ?? 0))

  const chosen = candidates[0]
  if (!chosen?.bundleId) {
    throw new Error('No active LINUX_UNIX bundle found.')
  }

  return chosen.bundleId
}

/**
 * Checks whether the named Lightsail instance exists.
 * Uses GetInstancesCommand (Lightsail-native — does NOT reuse DO dropletExists).
 */
export async function instanceExists(name: string, send: LightsailSendFn): Promise<boolean> {
  const response = (await send(new GetInstancesCommand({}))) as {instances?: {name?: string}[]}
  const instances = response.instances ?? []
  return instances.some(i => i.name === name)
}

/**
 * Imports the SSH public key into Lightsail as a named key pair.
 * Idempotent: swallows "already exists" errors so re-runs don't fail.
 *
 * Despite the SDK parameter being named `publicKeyBase64`, Lightsail expects
 * the raw OpenSSH public key text (e.g. "ssh-ed25519 AAAA... comment") passed
 * as-is. The "Base64" in the name refers to the key body already being base64
 * inside the OpenSSH format — calling btoa() on top of it double-encodes and
 * causes InvalidInputException: The format of this public key is not valid.
 * Ed25519 keys are accepted by Lightsail when passed as raw OpenSSH text.
 */
export async function importKeyPairIdempotent(
  keyPairName: string,
  publicKey: string,
  send: LightsailSendFn,
): Promise<void> {
  try {
    await send(new ImportKeyPairCommand({keyPairName, publicKeyBase64: publicKey.trim()}))
  } catch (error: unknown) {
    // Swallow "already exists" errors — idempotent re-import is fine
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.toLowerCase().includes('already exists') || msg.toLowerCase().includes('duplicate')) {
      console.log(`\u001B[1;34m==>\u001B[0m Key pair "${keyPairName}" already exists — skipping import`)
      return
    }
    throw error
  }
}

export interface PollOptions {
  maxAttempts?: number
  intervalMs?: number
}

/**
 * Polls GetInstanceCommand until state.name === 'running'.
 * Defaults: 40 attempts × 5000ms.
 */
export async function pollUntilRunning(instanceName: string, send: LightsailSendFn, opts?: PollOptions): Promise<void> {
  const maxAttempts = opts?.maxAttempts ?? 40
  const intervalMs = opts?.intervalMs ?? 5_000

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const response = (await send(new GetInstanceCommand({instanceName}))) as {
      instance?: {state?: {name?: string}}
    }
    const state = response.instance?.state?.name
    if (state === 'running') {
      return
    }
    console.log(`\u001B[1;34m==>\u001B[0m Instance state: ${state ?? 'unknown'} (attempt ${attempt}/${maxAttempts})`)
    if (attempt < maxAttempts) {
      await sleep(intervalMs)
    }
  }

  throw new Error(`Timed out waiting for instance "${instanceName}" to reach running state`)
}

// ---------------------------------------------------------------------------
// Identity resolution (exported for testability)
// ---------------------------------------------------------------------------

export interface ProvisionIdentity {
  identityFile: string | undefined
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
// IP-only host-key pinning (exported for testability)
// ---------------------------------------------------------------------------

type PinHostKeysFn = (domain: string, ip: string, knownHostsPath: string, opts: {marker: string}) => Promise<void>

/**
 * Pins the host key for an IP address only (no domain in v1).
 * Passes the IP as both the domain and ip args to pinHostKeys so that
 * ssh-keyscan is called for the IP (harmless double-scan).
 * Fails closed: if pinning fails, the error propagates.
 */
export async function pinIpHostKey(
  ip: string,
  knownHostsPath: string,
  pinFn: PinHostKeysFn = pinHostKeys,
): Promise<void> {
  await pinFn(ip, ip, knownHostsPath, {
    marker: `# fro-bot-vpn static IP (${ip})`,
  })
}

// ---------------------------------------------------------------------------
// Full provisioning orchestration (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Performs the full Lightsail provisioning sequence:
 * 1. Check if instance exists → abort unless --force; repair partial state if --force
 * 2. ImportKeyPair (idempotent)
 * 3. Resolve blueprint + bundle live
 * 4. CreateInstances
 * 5. Poll until running
 * 6. AllocateStaticIp + AttachStaticIp
 * 7. GetStaticIp → IP address
 * 8. PutInstancePublicPorts (set-exact: SSH 22 + UDP 51820)
 * 9. waitForSsh
 * 10. Install WireGuard via SSH
 * 11. Pin IP host key (fail closed)
 * 12. Print static IP for operator
 */
export async function performProvisioning(deps: ProvisionDeps): Promise<void> {
  const {send, publicKey, privateKey, knownHostsPath, force = false, pollIntervalMs = 5_000} = deps

  const resolvedWaitForSsh = deps.waitForSsh ?? waitForSsh
  const resolvedPinHostKeys = deps.pinHostKeys ?? pinHostKeys
  const resolvedPrintIp = deps.printIp ?? ((ip: string) => console.log(`\nStatic IP: ${ip}`))

  const resolvedRunSsh =
    deps.runSsh ??
    (async (command: string, ip: string, identityFile?: string) => {
      const opts = identityFile ? {identityFile} : undefined
      const proc = Bun.spawn(ssh(ip, command, REMOTE_USER, opts), {
        stdout: 'inherit',
        stderr: 'inherit',
      })
      const code = await proc.exited
      if (code !== 0) {
        throw new Error(`SSH command failed (exit ${code}): ${command}`)
      }
    })

  // Step 1: Check instance existence
  const exists = await instanceExists(INSTANCE_NAME, send)

  if (exists && !force) {
    throw new Error(`Instance "${INSTANCE_NAME}" already exists. Use --force to proceed anyway.`)
  }

  if (exists && force) {
    console.warn(`⚠️  --force: Proceeding despite existing instance "${INSTANCE_NAME}"`)
  }

  // Step 2: Import SSH key pair (idempotent)
  await importKeyPairIdempotent(KEY_PAIR_NAME, publicKey, send)

  // Step 3: Resolve blueprint + bundle live (never hardcode)
  const blueprintsResponse = (await send(new GetBlueprintsCommand({}))) as {
    blueprints?: {
      blueprintId?: string
      name?: string
      group?: string
      isActive?: boolean
      platform?: string
      version?: string
    }[]
  }
  const blueprintId = findUbuntuBlueprint(blueprintsResponse.blueprints ?? [])

  const bundlesResponse = (await send(new GetBundlesCommand({}))) as {
    bundles?: {bundleId?: string; price?: number; isActive?: boolean; supportedPlatforms?: string[]}[]
  }
  const bundleId = findSmallestIpv4Bundle(bundlesResponse.bundles ?? [])

  console.log(`\u001B[1;34m==>\u001B[0m Using blueprint: ${blueprintId}, bundle: ${bundleId}`)

  // Step 4: Create instance (skip if already exists — repair path)
  if (!exists) {
    console.log(`\u001B[1;34m==>\u001B[0m Creating instance "${INSTANCE_NAME}"`)
    await send(
      new CreateInstancesCommand({
        instanceNames: [INSTANCE_NAME],
        availabilityZone: AVAILABILITY_ZONE,
        blueprintId,
        bundleId,
        keyPairName: KEY_PAIR_NAME,
      }),
    )
  }

  // Step 5: Poll until running
  console.log(`\u001B[1;34m==>\u001B[0m Waiting for instance to reach running state`)
  await pollUntilRunning(INSTANCE_NAME, send, {intervalMs: pollIntervalMs})

  // Step 6: Allocate + attach static IP (idempotent — mirrors importKeyPairIdempotent pattern)
  // Check if the static IP already exists before allocating — Lightsail rejects duplicate names.
  let staticIp: string | undefined
  try {
    console.log(`\u001B[1;34m==>\u001B[0m Checking if static IP "${STATIC_IP_NAME}" already exists`)
    const existingIpResponse = (await send(new GetStaticIpCommand({staticIpName: STATIC_IP_NAME}))) as {
      staticIp?: {ipAddress?: string}
    }
    staticIp = existingIpResponse.staticIp?.ipAddress
    if (staticIp) {
      console.log(
        `\u001B[1;34m==>\u001B[0m Static IP "${STATIC_IP_NAME}" already exists (${staticIp}) — skipping allocation`,
      )
    }
  } catch (error: unknown) {
    // Static IP does not exist — allocate fresh
    const msg = error instanceof Error ? error.message : String(error)
    const isNotFound =
      msg.toLowerCase().includes('not found') ||
      msg.toLowerCase().includes('does not exist') ||
      msg.toLowerCase().includes('no static ip')
    if (!isNotFound) {
      throw error
    }
    console.log(`\u001B[1;34m==>\u001B[0m Allocating static IP "${STATIC_IP_NAME}"`)
    await send(new AllocateStaticIpCommand({staticIpName: STATIC_IP_NAME}))
  }

  // AttachStaticIpCommand is safe to call when already attached (idempotent)
  console.log(`\u001B[1;34m==>\u001B[0m Attaching static IP to instance`)
  await send(new AttachStaticIpCommand({staticIpName: STATIC_IP_NAME, instanceName: INSTANCE_NAME}))

  // Step 7: Get the IP address (may already be set from the existence check above)
  if (!staticIp) {
    const staticIpResponse = (await send(new GetStaticIpCommand({staticIpName: STATIC_IP_NAME}))) as {
      staticIp?: {ipAddress?: string}
    }
    staticIp = staticIpResponse.staticIp?.ipAddress
  }
  if (!staticIp) {
    throw new Error('Failed to retrieve static IP address after allocation')
  }

  // Step 8: Set exact firewall ruleset (SSH 22 + UDP 51820; closes default 80/443)
  console.log(`\u001B[1;34m==>\u001B[0m Setting firewall ruleset (SSH 22 + UDP 51820)`)
  await send(
    new PutInstancePublicPortsCommand({
      instanceName: INSTANCE_NAME,
      portInfos: FIREWALL_PORTS,
    }),
  )

  // Steps 9-11: SSH-dependent steps — materialize identity file
  const {identityFile, cleanup} = resolveProvisionIdentity(privateKey)
  try {
    // Step 9: Wait for SSH connectivity
    console.log(`\u001B[1;34m==>\u001B[0m Waiting for SSH connectivity on ${staticIp}`)
    await resolvedWaitForSsh(staticIp, REMOTE_USER, {identityFile})

    // Step 10: Install WireGuard (must run before any wg use)
    console.log(`\u001B[1;34m==>\u001B[0m Installing WireGuard`)
    await resolvedRunSsh(
      'sudo apt-get update && sudo DEBIAN_FRONTEND=noninteractive apt-get install -y wireguard',
      staticIp,
      identityFile,
    )

    // Step 11: Pin IP host key (fail closed — error propagates)
    console.log(`\u001B[1;34m==>\u001B[0m Pinning host key for ${staticIp}`)
    await pinIpHostKey(staticIp, knownHostsPath, resolvedPinHostKeys)
  } finally {
    cleanup()
  }

  // Step 12: Print static IP for operator to seed VPN_HOST
  console.log('\n\u001B[1;32m✓\u001B[0m VPN instance provisioned\n')
  resolvedPrintIp(staticIp)
  console.log('\nSeed this IP as VPN_HOST in your .env and the vpn GitHub Environment before the first deploy.')
  console.log('Commit the updated .github/known_hosts before triggering a CI deploy.')
}

// ---------------------------------------------------------------------------
// Main orchestrator
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const {force} = parseProvisionArgs(process.argv.slice(2))

  const missing = validateRequiredEnv(process.env as Record<string, string>)
  if (missing.length > 0) {
    console.error(`\u001B[1;31mError:\u001B[0m Missing required environment variables: ${missing.join(', ')}`)
    console.error(
      'Set VPN_AWS_ACCESS_KEY_ID and VPN_AWS_SECRET_ACCESS_KEY to the credentials of a dedicated Lightsail IAM user.',
    )
    console.error('See apps/vpn/AGENTS.md § IAM note for the required action set.')
    process.exit(1)
  }

  const publicKey = process.env.VPN_PUBLIC_KEY
  if (!publicKey) {
    console.error('\u001B[1;31mError:\u001B[0m VPN_PUBLIC_KEY environment variable is required')
    console.error('Set it to the contents of your fro-bot-vpn Ed25519 public key.')
    process.exit(1)
  }

  // VPN_AWS_REGION defaults to eu-west-1 (the initial scope is Ireland only).
  // The availability zone is hardcoded to eu-west-1a; if you set a different
  // VPN_AWS_REGION the AZ will not match — eu-west-1 is the only supported region.
  const region = process.env.VPN_AWS_REGION ?? 'eu-west-1'

  // Credentials are passed explicitly so the SDK never falls back to the ambient
  // standard AWS env vars (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY), which belong
  // to the gateway's S3 credential and lack Lightsail permissions.
  const accessKeyId = process.env.VPN_AWS_ACCESS_KEY_ID
  const secretAccessKey = process.env.VPN_AWS_SECRET_ACCESS_KEY
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'VPN_AWS_ACCESS_KEY_ID and VPN_AWS_SECRET_ACCESS_KEY are required to construct the Lightsail client.',
    )
  }
  const client = new LightsailClient({
    region,
    credentials: {accessKeyId, secretAccessKey},
  })
  const send: LightsailSendFn = command => client.send(command)

  const knownHostsPath = resolve(join(import.meta.dir, '..', '..', '..', '.github', 'known_hosts'))

  await performProvisioning({
    send,
    publicKey,
    privateKey: process.env.VPN_SSH_KEY,
    knownHostsPath,
    force,
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
