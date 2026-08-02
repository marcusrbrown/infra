import {unlink} from 'node:fs/promises'
import {describe, expect, it} from 'bun:test'

import {AGENT_ACTION_LAYOUT_VERSION, buildAgentKeyLayout} from '../src/key-layout'
import {
  AGENT_REPOSITORY_ID,
  AGENT_REPOSITORY_NAME,
  AGENT_REPOSITORY_OWNER,
  AGENT_REPOSITORY_OWNER_ID,
  AGENT_WORKFLOW_NAME,
  auditAgentStorageResources,
  buildAgentStoragePolicy,
  canonicalizeS3Prefix,
  createIamClientFromEnv,
  ensureAgentStateBucket,
  ensureAgentStoragePolicy,
  ensureAgentStorageRole,
  ensureGitHubOidcProvider,
  GITHUB_OIDC_AUDIENCE,
  GITHUB_OIDC_PROVIDER_URL,
  main,
  performProvisioning,
  performTeardown,
  type AgentBucketConfig,
  type AgentRepositoryConfig,
  type AgentRoleProvisionResult,
  type IAMClientLike,
  type S3ClientLike,
} from './provision'

interface CommandShape {
  constructor: {name: string}
  input: Record<string, unknown>
}

interface FakeCall {
  name: string
  input: Record<string, unknown>
}

type CommandHandler = (command: CommandShape, calls: FakeCall[]) => Promise<unknown>

function makeClient(handler: CommandHandler): {client: IAMClientLike; calls: FakeCall[]} {
  const calls: FakeCall[] = []
  const send = async (command: CommandShape): Promise<unknown> => {
    calls.push({name: command.constructor.name, input: command.input})
    return handler(command, calls)
  }

  return {
    client: {send: send as unknown as IAMClientLike['send']},
    calls,
  }
}

const roleRepository: AgentRepositoryConfig = {
  owner: 'marcusrbrown',
  repo: 'infra',
  repositoryId: '1200110668',
  repositoryOwnerId: '831617',
  workflow: 'Fro Bot',
}

const roleProviderArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'

async function ensureRoleForTest(
  client: IAMClientLike,
  options: {force?: boolean; log?: (message: string) => void} = {},
): Promise<AgentRoleProvisionResult> {
  return ensureAgentStorageRole(client, roleRepository, roleProviderArn, options)
}

function roleResponse(role: Record<string, unknown>): Record<string, unknown> {
  return {Role: role}
}

function roleFromCreateCall(input: Record<string, unknown>): Record<string, unknown> {
  const roleName = String(input.RoleName)
  return {
    Arn: `arn:aws:iam::111122223333:role/${roleName}`,
    RoleName: roleName,
    AssumeRolePolicyDocument: input.AssumeRolePolicyDocument,
    MaxSessionDuration: input.MaxSessionDuration,
    Tags: input.Tags,
  }
}

function makeRoleClient(
  options: {
    role?: Record<string, unknown>
    readbackNoSuchCount?: number
  } = {},
): {client: IAMClientLike; calls: FakeCall[]} {
  let role = options.role
  let readbackNoSuchCount = options.readbackNoSuchCount ?? 0
  let created = false

  return makeClient(async command => {
    switch (command.constructor.name) {
      case 'GetRoleCommand':
        if (!role || (created && readbackNoSuchCount > 0)) {
          if (created && readbackNoSuchCount > 0) readbackNoSuchCount -= 1
          throw namedError('NoSuchEntity', 'role does not exist yet')
        }
        return roleResponse(role)
      case 'CreateRoleCommand': {
        role = roleFromCreateCall(command.input)
        created = true
        return roleResponse(role)
      }
      case 'UpdateAssumeRolePolicyCommand':
        role = {...role, AssumeRolePolicyDocument: command.input.PolicyDocument}
        return {}
      case 'UpdateRoleCommand':
        role = {...role, MaxSessionDuration: command.input.MaxSessionDuration}
        return {}
      case 'TagRoleCommand':
        role = {...role, Tags: command.input.Tags}
        return {}
      default:
        throw new Error(`Unexpected IAM command: ${command.constructor.name}`)
    }
  })
}

function canonicalRoleTrust(): Record<string, unknown> {
  return {
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: {Federated: roleProviderArn},
        Action: 'sts:AssumeRoleWithWebIdentity',
        Condition: {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub': [
              'repo:marcusrbrown/infra:environment:fro-bot-storage',
              'repo:marcusrbrown@831617/infra@1200110668:environment:fro-bot-storage',
            ],
            'token.actions.githubusercontent.com:repository_id': '1200110668',
            'token.actions.githubusercontent.com:repository_owner_id': '831617',
            'token.actions.githubusercontent.com:ref': 'refs/heads/main',
            'token.actions.githubusercontent.com:workflow': 'Fro Bot',
          },
        },
      },
    ],
  }
}

function managedRoleTags(): Record<string, string>[] {
  return [
    {Key: 'owner', Value: roleRepository.owner},
    {Key: 'repo', Value: roleRepository.repo},
    {Key: 'repository_id', Value: roleRepository.repositoryId},
    {Key: 'repository_owner_id', Value: roleRepository.repositoryOwnerId},
    {Key: 'managed-by', Value: 'fro-bot-agent-storage'},
  ]
}

function makeS3Client(handler: CommandHandler): {client: S3ClientLike; calls: FakeCall[]} {
  const calls: FakeCall[] = []
  const send = async (command: CommandShape): Promise<unknown> => {
    calls.push({name: command.constructor.name, input: command.input})
    return handler(command, calls)
  }

  return {
    client: {send: send as unknown as S3ClientLike['send']},
    calls,
  }
}

function namedError(name: string, message = name): Error {
  const error = new Error(message)
  error.name = name
  return error
}

function lifecycleRulesFromCall(call: FakeCall | undefined): Record<string, unknown>[] | undefined {
  const lifecycleConfiguration = call?.input.LifecycleConfiguration
  if (typeof lifecycleConfiguration !== 'object' || lifecycleConfiguration === null) return undefined
  const rules = (lifecycleConfiguration as {Rules?: unknown}).Rules
  return Array.isArray(rules) ? (rules as Record<string, unknown>[]) : undefined
}

const bucketConfig: AgentBucketConfig = {
  bucket: 'fro-bot-agent-state-fixture',
  region: 'us-west-2',
  expectedBucketOwner: '111122223333',
  s3Prefix: 'fro-bot-state',
  sessionPrefix: 'fro-bot-state/github/marcusrbrown-infra/storage',
  metadataArtifactsPrefix: 'fro-bot-state/github/marcusrbrown-infra/metadata',
}

const storagePolicyConfig = {
  roleName: 'fro-bot-agent-storage-marcusrbrown-infra',
  bucket: bucketConfig.bucket,
  owner: roleRepository.owner,
  repo: roleRepository.repo,
  s3Prefix: 'fro-bot-state',
  actionVersion: AGENT_ACTION_LAYOUT_VERSION,
}

const teardownManifest = {
  owner: roleRepository.owner,
  repo: roleRepository.repo,
  repository_id: roleRepository.repositoryId,
  repository_owner_id: roleRepository.repositoryOwnerId,
  bucket: bucketConfig.bucket,
  bucket_region: bucketConfig.region,
  expected_bucket_owner: bucketConfig.expectedBucketOwner,
  s3_prefix: 'fro-bot-state',
  session_prefix: 'fro-bot-state/github/marcusrbrown-infra/storage/',
  lock_key: 'fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock',
  role_name: 'fro-bot-agent-storage-marcusrbrown-infra',
  role_arn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra',
  policy_name: 'fro-bot-agent-storage-marcusrbrown-infra',
  action_ref_verified: true as const,
  key_layout_version: AGENT_ACTION_LAYOUT_VERSION,
  oidc_provider_arn: roleProviderArn,
}

