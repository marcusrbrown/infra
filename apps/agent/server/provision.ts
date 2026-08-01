#!/usr/bin/env bun

import {
  AddClientIDToOpenIDConnectProviderCommand,
  CreateOpenIDConnectProviderCommand,
  GetOpenIDConnectProviderCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
} from '@aws-sdk/client-iam'
import {
  CreateBucketCommand,
  GetBucketEncryptionCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketPolicyCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketLifecycleConfigurationCommand,
  PutBucketPolicyCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
  S3Client,
  type BucketLocationConstraint,
  type LifecycleRule,
} from '@aws-sdk/client-s3'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_OIDC_PROVIDER_URL = 'https://token.actions.githubusercontent.com'
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'
export const AGENT_AWS_ACCESS_KEY_ID = 'AGENT_AWS_ACCESS_KEY_ID'
export const AGENT_AWS_SECRET_ACCESS_KEY = 'AGENT_AWS_SECRET_ACCESS_KEY'
export const AGENT_AWS_SESSION_TOKEN = 'AGENT_AWS_SESSION_TOKEN'
export const AGENT_AWS_REGION = 'AGENT_AWS_REGION'
export const AGENT_S3_BUCKET = 'AGENT_S3_BUCKET'
export const AGENT_S3_EXPECTED_BUCKET_OWNER = 'AGENT_S3_EXPECTED_BUCKET_OWNER'
export const AGENT_S3_PREFIX = 'AGENT_S3_PREFIX'
export const AGENT_S3_SESSION_PREFIX = 'AGENT_S3_SESSION_PREFIX'
export const AGENT_S3_METADATA_ARTIFACTS_PREFIX = 'AGENT_S3_METADATA_ARTIFACTS_PREFIX'

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
  /** Environment source used to construct the default IAM client. */
  env?: Partial<Record<string, string | undefined>>
  /** Replaces stdout in tests; defaults to console.log. */
  printLine?: (line: string) => void
  /** Credential values to redact from AWS error messages. */
  redactionSecrets?: RedactionSecret[]
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
  const prefix = lifecycleRulePrefix(rule)
  return prefix === undefined || prefix === ''
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
      Status: 'Enabled',
      NoncurrentVersionExpiration: {NoncurrentDays: 30},
    },
    {
      ID: AGENT_LIFECYCLE_RULE_IDS[3],
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
      url: response.Url,
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

function assertCanonicalUrl(provider: OidcProviderDetails): void {
  if (provider.url !== GITHUB_OIDC_PROVIDER_URL) {
    throw new Error(
      `IAM OIDC provider ${provider.providerArn} URL drifted to ${provider.url}; expected ${GITHUB_OIDC_PROVIDER_URL}`,
    )
  }
}

function assertCanonicalProvider(provider: OidcProviderDetails): void {
  assertCanonicalUrl(provider)
  if (!provider.clientIds.includes(GITHUB_OIDC_AUDIENCE)) {
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
  if (!provider.clientIds.includes(GITHUB_OIDC_AUDIENCE)) {
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

export async function performProvisioning(deps: ProvisionDeps = {}): Promise<AgentHandoffManifest> {
  const env = deps.env ?? process.env
  const secrets = deps.redactionSecrets ?? [
    {name: 'agent-aws-access-key-id', content: env[AGENT_AWS_ACCESS_KEY_ID] ?? ''},
    {name: 'agent-aws-secret-access-key', content: env[AGENT_AWS_SECRET_ACCESS_KEY] ?? ''},
    {name: 'agent-aws-session-token', content: env[AGENT_AWS_SESSION_TOKEN] ?? ''},
  ]

  const client = deps.client ?? createIamClientFromEnv(env)
  const provider = await ensureGitHubOidcProvider(client, secrets)
  const manifest = createHandoffManifest(provider.providerArn)

  const bucketConfig = deps.bucket ?? readBucketConfigFromEnv(env)
  if (!bucketConfig) {
    throw new Error(
      `Missing dedicated agent S3 bucket configuration. Set ${AGENT_S3_BUCKET}, ${AGENT_S3_EXPECTED_BUCKET_OWNER}, and ${AGENT_S3_PREFIX}.`,
    )
  }

  const s3Client = deps.s3Client ?? createS3ClientFromEnv(env, bucketConfig.region)
  const bucket = await ensureAgentStateBucket(s3Client, bucketConfig, {redactionSecrets: secrets})
  manifest.bucket = bucket.bucket
  manifest.bucket_region = bucket.bucketRegion
  manifest.expected_bucket_owner = bucket.expectedBucketOwner
  manifest.s3_prefix = bucket.s3Prefix
  manifest.session_prefix = bucket.sessionPrefix

  printManifest(manifest, deps.printLine)
  return manifest
}

async function main(): Promise<void> {
  await performProvisioning()
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
