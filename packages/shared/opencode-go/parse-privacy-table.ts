/**
 * Parse the privacy terms out of anomalyco/opencode `console/go.mdx` into one record per Privacy table row.
 *
 * The page says nothing about model ids, so this parser does not produce a snapshot: `build-snapshot.ts` joins
 * these rows with the live models list, which is the other half of the evidence. What the page gives:
 *
 * - the Privacy table gives each model's retention, with `*` markers on some retention cells;
 * - the Privacy footnotes qualify models by name: retention periods, permission to train, region limits and
 *   agreement expiry dates;
 * - the "Enable restricted models" bullets give the workspace Global-region requirement and the training opt-in.
 *
 * It fails closed, and nothing it reads is discarded unaccounted for:
 *
 * - A row, marker, column, rule or footnote sentence it cannot map throws `PrivacyTableError`. A footnote sentence
 *   must match one known sentence form from the first character to the last; there is no "starts with" or "contains"
 *   branch, so a clause added to a known sentence is a new sentence and throws.
 * - A footnote label names a row by exact normalized name, a list of exact names, or a label in `LABEL_GROUPS`.
 *   Never by prefix or suffix.
 * - The per-model notices in the Usage limits section (`**Beam Free:** Free for a limited time. Not available in
 *   ...`) are read for the region limit only. Pricing sentences there churn weekly, so they are ignored; a sentence
 *   that looks like an availability or region statement must match the one known form or the refresh throws.
 * - Prose that names a Privacy model, in the restricted-models section or in front of the Privacy table, throws:
 *   a restriction written as prose is not read, so it must not pass silently. Known limit: prose that restricts
 *   models without naming one cannot be detected, and prose elsewhere on the page is not inspected.
 *
 * Every regex here is anchored and has no nested or overlapping quantifier, because it runs over public page text.
 */

import {DOCS_NAME_ALIASES, normalizeModelName, quoted} from './model-names'

export class PrivacyTableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PrivacyTableError'
  }
}

interface Table {
  header: string[]
  rows: string[][]
}

/** One model's terms as the page states them. A flag is false when the page says nothing, not when it denies. */
export interface DocsPrivacyRow {
  /** The display name in the Privacy table; the page has no model ids. */
  name: string
  /** Days from a "N days" cell; null for "Not ZDR". */
  retentionDays: number | null
  /** A footnote or the restricted-models opt-in says the model uses prompts and completions for training. */
  trainingGranted: boolean
  /**
   * The page requires a workspace region (Global) or names where the model is hosted. The API's `limited_regions`
   * means something else (countries refused), so the API is silent on this by design.
   */
  regionRequirement: boolean
  /**
   * The page says availability is limited to permitted regions: a footnote, or a usage-limits notice of the form
   * "Not available in <places>." The API's `limited_regions` states the same fact.
   */
  availabilityLimited: boolean
  /** Last UTC day the zero-retention agreement is valid, inclusive; null when the page gives none. */
  agreementExpiry: string | null
}

interface Row {
  name: string
  /** Days from a "N days" cell; null for "Not ZDR". */
  retentionDays: number | null
  marker: boolean
}

interface Accumulator {
  row: Row
  trainingGranted: boolean
  regionRequirement: boolean
  availabilityLimited: boolean
  agreementExpiry: string | null
}

const PRIVACY_COLUMNS: readonly string[] = ['model', 'data retention']

const MONTHS: readonly string[] = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
]

const normalizeName = (name: string): string => name.toLowerCase().replaceAll(/\s+/g, ' ').trim()

/** Reduce `[text](url)` to `text` so sentences read as prose. */
const stripLinks = (text: string): string => text.replaceAll(/\[([^[\]]*)\]\([^()]*\)/g, '$1')

const splitCells = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map(cell => cell.trim())

