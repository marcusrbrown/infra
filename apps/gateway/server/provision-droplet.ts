#!/usr/bin/env bun

import {join, resolve} from 'node:path'

import {
  GetBucketLifecycleConfigurationCommand,
  PutBucketLifecycleConfigurationCommand,
  S3Client,
  type LifecycleRule,
  type S3ClientConfig,
} from '@aws-sdk/client-s3'
import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  materializeIdentityFile,
  pinHostKeys,
  run,
  runCapture,
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

type LifecycleS3Client = Pick<S3Client, 'send'>
type LifecycleEnv = Partial<Record<string, string>>

export const RUN_STATE_LIFECYCLE_RULE: LifecycleRule = {
  ID: 'run-state-30d-expiration',
  Filter: {Tag: {Key: 'object-type', Value: 'run-state'}},
  Status: 'Enabled',
  Expiration: {Days: 30},
}

function isRunStateLifecycleRule(rule: LifecycleRule | undefined): boolean {
  if (!rule) return false

  if (
    rule.ID !== RUN_STATE_LIFECYCLE_RULE.ID ||
    rule.Status !== RUN_STATE_LIFECYCLE_RULE.Status ||
    rule.Expiration?.Days !== RUN_STATE_LIFECYCLE_RULE.Expiration?.Days
  ) {
    return false
  }

  const filter = rule.Filter
  if (!filter) return false

  const hasTopLevelSizeConstraint =
    filter.ObjectSizeGreaterThan !== undefined || filter.ObjectSizeLessThan !== undefined
  const directTagIsCanonical =
    filter.Tag?.Key === 'object-type' &&
    filter.Tag.Value === 'run-state' &&
    filter.And === undefined &&
    filter.Prefix === undefined &&
    !hasTopLevelSizeConstraint

  if (directTagIsCanonical) return true

  const and = filter.And
  if (
    !and ||
    filter.Tag !== undefined ||
    filter.Prefix !== undefined ||
    hasTopLevelSizeConstraint ||
    and.Prefix !== undefined ||
    and.ObjectSizeGreaterThan !== undefined ||
    and.ObjectSizeLessThan !== undefined ||
    and.Tags?.length !== 1
  ) {
    return false
  }

  const [tag] = and.Tags
  return tag?.Key === 'object-type' && tag.Value === 'run-state'
}

interface LifecycleSecret {
  name: string
  content: string
}

function redactLifecycleError(error: unknown, secrets: LifecycleSecret[]): Error {
  const base = error instanceof Error ? error.message : String(error)
  let sanitized = base
  for (const secret of secrets) {
    if (secret.content) {
      const escaped = secret.content.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
      sanitized = sanitized.replaceAll(new RegExp(escaped, 'g'), `<redacted:${secret.name}>`)
    }
  }
  return new Error(sanitized)
}

/** Ensures AWS-native S3 expires tagged run-state objects after 30 days. */
export async function ensureRunStateLifecycleRule(
  env: LifecycleEnv,
  client?: LifecycleS3Client,
  log: (message: string) => void = message => console.warn(message),
): Promise<void> {
  if (env.S3_ENDPOINT?.trim()) {
    log('skipped: custom S3 endpoint, run-state tagging not applied by daemon')
    return
  }

  const required = ['S3_BUCKET', 'S3_REGION', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY'] as const
  const missing = required.filter(key => !env[key]?.trim())
  if (missing.length > 0) {
    log(`skipped: missing S3 lifecycle environment variables (${missing.join(', ')})`)
    return
  }

  const bucket = env.S3_BUCKET
  const region = env.S3_REGION
  const accessKeyId = env.AWS_ACCESS_KEY_ID
  const secretAccessKey = env.AWS_SECRET_ACCESS_KEY
  if (!bucket || !region || !accessKeyId || !secretAccessKey) return

  const lifecycleSecrets: LifecycleSecret[] = [
    {name: 'aws-access-key-id', content: accessKeyId},
    {name: 'aws-secret-access-key', content: secretAccessKey},
  ]
  if (env.AWS_SESSION_TOKEN) {
    lifecycleSecrets.push({name: 'aws-session-token', content: env.AWS_SESSION_TOKEN})
  }

  const s3 =
    client ??
    new S3Client({
      region,
      maxAttempts: 2,
      credentials: {
        accessKeyId,
        secretAccessKey,
        ...(env.AWS_SESSION_TOKEN ? {sessionToken: env.AWS_SESSION_TOKEN} : {}),
      },
    } satisfies S3ClientConfig)

  const getConfig = async () => {
    try {
      return await s3.send(new GetBucketLifecycleConfigurationCommand({Bucket: bucket}))
    } catch (error) {
      if (error instanceof Error && error.name === 'NoSuchLifecycleConfiguration') return undefined
      throw redactLifecycleError(error, lifecycleSecrets)
    }
  }

  const existingRules: LifecycleRule[] = (await getConfig())?.Rules ?? []
  const desiredRules = [
    ...existingRules.filter(rule => rule.ID !== RUN_STATE_LIFECYCLE_RULE.ID),
    RUN_STATE_LIFECYCLE_RULE,
  ]
  const existingRunStateRule = existingRules.find(rule => rule.ID === RUN_STATE_LIFECYCLE_RULE.ID)

  if (existingRunStateRule && isRunStateLifecycleRule(existingRunStateRule)) {
    log('S3 run-state lifecycle rule is already current')
  } else {
    try {
      await s3.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: bucket,
          LifecycleConfiguration: {Rules: desiredRules},
        }),
      )
    } catch (error) {
      throw redactLifecycleError(error, lifecycleSecrets)
    }
  }

  const readback = await getConfig()
  if (!readback?.Rules?.some(isRunStateLifecycleRule)) {
    throw new Error(
      'S3 run-state lifecycle rule readback failed: run-state-30d-expiration is missing or incorrect. ' +
        'Expected tag object-type=run-state, expiration Days=30, and Status=Enabled.',
    )
  }
  log('S3 run-state lifecycle rule verified')
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
  waitForSsh?: typeof waitForSsh
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
  const identity = privateKey && privateKey.trim().length > 0 ? materializeIdentityFile(privateKey) : undefined
  try {
    await resolvedWaitForSsh(dropletIp, REMOTE_USER, {identityFile: identity?.path})
  } finally {
    identity?.cleanup()
  }
}

