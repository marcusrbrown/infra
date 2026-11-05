import {readFileSync} from 'node:fs'
import snapshotJson from '@marcusrbrown/infra-shared/opencode-go/privacy-snapshot.json'
import settingsJson from '@marcusrbrown/infra-shared/opencode-go/settings.json'
import {describe, expect, test} from 'bun:test'

import {computeEligibility, parseSettings, parseSnapshot} from './eligibility'

const COMMIT = 'a'.repeat(40)

interface EntryOverrides {
  zeroRetention?: boolean
  trainsOnData?: boolean
  regionGated?: boolean
  agreementExpiry?: string | null
}

const entry = (overrides: EntryOverrides = {}) => ({
  zeroRetention: true,
  trainsOnData: false,
  regionGated: false,
  agreementExpiry: null,
  ...overrides,
})

const makeSnapshot = (models: Record<string, unknown>) => ({
  schemaVersion: 1,
  source: {repo: 'anomalyco/opencode', path: 'services/www/src/docs/content/console/go.mdx', commit: COMMIT},
  models,
})

const TODAY = '2026-11-04'

const evaluate = (models: Record<string, unknown>, liveIds: string[], today = TODAY) =>
  computeEligibility(parseSnapshot(makeSnapshot(models)), liveIds, today)

const readFixtureJson = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8'))

const liveFixtureIds = (): string[] => {
  const raw = readFixtureJson('live-models.json')
  if (typeof raw !== 'object' || raw === null || !('data' in raw) || !Array.isArray(raw.data)) {
    throw new Error('live-models fixture has no data array')
  }
  return raw.data.map((m: {id: string}) => m.id)
}

describe('computeEligibility', () => {
  test('a zero-retention, no-training live model is eligible', () => {
    expect(evaluate({'glm-5.3': entry()}, ['glm-5.3'])).toEqual({eligible: ['glm-5.3'], excluded: []})
  })

  test('eligible ids are sorted', () => {
    const result = evaluate({b: entry(), a: entry(), c: entry()}, ['c', 'a', 'b'])
    expect(result.eligible).toEqual(['a', 'b', 'c'])
  })

  test('a model that trains on data is excluded', () => {
    expect(evaluate({m: entry({trainsOnData: true})}, ['m'])).toEqual({
      eligible: [],
      excluded: [{id: 'm', reason: 'trains-on-data'}],
    })
  })

  test('a model that retains data is not zero-retention', () => {
    expect(evaluate({m: entry({zeroRetention: false})}, ['m']).excluded).toEqual([
      {id: 'm', reason: 'not-zero-retention'},
    ])
  })

  test('a region-gated model is excluded', () => {
    expect(evaluate({m: entry({regionGated: true})}, ['m']).excluded).toEqual([{id: 'm', reason: 'region-gated'}])
  })

  test('an expiry dated today is eligible; yesterday and earlier are excluded', () => {
    expect(evaluate({m: entry({agreementExpiry: TODAY})}, ['m']).eligible).toEqual(['m'])
    expect(evaluate({m: entry({agreementExpiry: '2026-11-05'})}, ['m']).eligible).toEqual(['m'])
    expect(evaluate({m: entry({agreementExpiry: '2026-11-03'})}, ['m']).excluded).toEqual([
      {id: 'm', reason: 'agreement-expired'},
    ])
  })

  test('a live model missing from the snapshot is excluded', () => {
    expect(evaluate({a: entry()}, ['a', 'b'])).toEqual({
      eligible: ['a'],
      excluded: [{id: 'b', reason: 'not-in-snapshot'}],
    })
  })

  test('a snapshot model missing from the live list is excluded', () => {
    expect(evaluate({a: entry(), b: entry()}, ['a'])).toEqual({
      eligible: ['a'],
      excluded: [{id: 'b', reason: 'not-live'}],
    })
  })

  test('one invalid entry is excluded alone and its siblings stay eligible', () => {
    const result = evaluate({good: entry(), bad: {...entry(), zeroRetention: 'yes'}, worse: {zeroRetention: true}}, [
      'good',
      'bad',
      'worse',
    ])
    expect(result.eligible).toEqual(['good'])
    expect(result.excluded).toEqual([
      {id: 'bad', reason: 'invalid-entry'},
      {id: 'worse', reason: 'invalid-entry'},
    ])
  })

  test('an entry with an unknown key is invalid', () => {
    expect(evaluate({m: {...entry(), extra: 1}}, ['m']).excluded).toEqual([{id: 'm', reason: 'invalid-entry'}])
  })

  test('an entry with a malformed expiry date is invalid', () => {
    expect(evaluate({m: entry({agreementExpiry: 'November 30, 2026'})}, ['m']).excluded).toEqual([
      {id: 'm', reason: 'invalid-entry'},
    ])
    expect(evaluate({m: entry({agreementExpiry: '2026-02-31'})}, ['m']).excluded).toEqual([
      {id: 'm', reason: 'invalid-entry'},
    ])
  })

  test('reports each excluded id once, with the first applicable reason', () => {
    const result = evaluate({m: entry({trainsOnData: true, zeroRetention: false, regionGated: true})}, ['m', 'm'])
    expect(result.excluded).toEqual([{id: 'm', reason: 'trains-on-data'}])
  })

  test('rejects a malformed todayUtc instead of returning a partial result', () => {
    const snapshot = parseSnapshot(makeSnapshot({m: entry()}))
    expect(() => computeEligibility(snapshot, ['m'], '2026-11-4')).toThrow()
    expect(() => computeEligibility(snapshot, ['m'], '2026-13-01')).toThrow()
    expect(() => computeEligibility(snapshot, ['m'], 'today')).toThrow()
  })
})

