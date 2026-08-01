/// <reference types="bun" />

import type {goke} from 'goke'

import {log} from '@clack/prompts'
import {z} from 'zod'

import {applyGhValue, runGh, type CommandResult} from './setup-core/gh'

// These names intentionally mirror the fro-bot/agent action inputs. They are
// repository VARIABLES, never secrets, and are the only GitHub values this
// module writes.
export const STORAGE_VARIABLE_NAMES = {
  roleToAssume: 'FRO_BOT_S3_ROLE_TO_ASSUME',
  bucket: 'FRO_BOT_S3_BUCKET',
  region: 'FRO_BOT_S3_REGION',
  prefix: 'FRO_BOT_S3_PREFIX',
  expectedBucketOwner: 'FRO_BOT_S3_EXPECTED_BUCKET_OWNER',
} as const

export interface StorageManifest {
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
  action_ref_verified: true
  key_layout_version: string
}

export interface StorageOptions {
  /** Handoff manifest path, or '-' to read JSON from stdin. */
  manifest?: string
  /** Rejected deliberately; static AWS credentials are never agent config. */
  staticAwsAccessKeyId?: string
  /** Rejected deliberately; static AWS credentials are never agent config. */
  staticAwsSecretAccessKey?: string
  /** Compatibility spelling for callers attempting to pass static credentials. */
  awsAccessKeyId?: string
  /** Compatibility spelling for callers attempting to pass static credentials. */
  awsSecretAccessKey?: string
  /** Environment-style spelling is accepted only so it can be refused explicitly. */
  AWS_ACCESS_KEY_ID?: string
  /** Environment-style spelling is accepted only so it can be refused explicitly. */
  AWS_SECRET_ACCESS_KEY?: string
}

export interface StorageSetupDeps {
  runGh?: typeof runGh
  applyGhValue?: typeof applyGhValue
  readManifest?: (source: string) => Promise<string>
  verifyResources?: (manifest: StorageManifest) => Promise<void>
  runAws?: (args: string[]) => Promise<CommandResult>
  /** Unit 7 attaches the effective-job-graph verifier here. */
  verifyWorkflow?: (repo: string, manifest: StorageManifest) => Promise<void>
}

export interface PreparedStorageSetup {
  repo: string
  manifest: StorageManifest
  variables: readonly {name: string; value: string}[]
}

const manifestSchema = z.object({
  owner: z.string().min(1),
  repo: z.string().min(1),
  repository_id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  repository_owner_id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  bucket: z.string().min(1),
  bucket_region: z.string().min(1),
  expected_bucket_owner: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  s3_prefix: z.string().min(1),
  session_prefix: z.string().min(1),
  lock_key: z.string().min(1),
  role_name: z.string().min(1),
  role_arn: z.string().min(1),
  policy_name: z.string().min(1),
  action_ref_verified: z.literal(true),
  key_layout_version: z.string().min(1),
})

const liveRepoSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  name: z.string().min(1),
  owner: z.object({
    login: z.string().min(1),
    id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  }),
})

const oidcSubjectSchema = z
  .object({
    use_default: z.boolean(),
    use_immutable_subject: z.boolean(),
  })
  .passthrough()

function extractErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function assertRepoFormat(repo: string): {owner: string; name: string} {
  const match = /^([^/\s]+)\/([^/\s]+)$/.exec(repo)
  if (!match || !match[1] || !match[2]) {
    throw new Error(`Repository must be in owner/repo format: ${repo}`)
  }
  return {owner: match[1], name: match[2]}
}

function assertCanonicalPath(field: string, value: string, mustEndWithSlash: boolean): void {
  if (value.startsWith('/') || value.includes('*') || value.includes('?') || value.includes('//')) {
    throw new Error(`Handoff manifest ${field} is not canonical; refusing to wire storage.`)
  }

  if (mustEndWithSlash && !value.endsWith('/')) {
    throw new Error(`Handoff manifest ${field} must have one normalized trailing slash; refusing to wire storage.`)
  }

  if (!mustEndWithSlash && value.endsWith('/')) {
    throw new Error(`Handoff manifest ${field} must not have a trailing slash; refusing to wire storage.`)
  }
}

