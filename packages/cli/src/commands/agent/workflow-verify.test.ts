/// <reference types="bun" />

import {describe, expect, it, mock} from 'bun:test'

import {inspectWorkflow, verifyWorkflow, type EnvironmentReadback, type WorkflowVerifyDeps} from './workflow-verify'

// Must match apps/agent/src/key-layout.ts PINNED_ACTION_SHA.
const SHA = 'c29ac295b8da06768b140c32e5bd0ae3aff45dc6'
// Must match apps/agent/src/key-layout.ts PINNED_ACTION_REF.
const ACTION_TAG = 'v0.96.0'
const CREDENTIALS_STEP = `      - uses: aws-actions/configure-aws-credentials@${SHA}
        with:
          role-to-assume: \${{ vars.FRO_BOT_S3_ROLE_TO_ASSUME }}
          aws-region: \${{ vars.FRO_BOT_S3_REGION }}`
const AGENT_STEP = `      - uses: fro-bot/agent@${SHA}
        with:
          s3-backup: true
          s3-bucket: \${{ vars.FRO_BOT_S3_BUCKET }}
          aws-region: \${{ vars.FRO_BOT_S3_REGION }}
          s3-prefix: \${{ vars.FRO_BOT_S3_PREFIX }}
          s3-expected-bucket-owner: \${{ vars.FRO_BOT_S3_EXPECTED_BUCKET_OWNER }}`

const manifest = {
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
  action_ref_verified: true as const,
  // Must match apps/agent/src/key-layout.ts KEY_LAYOUT_VERSION.
  key_layout_version: 'fro-bot/agent@v0.96.0',
}

const environment: EnvironmentReadback = {
  name: 'fro-bot-storage',
  protection_rules: [
    {
      type: 'required_reviewers',
      reviewers: [{type: 'User', reviewer: {login: 'reviewer'}}],
    },
  ],
  deployment_branch_policy: {
    protected_branches: false,
    custom_branch_policies: true,
  },
  branch_policies: [{name: 'main', type: 'branch'}],
}

function workflowJob(action = true): string {
  return `
name: Fro Bot
on:
  pull_request:
  issue_comment:
  schedule:
    - cron: '0 3 * * *'
  workflow_dispatch:
permissions:
  contents: read
jobs:
  content:
    if: github.event_name == 'pull_request' || github.event_name == 'issue_comment'
    permissions:
      contents: read
    steps:
      - run: echo content
  storage:
    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')
    environment: fro-bot-storage
    permissions:
      contents: read
      id-token: write
    timeout-minutes: 30
    steps:
${action ? `${CREDENTIALS_STEP}\n${AGENT_STEP}` : '      - run: echo storage'}
`
}

function result(stdout: string, exitCode = 0, stderr = '') {
  return {stdout, stderr, exitCode}
}

function makeDeps(
  workflow: string,
  environmentValue: EnvironmentReadback | null = environment,
  overrides: Partial<WorkflowVerifyDeps> = {},
): WorkflowVerifyDeps & {calls: string[][]} {
  const calls: string[][] = []
  const runGh = mock(async (args: string[]) => {
    calls.push(args)
    const path = args.at(-1) ?? ''
    if (path.includes('/contents/.github/workflows/fro-bot.yaml')) return result(workflow)
    if (path.endsWith('/environments/fro-bot-storage')) {
      return environmentValue
        ? result(JSON.stringify({...environmentValue, branch_policies: undefined}))
        : result('', 1, 'gh: Not Found (HTTP 404)')
    }
    if (path.endsWith('/deployment-branch-policies')) {
      return environmentValue
        ? result(JSON.stringify({branch_policies: environmentValue.branch_policies}))
        : result('', 1, 'not found')
    }
    return result('', 1, `unexpected gh api path ${path}`)
  })

  return {runGh, calls, ...overrides}
}

