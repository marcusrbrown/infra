#!/usr/bin/env bun

import {
  AddClientIDToOpenIDConnectProviderCommand,
  CreateOpenIDConnectProviderCommand,
  CreateRoleCommand,
  DeleteRoleCommand,
  DeleteRolePolicyCommand,
  GetOpenIDConnectProviderCommand,
  GetRoleCommand,
  GetRolePolicyCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
  ListRolesCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
  UpdateAssumeRolePolicyCommand,
  UpdateRoleCommand,
} from '@aws-sdk/client-iam'
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
  ListObjectVersionsCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
  type LifecycleRule,
} from '@aws-sdk/client-s3'
import {assertKnownKeyLayout, buildAgentKeyLayout, type AgentKeyLayout} from '../src/key-layout'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_OIDC_PROVIDER_URL = 'https://token.actions.githubusercontent.com'
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'
const GITHUB_OIDC_PROVIDER_READBACK_HOST = 'token.actions.githubusercontent.com'
export const AGENT_AWS_ACCESS_KEY_ID = 'AGENT_AWS_ACCESS_KEY_ID'
export const AGENT_AWS_SECRET_ACCESS_KEY = 'AGENT_AWS_SECRET_ACCESS_KEY'
export const AGENT_AWS_SESSION_TOKEN = 'AGENT_AWS_SESSION_TOKEN'
export const AGENT_AWS_REGION = 'AGENT_AWS_REGION'
export const AGENT_S3_BUCKET = 'AGENT_S3_BUCKET'
export const AGENT_S3_EXPECTED_BUCKET_OWNER = 'AGENT_S3_EXPECTED_BUCKET_OWNER'
export const AGENT_S3_PREFIX = 'AGENT_S3_PREFIX'
export const AGENT_S3_SESSION_PREFIX = 'AGENT_S3_SESSION_PREFIX'
export const AGENT_S3_METADATA_ARTIFACTS_PREFIX = 'AGENT_S3_METADATA_ARTIFACTS_PREFIX'
export const AGENT_REPOSITORY_OWNER = 'AGENT_REPOSITORY_OWNER'
export const AGENT_REPOSITORY_NAME = 'AGENT_REPOSITORY_NAME'
export const AGENT_REPOSITORY_ID = 'AGENT_REPOSITORY_ID'
export const AGENT_REPOSITORY_OWNER_ID = 'AGENT_REPOSITORY_OWNER_ID'
export const AGENT_WORKFLOW_NAME = 'AGENT_WORKFLOW_NAME'
export const AGENT_ACTION_REF = 'AGENT_ACTION_REF'

export const AGENT_STORAGE_ENVIRONMENT = 'fro-bot-storage'
export const AGENT_ROLE_MANAGED_BY = 'fro-bot-agent-storage'
export const AGENT_ROLE_MAX_SESSION_DURATION = 7200

export const AGENT_LIFECYCLE_RULE_IDS = [
  'fro-bot-agent-session-90d',
  'fro-bot-agent-metadata-30d',
  'fro-bot-agent-noncurrent-30d',
  'fro-bot-agent-abort-mpu-7d',
] as const

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Narrow IAM client seam used by the provisioner and its boundary tests. */
export type IAMClientLike = Pick<IAMClient, 'send'>

/** Narrow S3 client seam used by the provisioner and its boundary tests. */
export type S3ClientLike = Pick<S3Client, 'send'>

export interface RedactionSecret {
  name: string
  content: string
}

export interface OidcProviderProvisionResult {
  classification: 'current' | 'absent'
  changed: boolean
  providerArn: string
}

export interface AgentBucketConfig {
  bucket: string
  region: string
  expectedBucketOwner: string
  s3Prefix: string
  sessionPrefix?: string
  metadataArtifactsPrefix?: string
}

export interface AgentBucketProvisionOptions {
  force?: boolean
  log?: (message: string) => void
  redactionSecrets?: RedactionSecret[]
}

export interface AgentBucketProvisionResult {
  classification: 'current' | 'absent'
  changed: boolean
  bucket: string
  bucketRegion: string
  expectedBucketOwner: string
  s3Prefix: string
  sessionPrefix: string
}

export interface AgentRepositoryConfig {
  owner: string
  repo: string
  repositoryId: string
  repositoryOwnerId: string
  workflow: string
}

export interface AgentRoleProvisionOptions {
  force?: boolean
  log?: (message: string) => void
  redactionSecrets?: RedactionSecret[]
}

export interface AgentRoleProvisionResult {
  classification: 'current' | 'absent' | 'managed-drift' | 'foreign-drift'
  changed: boolean
  roleName: string
  roleArn: string
}

export interface AgentStoragePolicyConfig {
  roleName: string
  bucket: string
  owner: string
  repo: string
  s3Prefix: string
  actionVersion: string
}

export interface AgentStoragePolicyProvisionOptions {
  force?: boolean
  log?: (message: string) => void
  redactionSecrets?: RedactionSecret[]
}

export interface AgentStoragePolicyProvisionResult {
  classification: 'current' | 'absent' | 'managed-drift'
  changed: boolean
  policyName: string
  keyLayoutVersion: string
  sessionPrefix: string
  lockKey: string
}

interface OidcProviderDetails {
  providerArn: string
  url: string
  clientIds: string[]
  thumbprints: string[]
}

export interface ProvisionDeps {
  /** Injected IAM client; omitted only by the real operator entrypoint. */
  client?: IAMClientLike
  /** Injected S3 client; omitted only by the real operator entrypoint. */
  s3Client?: S3ClientLike
  /** Explicit bucket configuration; otherwise read from AGENT_S3_* env vars. */
  bucket?: AgentBucketConfig
  /** Explicit consumer repository identity; otherwise read from AGENT_REPOSITORY_* env vars. */
  repository?: AgentRepositoryConfig
  /** Exact fro-bot/agent ref used by the consumer workflow. */
  actionRef?: string
  /** Apply managed drift instead of warning and halting. */
  force?: boolean
  /** Read current state and report intended changes without mutating AWS. */
  plan?: boolean
  /** Environment source used to construct the default IAM client. */
  env?: Partial<Record<string, string | undefined>>
  /** Replaces stdout in tests; defaults to console.log. */
  printLine?: (line: string) => void
  /** Credential values to redact from AWS error messages. */
  redactionSecrets?: RedactionSecret[]
}

export interface AgentTeardownDeps {
  /** Same handoff manifest emitted by provisioning. */
  manifest: AgentHandoffManifest
  /** Live repository identity used to validate the role trust boundary. */
  repository: AgentRepositoryConfig
  client?: IAMClientLike
  s3Client?: S3ClientLike
  purgeState?: boolean
  plan?: boolean
  env?: Partial<Record<string, string | undefined>>
  log?: (message: string) => void
  redactionSecrets?: RedactionSecret[]
}

export interface AgentTeardownResult {
  planned: boolean
  roleDeleted: boolean
  policyDeleted: boolean
  lockDeleted: boolean
  sessionObjectsPurged: boolean
  stateRetained: boolean
  statePurgeImpossible: boolean
  sharedResourcesPreserved: boolean
}

export interface AgentStorageAuditDeps {
  client?: IAMClientLike
  s3Client?: S3ClientLike
  bucket: AgentBucketConfig
  env?: Partial<Record<string, string | undefined>>
  now?: Date
  /** Defaults to two hours plus fifteen minutes of teardown grace. */
  staleLockThresholdMs?: number
  /** Return true when the repository still has the five S3 GitHub variables. */
  hasRepoVariables?: (repository: string) => Promise<boolean>
  redactionSecrets?: RedactionSecret[]
}

export interface AgentStorageAuditResult {
  candidateRoles: string[]
  strandedRoles: string[]
  staleLocks: string[]
  incompleteMultipartUploads: string[]
  orphanedNoncurrentVersions: string[]
}

/** Cross-artifact contract emitted by the AWS provisioner. */
export interface AgentHandoffManifest {
  owner: string
  repo: string
  repository_id: string
  repository_owner_id: string
  bucket: string
  bucket_region: string
  expected_bucket_owner: string
  s3_prefix: string
  session_prefix: string
  lock_key: string
  role_name: string
  role_arn: string
  policy_name: string
  action_ref_verified: boolean
  key_layout_version: string
  oidc_provider_arn: string
}

// ---------------------------------------------------------------------------
// Error and environment helpers
// ---------------------------------------------------------------------------

/** Redacts credential material before an AWS error is printed to operator logs. */
export function redactAwsError(error: unknown, secrets: RedactionSecret[] = []): Error {
  const base = error instanceof Error ? error.message : String(error)
  let sanitized = base

  for (const secret of secrets) {
    if (secret.content.length === 0) continue
    const escaped = secret.content.replaceAll(/[$()*+.?[\\\]^{|}]/g, String.raw`\$&`)
    sanitized = sanitized.replaceAll(new RegExp(escaped, 'g'), `<redacted:${secret.name}>`)
  }

  const redacted = new Error(sanitized)
  if (error instanceof Error) redacted.name = error.name
  return redacted
}

function errorCode(error: Error): string | undefined {
  if (!('code' in error)) return undefined
  const code = error.code
  return typeof code === 'string' ? code : undefined
}

/** Matches the IAM error used when another process wins the create race. */
export function isEntityAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = errorCode(error)
  const text = `${error.name} ${code ?? ''} ${error.message}`.toLowerCase()
  return (
    error.name === 'EntityAlreadyExists' ||
    code === 'EntityAlreadyExists' ||
    text.includes('entityalreadyexists') ||
    text.includes('entity already exists')
  )
}

/** Returns the dedicated operator credentials that must be present. */
export function validateRequiredEnv(env: Partial<Record<string, string | undefined>>): string[] {
  return [AGENT_AWS_ACCESS_KEY_ID, AGENT_AWS_SECRET_ACCESS_KEY].filter(key => !env[key]?.trim())
}

/**
 * Constructs an IAM client without allowing the AWS SDK to consult ambient
 * AWS_* credentials. The standard AWS_* names belong to other deploy paths.
 */
export function createIamClientFromEnv(env: Partial<Record<string, string | undefined>> = process.env): IAMClient {
  const missing = validateRequiredEnv(env)
  if (missing.length > 0) {
    throw new Error(
      `Missing dedicated operator AWS credentials: ${missing.join(', ')}. ` +
        `Set ${AGENT_AWS_ACCESS_KEY_ID} and ${AGENT_AWS_SECRET_ACCESS_KEY} in the operator-local root .env; ` +
        'ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are intentionally ignored.',
    )
  }

  const accessKeyId = env[AGENT_AWS_ACCESS_KEY_ID]
  const secretAccessKey = env[AGENT_AWS_SECRET_ACCESS_KEY]
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Dedicated operator AWS credentials are required to construct the IAM client.')
  }

  const sessionToken = env[AGENT_AWS_SESSION_TOKEN]?.trim()
  return new IAMClient({
    region: env[AGENT_AWS_REGION]?.trim() || 'us-east-1',
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? {sessionToken} : {}),
    },
  })
}

/** Constructs an S3 client using only the dedicated operator credentials. */
export function createS3ClientFromEnv(
  env: Partial<Record<string, string | undefined>> = process.env,
  region = env[AGENT_AWS_REGION]?.trim() || 'us-east-1',
): S3Client {
  const missing = validateRequiredEnv(env)
  if (missing.length > 0) {
    throw new Error(
      `Missing dedicated operator AWS credentials: ${missing.join(', ')}. ` +
        `Set ${AGENT_AWS_ACCESS_KEY_ID} and ${AGENT_AWS_SECRET_ACCESS_KEY} in the operator-local root .env; ` +
        'ambient AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY are intentionally ignored.',
    )
  }

  const accessKeyId = env[AGENT_AWS_ACCESS_KEY_ID]
  const secretAccessKey = env[AGENT_AWS_SECRET_ACCESS_KEY]
  if (!accessKeyId || !secretAccessKey) {
    throw new Error('Dedicated operator AWS credentials are required to construct the S3 client.')
  }

  const sessionToken = env[AGENT_AWS_SESSION_TOKEN]?.trim()
  return new S3Client({
    region,
    credentials: {
      accessKeyId,
      secretAccessKey,
      ...(sessionToken ? {sessionToken} : {}),
    },
  })
}

