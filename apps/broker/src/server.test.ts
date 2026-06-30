/**
 * Tests for the broker HTTP service.
 *
 * All tests exercise the handler function directly via Request/Response —
 * no port binding, no real network, no real OIDC. All collaborators are
 * injected via the deps arg.
 */

import type {AuditEvent} from './audit'
import type {LiveEntry} from './live-set'
import type {OidcClaims} from './oidc'
import {afterEach, describe, expect, it, mock} from 'bun:test'
import {resetLiveSetForTest} from './live-set'
import {createServer} from './server'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal valid OIDC claims for a passing stub. */
const VALID_CLAIMS: OidcClaims & {run_id: string} = {
  iss: 'https://token.actions.githubusercontent.com',
  aud: 'broker.fro.bot',
  sub: 'repo:fro-bot/agent:ref:refs/heads/main',
  jti: 'test-jti-1',
  exp: Math.floor(Date.now() / 1000) + 600,
  iat: Math.floor(Date.now() / 1000),
  repository_id: '123456',
  repository_owner_id: '789',
  workflow_ref: 'fro-bot/agent/.github/workflows/integrate.yaml@refs/heads/main',
  ref: 'refs/heads/main',
  ref_type: 'branch',
  ref_protected: 'true',
  event_name: 'workflow_dispatch',
  runner_environment: 'github-hosted',
  repository_visibility: 'private',
  run_id: 'run-abc-123',
}

const MINTED_KEY = 'ghact-run-abc-123-testrand'

/** Build a POST /v1/mint request with the given bearer token. */
function mintRequest(bearer: string): Request {
  return new Request('http://broker.internal/v1/mint', {
    method: 'POST',
    headers: {Authorization: `Bearer ${bearer}`},
  })
}

/** Build a GET /healthz request. */
function healthzRequest(): Request {
  return new Request('http://broker.internal/healthz', {method: 'GET'})
}

/** Build a default deps object with all stubs passing. */
function buildDeps(overrides: Partial<Parameters<typeof createServer>[0]> = {}): Parameters<typeof createServer>[0] {
  const auditEvents: AuditEvent[] = []

  return {
    verifyOidcToken: async (_token: string) => ({ok: true as const, claims: VALID_CLAIMS}),
    evaluateClaims: (_claims: Record<string, string | undefined>) => ({ok: true as const}),
    mintKey: async (_runId: string) => MINTED_KEY,
    recordMint: mock((_entry: LiveEntry) => {}),
    isReady: () => true,
    rateLimiter: {check: (_repositoryId: string) => ({allowed: true})},
    auditLogger: {
      log: (event: AuditEvent) => {
        auditEvents.push(event)
      },
    },
    clock: () => Date.now(),
    _auditEvents: auditEvents,
    ...overrides,
  }
}

afterEach(() => {
  resetLiveSetForTest()
})

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('GET /healthz', () => {
  it('returns 200 {status:"ok"} without auth, even when isReady() is false', async () => {
    const deps = buildDeps({isReady: () => false})
    const handler = createServer(deps)
    const res = await handler(healthzRequest())
    expect(res.status).toBe(200)
    const body = (await res.json()) as {status: string}
    expect(body).toEqual({status: 'ok'})
  })

  it('returns 200 {status:"ok"} when isReady() is true', async () => {
    const deps = buildDeps({isReady: () => true})
    const handler = createServer(deps)
    const res = await handler(healthzRequest())
    expect(res.status).toBe(200)
  })
})

describe('POST /v1/mint — startup gate', () => {
  it('returns 503 when isReady() is false', async () => {
    const deps = buildDeps({isReady: () => false})
    const handler = createServer(deps)
    const res = await handler(mintRequest('some-token'))
    expect(res.status).toBe(503)
  })

  it('returns non-503 once isReady() is true (happy path)', async () => {
    const deps = buildDeps({isReady: () => true})
    const handler = createServer(deps)
    const res = await handler(mintRequest('valid-token'))
    expect(res.status).toBe(200)
  })
})

