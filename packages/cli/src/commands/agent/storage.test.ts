/// <reference types="bun" />

import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from 'bun:test'

import {runCommand} from './setup-core/gh'
import {
  buildAwsChildEnv,
  runStorageSetup,
  runStorageTeardown,
  STORAGE_VARIABLE_NAMES,
  unwireStorageVariables,
  verifyProvisionedResources,
  type StorageManifest,
  type StorageSetupDeps,
} from './storage'

const manifest: StorageManifest = {
  owner: 'owner',
  repo: 'repo',
  repository_id: '12345',
  repository_owner_id: '67890',
  bucket: 'fro-bot-agent-state',
  bucket_region: 'us-east-1',
  expected_bucket_owner: '111122223333',
  s3_prefix: 'fro-bot-state',
  session_prefix: 'fro-bot-state/github/owner-repo/storage/',
  lock_key: 'fro-bot-state/github/owner-repo/coordination/lock',
  role_name: 'fro-bot-agent-storage-owner-repo',
  role_arn: 'arn:aws:iam::111122223333:role/fro-bot-agent-storage-owner-repo',
  policy_name: 'fro-bot-agent-storage-owner-repo',
  action_ref_verified: true,
  // Must match apps/agent/src/key-layout.ts KEY_LAYOUT_VERSION.
  key_layout_version: 'fro-bot/agent@v0.96.0',
}

function makeGhResult(stdout: string, exitCode = 0, stderr = '') {
  return {stdout, stderr, exitCode}
}

function makeDeps(writes: {kind: string; name: string; value: string}[], overrides: Partial<StorageSetupDeps> = {}) {
  const runGh = mock(async (args: string[]) => {
    if (args[0] !== 'api') return makeGhResult('', 1, 'unexpected gh command')
    if (args[1]?.includes('/actions/oidc/customization/sub')) {
      return makeGhResult(JSON.stringify({use_default: true, use_immutable_subject: false}))
    }
    return makeGhResult(
      JSON.stringify({
        id: Number(manifest.repository_id),
        name: manifest.repo,
        owner: {login: manifest.owner, id: Number(manifest.repository_owner_id)},
      }),
    )
  })

  return {
    runGh,
    readManifest: mock(async () => JSON.stringify(manifest)),
    verifyResources: mock(async () => {}),
    // Existing storage tests isolate manifest/resource/identity/OIDC checks.
    // Workflow verification is opted out explicitly rather than by injecting
    // the low-level gh seam.
    verifyWorkflow: mock(async () => {}),
    applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, _repo: string, value: string) => {
      writes.push({kind, name, value})
    }),
    ...overrides,
  } satisfies StorageSetupDeps
}

const storageEnvKeys = [
  'AGENT_AWS_ACCESS_KEY_ID',
  'AGENT_AWS_SECRET_ACCESS_KEY',
  'AGENT_AWS_SESSION_TOKEN',
  'AGENT_AWS_REGION',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_DEFAULT_REGION',
  'AWS_CONFIG_FILE',
  'AWS_SHARED_CREDENTIALS_FILE',
  'AWS_CA_BUNDLE',
  'AWS_ENDPOINT_URL',
  'AWS_PROFILE',
  'AWS_DEFAULT_PROFILE',
  'AWS_ROLE_ARN',
  'AWS_WEB_IDENTITY_TOKEN_FILE',
  'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
  'AWS_CONTAINER_CREDENTIALS_FULL_URI',
  'AWS_CONTAINER_AUTHORIZATION_TOKEN',
  'AWS_EC2_METADATA_DISABLED',
  'AWS_REGION',
  'PATH',
  'HOME',
  'TMPDIR',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'UNRELATED_REPO_SECRET',
] as const

let storageEnvBeforeEach: Record<string, string | undefined>

beforeEach(() => {
  storageEnvBeforeEach = Object.fromEntries(storageEnvKeys.map(key => [key, process.env[key]]))
})

