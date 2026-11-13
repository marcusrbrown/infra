import {readFileSync} from 'node:fs'
import {describe, expect, test} from 'bun:test'

import {parseSnapshot} from './eligibility'
import {parsePrivacyTable, PrivacyTableError} from './parse-privacy-table'

const FIXTURE_COMMIT = '2f886a2a5e0f22b813fe0c177105559b508abad5'

const readFixture = (name: string) => readFileSync(new URL(`__fixtures__/${name}`, import.meta.url), 'utf8')

const mdx = readFixture('go.mdx')

/** Replace exactly one occurrence; a drifted fixture fails loudly instead of silently testing nothing. */
const mutate = (from: string, to: string): string => {
  expect(mdx.split(from)).toHaveLength(2)
  return mdx.replace(from, () => to)
}

const parse = (source: string) => parsePrivacyTable(source, FIXTURE_COMMIT)

describe('parsePrivacyTable on the pinned go.mdx', () => {
  test('parses to exactly go.expected.json', () => {
    expect(parse(mdx)).toEqual(JSON.parse(readFixture('go.expected.json')))
  })

  test('the output satisfies the snapshot schema with no invalid entries', () => {
    const parsed = parseSnapshot(parse(mdx))
    expect(parsed.invalid).toEqual([])
    expect(parsed.source).toEqual({
      repo: 'anomalyco/opencode',
      path: 'services/site/src/docs/content/console/go.mdx',
      commit: FIXTURE_COMMIT,
    })
  })

  test('keys models by endpoint id, sorted', () => {
    const ids = Object.keys(parse(mdx).models)
    expect(ids).toEqual([...ids].sort())
    expect(ids).toContain('claude-haiku-5-5')
    expect(ids).toContain('glm-5.3')
  })

  test('maps each footnote and marker to the field it qualifies', () => {
    const {models} = parse(mdx)
    // Marker `*` + "valid through" footnote -> agreement expiry, plus the Global-region requirement.
    expect(models['deepseek-v4.1-flash']).toEqual({
      zeroRetention: true,
      trainsOnData: false,
      regionGated: true,
      agreementExpiry: '2026-11-30',
    })
    expect(models['deepseek-v4-pro']).toEqual(models['deepseek-v4.1-flash'])
    // Retention footnote: 30 days is not zero retention.
    expect(models['claude-haiku-5-5']).toEqual({
      zeroRetention: false,
      trainsOnData: false,
      regionGated: false,
      agreementExpiry: null,
    })
    expect(models['gpt-6-luna']?.zeroRetention).toBe(false)
    expect(models['gpt-5.6-luna']?.zeroRetention).toBe(false)
    expect(models['grok-4.7']?.zeroRetention).toBe(false)
    // Training flag + region footnote.
    expect(models['muse-spark-1.3-contributor']).toEqual({
      zeroRetention: false,
      trainsOnData: true,
      regionGated: true,
      agreementExpiry: null,
    })
    expect(models['iceman-contributor-free']?.trainsOnData).toBe(true)
    // Region from the model list ("limited regions").
    expect(models['beam-free']?.regionGated).toBe(true)
    // Hosting + region footnote and the restricted-models bullet: zero retention, no training, region-gated.
    expect(models['longcat-2.5-free']).toEqual({
      zeroRetention: true,
      trainsOnData: false,
      regionGated: true,
      agreementExpiry: null,
    })
    expect(models['crouton-alpha-free']).toBeUndefined()
    // Plain zero-retention row.
    expect(models['glm-5.3']).toEqual({
      zeroRetention: true,
      trainsOnData: false,
      regionGated: false,
      agreementExpiry: null,
    })
  })
})