describe('parseSnapshot', () => {
  test.each([
    ['a non-object', 'nope'],
    ['a missing source', {schemaVersion: 1, models: {}}],
    ['an unknown top-level key', {...makeSnapshot({}), extra: true}],
    ['a wrong schema version', {...makeSnapshot({}), schemaVersion: 2}],
    ['a short source commit', {...makeSnapshot({}), source: {...makeSnapshot({}).source, commit: 'abc123'}}],
    ['an uppercase source commit', {...makeSnapshot({}), source: {...makeSnapshot({}).source, commit: 'A'.repeat(40)}}],
    ['an unknown source key', {...makeSnapshot({}), source: {...makeSnapshot({}).source, ref: 'dev'}}],
    ['models as an array', {...makeSnapshot({}), models: []}],
  ])('fails the whole parse on %s', (_label, raw) => {
    expect(() => parseSnapshot(raw)).toThrow()
  })

  test('does not echo entry values in the error', () => {
    expect(() => parseSnapshot({...makeSnapshot({}), extra: 'super-secret-value'})).toThrow(
      /^(?!.*super-secret-value)/s,
    )
  })
})

describe('parseSettings', () => {
  test('accepts enabled with and without a probe model', () => {
    expect(parseSettings({enabled: true})).toEqual({enabled: true})
    expect(parseSettings({enabled: false, defaultProbeModel: 'glm-5.3'})).toEqual({
      enabled: false,
      defaultProbeModel: 'glm-5.3',
    })
  })

  test.each([
    ['unknown keys', {enabled: true, extra: 1}],
    ['a missing enabled', {defaultProbeModel: 'glm-5.3'}],
    ['a non-boolean enabled', {enabled: 'true'}],
    ['an empty probe model', {enabled: true, defaultProbeModel: ''}],
    ['a non-string probe model', {enabled: true, defaultProbeModel: 5}],
    ['a non-object', []],
  ])('rejects %s', (_label, raw) => {
    expect(() => parseSettings(raw)).toThrow()
  })
})

// Model-specific classification runs over fixtures that never change: `go.expected.json` is the parse of the
// pinned `go.mdx`, and `live-models.json` is a recorded live list. A privacy refresh rewrites the committed
// snapshot, so nothing about individual models may be asserted against that file.
describe('classification over the pinned fixtures', () => {
  const snapshot = parseSnapshot(readFixtureJson('go.expected.json'))
  const live = liveFixtureIds()
  const result = computeEligibility(snapshot, live, TODAY)

  test('the pinned snapshot passes the schema', () => {
    expect(snapshot.invalid).toEqual([])
  })

  test('the eligible set is non-empty and has no DeepSeek model', () => {
    expect(result.eligible.length).toBeGreaterThan(0)
    expect(result.eligible.filter(id => id.startsWith('deepseek'))).toEqual([])
    for (const id of live.filter(id => id.startsWith('deepseek'))) {
      expect(result.excluded).toContainEqual({id, reason: 'region-gated'})
    }
  })

  test('models that train, retain or are region-gated stay out', () => {
    const reasons = new Map(result.excluded.map(e => [e.id, e.reason]))
    expect(reasons.get('claude-haiku-5-5')).toBe('not-zero-retention')
    expect(reasons.get('muse-spark-1.3-contributor')).toBe('trains-on-data')
    expect(reasons.get('iceman-contributor-free')).toBe('trains-on-data')
    expect(result.eligible).toContain('glm-5.3')
  })

  test.each([
    ['enabled', 'settings-enabled.json', true],
    ['disabled', 'settings-disabled.json', false],
  ])('the %s settings fixture parses, and its probe model is eligible', (_label, name, enabled) => {
    const settings = parseSettings(readFixtureJson(name))
    expect(settings.enabled).toBe(enabled)
    expect(settings.defaultProbeModel).toBeDefined()
    expect(result.eligible).toContain(settings.defaultProbeModel ?? '')
  })
})

// The committed files change by design (a reviewed refresh PR, an emergency disable PR), so only invariants
// that hold after either change are asserted.
describe('committed snapshot and settings', () => {
  const snapshot = parseSnapshot(snapshotJson)

  test('the snapshot passes the schema and records a 40-hex source commit', () => {
    expect(snapshot.source.commit).toMatch(/^[0-9a-f]{40}$/)
    expect(snapshot.invalid).toEqual([])
  })

  test('at least one model is eligible against the recorded live list', () => {
    expect(computeEligibility(snapshot, liveFixtureIds(), TODAY).eligible.length).toBeGreaterThan(0)
  })

  test('the settings parse, whether Go is enabled or disabled', () => {
    expect(() => parseSettings(settingsJson)).not.toThrow()
  })
})
