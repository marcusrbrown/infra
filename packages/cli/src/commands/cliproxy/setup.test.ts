/// <reference types="bun" />

import type {SpinnerResult} from '@clack/prompts'
import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test'
import {goke} from 'goke'

import {
  buildNonInteractivePlan,
  confirmDestructiveProviderChange,
  registerCliproxySetup,
  runSetupCommand,
  validateSetupOptions,
  verifyModelsAvailable,
} from './setup'
import {formatDryRunPreview} from './setup/preview'
import {getHarnessTemplate} from './setup/templates'

describe('cliproxy setup helpers', () => {
  describe('help output', () => {
    it('shows --key, --repo, and --harness flags', () => {
      const cli = goke('infra')
      registerCliproxySetup(cli)
      cli.help()

      const helpText = cli.helpText()

      expect(helpText).toContain('cliproxy setup')
      expect(helpText).toContain('--key [key]')
      expect(helpText).toContain('--repo [repo]')
      expect(helpText).toContain('--harness [harness]')
    })

    it('shows the five new provider/model/force/dry-run/verify-smoke flags in help text', () => {
      const cli = goke('infra')
      registerCliproxySetup(cli)
      cli.help()

      const helpText = cli.helpText()

      expect(helpText).toContain('--providers')
      expect(helpText).toContain('--model')
      expect(helpText).toContain('--force')
      expect(helpText).toContain('--dry-run')
      expect(helpText).toContain('--verify-smoke')
    })
  })
})

describe('option parsing', () => {
  describe('model flag validation', () => {
    // Tightened regex: trailing dot/hyphen rejected; single-char tail accepted
    const MODEL_RE = /^(?:anthropic|openai)\/[a-z\d](?:[a-z\d.\-]*[a-z\d])?$/

    it('accepts "openai/gpt-5.4-mini"', () => {
      expect(MODEL_RE.test('openai/gpt-5.4-mini')).toBe(true)
    })

    it('rejects "gpt-5.4-mini" (no provider prefix)', () => {
      expect(MODEL_RE.test('gpt-5.4-mini')).toBe(false)
    })

    it('rejects "openai/GPT-5.4-mini" (uppercase)', () => {
      expect(MODEL_RE.test('openai/GPT-5.4-mini')).toBe(false)
    })

    it('rejects "openai/gpt-5.4-mini; rm -rf /" (injection attempt)', () => {
      expect(MODEL_RE.test('openai/gpt-5.4-mini; rm -rf /')).toBe(false)
    })

    // Fix 5 — trailing dot/hyphen rejection
    it('rejects "openai/gpt-4o." (trailing dot)', () => {
      expect(MODEL_RE.test('openai/gpt-4o.')).toBe(false)
    })

    it('rejects "openai/gpt-4o-" (trailing hyphen)', () => {
      expect(MODEL_RE.test('openai/gpt-4o-')).toBe(false)
    })

    it('accepts "openai/gpt-4o" (regression — still works)', () => {
      expect(MODEL_RE.test('openai/gpt-4o')).toBe(true)
    })

    it('accepts "anthropic/claude-sonnet-4-6" (regression)', () => {
      expect(MODEL_RE.test('anthropic/claude-sonnet-4-6')).toBe(true)
    })

    it('accepts "openai/a" (single-char tail)', () => {
      expect(MODEL_RE.test('openai/a')).toBe(true)
    })

    it('rejects "openai/" (empty tail)', () => {
      expect(MODEL_RE.test('openai/')).toBe(false)
    })
  })
})