function makeTeardownClients(
  options: {
    role?: Record<string, unknown>
    policy?: string
    deletePolicyError?: Error
    deleteRoleError?: Error
    stateError?: Error
    lockError?: Error
    versionError?: Error
    versionResponses?: Record<string, unknown>[]
  } = {},
) {
  let role = options.role ?? {
    Arn: teardownManifest.role_arn,
    RoleName: teardownManifest.role_name,
    AssumeRolePolicyDocument: JSON.stringify(canonicalRoleTrust()),
    MaxSessionDuration: 7200,
    Tags: managedRoleTags(),
  }
  let policy = options.policy ?? JSON.stringify(buildAgentStoragePolicy(storagePolicyConfig).document)
  let versionResponseIndex = 0
  const iam = makeClient(async command => {
    switch (command.constructor.name) {
      case 'GetOpenIDConnectProviderCommand':
        return providerDetails(roleProviderArn)
      case 'GetRoleCommand':
        if (!role) throw namedError('NoSuchEntity')
        return roleResponse(role)
      case 'GetRolePolicyCommand':
        if (!role || !policy) throw namedError('NoSuchEntity')
        return {PolicyDocument: encodeURIComponent(policy)}
      case 'DeleteRolePolicyCommand':
        policy = ''
        if (options.deletePolicyError) throw options.deletePolicyError
        return {}
      case 'DeleteRoleCommand':
        role = undefined as unknown as Record<string, unknown>
        if (options.deleteRoleError) throw options.deleteRoleError
        return {}
      default:
        throw new Error(`Unexpected IAM teardown command: ${command.constructor.name}`)
    }
  })

  const deletedObjects: Record<string, unknown>[] = []
  const s3 = makeS3Client(async command => {
    switch (command.constructor.name) {
      case 'HeadBucketCommand':
        return {BucketRegion: bucketConfig.region, BucketOwner: bucketConfig.expectedBucketOwner}
      case 'DeleteObjectCommand':
        if (options.lockError ?? options.stateError) throw options.lockError ?? options.stateError
        deletedObjects.push(command.input)
        return {}
      case 'ListObjectVersionsCommand':
        if (options.versionError ?? options.stateError) throw options.versionError ?? options.stateError
        return (
          options.versionResponses?.[versionResponseIndex++] ?? {
            Versions: [
              {Key: `${teardownManifest.session_prefix}session.json`, VersionId: 'v1'},
              {Key: `${teardownManifest.session_prefix}session.json`, VersionId: 'v2', IsLatest: true},
            ],
            DeleteMarkers: [{Key: `${teardownManifest.session_prefix}deleted.json`, VersionId: 'd1'}],
          }
        )
      case 'DeleteObjectsCommand':
        deletedObjects.push(command.input)
        return {}
      default:
        throw new Error(`Unexpected S3 teardown command: ${command.constructor.name}`)
    }
  })

  return {iam, s3, deletedObjects}
}

function teardownRepository(): AgentRepositoryConfig {
  return roleRepository
}

const canonicalLifecycleRules = [
  {
    ID: 'fro-bot-agent-session-90d',
    Filter: {Prefix: 'fro-bot-state/github/marcusrbrown-infra/storage/'},
    Status: 'Enabled',
    Expiration: {Days: 90},
  },
  {
    ID: 'fro-bot-agent-metadata-30d',
    Filter: {Prefix: 'fro-bot-state/github/marcusrbrown-infra/metadata/'},
    Status: 'Enabled',
    Expiration: {Days: 30},
  },
  {
    ID: 'fro-bot-agent-noncurrent-30d',
    Status: 'Enabled',
    NoncurrentVersionExpiration: {NoncurrentDays: 30},
  },
  {
    ID: 'fro-bot-agent-abort-mpu-7d',
    Status: 'Enabled',
    AbortIncompleteMultipartUpload: {DaysAfterInitiation: 7},
  },
]

function makeCurrentBucketClient(
  options: {
    bucketRegion?: string
    lifecycleRules?: Record<string, unknown>[]
    publicAccessBlock?: Record<string, unknown> | null
    versioningStatus?: string | null
    encryptionAlgorithm?: string | null
    policy?: string | null
    headError?: Error
    readbackMismatch?: boolean
  } = {},
): {client: S3ClientLike; calls: FakeCall[]} {
  let bucketExists = options.headError === undefined
  let publicAccessBlock =
    options.publicAccessBlock === undefined
      ? {
          BlockPublicAcls: true,
          IgnorePublicAcls: true,
          BlockPublicPolicy: true,
          RestrictPublicBuckets: true,
        }
      : options.publicAccessBlock
  let versioningStatus = options.versioningStatus === undefined ? 'Enabled' : options.versioningStatus
  let encryptionAlgorithm = options.encryptionAlgorithm === undefined ? 'AES256' : options.encryptionAlgorithm
  let policy =
    options.policy === undefined
      ? JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Sid: 'DenyInsecureTransport',
              Effect: 'Deny',
              Principal: '*',
              Action: 's3:*',
              Resource: [`arn:aws:s3:::${bucketConfig.bucket}`, `arn:aws:s3:::${bucketConfig.bucket}/*`],
              Condition: {Bool: {'aws:SecureTransport': 'false'}},
            },
          ],
        })
      : options.policy
  let lifecycleRules = options.lifecycleRules ?? canonicalLifecycleRules

  return makeS3Client(async command => {
    switch (command.constructor.name) {
      case 'HeadBucketCommand':
        if (options.headError && !bucketExists) throw options.headError
        return {BucketRegion: options.bucketRegion ?? bucketConfig.region}
      case 'CreateBucketCommand':
        bucketExists = true
        return {}
      case 'GetPublicAccessBlockCommand':
        if (!publicAccessBlock) throw namedError('NoSuchPublicAccessBlockConfiguration')
        return {
          PublicAccessBlockConfiguration: options.readbackMismatch
            ? {...publicAccessBlock, RestrictPublicBuckets: false}
            : publicAccessBlock,
        }
      case 'PutPublicAccessBlockCommand':
        publicAccessBlock = command.input.PublicAccessBlockConfiguration as Record<string, unknown>
        return {}
      case 'GetBucketVersioningCommand':
        return {Status: versioningStatus ?? undefined}
      case 'PutBucketVersioningCommand':
        versioningStatus = 'Enabled'
        return {}
      case 'GetBucketEncryptionCommand':
        if (!encryptionAlgorithm) throw namedError('ServerSideEncryptionConfigurationNotFoundError')
        return {
          ServerSideEncryptionConfiguration: {
            Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: encryptionAlgorithm}}],
          },
        }
      case 'PutBucketEncryptionCommand':
        encryptionAlgorithm = 'AES256'
        return {}
      case 'GetBucketPolicyCommand':
        if (!policy) throw namedError('NoSuchBucketPolicy')
        return {Policy: policy}
      case 'PutBucketPolicyCommand':
        policy = String(command.input.Policy)
        return {}
      case 'GetBucketLifecycleConfigurationCommand':
        return {Rules: lifecycleRules}
      case 'PutBucketLifecycleConfigurationCommand':
        lifecycleRules = lifecycleRulesFromCall({name: command.constructor.name, input: command.input}) ?? []
        return {}
      default:
        throw new Error(`Unexpected S3 command: ${command.constructor.name}`)
    }
  })
}

