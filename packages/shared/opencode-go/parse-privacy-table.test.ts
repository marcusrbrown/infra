import type {DocsPrivacyRow} from './parse-privacy-table'
import {readFileSync} from 'node:fs'

import {describe, expect, test} from 'bun:test'

import {parsePrivacyDocs, PrivacyTableError} from './parse-privacy-table'

const readFixture = (name: string) => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8')

const mdx = readFixture('go.mdx')

/** Replace exactly one occurrence; a drifted fixture fails loudly instead of silently testing nothing. */
const mutate = (from: string, to: string): string => {
  expect(mdx.split(from)).toHaveLength(2)
  return mdx.replace(from, () => to)
}

const rowsByName = (source: string): Map<string, DocsPrivacyRow> =>
  new Map(parsePrivacyDocs(source).map(row => [row.name, row]))

const plain = {
  trainingGranted: false,
  regionRequirement: false,
  availabilityLimited: false,
  agreementExpiry: null,
} as const

describe('parsePrivacyDocs on the pinned go.mdx', () => {
  const rows = rowsByName(mdx)

  test('reads one row per Privacy table line, in page order', () => {
    const parsed = parsePrivacyDocs(mdx)
    expect(parsed).toHaveLength(31)
    expect(parsed[0]?.name).toBe('Grok 4.7')
    expect(parsed.at(-1)?.name).toBe('Hy4 flash Free')
  })

  test('maps each footnote and marker to the fact it qualifies', () => {
    // Marker + "valid through" footnote -> expiry; restricted-models bullet -> workspace Global requirement.
    expect(rows.get('DeepSeek V4.1 Flash')).toEqual({
      name: 'DeepSeek V4.1 Flash',
      retentionDays: 0,
      ...plain,
      regionRequirement: true,
      agreementExpiry: '2026-11-30',
    })
    expect(rows.get('DeepSeek V4 Pro')).toEqual({
      name: 'DeepSeek V4 Pro',
      retentionDays: 0,
      ...plain,
      regionRequirement: true,
      agreementExpiry: '2026-11-30',
    })
    // Retention footnotes agree with the table; none of them gates anything.
    expect(rows.get('Gemini 4 Argon')).toEqual({name: 'Gemini 4 Argon', retentionDays: 55, ...plain})
    expect(rows.get('Claude Haiku 5.5')).toEqual({name: 'Claude Haiku 5.5', retentionDays: 30, ...plain})
    expect(rows.get('Grok 4.7')).toEqual({name: 'Grok 4.7', retentionDays: 30, ...plain})
    // Training footnote + availability footnote + opt-in rule.
    expect(rows.get('Muse Spark 1.3 Contributor')).toEqual({
      name: 'Muse Spark 1.3 Contributor',
      retentionDays: null,
      ...plain,
      trainingGranted: true,
      availabilityLimited: true,
    })
    expect(rows.get('Muse Spark 1.2 Contributor')?.trainingGranted).toBe(true)
    // Training footnote alone.
    expect(rows.get('Iceman Contributor Free')).toEqual({
      name: 'Iceman Contributor Free',
      retentionDays: null,
      ...plain,
      trainingGranted: true,
    })
    // Hosting + Global sentences.
    expect(rows.get('LongCat 2.5 Free')).toEqual({
      name: 'LongCat 2.5 Free',
      retentionDays: 0,
      ...plain,
      regionRequirement: true,
    })
    // The page no longer says anything about Beam Free's region; that now lives in the API only.
    expect(rows.get('Beam Free')).toEqual({name: 'Beam Free', retentionDays: 30, ...plain})
    expect(rows.get('Hy4 flash Free')).toEqual({name: 'Hy4 flash Free', retentionDays: 0, ...plain})
    expect(rows.get('GLM-5.3')).toEqual({name: 'GLM-5.3', retentionDays: 0, ...plain})
  })
})

describe('parsePrivacyDocs on the current page layout', () => {
  test('parses a page with no Endpoints table, no model list and no training column (the pinned page)', () => {
    expect(mdx).not.toContain('Model ID')
    expect(mdx).not.toContain('The current list of models includes:')
    expect(mdx).not.toContain('Model training')
    expect(() => parsePrivacyDocs(mdx)).not.toThrow()
  })

  test('parses a page with no Endpoints heading at all', () => {
    const lines = mdx.split('\n')
    const start = lines.indexOf('## Endpoints')
    const end = lines.indexOf('## Privacy')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(parsePrivacyDocs([...lines.slice(0, start), ...lines.slice(end)].join('\n'))).toEqual(parsePrivacyDocs(mdx))
  })

  test('on a reinstated training column, because a column it does not read could hide a fact', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate('| Model                      | Data retention |', '| Model | Model training | Data retention |'),
      ),
    ).toThrow(/columns/)
  })
})