// ---------------------------------------------------------------------------
// S3 bucket configuration and canonical state
// ---------------------------------------------------------------------------

/** Normalizes an operator-provided S3 prefix to one trailing slash. */
export function canonicalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.trim()
  if (trimmed.length === 0) throw new Error('S3 prefixes must not be empty')
  if (trimmed.includes('*') || trimmed.includes('?')) {
    throw new Error('S3 prefixes must not contain wildcard characters')
  }

  const withoutLeadingOrTrailingSlashes = trimmed.replace(/^\/+/, '').replace(/\/+$/, '')
  if (withoutLeadingOrTrailingSlashes.length === 0) {
    throw new Error('S3 prefixes must contain a non-empty path segment')
  }

  const segments = withoutLeadingOrTrailingSlashes.split('/')
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error('S3 prefixes must contain non-empty, non-relative path segments')
  }

  return `${segments.join('/')}/`
}

function resolveBucketPrefixes(config: AgentBucketConfig): {
  s3Prefix: string
  sessionPrefix: string
  metadataArtifactsPrefix: string
} {
  const s3Prefix = canonicalizeS3Prefix(config.s3Prefix)
  const sessionPrefix = canonicalizeS3Prefix(config.sessionPrefix ?? `${s3Prefix}github`)
  const metadataArtifactsPrefix = canonicalizeS3Prefix(config.metadataArtifactsPrefix ?? `${s3Prefix}metadata`)
  return {s3Prefix, sessionPrefix, metadataArtifactsPrefix}
}

function isNamedError(error: unknown, names: readonly string[]): boolean {
  if (!(error instanceof Error)) return false
  const code = errorCode(error)
  return names.includes(error.name) || (code !== undefined && names.includes(code))
}

function isNotFoundError(error: unknown): boolean {
  if (isNamedError(error, ['NoSuchBucket', 'NotFound'])) return true
  if (error instanceof Error && '$metadata' in error) {
    const metadata = error.$metadata
    return (
      typeof metadata === 'object' &&
      metadata !== null &&
      'httpStatusCode' in metadata &&
      metadata.httpStatusCode === 404
    )
  }
  return false
}

function isMissingPublicAccessBlock(error: unknown): boolean {
  return isNamedError(error, ['NoSuchPublicAccessBlockConfiguration', 'NoSuchPublicAccessBlockConfigurationError'])
}

function isMissingEncryption(error: unknown): boolean {
  return isNamedError(error, ['ServerSideEncryptionConfigurationNotFoundError'])
}

function isMissingPolicy(error: unknown): boolean {
  return isNamedError(error, ['NoSuchBucketPolicy'])
}

function isMissingLifecycle(error: unknown): boolean {
  return isNamedError(error, ['NoSuchLifecycleConfiguration'])
}

function isBucketAlreadyOwnedByThisAccount(error: unknown): boolean {
  return isNamedError(error, ['BucketAlreadyOwnedByYou'])
}

function canonicalBucketRegion(region: string | undefined, requestedRegion: string): string {
  if (region === 'EU') return 'eu-west-1'
  return region?.trim() || requestedRegion
}