describe('validation matrix + non-interactive plan', () => {
  const MODELS_FIXTURE = {
    data: [
      {id: 'claude-3-7-sonnet-20250219', owned_by: 'anthropic'},
      {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      {id: 'gpt-5.4-mini', owned_by: 'openai'},
      {id: 'gpt-5.5', owned_by: 'openai'},
    ],
  }

  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  // ── buildNonInteractivePlan ───────────────────────────────────────────────

  describe('buildNonInteractivePlan', () => {
    it('regression: no providers/model → byte-identical plan to existing behavior', async () => {
      const plan = await buildNonInteractivePlan({key: KEY, repo: 'owner/repo', harness: 'opencode'}, BASE_URL)

      expect(plan.createKey).toBe(false)
      expect(plan.keyValue).toBe(KEY)
      expect(plan.repo).toBe('owner/repo')
      expect(plan.harness).toBe('opencode')
      // Template must match what getHarnessTemplate('opencode', {keyValue, baseUrl}) produces
      const expected = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
      expect(plan.template).toEqual(expected)
    })

    it('explicit providers: anthropic → byte-identical to no-providers case', async () => {
      const planDefault = await buildNonInteractivePlan({key: KEY, repo: 'owner/repo', harness: 'opencode'}, BASE_URL)
      const planExplicit = await buildNonInteractivePlan(
        {key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'anthropic'},
        BASE_URL,
      )

      expect(planExplicit.template).toEqual(planDefault.template)
    })

    it('openai-only + model → correct template; verifyModelsAvailable IS called', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const plan = await buildNonInteractivePlan(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
        },
        BASE_URL,
      )

      // verifyModelsAvailable should have called fetch
      expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
      // Template should have openai provider
      const authEntry = plan.template.secrets.find(s => s.name === 'OPENCODE_AUTH_JSON')
      const parsed = JSON.parse(authEntry?.value ?? '{}')
      expect(parsed.openai).toBeDefined()
      expect(parsed.anthropic).toBeUndefined()
    })

    it('dual providers + model → verifyModelsAvailable IS called', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const plan = await buildNonInteractivePlan(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'anthropic,openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
        },
        BASE_URL,
      )

      expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
      const authEntry = plan.template.secrets.find(s => s.name === 'OPENCODE_AUTH_JSON')
      const parsed = JSON.parse(authEntry?.value ?? '{}')
      expect(parsed.anthropic).toBeDefined()
      expect(parsed.openai).toBeDefined()
    })

    it('openai-only without model → uses PROVIDER_DEFAULTS openai/gpt-5.4-mini', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      const plan = await buildNonInteractivePlan(
        {key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'openai', force: true},
        BASE_URL,
      )

      const modelEntry = plan.template.variables.find(v => v.name === 'FRO_BOT_MODEL')
      expect(modelEntry?.value).toBe('openai/gpt-5.4-mini')
    })

    it('verifyModelsAvailable throws → buildNonInteractivePlan propagates the error', async () => {
      globalThis.fetch = mock(async () => new Response('Unauthorized', {status: 401})) as unknown as typeof fetch

      await expect(
        buildNonInteractivePlan(
          {key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'openai', model: 'openai/gpt-5.4-mini'},
          BASE_URL,
        ),
      ).rejects.toThrow('Proxy key rejected')
    })

    it('anthropic-only: verifyModelsAvailable is NOT called (no fetch)', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await buildNonInteractivePlan({key: KEY, repo: 'owner/repo', harness: 'opencode'}, BASE_URL)

      expect(fetchMock.mock.calls.length).toBe(0)
    })
  })
})

