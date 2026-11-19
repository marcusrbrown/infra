import type {DocsPrivacyRow} from './parse-privacy-table'
import {readFileSync} from 'node:fs'

import {describe, expect, test} from 'bun:test'

import {buildSnapshot, DOCS_NAME_ALIASES, normalizeModelName} from './build-snapshot'
import {computeEligibility, parseSnapshot} from './eligibility'
import {parseLiveModels, type LiveModel} from './live-models'
import {parsePrivacyDocs, PrivacyTableError} from './parse-privacy-table'

const FIXTURE_COMMIT = '011f9043e8a90dc9a1ac42fb1181486dd4d13b71'

const readFixture = (name: string) => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8')
const docs = (): DocsPrivacyRow[] => parsePrivacyDocs(readFixture('go.mdx'))
const live = (): LiveModel[] => parseLiveModels(JSON.parse(readFixture('live-models.json')))

const build = (rows = docs(), models = live()) => buildSnapshot(rows, models, FIXTURE_COMMIT)

/** A copy of the fixture docs with `patch` applied to the row named `name`. */
const patchDocs = (name: string, patch: Partial<DocsPrivacyRow>): DocsPrivacyRow[] => {
  const rows = docs()
  const index = rows.findIndex(row => row.name === name)
  expect(index).toBeGreaterThan(-1)
  return rows.map((row, i) => (i === index ? {...row, ...patch} : row))
}

/** A copy of the fixture live list with `patch` applied to the model `id`. */
const patchLive = (id: string, patch: Partial<LiveModel>): LiveModel[] => {
  const models = live()
  const index = models.findIndex(model => model.id === id)
  expect(index).toBeGreaterThan(-1)
  return models.map((model, i) => (i === index ? {...model, ...patch} : model))
}

const entryOf = (id: string, result = build()) => result.snapshot.models[id]

describe('buildSnapshot on the pinned page and API response', () => {
  test('builds exactly go.expected.json', () => {
    expect(build().snapshot).toEqual(JSON.parse(readFixture('go.expected.json')))
  })

  test('the result satisfies the snapshot schema with no invalid entries and the docs commit as source', () => {
    const parsed = parseSnapshot(build().snapshot)
    expect(parsed.invalid).toEqual([])
    expect(parsed.source.commit).toBe(FIXTURE_COMMIT)
  })

  test('keys models by API id, sorted', () => {
    const ids = Object.keys(build().snapshot.models)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toHaveLength(31)
    expect(ids).toContain('hy4-flash-free')
    expect(ids).not.toContain('glm-5.2')
  })

  test('the new model is cleared and the retained ones are not', () => {
    expect(entryOf('hy4-flash-free')).toEqual({
      zeroRetention: true,
      trainsOnData: false,
      regionGated: false,
      agreementExpiry: null,
    })
    expect(entryOf('gemini-4-argon')).toEqual({
      zeroRetention: false,
      trainsOnData: false,
      regionGated: false,
      agreementExpiry: null,
    })
  })

  test('eligibility over the built snapshot and the live list', () => {
    const result = computeEligibility(
      parseSnapshot(build().snapshot),
      live().map(model => model.id),
      '2026-11-19',
    )
    expect(result.eligible).toContain('hy4-flash-free')
    expect(result.eligible).toContain('glm-5.3')
    expect(result.excluded).toContainEqual({id: 'gemini-4-argon', reason: 'not-zero-retention'})
    expect(result.excluded).toContainEqual({id: 'beam-free', reason: 'not-zero-retention'})
    expect(result.excluded).toContainEqual({id: 'muse-spark-1.3-contributor', reason: 'trains-on-data'})
    expect(result.excluded).toContainEqual({id: 'iceman-contributor-free', reason: 'trains-on-data'})
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'longcat-2.5-free']) {
      expect(result.excluded).toContainEqual({id, reason: 'region-gated'})
    }
  })

  test('the agreement expiry comes from the docs, and the API has none', () => {
    expect(entryOf('deepseek-v4.1-flash')?.agreementExpiry).toBe('2026-11-30')
    expect(entryOf('deepseek-v4-pro')?.agreementExpiry).toBe('2026-11-30')
    expect(entryOf('glm-5.3')?.agreementExpiry).toBeNull()
  })

  test('reports no retention or training disagreement on today’s inputs', () => {
    const {disagreements} = build()
    expect(disagreements.filter(d => d.fact !== 'regionGated')).toEqual([])
  })
})