async function headAgentBucket(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<{exists: boolean; bucketRegion: string}> {
  try {
    const response = await client.send(
      new HeadBucketCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    const typedResponse = response as {BucketRegion?: string; BucketOwner?: string}
    if (typedResponse.BucketOwner && typedResponse.BucketOwner !== config.expectedBucketOwner) {
      throw new Error(
        `S3 bucket ${config.bucket} is owned by ${typedResponse.BucketOwner}, expected ${config.expectedBucketOwner}; refusing to reuse it`,
      )
    }

    const bucketRegion = canonicalBucketRegion(typedResponse.BucketRegion, config.region)
    if (bucketRegion !== config.region) {
      throw new Error(
        `S3 bucket ${config.bucket} is in region ${bucketRegion}, but region ${config.region} was requested; refusing to reuse a mislocated bucket`,
      )
    }
    return {exists: true, bucketRegion}
  } catch (error: unknown) {
    if (isNotFoundError(error)) return {exists: false, bucketRegion: config.region}
    throw redactAwsError(error, secrets)
  }
}

function buildTlsOnlyBucketPolicy(bucket: string): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucket}`, `arn:aws:s3:::${bucket}/*`],
        Condition: {Bool: {'aws:SecureTransport': 'false'}},
      },
    ],
  }
}

function normalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeJson)
  if (typeof value !== 'object' || value === null) return value
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, normalizeJson(entry)]),
  )
}

function parseBucketPolicy(policy: string): unknown {
  try {
    return JSON.parse(policy) as unknown
  } catch {
    try {
      return JSON.parse(decodeURIComponent(policy)) as unknown
    } catch {
      return undefined
    }
  }
}

function policiesEqual(actual: string | undefined, expected: Record<string, unknown>): boolean {
  if (!actual) return false
  return JSON.stringify(normalizeJson(parseBucketPolicy(actual))) === JSON.stringify(normalizeJson(expected))
}

function lifecycleRulePrefix(rule: LifecycleRule): string | undefined {
  const legacyRule = rule as LifecycleRule & {Prefix?: string}
  return rule.Filter?.Prefix ?? legacyRule.Prefix
}

function isGlobalLifecycleFilter(rule: LifecycleRule): boolean {
  const legacyRule = rule as LifecycleRule & {Prefix?: unknown}
  if (legacyRule.Prefix !== undefined) return false

  const filter = rule.Filter
  if (typeof filter !== 'object' || filter === null || Array.isArray(filter)) return false

  return Object.entries(filter)
    .filter(([, value]) => value !== undefined)
    .every(([key, value]) => key === 'Prefix' && value === '')
}

function isCanonicalAgentLifecycleRule(
  rule: LifecycleRule | undefined,
  prefixes: {sessionPrefix: string; metadataArtifactsPrefix: string},
): boolean {
  if (!rule || rule.Status !== 'Enabled') return false

  switch (rule.ID) {
    case AGENT_LIFECYCLE_RULE_IDS[0]:
      return (
        lifecycleRulePrefix(rule) === prefixes.sessionPrefix &&
        rule.Expiration?.Days === 90 &&
        rule.NoncurrentVersionExpiration === undefined &&
        rule.AbortIncompleteMultipartUpload === undefined
      )
    case AGENT_LIFECYCLE_RULE_IDS[1]:
      return (
        lifecycleRulePrefix(rule) === prefixes.metadataArtifactsPrefix &&
        rule.Expiration?.Days === 30 &&
        rule.NoncurrentVersionExpiration === undefined &&
        rule.AbortIncompleteMultipartUpload === undefined
      )
    case AGENT_LIFECYCLE_RULE_IDS[2]:
      return (
        isGlobalLifecycleFilter(rule) &&
        rule.Expiration === undefined &&
        rule.NoncurrentVersionExpiration?.NoncurrentDays === 30 &&
        rule.AbortIncompleteMultipartUpload === undefined
      )
    case AGENT_LIFECYCLE_RULE_IDS[3]:
      return (
        isGlobalLifecycleFilter(rule) &&
        rule.Expiration === undefined &&
        rule.NoncurrentVersionExpiration === undefined &&
        rule.AbortIncompleteMultipartUpload?.DaysAfterInitiation === 7
      )
    default:
      return false
  }
}

function buildAgentLifecycleRules(prefixes: {sessionPrefix: string; metadataArtifactsPrefix: string}): LifecycleRule[] {
  return [
    {
      ID: AGENT_LIFECYCLE_RULE_IDS[0],
      Filter: {Prefix: prefixes.sessionPrefix},
      Status: 'Enabled',
      Expiration: {Days: 90},
    },
    {
      ID: AGENT_LIFECYCLE_RULE_IDS[1],
      Filter: {Prefix: prefixes.metadataArtifactsPrefix},
      Status: 'Enabled',
      Expiration: {Days: 30},
    },
    {
      ID: AGENT_LIFECYCLE_RULE_IDS[2],
      Filter: {Prefix: ''},
      Status: 'Enabled',
      NoncurrentVersionExpiration: {NoncurrentDays: 30},
    },
    {
      ID: AGENT_LIFECYCLE_RULE_IDS[3],
      Filter: {Prefix: ''},
      Status: 'Enabled',
      AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7},
    },
  ]
}

function lifecycleRulesContainRule(rules: LifecycleRule[], expected: LifecycleRule): boolean {
  return rules.some(rule => JSON.stringify(normalizeJson(rule)) === JSON.stringify(normalizeJson(expected)))
}

async function readPublicAccessBlock(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<
  | {
      BlockPublicAcls?: boolean
      IgnorePublicAcls?: boolean
      BlockPublicPolicy?: boolean
      RestrictPublicBuckets?: boolean
    }
  | undefined
> {
  try {
    const response = await client.send(
      new GetPublicAccessBlockCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    return response.PublicAccessBlockConfiguration
  } catch (error: unknown) {
    if (isMissingPublicAccessBlock(error)) return undefined
    throw redactAwsError(error, secrets)
  }
}

async function readBucketVersioning(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<string | undefined> {
  try {
    const response = await client.send(
      new GetBucketVersioningCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    return response.Status
  } catch (error: unknown) {
    throw redactAwsError(error, secrets)
  }
}

async function readBucketEncryption(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<string[]> {
  try {
    const response = await client.send(
      new GetBucketEncryptionCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    const algorithms: unknown[] = (response.ServerSideEncryptionConfiguration?.Rules ?? []).map(
      rule => rule.ApplyServerSideEncryptionByDefault?.SSEAlgorithm,
    )
    return algorithms.filter((algorithm): algorithm is string => typeof algorithm === 'string')
  } catch (error: unknown) {
    if (isMissingEncryption(error)) return []
    throw redactAwsError(error, secrets)
  }
}

async function readBucketPolicy(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<string | undefined> {
  try {
    const response = await client.send(
      new GetBucketPolicyCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    return response.Policy
  } catch (error: unknown) {
    if (isMissingPolicy(error)) return undefined
    throw redactAwsError(error, secrets)
  }
}

async function readBucketLifecycle(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<LifecycleRule[]> {
  try {
    const response = await client.send(
      new GetBucketLifecycleConfigurationCommand({
        Bucket: config.bucket,
        ExpectedBucketOwner: config.expectedBucketOwner,
      }),
    )
    return response.Rules ?? []
  } catch (error: unknown) {
    if (isMissingLifecycle(error)) return []
    throw redactAwsError(error, secrets)
  }
}

function warnAndHalt(resource: string, message: string, options: AgentBucketProvisionOptions): never {
  const warning = `S3 bucket ${resource} managed drift detected: ${message}. Refusing to mutate; re-run with --force to apply the canonical state.`
  ;(options.log ?? (line => console.warn(line)))(warning)
  throw new Error(warning)
}

/**
 * Ensures the dedicated action-state bucket and its security controls.
 *
 * Owner and region are checked before any mutation. Managed controls converge
 * only from an absent state or with force; foreign/shared bucket ownership and
 * region mismatches always fail closed.
 */
export async function ensureAgentStateBucket(
  client: S3ClientLike,
  config: AgentBucketConfig,
  options: AgentBucketProvisionOptions = {},
): Promise<AgentBucketProvisionResult> {
  const secrets = options.redactionSecrets ?? []
  const prefixes = resolveBucketPrefixes(config)
  const existing = await headAgentBucket(client, config, secrets)
  let bucketRegion = existing.bucketRegion
  let changed = false

  if (!existing.exists) {
    try {
      await client.send(
        new CreateBucketCommand({
          Bucket: config.bucket,
          ...(config.region === 'us-east-1'
            ? {}
            : {
                CreateBucketConfiguration: {
                  LocationConstraint: config.region as BucketLocationConstraint,
                },
              }),
        }),
      )
      changed = true
    } catch (error: unknown) {
      if (!isBucketAlreadyOwnedByThisAccount(error)) throw redactAwsError(error, secrets)
    }

    const createdReadback = await headAgentBucket(client, config, secrets)
    if (!createdReadback.exists) {
      throw new Error(`S3 bucket ${config.bucket} was created but could not be verified by readback`)
    }
    bucketRegion = createdReadback.bucketRegion
  }

  const publicAccessBlock = await readPublicAccessBlock(client, config, secrets)
  const publicAccessBlockCurrent =
    publicAccessBlock?.BlockPublicAcls === true &&
    publicAccessBlock.IgnorePublicAcls === true &&
    publicAccessBlock.BlockPublicPolicy === true &&
    publicAccessBlock.RestrictPublicBuckets === true
  if (!publicAccessBlockCurrent) {
    if (publicAccessBlock !== undefined && !options.force) {
      warnAndHalt(config.bucket, 'public-access-block is not all true', options)
    }
    try {
      await client.send(
        new PutPublicAccessBlockCommand({
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      )
      changed = true
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    const publicAccessBlockReadback = await readPublicAccessBlock(client, config, secrets)
    if (
      publicAccessBlockReadback?.BlockPublicAcls !== true ||
      publicAccessBlockReadback.IgnorePublicAcls !== true ||
      publicAccessBlockReadback.BlockPublicPolicy !== true ||
      publicAccessBlockReadback.RestrictPublicBuckets !== true
    ) {
      throw new Error(`S3 bucket ${config.bucket} public-access-block readback failed`)
    }
  }

  const versioningStatus = await readBucketVersioning(client, config, secrets)
  if (versioningStatus !== 'Enabled') {
    if (versioningStatus !== undefined && !options.force) {
      warnAndHalt(config.bucket, `versioning status is ${versioningStatus}`, options)
    }
    try {
      await client.send(
        new PutBucketVersioningCommand({
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          VersioningConfiguration: {Status: 'Enabled'},
        }),
      )
      changed = true
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    if ((await readBucketVersioning(client, config, secrets)) !== 'Enabled') {
      throw new Error(`S3 bucket ${config.bucket} versioning readback failed`)
    }
  }

  const encryptionAlgorithms = await readBucketEncryption(client, config, secrets)
  const encryptionCurrent = encryptionAlgorithms.length === 1 && encryptionAlgorithms[0] === 'AES256'
  if (!encryptionCurrent) {
    if (encryptionAlgorithms.length > 0 && !options.force) {
      warnAndHalt(
        config.bucket,
        `default encryption is ${encryptionAlgorithms.join(', ')}, expected only AES256`,
        options,
      )
    }
    try {
      await client.send(
        new PutBucketEncryptionCommand({
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          ServerSideEncryptionConfiguration: {
            Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}}],
          },
        }),
      )
      changed = true
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    const encryptionReadback = await readBucketEncryption(client, config, secrets)
    if (encryptionReadback.length !== 1 || encryptionReadback[0] !== 'AES256') {
      throw new Error(`S3 bucket ${config.bucket} SSE-S3 readback failed: expected AES256`)
    }
  }

  const expectedPolicy = buildTlsOnlyBucketPolicy(config.bucket)
  const currentPolicy = await readBucketPolicy(client, config, secrets)
  if (!policiesEqual(currentPolicy, expectedPolicy)) {
    if (currentPolicy !== undefined && !options.force) {
      warnAndHalt(config.bucket, 'bucket policy is not the canonical TLS-only deny policy', options)
    }
    try {
      await client.send(
        new PutBucketPolicyCommand({
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          Policy: JSON.stringify(expectedPolicy),
        }),
      )
      changed = true
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    const policyReadback = await readBucketPolicy(client, config, secrets)
    if (!policiesEqual(policyReadback, expectedPolicy)) {
      throw new Error(`S3 bucket ${config.bucket} TLS-only policy readback failed`)
    }
  }

  const desiredLifecycleRules = buildAgentLifecycleRules(prefixes)
  const existingLifecycleRules = await readBucketLifecycle(client, config, secrets)
  const ownedLifecycleRules = existingLifecycleRules.filter(rule =>
    AGENT_LIFECYCLE_RULE_IDS.includes(rule.ID as (typeof AGENT_LIFECYCLE_RULE_IDS)[number]),
  )
  const lifecycleNeedsMutation = desiredLifecycleRules.some(
    desired =>
      ownedLifecycleRules.filter(rule => rule.ID === desired.ID).length !== 1 ||
      !isCanonicalAgentLifecycleRule(
        ownedLifecycleRules.find(rule => rule.ID === desired.ID),
        prefixes,
      ),
  )

  if (lifecycleNeedsMutation) {
    const hasManagedLifecycleDrift = ownedLifecycleRules.some(rule => {
      const canonical = desiredLifecycleRules.find(desired => desired.ID === rule.ID)
      return canonical !== undefined && !isCanonicalAgentLifecycleRule(rule, prefixes)
    })
    if (hasManagedLifecycleDrift && !options.force) {
      warnAndHalt(config.bucket, 'one or more owned lifecycle rules are not canonical', options)
    }

    const desiredWithForeignRules = [
      ...existingLifecycleRules.filter(
        rule => !AGENT_LIFECYCLE_RULE_IDS.includes(rule.ID as (typeof AGENT_LIFECYCLE_RULE_IDS)[number]),
      ),
      ...desiredLifecycleRules,
    ]
    try {
      await client.send(
        new PutBucketLifecycleConfigurationCommand({
          Bucket: config.bucket,
          ExpectedBucketOwner: config.expectedBucketOwner,
          LifecycleConfiguration: {Rules: desiredWithForeignRules},
        }),
      )
      changed = true
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
  }

  const lifecycleReadback = await readBucketLifecycle(client, config, secrets)
  for (const desiredRule of desiredLifecycleRules) {
    const readbackRule = lifecycleReadback.find(rule => rule.ID === desiredRule.ID)
    if (!isCanonicalAgentLifecycleRule(readbackRule, prefixes)) {
      throw new Error(`S3 bucket ${config.bucket} lifecycle readback failed for ${desiredRule.ID}`)
    }
  }
  for (const foreignRule of existingLifecycleRules.filter(
    rule => !AGENT_LIFECYCLE_RULE_IDS.includes(rule.ID as (typeof AGENT_LIFECYCLE_RULE_IDS)[number]),
  )) {
    if (!lifecycleRulesContainRule(lifecycleReadback, foreignRule)) {
      throw new Error(`S3 bucket ${config.bucket} lifecycle readback dropped an unowned rule`)
    }
  }

  return {
    classification: existing.exists ? 'current' : 'absent',
    changed,
    bucket: config.bucket,
    bucketRegion,
    expectedBucketOwner: config.expectedBucketOwner,
    s3Prefix: prefixes.s3Prefix,
    sessionPrefix: prefixes.sessionPrefix,
  }
}

// ---------------------------------------------------------------------------
// Handoff manifest scaffolding
// ---------------------------------------------------------------------------

/** Creates the Unit 1 manifest scaffold; later units replace placeholders. */
export function createHandoffManifest(oidcProviderArn: string): AgentHandoffManifest {
  return {
    owner: '',
    repo: '',
    repository_id: '',
    repository_owner_id: '',
    bucket: '',
    bucket_region: '',
    expected_bucket_owner: '',
    s3_prefix: '',
    session_prefix: '',
    lock_key: '',
    role_name: '',
    role_arn: '',
    policy_name: '',
    action_ref_verified: false,
    key_layout_version: '',
    oidc_provider_arn: oidcProviderArn,
  }
}

/** Emits one compact JSON handoff manifest line to stdout. */
export function printManifest(
  manifest: AgentHandoffManifest,
  printLine: (line: string) => void = line => console.log(line),
): void {
  printLine(JSON.stringify(manifest))
}

// ---------------------------------------------------------------------------
// OIDC provider discovery and convergence
// ---------------------------------------------------------------------------

function canonicalizeGitHubOidcProviderReadbackUrl(url: string): string {
  if (url === GITHUB_OIDC_PROVIDER_URL || url === GITHUB_OIDC_PROVIDER_READBACK_HOST) {
    return GITHUB_OIDC_PROVIDER_URL
  }
  return url
}

async function readOidcProvider(
  client: IAMClientLike,
  providerArn: string,
  secrets: RedactionSecret[],
): Promise<OidcProviderDetails> {
  try {
    const response = await client.send(new GetOpenIDConnectProviderCommand({OpenIDConnectProviderArn: providerArn}))

    if (!response.Url) {
      throw new Error(`IAM OIDC provider ${providerArn} readback did not include a URL`)
    }

    return {
      providerArn,
      url: canonicalizeGitHubOidcProviderReadbackUrl(response.Url),
      clientIds: response.ClientIDList ?? [],
      thumbprints: response.ThumbprintList ?? [],
    }
  } catch (error: unknown) {
    throw redactAwsError(error, secrets)
  }
}

async function discoverCanonicalProvider(
  client: IAMClientLike,
  secrets: RedactionSecret[],
): Promise<OidcProviderDetails | undefined> {
  let providerArns: string[]
  try {
    const response = await client.send(new ListOpenIDConnectProvidersCommand({}))
    providerArns = (response.OpenIDConnectProviderList ?? []).map(provider => {
      if (!provider.Arn) {
        throw new Error('IAM returned an OpenID Connect provider without an ARN; refusing to continue')
      }
      return provider.Arn
    })
  } catch (error: unknown) {
    throw redactAwsError(error, secrets)
  }

  const providers = await Promise.all(providerArns.map(providerArn => readOidcProvider(client, providerArn, secrets)))
  const canonical = providers.filter(provider => provider.url === GITHUB_OIDC_PROVIDER_URL)
  const canonicalArnPath = '/token.actions.githubusercontent.com'
  const driftedCanonicalArns = providers.filter(
    provider => provider.providerArn.endsWith(canonicalArnPath) && provider.url !== GITHUB_OIDC_PROVIDER_URL,
  )

  if (driftedCanonicalArns.length > 0) {
    throw new Error(
      `IAM OIDC provider ${driftedCanonicalArns[0]?.providerArn ?? 'unknown'} URL drifted; refusing to recreate a shared provider`,
    )
  }

  if (canonical.length > 1) {
    throw new Error(
      `Found multiple GitHub OIDC providers for ${GITHUB_OIDC_PROVIDER_URL}; refusing to choose between shared resources`,
    )
  }

  return canonical[0]
}

// Exact set membership over the OIDC client-ID list. Using Set.has (not
// Array.includes) keeps the audience match an exact-equality check that CodeQL
// does not misread as URL substring sanitization on the host-shaped constant.
function hasAudience(clientIds: string[], audience: string): boolean {
  return new Set(clientIds).has(audience)
}

function assertCanonicalUrl(provider: OidcProviderDetails): void {
  if (provider.url !== GITHUB_OIDC_PROVIDER_URL) {
    throw new Error(
      `IAM OIDC provider ${provider.providerArn} URL drifted to ${provider.url}; expected ${GITHUB_OIDC_PROVIDER_URL}`,
    )
  }
}

function assertCanonicalProvider(provider: OidcProviderDetails): void {
  assertCanonicalUrl(provider)
  if (!hasAudience(provider.clientIds, GITHUB_OIDC_AUDIENCE)) {
    throw new Error(
      `IAM OIDC provider ${provider.providerArn} readback is missing the ${GITHUB_OIDC_AUDIENCE} audience`,
    )
  }
}

async function convergeExistingProvider(
  client: IAMClientLike,
  provider: OidcProviderDetails,
  secrets: RedactionSecret[],
): Promise<OidcProviderProvisionResult> {
  // Discovery already selected the canonical URL. Keeping this explicit makes
  // the read/compare boundary visible and prevents future normalization.
  assertCanonicalUrl(provider)

  let changed = false
  if (!hasAudience(provider.clientIds, GITHUB_OIDC_AUDIENCE)) {
    try {
      await client.send(
        new AddClientIDToOpenIDConnectProviderCommand({
          OpenIDConnectProviderArn: provider.providerArn,
          ClientID: GITHUB_OIDC_AUDIENCE,
        }),
      )
      changed = true
    } catch (error: unknown) {
      if (!isEntityAlreadyExistsError(error)) throw redactAwsError(error, secrets)
    }
  }

  const readback = await readOidcProvider(client, provider.providerArn, secrets)
  assertCanonicalProvider(readback)

  return {
    classification: 'current',
    changed,
    providerArn: provider.providerArn,
  }
}

/**
 * Ensures the shared GitHub OIDC provider exists without destructive changes.
 * Thumbprints and existing audiences are read-only; the sole mutation is an
 * append-only sts.amazonaws.com audience addition.
 */
export async function ensureGitHubOidcProvider(
  client: IAMClientLike,
  secrets: RedactionSecret[] = [],
): Promise<OidcProviderProvisionResult> {
  const existing = await discoverCanonicalProvider(client, secrets)
  if (existing) return convergeExistingProvider(client, existing, secrets)

  let providerArn: string | undefined
  try {
    const response = await client.send(
      new CreateOpenIDConnectProviderCommand({
        Url: GITHUB_OIDC_PROVIDER_URL,
        ClientIDList: [GITHUB_OIDC_AUDIENCE],
      }),
    )
    providerArn = response.OpenIDConnectProviderArn
    if (!providerArn) {
      throw new Error('IAM did not return an ARN after creating the GitHub OIDC provider')
    }
  } catch (error: unknown) {
    if (!isEntityAlreadyExistsError(error)) throw redactAwsError(error, secrets)

    // A concurrent operator may have created the provider after discovery. Do
    // not guess an ARN from the error: re-list and require the same canonical,
    // unambiguous shared-resource contract.
    const raced = await discoverCanonicalProvider(client, secrets)
    if (!raced) {
      throw new Error(
        `IAM reported an existing GitHub OIDC provider, but no canonical provider was returned by readback`,
      )
    }
    return convergeExistingProvider(client, raced, secrets)
  }

  const readback = await readOidcProvider(client, providerArn, secrets)
  assertCanonicalProvider(readback)

  return {
    classification: 'absent',
    changed: true,
    providerArn,
  }
}

// ---------------------------------------------------------------------------
// Per-repository role and trust-policy convergence
// ---------------------------------------------------------------------------

const IAM_ROLE_NAME_MAX_LENGTH = 64
const IAM_ROLE_READBACK_MAX_ATTEMPTS = 5
const IAM_ROLE_READBACK_DELAY_MS = 25

interface RoleTagReadback {
  Key?: string
  Value?: string
}

interface IamRoleReadback {
  Arn?: string
  RoleName?: string
  AssumeRolePolicyDocument?: string | Record<string, unknown>
  MaxSessionDuration?: number
  Tags?: RoleTagReadback[]
}

interface RoleState {
  foreignDrift: string[]
  managedDrift: string[]
}

function validateRepositoryConfig(repository: AgentRepositoryConfig): void {
  const githubSegment = /^[A-Z0-9](?:[\w.-]*[A-Z0-9])?$/i
  for (const [label, value] of [
    ['owner', repository.owner],
    ['repo', repository.repo],
  ] as const) {
    if (!githubSegment.test(value)) {
      throw new Error(`Agent repository ${label} must be a single GitHub path segment without wildcard characters`)
    }
  }

  for (const [label, value] of [
    ['repository_id', repository.repositoryId],
    ['repository_owner_id', repository.repositoryOwnerId],
  ] as const) {
    if (!/^\d+$/.test(value)) {
      throw new Error(`Agent repository ${label} must contain only decimal digits`)
    }
  }

  if (
    repository.workflow.trim().length === 0 ||
    repository.workflow.includes('*') ||
    repository.workflow.includes('?')
  ) {
    throw new Error('Agent workflow name must be non-empty and must not contain wildcard characters')
  }
}

function sanitizeIamRoleSegment(value: string): string {
  return value.replaceAll(/[^\w+=,.@-]/g, '-')
}

function stableRoleNameDigest(value: string): string {
  let first = 2166136261
  let second = 2654435769
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0
    first = Math.imul(first ^ codePoint, 16777619)
    second = Math.imul(second ^ codePoint, 2246822519)
  }
  return `${(first >>> 0).toString(16).padStart(8, '0')}${(second >>> 0).toString(16).padStart(8, '0')}`.slice(0, 12)
}

/** Builds a stable IAM-safe role name, hashing only when GitHub names exceed IAM's limit. */
export function buildAgentRoleName(owner: string, repo: string): string {
  const ownerSegment = sanitizeIamRoleSegment(owner)
  const repoSegment = sanitizeIamRoleSegment(repo)
  if (ownerSegment.length === 0 || repoSegment.length === 0) {
    throw new Error('Agent role names require non-empty owner and repository segments')
  }

  const base = `fro-bot-agent-storage-${ownerSegment}-${repoSegment}`
  if (base.length <= IAM_ROLE_NAME_MAX_LENGTH) return base

  const digest = stableRoleNameDigest(`${owner}/${repo}`)
  return `${base.slice(0, IAM_ROLE_NAME_MAX_LENGTH - digest.length - 1)}-${digest}`
}

/**
 * Builds the only supported GitHub OIDC subjects for a storage role.
 * The array is intentionally exact: no wildcard subject is ever constructed.
 */
export function buildGitHubOidcTrustPolicy(
  repository: AgentRepositoryConfig,
  oidcProviderArn: string,
): Record<string, unknown> {
  validateRepositoryConfig(repository)
  if (oidcProviderArn.trim().length === 0) throw new Error('GitHub OIDC provider ARN is required')

  const legacySubject = `repo:${repository.owner}/${repository.repo}:environment:${AGENT_STORAGE_ENVIRONMENT}`
  const immutableSubject = `repo:${repository.owner}@${repository.repositoryOwnerId}/${repository.repo}@${repository.repositoryId}:environment:${AGENT_STORAGE_ENVIRONMENT}`
  const subjects = [legacySubject, immutableSubject]

  if (subjects.some(subject => subject.includes('*') || subject.includes('?'))) {
    throw new Error('Agent trust policy subjects must never contain wildcard characters')
  }

  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {Federated: oidcProviderArn},
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': GITHUB_OIDC_AUDIENCE,
            'token.actions.githubusercontent.com:sub': subjects,
            'token.actions.githubusercontent.com:repository_id': repository.repositoryId,
            'token.actions.githubusercontent.com:repository_owner_id': repository.repositoryOwnerId,
            'token.actions.githubusercontent.com:ref': 'refs/heads/main',
            // Defense-in-depth tripwire. The environment subject and numeric
            // repository/ref pins remain the load-bearing trust boundary.
            'token.actions.githubusercontent.com:workflow': repository.workflow,
          },
        },
      },
    ],
  }
}