afterEach(() => {
  for (const key of storageEnvKeys) {
    const value = storageEnvBeforeEach[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

function setStorageEnv(values: Partial<Record<(typeof storageEnvKeys)[number], string | undefined>>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

describe('agent S3 durable storage wiring', () => {
  it('builds a dedicated AWS child environment with explicit preservation and default denial', () => {
    const dedicatedAccessKey = 'agent-access-fixture'
    const dedicatedSecretKey = 'agent-secret-fixture'
    const ambientAccessKey = 'ambient-access-fixture'
    const ambientSecretKey = 'ambient-secret-fixture'
    const sourceEnv = {
      AGENT_AWS_ACCESS_KEY_ID: dedicatedAccessKey,
      AGENT_AWS_SECRET_ACCESS_KEY: dedicatedSecretKey,
      AGENT_AWS_REGION: undefined,
      AWS_ACCESS_KEY_ID: ambientAccessKey,
      AWS_SECRET_ACCESS_KEY: ambientSecretKey,
      AWS_REGION: 'ambient-region',
      AWS_DEFAULT_REGION: 'ambient-default-region',
      AWS_CONFIG_FILE: '/tmp/ambient-config',
      AWS_SHARED_CREDENTIALS_FILE: '/tmp/ambient-credentials',
      AWS_CA_BUNDLE: '/tmp/ambient-ca.pem',
      AWS_ENDPOINT_URL: 'http://ambient-endpoint.invalid',
      AWS_PROFILE: 'gateway-profile',
      AWS_DEFAULT_PROFILE: 'gateway-profile',
      AWS_ROLE_ARN: 'arn:aws:iam::999999999999:role/ambient',
      AWS_WEB_IDENTITY_TOKEN_FILE: '/tmp/ambient-token',
      AWS_CONTAINER_CREDENTIALS_RELATIVE_URI: '/v2/credentials/ambient',
      AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://169.254.170.2/ambient',
      AWS_CONTAINER_AUTHORIZATION_TOKEN: 'ambient-auth-fixture',
      AWS_EC2_METADATA_DISABLED: 'false',
      AWS_SESSION_TOKEN: 'ambient-session-fixture',
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      TMPDIR: '/fixture/tmp',
      LANG: 'C.UTF-8',
      LANGUAGE: 'en_US',
      LC_ALL: 'C.UTF-8',
      LC_CTYPE: 'C.UTF-8',
      UNRELATED_REPO_SECRET: 'unrelated-fixture',
    }
    const childEnv = buildAwsChildEnv(manifest, sourceEnv)

    expect(childEnv).toEqual(
      expect.objectContaining({
        AWS_ACCESS_KEY_ID: dedicatedAccessKey,
        AWS_SECRET_ACCESS_KEY: dedicatedSecretKey,
        AWS_REGION: manifest.bucket_region,
        AWS_DEFAULT_REGION: manifest.bucket_region,
        PATH: sourceEnv.PATH,
        HOME: sourceEnv.HOME,
        TMPDIR: sourceEnv.TMPDIR,
        LANG: sourceEnv.LANG,
        LANGUAGE: sourceEnv.LANGUAGE,
        LC_ALL: sourceEnv.LC_ALL,
        LC_CTYPE: sourceEnv.LC_CTYPE,
      }),
    )

    for (const key of [
      'AWS_CONFIG_FILE',
      'AWS_SHARED_CREDENTIALS_FILE',
      'AWS_CA_BUNDLE',
      'AWS_ENDPOINT_URL',
      'AWS_PROFILE',
      'AWS_DEFAULT_PROFILE',
      'AWS_ROLE_ARN',
      'AWS_WEB_IDENTITY_TOKEN_FILE',
      'AWS_CONTAINER_CREDENTIALS_RELATIVE_URI',
      'AWS_CONTAINER_CREDENTIALS_FULL_URI',
      'AWS_CONTAINER_AUTHORIZATION_TOKEN',
      'AWS_EC2_METADATA_DISABLED',
      'AWS_SESSION_TOKEN',
      'UNRELATED_REPO_SECRET',
    ]) {
      expect(childEnv).not.toHaveProperty(key)
    }
    expect(childEnv).not.toHaveProperty('AGENT_AWS_ACCESS_KEY_ID')
    expect(childEnv).not.toHaveProperty('AGENT_AWS_SECRET_ACCESS_KEY')
    expect(childEnv.AWS_REGION).not.toBe('ambient-region')
    expect(childEnv.AWS_DEFAULT_REGION).not.toBe('ambient-default-region')
  })

  it('fails before spawning aws when dedicated credentials are missing, partial, or whitespace-only', async () => {
    const spawnSpy = spyOn(Bun, 'spawn')
    const cases = [
      {AGENT_AWS_ACCESS_KEY_ID: undefined, AGENT_AWS_SECRET_ACCESS_KEY: undefined},
      {AGENT_AWS_ACCESS_KEY_ID: 'partial-access-fixture', AGENT_AWS_SECRET_ACCESS_KEY: undefined},
      {AGENT_AWS_ACCESS_KEY_ID: undefined, AGENT_AWS_SECRET_ACCESS_KEY: 'partial-secret-fixture'},
      {AGENT_AWS_ACCESS_KEY_ID: '   ', AGENT_AWS_SECRET_ACCESS_KEY: 'dedicated-secret-fixture'},
      {AGENT_AWS_ACCESS_KEY_ID: 'dedicated-access-fixture', AGENT_AWS_SECRET_ACCESS_KEY: '\t'},
    ] as const

    try {
      for (const values of cases) {
        setStorageEnv(values)
        let failure: unknown
        try {
          await verifyProvisionedResources(manifest)
        } catch (error) {
          failure = error
        }

        expect(failure).toBeInstanceOf(Error)
        const message = failure instanceof Error ? failure.message : ''
        expect(message).toMatch(/AGENT_AWS_ACCESS_KEY_ID.*AGENT_AWS_SECRET_ACCESS_KEY/)
        expect(message).not.toContain('partial-access-fixture')
        expect(message).not.toContain('partial-secret-fixture')
      }
      expect(spawnSpy).not.toHaveBeenCalled()
    } finally {
      spawnSpy.mockRestore()
    }
  })

  it('passes the dedicated session token only when configured and removes ambient session state otherwise', () => {
    const sourceEnv = {
      AGENT_AWS_ACCESS_KEY_ID: 'agent-access-fixture',
      AGENT_AWS_SECRET_ACCESS_KEY: 'agent-secret-fixture',
      AGENT_AWS_SESSION_TOKEN: 'agent-session-fixture',
      AWS_SESSION_TOKEN: 'ambient-session-fixture',
    }
    expect(buildAwsChildEnv(manifest, sourceEnv).AWS_SESSION_TOKEN).toBe('agent-session-fixture')

    expect(buildAwsChildEnv(manifest, {...sourceEnv, AGENT_AWS_SESSION_TOKEN: undefined})).not.toHaveProperty(
      'AWS_SESSION_TOKEN',
    )
  })

  it('prefers the dedicated region and falls back to the manifest region', () => {
    const sourceEnv = {
      AGENT_AWS_ACCESS_KEY_ID: 'agent-access-fixture',
      AGENT_AWS_SECRET_ACCESS_KEY: 'agent-secret-fixture',
      AGENT_AWS_REGION: 'eu-west-1',
    }
    expect(buildAwsChildEnv(manifest, sourceEnv).AWS_REGION).toBe('eu-west-1')
    expect(buildAwsChildEnv(manifest, {...sourceEnv, AGENT_AWS_REGION: undefined}).AWS_REGION).toBe(
      manifest.bucket_region,
    )
  })

  it('keeps injected AWS runners hermetic and does not require dedicated process credentials', async () => {
    setStorageEnv({
      AGENT_AWS_ACCESS_KEY_ID: undefined,
      AGENT_AWS_SECRET_ACCESS_KEY: undefined,
      AWS_ACCESS_KEY_ID: undefined,
      AWS_SECRET_ACCESS_KEY: undefined,
    })
    const runAws = mock(async (args: string[]) => {
      if (args[0] === 'iam') return makeGhResult(JSON.stringify({Role: {Arn: manifest.role_arn}}))
      if (args[1] === 'head-bucket') return makeGhResult('')
      return makeGhResult(JSON.stringify({LocationConstraint: manifest.bucket_region}))
    })

    await expect(
      runStorageSetup('owner/repo', {manifest: '-'}, makeDeps([], {verifyResources: undefined, runAws})),
    ).resolves.toBeUndefined()
    expect(runAws).toHaveBeenCalledTimes(3)
  })

  it('redacts dedicated credentials from default AWS stdout, stderr, and thrown preflight errors', async () => {
    const accessKey = 'agent-access-redaction-fixture'
    const secretKey = 'agent-secret-redaction-fixture'
    const sessionToken = 'agent-session-redaction-fixture'
    setStorageEnv({
      AGENT_AWS_ACCESS_KEY_ID: accessKey,
      AGENT_AWS_SECRET_ACCESS_KEY: secretKey,
      AGENT_AWS_SESSION_TOKEN: sessionToken,
    })

    let captured: {stdout: string; stderr: string} | undefined
    const awsCalls: string[][] = []
    const runAwsCommand: NonNullable<StorageSetupDeps['runAwsCommand']> = async (args, env, redactValues) => {
      awsCalls.push(args)
      const outputScript = [
        'process.stdout.write("stdout:" + process.env.AWS_ACCESS_KEY_ID + ":" + process.env.AWS_SECRET_ACCESS_KEY + ":" + process.env.AWS_SESSION_TOKEN);',
        'process.stderr.write("stderr:" + process.env.AWS_ACCESS_KEY_ID + ":" + process.env.AWS_SECRET_ACCESS_KEY + ":" + process.env.AWS_SESSION_TOKEN);',
      ].join(' ')
      const result = await runCommand('bun', ['-e', outputScript], 1_000, undefined, env, redactValues)
      captured = result
      return {...result, exitCode: 1}
    }

    const failure = runStorageSetup(
      'owner/repo',
      {manifest: '-'},
      makeDeps([], {verifyResources: undefined, runAwsCommand}),
    )
    await expect(failure).rejects.toThrow('AWS IAM role preflight failed')

    expect(captured?.stdout).toBe('stdout:[REDACTED]:[REDACTED]:[REDACTED]')
    expect(captured?.stderr).toBe('stderr:[REDACTED]:[REDACTED]:[REDACTED]')
    expect(awsCalls).toHaveLength(1)
    for (const value of [accessKey, secretKey, sessionToken]) {
      expect(awsCalls[0]).not.toContain(value)
    }
    const error = await failure.catch(error_ => error_)
    const message = error instanceof Error ? error.message : String(error)
    expect(message).toContain('[REDACTED]')
    expect(message).not.toContain(accessKey)
    expect(message).not.toContain(secretKey)
    expect(message).not.toContain(sessionToken)
  })

  it('writes exactly the non-secret S3 variables after all prechecks pass', async () => {
    const writes: {kind: string; name: string; value: string}[] = []

    await runStorageSetup('owner/repo', {manifest: '-'}, makeDeps(writes))

    expect(writes).toEqual([
      {kind: 'variable', name: STORAGE_VARIABLE_NAMES.roleToAssume, value: manifest.role_arn},
      {kind: 'variable', name: STORAGE_VARIABLE_NAMES.bucket, value: manifest.bucket},
      {kind: 'variable', name: STORAGE_VARIABLE_NAMES.region, value: manifest.bucket_region},
      {kind: 'variable', name: STORAGE_VARIABLE_NAMES.prefix, value: manifest.s3_prefix},
      {kind: 'variable', name: STORAGE_VARIABLE_NAMES.expectedBucketOwner, value: manifest.expected_bucket_owner},
    ])
  })

  it('fails closed before writing when provisioned resources are absent', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      verifyResources: mock(async () => {
        throw new Error('IAM role or S3 bucket is absent; run the provisioner first.')
      }),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow('run the provisioner first')
    expect(writes).toEqual([])
  })

  it('refuses a handoff manifest whose repository id differs from live GitHub identity', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const staleManifest = {...manifest, repository_id: '99999'}
    const deps = makeDeps(writes, {
      readManifest: mock(async () => JSON.stringify(staleManifest)),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow('manifest identity mismatch')
    expect(writes).toEqual([])
  })

  it('fails closed when the repository has a custom OIDC subject template', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      runGh: mock(async (args: string[]) => {
        if (args[1]?.includes('/actions/oidc/customization/sub')) {
          return makeGhResult(JSON.stringify({use_default: false, use_immutable_subject: false}))
        }
        return makeGhResult(
          JSON.stringify({
            id: Number(manifest.repository_id),
            name: manifest.repo,
            owner: {login: manifest.owner, id: Number(manifest.repository_owner_id)},
          }),
        )
      }),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow('explicit OIDC re-verification')
    expect(writes).toEqual([])
  })

  it('refuses immutable-subject mode until the trust policy is explicitly re-verified', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      runGh: mock(async (args: string[]) => {
        if (args[1]?.includes('/actions/oidc/customization/sub')) {
          return makeGhResult(JSON.stringify({use_default: true, use_immutable_subject: true}))
        }
        return makeGhResult(
          JSON.stringify({
            id: Number(manifest.repository_id),
            name: manifest.repo,
            owner: {login: manifest.owner, id: Number(manifest.repository_owner_id)},
          }),
        )
      }),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow('explicit OIDC re-verification')
    expect(writes).toEqual([])
  })

  it('refuses static AWS credential input without writing any GitHub value', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes)

    await expect(
      runStorageSetup('owner/repo', {manifest: '-', staticAwsAccessKeyId: 'AKIA-test'}, deps),
    ).rejects.toThrow('Static AWS credentials are not supported')
    expect(writes).toEqual([])
  })

  it('calls an explicit workflow verifier override before S3 variables are wired', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const events: string[] = []
    const deps = makeDeps(writes, {
      verifyWorkflow: mock(async () => {
        events.push('verify')
      }),
      applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, _repo: string, value: string) => {
        events.push(`write:${name}`)
        writes.push({kind, name, value})
      }),
    })

    await runStorageSetup('owner/repo', {manifest: '-'}, deps)

    expect(events[0]).toBe('verify')
    expect(writes.every(write => write.kind === 'variable')).toBe(true)
  })

  it('does not write storage variables when workflow verification fails', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      verifyWorkflow: mock(async () => {
        throw new Error('unsafe workflow')
      }),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow('unsafe workflow')
    expect(writes).toEqual([])
  })

  it('rejects an unknown key layout version before writing storage variables', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      readManifest: mock(async () => JSON.stringify({...manifest, key_layout_version: 'fro-bot-agent@v0.0.0'})),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow(
      /key_layout_version|known layout/i,
    )
    expect(writes).toEqual([])
  })

  it('accepts the literal key layout version emitted by the provisioner', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeDeps(writes, {
      // Must match apps/agent/src/key-layout.ts KEY_LAYOUT_VERSION.
      readManifest: mock(async () => JSON.stringify({...manifest, key_layout_version: 'fro-bot/agent@v0.96.0'})),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).resolves.toBeUndefined()
  })

  it('reports partial wiring when a later storage variable write fails', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    let writeCount = 0
    const deps = makeDeps(writes, {
      applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, _repo: string, value: string) => {
        writeCount += 1
        if (writeCount === 2) throw new Error('gh variable set failed')
        writes.push({kind, name, value})
      }),
    })

    await expect(runStorageSetup('owner/repo', {manifest: '-'}, deps)).rejects.toThrow(
      /partially wired.*FRO_BOT_S3_ROLE_TO_ASSUME/i,
    )
  })

  it('plans storage variables without applying them', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const messages: string[] = []
    const deps = makeDeps(writes, {log: message => messages.push(message)})

    await runStorageSetup('owner/repo', {manifest: '-', plan: true}, deps)

    expect(writes).toEqual([])
    expect(messages).toEqual(
      Object.values(STORAGE_VARIABLE_NAMES).map(name => `Would write GitHub variable ${name} to owner/repo.`),
    )
  })

  it('invokes the real workflow verifier by default when no explicit opt-out is provided', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const calls: string[][] = []
    const workflow = `
name: Fro Bot
on:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  storage:
    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')
    environment: fro-bot-storage
    permissions:
      contents: read
      id-token: write
    timeout-minutes: 30
    steps:
      - uses: aws-actions/configure-aws-credentials@c29ac295b8da06768b140c32e5bd0ae3aff45dc6
        with:
          role-to-assume: \${{ vars.FRO_BOT_S3_ROLE_TO_ASSUME }}
          aws-region: \${{ vars.FRO_BOT_S3_REGION }}
      - uses: fro-bot/agent@c29ac295b8da06768b140c32e5bd0ae3aff45dc6
        with:
          s3-backup: true
          s3-bucket: \${{ vars.FRO_BOT_S3_BUCKET }}
          aws-region: \${{ vars.FRO_BOT_S3_REGION }}
          s3-prefix: \${{ vars.FRO_BOT_S3_PREFIX }}
          s3-expected-bucket-owner: \${{ vars.FRO_BOT_S3_EXPECTED_BUCKET_OWNER }}
`
    const deps = makeDeps(writes, {
      verifyWorkflow: undefined,
      runGh: mock(async (args: string[]) => {
        calls.push(args)
        const path = args.at(-1) ?? ''
        if (path.includes('/contents/.github/workflows/fro-bot.yaml')) return makeGhResult(workflow)
        if (path.endsWith('/environments/fro-bot-storage')) {
          return makeGhResult(
            JSON.stringify({
              protection_rules: [{type: 'required_reviewers', reviewers: [{type: 'User'}]}],
              deployment_branch_policy: {protected_branches: false, custom_branch_policies: true},
            }),
          )
        }
        if (path.endsWith('/deployment-branch-policies')) {
          return makeGhResult(JSON.stringify({branch_policies: [{name: 'main', type: 'branch'}]}))
        }
        if (args[1]?.includes('/actions/oidc/customization/sub')) {
          return makeGhResult(JSON.stringify({use_default: true, use_immutable_subject: false}))
        }
        return makeGhResult(
          JSON.stringify({
            id: Number(manifest.repository_id),
            name: manifest.repo,
            owner: {login: manifest.owner, id: Number(manifest.repository_owner_id)},
          }),
        )
      }),
    })

    await runStorageSetup('owner/repo', {manifest: '-'}, deps)

    expect(calls.some(args => args.at(-1)?.includes('/contents/.github/workflows/fro-bot.yaml'))).toBe(true)
    expect(calls.some(args => args.at(-1)?.endsWith('/environments/fro-bot-storage'))).toBe(true)
  })
})

