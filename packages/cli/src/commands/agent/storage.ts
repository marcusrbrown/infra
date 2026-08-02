/// <reference types="bun" />

import type {goke} from 'goke'

import {log} from '@clack/prompts'
import {z} from 'zod'

import {applyGhValue, runCommand, runGh, type CommandResult} from './setup-core/gh'
import {verifyWorkflow} from './workflow-verify'

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

/** Must match apps/agent/src/key-layout.ts KEY_LAYOUT_VERSION. Unknown layouts fail closed. */
export const KNOWN_KEY_LAYOUT_VERSION = 'fro-bot/agent@v0.96.0'

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
  /** Verify all preconditions and report writes without mutating GitHub. */
  plan?: boolean
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

export interface StorageTeardownOptions extends StorageOptions {
  purgeState?: boolean
  plan?: boolean
}

export interface StorageSetupDeps {
  runGh?: typeof runGh
  applyGhValue?: typeof applyGhValue
  readManifest?: (source: string) => Promise<string>
  verifyResources?: (manifest: StorageManifest) => Promise<void>
  runAws?: (args: string[]) => Promise<CommandResult>
  runAwsCommand?: AwsCommandRunner
  /** Explicit test/operator override; production defaults to the effective-job-graph verifier. */
  verifyWorkflow?: (repo: string, manifest: StorageManifest) => Promise<void>
  /** Injected provisioner boundary used by teardown tests and operator wrappers. */
  runProvisioner?: (manifest: string, options: {purgeState?: boolean; plan?: boolean}) => Promise<void>
  log?: (message: string) => void
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
  if (manifest.key_layout_version !== KNOWN_KEY_LAYOUT_VERSION) {
    throw new Error(
      `Unknown handoff manifest key_layout_version '${manifest.key_layout_version}'; expected ${KNOWN_KEY_LAYOUT_VERSION}.`,
    )
  }
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

async function runAwsCommand(
  args: string[],
  env: Record<string, string>,
  redactValues: readonly string[],
): Promise<CommandResult> {
  return runCommand('aws', args, undefined, undefined, env, redactValues)
}

type AwsCommandRunner = typeof runAwsCommand

const AWS_CHILD_LOCALE_KEYS = new Set(['LANG', 'LANGUAGE'])

/**
 * Build the least-privileged environment used by the local AWS readback.
 * Dedicated operator credentials are required; the parent process environment
 * is never passed through wholesale.
 *
 * @internal
 */
export function buildAwsChildEnv(
  manifest: StorageManifest,
  sourceEnv: Record<string, string | undefined> = process.env,
): Record<string, string> {
  const accessKeyId = sourceEnv.AGENT_AWS_ACCESS_KEY_ID?.trim()
  const secretAccessKey = sourceEnv.AGENT_AWS_SECRET_ACCESS_KEY?.trim()
  if (!accessKeyId || !secretAccessKey) {
    throw new Error(
      'Dedicated AWS credentials are required for agent storage preflight. Set AGENT_AWS_ACCESS_KEY_ID and AGENT_AWS_SECRET_ACCESS_KEY in the operator-local environment.',
    )
  }

  const childEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (
      value !== undefined &&
      (key === 'PATH' || key === 'HOME' || key === 'TMPDIR' || AWS_CHILD_LOCALE_KEYS.has(key) || key.startsWith('LC_'))
    ) {
      childEnv[key] = value
    }
  }

  childEnv.AWS_CONFIG_FILE = '/dev/null'
  childEnv.AWS_SHARED_CREDENTIALS_FILE = '/dev/null'
  childEnv.AWS_ACCESS_KEY_ID = accessKeyId
  childEnv.AWS_SECRET_ACCESS_KEY = secretAccessKey
  childEnv.AWS_REGION = sourceEnv.AGENT_AWS_REGION?.trim() || manifest.bucket_region
  childEnv.AWS_DEFAULT_REGION = childEnv.AWS_REGION

  const sessionToken = sourceEnv.AGENT_AWS_SESSION_TOKEN?.trim()
  if (sessionToken) childEnv.AWS_SESSION_TOKEN = sessionToken

  return childEnv
}