// ---------------------------------------------------------------------------
// DO Cloud Firewall setup (exported for testability)
// ---------------------------------------------------------------------------

/**
 * Operator VPC state for the firewall setup gate.
 * Mirrors the all-or-none semantics used in deploy.ts getOperatorVpcState.
 */
export type FirewallVpcState = 'enabled' | 'disabled' | 'misconfigured'

/**
 * Returns the VPC state for the firewall setup gate.
 * - 'enabled':       both GATEWAY_VPC_IP and DASHBOARD_VPC_IP are set and non-empty.
 * - 'disabled':      both are absent (unset or whitespace-only).
 * - 'misconfigured': exactly one is set — all-or-none gate violated.
 */
export function getFirewallVpcState(env: Partial<Record<string, string>>): FirewallVpcState {
  const hasGateway = Boolean(env.GATEWAY_VPC_IP?.trim())
  const hasDashboard = Boolean(env.DASHBOARD_VPC_IP?.trim())
  if (hasGateway && hasDashboard) return 'enabled'
  if (!hasGateway && !hasDashboard) return 'disabled'
  return 'misconfigured'
}

/**
 * Checks whether a single inbound rule token contains BOTH the exact port field
 * (ports:9300, not ports:93000) AND the dashboard droplet-id in the same token.
 * Per-rule parse guards against cross-rule false positives.
 */
export function ruleHas9300FromDroplet(ruleToken: string, dashboardDropletId: string): boolean {
  return /(?:^|,)ports:9300(?:,|$)/.test(ruleToken) && ruleToken.includes(`droplet_id:${dashboardDropletId}`)
}

export interface SetupFirewallDeps {
  /** Injectable runCapture for testing. Defaults to the shared runCapture. */
  runCaptureFn?: (cmd: string[]) => Promise<string>
  /** Injectable run (fire-and-forget) for testing. Defaults to the shared run. */
  runFn?: (label: string, cmd: string[]) => Promise<void>
}

/**
 * Idempotently creates or updates the DO Cloud Firewall for the gateway operator port.
 *
 * Gate: only runs when both GATEWAY_VPC_IP and DASHBOARD_VPC_IP are set.
 * If neither is set, skips silently. If exactly one is set, warns and skips (misconfiguration).
 *
 * Firewall name: 'gateway-operator-fw'.
 *
 * If no firewall is attached to the gateway droplet:
 *   Creates a new firewall with base rules (22/80/443 inbound + 9300 from dashboard droplet-id)
 *   and default-allow outbound, then attaches it to the gateway droplet.
 *   CRITICAL: DO firewalls are default-deny. Creating without 22/80/443 inbound would lock out SSH.
 *
 * If a firewall is already attached:
 *   Checks whether the 9300-from-dashboard rule is present (per-rule parse).
 *   If missing, adds it additively (never removes/replaces existing rules).
 *   If already present, no-op.
 *
 * Dashboard droplet must be provisioned first. If not found, warns and skips (does not fail provision).
 */