describe('POST /v1/mint — happy path', () => {
  it('returns 200 with auth.json carrying the minted key', async () => {
    const deps = buildDeps()
    const handler = createServer(deps)
    const res = await handler(mintRequest('valid-oidc-token'))
    expect(res.status).toBe(200)
    const body = (await res.json()) as {anthropic: {type: string; key: string}; openai: {type: string; key: string}}
    // auth.json shape per apps/cliproxy/AGENTS.md "OPENCODE_CONFIG AND OPENCODE_AUTH_JSON SHAPES":
    // {anthropic: {type: "api", key: "<minted-key>"}, openai: {type: "api", key: "<minted-key>"}}
    expect(body).toHaveProperty('anthropic')
    expect(body.anthropic).toEqual({type: 'api', key: MINTED_KEY})
    expect(body).toHaveProperty('openai')
    expect(body.openai).toEqual({type: 'api', key: MINTED_KEY})
  })

  it('records a live-set entry after a successful mint', async () => {
    const recordMintMock = mock((_entry: LiveEntry) => {})
    const deps = buildDeps({recordMint: recordMintMock})
    const handler = createServer(deps)
    await handler(mintRequest('valid-oidc-token'))
    expect(recordMintMock).toHaveBeenCalledTimes(1)
    const entry = recordMintMock.mock.calls[0]?.[0] as LiveEntry
    expect(entry).toBeDefined()
    expect(entry.key).toBe(MINTED_KEY)
    expect(typeof entry.runId).toBe('string')
    expect(typeof entry.jti).toBe('string')
    expect(typeof entry.expiresAt).toBe('number')
  })

  it('emits a mint audit event', async () => {
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    await handler(mintRequest('valid-oidc-token'))
    const mintEvent = auditEvents.find(e => e.decision === 'mint')
    expect(mintEvent).toBeDefined()
  })

  it('adversarial (Pattern A non-goal): a valid allowlisted token mints successfully', async () => {
    // This is the documented Pattern A non-goal: the broker authorizes the job,
    // not the in-job agent. A prompt-injected agent with a valid OIDC token
    // for the broker's audience will successfully mint. This is expected behavior.
    const deps = buildDeps()
    const handler = createServer(deps)
    const res = await handler(mintRequest('valid-allowlisted-token'))
    expect(res.status).toBe(200)
  })
})

describe('POST /v1/mint — missing/garbage bearer', () => {
  it('returns 401 when Authorization header is missing', async () => {
    const mintKeyMock = mock(async (_runId: string) => MINTED_KEY)
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      mintKey: mintKeyMock,
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    const req = new Request('http://broker.internal/v1/mint', {method: 'POST'})
    const res = await handler(req)
    expect(res.status).toBe(401)
    expect(mintKeyMock).not.toHaveBeenCalled()
    const denyEvent = auditEvents.find(e => e.decision === 'deny')
    expect(denyEvent).toBeDefined()
  })

  it('returns 401 when Authorization header is not a Bearer token', async () => {
    const mintKeyMock = mock(async (_runId: string) => MINTED_KEY)
    const deps = buildDeps({mintKey: mintKeyMock})
    const handler = createServer(deps)
    const req = new Request('http://broker.internal/v1/mint', {
      method: 'POST',
      headers: {Authorization: 'Basic dXNlcjpwYXNz'},
    })
    const res = await handler(req)
    expect(res.status).toBe(401)
    expect(mintKeyMock).not.toHaveBeenCalled()
  })
})

describe('POST /v1/mint — verify fails', () => {
  it('returns 401 when verifyOidcToken returns {ok: false}', async () => {
    const mintKeyMock = mock(async (_runId: string) => MINTED_KEY)
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      verifyOidcToken: async (_token: string) => ({ok: false as const, reason: 'bad signature'}),
      mintKey: mintKeyMock,
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    const res = await handler(mintRequest('bad-token'))
    expect(res.status).toBe(401)
    expect(mintKeyMock).not.toHaveBeenCalled()
    const denyEvent = auditEvents.find(e => e.decision === 'deny')
    expect(denyEvent).toBeDefined()
    expect(denyEvent?.reason).toContain('bad signature')
  })
})