function roleTags(repository: AgentRepositoryConfig): {Key: string; Value: string}[] {
  return [
    {Key: 'owner', Value: repository.owner},
    {Key: 'repo', Value: repository.repo},
    {Key: 'repository_id', Value: repository.repositoryId},
    {Key: 'repository_owner_id', Value: repository.repositoryOwnerId},
    {Key: 'managed-by', Value: AGENT_ROLE_MANAGED_BY},
  ]
}

function parseJsonDocument(document: unknown): unknown {
  if (typeof document !== 'string') return document
  try {
    return JSON.parse(document) as unknown
  } catch {
    try {
      return JSON.parse(decodeURIComponent(document)) as unknown
    } catch {
      return undefined
    }
  }
}

function jsonDocumentsEqual(actual: unknown, expected: Record<string, unknown>): boolean {
  return JSON.stringify(normalizeJson(parseJsonDocument(actual))) === JSON.stringify(normalizeJson(expected))
}

function tagsToMap(tags: RoleTagReadback[] | undefined): Map<string, string> {
  const result = new Map<string, string>()
  for (const tag of tags ?? []) {
    if (typeof tag.Key === 'string' && typeof tag.Value === 'string') result.set(tag.Key, tag.Value)
  }
  return result
}

function classifyRoleState(
  role: IamRoleReadback,
  roleName: string,
  repository: AgentRepositoryConfig,
  expectedTrustPolicy: Record<string, unknown>,
): RoleState {
  const foreignDrift: string[] = []
  const managedDrift: string[] = []

  if (role.RoleName !== undefined && role.RoleName !== roleName) foreignDrift.push('role name')

  const tags = tagsToMap(role.Tags)
  if (tags.get('managed-by') !== AGENT_ROLE_MANAGED_BY) {
    foreignDrift.push('managed-by tag')
  }

  for (const [key, expected] of [
    ['owner', repository.owner],
    ['repo', repository.repo],
    ['repository_id', repository.repositoryId],
    ['repository_owner_id', repository.repositoryOwnerId],
  ] as const) {
    const actual = tags.get(key)
    if (actual === undefined) managedDrift.push(`${key} tag`)
    else if (actual !== expected) foreignDrift.push(`${key} tag`)
  }

  if (!jsonDocumentsEqual(role.AssumeRolePolicyDocument, expectedTrustPolicy)) {
    managedDrift.push('trust policy')
  }
  if ((role.MaxSessionDuration ?? 0) < AGENT_ROLE_MAX_SESSION_DURATION) {
    managedDrift.push('max session duration')
  }

  return {foreignDrift, managedDrift}
}

function roleIsCanonical(
  role: IamRoleReadback,
  roleName: string,
  repository: AgentRepositoryConfig,
  expectedTrustPolicy: Record<string, unknown>,
): boolean {
  const state = classifyRoleState(role, roleName, repository, expectedTrustPolicy)
  return state.foreignDrift.length === 0 && state.managedDrift.length === 0
}

function roleArn(role: IamRoleReadback, roleName: string): string {
  if (!role.Arn) throw new Error(`IAM role ${roleName} readback did not include an ARN`)
  return role.Arn
}

async function readAgentRole(
  client: IAMClientLike,
  roleName: string,
  secrets: RedactionSecret[],
): Promise<IamRoleReadback | undefined> {
  try {
    const response = await client.send(new GetRoleCommand({RoleName: roleName}))
    const role = response.Role as IamRoleReadback | undefined
    if (!role) throw new Error(`IAM role ${roleName} readback did not include a role`)
    return role
  } catch (error: unknown) {
    if (isNamedError(error, ['NoSuchEntity', 'NoSuchEntityException'])) return undefined
    throw redactAwsError(error, secrets)
  }
}

async function readAgentRoleAfterMutation(
  client: IAMClientLike,
  roleName: string,
  secrets: RedactionSecret[],
  matches?: (role: IamRoleReadback) => boolean,
): Promise<IamRoleReadback> {
  let lastRole: IamRoleReadback | undefined
  for (let attempt = 0; attempt < IAM_ROLE_READBACK_MAX_ATTEMPTS; attempt += 1) {
    lastRole = await readAgentRole(client, roleName, secrets)
    if (lastRole !== undefined && (matches === undefined || matches(lastRole))) return lastRole
    if (attempt + 1 < IAM_ROLE_READBACK_MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, IAM_ROLE_READBACK_DELAY_MS))
    }
  }

  throw new Error(
    `IAM role ${roleName} readback did not converge after ${IAM_ROLE_READBACK_MAX_ATTEMPTS} attempts${
      lastRole === undefined ? '' : ' to the requested state'
    }`,
  )
}

