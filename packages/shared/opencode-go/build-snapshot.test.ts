import type {DocsPrivacyRow} from './parse-privacy-table'
import {readFileSync} from 'node:fs'

import {describe, expect, test} from 'bun:test'

import {
  buildSnapshot,
  describeDisagreement,
  describeUnmatched,
  DOCS_NAME_ALIASES,
  normalizeModelName,
  type Unmatched,
} from './build-snapshot'
import {computeEligibility, parseSnapshot} from './eligibility'
import {parseLiveModels, type LiveModel} from './live-models'
import {parsePrivacyDocs, parsePrivacyDocsWithOrphans, PrivacyTableError} from './parse-privacy-table'

const FIXTURE_COMMIT = '011f9043e8a90dc9a1ac42fb1181486dd4d13b71'

const readFixture = (name: string) => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8')
const docs = (): DocsPrivacyRow[] => parsePrivacyDocs(readFixture('go.mdx'))
const live = (): LiveModel[] => parseLiveModels(JSON.parse(readFixture('live-models.json'))).models

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
  test('Beam Free is region-gated by the docs notice and the API together', () => {
    const beam = docs().find(row => row.name === 'Beam Free')
    expect(beam?.availabilityLimited).toBe(true)
    expect(beam?.regionRequirement).toBe(false)
    expect(entryOf('beam-free')?.regionGated).toBe(true)
  })

  test('Beam Free stays region-gated from the docs notice alone when the API drops its limit', () => {
    expect(entryOf('beam-free', build(docs(), patchLive('beam-free', {limitedRegions: false})))?.regionGated).toBe(true)
  })

  test('Beam Free stays region-gated from the API alone when the notice is gone from the page', () => {
    expect(entryOf('beam-free', build(patchDocs('Beam Free', {availabilityLimited: false})))?.regionGated).toBe(true)
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
  const full = build()
  const liveModel = (id: string, name: string): LiveModel => ({
    id,
    name,
    training: false,
    zdr: true,
    limitedRegions: false,
  })

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

  test('the alias and the name join agreeing on one model is not ambiguous', () => {
    const models = patchLive('deepseek-v4.1-flash', {name: 'DeepSeek V4.1 Flash'})
    expect(entryOf('deepseek-v4.1-flash', build(docs(), models))?.agreementExpiry).toBe('2026-11-30')
  })

  test('an alias and a name join pointing at different models is ambiguous and throws', () => {
    const models = [...live(), liveModel('deepseek-flash-clone', 'DeepSeek V4.1 Flash')]
    expect(() => build(docs(), models)).toThrow(/more than one/)
  })

  test('a live name that normalizes like another live name throws, so no docs row can match both', () => {
    const models = [...live(), liveModel('glm-5.3-copy', 'GLM 5.3')]
    expect(() => build(docs(), models)).toThrow(/glm-5\.3.*same name/)
  })

  test('two live models that normalize to one name throw even when no docs row names them', () => {
    const models = [...live(), liveModel('new-a', 'Brand New'), liveModel('new-b', 'brand-new')]
    expect(() => build(docs(), models)).toThrow(/same name/)
  })

  test('two docs rows that resolve to the same live model throw', () => {
    const rows = [...docs(), {...(docs().find(row => row.name === 'GLM-5.3') as DocsPrivacyRow), name: 'GLM 5.3'}]
    expect(() => build(rows)).toThrow(/duplicate|same live model/i)
  })

  test('an empty docs table or live list throws', () => {
    expect(() => build([], live())).toThrow(PrivacyTableError)
    expect(() => build(docs(), [])).toThrow(PrivacyTableError)
  })

  test('a join that matches nothing at all throws, because the join itself is then wrong', () => {
    const models = live().map(model => ({...model, name: `Renamed ${model.id}`}))
    expect(() => buildSnapshot(docs(), models, FIXTURE_COMMIT, {aliases: {}})).toThrow(
      /no docs row matches any live model/,
    )
  })

  test('a malformed source commit throws', () => {
    expect(() => buildSnapshot(docs(), live(), 'dev')).toThrow(PrivacyTableError)
  })

  describe('a model one source does not know is left out and reported', () => {
    test('a live model with no docs row has no entry, and the report names its id, name and the missing side', () => {
      const models = [...live(), liveModel('brand-new', 'Brand New')]
      const result = build(docs(), models)
      expect(result.snapshot.models['brand-new']).toBeUndefined()
      expect(Object.keys(result.snapshot.models)).toEqual(Object.keys(full.snapshot.models))
      expect(result.unmatched).toEqual([{missing: 'docs', id: 'brand-new', name: 'Brand New'}])
    })

    test('the left-out live model is excluded by the eligibility check as not-in-snapshot', () => {
      const models = [...live(), liveModel('brand-new', 'Brand New')]
      const result = computeEligibility(
        parseSnapshot(build(docs(), models).snapshot),
        models.map(model => model.id),
        '2026-11-19',
      )
      expect(result.eligible).not.toContain('brand-new')
      expect(result.excluded).toContainEqual({id: 'brand-new', reason: 'not-in-snapshot'})
    })

    test('a docs row with no live model has no entry, and the report names the row and the missing side', () => {
      const rows = [
        ...docs(),
        {...(docs().find(row => row.name === 'GLM-5.3') as DocsPrivacyRow), name: 'Mystery Model'},
      ]
      const result = build(rows)
      expect(Object.keys(result.snapshot.models)).toEqual(Object.keys(full.snapshot.models))
      expect(result.unmatched).toEqual([{missing: 'api', id: null, name: 'Mystery Model'}])
    })

    test('without the alias, the DeepSeek V4.1 Flash pair is left out on both sides and the rest is unchanged', () => {
      const result = buildSnapshot(docs(), live(), FIXTURE_COMMIT, {aliases: {}})
      expect(result.snapshot.models['deepseek-v4.1-flash']).toBeUndefined()
      expect(result.unmatched).toEqual([
        {missing: 'api', id: null, name: 'DeepSeek V4.1 Flash'},
        {missing: 'docs', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017'},
      ])
      expect(result.snapshot.models['deepseek-v4-pro']).toEqual(full.snapshot.models['deepseek-v4-pro'])
    })

    test('an alias whose target is not live is ignored, and the row is left out', () => {
      const models = live().filter(model => model.id !== 'deepseek-v4.1-flash')
      const result = build(docs(), models)
      expect(result.snapshot.models['deepseek-v4.1-flash']).toBeUndefined()
      expect(result.unmatched).toEqual([{missing: 'api', id: null, name: 'DeepSeek V4.1 Flash'}])
    })

    test('never joins by prefix: a missing Hy4 stays missing and Hy4 preview and Hy4 flash Free keep their own entries', () => {
      const models = live().filter(model => model.id !== 'hy4')
      const result = build(docs(), models)
      expect(result.snapshot.models.hy4).toBeUndefined()
      expect(result.unmatched).toEqual([{missing: 'api', id: null, name: 'Hy4'}])
      expect(result.snapshot.models['hy4-preview']).toEqual(full.snapshot.models['hy4-preview'])
      expect(result.snapshot.models['hy4-flash-free']).toEqual(full.snapshot.models['hy4-flash-free'])
      // Reverse direction: a live name that only prefixes a docs name does not match it either.
      const renamed = build(docs(), patchLive('hy4', {name: 'Hy'}))
      expect(renamed.snapshot.models.hy4).toBeUndefined()
      expect(renamed.unmatched.map(item => `${item.missing}:${item.name}`).sort()).toEqual(['api:Hy4', 'docs:Hy'])
    })

    test('missing evidence never becomes an entry with permissive defaults', () => {
      const models = [...live(), liveModel('brand-new', 'Brand New')]
      const rows = [
        ...docs(),
        {...(docs().find(row => row.name === 'GLM-5.3') as DocsPrivacyRow), name: 'Mystery Model'},
      ]
      const ids = Object.keys(build(rows, models).snapshot.models)
      expect(ids).not.toContain('brand-new')
      expect(ids).toHaveLength(31)
    })

    test('a new unmatched live model and a new Global restriction on an exposed model: the restriction lands', () => {
      const rows = patchDocs('Kimi K3', {regionRequirement: true})
      const models = [...live(), liveModel('new-model', 'New Model')]
      const result = build(rows, models)
      expect(result.snapshot.models['kimi-k3']?.regionGated).toBe(true)
      expect(result.snapshot.models['new-model']).toBeUndefined()
      expect(result.unmatched).toEqual([{missing: 'docs', id: 'new-model', name: 'New Model'}])
      const eligibility = computeEligibility(
        parseSnapshot(result.snapshot),
        models.map(model => model.id),
        '2026-11-19',
      )
      expect(eligibility.excluded).toContainEqual({id: 'kimi-k3', reason: 'region-gated'})
      expect(eligibility.excluded).toContainEqual({id: 'new-model', reason: 'not-in-snapshot'})
    })
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

  test('API limited_regions false against the Beam Free docs notice is a conflict, and the snapshot keeps the gate', () => {
    const result = build(docs(), patchLive('beam-free', {limitedRegions: false}))
    expect(find(result, 'beam-free', 'regionGated')).toEqual([
      {
        id: 'beam-free',
        name: 'Beam Free',
        fact: 'regionGated',
        kind: 'conflict',
        api: 'limited_regions: false',
        docs: 'availability limited to permitted regions',
        snapshot: 'yes',
      },
    ])
  })

  test('the notice gone from the page while the API still restricts Beam Free is an API-only restriction', () => {
    const result = build(patchDocs('Beam Free', {availabilityLimited: false}))
    expect(find(result, 'beam-free', 'regionGated')).toEqual([
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

  test('on today’s inputs the sources agree on every compared fact, so there is no report at all', () => {
    expect(build().disagreements).toEqual([])
  })
})

describe('report lines render upstream names as bounded plain text', () => {
  const NASTY = '# Heading\n- item |x| `code` [link](https://example.com) <b>bold</b>\r\n> quote'
  const unmatchedLive = {missing: 'docs' as const, id: 'brand-new', name: NASTY}

  const expectInert = (line: string): void => {
    expect(line).not.toMatch(/[\n\r]/)
    expect(line.startsWith('#')).toBe(false)
    expect(line.startsWith('-')).toBe(false)
    // One code span holds the name: the only backticks left delimit spans we wrote.
    expect(line.split('`').length % 2).toBe(1)
  }

  test('a left-out live model name with newlines, backticks, a pipe and a leading # is one bounded line', () => {
    const line = describeUnmatched(unmatchedLive)
    expectInert(line)
    expect(line).toContain('named `# Heading - item |x| code [link](https://example.com) <b>bold</b> > quote`')
  })

  test('a left-out Privacy row name is sanitised the same way', () => {
    const line = describeUnmatched({missing: 'api', id: null, name: NASTY})
    expectInert(line)
    expect(line.startsWith('Privacy row `')).toBe(true)
  })

  test('a disagreement line sanitises the model name', () => {
    const line = describeDisagreement({
      id: 'glm-5.3',
      name: NASTY,
      fact: 'zeroRetention',
      kind: 'conflict',
      api: 'zdr: true',
      docs: '30 days',
      snapshot: 'no',
    })
    expectInert(line)
    expect(line).toContain('(`# Heading')
  })

  test('a long name is capped and marked', () => {
    const line = describeUnmatched({missing: 'api', id: null, name: 'n'.repeat(5000)})
    expect(line).toContain('…')
    expect(line.length).toBeLessThan(160)
  })

  test('control and bidirectional characters are removed, and a blank name stays visible', () => {
    expect(describeUnmatched({missing: 'api', id: null, name: 'a\u0007b\u202Ec\u200Bd'})).toBe(
      'Privacy row `abcd`: no live model',
    )
    expect(describeUnmatched({missing: 'api', id: null, name: ' \n '})).toBe('Privacy row `(blank)`: no live model')
  })
})

describe('buildSnapshot on live models upstream published no privacy fields for', () => {
  const noPrivacyFor = (id: string): {models: LiveModel[]; noPrivacy: {id: string; name: string}[]} => {
    const gone = live().find(model => model.id === id)
    if (gone === undefined) throw new Error(`fixture has no ${id}`)
    return {models: live().filter(model => model.id !== id), noPrivacy: [{id, name: gone.name}]}
  }
  const buildWithout = (id: string) => {
    const {models, noPrivacy} = noPrivacyFor(id)
    return buildSnapshot(docs(), models, FIXTURE_COMMIT, {noPrivacy})
  }

  test('the model has no entry, and every other entry is unchanged', () => {
    const result = buildWithout('glm-5.3')
    expect(result.snapshot.models['glm-5.3']).toBeUndefined()
    const {'glm-5.3': _gone, ...rest} = build().snapshot.models
    expect(result.snapshot.models).toEqual(rest)
  })

  test('the report names it with its own wording, and its docs row is not reported as missing from the API', () => {
    const {unmatched} = buildWithout('glm-5.3')
    expect(unmatched).toEqual([{missing: 'privacy', id: 'glm-5.3', name: 'GLM-5.3'}])
    expect(describeUnmatched(unmatched[0] as Unmatched)).toBe(
      'live model `glm-5.3` named `GLM-5.3`: upstream published no privacy fields (`go`) for it, so it has no entry',
    )
  })

  test('it is excluded by the eligibility check as not-in-snapshot', () => {
    const {models, noPrivacy} = noPrivacyFor('glm-5.3')
    const result = buildSnapshot(docs(), models, FIXTURE_COMMIT, {noPrivacy})
    const ids = [...models.map(model => model.id), 'glm-5.3']
    const eligibility = computeEligibility(parseSnapshot(result.snapshot), ids, '2026-11-19')
    expect(eligibility.excluded).toContainEqual({id: 'glm-5.3', reason: 'not-in-snapshot'})
    expect(eligibility.eligible).not.toContain('glm-5.3')
  })

  test('a model with no privacy fields and no docs row is reported once', () => {
    const {models} = noPrivacyFor('glm-5.3')
    const result = buildSnapshot(docs(), models, FIXTURE_COMMIT, {noPrivacy: [{id: 'brand-new', name: 'Brand New'}]})
    expect(result.unmatched.filter(item => item.id === 'brand-new')).toEqual([
      {missing: 'privacy', id: 'brand-new', name: 'Brand New'},
    ])
  })

  test('the alias still pairs a docs row with a model that has no privacy fields', () => {
    const {models} = noPrivacyFor('deepseek-v4.1-flash')
    const result = buildSnapshot(docs(), models, FIXTURE_COMMIT, {
      noPrivacy: [{id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017'}],
    })
    expect(result.unmatched).toEqual([
      {missing: 'privacy', id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017'},
    ])
  })

  test('a name shared with another live model is an ambiguous join and throws', () => {
    const {models} = noPrivacyFor('glm-5.3')
    expect(() =>
      buildSnapshot(docs(), models, FIXTURE_COMMIT, {noPrivacy: [{id: 'glm-5.3-b', name: 'GLM 5.3 Flash'}]}),
    ).toThrow(/same name/)
  })

  test('the report line sanitises the upstream name like the other left-out lines', () => {
    const line = describeUnmatched({missing: 'privacy', id: 'x', name: '# A\n`b` |c|'})
    expect(line).not.toMatch(/\n/)
    expect(line).toContain('named `# A b |c|`')
  })
})

describe('a footnote for a live model with no Privacy row leaves the model out', () => {
  // The footnote upstream published for a model it gave no Privacy row. The API lists it as `hungerg-free`.
  const FOOTNOTE =
    '- **HungerG Free:** Free for a limited time. No data training: your prompts and completions are not used to train models.'
  const HUNGERG: LiveModel = {
    id: 'hungerg-free',
    name: 'HungerG Free',
    training: false,
    zdr: true,
    limitedRegions: false,
  }
  const expected = JSON.parse(readFixture('go.expected.json')) as ReturnType<typeof build>['snapshot']

  const mdxWith = (line: string): string => {
    const source = readFixture('go.mdx')
    return source.replace('- **Grok 4.7:**', () => `${line}\n- **Grok 4.7:**`)
  }
  /** Parse with the orphan-tolerant reader and join, as the refresh does. */
  const buildFrom = (line: string, models: LiveModel[], options: Parameters<typeof buildSnapshot>[3] = {}) => {
    const {rows, orphanFootnotes} = parsePrivacyDocsWithOrphans(mdxWith(line))
    return buildSnapshot(rows, models, FIXTURE_COMMIT, {...options, orphanFootnotes})
  }
  const withHungerG = (): LiveModel[] => [...live(), HUNGERG]

  test('the model is reported with its reason, has no entry, and every other entry is unchanged', () => {
    const result = buildFrom(FOOTNOTE, withHungerG())
    expect(result.snapshot).toEqual(expected)
    expect(result.snapshot.models['hungerg-free']).toBeUndefined()
    expect(result.disagreements).toEqual([])
    expect(result.unmatched).toEqual([{missing: 'footnote', id: 'hungerg-free', name: 'HungerG Free'}])
    expect(describeUnmatched(result.unmatched[0] as Unmatched)).toBe(
      'live model `hungerg-free` named `HungerG Free`: footnote only, no Privacy row, so it has no entry',
    )
  })

  test('eligibility leaves it excluded as not in the snapshot, and nothing else becomes eligible', () => {
    const ids = withHungerG().map(model => model.id)
    const result = computeEligibility(parseSnapshot(buildFrom(FOOTNOTE, withHungerG()).snapshot), ids, '2026-11-19')
    const baseline = computeEligibility(
      parseSnapshot(build().snapshot),
      live().map(model => model.id),
      '2026-11-19',
    )
    expect(result.excluded).toContainEqual({id: 'hungerg-free', reason: 'not-in-snapshot'})
    expect(result.eligible).toEqual(baseline.eligible)
  })

  test('the label is matched by the join’s own name normalization', () => {
    const result = buildFrom('- **hungerg  FREE:** Free for a limited time.', withHungerG())
    expect(result.unmatched).toEqual([{missing: 'footnote', id: 'hungerg-free', name: 'HungerG Free'}])
  })

  test('the join’s reviewed alias map names a model too, and without the alias the label fails', () => {
    const line = '- **HungerG:** Free for a limited time.'
    const aliases = {...DOCS_NAME_ALIASES, hungerg: 'hungerg-free'}
    expect(buildFrom(line, withHungerG(), {aliases}).unmatched).toEqual([
      {missing: 'footnote', id: 'hungerg-free', name: 'HungerG Free'},
    ])
    expect(() => buildFrom(line, withHungerG())).toThrow('"HungerG" does not name a model in the Privacy table')
  })

  test('the model is absent from the live list: the build throws as it did before', () => {
    expect(() => buildFrom(FOOTNOTE, live())).toThrow(PrivacyTableError)
    expect(() => buildFrom(FOOTNOTE, live())).toThrow('"HungerG Free" does not name a model in the Privacy table')
  })

  test('a misspelled label for an existing row throws', () => {
    expect(() => buildFrom('- **GLM-5.3x:** Hosted in China.', withHungerG())).toThrow(
      '"GLM-5.3x" does not name a model in the Privacy table',
    )
  })

  test('a label for a model that has a row, written so the parser cannot resolve it, throws: its rules would be lost', () => {
    // "GLM 5.3" is the live model glm-5.3, which has the row "GLM-5.3". Skipping the footnote would drop its terms.
    expect(() => buildFrom('- **GLM 5.3:** Requests are retained for 30 days.', withHungerG())).toThrow(
      '"GLM 5.3" does not name a model in the Privacy table',
    )
  })

  test.each([
    ['a row and a live model with no row', 'GPT 6 Luna / HungerG Free'],
    ['a live model with no row and a row', 'HungerG Free and GPT 6 Luna'],
    ['two live models with no row', 'HungerG Free / Beam Free Plus'],
  ])('a partial label (%s) throws even when every name in it is live', (_name, label) => {
    const models = [...live(), HUNGERG, {...HUNGERG, id: 'beam-free-plus', name: 'Beam Free Plus'}]
    expect(() => buildFrom(`- **${label}:** Free for a limited time.`, models)).toThrow(
      `"${label}" does not name a model in the Privacy table`,
    )
  })

  test.each([
    [
      'training allowed',
      '- **HungerG Free:** Free for a limited time in exchange for permission to use your prompts and completions to improve the model.',
    ],
    ['retained for 30 days', '- **HungerG Free:** Requests are retained for 30 days.'],
    ['region-limited', '- **HungerG Free:** Availability is limited to regions permitted by Meta.'],
  ])('a restrictive orphan footnote (%s) leaves the model out and clears nothing', (_name, line) => {
    const result = buildFrom(line, withHungerG())
    expect(result.snapshot).toEqual(expected)
    expect(result.unmatched).toEqual([{missing: 'footnote', id: 'hungerg-free', name: 'HungerG Free'}])
  })

  test('a footnote can never add the model: the entry stays absent whatever the API says about it', () => {
    const permissive = {...HUNGERG, training: false, zdr: true, limitedRegions: false}
    expect(buildFrom(FOOTNOTE, [...live(), permissive]).snapshot.models['hungerg-free']).toBeUndefined()
  })

  test('orphan text that names a model with a row fails the build, so that row keeps no stale zero retention', () => {
    const line = `${FOOTNOTE} Kimi K3 requests are retained for 30 days.`
    expect(entryOf('kimi-k3')?.zeroRetention).toBe(true)
    expect(() => buildFrom(line, withHungerG())).toThrow(/prose names "Kimi K3"/)
  })

  test('orphan text that names a reviewed family label fails the build', () => {
    expect(() => buildFrom(`${FOOTNOTE} The DeepSeek agreement ends soon.`, withHungerG())).toThrow(
      /prose names "deepseek"/,
    )
  })

  test('the same label twice is reported once', () => {
    const result = buildFrom(`${FOOTNOTE}\n- **HungerG Free:** Free for a limited time.`, withHungerG())
    expect(result.unmatched).toEqual([{missing: 'footnote', id: 'hungerg-free', name: 'HungerG Free'}])
  })

  test('a live entry with no privacy fields is reported once, as having none', () => {
    const result = buildFrom(FOOTNOTE, live(), {noPrivacy: [{id: 'hungerg-free', name: 'HungerG Free'}]})
    expect(result.unmatched).toEqual([{missing: 'privacy', id: 'hungerg-free', name: 'HungerG Free'}])
    expect(result.snapshot).toEqual(expected)
  })

  test('the orphan list is checked even when it is the only thing wrong with a join that otherwise pairs', () => {
    const {rows} = parsePrivacyDocsWithOrphans(mdxWith(FOOTNOTE))
    expect(() => buildSnapshot(rows, live(), FIXTURE_COMMIT, {orphanFootnotes: [{label: 'Nope', text: 'x'}]})).toThrow(
      '"Nope" does not name a model in the Privacy table',
    )
  })

  test('a line rendered for a hostile label stays one bounded plain line', () => {
    const nasty = '# Heading\n- item |x| `code` [link](https://example.com) <b>bold</b>'
    const line = describeUnmatched({missing: 'footnote', id: 'brand-new', name: nasty})
    expect(line).not.toMatch(/[\n\r]/)
    expect(line.startsWith('live model `brand-new` named `# Heading - item |x| code [link]')).toBe(true)
    expect(line.split('`').length % 2).toBe(1)
  })
})