function validateManifest(manifest: StorageManifest): void {
  assertRepoFormat(`${manifest.owner}/${manifest.repo}`)
  assertCanonicalPath('s3_prefix', manifest.s3_prefix, false)
  assertCanonicalPath('session_prefix', manifest.session_prefix, true)
  assertCanonicalPath('lock_key', manifest.lock_key, false)

  if (!/^arn:aws:iam::\d{12}:role\//.test(manifest.role_arn)) {
    throw new Error('Handoff manifest role_arn is not a canonical IAM role ARN; refusing to wire storage.')
  }
}

async function readManifest(source: string): Promise<string> {
  const trimmed = source.trim()
  if (trimmed.startsWith('{')) {
    return source
  }

  if (source === '-') {
    return new Response(Bun.stdin).text()
  }

  const file = Bun.file(source)
  if (!(await file.exists())) {
    throw new Error(`Handoff manifest not found at ${source}. Run the provisioner first.`)
  }
  return file.text()
}

function parseManifest(raw: string): StorageManifest {
  try {
    const parsed = manifestSchema.parse(JSON.parse(raw))
    validateManifest(parsed)
    return parsed
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new Error(
        `Invalid handoff manifest: ${error.issues.map(issue => `${issue.path.join('.')} ${issue.message}`).join('; ')}`,
      )
    }
    throw error
  }
}

async function runAwsCommand(args: string[]): Promise<CommandResult> {
  const child = Bun.spawn(['aws', ...args], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  return {stdout, stderr, exitCode}
}

function parseAwsJson(result: CommandResult, operation: string): Record<string, unknown> {
  if (result.exitCode !== 0) {
    throw new Error(
      `AWS ${operation} preflight failed: ${result.stderr.trim() || `aws exited with code ${result.exitCode}`}`,
    )
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('response was not an object')
    }
    return parsed as Record<string, unknown>
  } catch (error) {
    throw new Error(`AWS ${operation} preflight returned malformed JSON: ${extractErrorMessage(error)}`)
  }
}

function canonicalBucketRegion(location: unknown): string {
  if (location === null || location === undefined || location === '') return 'us-east-1'
  if (location === 'EU') return 'eu-west-1'
  return String(location)
}

/**
 * Readback-based provision-first check. The command never creates or mutates
 * AWS resources and never passes credential material on the aws argv.
 */
export async function verifyProvisionedResources(
  manifest: StorageManifest,
  runAws: (args: string[]) => Promise<CommandResult> = runAwsCommand,
): Promise<void> {
  const roleResult = await runAws([
    'iam',
    'get-role',
    '--role-name',
    manifest.role_name,
    '--output',
    'json',
    '--no-cli-pager',
  ])

  let rolePayload: Record<string, unknown>
  try {
    rolePayload = parseAwsJson(roleResult, 'IAM role')
  } catch (error) {
    throw new Error(
      `AWS resources are not provisioned for ${manifest.owner}/${manifest.repo}; run the provisioner first. ${extractErrorMessage(error)}`,
    )
  }

  const role = rolePayload.Role
  const roleArn =
    typeof role === 'object' && role !== null && !Array.isArray(role) && 'Arn' in role && typeof role.Arn === 'string'
      ? role.Arn
      : undefined
  if (roleArn !== manifest.role_arn) {
    throw new Error(
      `AWS IAM role readback does not match the handoff manifest for ${manifest.owner}/${manifest.repo}; run the provisioner first.`,
    )
  }

  const bucketResult = await runAws([
    's3api',
    'head-bucket',
    '--bucket',
    manifest.bucket,
    '--expected-bucket-owner',
    manifest.expected_bucket_owner,
    '--no-cli-pager',
  ])
  if (bucketResult.exitCode !== 0) {
    throw new Error(
      `AWS S3 bucket ${manifest.bucket} is absent, inaccessible, or owned by another account; run the provisioner first. ${bucketResult.stderr.trim()}`.trim(),
    )
  }

  const locationResult = await runAws([
    's3api',
    'get-bucket-location',
    '--bucket',
    manifest.bucket,
    '--expected-bucket-owner',
    manifest.expected_bucket_owner,
    '--output',
    'json',
    '--no-cli-pager',
  ])
  let locationPayload: Record<string, unknown>
  try {
    locationPayload = parseAwsJson(locationResult, 'S3 bucket location')
  } catch (error) {
    throw new Error(
      `AWS resources are not provisioned for ${manifest.owner}/${manifest.repo}; run the provisioner first. ${extractErrorMessage(error)}`,
    )
  }

  const region = canonicalBucketRegion(locationPayload.LocationConstraint)
  if (region !== manifest.bucket_region) {
    throw new Error(
      `AWS S3 bucket region ${region} does not match the handoff manifest region ${manifest.bucket_region}; run the provisioner first.`,
    )
  }
}

