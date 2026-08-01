/// <reference types="bun" />

import type {SpinnerResult} from '@clack/prompts'

import {log} from '@clack/prompts'
import {describe, expect, it, mock, spyOn} from 'bun:test'
import {goke} from 'goke'

import {registerCliproxySetup, runSetupCommand} from '../cliproxy/setup'
import {MCP_ALLOWLIST} from '../mcp'
import {registerAgentCommands} from './index'
import {runAgentSetupCommand} from './setup'

function makeSpinner(): SpinnerResult {
  return {
    message: () => {},
    start: () => {},
    stop: () => {},
    cancel: () => {},
    error: () => {},
    clear: () => {},
    isCancelled: false,
  }
}

function makeCtx() {
  const logs: unknown[][] = []
  const errors: unknown[][] = []

  return {
    ctx: {
      console: {
        log: (...args: unknown[]) => logs.push(args),
        error: (...args: unknown[]) => errors.push(args),
      },
      process: {
        stdout: {write: (_chunk: string) => {}},
        stderr: {write: (_chunk: string) => {}},
        exit: (code: number) => {
          throw new Error(`process.exit called with ${code}`)
        },
      },
    },
    logs,
    errors,
  }
}

function makeSetupDeps(writes: {kind: string; name: string; value: string}[]) {
  const {ctx} = makeCtx()
  let listCallCount = 0

  return {
    interactive: false,
    baseUrl: 'https://cliproxy.fro.bot',
    ctx,
    gh: {
      assertGhInstalled: mock(async () => {}),
      assertGhAuthenticated: mock(async () => {}),
      assertRepoAccess: mock(async () => {}),
      listExistingGhNames: mock(async (_repo: string, kind: 'secret' | 'variable') => {
        listCallCount += 1
        if (listCallCount <= 2) return []
        return kind === 'secret' ? ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG'] : ['FRO_BOT_MODEL']
      }),
      createManagementApiKey: mock(async () => {}),
      deleteManagementApiKey: mock(async () => {}),
      applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, _repo: string, value: string) => {
        writes.push({kind, name, value})
      }),
      withGhRetry: async <T>(_label: string, fn: (spinner: SpinnerResult) => Promise<T>): Promise<T> =>
        fn(makeSpinner()),
    },
    prompts: {
      promptValue: async <T>(_prompt: Promise<T | symbol>): Promise<T> => true as T,
      confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
      intro: () => {},
      note: () => {},
      outro: () => {},
      promptForProviders: async (): Promise<('anthropic' | 'openai')[]> => ['anthropic'],
      promptForModel: async () => 'anthropic/claude-sonnet-4-6',
    },
    smoke: {runSmokeTest: async () => ({kind: 'pass' as const, message: 'ok', runUrl: 'https://example.com/run/1'})},
    validation: {
      assertProxyReachable: async () => {},
      assertProxyKeyWorks: async () => {},
      verifyModelsAvailable: async () => {},
    },
    workflow: {
      checkFroBotWorkflow: async () => ({kind: 'analyzed' as const, stepsWithGaps: []}),
    },
  }
}