describe('agent S3 durable storage unwire', () => {
  it('deletes exactly the five S3 variables and leaves model variables and secrets untouched', async () => {
    const calls: string[][] = []
    const runGh = mock(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'variable' && args[1] === 'list') {
        return makeGhResult(
          JSON.stringify([...Object.values(STORAGE_VARIABLE_NAMES).map(name => ({name})), {name: 'FRO_BOT_MODEL'}]),
        )
      }
      if (args[0] === 'variable' && args[1] === 'delete') return makeGhResult('')
      throw new Error(`unexpected gh command: ${args.join(' ')}`)
    })

    await unwireStorageVariables('owner/repo', {runGh})

    expect(calls.filter(args => args[1] === 'delete')).toEqual(
      Object.values(STORAGE_VARIABLE_NAMES).map(name => ['variable', 'delete', name, '--repo', 'owner/repo', '--yes']),
    )
    expect(calls.some(args => args[0] === 'secret')).toBe(false)
    expect(calls.some(args => args.includes('FRO_BOT_MODEL'))).toBe(false)
  })

  it('is idempotent when no S3 variables are present', async () => {
    const calls: string[][] = []
    const runGh = mock(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'variable' && args[1] === 'list') return makeGhResult('[]')
      throw new Error(`unexpected gh command: ${args.join(' ')}`)
    })

    await expect(unwireStorageVariables('owner/repo', {runGh})).resolves.toBeUndefined()
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(['variable', 'list', '--repo', 'owner/repo', '--json', 'name'])
  })

  it('still deletes variables when a log callback is supplied outside plan mode', async () => {
    const calls: string[][] = []
    const runGh = mock(async (args: string[]) => {
      calls.push(args)
      if (args[0] === 'variable' && args[1] === 'list') {
        return makeGhResult(JSON.stringify([{name: STORAGE_VARIABLE_NAMES.bucket}]))
      }
      if (args[0] === 'variable' && args[1] === 'delete') return makeGhResult('')
      throw new Error(`unexpected gh command: ${args.join(' ')}`)
    })

    await unwireStorageVariables('owner/repo', {runGh, log: () => {}})

    expect(calls.some(args => args[1] === 'delete')).toBe(true)
  })

  it('unwires before invoking provisioner teardown and passes purge-state through', async () => {
    const events: string[] = []
    const deps = {
      runGh: mock(async (args: string[]) => {
        if (args[0] === 'api') {
          if (args[1]?.includes('/actions/oidc/customization/sub')) {
            return makeGhResult(JSON.stringify({use_default: true, use_immutable_subject: false}))
          }
          return makeGhResult(
            JSON.stringify({
              id: Number(manifest.repository_id),
              name: manifest.repo,
              owner: {login: manifest.owner, id: Number(manifest.repository_owner_id)},
            }),
          )
        }
        if (args[0] === 'variable' && args[1] === 'list') {
          return makeGhResult(JSON.stringify([{name: STORAGE_VARIABLE_NAMES.bucket}]))
        }
        if (args[0] === 'variable' && args[1] === 'delete') {
          events.push(`delete:${args[2]}`)
          return makeGhResult('')
        }
        throw new Error(`unexpected gh command: ${args.join(' ')}`)
      }),
      readManifest: mock(async () => JSON.stringify(manifest)),
      runProvisioner: mock(async (_raw: string, options: {purgeState?: boolean; plan?: boolean}) => {
        events.push(`provisioner:${String(options.purgeState)}:${String(options.plan)}`)
      }),
    }

    await runStorageTeardown('owner/repo', {manifest: '-', purgeState: true}, deps)

    expect(events).toEqual([`delete:${STORAGE_VARIABLE_NAMES.bucket}`, 'provisioner:true:false'])
  })
})