function providerDetails(arn: string, clientIds: string[] = [GITHUB_OIDC_AUDIENCE]): Record<string, unknown> {
  return {
    Url: GITHUB_OIDC_PROVIDER_URL,
    ClientIDList: clientIds,
    ThumbprintList: ['bounded-fixture-thumbprint'],
    CreateDate: new Date('2026-08-01T00:00:00.000Z'),
    Arn: arn,
  }
}

function listResponse(...arns: string[]): Record<string, unknown> {
  return {
    OpenIDConnectProviderList: arns.map(Arn => ({Arn})),
  }
}

describe('GitHub OIDC provider provisioning', () => {
  it('creates the provider with the canonical URL and STS audience when absent', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse()
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        return {OpenIDConnectProviderArn: providerArn}
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'absent', changed: true, providerArn})
    const create = calls.find(call => call.name === 'CreateOpenIDConnectProviderCommand')
    expect(create?.input).toEqual({
      Url: GITHUB_OIDC_PROVIDER_URL,
      ClientIDList: [GITHUB_OIDC_AUDIENCE],
    })
  })

  it('does not mutate a provider that already has the STS audience', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: false, providerArn})
    expect(calls.map(call => call.name)).toEqual([
      'ListOpenIDConnectProvidersCommand',
      'GetOpenIDConnectProviderCommand',
      'GetOpenIDConnectProviderCommand',
    ])
  })

  it('appends the STS audience without recreating or changing thumbprints', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let getCount = 0
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        getCount += 1
        return providerDetails(
          providerArn,
          getCount === 1 ? ['other-audience'] : ['other-audience', GITHUB_OIDC_AUDIENCE],
        )
      }
      if (command.constructor.name === 'AddClientIDToOpenIDConnectProviderCommand') return {}
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: true, providerArn})
    expect(calls.find(call => call.name === 'AddClientIDToOpenIDConnectProviderCommand')?.input).toEqual({
      OpenIDConnectProviderArn: providerArn,
      ClientID: GITHUB_OIDC_AUDIENCE,
    })
    expect(calls.some(call => call.name === 'CreateOpenIDConnectProviderCommand')).toBe(false)
    expect(calls.some(call => call.name === 'UpdateOpenIDConnectProviderThumbprintCommand')).toBe(false)
  })

  it('halts when more than one canonical GitHub provider is present', async () => {
    const firstArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com-1'
    const secondArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com-2'
    const {client} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(firstArn, secondArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        return providerDetails(command.input.OpenIDConnectProviderArn === firstArn ? firstArn : secondArn)
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    await expect(ensureGitHubOidcProvider(client)).rejects.toThrow(/multiple.*GitHub OIDC providers/i)
  })

  it('halts on URL drift for an ARN that claims the canonical GitHub provider', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') {
        return {
          ...providerDetails(providerArn),
          Url: 'https://malicious.example.invalid',
        }
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    await expect(ensureGitHubOidcProvider(client)).rejects.toThrow(/URL drifted/i)
    expect(calls.some(call => call.name === 'CreateOpenIDConnectProviderCommand')).toBe(false)
  })

  it('confirms the canonical provider after an EntityAlreadyExists create race', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let listCount = 0
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') {
        listCount += 1
        return listCount === 1 ? listResponse() : listResponse(providerArn)
      }
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        const error = new Error('Provider already exists')
        error.name = 'EntityAlreadyExists'
        throw error
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })

    const result = await ensureGitHubOidcProvider(client)

    expect(result).toEqual({classification: 'current', changed: false, providerArn})
    expect(calls.map(call => call.name)).toEqual([
      'ListOpenIDConnectProvidersCommand',
      'CreateOpenIDConnectProviderCommand',
      'ListOpenIDConnectProvidersCommand',
      'GetOpenIDConnectProviderCommand',
      'GetOpenIDConnectProviderCommand',
    ])
  })

  it('fails closed when only ambient AWS credentials are present', () => {
    expect(() =>
      createIamClientFromEnv({
        AWS_ACCESS_KEY_ID: 'ambient-access-key-fixture',
        AWS_SECRET_ACCESS_KEY: 'ambient-secret-fixture',
      }),
    ).toThrow(/Missing dedicated.*AGENT_AWS_ACCESS_KEY_ID.*AGENT_AWS_SECRET_ACCESS_KEY/i)
  })

  it('emits the handoff manifest with the OIDC provider ARN populated', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let role: Record<string, unknown> | undefined
    let policy: string | undefined
    const {client} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse()
      if (command.constructor.name === 'CreateOpenIDConnectProviderCommand') {
        return {OpenIDConnectProviderArn: providerArn}
      }
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      if (command.constructor.name === 'GetRoleCommand') {
        if (!role) throw namedError('NoSuchEntity')
        return roleResponse(role)
      }
      if (command.constructor.name === 'CreateRoleCommand') {
        role = roleFromCreateCall(command.input)
        return roleResponse(role)
      }
      if (command.constructor.name === 'GetRolePolicyCommand') {
        if (!policy) throw namedError('NoSuchEntity')
        return {PolicyDocument: encodeURIComponent(policy)}
      }
      if (command.constructor.name === 'PutRolePolicyCommand') {
        policy = String(command.input.PolicyDocument)
        return {}
      }
      throw new Error(`Unexpected command: ${command.constructor.name}`)
    })
    const lines: string[] = []
    const {client: s3Client} = makeCurrentBucketClient()

    await performProvisioning({
      client,
      s3Client,
      bucket: bucketConfig,
      repository: roleRepository,
      actionRef: AGENT_ACTION_LAYOUT_VERSION,
      printLine: (line: string) => lines.push(line),
    })

    expect(lines).toHaveLength(1)
    const manifest = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(manifest.oidc_provider_arn).toBe(providerArn)
    expect(manifest.owner).toBe(roleRepository.owner)
    expect(manifest.repo).toBe(roleRepository.repo)
    expect(manifest.repository_id).toBe(roleRepository.repositoryId)
    expect(manifest.repository_owner_id).toBe(roleRepository.repositoryOwnerId)
    expect(manifest.role_name).toBe('fro-bot-agent-storage-marcusrbrown-infra')
    expect(manifest.role_arn).toBe('arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra')
    expect(manifest.lock_key).toBe('fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock')
    expect(manifest.policy_name).toBe('fro-bot-agent-storage-marcusrbrown-infra')
    expect(manifest.action_ref_verified).toBe(true)
    expect(manifest.key_layout_version).toBe(AGENT_ACTION_LAYOUT_VERSION)
    expect(Object.keys(manifest)).toEqual(
      expect.arrayContaining([
        'owner',
        'repo',
        'repository_id',
        'repository_owner_id',
        'bucket',
        'bucket_region',
        'expected_bucket_owner',
        's3_prefix',
        'session_prefix',
        'lock_key',
        'role_name',
        'role_arn',
        'policy_name',
        'action_ref_verified',
        'key_layout_version',
        'oidc_provider_arn',
      ]),
    )
  })

  it('fails closed when bucket configuration is missing', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      throw new Error(`Unexpected IAM command: ${command.constructor.name}`)
    })
    const s3 = makeS3Client(async command => {
      throw new Error(`Unexpected S3 call: ${command.constructor.name}`)
    })

    await expect(
      performProvisioning({client, env: {}, repository: roleRepository, s3Client: s3.client}),
    ).rejects.toThrow(/agent S3.*configuration|bucket/i)
    expect(calls).toEqual([])
    expect(s3.calls).toEqual([])
  })

  it('fails closed on an unknown action layout before applying any AWS policy', async () => {
    const {client, calls} = makeClient(async command => {
      throw new Error(`Unexpected AWS call: ${command.constructor.name}`)
    })

    await expect(
      performProvisioning({
        client,
        bucket: bucketConfig,
        repository: roleRepository,
        actionRef: 'fro-bot/agent@v0.0.0',
      }),
    ).rejects.toThrow(/unknown|unverified|widen/i)
    expect(calls).toEqual([])
  })

  it('populates bucket handoff fields from the verified S3 configuration', async () => {
    const providerArn = 'arn:aws:iam::111122223333:oidc-provider/token.actions.githubusercontent.com'
    let role: Record<string, unknown> | undefined
    let policy: string | undefined
    const {client: iamClient} = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      if (command.constructor.name === 'GetRoleCommand') {
        if (!role) throw namedError('NoSuchEntity')
        return roleResponse(role)
      }
      if (command.constructor.name === 'CreateRoleCommand') {
        role = roleFromCreateCall(command.input)
        return roleResponse(role)
      }
      if (command.constructor.name === 'GetRolePolicyCommand') {
        if (!policy) throw namedError('NoSuchEntity')
        return {PolicyDocument: encodeURIComponent(policy)}
      }
      if (command.constructor.name === 'PutRolePolicyCommand') {
        policy = String(command.input.PolicyDocument)
        return {}
      }
      throw new Error(`Unexpected IAM command: ${command.constructor.name}`)
    })
    const {client: s3Client} = makeCurrentBucketClient()
    const lines: string[] = []

    await performProvisioning({
      client: iamClient,
      s3Client,
      bucket: bucketConfig,
      repository: roleRepository,
      actionRef: AGENT_ACTION_LAYOUT_VERSION,
      printLine: (line: string) => lines.push(line),
    })

    const manifest = JSON.parse(lines[0] ?? '') as Record<string, unknown>
    expect(manifest.bucket).toBe(bucketConfig.bucket)
    expect(manifest.bucket_region).toBe(bucketConfig.region)
    expect(manifest.expected_bucket_owner).toBe(bucketConfig.expectedBucketOwner)
    expect(manifest.s3_prefix).toBe('fro-bot-state')
    expect(manifest.session_prefix).toBe('fro-bot-state/github/marcusrbrown-infra/storage/')
    expect(String(manifest.s3_prefix).endsWith('/')).toBe(false)
    const rebuiltLayout = buildAgentKeyLayout(
      String(manifest.owner),
      String(manifest.repo),
      String(manifest.s3_prefix),
      String(manifest.key_layout_version),
    )
    expect(rebuiltLayout.sessionPrefix).toBe(String(manifest.session_prefix))
    expect(rebuiltLayout.lockKey).toBe(String(manifest.lock_key))
  })

  it('reports a provisioning plan without issuing mutating AWS commands', async () => {
    const providerArn = roleProviderArn
    const iamRole = {
      Arn: teardownManifest.role_arn,
      RoleName: teardownManifest.role_name,
      AssumeRolePolicyDocument: JSON.stringify(canonicalRoleTrust()),
      MaxSessionDuration: 7200,
      Tags: managedRoleTags(),
    }
    const iam = makeClient(async command => {
      if (command.constructor.name === 'ListOpenIDConnectProvidersCommand') return listResponse(providerArn)
      if (command.constructor.name === 'GetOpenIDConnectProviderCommand') return providerDetails(providerArn)
      if (command.constructor.name === 'GetRoleCommand') return roleResponse(iamRole)
      if (command.constructor.name === 'GetRolePolicyCommand') {
        return {
          PolicyDocument: encodeURIComponent(JSON.stringify(buildAgentStoragePolicy(storagePolicyConfig).document)),
        }
      }
      throw new Error(`Unexpected IAM plan command: ${command.constructor.name}`)
    })
    const s3 = makeCurrentBucketClient()
    const report: string[] = []

    await performProvisioning({
      client: iam.client,
      s3Client: s3.client,
      bucket: bucketConfig,
      repository: roleRepository,
      actionRef: AGENT_ACTION_LAYOUT_VERSION,
      plan: true,
      printLine: line => report.push(line),
    })

    expect(report.join('\n')).toMatch(/plan.*(current|would)/i)
    expect(iam.calls.some(call => /^(?:Create|Put|Update|Tag|Add|Delete)/.test(call.name))).toBe(false)
    expect(s3.calls.some(call => /^(?:Create|Put|Update|Delete)/.test(call.name))).toBe(false)
  })

  it('plans absent IAM role and inline policy reported as NoSuchEntityException', async () => {
    const iam = makeClient(async command => {
      switch (command.constructor.name) {
        case 'ListOpenIDConnectProvidersCommand':
          return listResponse(roleProviderArn)
        case 'GetOpenIDConnectProviderCommand':
          return providerDetails(roleProviderArn)
        case 'GetRoleCommand':
          throw namedError('NoSuchEntityException', 'role does not exist')
        case 'GetRolePolicyCommand':
          throw namedError('NoSuchEntityException', 'inline policy does not exist')
        default:
          throw new Error(`Unexpected IAM plan command: ${command.constructor.name}`)
      }
    })
    const s3 = makeCurrentBucketClient()
    const report: string[] = []

    await performProvisioning({
      client: iam.client,
      s3Client: s3.client,
      bucket: bucketConfig,
      repository: roleRepository,
      actionRef: AGENT_ACTION_LAYOUT_VERSION,
      plan: true,
      printLine: line => report.push(line),
    })

    expect(report.join('\n')).toMatch(/would create IAM role fro-bot-agent-storage-marcusrbrown-infra/i)
    expect(report.join('\n')).toMatch(/would attach IAM inline policy fro-bot-agent-storage-marcusrbrown-infra/i)
    expect(iam.calls.some(call => /^(?:Create|Put|Update|Tag|Add|Delete)/.test(call.name))).toBe(false)
    expect(s3.calls.some(call => /^(?:Create|Put|Update|Delete)/.test(call.name))).toBe(false)
  })
})