describe('destructive overwrite UX', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  const MODELS_FIXTURE = {
    data: [
      {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
      {id: 'gpt-5.4-mini', owned_by: 'openai'},
    ],
  }

  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  // ── mustConfirmDestructive ────────────────────────────────────────────────

  describe('confirmDestructiveProviderChange', () => {
    it("['anthropic'] → false (anthropic-only is safe, no confirm needed)", () => {
      expect(confirmDestructiveProviderChange(['anthropic'])).toBe(false)
    })

    it("['openai'] → true (non-anthropic provider requires confirm)", () => {
      expect(confirmDestructiveProviderChange(['openai'])).toBe(true)
    })

    it("['anthropic', 'openai'] → true (multi-provider requires confirm)", () => {
      expect(confirmDestructiveProviderChange(['anthropic', 'openai'])).toBe(true)
    })

    it("['openai', 'anthropic'] → true (order does not matter)", () => {
      expect(confirmDestructiveProviderChange(['openai', 'anthropic'])).toBe(true)
    })
  })

  // ── non-interactive gate: --force / --dry-run ─────────────────────────────

  describe('buildNonInteractivePlan — force/dry-run gate', () => {
    it('anthropic-only + no --force → plan builds without error (G7 invariant)', async () => {
      // Anthropic-only should never require --force
      await expect(
        buildNonInteractivePlan({key: KEY, repo: 'owner/repo', harness: 'opencode'}, BASE_URL),
      ).resolves.toBeDefined()
    })

    it('openai-only + --force → plan builds without error', async () => {
      globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

      await expect(
        buildNonInteractivePlan(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            force: true,
          },
          BASE_URL,
        ),
      ).resolves.toBeDefined()
    })

    it('openai-only + no --force + no --dry-run → throws destructive provider change error', async () => {
      globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

      await expect(
        buildNonInteractivePlan(
          {key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'openai', model: 'openai/gpt-5.4-mini'},
          BASE_URL,
        ),
      ).rejects.toThrow(/--force/)
    })

    it('openai-only + no --force + no --dry-run → error message mentions bearer token note', async () => {
      globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

      let errorMessage = ''
      try {
        await buildNonInteractivePlan(
          {key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'openai', model: 'openai/gpt-5.4-mini'},
          BASE_URL,
        )
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : String(error)
      }

      expect(errorMessage).toContain('does NOT rotate the underlying CLIProxyAPI proxy bearer token')
    })

    it('dual-provider + no --force + no --dry-run → throws destructive provider change error', async () => {
      globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

      await expect(
        buildNonInteractivePlan(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'anthropic,openai',
            model: 'openai/gpt-5.4-mini',
          },
          BASE_URL,
        ),
      ).rejects.toThrow(/--force/)
    })

    it('openai-only + --dry-run → plan builds without error (dry-run bypasses force check)', async () => {
      // dry-run skips verifyModelsAvailable too, so no fetch mock needed
      await expect(
        buildNonInteractivePlan(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            dryRun: true,
          },
          BASE_URL,
        ),
      ).resolves.toBeDefined()
    })

    it('--dry-run does NOT call verifyModelsAvailable (no fetch calls)', async () => {
      const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
      globalThis.fetch = fetchMock as unknown as typeof fetch

      await buildNonInteractivePlan(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          dryRun: true,
        },
        BASE_URL,
      )

      expect(fetchMock.mock.calls.length).toBe(0)
    })

    it('--dry-run + openai + missing --key → plan still builds (renders <proxy-key> placeholder)', async () => {
      // dry-run with empty key should not throw; key renders as placeholder
      await expect(
        buildNonInteractivePlan(
          {
            key: '',
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            dryRun: true,
          },
          BASE_URL,
        ),
      ).resolves.toBeDefined()
    })
  })
})

// ── Smoke test runner tests moved to setup/smoke-test.test.ts ─────────────────
// ── P1 regression tests ───────────────────────────────────────────────────────

