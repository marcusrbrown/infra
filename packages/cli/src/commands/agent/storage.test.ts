/// <reference types="bun" />

import {describe, expect, it, mock} from 'bun:test'

import {runStorageSetup, STORAGE_VARIABLE_NAMES, type StorageManifest, type StorageSetupDeps} from './storage'

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
  key_layout_version: 'fro-bot-agent@v0.96.0',
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
    applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, _repo: string, value: string) => {
      writes.push({kind, name, value})
    }),
    ...overrides,
  } satisfies StorageSetupDeps
}

describe('agent S3 durable storage wiring', () => {
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

  it('calls the optional Unit-7 workflow verifier after S3 variables are wired', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const verifyWorkflow = mock(async () => {})
    const deps = makeDeps(writes, {verifyWorkflow})

    await runStorageSetup('owner/repo', {manifest: '-'}, deps)

    expect(verifyWorkflow).toHaveBeenCalledWith('owner/repo', manifest)
    expect(writes.every(write => write.kind === 'variable')).toBe(true)
  })
})