describe('per-repo IAM role provisioning', () => {
  it('creates a role with both pinned environment subjects, claim conditions, tags, and STS headroom', async () => {
    const {client, calls} = makeRoleClient()

    await ensureRoleForTest(client)

    const create = calls.find(call => call.name === 'CreateRoleCommand')
    expect(create?.input.RoleName).toBe('fro-bot-agent-storage-marcusrbrown-infra')
    expect(create?.input.MaxSessionDuration).toBeGreaterThanOrEqual(7200)
    expect(create?.input.Tags).toEqual(expect.arrayContaining(managedRoleTags()))

    const trust = JSON.parse(String(create?.input.AssumeRolePolicyDocument)) as {
      Statement: {
        Principal: {Federated: string}
        Condition: {StringEquals: Record<string, unknown>}
      }[]
    }
    const statement = trust.Statement[0]
    const conditions = statement?.Condition.StringEquals
    expect(statement?.Principal.Federated).toBe(roleProviderArn)
    expect(conditions?.['token.actions.githubusercontent.com:aud']).toBe('sts.amazonaws.com')
    expect(conditions?.['token.actions.githubusercontent.com:repository_id']).toBe('1200110668')
    expect(conditions?.['token.actions.githubusercontent.com:repository_owner_id']).toBe('831617')
    expect(conditions?.['token.actions.githubusercontent.com:ref']).toBe('refs/heads/main')
    expect(conditions?.['token.actions.githubusercontent.com:workflow']).toBe('Fro Bot')
    expect(conditions?.['token.actions.githubusercontent.com:sub']).toEqual([
      'repo:marcusrbrown/infra:environment:fro-bot-storage',
      'repo:marcusrbrown@831617/infra@1200110668:environment:fro-bot-storage',
    ])
    expect(JSON.stringify(conditions?.['token.actions.githubusercontent.com:sub'])).not.toContain('repo:marcusrbrown/*')
  })

  it('does not mutate an existing role when trust, tags, and session duration are current', async () => {
    const {client, calls} = makeRoleClient({
      role: {
        Arn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra',
        RoleName: 'fro-bot-agent-storage-marcusrbrown-infra',
        AssumeRolePolicyDocument: JSON.stringify(canonicalRoleTrust()),
        MaxSessionDuration: 7200,
        Tags: managedRoleTags(),
      },
    })

    const result = await ensureRoleForTest(client)

    expect(result).toEqual({
      classification: 'current',
      changed: false,
      roleName: 'fro-bot-agent-storage-marcusrbrown-infra',
      roleArn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra',
    })
    expect(calls.map(call => call.name)).toEqual(['GetRoleCommand'])
  })

  it('warns and halts on managed trust drift, then updates only with force', async () => {
    const driftedTrust = canonicalRoleTrust()
    const statement = (driftedTrust.Statement as Record<string, unknown>[])[0]
    const condition = statement?.Condition as {StringEquals: Record<string, unknown>}
    condition.StringEquals['token.actions.githubusercontent.com:ref'] = 'refs/heads/release'
    const {client, calls} = makeRoleClient({
      role: {
        Arn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra',
        RoleName: 'fro-bot-agent-storage-marcusrbrown-infra',
        AssumeRolePolicyDocument: JSON.stringify(driftedTrust),
        MaxSessionDuration: 7200,
        Tags: managedRoleTags(),
      },
    })
    const warnings: string[] = []

    await expect(ensureRoleForTest(client, {log: message => warnings.push(message)})).rejects.toThrow(/managed drift/i)
    expect(warnings.some(message => /trust/i.test(message))).toBe(true)
    expect(calls.map(call => call.name)).toEqual(['GetRoleCommand'])

    await ensureRoleForTest(client, {force: true})
    expect(calls.map(call => call.name)).toEqual([
      'GetRoleCommand',
      'GetRoleCommand',
      'UpdateAssumeRolePolicyCommand',
      'GetRoleCommand',
    ])
  })

  it('retries role readback after create until IAM eventual consistency converges', async () => {
    const {client, calls} = makeRoleClient({readbackNoSuchCount: 2})

    const result = await ensureRoleForTest(client)

    expect(result).toEqual({
      classification: 'absent',
      changed: true,
      roleName: 'fro-bot-agent-storage-marcusrbrown-infra',
      roleArn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-marcusrbrown-infra',
    })
    expect(calls.map(call => call.name)).toEqual([
      'GetRoleCommand',
      'CreateRoleCommand',
      'GetRoleCommand',
      'GetRoleCommand',
      'GetRoleCommand',
    ])
  })
})