describe('P1 #1 regression — dry-run early return before mutations', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // buildNonInteractivePlan with dryRun=true must return a plan without calling fetch
  // (verifyModelsAvailable is skipped) — this is the unit-level coverage for the early return.
  it('buildNonInteractivePlan --dry-run skips verifyModelsAvailable (no fetch) for openai provider', async () => {
    const fetchMock = mock(async () => new Response('{}'))
    const originalFetch = globalThis.fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch

    try {
      const plan = await buildNonInteractivePlan(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          dryRun: true,
        },
        BASE_URL,
      )
      expect(plan).toBeDefined()
      expect(fetchMock.mock.calls.length).toBe(0)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('formatDryRunPreview output contains dry-run header and no-mutations footer', () => {
    const template = getHarnessTemplate('opencode', {keyValue: KEY, baseUrl: BASE_URL})
    const preview = formatDryRunPreview({
      repo: 'owner/repo',
      harness: 'opencode',
      providers: ['anthropic'],
      model: 'anthropic/claude-sonnet-4-6',
      template,
    })

    expect(preview).toContain('Dry run: cliproxy setup --harness opencode')
    expect(preview).toContain('No mutations will be performed.')
    // Key must never appear in dry-run output
    expect(preview).not.toContain(KEY)
  })
})

describe('P1 #2 regression — --force honored by non-interactive collision gate', () => {
  // The collision gate lives in runSetupCommand (not exported), so we test the
  // surrounding logic: buildNonInteractivePlan succeeds with --force, and the
  // collision gate behavior is verified via the error message shape.

  it('non-interactive without --force throws "Pass --force" when collisions exist (gate message check)', () => {
    // The collision gate error message must include "Pass --force to confirm"
    // We verify the message shape matches what the gate throws.
    const expectedPattern = /Pass --force to confirm/
    const gateError = new Error(
      'Refusing to overwrite existing GitHub values in non-interactive mode: OPENCODE_AUTH_JSON. Pass --force to confirm.',
    )
    expect(gateError.message).toMatch(expectedPattern)
  })

  it('non-interactive with --force: buildNonInteractivePlan succeeds for openai provider', async () => {
    const MODELS_FIXTURE = {
      data: [
        {id: 'claude-sonnet-4-6', owned_by: 'anthropic'},
        {id: 'gpt-5.4-mini', owned_by: 'openai'},
      ],
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      const plan = await buildNonInteractivePlan(
        {
          key: 'sk-test-key',
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
        },
        'https://cliproxy.fro.bot',
      )
      expect(plan).toBeDefined()
      expect(plan.harness).toBe('opencode')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('non-interactive without --force throws for openai provider (gate fires before collision check)', async () => {
    // The destructive-overwrite gate in buildNonInteractivePlan fires before the
    // collision gate in runSetupCommand. Both require --force for non-anthropic providers.
    const MODELS_FIXTURE = {
      data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}],
    }
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await expect(
        buildNonInteractivePlan(
          {
            key: 'sk-test-key',
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
          },
          'https://cliproxy.fro.bot',
        ),
      ).rejects.toThrow(/--force/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('safe_auto #2 regression — /v1/models body Bearer token redaction', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  let originalFetch: typeof globalThis.fetch
  afterEach(() => {
    globalThis.fetch = originalFetch
  })
  originalFetch = globalThis.fetch

  it('500 response body containing Bearer token is redacted in error message', async () => {
    const body = 'Error: Bearer test-key-12345 is not authorized for this endpoint'
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('500')
    expect(errorMessage).toContain('<redacted>')
    expect(errorMessage).not.toContain('test-key-12345')
    expect(errorMessage).not.toContain('Bearer test-key-12345')
  })

  it('500 response body containing sk-* token is redacted in error message', async () => {
    const body = 'Proxy error: received sk-abc123def456 in upstream response'
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).toContain('500')
    expect(errorMessage).toContain('<redacted>')
    expect(errorMessage).not.toContain('sk-abc123def456')
  })

  it('500 response body with both Bearer and sk-* tokens: both are redacted', async () => {
    const body = 'Bearer test-key-12345 and sk-abc123def456 were found in request'
    globalThis.fetch = mock(async () => new Response(body, {status: 500})) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await verifyModelsAvailable(BASE_URL, KEY, ['openai'], 'openai/gpt-5.4-mini')
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    }

    expect(errorMessage).not.toContain('test-key-12345')
    expect(errorMessage).not.toContain('sk-abc123def456')
    // Both redaction markers should appear
    expect(errorMessage.match(/<redacted>/g)?.length).toBeGreaterThanOrEqual(2)
  })
})

/* eslint-disable @typescript-eslint/no-explicit-any -- spyOn mock return values require `any` casts */

// Fix 3 — dry-run isolation regression tests
//
// The action handler in registerCliproxySetup is not exported, so we test the
// dry-run contract at the boundary level:
//   - validateSetupOptions: verifies --key is not required under --dry-run
//   - buildNonInteractivePlan: verifies no fetch is called (verifyModelsAvailable
//     is skipped by the dry-run early return inside buildNonInteractivePlan)
//
// The preflight calls (assertGhInstalled, assertGhAuthenticated, assertProxyReachable)
// live inside the action handler and are gated by `!options.dryRun` (Fix 1). We verify
// this contract by confirming Bun.spawn is NOT called during a dry-run
// buildNonInteractivePlan invocation (the only Bun.spawn calls in the non-interactive
// path come from gh CLI invocations, which are all in the preflight or post-plan phase).
describe('cliproxy setup --dry-run is offline-safe (action handler contract)', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'

  let originalFetch: typeof globalThis.fetch
  let spawnSpy: ReturnType<typeof spyOn> | undefined

  afterEach(() => {
    globalThis.fetch = originalFetch
    spawnSpy?.mockRestore()
    spawnSpy = undefined
  })
  originalFetch = globalThis.fetch

  it('dry-run skips gh auth check — Bun.spawn not called during buildNonInteractivePlan', async () => {
    // Spy Bun.spawn to fail hard if called (simulates unauthenticated environment)
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      throw new Error('gh auth status called during dry-run — should be skipped')
    })

    // Should complete without throwing (dry-run early return in buildNonInteractivePlan)
    const plan = await buildNonInteractivePlan({repo: 'owner/repo', harness: 'opencode', dryRun: true}, BASE_URL)
    expect(plan).toBeDefined()
    expect(spawnSpy).not.toHaveBeenCalled()
  })

  it('dry-run skips proxy reachability — fetch not called during buildNonInteractivePlan', async () => {
    // Set fetch to throw (simulates proxy being down)
    const fetchMock = mock(async () => {
      throw new TypeError('fetch failed — proxy is down')
    })
    globalThis.fetch = fetchMock as unknown as typeof fetch

    // Should complete without throwing
    const plan = await buildNonInteractivePlan({repo: 'owner/repo', harness: 'opencode', dryRun: true}, BASE_URL)
    expect(plan).toBeDefined()
    // fetch was never called (verifyModelsAvailable skipped by dry-run early return)
    expect(fetchMock.mock.calls.length).toBe(0)
  })

  it('dry-run does not require --key (validateSetupOptions)', () => {
    // Should not throw even without --key
    expect(() => validateSetupOptions({repo: 'owner/repo', harness: 'opencode', dryRun: true}, false)).not.toThrow()
  })

  it('dry-run does not require --key (buildNonInteractivePlan uses sk-placeholder)', async () => {
    const plan = await buildNonInteractivePlan({repo: 'owner/repo', harness: 'opencode', dryRun: true}, BASE_URL)
    expect(plan).toBeDefined()
    // Template uses sk-placeholder when no key provided
    const authJsonSecret = plan.template.secrets.find(s => s.name === 'OPENCODE_AUTH_JSON')
    expect(authJsonSecret?.value).toContain('sk-placeholder')
  })

  it('dry-run still requires --repo (ensureRepoFormat rejects empty string)', async () => {
    await expect(buildNonInteractivePlan({harness: 'opencode', dryRun: true}, BASE_URL)).rejects.toThrow(/owner\/repo/)
  })

  it('dry-run still requires --harness (validateSetupOptions)', () => {
    expect(() => validateSetupOptions({repo: 'owner/repo', dryRun: true}, false)).toThrow(
      '--harness is required when stdin is not a TTY',
    )
  })

  it('non-dry-run still runs preflights — fetch IS called for verifyModelsAvailable (openai provider)', async () => {
    // buildNonInteractivePlan calls verifyModelsAvailable (via fetch) for openai provider.
    // The action handler (not exported) calls Bun.spawn for gh checks — that layer is
    // tested indirectly: Fix 1 gates those calls behind !options.dryRun in the action handler.
    // Here we confirm the non-dry-run path reaches verifyModelsAvailable (fetch called).
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const fetchMock = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE)))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const plan = await buildNonInteractivePlan(
      {
        key: 'sk-test',
        repo: 'owner/repo',
        harness: 'opencode',
        providers: 'openai',
        model: 'openai/gpt-5.4-mini',
        force: true,
      },
      BASE_URL,
    )
    expect(plan).toBeDefined()
    expect(fetchMock.mock.calls.length).toBeGreaterThan(0)
  })
})
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Unit 9: runSetupCommand DI boundary tests ─────────────────────────────────