describe('buildSnapshot combines retention with AND', () => {
  test('API zdr true with a docs row of 30 days is not zero retention', () => {
    const rows = patchDocs('GLM-5.3', {retentionDays: 30})
    expect(entryOf('glm-5.3', build(rows))?.zeroRetention).toBe(false)
  })

  test('API zdr false with a docs row of 0 days is not zero retention', () => {
    const models = patchLive('glm-5.3', {zdr: false})
    expect(entryOf('glm-5.3', build(docs(), models))?.zeroRetention).toBe(false)
  })

  test('API zdr true with a docs "Not ZDR" row is not zero retention', () => {
    const rows = patchDocs('GLM-5.3', {retentionDays: null})
    expect(entryOf('glm-5.3', build(rows))?.zeroRetention).toBe(false)
  })

  test('both sources agreeing on zero retention is the only way to clear it', () => {
    expect(entryOf('glm-5.3')?.zeroRetention).toBe(true)
  })
})

describe('buildSnapshot combines training with OR', () => {
  test('API training true with no docs footnote excludes the model', () => {
    const models = patchLive('glm-5.3', {training: true})
    const result = build(docs(), models)
    expect(entryOf('glm-5.3', result)?.trainsOnData).toBe(true)
    expect(
      computeEligibility(
        parseSnapshot(result.snapshot),
        models.map(model => model.id),
        '2026-11-19',
      ).excluded,
    ).toContainEqual({id: 'glm-5.3', reason: 'trains-on-data'})
  })

  test('a docs training footnote with API training false excludes the model', () => {
    const rows = patchDocs('GLM-5.3', {trainingGranted: true})
    expect(entryOf('glm-5.3', build(rows))?.trainsOnData).toBe(true)
  })
})

describe('buildSnapshot combines region with OR', () => {
  test('Beam Free is region-gated by the API alone, because the page no longer says so', () => {
    const beam = docs().find(row => row.name === 'Beam Free')
    expect(beam?.availabilityLimited).toBe(false)
    expect(beam?.regionRequirement).toBe(false)
    expect(entryOf('beam-free')?.regionGated).toBe(true)
  })

  test.each([['deepseek-v4.1-flash'], ['deepseek-v4-pro'], ['longcat-2.5-free']])(
    '%s is region-gated by the docs Global rule alone, while the API says limited_regions false',
    id => {
      const model = live().find(candidate => candidate.id === id)
      expect(model?.limitedRegions).toBe(false)
      expect(entryOf(id)?.regionGated).toBe(true)
    },
  )

  test('a docs availability statement gates a model the API calls unrestricted', () => {
    const rows = patchDocs('GLM-5.3', {availabilityLimited: true})
    expect(entryOf('glm-5.3', build(rows))?.regionGated).toBe(true)
  })

  test('an ungated model stays ungated when both sources agree', () => {
    expect(entryOf('glm-5.3')?.regionGated).toBe(false)
  })
})

