import {describe, expect, it} from 'bun:test'

import {
  APP_IDS,
  OBSERVATION_KINDS,
  OBSERVATION_RESULTS,
  OBSERVATION_SOURCES,
  observationSchema,
  STATUS_SCHEMA_VERSION,
  statusEnvelopeSchema,
} from './observation'

const OBSERVED_AT = '2026-11-01T12:00:00.000Z'

function passObservation(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'public-reachability',
    kind: 'reachability',
    result: 'pass',
    observedAt: OBSERVED_AT,
    source: 'http',
    ...overrides,
  }
}

function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    generatedAt: OBSERVED_AT,
    apps: [{app: 'broker', observations: [passObservation()], facts: {}}],
    ...overrides,
  }
}

describe('contract vocabulary', () => {
  it('pins the closed enums and the schema version', () => {
    expect(STATUS_SCHEMA_VERSION).toBe(1)
    expect(OBSERVATION_KINDS).toEqual(['reachability', 'container-health', 'deploy-state', 'end-to-end', 'resource'])
    expect(OBSERVATION_RESULTS).toEqual(['pass', 'fail', 'unknown', 'not_measured'])
    expect(OBSERVATION_SOURCES).toEqual(['http', 'ssh', 'github-api', 'monitor', 'config'])
    expect(APP_IDS).toEqual(['keeweb', 'cliproxy', 'gateway', 'umami', 'dashboard', 'vpn', 'broker'])
  })
})

describe('observationSchema', () => {
  it('accepts a passing observation with an ISO observedAt', () => {
    expect(observationSchema.safeParse(passObservation()).success).toBe(true)
  })

  it('accepts a not_measured observation with a null observedAt', () => {
    const parsed = observationSchema.safeParse(
      passObservation({result: 'not_measured', observedAt: null, source: 'config'}),
    )
    expect(parsed.success).toBe(true)
  })

  it('rejects an unknown result', () => {
    expect(observationSchema.safeParse(passObservation({result: 'degraded'})).success).toBe(false)
  })

  it('rejects an unknown kind', () => {
    expect(observationSchema.safeParse(passObservation({kind: 'latency'})).success).toBe(false)
  })

  it('rejects an unknown source', () => {
    expect(observationSchema.safeParse(passObservation({source: 'carrier-pigeon'})).success).toBe(false)
  })

  it('rejects a non-null observedAt on not_measured', () => {
    const parsed = observationSchema.safeParse(passObservation({result: 'not_measured', observedAt: OBSERVED_AT}))
    expect(parsed.success).toBe(false)
  })

  it.each(['pass', 'fail', 'unknown'])('rejects a null observedAt on %s', result => {
    expect(observationSchema.safeParse(passObservation({result, observedAt: null})).success).toBe(false)
  })

  it('rejects a malformed observedAt', () => {
    expect(observationSchema.safeParse(passObservation({observedAt: 'yesterday'})).success).toBe(false)
  })

  it('rejects an unsupported id shape', () => {
    expect(observationSchema.safeParse(passObservation({id: 'Has Spaces'})).success).toBe(false)
    expect(observationSchema.safeParse(passObservation({id: ''})).success).toBe(false)
  })

  it('accepts the bounded detail keys', () => {
    const detail = {statusCode: 200, durationMs: 42, contractVersion: '2026-06-01', reason: 'at_gate'}
    expect(observationSchema.safeParse(passObservation({detail})).success).toBe(true)
  })

  it('rejects detail keys outside the contract, so raw bodies and error text cannot ride along', () => {
    expect(observationSchema.safeParse(passObservation({detail: {body: '{"ok":true}'}})).success).toBe(false)
    expect(observationSchema.safeParse(passObservation({detail: {error: 'getaddrinfo ENOTFOUND'}})).success).toBe(false)
  })

  it('rejects out-of-range or oversized detail values', () => {
    expect(observationSchema.safeParse(passObservation({detail: {statusCode: 99}})).success).toBe(false)
    expect(observationSchema.safeParse(passObservation({detail: {statusCode: 600}})).success).toBe(false)
    expect(observationSchema.safeParse(passObservation({detail: {durationMs: -1}})).success).toBe(false)
    expect(observationSchema.safeParse(passObservation({detail: {contractVersion: 'x'.repeat(65)}})).success).toBe(
      false,
    )
    expect(observationSchema.safeParse(passObservation({detail: {reason: 'Free form error text!'}})).success).toBe(
      false,
    )
    expect(observationSchema.safeParse(passObservation({detail: {reason: 'a'.repeat(33)}})).success).toBe(false)
  })

  it('rejects unexpected top-level keys', () => {
    expect(observationSchema.safeParse(passObservation({url: 'https://example.com'})).success).toBe(false)
  })
})