async function runProvisionerCommand(manifest: string, options: {purgeState?: boolean; plan?: boolean}): Promise<void> {
  const args = ['run', 'provision:agent', '--', '--teardown', '--manifest', '-']
  if (options.purgeState) args.push('--purge-state')
  if (options.plan) args.push('--plan')

  const child = Bun.spawn(['bun', ...args], {
    stdin: new Blob([manifest]).stream(),
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(`Agent storage provisioner teardown failed: ${stderr.trim() || stdout.trim()}`.trim())
  }
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
  runAws?: (args: string[]) => Promise<CommandResult>,
  awsCommand: AwsCommandRunner = runAwsCommand,
): Promise<void> {
  let executeAws: (args: string[]) => Promise<CommandResult>
  if (runAws) {
    executeAws = runAws
  } else {
    const awsEnv = buildAwsChildEnv(manifest)
    const redactValues = [awsEnv.AWS_ACCESS_KEY_ID, awsEnv.AWS_SECRET_ACCESS_KEY, awsEnv.AWS_SESSION_TOKEN].filter(
      (value): value is string => value !== undefined && value.length > 0,
    )
    executeAws = (args: string[]) => awsCommand(args, awsEnv, redactValues)
  }
  const roleResult = await executeAws([
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

  const bucketResult = await executeAws([
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

  const locationResult = await executeAws([
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
    deps.verifyResources ??
    ((value: StorageManifest) => verifyProvisionedResources(value, deps.runAws, deps.runAwsCommand))
  await verifyResources(manifest)
  await verifyOidcSubject(repo, deps.runGh ?? runGh)
  const verifyWorkflowSetup =
    deps.verifyWorkflow ??
    ((value: string, handoff: StorageManifest) => verifyWorkflow(value, handoff, {runGh: deps.runGh}))
  await verifyWorkflowSetup(repo, manifest)

  return {repo, manifest, variables: buildVariables(manifest)}
}

export async function applyStorageSetup(prepared: PreparedStorageSetup, deps: StorageSetupDeps = {}): Promise<void> {
  const apply = deps.applyGhValue ?? applyGhValue
  const writtenNames: string[] = []
  try {
    for (const variable of prepared.variables) {
      await apply('variable', variable.name, prepared.repo, variable.value)
      writtenNames.push(variable.name)
    }
  } catch (error) {
    const partial = writtenNames.length > 0 ? writtenNames.join(', ') : 'none'
    throw new Error(`Repository left partially wired: ${partial}. ${extractErrorMessage(error)}`)
  }
}

export async function runStorageSetup(
  repo: string,
  options: StorageOptions = {},
  deps: StorageSetupDeps = {},
): Promise<void> {
  const prepared = await prepareStorageSetup(repo, options, deps)
  if (options.plan) {
    const report = deps.log ?? (message => log.info(message))
    for (const variable of prepared.variables) {
      report(`Would write GitHub variable ${variable.name} to ${prepared.repo}.`)
    }
    return
  }
  await applyStorageSetup(prepared, deps)
}

function parseGhVariableNames(result: CommandResult, repo: string): string[] {
  if (result.exitCode !== 0) {
    throw new Error(`Unable to list GitHub variables for ${repo}. ${result.stderr.trim()}`.trim())
  }

  try {
    const parsed: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(parsed)) throw new Error('response was not an array')
    return parsed.flatMap(entry => {
      if (typeof entry !== 'object' || entry === null || !('name' in entry) || typeof entry.name !== 'string') {
        throw new Error('response contained an invalid variable name')
      }
      return [entry.name]
    })
  } catch (error) {
    throw new Error(`GitHub variable list for ${repo} returned malformed JSON: ${extractErrorMessage(error)}`)
  }
}

/** Removes only the five S3 variables owned by this command. */
export async function unwireStorageVariables(
  repo: string,
  deps: Pick<StorageSetupDeps, 'runGh' | 'log'> & {plan?: boolean} = {},
): Promise<void> {
  assertRepoFormat(repo)
  const gh = deps.runGh ?? runGh
  const result = await gh(['variable', 'list', '--repo', repo, '--json', 'name'])
  const existingNames = parseGhVariableNames(result, repo)
  const namesToDelete = Object.values(STORAGE_VARIABLE_NAMES).filter(name => existingNames.includes(name))

  for (const name of namesToDelete) {
    if (deps.plan) {
      deps.log?.(`Would delete GitHub variable ${name} from ${repo}.`)
      continue
    }
    const deleteResult = await gh(['variable', 'delete', name, '--repo', repo, '--yes'])
    if (
      deleteResult &&
      deleteResult.exitCode !== 0 &&
      !/not found|does not exist|could not find/i.test(deleteResult.stderr)
    ) {
      throw new Error(`gh variable delete ${name} failed: ${deleteResult.stderr.trim()}`.trim())
    }
  }
}

export async function runStorageTeardown(
  repo: string,
  options: StorageTeardownOptions = {},
  deps: StorageSetupDeps = {},
): Promise<void> {
  assertRepoFormat(repo)
  assertNoStaticCredentials(options)

  const loadManifest = deps.readManifest ?? readManifest
  const rawManifest = await loadManifest(options.manifest ?? '-')
  const manifest = parseManifest(rawManifest)
  await verifyRepoIdentity(repo, manifest, deps.runGh ?? runGh)

  if (options.plan) {
    await unwireStorageVariables(repo, {runGh: deps.runGh, log: deps.log, plan: true})
  } else {
    await unwireStorageVariables(repo, {runGh: deps.runGh})
  }

  const runProvisioner = deps.runProvisioner ?? runProvisionerCommand
  await runProvisioner(rawManifest, {purgeState: options.purgeState, plan: options.plan ?? false})
}

/**
 * Standalone opt-in command. `agent setup` can also pass `storage` through its
 * programmatic entrypoint; this command provides the CLI surface without
 * duplicating the model-credential setup options owned by setup-core.
 */
export function registerAgentStorageCommand(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'agent storage',
      'Verify the provisioned S3 handoff and wire non-secret GitHub storage variables. AWS readback requires AGENT_AWS_ACCESS_KEY_ID and AGENT_AWS_SECRET_ACCESS_KEY and ignores ambient AWS_* values.',
    )
    .option('--repo [repo]', z.string().describe('Target GitHub repository in owner/repo format.'))
    .option(
      '--manifest [manifest]',
      z.string().default('-').describe('Handoff manifest path, or - to read JSON from stdin.'),
    )
    .option('--plan', z.boolean().optional().describe('Verify and report storage writes without mutating GitHub.'))
    .option('--dry-run', z.boolean().optional().describe('Alias for --plan.'))
    .example('infra agent storage --repo owner/repo --manifest handoff.json')
    .example('cat handoff.json | infra agent storage --repo owner/repo --manifest -')
    .action(async options => {
      if (!options.repo) {
        throw new Error('--repo is required for agent storage.')
      }
      const plan = options.plan || options.dryRun
      await runStorageSetup(options.repo, {manifest: options.manifest ?? '-', plan})
      if (plan) log.info(`S3 storage plan complete for ${options.repo}; no variables were written.`)
      else log.success(`S3 storage variables wired for ${options.repo}.`)
    })

  cli
    .command('agent storage teardown', 'Unwire S3 variables and remove the repo-scoped storage resources.')
    .option('--repo [repo]', z.string().describe('Target GitHub repository in owner/repo format.'))
    .option(
      '--manifest [manifest]',
      z.string().default('-').describe('Handoff manifest path, or - to read JSON from stdin.'),
    )
    .option(
      '--purge-state',
      z.boolean().optional().describe('Delete versioned session-prefix objects instead of retaining them.'),
    )
    .option('--plan', z.boolean().optional().describe('Read back and report teardown actions without mutating.'))
    .example('infra agent storage teardown --repo owner/repo --manifest handoff.json')
    .example('infra agent storage teardown --repo owner/repo --purge-state --manifest handoff.json')
    .action(async options => {
      if (!options.repo) {
        throw new Error('--repo is required for agent storage teardown.')
      }
      await runStorageTeardown(options.repo, {
        manifest: options.manifest ?? '-',
        purgeState: options.purgeState,
        plan: options.plan,
      })
      log.success(`S3 storage teardown completed for ${options.repo}.`)
    })
}