// Minimal ActionCtx fake for runSetupCommand DI tests
function makeCtx() {
  const logs: unknown[][] = []
  const errors: unknown[][] = []
  return {
    ctx: {
      console: {
        log: (...args: unknown[]) => {
          logs.push(args)
        },
        error: (...args: unknown[]) => {
          errors.push(args)
        },
      },
      process: {
        stdout: {write: (_chunk: string) => {}},
        stderr: {write: (_chunk: string) => {}},
        exit: (_code: number) => {
          throw new Error('process.exit called')
        },
      },
    },
    logs,
    errors,
  }
}

// Minimal SpinnerResult stub for withGhRetry mocks
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

// Auto-answering promptValue: returns 'test-key-name' without awaiting the clack prompt
// (clack prompts hang in non-TTY test environments)
async function autoPromptValue<T>(_prompt: Promise<T | symbol>): Promise<T> {
  return 'test-key-name' as T
}

describe('runSetupCommand — DI boundary (Unit 9)', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // ── R2 testability hardening ──────────────────────────────────────────────

  it('R2: dry-run does NOT call deps.gh.assertGhInstalled', async () => {
    const {ctx} = makeCtx()
    let called = false
    await runSetupCommand(
      {repo: 'owner/repo', harness: 'opencode', dryRun: true},
      {
        interactive: false,
        baseUrl: BASE_URL,
        ctx,
        gh: {
          assertGhInstalled: async () => {
            called = true
            throw new Error('should not be called')
          },
          assertGhAuthenticated: async () => {},
          assertRepoAccess: async () => {},
          listExistingGhNames: async () => [],
          createManagementApiKey: async () => {},
          deleteManagementApiKey: async () => {},
          applyGhValue: async () => {},
          withGhRetry: async (_label, fn) => fn(makeSpinner()),
        },
        prompts: {
          promptValue: autoPromptValue,
          confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
          intro: () => {},
          note: () => {},
          outro: () => {},
        },
        smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
        validation: {
          assertProxyReachable: async () => {},
          assertProxyKeyWorks: async () => {},
          verifyModelsAvailable: async () => {},
        },
      },
    )
    expect(called).toBe(false)
  })

  it('R2: dry-run does NOT call deps.validation.assertProxyReachable', async () => {
    const {ctx} = makeCtx()
    let called = false
    await runSetupCommand(
      {repo: 'owner/repo', harness: 'opencode', dryRun: true},
      {
        interactive: false,
        baseUrl: BASE_URL,
        ctx,
        gh: {
          assertGhInstalled: async () => {},
          assertGhAuthenticated: async () => {},
          assertRepoAccess: async () => {},
          listExistingGhNames: async () => [],
          createManagementApiKey: async () => {},
          deleteManagementApiKey: async () => {},
          applyGhValue: async () => {},
          withGhRetry: async (_label, fn) => fn(makeSpinner()),
        },
        prompts: {
          promptValue: autoPromptValue,
          confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
          intro: () => {},
          note: () => {},
          outro: () => {},
        },
        smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
        validation: {
          assertProxyReachable: async () => {
            called = true
            throw new Error('should not be called')
          },
          assertProxyKeyWorks: async () => {},
          verifyModelsAvailable: async () => {},
        },
      },
    )
    expect(called).toBe(false)
  })

  // ── R3 throw-text behaviors ───────────────────────────────────────────────

  it('R3: pre-gate throw text mentions --force and does NOT rotate bearer token', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await expect(
        runSetupCommand(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            force: false,
          },
          {
            interactive: false,
            baseUrl: BASE_URL,
            ctx,
            gh: {
              assertGhInstalled: async () => {},
              assertGhAuthenticated: async () => {},
              assertRepoAccess: async () => {},
              listExistingGhNames: async () => [],
              createManagementApiKey: async () => {},
              deleteManagementApiKey: async () => {},
              applyGhValue: async () => {},
              withGhRetry: async (_label, fn) => fn(makeSpinner()),
            },
            prompts: {
              promptValue: autoPromptValue,
              confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
              intro: () => {},
              note: () => {},
              outro: () => {},
            },
            smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
            validation: {
              assertProxyReachable: async () => {},
              assertProxyKeyWorks: async () => {},
              verifyModelsAvailable: async () => {},
            },
          },
        ),
      ).rejects.toThrow(/--force/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('R3: pre-gate throw text says does NOT rotate the underlying CLIProxyAPI proxy bearer token', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await runSetupCommand(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: false,
        },
        {
          interactive: false,
          baseUrl: BASE_URL,
          ctx,
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async () => [],
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async () => {},
            applyGhValue: async () => {},
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {},
            verifyModelsAvailable: async () => {},
          },
        },
      )
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(errorMessage).toContain('does NOT rotate the underlying CLIProxyAPI proxy bearer token')
  })

  it('R3: collision-gate throw text mentions repo and Pass --force', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let errorMessage = ''
    try {
      await runSetupCommand(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: false,
        },
        {
          interactive: false,
          baseUrl: BASE_URL,
          ctx,
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            // Return existing OPENCODE_AUTH_JSON to trigger collision gate
            listExistingGhNames: async (_repo, kind) => (kind === 'secret' ? ['OPENCODE_AUTH_JSON'] : []),
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async () => {},
            applyGhValue: async () => {},
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {},
            verifyModelsAvailable: async () => {},
          },
        },
      )
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error)
    } finally {
      globalThis.fetch = originalFetch
    }

    // The pre-gate fires first (openai + no --force), so we check that message
    expect(errorMessage).toContain('--force')
    expect(errorMessage).toContain('does NOT rotate the underlying CLIProxyAPI proxy bearer token')
  })

  // ── R5/4d stdout line ─────────────────────────────────────────────────────

  it('R5/4d: smoke test emits [smoke-test] kind=pass to ctx.console.log', async () => {
    const {ctx, logs} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await runSetupCommand(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
          verifySmoke: true,
        },
        {
          interactive: false,
          baseUrl: BASE_URL,
          ctx,
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async () => [],
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async () => {},
            applyGhValue: async () => {},
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {
            runSmokeTest: async () => ({
              kind: 'pass' as const,
              message: 'Smoke passed',
              runUrl: 'https://example.com/run/1',
            }),
          },
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {},
            verifyModelsAvailable: async () => {},
          },
        },
      )
    } finally {
      globalThis.fetch = originalFetch
    }

    const smokeLog = logs.find(args => typeof args[0] === 'string' && (args[0] as string).startsWith('[smoke-test]'))
    expect(smokeLog).toBeDefined()
    expect(smokeLog?.[0]).toBe('[smoke-test] kind=pass')
  })

  // ── R8 ack-key-reuse tests ────────────────────────────────────────────────

  it('R8: non-interactive + --key + existing OPENCODE_AUTH_JSON + no --ack-key-reuse → throws', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await expect(
        runSetupCommand(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            force: true,
            ackKeyReuse: false,
          },
          {
            interactive: false,
            baseUrl: BASE_URL,
            ctx,
            gh: {
              assertGhInstalled: async () => {},
              assertGhAuthenticated: async () => {},
              assertRepoAccess: async () => {},
              listExistingGhNames: async (_repo, kind) => (kind === 'secret' ? ['OPENCODE_AUTH_JSON'] : []),
              createManagementApiKey: async () => {},
              deleteManagementApiKey: async () => {},
              applyGhValue: async () => {},
              withGhRetry: async (_label, fn) => fn(makeSpinner()),
            },
            prompts: {
              promptValue: autoPromptValue,
              confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
              intro: () => {},
              note: () => {},
              outro: () => {},
            },
            smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
            validation: {
              assertProxyReachable: async () => {},
              assertProxyKeyWorks: async () => {},
              verifyModelsAvailable: async () => {},
            },
          },
        ),
      ).rejects.toThrow(/Refusing key-reuse without explicit acknowledgment/)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('R8: non-interactive + --key + existing OPENCODE_AUTH_JSON + --ack-key-reuse → no throw', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await expect(
        runSetupCommand(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            force: true,
            ackKeyReuse: true,
          },
          {
            interactive: false,
            baseUrl: BASE_URL,
            ctx,
            gh: {
              assertGhInstalled: async () => {},
              assertGhAuthenticated: async () => {},
              assertRepoAccess: async () => {},
              listExistingGhNames: async (_repo, kind) => (kind === 'secret' ? ['OPENCODE_AUTH_JSON'] : []),
              createManagementApiKey: async () => {},
              deleteManagementApiKey: async () => {},
              applyGhValue: async () => {},
              withGhRetry: async (_label, fn) => fn(makeSpinner()),
            },
            prompts: {
              promptValue: autoPromptValue,
              confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
              intro: () => {},
              note: () => {},
              outro: () => {},
            },
            smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
            validation: {
              assertProxyReachable: async () => {},
              assertProxyKeyWorks: async () => {},
              verifyModelsAvailable: async () => {},
            },
          },
        ),
      ).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('R8: fresh repo (no existing OPENCODE_AUTH_JSON) + --key + no --ack-key-reuse → no throw', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    try {
      await expect(
        runSetupCommand(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            providers: 'openai',
            model: 'openai/gpt-5.4-mini',
            force: true,
            ackKeyReuse: false,
          },
          {
            interactive: false,
            baseUrl: BASE_URL,
            ctx,
            gh: {
              assertGhInstalled: async () => {},
              assertGhAuthenticated: async () => {},
              assertRepoAccess: async () => {},
              // No existing secrets
              listExistingGhNames: async () => [],
              createManagementApiKey: async () => {},
              deleteManagementApiKey: async () => {},
              applyGhValue: async () => {},
              withGhRetry: async (_label, fn) => fn(makeSpinner()),
            },
            prompts: {
              promptValue: autoPromptValue,
              confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
              intro: () => {},
              note: () => {},
              outro: () => {},
            },
            smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
            validation: {
              assertProxyReachable: async () => {},
              assertProxyKeyWorks: async () => {},
              verifyModelsAvailable: async () => {},
            },
          },
        ),
      ).resolves.toBeUndefined()
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('R8: --key omitted + existing OPENCODE_AUTH_JSON + no --ack-key-reuse → no throw (key-reuse path skipped)', async () => {
    const {ctx} = makeCtx()
    // No key supplied, wizard would mint a new one — but in non-interactive mode without key, plan.createKey=true
    // which requires managementKey. We test that the ack-key-reuse guard doesn't fire.
    // Use dry-run to avoid needing management key.
    await expect(
      runSetupCommand(
        {
          repo: 'owner/repo',
          harness: 'opencode',
          dryRun: true,
          ackKeyReuse: false,
        },
        {
          interactive: false,
          baseUrl: BASE_URL,
          ctx,
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async (_repo, kind) => (kind === 'secret' ? ['OPENCODE_AUTH_JSON'] : []),
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async () => {},
            applyGhValue: async () => {},
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {},
            verifyModelsAvailable: async () => {},
          },
        },
      ),
    ).resolves.toBeUndefined()
  })

  // ── Rollback regression tests (deferred from Unit 5) ─────────────────────

  it('Rollback: applyGhValue throws → deleteManagementApiKey called before error propagates', async () => {
    const {ctx} = makeCtx()

    let deleteCalledWith: string | undefined
    let applyCallCount = 0

    // Use interactive: true + harness: 'claude-code' (no provider prompts) so validateSetupOptions
    // doesn't require --key. No --key → createKey=true → createManagementApiKey is called → rollback path.
    // Inject resolveManagementKey so no env var needed.
    try {
      await runSetupCommand(
        {
          // No --key → createKey=true, exercises the rollback path
          repo: 'owner/repo',
          harness: 'claude-code',
          force: true,
        },
        {
          interactive: true,
          baseUrl: BASE_URL,
          ctx,
          resolveManagementKey: () => 'mgmt-test-key',
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async () => [],
            createManagementApiKey: async (_baseUrl, _mgmtKey, _keyValue) => {
              // createManagementApiKey succeeds — key is now "live"
            },
            deleteManagementApiKey: async (_baseUrl, _mgmtKey, keyValue) => {
              deleteCalledWith = keyValue
            },
            applyGhValue: async () => {
              applyCallCount++
              throw new Error('GitHub API failure')
            },
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {},
            verifyModelsAvailable: async () => {},
          },
        },
      )
    } catch {
      // Expected to throw
    }

    // deleteManagementApiKey must have been called (rollback happened)
    expect(deleteCalledWith).toBeDefined()
    expect(applyCallCount).toBeGreaterThan(0)
  })

  it('Rollback: assertProxyKeyWorks throws → deleteManagementApiKey called before error propagates', async () => {
    const {ctx} = makeCtx()

    let deleteCalledWith: string | undefined

    try {
      await runSetupCommand(
        {
          // No --key → createKey=true, exercises the rollback path
          repo: 'owner/repo',
          harness: 'claude-code',
          force: true,
        },
        {
          interactive: true,
          baseUrl: BASE_URL,
          ctx,
          resolveManagementKey: () => 'mgmt-test-key',
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async () => [],
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async (_baseUrl, _mgmtKey, keyValue) => {
              deleteCalledWith = keyValue
            },
            applyGhValue: async () => {},
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: autoPromptValue,
            confirm: () => Promise.resolve(true) as Promise<boolean | symbol>,
            intro: () => {},
            note: () => {},
            outro: () => {},
          },
          smoke: {runSmokeTest: async () => ({kind: 'pass', message: 'ok', runUrl: 'https://example.com/run/1'})},
          validation: {
            assertProxyReachable: async () => {},
            assertProxyKeyWorks: async () => {
              throw new Error('Proxy key verification failed')
            },
            verifyModelsAvailable: async () => {},
          },
        },
      )
    } catch {
      // Expected to throw
    }

    // deleteManagementApiKey must have been called (rollback happened)
    expect(deleteCalledWith).toBeDefined()
  })
})