describe('buildSnapshot joins by normalized name and a reviewed alias', () => {
  test('normalizes case, whitespace and hyphens, and nothing else', () => {
    expect(normalizeModelName('GPT-5.6  Luna')).toBe(normalizeModelName('gpt 5.6 luna'))
    expect(normalizeModelName('MiniMax-M3')).toBe(normalizeModelName('MiniMax M3'))
    expect(normalizeModelName('GLM-5.3-Flash')).toBe('glm 5.3 flash')
    expect(normalizeModelName('Qwen3.8 Max')).not.toBe(normalizeModelName('Qwen3 8 Max'))
  })

  test('the one reviewed alias maps the docs name to the API id', () => {
    expect(DOCS_NAME_ALIASES).toEqual({'deepseek v4.1 flash': 'deepseek-v4.1-flash'})
    const api = live().find(model => model.id === 'deepseek-v4.1-flash')
    expect(api?.name).toBe('DeepSeek V4.1 Flash 1017')
    expect(entryOf('deepseek-v4.1-flash')?.agreementExpiry).toBe('2026-11-30')
  })

  test('without the alias, the DeepSeek V4.1 Flash row matches nothing and the build throws', () => {
    expect(() => buildSnapshot(docs(), live(), FIXTURE_COMMIT, {})).toThrow(PrivacyTableError)
    expect(() => buildSnapshot(docs(), live(), FIXTURE_COMMIT, {})).toThrow(/DeepSeek V4\.1 Flash/)
  })

  test('the alias and the name join agreeing on one model is not ambiguous', () => {
    const models = patchLive('deepseek-v4.1-flash', {name: 'DeepSeek V4.1 Flash'})
    expect(entryOf('deepseek-v4.1-flash', build(docs(), models))?.agreementExpiry).toBe('2026-11-30')
  })

  test('an alias and a name join pointing at different models is ambiguous and throws', () => {
    const models = [
      ...live(),
      {id: 'deepseek-flash-clone', name: 'DeepSeek V4.1 Flash', training: false, zdr: true, limitedRegions: false},
    ]
    expect(() => build(docs(), models)).toThrow(/more than one/)
  })

  test('an alias whose target is not live is ignored, and the row then matches nothing', () => {
    const models = live().filter(model => model.id !== 'deepseek-v4.1-flash')
    expect(() => build(docs(), models)).toThrow(/DeepSeek V4\.1 Flash.*no live model/)
  })

  test('never joins by prefix: Hy4 does not borrow Hy4 preview or Hy4 flash Free', () => {
    const models = live().filter(model => model.id !== 'hy4')
    expect(() => build(docs(), models)).toThrow(/"Hy4".*no live model/)
    // Reverse direction: a live name that only prefixes a docs name does not match it either.
    const renamed = patchLive('hy4', {name: 'Hy'})
    expect(() => build(docs(), renamed)).toThrow(PrivacyTableError)
  })

  test('a docs row that matches no live model throws', () => {
    const rows = [...docs(), {...docs()[0], name: 'Mystery Model'} as DocsPrivacyRow]
    expect(() => build(rows)).toThrow(/"Mystery Model".*no live model/)
  })

  test('a docs row that matches more than one live model throws', () => {
    const models = [...live(), {id: 'glm-5.3-copy', name: 'GLM 5.3', training: false, zdr: true, limitedRegions: false}]
    expect(() => build(docs(), models)).toThrow(/"GLM-5\.3".*more than one/)
  })

  test('two docs rows that resolve to the same live model throw', () => {
    const rows = [...docs(), {...(docs().find(row => row.name === 'GLM-5.3') as DocsPrivacyRow), name: 'GLM 5.3'}]
    expect(() => build(rows)).toThrow(/duplicate|same live model/i)
  })

  test('a live model with no docs row throws, so a model without retention or expiry evidence is never written', () => {
    const models = [...live(), {id: 'brand-new', name: 'Brand New', training: false, zdr: true, limitedRegions: false}]
    expect(() => build(docs(), models)).toThrow(/brand-new.*no Privacy row/)
  })

  test('an empty docs table or live list throws', () => {
    expect(() => build([], live())).toThrow(PrivacyTableError)
    expect(() => build(docs(), [])).toThrow(PrivacyTableError)
  })

  test('a malformed source commit throws', () => {
    expect(() => buildSnapshot(docs(), live(), 'dev')).toThrow(PrivacyTableError)
  })
})