describe('per-repo IAM storage policy', () => {
  it('grants session access and lock access only at their canonical boundaries', () => {
    const built = buildAgentStoragePolicy(storagePolicyConfig)
    const statements = built.document.Statement as Record<string, unknown>[]
    const sessionAllow = statements.find(statement => statement.Sid === 'AllowSessionObjects')
    const lockAllow = statements.find(statement => statement.Sid === 'AllowCoordinationLock')

    expect(sessionAllow).toEqual({
      Sid: 'AllowSessionObjects',
      Effect: 'Allow',
      Action: ['s3:GetObject', 's3:PutObject'],
      Resource: ['arn:aws:s3:::fro-bot-agent-state-fixture/fro-bot-state/github/marcusrbrown-infra/storage/*'],
    })
    expect(lockAllow).toEqual({
      Sid: 'AllowCoordinationLock',
      Effect: 'Allow',
      Action: ['s3:DeleteObject', 's3:GetObject', 's3:PutObject'],
      Resource: [
        'arn:aws:s3:::fro-bot-agent-state-fixture/fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock',
      ],
    })
  })

  it('contains an explicit session-prefix delete deny for current and versioned objects', () => {
    const built = buildAgentStoragePolicy(storagePolicyConfig)
    const statements = built.document.Statement as Record<string, unknown>[]
    const sessionDeleteDeny = statements.find(statement => statement.Sid === 'DenySessionDeletes')

    expect(sessionDeleteDeny).toEqual({
      Sid: 'DenySessionDeletes',
      Effect: 'Deny',
      Action: ['s3:DeleteObject', 's3:DeleteObjectVersion'],
      Resource: ['arn:aws:s3:::fro-bot-agent-state-fixture/fro-bot-state/github/marcusrbrown-infra/storage/*'],
    })
  })

  it('conditions ListBucket to the session and lock prefixes rather than the whole bucket', () => {
    const built = buildAgentStoragePolicy(storagePolicyConfig)
    const statements = built.document.Statement as Record<string, unknown>[]
    const list = statements.find(statement => statement.Sid === 'AllowListRepoPrefixes')

    expect(list).toEqual({
      Sid: 'AllowListRepoPrefixes',
      Effect: 'Allow',
      Action: ['s3:ListBucket'],
      Resource: ['arn:aws:s3:::fro-bot-agent-state-fixture'],
      Condition: {
        StringLike: {
          's3:prefix': [
            'fro-bot-state/github/marcusrbrown-infra/storage/*',
            'fro-bot-state/coordination/github/marcusrbrown-infra/locks/*',
          ],
        },
      },
    })
  })

  it('does not allow DeleteObjectVersion anywhere', () => {
    const built = buildAgentStoragePolicy(storagePolicyConfig)
    const statements = built.document.Statement as Record<string, unknown>[]

    expect(
      statements
        .filter(statement => statement.Effect === 'Allow')
        .flatMap(statement => (Array.isArray(statement.Action) ? statement.Action : [statement.Action]))
        .includes('s3:DeleteObjectVersion'),
    ).toBe(false)
  })

  it('makes unsupported version and bucket-location operations explicit denies', () => {
    const built = buildAgentStoragePolicy(storagePolicyConfig)
    const statements = built.document.Statement as Record<string, unknown>[]
    const unsupported = statements.find(statement => statement.Sid === 'DenyUnsupportedS3Actions')

    expect(unsupported?.Effect).toBe('Deny')
    expect(unsupported?.Action).toEqual([
      's3:GetBucketLocation',
      's3:GetObjectAttributes',
      's3:GetObjectVersion',
      's3:GetObjectVersionAttributes',
      's3:ListBucketVersions',
    ])
  })

  it('is idempotent, halts on drift, and force re-applies the inline policy', async () => {
    let policyDocument: string | undefined = JSON.stringify(buildAgentStoragePolicy(storagePolicyConfig).document)
    const {client, calls} = makeClient(async command => {
      if (command.constructor.name === 'GetRolePolicyCommand') {
        if (!policyDocument) throw namedError('NoSuchEntity')
        return {PolicyDocument: encodeURIComponent(policyDocument)}
      }
      if (command.constructor.name === 'PutRolePolicyCommand') {
        policyDocument = String(command.input.PolicyDocument)
        return {}
      }
      throw new Error(`Unexpected IAM command: ${command.constructor.name}`)
    })

    const current = await ensureAgentStoragePolicy(client, storagePolicyConfig)
    expect(current).toEqual({
      classification: 'current',
      changed: false,
      policyName: storagePolicyConfig.roleName,
      keyLayoutVersion: AGENT_ACTION_LAYOUT_VERSION,
      sessionPrefix: 'fro-bot-state/github/marcusrbrown-infra/storage/',
      lockKey: 'fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock',
    })
    expect(calls.map(call => call.name)).toEqual(['GetRolePolicyCommand'])

    policyDocument = JSON.stringify({
      ...buildAgentStoragePolicy(storagePolicyConfig).document,
      Version: '2012-10-17-drift',
    })
    await expect(ensureAgentStoragePolicy(client, storagePolicyConfig)).rejects.toThrow(/managed drift/i)
    expect(calls.map(call => call.name)).toEqual(['GetRolePolicyCommand', 'GetRolePolicyCommand'])

    const forced = await ensureAgentStoragePolicy(client, storagePolicyConfig, {force: true})
    expect(forced).toEqual({
      classification: 'managed-drift',
      changed: true,
      policyName: storagePolicyConfig.roleName,
      keyLayoutVersion: AGENT_ACTION_LAYOUT_VERSION,
      sessionPrefix: 'fro-bot-state/github/marcusrbrown-infra/storage/',
      lockKey: 'fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock',
    })
    expect(calls.map(call => call.name)).toEqual([
      'GetRolePolicyCommand',
      'GetRolePolicyCommand',
      'GetRolePolicyCommand',
      'PutRolePolicyCommand',
      'GetRolePolicyCommand',
    ])
  })
})