function warnAndHaltRole(roleName: string, message: string, options: AgentRoleProvisionOptions): never {
  const warning = `IAM role ${roleName} managed drift detected: ${message}. Refusing to mutate; re-run with --force to apply the canonical state.`
  ;(options.log ?? (line => console.warn(line)))(warning)
  throw new Error(warning)
}

function haltForeignRole(roleName: string, message: string, options: AgentRoleProvisionOptions): never {
  const warning = `IAM role ${roleName} foreign/shared drift detected: ${message}. Refusing to mutate, including with --force.`
  ;(options.log ?? (line => console.warn(line)))(warning)
  throw new Error(warning)
}

async function convergeExistingAgentRole(
  client: IAMClientLike,
  role: IamRoleReadback,
  roleName: string,
  repository: AgentRepositoryConfig,
  expectedTrustPolicy: Record<string, unknown>,
  desiredTags: {Key: string; Value: string}[],
  options: AgentRoleProvisionOptions,
): Promise<AgentRoleProvisionResult> {
  const secrets = options.redactionSecrets ?? []
  const state = classifyRoleState(role, roleName, repository, expectedTrustPolicy)
  if (state.foreignDrift.length > 0) haltForeignRole(roleName, state.foreignDrift.join(', '), options)
  if (state.managedDrift.length === 0) {
    return {
      classification: 'current',
      changed: false,
      roleName,
      roleArn: roleArn(role, roleName),
    }
  }
  if (!options.force) warnAndHaltRole(roleName, state.managedDrift.join(', '), options)

  let changed = false
  let current = role
  if (state.managedDrift.includes('trust policy')) {
    try {
      await client.send(
        new UpdateAssumeRolePolicyCommand({
          RoleName: roleName,
          PolicyDocument: JSON.stringify(expectedTrustPolicy),
        }),
      )
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    current = await readAgentRoleAfterMutation(client, roleName, secrets, candidate =>
      jsonDocumentsEqual(candidate.AssumeRolePolicyDocument, expectedTrustPolicy),
    )
    changed = true
  }

  if (state.managedDrift.includes('max session duration')) {
    try {
      await client.send(
        new UpdateRoleCommand({
          RoleName: roleName,
          MaxSessionDuration: AGENT_ROLE_MAX_SESSION_DURATION,
        }),
      )
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    current = await readAgentRoleAfterMutation(
      client,
      roleName,
      secrets,
      candidate => (candidate.MaxSessionDuration ?? 0) >= AGENT_ROLE_MAX_SESSION_DURATION,
    )
    changed = true
  }

  if (state.managedDrift.some(drift => drift.endsWith('tag'))) {
    try {
      await client.send(new TagRoleCommand({RoleName: roleName, Tags: desiredTags}))
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    current = await readAgentRoleAfterMutation(client, roleName, secrets, candidate =>
      roleIsCanonical(candidate, roleName, repository, expectedTrustPolicy),
    )
    changed = true
  }

  if (!roleIsCanonical(current, roleName, repository, expectedTrustPolicy)) {
    throw new Error(`IAM role ${roleName} readback failed to match the canonical trust and tag state`)
  }

  return {
    classification: 'managed-drift',
    changed,
    roleName,
    roleArn: roleArn(current, roleName),
  }
}

/** Ensures one repo-scoped IAM role with a pinned GitHub OIDC trust policy. */
export async function ensureAgentStorageRole(
  client: IAMClientLike,
  repository: AgentRepositoryConfig,
  oidcProviderArn: string,
  options: AgentRoleProvisionOptions = {},
): Promise<AgentRoleProvisionResult> {
  validateRepositoryConfig(repository)
  const roleName = buildAgentRoleName(repository.owner, repository.repo)
  const expectedTrustPolicy = buildGitHubOidcTrustPolicy(repository, oidcProviderArn)
  const desiredTags = roleTags(repository)
  const secrets = options.redactionSecrets ?? []
  const existing = await readAgentRole(client, roleName, secrets)

  if (existing !== undefined) {
    return convergeExistingAgentRole(client, existing, roleName, repository, expectedTrustPolicy, desiredTags, options)
  }

  try {
    await client.send(
      new CreateRoleCommand({
        RoleName: roleName,
        AssumeRolePolicyDocument: JSON.stringify(expectedTrustPolicy),
        MaxSessionDuration: AGENT_ROLE_MAX_SESSION_DURATION,
        Tags: desiredTags,
      }),
    )
  } catch (error: unknown) {
    if (!isEntityAlreadyExistsError(error)) throw redactAwsError(error, secrets)
    const raced = await readAgentRoleAfterMutation(client, roleName, secrets)
    return convergeExistingAgentRole(client, raced, roleName, repository, expectedTrustPolicy, desiredTags, options)
  }

  const created = await readAgentRoleAfterMutation(client, roleName, secrets, candidate =>
    roleIsCanonical(candidate, roleName, repository, expectedTrustPolicy),
  )
  return {
    classification: 'absent',
    changed: true,
    roleName,
    roleArn: roleArn(created, roleName),
  }
}

interface BuiltAgentStoragePolicy {
  policyName: string
  keyLayoutVersion: string
  layout: AgentKeyLayout
  document: Record<string, unknown>
}

/**
 * Builds the exact S3 action set used by fro-bot/agent's pinned adapter.
 *
 * Required: ListBucket (only for the session and lock prefixes), GetObject and
 * PutObject (session + lock), and DeleteObject (the exact coordination lock).
 * HeadObject rides on GetObject in the pinned adapter. GetObjectAttributes,
 * GetObjectVersion, GetObjectVersionAttributes, ListBucketVersions, and
 * GetBucketLocation are not used by the pinned adapter and are explicitly
 * denied. DeleteObjectVersion is never allowed and is explicitly denied on the
 * session prefix.
 */
export function buildAgentStoragePolicy(config: AgentStoragePolicyConfig): BuiltAgentStoragePolicy {
  const keyLayoutVersion = assertKnownKeyLayout(config.actionVersion)
  const layout = buildAgentKeyLayout(config.owner, config.repo, config.s3Prefix, keyLayoutVersion)
  const bucketArn = `arn:aws:s3:::${config.bucket}`
  const sessionObjectArn = `${bucketArn}/${layout.sessionPrefix}*`
  const lockObjectArn = `${bucketArn}/${layout.lockKey}`

  return {
    policyName: config.roleName,
    keyLayoutVersion,
    layout,
    document: {
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'AllowListRepoPrefixes',
          Effect: 'Allow',
          Action: ['s3:ListBucket'],
          Resource: [bucketArn],
          Condition: {
            StringLike: {
              's3:prefix': layout.listBucketPrefixes.map(prefix => `${prefix}*`),
            },
          },
        },
        {
          Sid: 'AllowSessionObjects',
          Effect: 'Allow',
          Action: ['s3:GetObject', 's3:PutObject'],
          Resource: [sessionObjectArn],
        },
        {
          Sid: 'AllowCoordinationLock',
          Effect: 'Allow',
          Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
          Resource: [lockObjectArn],
        },
        {
          Sid: 'DenySessionDeletes',
          Effect: 'Deny',
          Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
          Resource: [sessionObjectArn],
        },
        {
          Sid: 'DenyUnsupportedS3Actions',
          Effect: 'Deny',
          Action: [
            's3:GetBucketLocation',
            's3:GetObjectAttributes',
            's3:GetObjectVersion',
            's3:GetObjectVersionAttributes',
            's3:ListBucketVersions',
          ],
          Resource: [bucketArn, `${bucketArn}/*`],
        },
      ],
    },
  }
}

async function readAgentStoragePolicy(
  client: IAMClientLike,
  roleName: string,
  policyName: string,
  secrets: RedactionSecret[],
): Promise<unknown | undefined> {
  try {
    const response = await client.send(new GetRolePolicyCommand({RoleName: roleName, PolicyName: policyName}))
    if (response.PolicyDocument === undefined) {
      throw new Error(`IAM role ${roleName} inline policy ${policyName} readback did not include a policy document`)
    }
    return response.PolicyDocument
  } catch (error: unknown) {
    if (isNamedError(error, ['NoSuchEntity', 'NoSuchEntityException'])) return undefined
    throw redactAwsError(error, secrets)
  }
}

async function readAgentStoragePolicyAfterMutation(
  client: IAMClientLike,
  roleName: string,
  policyName: string,
  expectedPolicy: Record<string, unknown>,
  secrets: RedactionSecret[],
): Promise<void> {
  let lastPolicy: unknown
  for (let attempt = 0; attempt < IAM_ROLE_READBACK_MAX_ATTEMPTS; attempt += 1) {
    lastPolicy = await readAgentStoragePolicy(client, roleName, policyName, secrets)
    if (lastPolicy !== undefined && jsonDocumentsEqual(lastPolicy, expectedPolicy)) return
    if (attempt + 1 < IAM_ROLE_READBACK_MAX_ATTEMPTS) {
      await new Promise(resolve => setTimeout(resolve, IAM_ROLE_READBACK_DELAY_MS))
    }
  }
  throw new Error(
    `IAM role ${roleName} inline policy ${policyName} readback did not converge after ${IAM_ROLE_READBACK_MAX_ATTEMPTS} attempts`,
  )
}

function warnAndHaltStoragePolicy(
  roleName: string,
  policyName: string,
  message: string,
  options: AgentStoragePolicyProvisionOptions,
): never {
  const warning =
    `IAM role ${roleName} inline policy ${policyName} managed drift detected: ${message}. ` +
    'Refusing to mutate; re-run with --force to apply the canonical state.'
  ;(options.log ?? (line => console.warn(line)))(warning)
  throw new Error(warning)
}

/** Ensures the repo-scoped inline storage policy without widening its boundaries. */
export async function ensureAgentStoragePolicy(
  client: IAMClientLike,
  config: AgentStoragePolicyConfig,
  options: AgentStoragePolicyProvisionOptions = {},
): Promise<AgentStoragePolicyProvisionResult> {
  const built = buildAgentStoragePolicy(config)
  const secrets = options.redactionSecrets ?? []
  const current = await readAgentStoragePolicy(client, config.roleName, built.policyName, secrets)

  if (current !== undefined && jsonDocumentsEqual(current, built.document)) {
    return {
      classification: 'current',
      changed: false,
      policyName: built.policyName,
      keyLayoutVersion: built.keyLayoutVersion,
      sessionPrefix: built.layout.sessionPrefix,
      lockKey: built.layout.lockKey,
    }
  }

  if (current !== undefined && !options.force) {
    warnAndHaltStoragePolicy(config.roleName, built.policyName, 'policy document is not canonical', options)
  }

  try {
    await client.send(
      new PutRolePolicyCommand({
        RoleName: config.roleName,
        PolicyName: built.policyName,
        PolicyDocument: JSON.stringify(built.document),
      }),
    )
  } catch (error: unknown) {
    throw redactAwsError(error, secrets)
  }

  await readAgentStoragePolicyAfterMutation(client, config.roleName, built.policyName, built.document, secrets)

  return {
    classification: current === undefined ? 'absent' : 'managed-drift',
    changed: true,
    policyName: built.policyName,
    keyLayoutVersion: built.keyLayoutVersion,
    sessionPrefix: built.layout.sessionPrefix,
    lockKey: built.layout.lockKey,
  }
}

function actionFacingS3Prefix(prefix: string): string {
  const canonical = canonicalizeS3Prefix(prefix)
  return canonical.slice(0, -1)
}

interface AgentBucketPlanState {
  bucketRegion: string
  changes: string[]
}

async function readAgentBucketPlanState(
  client: S3ClientLike,
  config: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<AgentBucketPlanState> {
  const prefixes = resolveBucketPrefixes(config)
  const existing = await headAgentBucket(client, config, secrets)
  if (!existing.exists) {
    return {
      bucketRegion: config.region,
      changes: [`create S3 bucket ${config.bucket}`, 'apply bucket security controls and lifecycle rules'],
    }
  }

  const changes: string[] = []
  const publicAccessBlock = await readPublicAccessBlock(client, config, secrets)
  if (
    publicAccessBlock?.BlockPublicAcls !== true ||
    publicAccessBlock.IgnorePublicAcls !== true ||
    publicAccessBlock.BlockPublicPolicy !== true ||
    publicAccessBlock.RestrictPublicBuckets !== true
  ) {
    changes.push('converge S3 public-access-block')
  }
  if ((await readBucketVersioning(client, config, secrets)) !== 'Enabled') {
    changes.push('enable S3 bucket versioning')
  }
  if (!(await readBucketEncryption(client, config, secrets)).includes('AES256')) {
    changes.push('converge S3 AES256 encryption')
  }
  if (!policiesEqual(await readBucketPolicy(client, config, secrets), buildTlsOnlyBucketPolicy(config.bucket))) {
    changes.push('converge the S3 TLS-only bucket policy')
  }
  const lifecycleRules = await readBucketLifecycle(client, config, secrets)
  for (const desiredRule of buildAgentLifecycleRules(prefixes)) {
    if (!lifecycleRulesContainRule(lifecycleRules, desiredRule)) {
      changes.push(`converge lifecycle rule ${String(desiredRule.ID)}`)
    }
  }

  return {bucketRegion: existing.bucketRegion, changes}
}

async function planProvisioning(options: {
  client: IAMClientLike
  s3Client: S3ClientLike
  repository: AgentRepositoryConfig
  bucketConfig: AgentBucketConfig
  keyLayoutVersion: string
  secrets: RedactionSecret[]
  log: (message: string) => void
}): Promise<AgentHandoffManifest> {
  const {client, s3Client, repository, bucketConfig, keyLayoutVersion, secrets, log} = options
  const provider = await discoverCanonicalProvider(client, secrets)
  if (!provider) {
    log('Plan: would create the shared GitHub OIDC provider.')
  } else if (hasAudience(provider.clientIds, GITHUB_OIDC_AUDIENCE)) {
    log(`Plan: GitHub OIDC provider is current (${provider.providerArn}).`)
  } else {
    log('Plan: would add sts.amazonaws.com to the shared GitHub OIDC provider.')
  }

  const bucketState = await readAgentBucketPlanState(s3Client, bucketConfig, secrets)
  for (const change of bucketState.changes) log(`Plan: would ${change}.`)
  if (bucketState.changes.length === 0) log(`Plan: S3 bucket ${bucketConfig.bucket} is current.`)

  const roleName = buildAgentRoleName(repository.owner, repository.repo)
  const expectedTrustPolicy = buildGitHubOidcTrustPolicy(repository, provider?.providerArn ?? 'planned-provider-arn')
  const role = await readAgentRole(client, roleName, secrets)
  if (role) {
    const roleState = classifyRoleState(role, roleName, repository, expectedTrustPolicy)
    if (roleState.foreignDrift.length > 0) {
      log(
        `Plan: IAM role ${roleName} has foreign drift (${roleState.foreignDrift.join(', ')}); no mutation would be attempted.`,
      )
    } else if (roleState.managedDrift.length > 0) {
      log(`Plan: would converge IAM role ${roleName} (${roleState.managedDrift.join(', ')}).`)
    } else {
      log(`Plan: IAM role ${roleName} is current.`)
    }
  } else {
    log(`Plan: would create IAM role ${roleName}.`)
  }

  const policyConfig: AgentStoragePolicyConfig = {
    roleName,
    bucket: bucketConfig.bucket,
    owner: repository.owner,
    repo: repository.repo,
    s3Prefix: bucketConfig.s3Prefix,
    actionVersion: keyLayoutVersion,
  }
  const builtPolicy = buildAgentStoragePolicy(policyConfig)
  const currentPolicy = await readAgentStoragePolicy(client, roleName, builtPolicy.policyName, secrets)
  if (currentPolicy === undefined) {
    log(`Plan: would attach IAM inline policy ${builtPolicy.policyName}.`)
  } else if (jsonDocumentsEqual(currentPolicy, builtPolicy.document)) {
    log(`Plan: IAM inline policy ${builtPolicy.policyName} is current.`)
  } else {
    log(`Plan: would converge IAM inline policy ${builtPolicy.policyName}.`)
  }

  const manifest = createHandoffManifest(provider?.providerArn ?? '')
  manifest.owner = repository.owner
  manifest.repo = repository.repo
  manifest.repository_id = repository.repositoryId
  manifest.repository_owner_id = repository.repositoryOwnerId
  manifest.bucket = bucketConfig.bucket
  manifest.bucket_region = bucketState.bucketRegion
  manifest.expected_bucket_owner = bucketConfig.expectedBucketOwner
  manifest.s3_prefix = actionFacingS3Prefix(bucketConfig.s3Prefix)
  manifest.session_prefix = builtPolicy.layout.sessionPrefix
  manifest.lock_key = builtPolicy.layout.lockKey
  manifest.role_name = roleName
  manifest.role_arn = role?.Arn ?? ''
  manifest.policy_name = builtPolicy.policyName
  manifest.action_ref_verified = true
  manifest.key_layout_version = builtPolicy.keyLayoutVersion
  log('Plan: no AWS mutations were issued.')
  printManifest(manifest, log)
  return manifest
}

// ---------------------------------------------------------------------------
// Per-repository teardown
// ---------------------------------------------------------------------------

function teardownLog(options: AgentTeardownDeps, message: string): void {
  ;(options.log ?? (line => console.log(line)))(message)
}

interface ValidatedTeardownManifest {
  manifest: AgentHandoffManifest
  roleName: string
  policyName: string
  bucketConfig: AgentBucketConfig
  layout: AgentKeyLayout
}

function validateTeardownManifest(manifest: unknown, repository: AgentRepositoryConfig): ValidatedTeardownManifest {
  validateRepositoryConfig(repository)

  if (typeof manifest !== 'object' || manifest === null || Array.isArray(manifest)) {
    throw new Error('Teardown manifest must be a JSON object; refusing to mutate.')
  }
  const candidate = manifest as Record<string, unknown>

  type RequiredStringField =
    | 'owner'
    | 'repo'
    | 'repository_id'
    | 'repository_owner_id'
    | 'bucket'
    | 'bucket_region'
    | 'expected_bucket_owner'
    | 's3_prefix'
    | 'session_prefix'
    | 'lock_key'
    | 'role_name'
    | 'role_arn'
    | 'policy_name'
    | 'key_layout_version'
    | 'oidc_provider_arn'
  const requiredString = (field: RequiredStringField): string => {
    const value = candidate[field]
    if (typeof value !== 'string' || value.trim().length === 0) {
      throw new Error(`Teardown manifest field ${field} is missing or invalid; refusing to mutate.`)
    }
    return value
  }
  const typedManifest: AgentHandoffManifest = {
    owner: requiredString('owner'),
    repo: requiredString('repo'),
    repository_id: requiredString('repository_id'),
    repository_owner_id: requiredString('repository_owner_id'),
    bucket: requiredString('bucket'),
    bucket_region: requiredString('bucket_region'),
    expected_bucket_owner: requiredString('expected_bucket_owner'),
    s3_prefix: requiredString('s3_prefix'),
    session_prefix: requiredString('session_prefix'),
    lock_key: requiredString('lock_key'),
    role_name: requiredString('role_name'),
    role_arn: requiredString('role_arn'),
    policy_name: requiredString('policy_name'),
    action_ref_verified: candidate.action_ref_verified === true,
    key_layout_version: requiredString('key_layout_version'),
    oidc_provider_arn: requiredString('oidc_provider_arn'),
  }

  if (typedManifest.action_ref_verified !== true) {
    throw new Error('Teardown manifest action layout was not verified; refusing to mutate.')
  }

  const expectedRoleName = buildAgentRoleName(repository.owner, repository.repo)
  if (typedManifest.owner !== repository.owner || typedManifest.repo !== repository.repo) {
    throw new Error('Teardown manifest repository identity does not match the target repository; refusing to mutate.')
  }
  if (
    typedManifest.repository_id !== repository.repositoryId ||
    typedManifest.repository_owner_id !== repository.repositoryOwnerId
  ) {
    throw new Error('Teardown manifest repository IDs do not match the target repository; refusing to mutate.')
  }
  if (typedManifest.role_name !== expectedRoleName || typedManifest.policy_name !== expectedRoleName) {
    throw new Error('Teardown manifest role or policy name does not match the target repository; refusing to mutate.')
  }
  if (typedManifest.role_arn !== `arn:aws:iam::${typedManifest.expected_bucket_owner}:role/${expectedRoleName}`) {
    throw new Error('Teardown manifest role ARN does not match the target repository; refusing to mutate.')
  }

  const keyLayoutVersion = assertKnownKeyLayout(typedManifest.key_layout_version)
  const layout = buildAgentKeyLayout(repository.owner, repository.repo, typedManifest.s3_prefix, keyLayoutVersion)
  if (layout.sessionPrefix !== typedManifest.session_prefix || layout.lockKey !== typedManifest.lock_key) {
    throw new Error('Teardown manifest S3 key layout does not match the target repository; refusing to mutate.')
  }

  return {
    manifest: typedManifest,
    roleName: expectedRoleName,
    policyName: expectedRoleName,
    bucketConfig: {
      bucket: typedManifest.bucket,
      region: typedManifest.bucket_region,
      expectedBucketOwner: typedManifest.expected_bucket_owner,
      s3Prefix: typedManifest.s3_prefix,
      sessionPrefix: typedManifest.session_prefix,
    },
    layout,
  }
}

function assertTeardownRoleIdentity(
  role: IamRoleReadback,
  roleName: string,
  repository: AgentRepositoryConfig,
  providerArn: string,
  expectedRoleArn: string,
): void {
  const expectedTrustPolicy = buildGitHubOidcTrustPolicy(repository, providerArn)
  const state = classifyRoleState(role, roleName, repository, expectedTrustPolicy)
  if (state.foreignDrift.length > 0 || state.managedDrift.length > 0) {
    throw new Error(
      `IAM role ${roleName} identity/trust does not match ${repository.owner}/${repository.repo}; refusing teardown. ${[
        ...state.foreignDrift,
        ...state.managedDrift,
      ].join(', ')}`,
    )
  }
  if (roleArn(role, roleName) !== expectedRoleArn) {
    throw new Error(`IAM role ${roleName} ARN does not match the teardown manifest; refusing teardown.`)
  }
}

async function verifyTeardownSharedResources(
  client: IAMClientLike,
  s3Client: S3ClientLike,
  manifest: AgentHandoffManifest,
  bucketConfig: AgentBucketConfig,
  secrets: RedactionSecret[],
): Promise<void> {
  const provider = await readOidcProvider(client, manifest.oidc_provider_arn, secrets)
  assertCanonicalProvider(provider)

  const bucket = await headAgentBucket(s3Client, bucketConfig, secrets)
  if (!bucket.exists || bucket.bucketRegion !== manifest.bucket_region) {
    throw new Error(
      `Shared S3 bucket ${manifest.bucket} is absent or mislocated; refusing repo teardown because shared resources must be preserved.`,
    )
  }
}

async function deleteTeardownState(
  s3Client: S3ClientLike,
  manifest: AgentHandoffManifest,
  sessionPrefix: string,
  purgeState: boolean,
  secrets: RedactionSecret[],
): Promise<{lockDeleted: boolean; sessionObjectsPurged: boolean; statePurgeImpossible: boolean; errors: string[]}> {
  let lockDeleted = false
  let sessionObjectsPurged = false
  let statePurgeImpossible = false
  const errors: string[] = []

  try {
    await s3Client.send(
      new DeleteObjectCommand({
        Bucket: manifest.bucket,
        Key: manifest.lock_key,
        ExpectedBucketOwner: manifest.expected_bucket_owner,
      }),
    )
    lockDeleted = true
  } catch (error: unknown) {
    statePurgeImpossible = true
    errors.push(`lock deletion failed: ${redactAwsError(error, secrets).message}`)
  }

  if (!purgeState) return {lockDeleted, sessionObjectsPurged, statePurgeImpossible, errors}

  try {
    const objects: {Key: string; VersionId?: string}[] = []
    let keyMarker: string | undefined
    let versionIdMarker: string | undefined
    do {
      const response = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: manifest.bucket,
          Prefix: sessionPrefix,
          ExpectedBucketOwner: manifest.expected_bucket_owner,
          ...(keyMarker ? {KeyMarker: keyMarker} : {}),
          ...(versionIdMarker ? {VersionIdMarker: versionIdMarker} : {}),
        }),
      )
      objects.push(
        ...[...(response.Versions ?? []), ...(response.DeleteMarkers ?? [])]
          .filter(
            (entry): entry is {Key: string; VersionId?: string} =>
              typeof entry.Key === 'string' && entry.Key.startsWith(sessionPrefix),
          )
          .map(entry => ({Key: entry.Key, ...(entry.VersionId ? {VersionId: entry.VersionId} : {})})),
      )
      keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined
      versionIdMarker = response.IsTruncated ? response.NextVersionIdMarker : undefined
    } while (keyMarker || versionIdMarker)

    for (let offset = 0; offset < objects.length; offset += 1000) {
      const deleteResponse = await s3Client.send(
        new DeleteObjectsCommand({
          Bucket: manifest.bucket,
          ExpectedBucketOwner: manifest.expected_bucket_owner,
          Delete: {Objects: objects.slice(offset, offset + 1000)},
        }),
      )
      if (deleteResponse.Errors && deleteResponse.Errors.length > 0) {
        throw new Error(`session object deletion returned ${deleteResponse.Errors.length} object errors`)
      }
    }
    sessionObjectsPurged = true
  } catch (error: unknown) {
    statePurgeImpossible = true
    errors.push(`session purge failed: ${redactAwsError(error, secrets).message}`)
  }

  return {lockDeleted, sessionObjectsPurged, statePurgeImpossible, errors}
}