/** Lines of a section: from the heading line to the next heading at the same or a higher level. */
function sectionLines(lines: readonly string[], heading: string): string[] {
  const level = /^#+/.exec(heading)?.[0].length ?? 0
  const start = lines.findIndex(line => line.trim() === heading)
  if (start === -1) throw new PrivacyTableError(`section "${heading}" not found`)
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const next = /^(#+) /.exec(line)
    if (next !== null && (next[1]?.length ?? 0) <= level) break
    body.push(line)
  }
  return body
}

/**
 * The first pipe table in `lines`, and the index of the first line after it. The header must be exactly
 * `expectedHeader`: a column this parser does not read could carry a fact it would then drop.
 */
function readTable(
  lines: readonly string[],
  label: string,
  expectedHeader: readonly string[],
): {table: Table; start: number; end: number} {
  const start = lines.findIndex(line => line.trimStart().startsWith('|'))
  if (start === -1) throw new PrivacyTableError(`${label}: no table found`)
  const separator = lines[start + 1]
  if (separator === undefined || !/^\s*\|[\s:|-]+\|\s*$/.test(separator)) {
    throw new PrivacyTableError(`${label}: table has no separator row`)
  }
  const header = splitCells(lines[start] ?? '')
  if (header.length !== expectedHeader.length || header.some((cell, i) => normalizeName(cell) !== expectedHeader[i])) {
    throw new PrivacyTableError(`${label}: table has unexpected columns, expected ${expectedHeader.join(' | ')}`)
  }
  const rows: string[][] = []
  let end = start + 2
  while (end < lines.length && (lines[end] ?? '').trimStart().startsWith('|')) {
    const cells = splitCells(lines[end] ?? '')
    if (cells.length !== header.length) {
      throw new PrivacyTableError(
        `${label}: row ${rows.length + 1} has ${cells.length} cells, expected ${header.length}`,
      )
    }
    rows.push(cells)
    end++
  }
  return {table: {header, rows}, start, end}
}

/** The Privacy table rows, keyed by normalized display name in page order. */
function readRows(table: Table): Map<string, Row> {
  if (table.rows.length === 0) throw new PrivacyTableError('Privacy: table has no rows')

  const rows = new Map<string, Row>()
  for (const cells of table.rows) {
    const displayName = cells[0] ?? ''
    const key = normalizeName(displayName)
    if (key === '') throw new PrivacyTableError('Privacy: row with no model name')
    if (rows.has(key)) throw new PrivacyTableError(`Privacy: duplicate row ${quoted(displayName)}`)

    const retentionCell = cells[1] ?? ''
    const marked = /^(.*?)(\\\*|\*)$/.exec(retentionCell)
    const retention = (marked?.[1] ?? retentionCell).trim()
    const days = /^(\d+) days?$/.exec(retention)
    if (days === null && retention !== 'Not ZDR') {
      throw new PrivacyTableError(
        `Privacy: ${quoted(displayName)} has an unrecognized retention value ${quoted(retentionCell)}`,
      )
    }
    rows.set(key, {
      name: displayName,
      retentionDays: days === null ? null : Number(days[1]),
      marker: marked !== null,
    })
  }
  return rows
}

/**
 * Labels that name several rows without spelling each one as a full name, keyed by normalized label and mapped to
 * normalized row names. Reviewed by hand and as small as today's page needs; a target that is not a row throws.
 */
const LABEL_GROUPS: ReadonlyMap<string, readonly string[]> = new Map([
  // "- **DeepSeek:** ZDR agreement is renewed monthly. The current agreement is valid through ..." covers the family.
  ['deepseek', ['deepseek v4.1 flash', 'deepseek v4 pro']],
  // "- **DeepSeek V4.1 Flash and V4 Pro:** select **Global** ..." abbreviates the second model to "V4 Pro".
  ['deepseek v4.1 flash and v4 pro', ['deepseek v4.1 flash', 'deepseek v4 pro']],
])