describe('buildSnapshot reports where the sources differ', () => {
  const find = (result: ReturnType<typeof build>, id: string, fact: string) =>
    result.disagreements.filter(d => d.id === id && d.fact === fact)

  test('a retention conflict names the model, both values and the snapshot value', () => {
    const result = build(patchDocs('GLM-5.3', {retentionDays: 30}))
    expect(find(result, 'glm-5.3', 'zeroRetention')).toEqual([
      {
        id: 'glm-5.3',
        name: 'GLM-5.3',
        fact: 'zeroRetention',
        kind: 'conflict',
        api: 'zdr: true',
        docs: '30 days',
        snapshot: 'no',
      },
    ])
  })

  test('a docs "Not ZDR" row against API zdr true is reported as a conflict', () => {
    const [report] = find(build(patchDocs('GLM-5.3', {retentionDays: null})), 'glm-5.3', 'zeroRetention')
    expect(report?.docs).toBe('Not ZDR')
    expect(report?.kind).toBe('conflict')
  })

  test('API zdr false against a docs row of 0 days is reported', () => {
    const [report] = find(build(docs(), patchLive('glm-5.3', {zdr: false})), 'glm-5.3', 'zeroRetention')
    expect(report).toMatchObject({api: 'zdr: false', docs: '0 days', snapshot: 'no', kind: 'conflict'})
  })

  test('a training footnote against API training false is a conflict', () => {
    const [report] = find(build(patchDocs('GLM-5.3', {trainingGranted: true})), 'glm-5.3', 'trainsOnData')
    expect(report).toMatchObject({
      kind: 'conflict',
      api: 'training: false',
      docs: 'grants training use',
      snapshot: 'yes',
    })
  })

  test('API training true with no docs footnote is reported as API-only, not as a conflict', () => {
    const [report] = find(build(docs(), patchLive('glm-5.3', {training: true})), 'glm-5.3', 'trainsOnData')
    expect(report).toMatchObject({
      kind: 'api-only',
      api: 'training: true',
      docs: 'no training statement',
      snapshot: 'yes',
    })
  })

  test('a docs availability statement against API limited_regions false is a conflict', () => {
    const [report] = find(build(patchDocs('GLM-5.3', {availabilityLimited: true})), 'glm-5.3', 'regionGated')
    expect(report).toMatchObject({kind: 'conflict', api: 'limited_regions: false', snapshot: 'yes'})
  })

  test('Beam Free is an API-only region restriction, which today’s page cannot confirm', () => {
    expect(find(build(), 'beam-free', 'regionGated')).toEqual([
      {
        id: 'beam-free',
        name: 'Beam Free',
        fact: 'regionGated',
        kind: 'api-only',
        api: 'limited_regions: true',
        docs: 'no availability statement',
        snapshot: 'yes',
      },
    ])
  })

  test('the Global workspace rule is docs-only by design and is never reported', () => {
    const result = build()
    for (const id of ['deepseek-v4.1-flash', 'deepseek-v4-pro', 'longcat-2.5-free']) {
      expect(result.disagreements.filter(d => d.id === id)).toEqual([])
    }
  })

  test('models whose sources agree produce no report', () => {
    const result = build()
    expect(result.disagreements.filter(d => d.id === 'muse-spark-1.3-contributor')).toEqual([])
    expect(result.disagreements.filter(d => d.id === 'gemini-4-argon')).toEqual([])
    expect(result.disagreements.filter(d => d.id === 'glm-5.3')).toEqual([])
  })

  test('on today’s inputs the only report is Beam Free’s API-only region restriction', () => {
    expect(build().disagreements.map(d => `${d.id}/${d.fact}/${d.kind}`)).toEqual(['beam-free/regionGated/api-only'])
  })
})
