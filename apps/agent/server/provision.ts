#!/usr/bin/env bun

import {
  AddClientIDToOpenIDConnectProviderCommand,
  CreateOpenIDConnectProviderCommand,
  GetOpenIDConnectProviderCommand,
  IAMClient,
  ListOpenIDConnectProvidersCommand,
} from '@aws-sdk/client-iam'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const GITHUB_OIDC_PROVIDER_URL = 'https://token.actions.githubusercontent.com'
export const GITHUB_OIDC_AUDIENCE = 'sts.amazonaws.com'
export const AGENT_AWS_ACCESS_KEY_ID = 'AGENT_AWS_ACCESS_KEY_ID'
export const AGENT_AWS_SECRET_ACCESS_KEY = 'AGENT_AWS_SECRET_ACCESS_KEY'
export const AGENT_AWS_SESSION_TOKEN = 'AGENT_AWS_SESSION_TOKEN'
export const AGENT_AWS_REGION = 'AGENT_AWS_REGION'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Narrow IAM client seam used by the provisioner and its boundary tests. */
export type IAMClientLike = Pick<IAMClient, 'send'>

export interface RedactionSecret {
  name: string
  content: string
}

export interface OidcProviderProvisionResult {
  classification: 'current' | 'absent'
  changed: boolean
  providerArn: string
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