describe('agent setup command', () => {
  it('registers the agent group and keeps mutating setup commands out of MCP', () => {
    const cli = goke('infra')
    registerAgentCommands(cli)
    cli.help()

    expect(cli.helpText()).toContain('agent setup')
    expect(MCP_ALLOWLIST.has('agent setup')).toBe(false)
    expect([...MCP_ALLOWLIST].some(command => command.startsWith('agent'))).toBe(false)
  })

  it('describes agent setup as generalized Fro Bot agent configuration', () => {
    const cli = goke('infra')
    registerAgentCommands(cli)
    cli.help()

    expect(cli.helpText()).toContain('generalized Fro Bot agent model-credential setup')
  })

  it('matches cliproxy setup model-credential writes and warnings', async () => {
    const options = {
      key: 'sk-test-key',
      repo: 'owner/repo',
      harness: 'opencode' as const,
    }
    const legacyWrites: {kind: string; name: string; value: string}[] = []
    const agentWrites: {kind: string; name: string; value: string}[] = []
    const warningSets: string[][] = []
    const warnSpy = spyOn(log, 'warn').mockImplementation((message: string) => {
      const current = warningSets.at(-1)
      current?.push(message)
    })

    try {
      warningSets.push([])
      await runSetupCommand(options, makeSetupDeps(legacyWrites))
      warningSets.push([])
      await runAgentSetupCommand(options, makeSetupDeps(agentWrites))
    } finally {
      warnSpy.mockRestore()
    }

    expect(agentWrites).toEqual(legacyWrites)
    expect(warningSets[1]).toEqual(warningSets[0])
  })

  it('supports the interactive entrypoint', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const deps = makeSetupDeps(writes)

    await runAgentSetupCommand(
      {
        key: 'sk-test-key',
        repo: 'owner/repo',
        harness: 'opencode',
      },
      {
        ...deps,
        interactive: true,
      },
    )

    expect(writes.map(write => write.name)).toEqual(['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG', 'FRO_BOT_MODEL'])
  })

  it('dry-run short-circuits before validation', async () => {
    const {ctx, logs} = makeCtx()
    let validationCalled = false

    await runAgentSetupCommand(
      {dryRun: true},
      {
        interactive: false,
        ctx,
        validation: {
          assertProxyReachable: async () => {
            validationCalled = true
            throw new Error('validation should not run')
          },
          assertProxyKeyWorks: async () => {},
          verifyModelsAvailable: async () => {},
        },
      },
    )

    expect(validationCalled).toBe(false)
    expect(logs[0]?.[0]).toContain('Dry run: agent setup')
  })

  it('runs storage verification before model writes and fails closed', async () => {
    const writes: {kind: string; name: string; value: string}[] = []
    const setupDeps = makeSetupDeps(writes)
    const storageManifest = {
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
    const storageDeps = {
      readManifest: mock(async () => JSON.stringify(storageManifest)),
      runGh: mock(async (args: string[]) => {
        if (args[1]?.includes('/actions/oidc/customization/sub')) {
          return {stdout: JSON.stringify({use_default: true, use_immutable_subject: false}), stderr: '', exitCode: 0}
        }
        return {
          stdout: JSON.stringify({
            id: 12345,
            name: 'repo',
            owner: {login: 'owner', id: 67890},
          }),
          stderr: '',
          exitCode: 0,
        }
      }),
      verifyResources: mock(async () => {}),
      verifyWorkflow: mock(async () => {
        throw new Error('storage workflow precheck failed')
      }),
      applyGhValue: mock(async () => {
        throw new Error('storage variables must not be written')
      }),
    }

    await expect(
      runAgentSetupCommand(
        {key: 'sk-test-key', repo: 'owner/repo', harness: 'opencode', storage: {manifest: '-'}},
        {...setupDeps, storage: storageDeps},
      ),
    ).rejects.toThrow('storage workflow precheck failed')
    expect(writes).toEqual([])
  })

  it('applies storage only after the model setup command succeeds', async () => {
    const events: string[] = []
    const modelWrites: {kind: string; name: string; value: string}[] = []
    const setupDeps = makeSetupDeps(modelWrites)
    const storageManifest = {
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
    const storageDeps = {
      readManifest: mock(async () => JSON.stringify(storageManifest)),
      runGh: mock(async (args: string[]) =>
        args[1]?.includes('/actions/oidc/customization/sub')
          ? {stdout: JSON.stringify({use_default: true, use_immutable_subject: false}), stderr: '', exitCode: 0}
          : {
              stdout: JSON.stringify({id: 12345, name: 'repo', owner: {login: 'owner', id: 67890}}),
              stderr: '',
              exitCode: 0,
            },
      ),
      verifyResources: mock(async () => {}),
      verifyWorkflow: mock(async () => {
        events.push('storage-verify')
      }),
      applyGhValue: mock(async () => {
        events.push('storage-apply')
      }),
    }
    const modelGh = setupDeps.gh

    await runAgentSetupCommand(
      {key: 'sk-test-key', repo: 'owner/repo', harness: 'opencode', storage: {manifest: '-'}},
      {
        ...setupDeps,
        gh: {
          ...modelGh,
          applyGhValue: mock(async (kind: 'secret' | 'variable', name: string, repo: string, value: string) => {
            events.push('model-apply')
            await modelGh.applyGhValue(kind, name, repo, value)
          }),
        },
        storage: storageDeps,
      },
    )

    expect(events[0]).toBe('storage-verify')
    expect(events.at(-1)).toBe('storage-apply')
    expect(events).toContain('model-apply')
    expect(modelWrites.length).toBeGreaterThan(0)
  })

  it('registers the compatibility wrapper as a separate multiword command', () => {
    const cli = goke('infra')
    registerCliproxySetup(cli)
    cli.help()

    expect(cli.helpText()).toContain('cliproxy setup')
    expect(cli.helpText()).not.toContain('agent --alias')
  })
})