describe('agent action-state S3 bucket provisioning', () => {
  it('normalizes prefixes without leading slashes, wildcards, or duplicate trailing slashes', () => {
    expect(canonicalizeS3Prefix('/fro-bot-state///')).toBe('fro-bot-state/')
    expect(() => canonicalizeS3Prefix('fro-bot-state/*')).toThrow(/wildcard/i)
    expect(() => canonicalizeS3Prefix('fro-bot-state/metadata?')).toThrow(/wildcard/i)
  })

  it('creates an absent bucket with all controls and the canonical lifecycle rules', async () => {
    const {client, calls} = makeCurrentBucketClient({
      headError: namedError('NoSuchBucket'),
      publicAccessBlock: null,
      versioningStatus: null,
      encryptionAlgorithm: null,
      policy: null,
      lifecycleRules: [],
    })

    const result = await ensureAgentStateBucket(client, bucketConfig)

    expect(result).toEqual({
      classification: 'absent',
      changed: true,
      bucket: bucketConfig.bucket,
      bucketRegion: bucketConfig.region,
      expectedBucketOwner: bucketConfig.expectedBucketOwner,
      s3Prefix: 'fro-bot-state/',
      sessionPrefix: 'fro-bot-state/github/marcusrbrown-infra/storage/',
    })
    expect(calls.map(call => call.name)).toContain('CreateBucketCommand')
    expect(calls.map(call => call.name)).toContain('PutPublicAccessBlockCommand')
    expect(calls.map(call => call.name)).toContain('PutBucketVersioningCommand')
    expect(calls.map(call => call.name)).toContain('PutBucketEncryptionCommand')
    expect(calls.map(call => call.name)).toContain('PutBucketPolicyCommand')
    const lifecyclePut = calls.find(call => call.name === 'PutBucketLifecycleConfigurationCommand')
    expect(lifecycleRulesFromCall(lifecyclePut)).toEqual(canonicalLifecycleRules)

    for (const call of calls) {
      if (call.name !== 'CreateBucketCommand')
        expect(call.input.ExpectedBucketOwner).toBe(bucketConfig.expectedBucketOwner)
    }
  })

  it('omits LocationConstraint for us-east-1 and includes it for other regions', async () => {
    for (const region of ['us-east-1', 'eu-west-1']) {
      const config = {...bucketConfig, region}
      const {client, calls} = makeCurrentBucketClient({
        headError: namedError('NoSuchBucket'),
        bucketRegion: region,
        publicAccessBlock: null,
        versioningStatus: null,
        encryptionAlgorithm: null,
        policy: null,
        lifecycleRules: [],
      })

      await ensureAgentStateBucket(client, config)

      const create = calls.find(call => call.name === 'CreateBucketCommand')
      if (region === 'us-east-1') {
        expect(create?.input).toEqual({Bucket: config.bucket})
      } else {
        expect(create?.input).toEqual({
          Bucket: config.bucket,
          CreateBucketConfiguration: {LocationConstraint: region},
        })
      }
    }
  })

  it('does not PUT controls when the bucket is already current', async () => {
    const {client, calls} = makeCurrentBucketClient()

    const result = await ensureAgentStateBucket(client, bucketConfig)

    expect(result.classification).toBe('current')
    expect(result.changed).toBe(false)
    expect(calls.every(call => !call.name.startsWith('Put'))).toBe(true)
  })

  it('halts on managed drift unless force is enabled, then reapplies and verifies it', async () => {
    const {client, calls} = makeCurrentBucketClient({versioningStatus: 'Suspended'})
    const warnings: string[] = []

    await expect(
      ensureAgentStateBucket(client, bucketConfig, {log: (message: string) => warnings.push(message)}),
    ).rejects.toThrow(/drift/i)
    expect(warnings.some(message => /versioning/i.test(message))).toBe(true)
    expect(calls.some(call => call.name === 'PutBucketVersioningCommand')).toBe(false)

    const forced = await ensureAgentStateBucket(client, bucketConfig, {force: true})
    expect(forced.changed).toBe(true)
    expect(calls.some(call => call.name === 'PutBucketVersioningCommand')).toBe(true)
  })

  it('fails closed before any mutation when owner verification fails', async () => {
    const {client, calls} = makeCurrentBucketClient({
      headError: namedError('AccessDenied', 'wrong ExpectedBucketOwner'),
    })

    await expect(ensureAgentStateBucket(client, bucketConfig)).rejects.toThrow(/owner|accessdenied|expected/i)
    expect(calls.map(call => call.name)).toEqual(['HeadBucketCommand'])
  })

  it('halts before mutation when the existing bucket is in another region', async () => {
    const {client, calls} = makeCurrentBucketClient({bucketRegion: 'eu-central-1'})

    await expect(ensureAgentStateBucket(client, bucketConfig)).rejects.toThrow(/region/i)
    expect(calls.map(call => call.name)).toEqual(['HeadBucketCommand'])
  })

  it('merges owned lifecycle rules by ID while preserving an unowned rule', async () => {
    const unrelated = {
      ID: 'operator-owned-rule',
      Filter: {Prefix: 'keep-me/'},
      Status: 'Enabled',
      Expiration: {Days: 365},
    }
    const driftedOwned = {...canonicalLifecycleRules[0], Expiration: {Days: 7}}
    const {client, calls} = makeCurrentBucketClient({lifecycleRules: [unrelated, driftedOwned]})

    await ensureAgentStateBucket(client, bucketConfig, {force: true})

    const lifecyclePut = calls.find(call => call.name === 'PutBucketLifecycleConfigurationCommand')
    expect(lifecycleRulesFromCall(lifecyclePut)).toEqual([unrelated, ...canonicalLifecycleRules])
  })

  it('throws when a control readback does not match the requested state', async () => {
    const {client} = makeCurrentBucketClient({readbackMismatch: true})

    await expect(ensureAgentStateBucket(client, bucketConfig, {force: true})).rejects.toThrow(/readback/i)
  })

  it('writes a four-flag public block, AES256 SSE-S3, and a non-TLS deny policy', async () => {
    const {client, calls} = makeCurrentBucketClient({
      headError: namedError('NoSuchBucket'),
      publicAccessBlock: null,
      versioningStatus: null,
      encryptionAlgorithm: null,
      policy: null,
      lifecycleRules: [],
    })

    await ensureAgentStateBucket(client, bucketConfig)

    expect(calls.find(call => call.name === 'PutPublicAccessBlockCommand')?.input).toEqual({
      Bucket: bucketConfig.bucket,
      ExpectedBucketOwner: bucketConfig.expectedBucketOwner,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    })
    expect(calls.find(call => call.name === 'PutBucketEncryptionCommand')?.input).toEqual({
      Bucket: bucketConfig.bucket,
      ExpectedBucketOwner: bucketConfig.expectedBucketOwner,
      ServerSideEncryptionConfiguration: {
        Rules: [{ApplyServerSideEncryptionByDefault: {SSEAlgorithm: 'AES256'}}],
      },
    })

    const policyInput = calls.find(call => call.name === 'PutBucketPolicyCommand')?.input
    const policy = JSON.parse(String(policyInput?.Policy)) as {
      Statement: Record<string, unknown>[]
    }
    expect(policy.Statement).toEqual([
      {
        Sid: 'DenyInsecureTransport',
        Effect: 'Deny',
        Principal: '*',
        Action: 's3:*',
        Resource: [`arn:aws:s3:::${bucketConfig.bucket}`, `arn:aws:s3:::${bucketConfig.bucket}/*`],
        Condition: {Bool: {'aws:SecureTransport': 'false'}},
      },
    ])
  })
})