/** One name or group label: an exact row, a reviewed group, or nothing. A name that is both is ambiguous. */
function resolveToken(token: string, accumulators: ReadonlyMap<string, Accumulator>): Accumulator[] | undefined {
  const exact = accumulators.get(token)
  const group = LABEL_GROUPS.get(token)
  if (exact !== undefined && group !== undefined) {
    throw new PrivacyTableError(`label ${quoted(token)} is ambiguous: a Privacy row and a reviewed label mapping`)
  }
  if (exact !== undefined) return [exact]
  if (group === undefined) return undefined
  return group.map(name => {
    const target = accumulators.get(name)
    if (target === undefined) {
      throw new PrivacyTableError(
        `reviewed label mapping ${quoted(token)} names ${quoted(name)}, which is no longer a Privacy row`,
      )
    }
    return target
  })
}

/**
 * Resolve a footnote or bullet label to the rows it names: the whole label as an exact name or reviewed group, or
 * each part of "A / B" and "A and B" as one. Anything else throws. This module never matches by prefix or suffix.
 */
function resolveLabel(label: string, accumulators: ReadonlyMap<string, Accumulator>): Accumulator[] {
  const whole = resolveToken(normalizeName(label), accumulators)
  if (whole !== undefined) return whole
  const resolved = new Set<Accumulator>()
  for (const part of normalizeName(label)
    .split('/')
    .flatMap(piece => piece.split(' and '))) {
    const token = normalizeName(part)
    const found = token === '' ? undefined : resolveToken(token, accumulators)
    if (found === undefined) {
      throw new PrivacyTableError(`${quoted(label)} does not name a model in the Privacy table`)
    }
    for (const target of found) resolved.add(target)
  }
  return [...resolved]
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/

/**
 * The `- **Label:** text` bullets of a section, and its prose. `every-line` rejects any line that is not such a
 * bullet; `list-items` rejects only list items that are not, and returns the other lines as prose for the caller
 * to inspect.
 */
function bulletsOf(
  lines: readonly string[],
  label: string,
  unmatched: 'every-line' | 'list-items',
): {bullets: {label: string; text: string}[]; prose: string[]} {
  const bullets: {label: string; text: string}[] = []
  const prose: string[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^- \*\*([^*]+):\*\* (.+)$/.exec(line)
    if (match === null) {
      if (unmatched === 'every-line' || LIST_ITEM.test(line)) {
        throw new PrivacyTableError(`${label}: unmapped line ${quoted(line.trim())}`)
      }
      prose.push(line)
      continue
    }
    bullets.push({label: match[1] ?? '', text: match[2] ?? ''})
  }
  return {bullets, prose}
}

const isWordChar = (char: string | undefined): boolean => char !== undefined && /[\da-z]/.test(char)

/** True when `name` occurs in `haystack` as whole words (both are already normalized). */
function mentions(haystack: string, name: string): boolean {
  if (name === '') return false
  for (let from = haystack.indexOf(name); from !== -1; from = haystack.indexOf(name, from + 1)) {
    if (!isWordChar(haystack[from - 1]) && !isWordChar(haystack[from + name.length])) return true
  }
  return false
}

/**
 * Throw when prose names a Privacy model, a reviewed label group or an alias. Prose restricts nothing the parser
 * reads, so a sentence like "Kimi K3 requires Global regions" would otherwise leave the model looking unrestricted.
 * Lines are joined first, so a name wrapped across lines is still found.
 */
function assertProseNamesNoModel(
  prose: readonly string[],
  where: string,
  accumulators: ReadonlyMap<string, Accumulator>,
): void {
  if (prose.length === 0) return
  const haystack = normalizeModelName(stripLinks(prose.join(' ')).replaceAll(/[*_`]/g, ''))
  const names: {shown: string; key: string}[] = [
    ...[...accumulators.values()].map(({row}) => ({shown: row.name, key: normalizeModelName(row.name)})),
    ...[...LABEL_GROUPS.keys()].map(label => ({shown: label, key: normalizeModelName(label)})),
    ...Object.entries(DOCS_NAME_ALIASES).flatMap(([name, id]) => [
      {shown: name, key: normalizeModelName(name)},
      {shown: id, key: normalizeModelName(id)},
    ]),
  ]
  for (const {shown, key} of names) {
    if (mentions(haystack, key)) {
      throw new PrivacyTableError(
        `${where}: prose names ${quoted(shown)}. Prose is not read as a restriction, so state it as a bullet in the form the section uses`,
      )
    }
  }
}

function parseAgreementDate(raw: string, label: string): string {
  const fail = (): PrivacyTableError =>
    new PrivacyTableError(`${quoted(label)}: unparseable agreement date ${quoted(raw)}`)
  const match = /^([A-Z]+) (\d{1,2}), (\d{4})$/i.exec(raw)
  const month = match === null ? -1 : MONTHS.indexOf((match[1] ?? '').toLowerCase())
  if (match === null || month === -1) throw fail()
  const year = Number(match[3])
  const day = Number(match[2])
  // Check the calendar before formatting: `toISOString()` throws a bare RangeError on an impossible date.
  const date = new Date(0)
  date.setUTCFullYear(year, month, day)
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) throw fail()
  return `${match[3]}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** A proper-noun phrase such as "Anthropic's Data Policies": capitalized words only, so no clause can hide in it. */
const NAME = String.raw`[A-Z][A-Za-z\d]*(?:['’]s)?(?: [A-Z][A-Za-z\d]*(?:['’]s)?)*`

/** Sentences that change no field. Exact text: reworded text is new text and throws. */
const INFORMATIONAL_SENTENCES: ReadonlySet<string> = new Set([
  'ZDR disables important API features that depend on stored data, including the stateful Responses API, Files and Collections, and the Batch API.',
  'ZDR agreement is renewed monthly.',
])
/** Sentences that say the model's prompts and completions are used for training. Exact text. */
const TRAINING_SENTENCES: ReadonlySet<string> = new Set([
  'Heavily discounted token pricing in exchange for permission to use your prompts and completions to train future Meta models.',
  'Free for a limited time in exchange for permission to use your prompts and completions to improve the model.',
])
const GLOBAL_REGION_SENTENCE = 'Requires **Global** regions in your workspace privacy settings.'

const RETAINED_ABUSE_SENTENCE =
  /^Abuse monitoring logs are generated for all API feature usage and retained for up to (\d+) days\.$/
const RETAINED_REQUESTS_SENTENCE = new RegExp(
  String.raw`^Requests are retained for (?:up to )?(\d+) days(?: for abuse monitoring)?(?: in accordance with ${NAME})?\.$`,
)
const AVAILABILITY_SENTENCE = new RegExp(String.raw`^Availability is limited to regions permitted by ${NAME}\.$`)
const HOSTED_SENTENCE = new RegExp(String.raw`^Hosted in ${NAME}(?: and ${NAME})?\.$`)
const EXPIRY_SENTENCE = /^The current agreement is valid through ([A-Z]+ \d{1,2}, \d{4})\.$/i

/**
 * Apply the Privacy footnotes. Each sentence must be wholly one known sentence form, or the refresh throws; a
 * contradiction with the table throws too.
 */
function applyFootnotes(lines: readonly string[], accumulators: ReadonlyMap<string, Accumulator>): void {
  for (const {label, text} of bulletsOf(lines, 'Privacy footnotes', 'every-line').bullets) {
    const targets = resolveLabel(label, accumulators)
    const sentences = stripLinks(text)
      .split(/(?<=\.)\s+/)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence !== '' && sentence !== 'Learn more.')

    for (const sentence of sentences) {
      const retained = RETAINED_ABUSE_SENTENCE.exec(sentence) ?? RETAINED_REQUESTS_SENTENCE.exec(sentence)
      const expiry = EXPIRY_SENTENCE.exec(sentence)
      if (INFORMATIONAL_SENTENCES.has(sentence)) {
        // Informational: feature limits and renewal cadence change no field.
      } else if (retained !== null) {
        for (const target of targets) {
          if (target.row.retentionDays !== Number(retained[1])) {
            throw new PrivacyTableError(
              `${quoted(label)}: footnote retention contradicts the table for ${quoted(target.row.name)}`,
            )
          }
        }
      } else if (TRAINING_SENTENCES.has(sentence)) {
        for (const target of targets) target.trainingGranted = true
      } else if (AVAILABILITY_SENTENCE.test(sentence)) {
        for (const target of targets) target.availabilityLimited = true
      } else if (HOSTED_SENTENCE.test(sentence) || sentence === GLOBAL_REGION_SENTENCE) {
        // Any stated hosting location is a region statement, and gating is the fail-closed direction.
        for (const target of targets) target.regionRequirement = true
      } else if (expiry === null) {
        throw new PrivacyTableError(`${quoted(label)}: unmapped footnote sentence ${quoted(sentence)}`)
      } else {
        const date = parseAgreementDate(expiry[1] ?? '', label)
        for (const target of targets) {
          if (target.agreementExpiry !== null && target.agreementExpiry !== date) {
            throw new PrivacyTableError(`${quoted(label)}: conflicting agreement dates for ${quoted(target.row.name)}`)
          }
          target.agreementExpiry = date
        }
      }
    }
  }
}

/** The "Enable restricted models" bullets: the Global-region requirement, and which models opt in to training. */
function applyRestrictedModels(lines: readonly string[], accumulators: ReadonlyMap<string, Accumulator>): void {
  const {bullets, prose} = bulletsOf(
    sectionLines(lines, '### Enable restricted models'),
    'Enable restricted models',
    'list-items',
  )
  if (bullets.length === 0) throw new PrivacyTableError('Enable restricted models: no bullets found')
  assertProseNamesNoModel(prose, 'Enable restricted models', accumulators)
  for (const {label, text} of bullets) {
    const targets = resolveLabel(label, accumulators)
    const rule = stripLinks(text).trim()
    if (rule === 'select **Global** under **Regions**.') {
      for (const target of targets) target.regionRequirement = true
    } else if (rule === 'turn on **Allow paid endpoints that train on request data**.') {
      // A model that needs this opt-in trains on requests; the page has no other training column any more.
      for (const target of targets) target.trainingGranted = true
    } else {
      throw new PrivacyTableError(`Enable restricted models: unmapped rule for ${quoted(label)}`)
    }
  }
}

/**
 * Words that make a usage-notice sentence an availability or region statement. A sentence with none of them is
 * pricing or limits and is ignored; a sentence with one must be the recognised form. Chosen by reading the page:
 * the neighbouring notices say "Free for a limited time", "The 50% discount applies through ..." and "Higher usage
 * limits apply through ...", none of which contain these.
 */
const AVAILABILITY_WORDS =
  /\b(?:not available|unavailable|available only|only available|availability|regions?|countr(?:y|ies)|restricted|limited to|blocked|refused|geograph\w*|territor(?:y|ies))\b/i
/** The one recognised form. A single character-class run, so the long place list cannot backtrack. */
const NOT_AVAILABLE_SENTENCE = /^Not available in ([A-Za-z ,()]+)\.$/
const PLACE_WORDS: ReadonlySet<string> = new Set(['the', 'of', 'and', 'or', 'including', 'regions'])
const NOTICE_START = /^\*\*([^*:]+):\*\* (.*)$/

/** A place list is proper nouns and a few connectives, so no clause (such as a training statement) can ride in it. */
const isPlaceList = (list: string): boolean =>
  list
    .split(/[\s,()]+/)
    .filter(word => word !== '')
    .every(word => /^[A-Z][A-Za-z]*$/.test(word) || PLACE_WORDS.has(word))

/** The `**Label:** text` paragraphs of a section; a paragraph runs to the next blank line or heading. */
function noticesOf(lines: readonly string[]): {label: string; text: string}[] {
  const notices: {label: string; text: string}[] = []
  let current: {label: string; parts: string[]} | undefined
  const flush = (): void => {
    if (current !== undefined) notices.push({label: current.label, text: current.parts.join(' ')})
    current = undefined
  }
  for (const line of lines) {
    const start = NOTICE_START.exec(line)
    if (line.trim() === '' || line.startsWith('#') || LIST_ITEM.test(line)) flush()
    else if (start === null) {
      current?.parts.push(line.trim())
    } else {
      flush()
      current = {label: start[1] ?? '', parts: [start[2] ?? '']}
    }
  }
  flush()
  return notices
}

/**
 * The per-model notices in the Usage limits section, read for one fact: "Not available in <places>." is the page's
 * statement of a model's region limit. Everything else in a notice is pricing and limits, which change weekly, so
 * full recognition is not required here: only a sentence that looks like an availability statement must match.
 * This is the only place on the page where unrecognised sentences are tolerated.
 */
function applyUsageNotices(lines: readonly string[], accumulators: ReadonlyMap<string, Accumulator>): void {
  for (const {label, text} of noticesOf(sectionLines(lines, '## Usage limits'))) {
    let limited = false
    const sentences = stripLinks(text)
      .split(/(?<=\.)\s+/)
      .map(sentence => sentence.trim())
    for (const sentence of sentences) {
      const places = NOT_AVAILABLE_SENTENCE.exec(sentence)?.[1]
      if (places !== undefined && isPlaceList(places)) limited = true
      else if (AVAILABILITY_WORDS.test(sentence)) {
        throw new PrivacyTableError(
          `usage notice for ${quoted(label)}: unrecognised availability sentence ${quoted(sentence)}`,
        )
      }
    }
    // A pricing-only notice never resolves its label, so a notice for a model with no Privacy row cannot block.
    if (limited) for (const target of resolveLabel(label, accumulators)) target.availabilityLimited = true
  }
}

/**
 * Parse `go.mdx` into one record per Privacy row, in page order. Throws `PrivacyTableError` on anything it
 * cannot map.
 */
export function parsePrivacyDocs(mdx: string): DocsPrivacyRow[] {
  const lines = mdx.split('\n')
  const privacy = sectionLines(lines, '## Privacy')
  const {table, start, end} = readTable(privacy, 'Privacy', PRIVACY_COLUMNS)

  const accumulators = new Map<string, Accumulator>()
  for (const [key, row] of readRows(table)) {
    accumulators.set(key, {
      row,
      trainingGranted: false,
      regionRequirement: false,
      availabilityLimited: false,
      agreementExpiry: null,
    })
  }

  // The lines in front of the table are not a footnote or a rule, so nothing else reads them.
  assertProseNamesNoModel(privacy.slice(0, start), 'Privacy', accumulators)
  applyRestrictedModels(lines, accumulators)
  applyFootnotes(privacy.slice(end), accumulators)
  applyUsageNotices(lines, accumulators)

  return [...accumulators.values()].map(
    ({row, trainingGranted, regionRequirement, availabilityLimited, agreementExpiry}) => {
      // `*` is the zero-retention agreement marker; without its expiry footnote the agreement date is unknown.
      if (row.marker && agreementExpiry === null) {
        throw new PrivacyTableError(
          `Privacy: marker on ${quoted(row.name)} has no agreement footnote that qualifies it`,
        )
      }
      return {
        name: row.name,
        retentionDays: row.retentionDays,
        trainingGranted,
        regionRequirement,
        availabilityLimited,
        agreementExpiry,
      }
    },
  )
}
