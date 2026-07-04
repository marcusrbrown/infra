/**
 * Tests for OIDC JWT verification and replay denylist.
 *
 * All tests use a throwaway RS256 keypair and a local JWKS stub — no network calls.
 */
import {afterEach, beforeAll, describe, expect, test} from 'bun:test'
import {generateKeyPair, SignJWT, type CryptoKey} from 'jose'
import {assertNotReplayed, clearReplayDenylist, verifyOidcToken} from './oidc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a UTF-8 string as base64url without padding. */
function toBase64Url(input: string): string {
  return btoa(Array.from(new TextEncoder().encode(input), b => String.fromCodePoint(b)).join(''))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '')
}

// ---------------------------------------------------------------------------
// Test keypair + JWKS stub
// ---------------------------------------------------------------------------

let privateKey: CryptoKey
let publicKey: CryptoKey

const TEST_KID = 'test-key-1'
const TEST_ISS = 'https://token.actions.githubusercontent.com'
const TEST_AUD = 'https://broker.fro.bot/v1/mint'

beforeAll(async () => {
  const pair = await generateKeyPair('RS256')
  privateKey = pair.privateKey
  publicKey = pair.publicKey
})

afterEach(() => {
  clearReplayDenylist()
})

// ---------------------------------------------------------------------------
// Helper: build a valid base claim set
// ---------------------------------------------------------------------------

function baseClaims() {
  return {
    iss: TEST_ISS,
    aud: TEST_AUD,
    sub: 'repo:fro-bot/agent:ref:refs/heads/main',
    jti: `test-jti-${Math.random()}`,
    repository: 'fro-bot/agent',
    repository_id: '123456789',
    repository_owner_id: '987654321',
    workflow_ref: 'fro-bot/agent/.github/workflows/integrate.yaml@refs/heads/main',
    ref: 'refs/heads/main',
    ref_type: 'branch',
    ref_protected: 'true',
    event_name: 'workflow_dispatch',
    runner_environment: 'github-hosted',
    repository_visibility: 'private',
  }
}

async function signJwt(
  claims: Record<string, unknown>,
  opts: {
    privateKey?: CryptoKey
    kid?: string
    alg?: string
    exp?: number
    nbf?: number
  } = {},
): Promise<string> {
  const key = opts.privateKey ?? privateKey
  const alg = opts.alg ?? 'RS256'
  const now = Math.floor(Date.now() / 1000)

  let builder = new SignJWT(claims)
    .setProtectedHeader({alg, kid: opts.kid ?? TEST_KID})
    .setIssuedAt(now)
    .setExpirationTime(opts.exp ?? now + 600)

  if (opts.nbf !== undefined) {
    builder = builder.setNotBefore(opts.nbf)
  }

  return builder.sign(key)
}

// ---------------------------------------------------------------------------
// Local JWKS stub — returns the test public key
// ---------------------------------------------------------------------------

function makeLocalJwks() {
  return async (protectedHeader: {kid?: string}) => {
    if (protectedHeader.kid !== TEST_KID) {
      throw new Error(`Unknown kid: ${protectedHeader.kid}`)
    }
    return publicKey
  }
}

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('verifyOidcToken — happy path', () => {
  test('valid JWT with all required claims passes verification', async () => {
    const token = await signJwt(baseClaims())
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.claims.repository_id).toBe('123456789')
      expect(result.claims.workflow_ref).toBe('fro-bot/agent/.github/workflows/integrate.yaml@refs/heads/main')
    }
  })
})

// ---------------------------------------------------------------------------
// Error paths — cryptographic / structural
// ---------------------------------------------------------------------------

describe('verifyOidcToken — error paths', () => {
  test('rejects a JWT with a bad signature', async () => {
    const {privateKey: otherKey} = await generateKeyPair('RS256')
    const token = await signJwt(baseClaims(), {privateKey: otherKey})
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects wrong issuer', async () => {
    const claims = {...baseClaims(), iss: 'https://evil.example.com'}
    const token = await signJwt(claims)
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects wrong audience', async () => {
    const claims = {...baseClaims(), aud: 'https://other-service.example.com'}
    const token = await signJwt(claims)
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects expired token', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(baseClaims(), {exp: now - 120})
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
      clockTolerance: 0,
    })
    expect(result.ok).toBe(false)
  })

  test('rejects token with nbf in the future', async () => {
    const now = Math.floor(Date.now() / 1000)
    const token = await signJwt(baseClaims(), {nbf: now + 3600})
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
      clockTolerance: 0,
    })
    expect(result.ok).toBe(false)
  })

  test('rejects alg:none (unsigned token)', async () => {
    // Craft a token with alg:none by hand — jose refuses to sign with none,
    // so we build the raw JWT structure manually.
    const header = toBase64Url(JSON.stringify({alg: 'none', typ: 'JWT'}))
    const payload = toBase64Url(
      JSON.stringify({
        ...baseClaims(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    )
    const token = `${header}.${payload}.`
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(false)
  })

  test('rejects alg:HS256 (symmetric — not RS256)', async () => {
    // Build a HS256 token manually since jose would need a symmetric key
    const header = toBase64Url(JSON.stringify({alg: 'HS256', typ: 'JWT', kid: TEST_KID}))
    const payload = toBase64Url(
      JSON.stringify({
        ...baseClaims(),
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 600,
      }),
    )
    // Fake signature — will fail sig check but alg check should fire first
    const token = `${header}.${payload}.fakesig`
    const result = await verifyOidcToken(token, {
      audience: TEST_AUD,
      jwks: makeLocalJwks(),
    })
    expect(result.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Replay denylist
// ---------------------------------------------------------------------------

describe('assertNotReplayed', () => {
  test('first presentation of a jti succeeds', () => {
    const now = Math.floor(Date.now() / 1000)
    expect(() => assertNotReplayed('jti-1', TEST_ISS, now + 600)).not.toThrow()
  })

  test('second presentation of the same jti within exp window is rejected', () => {
    const now = Math.floor(Date.now() / 1000)
    assertNotReplayed('jti-2', TEST_ISS, now + 600)
    expect(() => assertNotReplayed('jti-2', TEST_ISS, now + 600)).toThrow(/replay/i)
  })

  test('same jti from different issuers are independent', () => {
    const now = Math.floor(Date.now() / 1000)
    assertNotReplayed('jti-3', TEST_ISS, now + 600)
    // Different issuer — should not throw
    expect(() => assertNotReplayed('jti-3', 'https://other.example.com', now + 600)).not.toThrow()
  })

  test('evicted entry (past exp + leeway) is allowed again', () => {
    const now = Math.floor(Date.now() / 1000)
    // Use an exp far enough in the past that exp + leeway (60s) is also past.
    // evictAt = exp + 60 = (now - 120) + 60 = now - 60 → already past.
    assertNotReplayed('jti-4', TEST_ISS, now - 120)
    // A new call with the same jti should succeed because the old entry is evicted
    expect(() => assertNotReplayed('jti-4', TEST_ISS, now + 600)).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Integration: verifyOidcToken runs replay check
// ---------------------------------------------------------------------------

describe('verifyOidcToken — replay integration', () => {
  test('same token presented twice is rejected on second call', async () => {
    const claims = baseClaims()
    const token = await signJwt(claims)
    const opts = {audience: TEST_AUD, jwks: makeLocalJwks()}

    const first = await verifyOidcToken(token, opts)
    expect(first.ok).toBe(true)

    const second = await verifyOidcToken(token, opts)
    expect(second.ok).toBe(false)
    if (!second.ok) {
      expect(second.reason).toMatch(/replay/i)
    }
  })
})