/**
 * Removes one repository's inline policy, role, lock, and optionally session
 * objects. The shared bucket and GitHub OIDC provider are read-only resources
 * here: their presence is verified before and after the scoped cleanup.
 */
export async function performTeardown(options: AgentTeardownDeps): Promise<AgentTeardownResult> {
  const env = options.env ?? process.env
  const secrets = options.redactionSecrets ?? [
    {name: 'agent-aws-access-key-id', content: env[AGENT_AWS_ACCESS_KEY_ID] ?? ''},
    {name: 'agent-aws-secret-access-key', content: env[AGENT_AWS_SECRET_ACCESS_KEY] ?? ''},
    {name: 'agent-aws-session-token', content: env[AGENT_AWS_SESSION_TOKEN] ?? ''},
  ]
  const identity = validateTeardownManifest(options.manifest, options.repository)
  const manifest = identity.manifest
  const client = options.client ?? createIamClientFromEnv(env)
  const s3Client = options.s3Client ?? createS3ClientFromEnv(env, manifest.bucket_region)

  await verifyTeardownSharedResources(client, s3Client, manifest, identity.bucketConfig, secrets)
  const role = await readAgentRole(client, identity.roleName, secrets)
  if (role !== undefined) {
    assertTeardownRoleIdentity(
      role,
      identity.roleName,
      options.repository,
      manifest.oidc_provider_arn,
      manifest.role_arn,
    )
  }
  const policy = await readAgentStoragePolicy(client, identity.roleName, identity.policyName, secrets)

  if (options.plan) {
    teardownLog(options, `Plan: would delete ${manifest.lock_key} from ${manifest.bucket}.`)
    if (options.purgeState) {
      teardownLog(options, `Plan: would purge session objects under ${manifest.session_prefix}.`)
    } else {
      teardownLog(options, `Plan: would retain session objects under ${manifest.session_prefix}.`)
    }
    teardownLog(options, `Plan: would delete IAM inline policy ${identity.policyName} and role ${identity.roleName}.`)
    teardownLog(options, 'Plan: would preserve the shared S3 bucket and GitHub OIDC provider.')
    return {
      planned: true,
      roleDeleted: false,
      policyDeleted: false,
      lockDeleted: false,
      sessionObjectsPurged: false,
      stateRetained: !options.purgeState,
      statePurgeImpossible: false,
      sharedResourcesPreserved: true,
    }
  }

  let lockDeleted = false
  let sessionObjectsPurged = false
  let statePurgeImpossible = false
  const state = await deleteTeardownState(
    s3Client,
    manifest,
    identity.layout.sessionPrefix,
    options.purgeState ?? false,
    secrets,
  )
  lockDeleted = state.lockDeleted
  sessionObjectsPurged = state.sessionObjectsPurged
  statePurgeImpossible = state.statePurgeImpossible
  for (const error of state.errors) {
    teardownLog(options, `state purge impossible: ${error}`)
  }

  let policyDeleted = false
  if (policy !== undefined) {
    try {
      await client.send(new DeleteRolePolicyCommand({RoleName: identity.roleName, PolicyName: identity.policyName}))
      policyDeleted = true
    } catch (error: unknown) {
      if (!isNamedError(error, ['NoSuchEntity', 'NoSuchEntityException'])) throw redactAwsError(error, secrets)
    }
  }

  let roleDeleted = false
  if (role !== undefined) {
    try {
      await client.send(new DeleteRoleCommand({RoleName: identity.roleName}))
      roleDeleted = true
    } catch (error: unknown) {
      if (!isNamedError(error, ['NoSuchEntity', 'NoSuchEntityException'])) throw redactAwsError(error, secrets)
    }
  }

  if ((await readAgentRole(client, identity.roleName, secrets)) !== undefined) {
    throw new Error(`IAM role ${identity.roleName} remained after teardown readback`)
  }
  if ((await readAgentStoragePolicy(client, identity.roleName, identity.policyName, secrets)) !== undefined) {
    throw new Error(`IAM inline policy ${identity.policyName} remained after teardown readback`)
  }
  await verifyTeardownSharedResources(client, s3Client, manifest, identity.bucketConfig, secrets)

  return {
    planned: false,
    roleDeleted,
    policyDeleted,
    lockDeleted,
    sessionObjectsPurged,
    stateRetained: !(options.purgeState ?? false),
    statePurgeImpossible,
    sharedResourcesPreserved: true,
  }
}

