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
    // The usage-limits notice "Not available in <places>." is the page's statement of Beam Free's region limit.
    expect(rows.get('Beam Free')).toEqual({name: 'Beam Free', retentionDays: 30, ...plain, availabilityLimited: true})
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
  const TRAINING =
    'Free for a limited time in exchange for permission to use your prompts and completions to improve the model.'
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
    const ungated = withoutBullet.replace(
      LONGCAT_FOOTNOTE,
      () => '- **LongCat 2.5 Free:** ZDR agreement is renewed monthly.',
    )
    expect(longcat(ungated)?.regionRequirement).toBe(false)
  })

  test('the restricted-models bullet alone gates its target', () => {
    const bulletOnly = mdx.replace(LONGCAT_FOOTNOTE, () => '- **LongCat 2.5 Free:** ZDR agreement is renewed monthly.')
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

/** The Privacy footnote line that starts with `label`, as the pinned page writes it. */
const footnoteLine = (label: string): string => {
  const lines = mdx.split('\n')
  const line = lines.slice(lines.indexOf('## Privacy')).find(candidate => candidate.startsWith(`- **${label}:**`))
  if (line === undefined) throw new Error(`fixture has no footnote for ${label}`)
  return line
}

describe('parsePrivacyDocs on prose in the restricted-models section', () => {
  const NEXT = 'See [Privacy](#privacy) for each model'
  const prose = (sentence: string): string => mutate(NEXT, `${sentence}\n\n${NEXT}`)

  test('prose that names a Privacy model fails the refresh and says which model', () => {
    const source = prose('Kimi K3 requires **Global** regions in your workspace privacy settings.')
    expect(() => parsePrivacyDocs(source)).toThrow(PrivacyTableError)
    expect(() => parsePrivacyDocs(source)).toThrow(/prose names "Kimi K3"/)
  })

  test.each([
    ['a lowercase, hyphenated spelling', 'kimi-k3 needs Global regions.'],
    ['emphasis around the name', 'Models such as **Kimi K3** need Global regions.'],
    ['a link around the name', 'Models such as [Kimi K3](https://example.com/k3) need Global regions.'],
    ['a family name from the reviewed label mapping', 'DeepSeek needs Global regions.'],
    ['a name at the end of a sentence', 'Global regions are needed for Hy3.'],
  ])('also fails on %s', (_label, sentence) => {
    expect(() => parsePrivacyDocs(prose(sentence))).toThrow(/prose names/)
  })

  test('also fails when the name is split across a wrapped line', () => {
    expect(() => parsePrivacyDocs(prose('Kimi\nK3 requires Global regions.'))).toThrow(/prose names "Kimi K3"/)
  })

  test('a model name inside a longer word is not a mention', () => {
    expect(() => parsePrivacyDocs(prose('The Hy3rid mode is not a model.'))).not.toThrow()
  })

  test('also fails on prose between the bullets', () => {
    const bullet = '- **LongCat 2.5 Free:** select **Global** under **Regions**.'
    expect(() => parsePrivacyDocs(mutate(bullet, `Grok 4.7 is unavailable.\n${bullet}`))).toThrow(
      /prose names "Grok 4.7"/,
    )
  })

  test('also fails on prose in front of the Privacy table, which no other rule reads', () => {
    const intro = 'See whether each model [trains on your data](https://opencode.ai/console/go#privacy).'
    expect(() =>
      parsePrivacyDocs(mutate(intro, `${intro}\n\nKimi K3 requires **Global** regions in your workspace.`)),
    ).toThrow(/prose names "Kimi K3"/)
  })

  test('the general prose of the pinned page names no model and still passes', () => {
    expect(() => parsePrivacyDocs(mdx)).not.toThrow()
  })

  test('truncates a long echoed model name', () => {
    const longName = `${'M'.repeat(200)} Model`
    const withRow = mutate('| Hy3                        | 0 days         |', `| ${longName} | 0 days |`)
    const source = withRow.replace(NEXT, `${longName} needs Global regions.\n\n${NEXT}`)
    let message = ''
    try {
      parsePrivacyDocs(source)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('prose names')
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(300)
  })
})

describe('parsePrivacyDocs accounts for every footnote sentence', () => {
  const kimi = (sentence: string): string => mutate('- **Grok 4.7:**', `- **Kimi K3:** ${sentence}\n- **Grok 4.7:**`)

  test('a retention clause cannot hide a training clause in the same sentence', () => {
    const source = kimi(
      'Requests are retained for 0 days, and permission to use your prompts and completions to train future models is granted.',
    )
    expect(() => parsePrivacyDocs(source)).toThrow(/unmapped footnote sentence/)
  })

  test('an informational sentence cannot swallow a retention clause', () => {
    const source = kimi('ZDR disables file uploads, but requests are retained for 30 days.')
    expect(() => parsePrivacyDocs(source)).toThrow(/unmapped footnote sentence/)
  })

  test.each([
    ['Grok 4.7'],
    ['GPT 6 Luna / GPT 5.6 Luna'],
    ['Claude Haiku 5.5'],
    ['Gemini 4 Argon'],
    ['Muse Spark 1.3 Contributor'],
    ['Iceman Contributor Free'],
    ['LongCat 2.5 Free'],
    ['DeepSeek'],
  ])('a clause added to the first sentence of the %s footnote throws', label => {
    const line = footnoteLine(label)
    const end = line.search(/\.(?:\s|$)/)
    expect(end).toBeGreaterThan(0)
    const extended = `${line.slice(0, end)}, and the data is shared with partners${line.slice(end)}`
    expect(() => parsePrivacyDocs(mutate(line, extended))).toThrow(/unmapped footnote sentence/)
  })

  test.each([
    [
      'the Grok informational sentence',
      'Grok 4.7',
      'ZDR disables important API features',
      'ZDR disables some API features',
    ],
    [
      'the GPT retention sentence',
      'GPT 6 Luna / GPT 5.6 Luna',
      'generated for all API feature usage',
      'generated for some API feature usage',
    ],
    ['the Gemini retention sentence', 'Gemini 4 Argon', 'for abuse monitoring', 'for quality monitoring'],
    ['the Muse training sentence', 'Muse Spark 1.3 Contributor', 'Heavily discounted', 'Discounted'],
    ['the Iceman training sentence', 'Iceman Contributor Free', 'for a limited time', 'for a while'],
    ['the DeepSeek renewal sentence', 'DeepSeek', 'renewed monthly', 'renewed yearly'],
  ])('rewording %s throws instead of being read loosely', (_what, label, from, to) => {
    const line = footnoteLine(label)
    expect(line.split(from)).toHaveLength(2)
    expect(() => parsePrivacyDocs(mutate(line, line.replace(from, to)))).toThrow(/unmapped footnote sentence/)
  })

  test('the two-sentence Muse footnote and the Grok informational footnote still parse', () => {
    const rows = rowsByName(mdx)
    expect(rows.get('Muse Spark 1.3 Contributor')).toMatchObject({trainingGranted: true, availabilityLimited: true})
    expect(rows.get('Grok 4.7')).toMatchObject({retentionDays: 30, trainingGranted: false})
  })

  test('a name slot holds proper nouns only, so lowercase text there is not read as a name', () => {
    const line = footnoteLine('Claude Haiku 5.5')
    expect(line).toContain("Anthropic's Data Policies")
    expect(() =>
      parsePrivacyDocs(
        mutate(line, line.replace("Anthropic's Data Policies", "Anthropic's policies and trains on it")),
      ),
    ).toThrow(/unmapped footnote sentence/)
  })

  test('a hosting sentence cannot carry lowercase text after the place', () => {
    expect(() => parsePrivacyDocs(kimi('Hosted in China and trains on your data.'))).toThrow(
      /unmapped footnote sentence/,
    )
  })
})

describe('parsePrivacyDocs resolves labels by exact name or a reviewed mapping', () => {
  const HY4_ROW = '| Hy4                        | 0 days         |'
  const withoutHy4 = (): string => mutate(`${HY4_ROW}\n`, '')
  const hy4Footnote = '- **Hy4:** Hosted in China.\n'
  const addHy4Footnote = (source: string): string =>
    source.replace('- **Grok 4.7:**', () => `${hy4Footnote}- **Grok 4.7:**`)

  test('a label does not attach to rows that merely start with it', () => {
    const source = addHy4Footnote(withoutHy4())
    expect(source).not.toContain(HY4_ROW)
    expect(() => parsePrivacyDocs(source)).toThrow(/"Hy4" does not name a model/)
  })

  test('a label does not attach to rows that merely end with it', () => {
    expect(() => parsePrivacyDocs(mutate('- **Grok 4.7:**', '- **Pro:** Hosted in China.\n- **Grok 4.7:**'))).toThrow(
      /"Pro" does not name a model/,
    )
  })

  test('with the Hy4 row present the same footnote reaches only that row', () => {
    const rows = rowsByName(addHy4Footnote(mdx))
    expect(rows.get('Hy4')?.regionRequirement).toBe(true)
    expect(rows.get('Hy4 preview')?.regionRequirement).toBe(false)
    expect(rows.get('Hy4 flash Free')?.regionRequirement).toBe(false)
  })

  test('the DeepSeek family label reaches both DeepSeek rows through the reviewed mapping', () => {
    const rows = rowsByName(mdx)
    expect(rows.get('DeepSeek V4.1 Flash')?.agreementExpiry).toBe('2026-11-30')
    expect(rows.get('DeepSeek V4 Pro')?.agreementExpiry).toBe('2026-11-30')
  })

  test('a family label that is also an exact row name is ambiguous and throws', () => {
    expect(() =>
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', '| DeepSeek | 0 days |')),
    ).toThrow(/ambiguous/)
  })

  test('a reviewed mapping whose row has gone throws instead of dropping the restriction', () => {
    expect(() => parsePrivacyDocs(mutate('| DeepSeek V4 Pro            | 0 days\\*       |\n', ''))).toThrow(
      /deepseek.*no longer/,
    )
  })

  test.each([
    ['a slash-joined list of full names', 'GPT 6 Luna / GPT 5.6 Luna'],
    ['an "and"-joined list of full names', 'Muse Spark 1.3 Contributor and Muse Spark 1.2 Contributor'],
  ])('%s resolves each name exactly', (_label, label) => {
    expect(() =>
      parsePrivacyDocs(mutate('- **Grok 4.7:**', `- **${label}:** Hosted in China.\n- **Grok 4.7:**`)),
    ).not.toThrow()
  })

  test('a list in which one name is not a row throws', () => {
    expect(() =>
      parsePrivacyDocs(mutate('- **Grok 4.7:**', '- **GPT 6 Luna / GPT 7 Luna:** Hosted in China.\n- **Grok 4.7:**')),
    ).toThrow(/"GPT 6 Luna \/ GPT 7 Luna" does not name a model/)
  })

  test('a shorthand in a restricted-models bullet outside the mapping throws', () => {
    expect(() =>
      parsePrivacyDocs(
        mutate('- **DeepSeek V4.1 Flash and V4 Pro:** select', '- **DeepSeek V4.1 Flash and V4 Pro and V5:** select'),
      ),
    ).toThrow(PrivacyTableError)
  })
})

describe('parsePrivacyDocs on agreement dates and echoed text', () => {
  test('an impossible calendar date throws the parser error naming the agreement, not a RangeError', () => {
    const source = mutate('valid through November 30, 2026', 'valid through November 32, 2026')
    expect(() => parsePrivacyDocs(source)).toThrow(PrivacyTableError)
    expect(() => parsePrivacyDocs(source)).toThrow(/"DeepSeek": unparseable agreement date "November 32, 2026"/)
  })

  test.each(['February 30, 2026', 'April 31, 2026', 'February 29, 2027', 'November 0, 2026'])('rejects %s', date => {
    expect(() => parsePrivacyDocs(mutate('valid through November 30, 2026', `valid through ${date}`))).toThrow(
      PrivacyTableError,
    )
  })

  test('accepts a real leap day', () => {
    const rows = rowsByName(mutate('valid through November 30, 2026', 'valid through February 29, 2028'))
    expect(rows.get('DeepSeek V4 Pro')?.agreementExpiry).toBe('2028-02-29')
  })

  test('caps an echoed retention cell at a short length', () => {
    const cell = 'x'.repeat(5000)
    let message = ''
    try {
      parsePrivacyDocs(mutate('| Hy3                        | 0 days         |', `| Hy3 | ${cell} |`))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('unrecognized retention value')
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(300)
  })

  test('caps an echoed footnote label at a short length', () => {
    const label = `${'L'.repeat(5000)} Model`
    let message = ''
    try {
      parsePrivacyDocs(mutate('- **Grok 4.7:**', `- **${label}:** Hosted in China.\n- **Grok 4.7:**`))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('does not name a model')
    expect(message.length).toBeLessThan(300)
  })
})

/** The Usage limits paragraph that starts with `**label:**`, as the pinned page writes it. */
const noticeLine = (label: string): string => {
  const line = mdx.split('\n').find(candidate => candidate.startsWith(`**${label}:**`))
  if (line === undefined) throw new Error(`fixture has no usage notice for ${label}`)
  return line
}

describe('parsePrivacyDocs on per-model usage notices', () => {
  const BEAM = noticeLine('Beam Free')
  const ARGON = noticeLine('Gemini 4 Argon')
  const PLACES = 'Angola, Belarus, Cambodia'
  const beam = (source: string) => rowsByName(source).get('Beam Free')
  /** The Beam Free notice replaced by `text`, written as the page writes a notice. */
  const withBeamNotice = (text: string): string => mutate(BEAM, `**Beam Free:** ${text}`)
  /** A notice paragraph added in front of the Argon one. */
  const withNotice = (line: string): string => mutate(ARGON, `${line}\n\n${ARGON}`)

  test('the page states Beam Free’s region limit in the "Not available in <places>." form', () => {
    expect(BEAM).toContain('Free for a limited time. Not available in Angola, Belarus')
    expect(beam(mdx)?.availabilityLimited).toBe(true)
    expect(beam(mdx)?.regionRequirement).toBe(false)
  })

  test('with the notice removed the page says nothing about Beam Free’s region', () => {
    expect(beam(mutate(`${BEAM}\n\n`, ''))?.availabilityLimited).toBe(false)
  })

  test('a notice reaches only the model its label names', () => {
    const rows = rowsByName(mdx)
    expect(rows.get('Gemini 4 Argon')?.availabilityLimited).toBe(false)
    expect(rows.get('GLM-5.3')?.availabilityLimited).toBe(false)
  })

  test.each([
    ['Unavailable in', 'Unavailable in Angola.'],
    ['Available only in', 'Available only in Europe.'],
    ['Only available in', 'Only available in Europe.'],
    ['Restricted to', 'Restricted to the United States.'],
    ['Limited to', 'Limited to Europe.'],
    ['Not available outside', 'Not available outside Europe.'],
    ['a sentence about the country', 'This model is offered in a few countries.'],
    ['a sentence about regions', 'Some regions are refused.'],
    ['a blocked statement', 'Blocked in Russia.'],
    ['an availability note', 'Availability varies.'],
    ['a recognised sentence with a clause', 'Not available in Angola, and trains on your data.'],
    ['a recognised sentence with a lowercase place word', 'Not available in some countries.'],
    ['no closing period', 'Not available in Angola'],
    ['a digit in the places', 'Not available in Angola 2.'],
  ])('a reworded availability notice (%s) throws instead of being ignored', (_label, sentence) => {
    const source = withBeamNotice(`Free for a limited time. ${sentence}`)
    expect(() => parsePrivacyDocs(source)).toThrow(PrivacyTableError)
    expect(() => parsePrivacyDocs(source)).toThrow(/usage notice/)
  })

  test.each([
    ['added', (): string => withNotice('**Beam Free:** Free through November 25, 2026.')],
    [
      'reworded',
      (): string => mutate(ARGON, '**Gemini 4 Argon:** Half price on every plan until the end of the month.'),
    ],
    ['removed', (): string => mutate(`${noticeLine('GLM-5.3')}\n\n`, '')],
    ['for a model with no Privacy row', (): string => withNotice('**Mystery Model:** 20% off until Friday.')],
    ['with a long date', (): string => withNotice('**Hy4:** Higher usage limits apply through December 31, 2026.')],
  ])('a pricing notice %s changes nothing and never throws', (_label, make) => {
    expect(parsePrivacyDocs(make())).toEqual(parsePrivacyDocs(mdx))
  })

  test('a pricing sentence next to the recognised one is ignored', () => {
    const rows = rowsByName(withBeamNotice(`Free through November 25, 2026. Not available in ${PLACES}.`))
    expect(rows.get('Beam Free')?.availabilityLimited).toBe(true)
  })

  test('an availability notice for a label that matches no row throws, naming the label', () => {
    const source = withNotice('**Mystery Model:** Not available in Angola.')
    expect(() => parsePrivacyDocs(source)).toThrow(/"Mystery Model" does not name a model/)
  })

  test('an unrecognised availability sentence for a label that matches no row throws too', () => {
    expect(() => parsePrivacyDocs(withNotice('**Mystery Model:** Unavailable in Angola.'))).toThrow(/usage notice/)
  })

  test('a notice label resolves like every other label: the reviewed family mapping works, a prefix does not', () => {
    const family = rowsByName(withNotice(`**DeepSeek:** Not available in ${PLACES}.`))
    expect(family.get('DeepSeek V4 Pro')?.availabilityLimited).toBe(true)
    expect(family.get('DeepSeek V4.1 Flash')?.availabilityLimited).toBe(true)
    expect(() => parsePrivacyDocs(withNotice(`**Hy:** Not available in ${PLACES}.`))).toThrow(
      /"Hy" does not name a model/,
    )
  })

  test('a notice wrapped over several lines is read as one paragraph', () => {
    const rows = rowsByName(withBeamNotice(`Free for a limited time. Not available in Angola,\nBelarus, Cambodia.`))
    expect(rows.get('Beam Free')?.availabilityLimited).toBe(true)
  })

  test('a name in a notice is not "prose that names a model": only the two inspected sections are', () => {
    expect(() => parsePrivacyDocs(mutate(ARGON, '**Gemini 4 Argon:** Kimi K3 costs less.'))).not.toThrow()
  })

  test('notices are read in the Usage limits section only', () => {
    const elsewhere = mutate(
      '## Where can I use it?',
      '**Beam Free:** Unavailable in Angola.\n\n## Where can I use it?',
    )
    expect(parsePrivacyDocs(elsewhere)).toEqual(parsePrivacyDocs(mdx))
  })

  test('a missing Usage limits section throws, because Beam Free’s notice would be lost', () => {
    expect(() => parsePrivacyDocs(mutate('## Usage limits', '## Something else'))).toThrow(/Usage limits/)
  })

  test('a very long place list parses quickly', () => {
    const places = `${'Angola, '.repeat(1000)}or Belarus`
    const started = performance.now()
    const rows = rowsByName(withBeamNotice(`Not available in ${places}.`))
    expect(performance.now() - started).toBeLessThan(1000)
    expect(rows.get('Beam Free')?.availabilityLimited).toBe(true)
  })

  test('a very long near-miss fails quickly instead of backtracking', () => {
    const started = performance.now()
    expect(() => parsePrivacyDocs(withBeamNotice(`Not available in ${'A'.repeat(5000)}!`))).toThrow(/usage notice/)
    expect(() => parsePrivacyDocs(withBeamNotice(`Not available in ${'a, '.repeat(2000)}.`))).toThrow(/usage notice/)
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test('an echoed notice sentence is capped', () => {
    let message = ''
    try {
      parsePrivacyDocs(withBeamNotice(`Unavailable in ${'x'.repeat(5000)}.`))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('…')
    expect(message.length).toBeLessThan(300)
  })
})
