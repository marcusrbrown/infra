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
 * It fails closed. A row, marker, footnote sentence, rule or column it cannot map throws `PrivacyTableError`, so a
 * format change upstream stops the refresh instead of marking a model safe by accident.
 */

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
  /** A footnote says availability is limited to permitted regions. The API's `limited_regions` states the same fact. */
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
): {table: Table; end: number} {
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
  return {table: {header, rows}, end}
}

/** The Privacy table rows, keyed by normalized display name in page order. */
function readRows(table: Table): Map<string, Row> {
  if (table.rows.length === 0) throw new PrivacyTableError('Privacy: table has no rows')

  const rows = new Map<string, Row>()
  for (const cells of table.rows) {
    const displayName = cells[0] ?? ''
    const key = normalizeName(displayName)
    if (key === '') throw new PrivacyTableError('Privacy: row with no model name')
    if (rows.has(key)) throw new PrivacyTableError(`Privacy: duplicate row "${displayName}"`)

    const retentionCell = cells[1] ?? ''
    const marked = /^(.*?)(\\\*|\*)$/.exec(retentionCell)
    const retention = (marked?.[1] ?? retentionCell).trim()
    const days = /^(\d+) days?$/.exec(retention)
    if (days === null && retention !== 'Not ZDR') {
      throw new PrivacyTableError(`Privacy: "${displayName}" has an unrecognized retention value "${retentionCell}"`)
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
 * Resolve a footnote label ("A / B", "A and B", "DeepSeek") to the rows it names. This reads only the page's own
 * labels; the page-to-API join in `build-snapshot.ts` never matches by prefix.
 */
function resolveLabel(label: string, accumulators: ReadonlyMap<string, Accumulator>): Accumulator[] {
  const resolved = new Map<string, Accumulator>()
  for (const part of normalizeName(label)
    .split('/')
    .flatMap(piece => piece.split(' and '))) {
    const token = normalizeName(part)
    const exact = accumulators.get(token)
    const matches =
      exact === undefined
        ? [...accumulators.entries()].filter(([name]) => name.startsWith(`${token} `) || name.endsWith(` ${token}`))
        : [[token, exact] as const]
    if (token === '' || matches.length === 0)
      throw new PrivacyTableError(`"${label}" does not name a model in the Privacy table`)
    for (const [name, accumulator] of matches) resolved.set(name, accumulator)
  }
  return [...resolved.values()]
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s/

/**
 * The `- **Label:** text` bullets of a section. `every-line` rejects any line that is not such a bullet;
 * `list-items` rejects only list items that are not, and lets prose between them pass.
 */
function bulletsOf(
  lines: readonly string[],
  label: string,
  unmatched: 'every-line' | 'list-items',
): {label: string; text: string}[] {
  const bullets: {label: string; text: string}[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^- \*\*([^*]+):\*\* (.+)$/.exec(line)
    if (match === null) {
      if (unmatched === 'every-line' || LIST_ITEM.test(line)) {
        throw new PrivacyTableError(`${label}: unmapped line "${line.trim().slice(0, 60)}"`)
      }
      continue
    }
    bullets.push({label: match[1] ?? '', text: match[2] ?? ''})
  }
  return bullets
}

function parseAgreementDate(raw: string): string {
  const match = /^([A-Z]+) (\d{1,2}), (\d{4})$/i.exec(raw)
  const month = match === null ? -1 : MONTHS.indexOf((match[1] ?? '').toLowerCase())
  if (match === null || month === -1) throw new PrivacyTableError(`unparseable agreement date "${raw}"`)
  const iso = `${match[3]}-${String(month + 1).padStart(2, '0')}-${(match[2] ?? '').padStart(2, '0')}`
  if (new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso) {
    throw new PrivacyTableError(`unparseable agreement date "${raw}"`)
  }
  return iso
}

/** Apply the Privacy footnotes. Every sentence must match a rule; a contradiction with the table throws. */
function applyFootnotes(lines: readonly string[], accumulators: ReadonlyMap<string, Accumulator>): void {
  for (const {label, text} of bulletsOf(lines, 'Privacy footnotes', 'every-line')) {
    const targets = resolveLabel(label, accumulators)
    const sentences = stripLinks(text)
      .split(/(?<=\.)\s+/)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence !== '' && sentence !== 'Learn more.')

    for (const sentence of sentences) {
      const retained = /retained for (?:up to )?(\d+) days/i.exec(sentence)
      const expiry = /valid through (.+?)\.?$/.exec(sentence)
      if (sentence.startsWith('ZDR disables ') || sentence === 'ZDR agreement is renewed monthly.') {
        // Informational: feature limits and renewal cadence change no field.
      } else if (retained !== null) {
        for (const target of targets) {
          if (target.row.retentionDays !== Number(retained[1])) {
            throw new PrivacyTableError(`"${label}": footnote retention contradicts the table for "${target.row.name}"`)
          }
        }
      } else if (/permission to use your prompts and completions/.test(sentence)) {
        for (const target of targets) target.trainingGranted = true
      } else if (sentence.startsWith('Availability is limited to regions permitted by ')) {
        for (const target of targets) target.availabilityLimited = true
      } else if (
        // Any stated hosting location is a region statement, and gating is the fail-closed direction.
        /^Hosted in \w.*\.$/.test(sentence) ||
        sentence === 'Requires **Global** regions in your workspace privacy settings.'
      ) {
        for (const target of targets) target.regionRequirement = true
      } else if (expiry !== null && sentence.startsWith('The current agreement is valid through ')) {
        const date = parseAgreementDate(expiry[1] ?? '')
        for (const target of targets) {
          if (target.agreementExpiry !== null && target.agreementExpiry !== date) {
            throw new PrivacyTableError(`"${label}": conflicting agreement dates for "${target.row.name}"`)
          }
          target.agreementExpiry = date
        }
      } else {
        throw new PrivacyTableError(`"${label}": unmapped footnote sentence "${sentence.slice(0, 80)}"`)
      }
    }
  }
}

/** The "Enable restricted models" bullets: the Global-region requirement, and which models opt in to training. */
function applyRestrictedModels(lines: readonly string[], accumulators: ReadonlyMap<string, Accumulator>): void {
  const bullets = bulletsOf(
    sectionLines(lines, '### Enable restricted models'),
    'Enable restricted models',
    'list-items',
  )
  if (bullets.length === 0) throw new PrivacyTableError('Enable restricted models: no bullets found')
  for (const {label, text} of bullets) {
    const targets = resolveLabel(label, accumulators)
    const rule = stripLinks(text).trim()
    if (rule === 'select **Global** under **Regions**.') {
      for (const target of targets) target.regionRequirement = true
    } else if (rule === 'turn on **Allow paid endpoints that train on request data**.') {
      // A model that needs this opt-in trains on requests; the page has no other training column any more.
      for (const target of targets) target.trainingGranted = true
    } else {
      throw new PrivacyTableError(`Enable restricted models: unmapped rule for "${label}"`)
    }
  }
}

/**
 * Parse `go.mdx` into one record per Privacy row, in page order. Throws `PrivacyTableError` on anything it
 * cannot map.
 */
export function parsePrivacyDocs(mdx: string): DocsPrivacyRow[] {
  const lines = mdx.split('\n')
  const privacy = sectionLines(lines, '## Privacy')
  const {table, end} = readTable(privacy, 'Privacy', PRIVACY_COLUMNS)

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

  applyRestrictedModels(lines, accumulators)
  applyFootnotes(privacy.slice(end), accumulators)

  return [...accumulators.values()].map(
    ({row, trainingGranted, regionRequirement, availabilityLimited, agreementExpiry}) => {
      // `*` is the zero-retention agreement marker; without its expiry footnote the agreement date is unknown.
      if (row.marker && agreementExpiry === null) {
        throw new PrivacyTableError(`Privacy: marker on "${row.name}" has no agreement footnote that qualifies it`)
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