export async function setupOperatorFirewall(
  gatewayDropletId: string,
  env: Partial<Record<string, string>>,
  deps: SetupFirewallDeps = {},
): Promise<void> {
  const vpcState = getFirewallVpcState(env)

  if (vpcState === 'disabled') {
    console.log('  (skipping DO Cloud Firewall setup — GATEWAY_VPC_IP and DASHBOARD_VPC_IP not set)')
    return
  }

  if (vpcState === 'misconfigured') {
    console.warn(
      '\u001B[1;33m[warn]\u001B[0m DO Cloud Firewall setup skipped: exactly one of GATEWAY_VPC_IP / DASHBOARD_VPC_IP is set. ' +
        'Set both or neither to enable the operator VPC bridge.',
    )
    return
  }

  console.log('\u001B[1;34m==>\u001B[0m Configuring DO Cloud Firewall for operator port (9300 from dashboard)')

  const capture = deps.runCaptureFn ?? runCapture
  const runCmd = deps.runFn ?? run

  // Resolve the dashboard droplet ID (stable across rebuild).
  let dashboardDropletId: string
  try {
    dashboardDropletId = await capture([
      'doctl',
      'compute',
      'droplet',
      'get',
      'dashboard',
      '--format',
      'ID',
      '--no-header',
    ])
  } catch {
    dashboardDropletId = ''
  }

  if (!dashboardDropletId) {
    console.warn(
      '\u001B[1;33m[warn]\u001B[0m DO Cloud Firewall setup skipped: dashboard droplet not found. ' +
        'Provision the dashboard droplet first, then re-run gateway provisioning.',
    )
    return
  }

  // Check whether a firewall is already attached to the gateway droplet.
  let existingFirewallId: string
  try {
    const listOutput = await capture([
      'doctl',
      'compute',
      'firewall',
      'list-by-droplet',
      gatewayDropletId,
      '--format',
      'ID',
      '--no-header',
    ])
    existingFirewallId = listOutput.split('\n')[0]?.trim() ?? ''
  } catch {
    existingFirewallId = ''
  }

  if (!existingFirewallId) {
    // No firewall attached — create one with base rules so the droplet is not locked out.
    // DO firewalls are default-deny: creating without 22/80/443 inbound would break the gateway.
    // Outbound: allow all tcp/udp/icmp so the gateway can reach Discord/S3/cliproxy.
    const inboundRules = [
      'protocol:tcp,ports:22,address:0.0.0.0/0',
      'protocol:tcp,ports:22,address:::/0',
      'protocol:tcp,ports:80,address:0.0.0.0/0',
      'protocol:tcp,ports:80,address:::/0',
      'protocol:tcp,ports:443,address:0.0.0.0/0',
      'protocol:tcp,ports:443,address:::/0',
      `protocol:tcp,ports:9300,droplet_id:${dashboardDropletId}`,
    ].join(' ')
    const outboundRules = [
      'protocol:tcp,ports:all,address:0.0.0.0/0',
      'protocol:tcp,ports:all,address:::/0',
      'protocol:udp,ports:all,address:0.0.0.0/0',
      'protocol:udp,ports:all,address:::/0',
      'protocol:icmp,address:0.0.0.0/0',
      'protocol:icmp,address:::/0',
    ].join(' ')

    await runCmd('Creating DO Cloud Firewall gateway-operator-fw with base rules + 9300 from dashboard', [
      'doctl',
      'compute',
      'firewall',
      'create',
      '--name',
      'gateway-operator-fw',
      '--inbound-rules',
      inboundRules,
      '--outbound-rules',
      outboundRules,
      '--droplet-ids',
      gatewayDropletId,
    ])

    console.log(
      `\u001B[1;32m✓\u001B[0m DO Cloud Firewall created with base rules (22/80/443) + tcp/9300 from dashboard droplet ${dashboardDropletId}`,
    )
    return
  }

  // Firewall exists — check whether the 9300-from-dashboard rule is already present.
  let inboundRulesRaw: string
  try {
    inboundRulesRaw = await capture([
      'doctl',
      'compute',
      'firewall',
      'get',
      existingFirewallId,
      '--format',
      'InboundRules',
      '--no-header',
    ])
  } catch {
    inboundRulesRaw = ''
  }

  // Per-rule parse: split on whitespace, check each token individually.
  // A rule token matches if it contains BOTH the exact port field AND the dashboard droplet-id.
  const ruleAlreadyPresent = inboundRulesRaw
    .trim()
    .split(/\s+/)
    .some(rule => ruleHas9300FromDroplet(rule, dashboardDropletId))

  if (ruleAlreadyPresent) {
    console.log(
      `\u001B[1;32m✓\u001B[0m DO Cloud Firewall rule already present: tcp/9300 from dashboard droplet ${dashboardDropletId} on firewall ${existingFirewallId} (no-op)`,
    )
    return
  }

  // Add the 9300 rule additively — never remove or replace existing rules.
  await runCmd('Adding DO Cloud Firewall inbound rule: tcp/9300 from dashboard droplet', [
    'doctl',
    'compute',
    'firewall',
    'add-rules',
    existingFirewallId,
    '--inbound-rules',
    `protocol:tcp,ports:9300,droplet_id:${dashboardDropletId}`,
  ])

  console.log(
    `\u001B[1;32m✓\u001B[0m DO Cloud Firewall rule added: tcp/9300 from dashboard droplet ${dashboardDropletId} on firewall ${existingFirewallId}`,
  )
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

  // Resolve the gateway droplet ID for the firewall setup step.
  const gatewayDropletId = await runCapture([
    'doctl',
    'compute',
    'droplet',
    'get',
    DROPLET_NAME,
    '--format',
    'ID',
    '--no-header',
  ])
  await setupOperatorFirewall(gatewayDropletId, process.env as Record<string, string>)

  await ensureRunStateLifecycleRule(process.env)

  printOperatorSetupMessage(dropletIp, gatewayHost)
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