describe('POST /v1/mint — policy deny', () => {
  it('returns 403 when evaluateClaims returns {ok: false}', async () => {
    const mintKeyMock = mock(async (_runId: string) => MINTED_KEY)
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      evaluateClaims: (_claims: Record<string, string | undefined>) => ({
        ok: false as const,
        reason: 'repository_id mismatch',
      }),
      mintKey: mintKeyMock,
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    const res = await handler(mintRequest('valid-sig-bad-claims'))
    expect(res.status).toBe(403)
    expect(mintKeyMock).not.toHaveBeenCalled()
    const denyEvent = auditEvents.find(e => e.decision === 'deny')
    expect(denyEvent).toBeDefined()
    expect(denyEvent?.reason).toContain('repository_id mismatch')
  })
})

describe('POST /v1/mint — mint throws', () => {
  it('returns 500 when mintKey throws, with no token/claim/key bytes in body', async () => {
    const SECRET_TOKEN = 'super-secret-oidc-token-value'
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      mintKey: async (_runId: string) => {
        throw new Error('cliproxy unreachable')
      },
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    const res = await handler(mintRequest(SECRET_TOKEN))
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = await res.text()
    // Must not leak the OIDC token, minted key, or any claim bytes
    expect(body).not.toContain(SECRET_TOKEN)
    expect(body).not.toContain(MINTED_KEY)
    const errorEvent = auditEvents.find(e => e.decision === 'error')
    expect(errorEvent).toBeDefined()
  })
})

describe('POST /v1/mint — rate limiting', () => {
  it('returns 429 when rate limit is exceeded, nothing minted, no secret leak', async () => {
    const mintKeyMock = mock(async (_runId: string) => MINTED_KEY)
    const SECRET_TOKEN = 'rate-limited-oidc-token'
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      rateLimiter: {check: (_repositoryId: string) => ({allowed: false, reason: 'per-repo limit exceeded'})},
      mintKey: mintKeyMock,
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    const res = await handler(mintRequest(SECRET_TOKEN))
    expect(res.status).toBe(429)
    expect(mintKeyMock).not.toHaveBeenCalled()
    const body = await res.text()
    expect(body).not.toContain(SECRET_TOKEN)
    const denyEvent = auditEvents.find(e => e.decision === 'deny-ratelimit')
    expect(denyEvent).toBeDefined()
  })
})

describe('Security: no secret material in audit events or response bodies', () => {
  it('audit events never contain the OIDC bearer token', async () => {
    const OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.signature'
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    await handler(mintRequest(OIDC_TOKEN))
    const serialized = JSON.stringify(auditEvents)
    expect(serialized).not.toContain(OIDC_TOKEN)
  })

  it('audit events never contain the minted key', async () => {
    const auditEvents: AuditEvent[] = []
    const deps = buildDeps({
      auditLogger: {
        log: (e: AuditEvent) => {
          auditEvents.push(e)
        },
      },
      _auditEvents: auditEvents,
    })
    const handler = createServer(deps)
    await handler(mintRequest('valid-token'))
    const serialized = JSON.stringify(auditEvents)
    expect(serialized).not.toContain(MINTED_KEY)
  })

  it('response body on deny never contains the OIDC bearer token', async () => {
    const OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.signature'
    const deps = buildDeps({
      verifyOidcToken: async (_token: string) => ({ok: false as const, reason: 'bad signature'}),
    })
    const handler = createServer(deps)
    const res = await handler(mintRequest(OIDC_TOKEN))
    const body = await res.text()
    expect(body).not.toContain(OIDC_TOKEN)
  })

  it('Authorization header value is redacted in any logged context', async () => {
    const OIDC_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.secret-payload.signature'
    const logLines: string[] = []
    const deps = buildDeps({
      auditLogger: {
        log: (e: AuditEvent) => {
          logLines.push(JSON.stringify(e))
        },
      },
    })
    const handler = createServer(deps)
    await handler(mintRequest(OIDC_TOKEN))
    for (const line of logLines) {
      expect(line).not.toContain(OIDC_TOKEN)
    }
  })
})

describe('Unknown routes', () => {
  it('returns 404 for an unknown path', async () => {
    const deps = buildDeps()
    const handler = createServer(deps)
    const req = new Request('http://broker.internal/unknown', {method: 'GET'})
    const res = await handler(req)
    expect(res.status).toBe(404)
  })
})