describe('parsePrivacyTable fails closed', () => {
  test('on an unmapped footnote sentence', () => {
    expect(() =>
      parse(
        mutate('- **Grok 4.7:** ZDR disables', '- **Grok 4.7:** Logs are mirrored to a cold archive. ZDR disables'),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a footnote that names no model', () => {
    expect(() =>
      parse(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **Mystery Model:** Data is retained for 7 days.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(/Mystery Model/)
  })

  test('on a table marker that no footnote qualifies', () => {
    expect(() =>
      parse(
        mutate(
          '| Hy3                        | Not used       | 0 days         |',
          String.raw`| Hy3 | Not used | 0 days\* |`,
        ),
      ),
    ).toThrow(/marker/i)
  })

  test('on an unknown marker character', () => {
    expect(() =>
      parse(
        mutate(
          '| Not used       | 0 days         |\n| Hy4 preview',
          '| Not used       | 0 days†        |\n| Hy4 preview',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a missing column', () => {
    expect(() =>
      parse(
        mutate(
          '| Model                      | Model training | Data retention |',
          '| Model                      | Model training |',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a row with the wrong cell count', () => {
    expect(() =>
      parse(mutate('| Hy3                        | Not used       | 0 days         |', '| Hy3 | Not used |')),
    ).toThrow(PrivacyTableError)
  })

  test('on zero rows', () => {
    const lines = mdx.split('\n')
    const start = lines.findIndex(l => l.startsWith('| Model                      | Model training'))
    const end = lines.findIndex((l, i) => i > start && !l.startsWith('|'))
    const without = [...lines.slice(0, start + 2), ...lines.slice(end)].join('\n')
    expect(() => parse(without)).toThrow(/no rows|zero rows/i)
  })

  test('on a missing Privacy section', () => {
    expect(() => parse(mutate('## Privacy', '## Something else'))).toThrow(PrivacyTableError)
  })

  test('on an unrecognized training value', () => {
    expect(() =>
      parse(
        mutate('| GLM-5.3                    | Not used       |', '| GLM-5.3                    | Maybe          |'),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on an unrecognized retention value', () => {
    expect(() =>
      parse(mutate('| Hy3                        | Not used       | 0 days         |', '| Hy3 | Not used | a while |')),
    ).toThrow(PrivacyTableError)
  })

  test('on a privacy row with no endpoint id', () => {
    expect(() =>
      parse(
        mutate(
          '| Hy3                        | hy3                        |',
          '| Hy3 Unlisted               | hy3                        |',
        ),
      ),
    ).toThrow(/Hy3/)
  })

  test('on a footnote that contradicts the table', () => {
    // Table says GLM-5.3 retains for 0 days; a footnote claiming 30 days must not be silently preferred.
    expect(() =>
      parse(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **GLM-5.3:** Requests are retained for 30 days.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(PrivacyTableError)
    // Table says Claude Haiku is not trained on; a training footnote contradicts it.
    expect(() =>
      parse(
        mutate(
          '- **DeepSeek:** ZDR agreement',
          '- **Claude Haiku 5.5:** Free in exchange for permission to use your prompts and completions to train models.\n- **DeepSeek:** ZDR agreement',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a missing restricted-models section, which carries the DeepSeek region rule', () => {
    expect(() => parse(mutate('### Enable restricted models', '### Something else'))).toThrow(PrivacyTableError)
  })

  test('on an unrecognized restricted-models rule', () => {
    expect(() =>
      parse(
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
    expect(() => parse(mutate(original, bullet))).toThrow(PrivacyTableError)
  })

  test('but not on prose inside the restricted-models section', () => {
    const intro = 'In **Settings › Privacy**, an owner or admin can enable:'
    expect(parse(mutate(intro, `${intro}\n\nEvery change takes effect at once.`))).toEqual(
      JSON.parse(readFixture('go.expected.json')),
    )
  })

  test('on an unrecognized parenthetical in the model list', () => {
    expect(() =>
      parse(
        mutate(
          '- **Iceman Contributor Free** (limited time)',
          '- **Iceman Contributor Free** (limited time, invite only)',
        ),
      ),
    ).toThrow(PrivacyTableError)
  })

  test('on a duplicate privacy row', () => {
    expect(() =>
      parse(mutate('| Hy3                        | Not used       | 0 days         |', '| Hy4 | Not used | 0 days |')),
    ).toThrow(/duplicate/i)
  })

  test('on a malformed source commit', () => {
    expect(() => parsePrivacyTable(mdx, 'dev')).toThrow(PrivacyTableError)
  })

  test('on an unparseable agreement date', () => {
    expect(() => parse(mutate('valid through November 30, 2026', 'valid through Smarch 40, 2026'))).toThrow(
      PrivacyTableError,
    )
  })
})

describe('parsePrivacyTable on region footnotes', () => {
  const HOSTING = 'Hosted in China.'
  const REGION = 'Requires **Global** regions in your workspace privacy settings.'
  const LONGCAT_FOOTNOTE = `- **LongCat 2.5 Free:** ${HOSTING} ${REGION}`
  const LONGCAT_RESTRICTED = '- **LongCat 2.5 Free:** select **Global** under **Regions**.\n'
  const LONGCAT_ROW = '| LongCat 2.5 Free           | Not used       | 0 days         |'
  const longcat = (source: string) => parse(source).models['longcat-2.5-free']

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
      zeroRetention: true,
      trainsOnData: false,
      regionGated: true,
      agreementExpiry: null,
    })
  })

  test('the region sentence alone gates its target', () => {
    expect(longcat(footnoteOnly(REGION))?.regionGated).toBe(true)
  })

  test('both sentences together gate their target', () => {
    expect(longcat(footnoteOnly(`${HOSTING} ${REGION}`))?.regionGated).toBe(true)
  })

  test('a hosting footnote with no restricted-models bullet is still region-gated', () => {
    const withoutBullet = mutate(LONGCAT_RESTRICTED, '')
    expect(withoutBullet).toContain(LONGCAT_FOOTNOTE)
    expect(longcat(withoutBullet)?.regionGated).toBe(true)
    // Control: without the bullet and without the region sentences, nothing gates LongCat.
    const ungated = withoutBullet.replace(LONGCAT_FOOTNOTE, () => '- **LongCat 2.5 Free:** ZDR disables training.')
    expect(longcat(ungated)?.regionGated).toBe(false)
  })

  test.each([
    ['the hosting sentence', HOSTING],
    ['the region sentence', REGION],
  ])('%s qualifies a retention marker', (_label, sentence) => {
    const marked = footnoteOnly(sentence).replace(
      LONGCAT_ROW,
      () => String.raw`| LongCat 2.5 Free | Not used | 0 days\* |`,
    )
    expect(marked).not.toBe(footnoteOnly(sentence))
    expect(longcat(marked)?.regionGated).toBe(true)
  })

  test('a hosting sentence names any place', () => {
    expect(longcat(footnoteOnly('Hosted in Singapore and Hong Kong.'))?.regionGated).toBe(true)
  })

  test('an unknown sentence next to them still throws the unmapped-sentence error', () => {
    const source = mdx.replace(LONGCAT_FOOTNOTE, () => `${LONGCAT_FOOTNOTE} Logs are mirrored to a cold archive.`)
    expect(source).not.toBe(mdx)
    expect(() => parse(source)).toThrow(PrivacyTableError)
    expect(() => parse(source)).toThrow(
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
    expect(() => parse(footnoteOnly(sentence))).toThrow(/unmapped footnote sentence/)
  })
})

describe('parsePrivacyTable on changed upstream content', () => {
  test('a row whose retention changes flips only that model', () => {
    const changed = parse(
      mutate('| GLM-5.3                    | Not used       | 0 days         |', '| GLM-5.3 | Not used | 30 days |'),
    )
    expect(changed.models['glm-5.3']?.zeroRetention).toBe(false)
    expect(changed.models['glm-5.2']?.zeroRetention).toBe(true)
  })
})