function readAuditDate(value: unknown): Date | undefined {
  if (value instanceof Date) return value
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? undefined : parsed
  }
  return undefined
}

function auditRoleRepository(tags: unknown): string | undefined {
  if (!Array.isArray(tags)) return undefined
  const tagMap = tagsToMap(
    tags.filter((tag): tag is RoleTagReadback => typeof tag === 'object' && tag !== null) as RoleTagReadback[],
  )
  const owner = tagMap.get('owner')
  const repo = tagMap.get('repo')
  return owner && repo ? `${owner}/${repo}` : undefined
}

/**
 * Report-only audit for resources left behind by a disabled repository. The
 * GitHub variable check is injected because this operator-side AWS package
 * deliberately does not own GitHub API credentials.
 */
export async function auditAgentStorageResources(options: AgentStorageAuditDeps): Promise<AgentStorageAuditResult> {
  const env = options.env ?? process.env
  const secrets = options.redactionSecrets ?? [
    {name: 'agent-aws-access-key-id', content: env[AGENT_AWS_ACCESS_KEY_ID] ?? ''},
    {name: 'agent-aws-secret-access-key', content: env[AGENT_AWS_SECRET_ACCESS_KEY] ?? ''},
    {name: 'agent-aws-session-token', content: env[AGENT_AWS_SESSION_TOKEN] ?? ''},
  ]
  const client = options.client ?? createIamClientFromEnv(env)
  const s3Client = options.s3Client ?? createS3ClientFromEnv(env, options.bucket.region)
  const now = options.now ?? new Date()
  const staleLockThresholdMs = options.staleLockThresholdMs ?? 2 * 60 * 60 * 1000 + 15 * 60 * 1000
  const rolePrefix = 'fro-bot-agent-storage-'

  const candidateRoles: string[] = []
  const strandedRoles: string[] = []
  let marker: string | undefined
  do {
    let response
    try {
      response = await client.send(new ListRolesCommand(marker ? {Marker: marker} : {}))
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    for (const role of response.Roles ?? []) {
      if (!role.RoleName?.startsWith(rolePrefix)) continue
      candidateRoles.push(role.RoleName)
      const repository = auditRoleRepository(role.Tags)
      if (repository === undefined || (options.hasRepoVariables && !(await options.hasRepoVariables(repository)))) {
        strandedRoles.push(role.RoleName)
      }
    }
    marker = response.IsTruncated ? response.Marker : undefined
  } while (marker)

  const s3Prefix = canonicalizeS3Prefix(options.bucket.s3Prefix)
  const staleLocks: string[] = []
  let continuationToken: string | undefined
  do {
    let response
    try {
      response = await s3Client.send(
        new ListObjectsV2Command({
          Bucket: options.bucket.bucket,
          Prefix: `${s3Prefix}coordination/`,
          ExpectedBucketOwner: options.bucket.expectedBucketOwner,
          ...(continuationToken ? {ContinuationToken: continuationToken} : {}),
        }),
      )
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    for (const object of response.Contents ?? []) {
      const modified = readAuditDate(object.LastModified)
      if (
        object.Key?.includes('/locks/') &&
        modified !== undefined &&
        now.getTime() - modified.getTime() > staleLockThresholdMs
      ) {
        staleLocks.push(object.Key)
      }
    }
    continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined
  } while (continuationToken)

  const incompleteMultipartUploads: string[] = []
  let keyMarker: string | undefined
  let uploadIdMarker: string | undefined
  do {
    let response
    try {
      response = await s3Client.send(
        new ListMultipartUploadsCommand({
          Bucket: options.bucket.bucket,
          Prefix: s3Prefix,
          ExpectedBucketOwner: options.bucket.expectedBucketOwner,
          ...(keyMarker ? {KeyMarker: keyMarker} : {}),
          ...(uploadIdMarker ? {UploadIdMarker: uploadIdMarker} : {}),
        }),
      )
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    for (const upload of response.Uploads ?? []) {
      if (upload.Key && upload.UploadId) incompleteMultipartUploads.push(`${upload.Key}#${upload.UploadId}`)
    }
    keyMarker = response.IsTruncated ? response.NextKeyMarker : undefined
    uploadIdMarker = response.IsTruncated ? response.NextUploadIdMarker : undefined
  } while (keyMarker || uploadIdMarker)

  const orphanedNoncurrentVersions: string[] = []
  let versionKeyMarker: string | undefined
  let versionIdMarker: string | undefined
  do {
    let response
    try {
      response = await s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: options.bucket.bucket,
          Prefix: s3Prefix,
          ExpectedBucketOwner: options.bucket.expectedBucketOwner,
          ...(versionKeyMarker ? {KeyMarker: versionKeyMarker} : {}),
          ...(versionIdMarker ? {VersionIdMarker: versionIdMarker} : {}),
        }),
      )
    } catch (error: unknown) {
      throw redactAwsError(error, secrets)
    }
    const currentKeys = new Set(
      (response.Versions ?? [])
        .filter(version => version.IsLatest === true && typeof version.Key === 'string')
        .map(version => version.Key as string),
    )
    for (const version of response.Versions ?? []) {
      if (version.IsLatest !== true && version.Key && version.VersionId && !currentKeys.has(version.Key)) {
        orphanedNoncurrentVersions.push(`${version.Key}#${version.VersionId}`)
      }
    }
    versionKeyMarker = response.IsTruncated ? response.NextKeyMarker : undefined
    versionIdMarker = response.IsTruncated ? response.NextVersionIdMarker : undefined
  } while (versionKeyMarker || versionIdMarker)

  return {
    candidateRoles,
    strandedRoles,
    staleLocks,
    incompleteMultipartUploads,
    orphanedNoncurrentVersions,
  }
}

