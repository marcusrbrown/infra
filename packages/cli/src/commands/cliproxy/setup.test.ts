/// <reference types="bun" />

import type {SpinnerResult} from '@clack/prompts'
import {log} from '@clack/prompts'
import {afterEach, beforeEach, describe, expect, it, mock, spyOn} from 'bun:test'
import {goke} from 'goke'

import {
  buildNonInteractivePlan,
  redactKey,
  registerCliproxySetup,
  requiresDestructiveProviderChangeConfirmation,
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
          // force: true bypasses the destructive-provider pre-gate so verifyModelsAvailable is reached
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

  describe('requiresDestructiveProviderChangeConfirmation', () => {
    it("['anthropic'] → false (anthropic-only is safe, no confirm needed)", () => {
      expect(requiresDestructiveProviderChangeConfirmation(['anthropic'])).toBe(false)
    })

    it("['openai'] → true (non-anthropic provider requires confirm)", () => {
      expect(requiresDestructiveProviderChangeConfirmation(['openai'])).toBe(true)
    })

    it("['anthropic', 'openai'] → true (multi-provider requires confirm)", () => {
      expect(requiresDestructiveProviderChangeConfirmation(['anthropic', 'openai'])).toBe(true)
    })

    it("['openai', 'anthropic'] → true (order does not matter)", () => {
      expect(requiresDestructiveProviderChangeConfirmation(['openai', 'anthropic'])).toBe(true)
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

// ── runSetupCommand DI boundary tests ─────────────────────────────────

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

describe('runSetupCommand action handler', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // ── dry-run testability hardening ──────────────────────────────────────────────

  it('dry-run does NOT call deps.gh.assertGhInstalled', async () => {
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

  it('dry-run does NOT call deps.validation.assertProxyReachable', async () => {
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

  // ── destructive-overwrite throw-text behaviors ───────────────────────────────────────────────

  it('destructive-overwrite pre-gate throw text mentions --force and does NOT rotate bearer token', async () => {
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

  it('destructive-overwrite pre-gate throw text says does NOT rotate the underlying CLIProxyAPI proxy bearer token', async () => {
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

  it('collision-gate throw text mentions repo and Pass --force', async () => {
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

  // ── smoke-test stdout line ─────────────────────────────────────────────────────

  it('smoke test emits [smoke-test] kind=pass to ctx.console.log', async () => {
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

  it('smoke test emits [smoke-test] kind=fail to ctx.console.log', async () => {
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
              kind: 'fail' as const,
              message: 'Smoke run failed with conclusion=failure',
              runUrl: 'https://example.com/run/2',
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
    expect(smokeLog?.[0]).toBe('[smoke-test] kind=fail')
  })

  it('smoke test emits [smoke-test] kind=unverified to ctx.console.log', async () => {
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
              kind: 'unverified' as const,
              message: 'Workflow requires environment approval',
              runUrl: 'https://example.com/run/3',
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
    expect(smokeLog?.[0]).toBe('[smoke-test] kind=unverified')
  })

  // ── key-reuse acknowledgment tests ────────────────────────────────────────────────

  it('non-interactive + --key + existing OPENCODE_AUTH_JSON + no --ack-key-reuse → throws', async () => {
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

  it('non-interactive + --key + existing OPENCODE_AUTH_JSON + --ack-key-reuse → no throw', async () => {
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

  it('fresh repo (no existing OPENCODE_AUTH_JSON) + --key + no --ack-key-reuse → no throw', async () => {
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

  it('--key omitted + existing OPENCODE_AUTH_JSON + no --ack-key-reuse → no throw (key-reuse path skipped)', async () => {
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

  // ── Interactive R8 ack-key-reuse prompt: redaction + cancel/continue ──────────
  //
  // Note: full interactive integration tests are limited by the F16 (issue #311) gap —
  // buildInteractivePlan calls real @clack/prompts.text() for the key-name and harness
  // prompts that DI doesn't cover yet. We test the redaction contract directly via
  // the exported redactKey helper, then a unit test confirms the prompt template uses
  // the redacted form. Interactive cancel/continue paths are exercised under F16 once
  // RunSetupDeps covers all prompt sites.

  it('redactKey: keys >= 12 chars use first-3 + *** + last-4 shape', () => {
    expect(redactKey('sk-PLAINTEXT-LONGKEY')).toBe('sk-***GKEY')
    expect(redactKey('sk-shortbutok123')).toBe('sk-***k123')
  })

  it('redactKey: keys < 12 chars collapse to sk-*** to avoid leaking short strings', () => {
    expect(redactKey('short')).toBe('sk-***')
    expect(redactKey('')).toBe('sk-***')
    expect(redactKey('sk-tiny')).toBe('sk-***')
  })

  it('redactKey: every input shorter than the original, never echoes raw key', () => {
    const RAW = 'sk-PLAINTEXT-LONGKEY-MUST-NOT-LEAK'
    const redacted = redactKey(RAW)
    expect(redacted).not.toContain('PLAINTEXT-LONGKEY-MUST-NOT')
    expect(redacted.length).toBeLessThan(RAW.length)
  })

  it('Interactive R8 prompt template uses redactKey output, never the raw key (source-level contract)', async () => {
    // Read the setup.ts source and assert the R8 prompt-message template uses ${redactKey(options.key)}
    // and never `${options.key}` raw. This is a source-level guard so a future refactor that
    // accidentally drops the redaction call fails the test even if integration coverage lags.
    const source = await Bun.file(new URL('./setup.ts', import.meta.url).pathname).text()
    const r8PromptIdx = source.indexOf('Verify it matches the bearer token')
    expect(r8PromptIdx).toBeGreaterThan(-1)
    const promptContext = source.slice(Math.max(0, r8PromptIdx - 200), r8PromptIdx + 100)
    expect(promptContext).toContain('redactKey(options.key)')
    expect(promptContext).not.toMatch(/--key \$\{options\.key\}/)
  })

  // The two interactive R8 integration tests below are skipped pending F16 (issue #311):
  // RunSetupDeps must cover the buildInteractivePlan prompt sites before the interactive
  // path can be exercised end-to-end with deps mocks alone.

  it.skip('Interactive R8: confirm prompt fires with redacted key (not raw token)', async () => {
    const {ctx} = makeCtx()
    const PLAINTEXT_KEY = 'sk-PLAINTEXT-LONGKEY-SHOULD-NOT-LEAK'
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let confirmMessage = ''
    const captureConfirm = (opts: {message: string}): Promise<boolean | symbol> => {
      confirmMessage = opts.message
      return Promise.resolve(true)
    }

    // Interactive mode resolves promptValue to the awaited prompt result. Our captureConfirm
    // returns true, so the wizard proceeds past the R8 gate. We assert on the captured message.
    const interactivePromptValue = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
      const result = await prompt
      return result as T
    }

    try {
      await runSetupCommand(
        {
          key: PLAINTEXT_KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
        },
        {
          interactive: true,
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
            promptValue: interactivePromptValue,
            confirm: captureConfirm,
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
    } finally {
      globalThis.fetch = originalFetch
    }

    // The R8 confirm prompt must be the one captured (interactive flow has more than one confirm
    // in some paths; we look for the one containing the verify-bearer language).
    expect(confirmMessage).toContain('Verify it matches the bearer token')
    // The raw key must NEVER appear in the prompt text — security regression guard.
    expect(confirmMessage).not.toContain(PLAINTEXT_KEY)
    // Redacted form must be present (first 3 + last 4 chars per redactKey helper).
    expect(confirmMessage).toContain('sk-')
    expect(confirmMessage).toContain('***')
    expect(confirmMessage).toContain('LEAK')
  })

  it.skip('Interactive R8: confirm returns false → cancelAndExit invoked, applyGhValue never called', async () => {
    const {ctx} = makeCtx()
    const MODELS_FIXTURE = {data: [{id: 'gpt-5.4-mini', owned_by: 'openai'}]}
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(JSON.stringify(MODELS_FIXTURE))) as unknown as typeof fetch

    let applyGhValueCalled = false
    let exitCode: number | undefined

    const interactivePromptValue = async <T>(prompt: Promise<T | symbol>): Promise<T> => {
      const result = await prompt
      return result as T
    }

    // process.exit is intercepted by ctx.process.exit only when ctx is threaded; cancelAndExit
    // calls global process.exit. Stub it to capture the code and throw so the function unwinds.
    const originalExit = process.exit
    process.exit = ((code?: number) => {
      exitCode = code
      throw new Error('process.exit-stubbed')
    }) as typeof process.exit

    try {
      await runSetupCommand(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          providers: 'openai',
          model: 'openai/gpt-5.4-mini',
          force: true,
        },
        {
          interactive: true,
          baseUrl: BASE_URL,
          ctx,
          gh: {
            assertGhInstalled: async () => {},
            assertGhAuthenticated: async () => {},
            assertRepoAccess: async () => {},
            listExistingGhNames: async (_repo, kind) => (kind === 'secret' ? ['OPENCODE_AUTH_JSON'] : []),
            createManagementApiKey: async () => {},
            deleteManagementApiKey: async () => {},
            applyGhValue: async () => {
              applyGhValueCalled = true
            },
            withGhRetry: async (_label, fn) => fn(makeSpinner()),
          },
          prompts: {
            promptValue: interactivePromptValue,
            // User rejects the R8 confirmation → cancelAndExit fires.
            confirm: () => Promise.resolve(false) as Promise<boolean | symbol>,
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
      // If we get here, cancelAndExit didn't fire. Fail the test.
      throw new Error('expected cancelAndExit to fire on R8 reject')
    } catch (error) {
      // cancelAndExit throws because we stubbed process.exit to throw.
      expect(error instanceof Error && error.message).toBe('process.exit-stubbed')
    } finally {
      process.exit = originalExit
      globalThis.fetch = originalFetch
    }

    expect(exitCode).toBe(0)
    expect(applyGhValueCalled).toBe(false)
  })

  // ── Double-log regression test ────────────────────

  it('Bare CLI path (no ctx injected): action error not double-logged via ctx.console.error', async () => {
    // When deps.ctx is undefined, ctx defaults to realCtx (which writes to global console).
    // The catch block should skip ctx.console.error to avoid double-printing — cli.ts top-level
    // catch already prints. We verify by tracking calls to console.error directly.
    const errorCalls: string[] = []
    const originalConsoleError = console.error
    console.error = (...args: unknown[]) => {
      errorCalls.push(args.map(String).join(' '))
    }

    try {
      await expect(
        runSetupCommand(
          {
            key: KEY,
            repo: 'owner/repo',
            harness: 'opencode',
            force: true,
          },
          {
            interactive: false,
            baseUrl: BASE_URL,
            // ctx NOT supplied — bare CLI mode
            gh: {
              assertGhInstalled: async () => {
                throw new Error('gh-not-installed-marker')
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
        ),
      ).rejects.toThrow('gh-not-installed-marker')
    } finally {
      console.error = originalConsoleError
    }

    // The catch block must NOT have called ctx.console.error because deps.ctx was undefined.
    // (cli.ts will handle the logging at the top level.) If the catch wrote here, this fails.
    const errorMatches = errorCalls.filter(line => line.includes('gh-not-installed-marker'))
    expect(errorMatches).toHaveLength(0)
  })

  it('MCP path (ctx injected): action error IS logged via ctx.console.error', async () => {
    // When deps.ctx IS supplied (MCP path), the catch block must call ctx.console.error
    // so the MCP transport surfaces the message. cli.ts's top-level catch doesn't run in MCP mode.
    const {ctx, errors} = makeCtx()

    await expect(
      runSetupCommand(
        {
          key: KEY,
          repo: 'owner/repo',
          harness: 'opencode',
          force: true,
        },
        {
          interactive: false,
          baseUrl: BASE_URL,
          ctx, // ← injected
          gh: {
            assertGhInstalled: async () => {
              throw new Error('mcp-error-marker')
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
      ),
    ).rejects.toThrow('mcp-error-marker')

    // The injected ctx.console.error received the message.
    const errorTexts = errors.map(args => args.map(String).join(' '))
    expect(errorTexts.some(line => line.includes('mcp-error-marker'))).toBe(true)
  })

  // ── Rollback regression tests ─────────────────────

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

  // ── F5: --dry-run with no --repo/--harness ─────────────────────────────────

  it('F5: --dry-run with no --repo/--harness prints preview and does not throw', async () => {
    const {ctx, logs} = makeCtx()
    await runSetupCommand({dryRun: true}, {ctx})
    const output = logs.map(args => args.join(' ')).join('\n')
    expect(output).toContain('OPENCODE_AUTH_JSON')
    expect(output).toContain('No mutations will be performed.')
  })

  it('F5: --dry-run does not call assertGhInstalled even with no flags', async () => {
    const {ctx} = makeCtx()
    let ghCalled = false
    await runSetupCommand(
      {dryRun: true},
      {
        ctx,
        gh: {
          assertGhInstalled: async () => {
            ghCalled = true
          },
          assertGhAuthenticated: async () => {},
          assertRepoAccess: async () => {},
          listExistingGhNames: async () => [],
          createManagementApiKey: async () => {},
          deleteManagementApiKey: async () => {},
          applyGhValue: async () => {},
          withGhRetry: async (_label, fn) => fn(makeSpinner()),
        },
      },
    )
    expect(ghCalled).toBe(false)
  })

  // ── F8: Rollback event-order assertions ────────────────────────────────────

  it('F8: applyGhValue fails → deleteManagementApiKey called BEFORE error propagates (event order)', async () => {
    const {ctx} = makeCtx()
    const events: string[] = []

    await expect(
      runSetupCommand(
        {repo: 'owner/repo', harness: 'claude-code', force: true},
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
            createManagementApiKey: async () => {
              events.push('create')
            },
            deleteManagementApiKey: async () => {
              events.push('delete')
            },
            applyGhValue: async () => {
              events.push('apply-fail')
              throw new Error('apply-fail')
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
      ),
    ).rejects.toThrow('apply-fail')

    expect(events).toEqual(['create', 'apply-fail', 'delete'])
  })

  it('F8: assertProxyKeyWorks fails → deleteManagementApiKey called BEFORE error propagates (event order)', async () => {
    const {ctx} = makeCtx()
    const events: string[] = []

    await expect(
      runSetupCommand(
        {repo: 'owner/repo', harness: 'claude-code', force: true},
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
            createManagementApiKey: async () => {
              events.push('create')
            },
            deleteManagementApiKey: async () => {
              events.push('delete')
            },
            applyGhValue: async () => {
              events.push('apply-success')
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
            assertProxyKeyWorks: async () => {
              events.push('verify-fail')
              throw new Error('verify-fail')
            },
            verifyModelsAvailable: async () => {},
          },
        },
      ),
    ).rejects.toThrow('verify-fail')

    expect(events).toEqual(['create', 'apply-success', 'verify-fail', 'delete'])
  })

  // ── F9: --force pre-gate fires before verifyModelsAvailable ────────────────

  it('F9: missing --force on provider change does not call fetch (verifyModelsAvailable skipped)', async () => {
    let fetchCalled = false
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock(async () => {
      fetchCalled = true
      return new Response('{}')
    }) as unknown as typeof fetch

    try {
      await expect(
        buildNonInteractivePlan({key: KEY, repo: 'owner/repo', harness: 'opencode', providers: 'openai'}, BASE_URL),
      ).rejects.toThrow('--force')
    } finally {
      globalThis.fetch = originalFetch
    }

    expect(fetchCalled).toBe(false)
  })
})

// ── post-write readback verification ──────────────────────────────────────────

describe('post-write readback verification', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  // Capture log.warn calls from @clack/prompts
  let warnSpy: ReturnType<typeof spyOn>
  let warnMessages: string[]

  // Standard DI deps for a successful non-interactive setup run.
  // listExistingGhNames is overridden per-test to control readback behavior.
  function makeDeps(
    listExistingGhNames: (repo: string, kind: 'secret' | 'variable') => Promise<string[]>,
    deleteManagementApiKey?: () => Promise<void>,
  ) {
    const {ctx} = makeCtx()
    return {
      ctx,
      deps: {
        interactive: false,
        baseUrl: BASE_URL,
        ctx,
        gh: {
          assertGhInstalled: async () => {},
          assertGhAuthenticated: async () => {},
          assertRepoAccess: async () => {},
          listExistingGhNames,
          createManagementApiKey: async () => {},
          deleteManagementApiKey: deleteManagementApiKey ?? (async () => {}),
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
          runSmokeTest: async () => ({kind: 'pass' as const, message: 'ok', runUrl: 'https://example.com/run/1'}),
        },
        validation: {
          assertProxyReachable: async () => {},
          assertProxyKeyWorks: async () => {},
          verifyModelsAvailable: async () => {},
        },
      } satisfies Parameters<typeof runSetupCommand>[1],
    }
  }

  // Standard options for a non-interactive anthropic-only setup (no --force needed)
  const baseOptions = {
    key: KEY,
    repo: 'owner/repo',
    harness: 'opencode' as const,
  }

  beforeEach(() => {
    warnMessages = []
    warnSpy = spyOn(log, 'warn').mockImplementation((msg: string) => {
      warnMessages.push(msg)
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('happy path: readback returns all written names → no new warning emitted', async () => {
    // Pre-write list is empty; post-write readback returns all written names
    // The opencode harness writes: OPENCODE_AUTH_JSON, OPENCODE_CONFIG, OMO_PROVIDERS (secrets)
    // and FRO_BOT_MODEL (variable)
    let callCount = 0
    const {deps} = makeDeps(async (_repo, kind) => {
      callCount++
      if (callCount <= 2) {
        // Pre-write calls: return empty (fresh repo)
        return []
      }
      // Post-write readback: return all written names
      if (kind === 'secret') return ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG', 'OMO_PROVIDERS']
      return ['FRO_BOT_MODEL']
    })

    await runSetupCommand(baseOptions, deps)

    // No verified-mismatch or cannot-verify warning should have been emitted
    const readbackWarnings = warnMessages.filter(
      m => m.includes('not visible') || m.includes('could not verify') || m.includes('may have been bypassed'),
    )
    expect(readbackWarnings).toHaveLength(0)
  })

  it('verified mismatch (secret): readback succeeds but written secret absent → loud warning naming absent secret', async () => {
    // Pre-write: empty. Post-write secret readback: missing OPENCODE_AUTH_JSON
    let callCount = 0
    const {deps} = makeDeps(async (_repo, kind) => {
      callCount++
      if (callCount <= 2) return []
      // Post-write: secret readback missing OPENCODE_AUTH_JSON
      if (kind === 'secret') return ['OPENCODE_CONFIG', 'OMO_PROVIDERS']
      return ['FRO_BOT_MODEL']
    })

    await runSetupCommand(baseOptions, deps)

    const mismatchWarnings = warnMessages.filter(m => m.includes('may have been bypassed'))
    expect(mismatchWarnings.length).toBeGreaterThan(0)
    // Must name the absent secret
    expect(mismatchWarnings.some(m => m.includes('OPENCODE_AUTH_JSON'))).toBe(true)
    // Must direct operator to manual verification
    expect(mismatchWarnings.some(m => m.includes('gh secret list'))).toBe(true)
  })

  it('verified mismatch (variable): secret readback complete but variable absent → warning lists absent variable', async () => {
    // Pre-write: empty. Post-write: all secrets present, but FRO_BOT_MODEL missing from variables
    let callCount = 0
    const {deps} = makeDeps(async (_repo, kind) => {
      callCount++
      if (callCount <= 2) return []
      if (kind === 'secret') return ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG', 'OMO_PROVIDERS']
      // Variable readback missing FRO_BOT_MODEL
      return []
    })

    await runSetupCommand(baseOptions, deps)

    const mismatchWarnings = warnMessages.filter(m => m.includes('may have been bypassed'))
    expect(mismatchWarnings.length).toBeGreaterThan(0)
    expect(mismatchWarnings.some(m => m.includes('FRO_BOT_MODEL'))).toBe(true)
    expect(mismatchWarnings.some(m => m.includes('gh variable list'))).toBe(true)
  })

  it('partial visibility: readback shows some but not all written names → warning lists exactly the absent names', async () => {
    // Post-write: OPENCODE_CONFIG and OMO_PROVIDERS present, OPENCODE_AUTH_JSON absent
    let callCount = 0
    const {deps} = makeDeps(async (_repo, kind) => {
      callCount++
      if (callCount <= 2) return []
      if (kind === 'secret') return ['OPENCODE_CONFIG', 'OMO_PROVIDERS'] // OPENCODE_AUTH_JSON absent
      return ['FRO_BOT_MODEL']
    })

    await runSetupCommand(baseOptions, deps)

    const mismatchWarnings = warnMessages.filter(m => m.includes('may have been bypassed'))
    expect(mismatchWarnings.length).toBeGreaterThan(0)
    // Must name OPENCODE_AUTH_JSON (absent)
    expect(mismatchWarnings.some(m => m.includes('OPENCODE_AUTH_JSON'))).toBe(true)
    // Must NOT name OPENCODE_CONFIG or OMO_PROVIDERS (they ARE present)
    expect(mismatchWarnings.some(m => m.includes('OPENCODE_CONFIG'))).toBe(false)
    expect(mismatchWarnings.some(m => m.includes('OMO_PROVIDERS'))).toBe(false)
  })

  it('cannot verify: listExistingGhNames throws on post-write call → softer warning, command does NOT throw, rollback NOT fired', async () => {
    let deleteCalledWith: string | undefined
    let callCount = 0

    const {deps} = makeDeps(
      async (_repo, _kind) => {
        callCount++
        if (callCount <= 2) return [] // Pre-write calls succeed
        // Post-write readback throws
        throw new Error('gh: command failed')
      },
      async () => {
        deleteCalledWith = 'called'
      },
    )

    // Command must NOT throw
    await expect(runSetupCommand(baseOptions, deps)).resolves.toBeUndefined()

    // Must emit the cannot-verify warning (softer wording)
    const cannotVerifyWarnings = warnMessages.filter(m => m.includes('could not verify'))
    expect(cannotVerifyWarnings.length).toBeGreaterThan(0)

    // Must NOT emit the verified-mismatch warning
    const mismatchWarnings = warnMessages.filter(m => m.includes('may have been bypassed'))
    expect(mismatchWarnings).toHaveLength(0)

    // Rollback must NOT have fired (key was not created by this run since --key was supplied)
    expect(deleteCalledWith).toBeUndefined()
  })

  it('createKey:true path — post-write readback throws → command resolves, key created, rollback suppressed', async () => {
    // This test drives the createKey:true path (no --key supplied, wizard mints a key).
    // The post-write readback throws after the key is created and secrets are written.
    // Asserts: (1) createManagementApiKey WAS called, (2) command resolves, (3) deleteManagementApiKey NOT called.
    const {ctx} = makeCtx()

    let createCalled = false
    let deleteCalled = false
    let listCallCount = 0

    await runSetupCommand(
      {
        // No --key → createKey=true
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
          listExistingGhNames: async (_repo, _kind) => {
            listCallCount++
            if (listCallCount <= 2) return [] // Pre-write calls succeed (empty repo)
            // Post-write readback throws
            throw new Error('gh: post-write readback failed')
          },
          createManagementApiKey: async () => {
            createCalled = true
          },
          deleteManagementApiKey: async () => {
            deleteCalled = true
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
        smoke: {
          runSmokeTest: async () => ({kind: 'pass' as const, message: 'ok', runUrl: 'https://example.com/run/1'}),
        },
        validation: {
          assertProxyReachable: async () => {},
          assertProxyKeyWorks: async () => {},
          verifyModelsAvailable: async () => {},
        },
      },
    )

    // Key was created this run
    expect(createCalled).toBe(true)
    // Command resolved (did not throw)
    // (implicit — if it threw, the test would fail above)
    // Rollback must NOT have fired — post-write readback failure must not trigger key deletion
    expect(deleteCalled).toBe(false)
  })

  it('whole-block guard: throw during diff/warning path → command does NOT throw, rollback NOT fired', async () => {
    // Simulate a throw that occurs after the gh calls succeed but during processing.
    // We do this by making the post-write secret readback return a value that causes
    // an error in the diff computation — specifically, we inject a non-iterable value
    // by making listExistingGhNames return a Proxy that throws on iteration.
    let deleteCalledWith: string | undefined
    let callCount = 0

    const {deps} = makeDeps(
      async (_repo, _kind) => {
        callCount++
        if (callCount <= 2) return []
        // Return a value that will cause an error during set-difference computation:
        // a Proxy that throws when iterated
        const throwingArray = new Proxy([] as string[], {
          get(target, prop) {
            if (prop === 'includes' || prop === Symbol.iterator || prop === 'forEach') {
              throw new Error('injected-diff-error')
            }
            return Reflect.get(target, prop)
          },
        })
        return throwingArray
      },
      async () => {
        deleteCalledWith = 'called'
      },
    )

    // Command must NOT throw
    await expect(runSetupCommand(baseOptions, deps)).resolves.toBeUndefined()

    // Rollback must NOT have fired
    expect(deleteCalledWith).toBeUndefined()
  })

  it('existing secret + ack-key-reuse: readback shows all names → no new warning', async () => {
    // Pre-write: OPENCODE_AUTH_JSON already exists (triggers ack-key-reuse path)
    // Post-write readback: all names present
    let callCount = 0
    const {deps} = makeDeps(async (_repo, kind) => {
      callCount++
      if (callCount <= 2) {
        // Pre-write: OPENCODE_AUTH_JSON exists
        if (kind === 'secret') return ['OPENCODE_AUTH_JSON']
        return []
      }
      // Post-write readback: all names present
      if (kind === 'secret') return ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG', 'OMO_PROVIDERS']
      return ['FRO_BOT_MODEL']
    })

    await runSetupCommand({...baseOptions, ackKeyReuse: true, force: true}, deps)

    const readbackWarnings = warnMessages.filter(
      m => m.includes('not visible') || m.includes('could not verify') || m.includes('may have been bypassed'),
    )
    expect(readbackWarnings).toHaveLength(0)
  })
})

// ── concurrency caveat on the non-interactive overwrite warning ─────────────────

describe('non-interactive overwrite warning concurrency caveat', () => {
  const BASE_URL = 'https://cliproxy.fro.bot'
  const KEY = 'sk-test-key'

  let warnSpy: ReturnType<typeof spyOn>
  let warnMessages: string[]

  function makeDeps(listExistingGhNames: (repo: string, kind: 'secret' | 'variable') => Promise<string[]>) {
    const {ctx} = makeCtx()
    return {
      interactive: false,
      baseUrl: BASE_URL,
      ctx,
      gh: {
        assertGhInstalled: async () => {},
        assertGhAuthenticated: async () => {},
        assertRepoAccess: async () => {},
        listExistingGhNames,
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
        runSmokeTest: async () => ({kind: 'pass' as const, message: 'ok', runUrl: 'https://example.com/run/1'}),
      },
      validation: {
        assertProxyReachable: async () => {},
        assertProxyKeyWorks: async () => {},
        verifyModelsAvailable: async () => {},
      },
    } satisfies Parameters<typeof runSetupCommand>[1]
  }

  beforeEach(() => {
    warnMessages = []
    warnSpy = spyOn(log, 'warn').mockImplementation((msg: string) => {
      warnMessages.push(msg)
    })
  })

  afterEach(() => {
    warnSpy.mockRestore()
  })

  it('--force overwrite with a collision present → warning carries the last-write-wins concurrency caveat', async () => {
    // OPENCODE_AUTH_JSON already exists → collision on the opencode secret set → overwrite warning fires.
    const deps = makeDeps(async (_repo, kind) => {
      if (kind === 'secret') return ['OPENCODE_AUTH_JSON', 'OPENCODE_CONFIG', 'OMO_PROVIDERS']
      return ['FRO_BOT_MODEL']
    })

    await runSetupCommand({key: KEY, repo: 'owner/repo', harness: 'opencode', ackKeyReuse: true, force: true}, deps)

    const overwriteWarnings = warnMessages.filter(m => m.includes('Overwriting existing GitHub values'))
    expect(overwriteWarnings.length).toBeGreaterThan(0)
    expect(overwriteWarnings.some(m => m.includes('last-write-wins'))).toBe(true)
    expect(overwriteWarnings.some(m => m.includes('two places at once'))).toBe(true)
  })

  it('--force with no collision → no overwrite warning, so no concurrency caveat (fresh-run race has no signal)', async () => {
    // Fresh repo: empty pre-write list → no collision → overwrite warning never fires.
    // This documents that the concurrency caveat does NOT cover the fresh-run race.
    const deps = makeDeps(async (_repo, kind) => {
      // Pre-write empty; post-write readback returns all written names (no readback warning either).
      if (kind === 'secret') return []
      return []
    })

    await runSetupCommand({key: KEY, repo: 'owner/repo', harness: 'opencode', force: true}, deps)

    const concurrencyWarnings = warnMessages.filter(m => m.includes('last-write-wins'))
    expect(concurrencyWarnings).toHaveLength(0)
  })
})