describe('parsePrivacyDocs fails closed', () => {
  test('on an unmapped footnote sentence', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate('- **Grok 4.7:** ZDR disables', '- **Grok 4.7:** Logs are mirrored to a cold archive. ZDR disables'),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a footnote that names no model', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **Mystery Model:** Data is retained for 7 days.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(/Mystery Model/)
  })

  test('on a retention marker that has no agreement footnote', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', String.raw`| Hy3 | 0 days\* |`)),
    ).toThrow(/marker/i)
  })

  test('on a retention marker that only a non-agreement footnote qualifies', () => {
    const marked = mutate(
      '| LongCat 2.5 Free           | 0 days         |',
      String.raw`| LongCat 2.5 Free | 0 days\* |`,
    )
    expect(() => parsePrivacyDocs(marked)).toThrow(/marker/i)
  })

  test('on an unknown marker character', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', '| Hy3 | 0 days† |')),
    ).toThrow(PrivacyTableError)
  })

  test('on a missing column', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Model                      | Data retention |', '| Model                      |')),
    ).toThrow(PrivacyTableError)
  })

  test('on a row with the wrong cell count', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', '| Hy3 | 0 days | extra |')),
    ).toThrow(PrivacyTableError)
  })

  test('on zero rows', () => {
    const lines = mdx.split('\n')
    const start = lines.findIndex(l => l.startsWith('| Model                      | Data retention'))
    const end = lines.findIndex((l, i) => i > start && !l.startsWith('|'))
    const without = [...lines.slice(0, start + 2), ...lines.slice(end)].join('\n')
    expect(() => parsePrivacyDocs(without)).toThrow(/no rows/i)
  })

  test('on a missing Privacy section', () => {
    expect(() => parsePrivacyDocs(mutate('## Privacy', '## Something else'))).toThrow(PrivacyTableError)
  })

  test('on an unrecognized retention value', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', '| Hy3 | a while |')),
    ).toThrow(PrivacyTableError)
  })

  test('on a footnote retention that contradicts the table', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **GLM-5.3:** Requests are retained for 30 days.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a missing restricted-models section, which carries the Global-region rule', () => {
    expect(() => parsePrivacyDocs(mutate('### Enable restricted models', '### Something else'))).toThrow(
      PrivacyTableError,
    )
  })

  test('on an unrecognized restricted-models rule', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate(
          '- **DeepSeek V4.1 Flash and V4 Pro:** select **Global** under **Regions**.',
          '- **DeepSeek V4.1 Flash and V4 Pro:** phone the support desk.',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test.each([
    ['the colon outside the bold text', '- **DeepSeek V4.1 Flash and V4 Pro**: select **Global** under **Regions**.'],
    ['an asterisk list marker', '* **DeepSeek V4.1 Flash and V4 Pro:** select **Global** under **Regions**.'],
    ['no bold label', '- DeepSeek V4.1 Flash and V4 Pro: select **Global** under **Regions**.'],
  ])('on a reformatted restricted-models bullet with %s, which would drop a region rule', (_label, bullet) => {
    const original = '- **DeepSeek V4.1 Flash and V4 Pro:** select **Global** under **Regions**.'
    expect(() => parsePrivacyDocs(mutate(original, bullet))).toThrow(PrivacyTableError)
  })

  test('but not on prose inside the restricted-models section', () => {
    const intro = 'In **Settings › Privacy**, an owner or admin can enable:'
    expect(parsePrivacyDocs(mutate(intro, `${intro}\n\nEvery change takes effect at once.`))).toEqual(
      parsePrivacyDocs(mdx),
    )
  })

  test('on a duplicate privacy row', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', '| Hy4 | 0 days |')),
    ).toThrow(/duplicate/i)
  })

  test('on an unparseable agreement date', () => {
    expect(() => parsePrivacyDocs(mutate('valid through November 30, 2026', 'valid through Smarch 40, 2026'))).toThrow(
      PrivacyTableError,
    )
  })

  test('on conflicting agreement dates for one model', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **DeepSeek V4 Pro:** The current agreement is valid through December 31, 2026.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(/conflicting agreement dates/)
  })
})

describe('parsePrivacyDocs on training statements', () => {
  const GLM_ROW = '| GLM-5.3                    | 0 days         |'
  const TRAINING = 'Free in exchange for permission to use your prompts and completions to improve the model.'
  const addFootnote = (line: string) =>
    mutate('- **DeepSeek:** ZDR agreement', `${line}\n- **DeepSeek:** ZDR agreement`)

  test('a footnote that grants permission to use prompts marks its model as training', () => {
    expect(mdx).toContain(GLM_ROW)
    const rows = rowsByName(addFootnote(`- **GLM-5.3:** ${TRAINING}`))
    expect(rows.get('GLM-5.3')?.trainingGranted).toBe(true)
    expect(rows.get('GLM-5.3-Flash')?.trainingGranted).toBe(false)
  })

  test('the opt-in rule alone marks its models as training', () => {
    const rule = '- **GLM-5.3:** turn on **Allow paid endpoints that train on request data**.'
    const rows = rowsByName(mutate('- **LongCat 2.5 Free:** select', `${rule}\n- **LongCat 2.5 Free:** select`))
    expect(rows.get('GLM-5.3')?.trainingGranted).toBe(true)
  })
})