describe('workflow storage verifier', () => {
  it('passes a protected schedule/dispatch storage split and environment readback', async () => {
    const deps = makeDeps(workflowJob())

    const report = await inspectWorkflow('owner/repo', manifest, deps)
    expect(report.workflowYamlCompliant, JSON.stringify(report)).toBe(true)
    expect(report.environmentPolicyVerified).toBe(true)
    expect(report.violations).toEqual([])
    await expect(verifyWorkflow('owner/repo', manifest, deps)).resolves.toBeUndefined()
  })

  it('accepts the exact verified action SHA for the manifest layout', async () => {
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(workflowJob()))).resolves.toBeUndefined()
  })

  it('rejects the moveable verified tag for the storage job', async () => {
    const tagged = workflowJob().replace(`fro-bot/agent@${SHA}`, `fro-bot/agent@${ACTION_TAG}`)

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(tagged))).rejects.toThrow(
      /must pin fro-bot\/agent to the verified SHA.*not a moveable tag/i,
    )
  })

  it('rejects an unverified action SHA for the manifest layout', async () => {
    const otherSha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    const unsafe = workflowJob().replace(`fro-bot/agent@${SHA}`, `fro-bot/agent@${otherSha}`)

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(
      /action ref .* is not the verified layout/i,
    )
  })

  it('rejects a wrong action tag for the manifest layout', async () => {
    const unsafe = workflowJob().replace(`fro-bot/agent@${SHA}`, 'fro-bot/agent@v0.95.0')

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(
      /action ref .* is not the verified layout/i,
    )
  })

  it('fails closed when the manifest layout is unknown', async () => {
    const unknownManifest = {...manifest, key_layout_version: 'fro-bot/agent@v0.95.0'}

    await expect(verifyWorkflow('owner/repo', unknownManifest, makeDeps(workflowJob()))).rejects.toThrow(
      /unknown.*key_layout_version|unknown.*layout/i,
    )
  })

  it('rejects workflow-level id-token write', async () => {
    const deps = makeDeps(workflowJob().replace('permissions:\n  contents: read', 'permissions:\n  id-token: write'))

    await expect(verifyWorkflow('owner/repo', manifest, deps)).rejects.toThrow(/workflow-level.*id-token/i)
  })

  it('rejects a content-reachable job with job-level write-all permissions', async () => {
    const unsafe = workflowJob().replace(
      '    permissions:\n      contents: read\n    steps:',
      '    permissions: write-all\n    steps:',
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(/write-all|id-token/i)
  })

  it('rejects a storage job using write-all instead of explicit id-token write', async () => {
    const unsafe = workflowJob().replace(
      `    permissions:\n      contents: read\n      id-token: write`,
      '    permissions: write-all',
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(
      /explicit|write-all|storage/i,
    )
  })

  it('rejects an id-token job reachable from a content event', async () => {
    const unsafe = workflowJob().replace(
      "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      "if: github.event_name == 'pull_request'",
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(/content|pull_request/i)
  })

  it.each(['pull_request_target', 'workflow_run'])('rejects %s reaching storage', event => {
    const unsafe = workflowJob()
      .replace('  issue_comment:\n', `  issue_comment:\n  ${event}:\n`)
      .replace(
        "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
        `if: github.event_name == '${event}'`,
      )
    return expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(
      new RegExp(`${event}|unsafe|content`, 'i'),
    )
  })

  it('rejects an artifact/output handoff from a content-reachable job', async () => {
    const poisoned = workflowJob().replace(
      "    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      "    needs: content\n    if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
    )
    const withHandoff = poisoned.replace(
      `      - uses: fro-bot/agent@${SHA}`,
      `      - uses: actions/download-artifact@${SHA}\n      - uses: fro-bot/agent@${SHA}`,
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(withHandoff))).rejects.toThrow(
      /handoff|artifact|poison/i,
    )
  })

  it('rejects an unpinned reusable workflow and permits a pinned separately verified one', async () => {
    const unpinned = workflowJob().replace(
      `    steps:\n${CREDENTIALS_STEP}\n${AGENT_STEP}`,
      '    uses: owner/storage-workflow@main',
    )
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unpinned))).rejects.toThrow(/reusable|pinned/i)

    const pinned = workflowJob().replace(
      `    steps:\n${CREDENTIALS_STEP}\n${AGENT_STEP}`,
      `    uses: owner/storage-workflow@${SHA}`,
    )
    const verifyReusableWorkflow = mock(async () => {})
    await expect(
      verifyWorkflow('owner/repo', manifest, makeDeps(pinned, environment, {verifyReusableWorkflow})),
    ).resolves.toBeUndefined()
    expect(verifyReusableWorkflow).toHaveBeenCalledWith(`owner/storage-workflow@${SHA}`)
  })

  it('rejects a SHA-pinned reusable storage workflow without separate verification', async () => {
    const pinned = workflowJob().replace(
      `    steps:\n${CREDENTIALS_STEP}\n${AGENT_STEP}`,
      `    uses: owner/storage-workflow@${SHA}`,
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(pinned))).rejects.toThrow(
      /has not been separately verified/i,
    )
  })

  it('rejects a trigger outside schedule and main workflow_dispatch', async () => {
    const unsafe = workflowJob().replace('  issue_comment:\n', '  push:\n')

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unsafe))).rejects.toThrow(/push|unsafe|content/i)
  })

  it('rejects an unguarded workflow_dispatch storage job on non-main refs', async () => {
    const unguarded = workflowJob().replace(
      "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      "if: github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'",
    )

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(unguarded))).rejects.toThrow(
      /refs\/heads\/main|reachable/i,
    )
  })

  it('fails closed on dynamic if and matrix expressions', async () => {
    const dynamicIf = workflowJob().replace(
      "if: github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main')",
      'if: $' + '{{ inputs.allow_storage }}',
    )
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(dynamicIf))).rejects.toThrow(/dynamic|if|prove/i)

    const dynamicMatrix = workflowJob().replace(
      '    environment: fro-bot-storage',
      '    strategy:\n      matrix: $' + '{{ fromJSON(vars.STORAGE_MATRIX) }}\n    environment: fro-bot-storage',
    )
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(dynamicMatrix))).rejects.toThrow(/matrix|dynamic/i)
  })

  it('flags an unpinned agent step and missing S3 inputs', async () => {
    const missing = workflowJob()
      .replace(`fro-bot/agent@${SHA}`, 'fro-bot/agent@v0.95.0')
      .replace('s3-prefix:', 'other-prefix:')
    const report = await inspectWorkflow('owner/repo', manifest, makeDeps(missing))

    expect(report.workflowYamlCompliant).toBe(false)
    expect(report.violations.join('\n')).toMatch(/SHA|S3/i)
  })

  it('requires s3-backup true on the agent action', async () => {
    const missing = workflowJob().replace('          s3-backup: true\n', '')
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(missing))).rejects.toThrow(/s3-backup/i)

    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(workflowJob()))).resolves.toBeUndefined()
  })

  it('requires OIDC credentials and rejects static AWS credentials in storage jobs', async () => {
    const missingCredentials = workflowJob().replace(`${CREDENTIALS_STEP}\n`, '')
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(missingCredentials))).rejects.toThrow(
      /configure-aws-credentials|OIDC|credentials/i,
    )

    const staticCredentials = workflowJob().replace(
      '    timeout-minutes: 30',
      '    timeout-minutes: 30\n    env:\n      AWS_ACCESS_KEY_ID: hard-coded\n      AWS_SECRET_ACCESS_KEY: hard-coded',
    )
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(staticCredentials))).rejects.toThrow(/static AWS/i)
  })

  it.each([
    ['missing', null],
    ['without a required reviewer', {...environment, protection_rules: []}],
    ['without a main-only branch policy', {...environment, branch_policies: [{name: 'develop', type: 'branch'}]}],
  ] as const)('fails closed when environment policy is %s', async (_label, value) => {
    const report = await inspectWorkflow('owner/repo', manifest, makeDeps(workflowJob(), value))

    expect(report.workflowYamlCompliant).toBe(true)
    expect(report.environmentPolicyVerified).toBe(false)
    expect(report.environmentViolations.length).toBeGreaterThan(0)
    await expect(verifyWorkflow('owner/repo', manifest, makeDeps(workflowJob(), value))).rejects.toThrow(
      /GitHub Environment policy verified: NO/,
    )
  })

  it('emits a unified pasteable diff and never writes the workflow', async () => {
    const calls: string[][] = []
    const deps = makeDeps(workflowJob(false), environment, {
      runGh: mock(async (args: string[]) => {
        calls.push(args)
        const path = args.at(-1) ?? ''
        if (path.includes('/contents/.github/workflows/fro-bot.yaml')) return result(workflowJob(false))
        if (path.endsWith('/environments/fro-bot-storage'))
          return result(JSON.stringify({...environment, branch_policies: undefined}))
        if (path.endsWith('/deployment-branch-policies'))
          return result(JSON.stringify({branch_policies: environment.branch_policies}))
        return result('', 1, 'unexpected mutation')
      }),
    })

    const report = await inspectWorkflow('owner/repo', manifest, deps)

    expect(report.diff).toContain('--- a/.github/workflows/fro-bot.yaml')
    expect(report.diff).toContain('+++ b/.github/workflows/fro-bot.yaml')
    expect(report.diff).toContain('fro-bot-storage')
    expect(calls.every(args => args[0] === 'api')).toBe(true)
  })
})