describe('statusEnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    expect(statusEnvelopeSchema.safeParse(envelope()).success).toBe(true)
  })

  it('rejects an unsupported schemaVersion', () => {
    expect(statusEnvelopeSchema.safeParse(envelope({schemaVersion: 2})).success).toBe(false)
    expect(statusEnvelopeSchema.safeParse(envelope({schemaVersion: 0})).success).toBe(false)
    expect(statusEnvelopeSchema.safeParse(envelope({schemaVersion: '1'})).success).toBe(false)
    expect(statusEnvelopeSchema.safeParse(envelope({schemaVersion: 1.5})).success).toBe(false)
  })

  it('rejects a missing schemaVersion', () => {
    const {schemaVersion: _omitted, ...rest} = envelope()
    expect(statusEnvelopeSchema.safeParse(rest).success).toBe(false)
  })

  it('rejects an unknown app id', () => {
    const parsed = statusEnvelopeSchema.safeParse(
      envelope({apps: [{app: 'mystery', observations: [passObservation()], facts: {}}]}),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects duplicate app entries and duplicate observation ids within one app', () => {
    const app = {app: 'broker', observations: [passObservation()], facts: {}}
    expect(statusEnvelopeSchema.safeParse(envelope({apps: [app, app]})).success).toBe(false)

    const dupObservations = {app: 'broker', observations: [passObservation(), passObservation()], facts: {}}
    expect(statusEnvelopeSchema.safeParse(envelope({apps: [dupObservations]})).success).toBe(false)
  })

  it('allows the same observation id under different apps', () => {
    const parsed = statusEnvelopeSchema.safeParse(
      envelope({
        apps: [
          {app: 'broker', observations: [passObservation()], facts: {}},
          {app: 'umami', observations: [passObservation()], facts: {}},
        ],
      }),
    )
    expect(parsed.success).toBe(true)
  })

  it('carries structured facts, such as the gateway workspace', () => {
    const facts = {version: '1.2.3', workspace: {state: 'ok', counts: {a: 1}, notes: ['x', null, true]}}
    const parsed = statusEnvelopeSchema.safeParse(
      envelope({apps: [{app: 'gateway', observations: [passObservation()], facts}]}),
    )
    expect(parsed.success).toBe(true)
    expect(parsed.data?.apps[0]?.facts).toEqual(facts)
  })

  it('rejects non-JSON fact values', () => {
    const facts = {when: new Date(), fn: () => 1}
    const parsed = statusEnvelopeSchema.safeParse(
      envelope({apps: [{app: 'gateway', observations: [passObservation()], facts}]}),
    )
    expect(parsed.success).toBe(false)
  })

  it('rejects a malformed generatedAt', () => {
    expect(statusEnvelopeSchema.safeParse(envelope({generatedAt: 'now'})).success).toBe(false)
  })

  it('propagates an invalid observation up through the envelope', () => {
    const bad = passObservation({result: 'not_measured', observedAt: OBSERVED_AT})
    const parsed = statusEnvelopeSchema.safeParse(envelope({apps: [{app: 'broker', observations: [bad], facts: {}}]}))
    expect(parsed.success).toBe(false)
  })
})