async function verifyRepoIdentity(repo: string, manifest: StorageManifest, gh: typeof runGh): Promise<void> {
  const result = await gh(['api', `/repos/${repo}`])
  if (result.exitCode !== 0) {
    throw new Error(`Unable to verify live GitHub repository identity for ${repo}: ${result.stderr.trim()}`.trim())
  }

  let live: z.infer<typeof liveRepoSchema>
  try {
    live = liveRepoSchema.parse(JSON.parse(result.stdout))
  } catch (error) {
    throw new Error(`Unable to verify live GitHub repository identity for ${repo}: ${extractErrorMessage(error)}`)
  }

  const expected = {
    owner: live.owner.login,
    repo: live.name,
    repository_id: live.id,
    repository_owner_id: live.owner.id,
  }
  const mismatches = (Object.keys(expected) as (keyof typeof expected)[]).filter(key => manifest[key] !== expected[key])
  if (mismatches.length > 0) {
    throw new Error(
      `Handoff manifest identity mismatch for ${repo} (${mismatches.join(', ')}); refusing to wire storage.`,
    )
  }
}

async function verifyOidcSubject(repo: string, gh: typeof runGh): Promise<void> {
  const result = await gh(['api', `/repos/${repo}/actions/oidc/customization/sub`])
  if (result.exitCode !== 0) {
    throw new Error(
      `Unable to verify GitHub OIDC subject configuration for ${repo}; explicit OIDC re-verification is required before storage can be enabled. ${result.stderr.trim()}`.trim(),
    )
  }

  let subject: z.infer<typeof oidcSubjectSchema>
  try {
    subject = oidcSubjectSchema.parse(JSON.parse(result.stdout))
  } catch (error) {
    throw new Error(
      `GitHub OIDC subject configuration for ${repo} could not be verified; explicit OIDC re-verification is required before storage can be enabled. ${extractErrorMessage(error)}`,
    )
  }

  const includeClaimKeys = subject.include_claim_keys
  const customTemplate = !subject.use_default || (Array.isArray(includeClaimKeys) && includeClaimKeys.length > 0)
  if (customTemplate || subject.use_immutable_subject) {
    const reason = subject.use_immutable_subject ? 'immutable-subject mode' : 'a custom subject template'
    throw new Error(
      `GitHub OIDC ${reason} is active for ${repo}; explicit OIDC re-verification is required before storage can be enabled.`,
    )
  }
}