describe('agent storage teardown', () => {
  it('deletes the repo policy, role, and lock while retaining session objects and shared resources by default', async () => {
    const {iam, s3, deletedObjects} = makeTeardownClients()
    const result = await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
    })

    expect(result.stateRetained).toBe(true)
    expect(result.statePurgeImpossible).toBe(false)
    expect(iam.calls.map(call => call.name)).toContain('DeleteRolePolicyCommand')
    expect(iam.calls.map(call => call.name)).toContain('DeleteRoleCommand')
    expect(deletedObjects).toEqual([
      {
        Bucket: bucketConfig.bucket,
        Key: teardownManifest.lock_key,
        ExpectedBucketOwner: bucketConfig.expectedBucketOwner,
      },
    ])
    expect(iam.calls.some(call => call.name === 'DeleteOpenIDConnectProviderCommand')).toBe(false)
    expect(s3.calls.some(call => call.name === 'DeleteBucketCommand')).toBe(false)
    expect(s3.calls.some(call => call.name === 'DeleteObjectsCommand')).toBe(false)
  })

  it('purges all versioned session-prefix objects when purge-state is requested', async () => {
    const {iam, s3, deletedObjects} = makeTeardownClients()

    const result = await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
      purgeState: true,
    })

    expect(result.stateRetained).toBe(false)
    expect(result.sessionObjectsPurged).toBe(true)
    expect(deletedObjects).toEqual([
      {
        Bucket: bucketConfig.bucket,
        Key: teardownManifest.lock_key,
        ExpectedBucketOwner: bucketConfig.expectedBucketOwner,
      },
      {
        Bucket: bucketConfig.bucket,
        ExpectedBucketOwner: bucketConfig.expectedBucketOwner,
        Delete: {
          Objects: [
            {Key: `${teardownManifest.session_prefix}session.json`, VersionId: 'v1'},
            {Key: `${teardownManifest.session_prefix}session.json`, VersionId: 'v2'},
            {Key: `${teardownManifest.session_prefix}deleted.json`, VersionId: 'd1'},
          ],
        },
      },
    ])
  })

  it('paginates session-prefix version deletion', async () => {
    const {iam, s3, deletedObjects} = makeTeardownClients({
      versionResponses: [
        {
          IsTruncated: true,
          NextKeyMarker: `${teardownManifest.session_prefix}first.json`,
          NextVersionIdMarker: 'v1',
          Versions: [{Key: `${teardownManifest.session_prefix}first.json`, VersionId: 'v1'}],
          DeleteMarkers: [],
        },
        {
          IsTruncated: false,
          Versions: [{Key: `${teardownManifest.session_prefix}second.json`, VersionId: 'v2'}],
          DeleteMarkers: [],
        },
      ],
    })

    await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
      purgeState: true,
    })

    expect(s3.calls.filter(call => call.name === 'ListObjectVersionsCommand')).toHaveLength(2)
    const deleteInput = deletedObjects.find(input => 'Delete' in input)
    expect((deleteInput?.Delete as {Objects?: unknown[]})?.Objects).toHaveLength(2)
  })

  it('is idempotent when the role and policy are already absent', async () => {
    const {iam, s3} = makeTeardownClients()
    await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
    })

    await expect(
      performTeardown({
        client: iam.client,
        s3Client: s3.client,
        manifest: teardownManifest,
        repository: teardownRepository(),
      }),
    ).resolves.toMatchObject({roleDeleted: false, policyDeleted: false})
  })

  it('treats NoSuchEntityException during inline policy and role deletion as idempotent success', async () => {
    const {iam, s3} = makeTeardownClients({
      deletePolicyError: namedError('NoSuchEntityException', 'inline policy already absent'),
      deleteRoleError: namedError('NoSuchEntityException', 'role already absent'),
    })

    await expect(
      performTeardown({
        client: iam.client,
        s3Client: s3.client,
        manifest: teardownManifest,
        repository: teardownRepository(),
      }),
    ).resolves.toMatchObject({roleDeleted: false, policyDeleted: false})
  })

  it('refuses to delete a role whose tags do not identify the target repository', async () => {
    const foreignRole = {
      Arn: teardownManifest.role_arn,
      RoleName: teardownManifest.role_name,
      AssumeRolePolicyDocument: JSON.stringify(canonicalRoleTrust()),
      MaxSessionDuration: 7200,
      Tags: managedRoleTags().map(tag => (tag.Key === 'repo' ? {...tag, Value: 'other-repo'} : tag)),
    }
    const {iam, s3} = makeTeardownClients({role: foreignRole})

    await expect(
      performTeardown({
        client: iam.client,
        s3Client: s3.client,
        manifest: teardownManifest,
        repository: teardownRepository(),
      }),
    ).rejects.toThrow(/foreign|identity|refus/i)
    expect(iam.calls.some(call => call.name === 'DeleteRolePolicyCommand')).toBe(false)
    expect(iam.calls.some(call => call.name === 'DeleteRoleCommand')).toBe(false)
    expect(s3.calls.some(call => call.name === 'DeleteObjectCommand')).toBe(false)
  })

  it('refuses to delete a role whose trust policy does not match the target repository', async () => {
    const driftedTrust = canonicalRoleTrust()
    const statement = (driftedTrust.Statement as Record<string, unknown>[])[0]
    const condition = statement?.Condition as {StringEquals: Record<string, unknown>}
    condition.StringEquals['token.actions.githubusercontent.com:repository_id'] = '999999'
    const {iam, s3} = makeTeardownClients({
      role: {
        Arn: teardownManifest.role_arn,
        RoleName: teardownManifest.role_name,
        AssumeRolePolicyDocument: JSON.stringify(driftedTrust),
        MaxSessionDuration: 7200,
        Tags: managedRoleTags(),
      },
    })

    await expect(
      performTeardown({
        client: iam.client,
        s3Client: s3.client,
        manifest: teardownManifest,
        repository: teardownRepository(),
      }),
    ).rejects.toThrow(/trust|identity|refus/i)
    expect(iam.calls.some(call => call.name === 'DeleteRoleCommand')).toBe(false)
    expect(s3.calls.some(call => call.name === 'DeleteObjectCommand')).toBe(false)
  })

  it('refuses a malformed handoff manifest before touching AWS', async () => {
    const {iam, s3} = makeTeardownClients()
    const malformedManifest = {...teardownManifest, oidc_provider_arn: undefined} as unknown as typeof teardownManifest

    await expect(
      performTeardown({
        client: iam.client,
        s3Client: s3.client,
        manifest: malformedManifest,
        repository: teardownRepository(),
      }),
    ).rejects.toThrow(/manifest.*OIDC|provider ARN/i)
    expect(iam.calls).toEqual([])
    expect(s3.calls).toEqual([])
  })

  it('rejects a malformed stdin/file manifest before the entrypoint constructs AWS clients', async () => {
    const manifestPath = `/tmp/agent-storage-malformed-${crypto.randomUUID()}.json`
    await Bun.write(manifestPath, JSON.stringify({...teardownManifest, bucket_region: undefined}))
    const env = {
      [AGENT_REPOSITORY_OWNER]: roleRepository.owner,
      [AGENT_REPOSITORY_NAME]: roleRepository.repo,
      [AGENT_REPOSITORY_ID]: roleRepository.repositoryId,
      [AGENT_REPOSITORY_OWNER_ID]: roleRepository.repositoryOwnerId,
      [AGENT_WORKFLOW_NAME]: roleRepository.workflow,
    }

    try {
      await expect(main(['--teardown', '--manifest', manifestPath], env)).rejects.toThrow(/bucket_region/i)
    } finally {
      await unlink(manifestPath)
    }
  })

  it('prints operator usage for --help without requiring AWS credentials', async () => {
    const output: string[] = []

    await expect(main(['--help'], {}, line => output.push(line))).resolves.toBeUndefined()

    const usage = output.join('\n')
    expect(usage).toMatch(/AGENT_AWS_ACCESS_KEY_ID/)
    expect(usage).toMatch(/--force/)
    expect(usage).toMatch(/--teardown/)
    expect(usage).toMatch(/--plan/)
    expect(usage).toMatch(/--manifest -/)
    expect(usage).toMatch(/--purge-state/)
  })

  it('reports the plan without mutating AWS', async () => {
    const {iam, s3} = makeTeardownClients()
    const report: string[] = []

    const result = await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
      purgeState: true,
      plan: true,
      log: message => report.push(message),
    })

    expect(result.planned).toBe(true)
    expect(report.join('\n')).toMatch(/would delete.*lock|would purge.*session/i)
    expect(iam.calls.some(call => call.name.startsWith('Delete'))).toBe(false)
    expect(s3.calls.some(call => call.name.startsWith('Delete'))).toBe(false)
  })

  it('continues scoped IAM cleanup when state deletion is impossible', async () => {
    const {iam, s3} = makeTeardownClients({
      stateError: namedError('AccessDenied', 'administrator credentials unavailable'),
    })
    const report: string[] = []

    const result = await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
      log: message => report.push(message),
    })

    expect(result.statePurgeImpossible).toBe(true)
    expect(report.join('\n')).toMatch(/state purge impossible/i)
    expect(iam.calls.some(call => call.name === 'DeleteRolePolicyCommand')).toBe(true)
    expect(iam.calls.some(call => call.name === 'DeleteRoleCommand')).toBe(true)
  })

  it('attempts session purge independently when lock deletion fails', async () => {
    const {iam, s3, deletedObjects} = makeTeardownClients({lockError: namedError('AccessDenied', 'lock access denied')})
    const result = await performTeardown({
      client: iam.client,
      s3Client: s3.client,
      manifest: teardownManifest,
      repository: teardownRepository(),
      purgeState: true,
    })

    expect(result.statePurgeImpossible).toBe(true)
    expect(result.sessionObjectsPurged).toBe(true)
    expect(s3.calls.map(call => call.name)).toContain('ListObjectVersionsCommand')
    expect(deletedObjects.some(input => 'Delete' in input)).toBe(true)
    expect(iam.calls.some(call => call.name === 'DeleteRoleCommand')).toBe(true)
  })

  it('reports stranded roles and stale S3 resources without mutating shared infrastructure', async () => {
    const iam = makeClient(async command => {
      if (command.constructor.name === 'ListRolesCommand') {
        return {
          Roles: [
            {
              RoleName: teardownManifest.role_name,
              Tags: managedRoleTags(),
            },
            {RoleName: 'unrelated-role', Tags: []},
          ],
        }
      }
      throw new Error(`Unexpected IAM audit command: ${command.constructor.name}`)
    })
    const old = new Date('2026-07-31T00:00:00.000Z')
    const s3 = makeS3Client(async command => {
      switch (command.constructor.name) {
        case 'ListObjectsV2Command':
          return {
            Contents: [
              {Key: teardownManifest.lock_key, LastModified: old},
              {Key: `${teardownManifest.lock_key}.fresh`, LastModified: new Date('2026-08-01T00:00:00.000Z')},
            ],
          }
        case 'ListMultipartUploadsCommand':
          return {
            Uploads: [{Key: `${teardownManifest.session_prefix}upload.bin`, UploadId: 'upload-1', Initiated: old}],
          }
        case 'ListObjectVersionsCommand':
          return {
            Versions: [
              {Key: `${teardownManifest.session_prefix}orphan.json`, VersionId: 'orphan-v1', IsLatest: false},
              {Key: `${teardownManifest.session_prefix}current.json`, VersionId: 'current-v2', IsLatest: true},
              {Key: `${teardownManifest.session_prefix}current.json`, VersionId: 'current-v1', IsLatest: false},
            ],
            DeleteMarkers: [],
          }
        default:
          throw new Error(`Unexpected S3 audit command: ${command.constructor.name}`)
      }
    })

    const result = await auditAgentStorageResources({
      client: iam.client,
      s3Client: s3.client,
      bucket: bucketConfig,
      now: new Date('2026-08-01T01:00:00.000Z'),
      hasRepoVariables: async () => false,
    })

    expect(result.strandedRoles).toEqual([teardownManifest.role_name])
    expect(result.staleLocks).toEqual([teardownManifest.lock_key])
    expect(result.incompleteMultipartUploads).toEqual([`${teardownManifest.session_prefix}upload.bin#upload-1`])
    expect(result.orphanedNoncurrentVersions).toEqual([`${teardownManifest.session_prefix}orphan.json#orphan-v1`])
    expect(iam.calls.some(call => call.name.startsWith('Delete'))).toBe(false)
    expect(s3.calls.some(call => call.name.startsWith('Delete'))).toBe(false)
  })
})