// ---------------------------------------------------------------------------
// Provisioning orchestration
// ---------------------------------------------------------------------------

function readBucketConfigFromEnv(env: Partial<Record<string, string | undefined>>): AgentBucketConfig | undefined {
  const bucketInputs = [
    AGENT_S3_BUCKET,
    AGENT_S3_EXPECTED_BUCKET_OWNER,
    AGENT_S3_PREFIX,
    AGENT_S3_SESSION_PREFIX,
    AGENT_S3_METADATA_ARTIFACTS_PREFIX,
  ]
  const hasBucketConfiguration = bucketInputs.some(key => env[key]?.trim())
  if (!hasBucketConfiguration) return undefined

  const required = [AGENT_S3_BUCKET, AGENT_S3_EXPECTED_BUCKET_OWNER, AGENT_S3_PREFIX]
  const missing = required.filter(key => !env[key]?.trim())
  if (missing.length > 0) {
    throw new Error(`Missing dedicated agent S3 configuration: ${missing.join(', ')}`)
  }

  const bucket = env[AGENT_S3_BUCKET]?.trim()
  const expectedBucketOwner = env[AGENT_S3_EXPECTED_BUCKET_OWNER]?.trim()
  const s3Prefix = env[AGENT_S3_PREFIX]?.trim()
  if (!bucket || !expectedBucketOwner || !s3Prefix) {
    throw new Error('Dedicated agent S3 bucket, expected owner, and prefix are required')
  }

  return {
    bucket,
    region: env[AGENT_AWS_REGION]?.trim() || 'us-east-1',
    expectedBucketOwner,
    s3Prefix,
    ...(env[AGENT_S3_SESSION_PREFIX]?.trim() ? {sessionPrefix: env[AGENT_S3_SESSION_PREFIX]?.trim()} : {}),
    ...(env[AGENT_S3_METADATA_ARTIFACTS_PREFIX]?.trim()
      ? {metadataArtifactsPrefix: env[AGENT_S3_METADATA_ARTIFACTS_PREFIX]?.trim()}
      : {}),
  }
}

function readRepositoryConfigFromEnv(env: Partial<Record<string, string | undefined>>): AgentRepositoryConfig {
  const values = {
    owner: env[AGENT_REPOSITORY_OWNER]?.trim(),
    repo: env[AGENT_REPOSITORY_NAME]?.trim(),
    repositoryId: env[AGENT_REPOSITORY_ID]?.trim(),
    repositoryOwnerId: env[AGENT_REPOSITORY_OWNER_ID]?.trim(),
    workflow: env[AGENT_WORKFLOW_NAME]?.trim(),
  }
  const missing = Object.entries(values)
    .filter(([, value]) => !value)
    .map(([key]) => key)
  if (missing.length > 0) {
    throw new Error(
      `Missing dedicated agent repository configuration: ${missing.join(', ')}. ` +
        `Set ${AGENT_REPOSITORY_OWNER}, ${AGENT_REPOSITORY_NAME}, ${AGENT_REPOSITORY_ID}, ${AGENT_REPOSITORY_OWNER_ID}, and ${AGENT_WORKFLOW_NAME}.`,
    )
  }

  const {owner, repo, repositoryId, repositoryOwnerId, workflow} = values
  if (!owner || !repo || !repositoryId || !repositoryOwnerId || !workflow) {
    throw new Error('Dedicated agent repository configuration is incomplete')
  }
  return {owner, repo, repositoryId, repositoryOwnerId, workflow}
}

function readActionRefFromEnv(env: Partial<Record<string, string | undefined>>): string {
  const actionRef = env[AGENT_ACTION_REF]?.trim()
  if (!actionRef) {
    throw new Error(
      `Missing dedicated agent action ref configuration. Set ${AGENT_ACTION_REF} to the pinned fro-bot/agent ref.`,
    )
  }
  return actionRef
}

function readArgumentValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  if (index === -1) return undefined
  const value = args[index + 1]
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`)
  return value
}

async function readTeardownManifest(source: string): Promise<unknown> {
  const raw = source === '-' ? await new Response(Bun.stdin).text() : await Bun.file(source).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('Teardown manifest is not valid JSON')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('Teardown manifest must be a JSON object')
  }
  return parsed
}

export async function performProvisioning(deps: ProvisionDeps = {}): Promise<AgentHandoffManifest> {
  const env = deps.env ?? process.env
  const secrets = deps.redactionSecrets ?? [
    {name: 'agent-aws-access-key-id', content: env[AGENT_AWS_ACCESS_KEY_ID] ?? ''},
    {name: 'agent-aws-secret-access-key', content: env[AGENT_AWS_SECRET_ACCESS_KEY] ?? ''},
    {name: 'agent-aws-session-token', content: env[AGENT_AWS_SESSION_TOKEN] ?? ''},
  ]

  const repository = deps.repository ?? readRepositoryConfigFromEnv(env)
  const bucketConfig = deps.bucket ?? readBucketConfigFromEnv(env)
  if (!bucketConfig) {
    throw new Error(
      `Missing dedicated agent S3 bucket configuration. Set ${AGENT_S3_BUCKET}, ${AGENT_S3_EXPECTED_BUCKET_OWNER}, and ${AGENT_S3_PREFIX}.`,
    )
  }

  // Validate the action layout before constructing clients or touching shared
  // AWS resources. An unknown layout is never made to work by widening IAM.
  const actionRef = deps.actionRef ?? readActionRefFromEnv(env)
  const keyLayoutVersion = assertKnownKeyLayout(actionRef)
  const keyLayout = buildAgentKeyLayout(repository.owner, repository.repo, bucketConfig.s3Prefix, keyLayoutVersion)

  const client = deps.client ?? createIamClientFromEnv(env)
  const log = deps.printLine ?? (line => console.log(line))
  if (deps.plan) {
    const s3Client = deps.s3Client ?? createS3ClientFromEnv(env, bucketConfig.region)
    return planProvisioning({
      client,
      s3Client,
      repository,
      bucketConfig,
      keyLayoutVersion,
      secrets,
      log,
    })
  }

  const provider = await ensureGitHubOidcProvider(client, secrets)
  const manifest = createHandoffManifest(provider.providerArn)

  const s3Client = deps.s3Client ?? createS3ClientFromEnv(env, bucketConfig.region)
  const bucket = await ensureAgentStateBucket(s3Client, bucketConfig, {
    force: deps.force,
    redactionSecrets: secrets,
  })
  const role = await ensureAgentStorageRole(client, repository, provider.providerArn, {
    force: deps.force,
    redactionSecrets: secrets,
  })
  const policy = await ensureAgentStoragePolicy(
    client,
    {
      roleName: role.roleName,
      bucket: bucket.bucket,
      owner: repository.owner,
      repo: repository.repo,
      s3Prefix: bucket.s3Prefix,
      actionVersion: keyLayoutVersion,
    },
    {
      force: deps.force,
      redactionSecrets: secrets,
    },
  )
  manifest.owner = repository.owner
  manifest.repo = repository.repo
  manifest.repository_id = repository.repositoryId
  manifest.repository_owner_id = repository.repositoryOwnerId
  manifest.bucket = bucket.bucket
  manifest.bucket_region = bucket.bucketRegion
  manifest.expected_bucket_owner = bucket.expectedBucketOwner
  manifest.s3_prefix = actionFacingS3Prefix(bucket.s3Prefix)
  manifest.session_prefix = keyLayout.sessionPrefix
  manifest.lock_key = policy.lockKey
  manifest.role_name = role.roleName
  manifest.role_arn = role.roleArn
  manifest.policy_name = policy.policyName
  manifest.action_ref_verified = true
  manifest.key_layout_version = policy.keyLayoutVersion

  printManifest(manifest, deps.printLine)
  return manifest
}

const AGENT_USAGE = `Usage:
  bun run apps/agent/server/provision.ts [--force] [--plan|--dry-run]
  bun run apps/agent/server/provision.ts --teardown --manifest <path|-> [--purge-state] [--plan]

Required environment:
  AGENT_AWS_ACCESS_KEY_ID, AGENT_AWS_SECRET_ACCESS_KEY
  AGENT_AWS_REGION, AGENT_S3_BUCKET, AGENT_S3_EXPECTED_BUCKET_OWNER, AGENT_S3_PREFIX
  AGENT_REPOSITORY_OWNER, AGENT_REPOSITORY_NAME, AGENT_REPOSITORY_ID
  AGENT_REPOSITORY_OWNER_ID, AGENT_WORKFLOW_NAME, AGENT_ACTION_REF
  Optional: AGENT_AWS_SESSION_TOKEN, AGENT_S3_SESSION_PREFIX,
  AGENT_S3_METADATA_ARTIFACTS_PREFIX

Examples:
  Provision:       bun run apps/agent/server/provision.ts
  Force drift:     bun run apps/agent/server/provision.ts --force
  Provision plan:  bun run apps/agent/server/provision.ts --plan
  Teardown plan:   bun run apps/agent/server/provision.ts --teardown --manifest handoff.json --plan
  Stdin manifest:  cat handoff.json | bun run apps/agent/server/provision.ts --teardown --manifest -
  Purge state:     bun run apps/agent/server/provision.ts --teardown --manifest handoff.json --purge-state
`

export async function main(
  args: string[] = Bun.argv.slice(2),
  env: Partial<Record<string, string | undefined>> = process.env,
  output: (line: string) => void = line => console.log(line),
): Promise<void> {
  if (args.includes('--help') || args.includes('-h')) {
    output(AGENT_USAGE)
    return
  }

  if (args.includes('--teardown')) {
    const unknown = args.filter(
      (argument: string, index: number) =>
        !['--teardown', '--purge-state', '--plan', '--dry-run', '--manifest'].includes(argument) &&
        (index === 0 || args[index - 1] !== '--manifest'),
    )
    if (unknown.length > 0) {
      throw new Error(
        `Unknown teardown argument(s): ${unknown.join(', ')}. Supported: --teardown --manifest <path> [--purge-state] [--plan]`,
      )
    }

    const manifestSource = readArgumentValue(args, '--manifest')
    if (!manifestSource) throw new Error('Teardown requires --manifest <path> or --manifest - for stdin')
    const manifestSourceValue = await readTeardownManifest(manifestSource)
    const repository = readRepositoryConfigFromEnv(env)
    const validated = validateTeardownManifest(manifestSourceValue, repository)
    const manifest = validated.manifest
    const client = createIamClientFromEnv(env)
    const s3Client = createS3ClientFromEnv(env, manifest.bucket_region)
    const result = await performTeardown({
      client,
      s3Client,
      manifest,
      repository,
      purgeState: args.includes('--purge-state'),
      plan: args.includes('--plan') || args.includes('--dry-run'),
      env,
    })
    output(JSON.stringify(result))
    return
  }

  const unknown = args.filter((argument: string) => !['--force', '--plan', '--dry-run'].includes(argument))
  if (unknown.length > 0) {
    throw new Error(`Unknown provision argument(s): ${unknown.join(', ')}. Supported: --force --plan --dry-run`)
  }
  await performProvisioning({
    force: args.includes('--force'),
    plan: args.includes('--plan') || args.includes('--dry-run'),
    env,
    printLine: output,
  })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const env = process.env
    const secrets: RedactionSecret[] = [
      {name: 'agent-aws-access-key-id', content: env[AGENT_AWS_ACCESS_KEY_ID] ?? ''},
      {name: 'agent-aws-secret-access-key', content: env[AGENT_AWS_SECRET_ACCESS_KEY] ?? ''},
      {name: 'agent-aws-session-token', content: env[AGENT_AWS_SESSION_TOKEN] ?? ''},
    ]
    console.error(redactAwsError(error, secrets).message)
    process.exit(1)
  })
}