function assertNoStaticCredentials(options: StorageOptions): void {
  if (
    options.staticAwsAccessKeyId !== undefined ||
    options.staticAwsSecretAccessKey !== undefined ||
    options.awsAccessKeyId !== undefined ||
    options.awsSecretAccessKey !== undefined ||
    options.AWS_ACCESS_KEY_ID !== undefined ||
    options.AWS_SECRET_ACCESS_KEY !== undefined
  ) {
    throw new Error('Static AWS credentials are not supported. Use GitHub OIDC to assume the provisioned role.')
  }
}

function buildVariables(manifest: StorageManifest): readonly {name: string; value: string}[] {
  return [
    {name: STORAGE_VARIABLE_NAMES.roleToAssume, value: manifest.role_arn},
    {name: STORAGE_VARIABLE_NAMES.bucket, value: manifest.bucket},
    {name: STORAGE_VARIABLE_NAMES.region, value: manifest.bucket_region},
    {name: STORAGE_VARIABLE_NAMES.prefix, value: manifest.s3_prefix},
    {name: STORAGE_VARIABLE_NAMES.expectedBucketOwner, value: manifest.expected_bucket_owner},
  ]
}

/**
 * Performs every fail-closed check without writing a GitHub value. Agent setup
 * uses this phase before model-credential setup so a failed storage preflight
 * cannot leave a partially opted-in repository behind.
 */
export async function prepareStorageSetup(
  repo: string,
  options: StorageOptions,
  deps: StorageSetupDeps = {},
): Promise<PreparedStorageSetup> {
  assertRepoFormat(repo)
  assertNoStaticCredentials(options)

  const loadManifest = deps.readManifest ?? readManifest
  const rawManifest = await loadManifest(options.manifest ?? '-')
  const manifest = parseManifest(rawManifest)
  await verifyRepoIdentity(repo, manifest, deps.runGh ?? runGh)

  const verifyResources =
    deps.verifyResources ?? ((value: StorageManifest) => verifyProvisionedResources(value, deps.runAws))
  await verifyResources(manifest)
  await verifyOidcSubject(repo, deps.runGh ?? runGh)

  return {repo, manifest, variables: buildVariables(manifest)}
}

export async function applyStorageSetup(prepared: PreparedStorageSetup, deps: StorageSetupDeps = {}): Promise<void> {
  const apply = deps.applyGhValue ?? applyGhValue
  for (const variable of prepared.variables) {
    await apply('variable', variable.name, prepared.repo, variable.value)
  }

  // Unit 7 attaches the effective-job-graph verifier at this explicit seam.
  // Until then, storage wiring remains usable without pretending the workflow
  // graph has been verified.
  if (deps.verifyWorkflow) {
    await deps.verifyWorkflow(prepared.repo, prepared.manifest)
  }
}

export async function runStorageSetup(
  repo: string,
  options: StorageOptions = {},
  deps: StorageSetupDeps = {},
): Promise<void> {
  const prepared = await prepareStorageSetup(repo, options, deps)
  await applyStorageSetup(prepared, deps)
}

/**
 * Standalone opt-in command. `agent setup` can also pass `storage` through its
 * programmatic entrypoint; this command provides the CLI surface without
 * duplicating the model-credential setup options owned by setup-core.
 */
export function registerAgentStorageCommand(cli: ReturnType<typeof goke>): void {
  cli
    .command('agent storage', 'Verify the provisioned S3 handoff and wire non-secret GitHub storage variables.')
    .option('--repo [repo]', z.string().describe('Target GitHub repository in owner/repo format.'))
    .option(
      '--manifest [manifest]',
      z.string().default('-').describe('Handoff manifest path, or - to read JSON from stdin.'),
    )
    .example('infra agent storage --repo owner/repo --manifest handoff.json')
    .example('cat handoff.json | infra agent storage --repo owner/repo --manifest -')
    .action(async options => {
      if (!options.repo) {
        throw new Error('--repo is required for agent storage.')
      }
      await runStorageSetup(options.repo, {manifest: options.manifest ?? '-'})
      log.success(`S3 storage variables wired for ${options.repo}.`)
    })
}