describe('parsePrivacyDocs on region footnotes', () => {
  const HOSTING = 'Hosted in China.'
  const REGION = 'Requires **Global** regions in your workspace privacy settings.'
  const AVAILABILITY = "Availability is limited to regions permitted by Meta's Geographic Use Policy."
  const LONGCAT_FOOTNOTE = `- **LongCat 2.5 Free:** ${HOSTING} ${REGION}`
  const LONGCAT_RESTRICTED = '- **LongCat 2.5 Free:** select **Global** under **Regions**.\n'
  const LONGCAT_ROW = '| LongCat 2.5 Free           | 0 days         |'
  const longcat = (source: string) => rowsByName(source).get('LongCat 2.5 Free')

  /** The LongCat footnote replaced by `sentences`, restricted-models bullet removed: only the footnote can gate. */
  const footnoteOnly = (sentences: string): string =>
    mutate(LONGCAT_RESTRICTED, '').replace(LONGCAT_FOOTNOTE, () => `- **LongCat 2.5 Free:** ${sentences}`)

  test('the pinned page carries the footnote in the sentence forms the rules match', () => {
    expect(mdx.split(LONGCAT_FOOTNOTE)).toHaveLength(2)
    expect(mdx.split(LONGCAT_RESTRICTED)).toHaveLength(2)
    expect(mdx.split(LONGCAT_ROW)).toHaveLength(2)
  })

  test('the hosting sentence alone gates its target', () => {
    expect(longcat(footnoteOnly(HOSTING))).toEqual({
      name: 'LongCat 2.5 Free',
      retentionDays: 0,
      ...plain,
      regionRequirement: true,
    })
  })

  test('the Global sentence alone gates its target', () => {
    expect(longcat(footnoteOnly(REGION))?.regionRequirement).toBe(true)
  })

  test('a hosting footnote with no restricted-models bullet is still gated', () => {
    const withoutBullet = mutate(LONGCAT_RESTRICTED, '')
    expect(longcat(withoutBullet)?.regionRequirement).toBe(true)
    // Control: without the bullet and without the region sentences, nothing gates LongCat.
    const ungated = withoutBullet.replace(LONGCAT_FOOTNOTE, () => '- **LongCat 2.5 Free:** ZDR disables training.')
    expect(longcat(ungated)?.regionRequirement).toBe(false)
  })

  test('the restricted-models bullet alone gates its target', () => {
    const bulletOnly = mdx.replace(LONGCAT_FOOTNOTE, () => '- **LongCat 2.5 Free:** ZDR disables training.')
    expect(longcat(bulletOnly)?.regionRequirement).toBe(true)
  })

  test('a hosting sentence names any place', () => {
    expect(longcat(footnoteOnly('Hosted in Singapore and Hong Kong.'))?.regionRequirement).toBe(true)
  })

  test('an availability sentence is the one the API can confirm, and does not set the docs-only gate', () => {
    const row = longcat(footnoteOnly(AVAILABILITY))
    expect(row?.availabilityLimited).toBe(true)
    expect(row?.regionRequirement).toBe(false)
  })

  test('an unknown sentence next to them still throws the unmapped-sentence error', () => {
    const source = mdx.replace(LONGCAT_FOOTNOTE, () => `${LONGCAT_FOOTNOTE} Logs are mirrored to a cold archive.`)
    expect(source).not.toBe(mdx)
    expect(() => parsePrivacyDocs(source)).toThrow(
      '"LongCat 2.5 Free": unmapped footnote sentence "Logs are mirrored to a cold archive."',
    )
  })

  test.each([
    ['a hosting sentence with no place', 'Hosted in.'],
    ['a hosting sentence with a blank place', 'Hosted in .'],
    ['a hosting sentence with no closing period', 'Hosted in China'],
    ['a hosting sentence not at the start', 'Mostly Hosted in China.'],
    ['a region sentence that names no region', 'Requires regions'],
    ['a region sentence with another region', 'Requires **Europe** regions in your workspace privacy settings.'],
    ['a region sentence with no closing period', 'Requires **Global** regions in your workspace privacy settings'],
  ])('a near miss (%s) still throws', (_label, sentence) => {
    expect(() => parsePrivacyDocs(footnoteOnly(sentence))).toThrow(/unmapped footnote sentence/)
  })
})
