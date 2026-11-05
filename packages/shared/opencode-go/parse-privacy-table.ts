import type {PrivacySnapshot} from './eligibility'

import {parseSnapshot, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SOURCE_PATH, SNAPSHOT_SOURCE_REPO} from './eligibility'

/**
 * Parse the privacy terms out of anomalyco/opencode `console/go.mdx` into snapshot entries.
 *
 * The page spreads one model's terms across four places, and this parser joins them:
 *
 * - the Endpoints table maps a display name to the model id (the snapshot is keyed by id);
 * - the Privacy table gives training and retention, with `*` markers on some retention cells;
 * - the Privacy footnotes qualify models by name: retention periods, training permission, region limits and
 *   agreement expiry dates;
 * - the "Enable restricted models" bullets and the model list's "(limited regions)" notes give region
 *   requirements, which the Privacy section does not repeat.
 *
 * It fails closed. A row, marker, footnote sentence or rule it cannot map throws `PrivacyTableError`, so a
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

interface Row {
  name: string
  id: string
  trainsOnData: boolean
  /** Days from a "N days" cell; null for "Not ZDR". */
  retentionDays: number | null
  marker: boolean
}

interface Accumulator {
  row: Row
  regionGated: boolean
  agreementExpiry: string | null
  /** A footnote set retention, training, region or expiry for this model (what a `*` marker points at). */
  qualified: boolean
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/

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
const stripLinks = (text: string): string => text.replaceAll(/\[([^\]]*)\]\([^)]*\)/g, '$1')

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

/** The first pipe table in `lines`, and the index of the first line after it. */
function readTable(lines: readonly string[], label: string): {table: Table; end: number} {
  const start = lines.findIndex(line => line.trimStart().startsWith('|'))
  if (start === -1) throw new PrivacyTableError(`${label}: no table found`)
  const separator = lines[start + 1]
  if (separator === undefined || !/^\s*\|[\s:|-]+\|\s*$/.test(separator)) {
    throw new PrivacyTableError(`${label}: table has no separator row`)
  }
  const header = splitCells(lines[start] ?? '')
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

function columnIndex(table: Table, label: string, column: string): number {
  const index = table.header.findIndex(cell => normalizeName(cell) === column)
  if (index === -1) throw new PrivacyTableError(`${label}: missing column "${column}"`)
  return index
}

/** Display name -> model id, from the Endpoints table. */
function readEndpointIds(lines: readonly string[]): Map<string, string> {
  const {table} = readTable(sectionLines(lines, '## Endpoints'), 'Endpoints')
  const nameCol = columnIndex(table, 'Endpoints', 'model')
  const idCol = columnIndex(table, 'Endpoints', 'model id')
  const ids = new Map<string, string>()
  const seen = new Set<string>()
  for (const cells of table.rows) {
    const name = normalizeName(cells[nameCol] ?? '')
    const id = (cells[idCol] ?? '').trim()
    if (name === '' || !MODEL_ID_RE.test(id))
      throw new PrivacyTableError(`Endpoints: unreadable row "${cells[nameCol]}"`)
    if (ids.has(name) || seen.has(id)) throw new PrivacyTableError(`Endpoints: duplicate model "${cells[nameCol]}"`)
    ids.set(name, id)
    seen.add(id)
  }
  if (ids.size === 0) throw new PrivacyTableError('Endpoints: table has no rows')
  return ids
}

function readRows(table: Table, endpointIds: ReadonlyMap<string, string>): Map<string, Row> {
  const nameCol = columnIndex(table, 'Privacy', 'model')
  const trainingCol = columnIndex(table, 'Privacy', 'model training')
  const retentionCol = columnIndex(table, 'Privacy', 'data retention')
  if (table.rows.length === 0) throw new PrivacyTableError('Privacy: table has no rows')

  const rows = new Map<string, Row>()
  for (const cells of table.rows) {
    const displayName = cells[nameCol] ?? ''
    const key = normalizeName(displayName)
    if (rows.has(key)) throw new PrivacyTableError(`Privacy: duplicate row "${displayName}"`)
    const id = endpointIds.get(key)
    if (id === undefined)
      throw new PrivacyTableError(`Privacy: "${displayName}" has no model id in the Endpoints table`)

    const training = cells[trainingCol] ?? ''
    if (training !== 'Not used' && training !== 'Yes') {
      throw new PrivacyTableError(`Privacy: "${displayName}" has an unrecognized training value "${training}"`)
    }

    const retentionCell = cells[retentionCol] ?? ''
    const marked = /^(.*?)(\\\*|\*)$/.exec(retentionCell)
    const retention = (marked?.[1] ?? retentionCell).trim()
    const days = /^(\d+) days?$/.exec(retention)
    if (days === null && retention !== 'Not ZDR') {
      throw new PrivacyTableError(`Privacy: "${displayName}" has an unrecognized retention value "${retentionCell}"`)
    }
    rows.set(key, {
      name: displayName,
      id,
      trainsOnData: training === 'Yes',
      retentionDays: days === null ? null : Number(days[1]),
      marker: marked !== null,
    })
  }
  return rows
}

/** Resolve a footnote label ("A / B", "A and B", "DeepSeek") to the privacy rows it names. */
function resolveLabel(label: string, rows: ReadonlyMap<string, Row>): Row[] {
  const resolved = new Map<string, Row>()
  for (const part of label.split(/\s*\/\s*|\s+and\s+/)) {
    const token = normalizeName(part)
    const exact = rows.get(token)
    const matches =
      exact === undefined
        ? [...rows.entries()].filter(([name]) => name.startsWith(`${token} `) || name.endsWith(` ${token}`))
        : [[token, exact] as const]
    if (token === '' || matches.length === 0)
      throw new PrivacyTableError(`"${label}" does not name a model in the Privacy table`)
    for (const [name, row] of matches) resolved.set(name, row)
  }
  return [...resolved.values()]
}

function bulletsOf(lines: readonly string[], label: string, strict: boolean): {label: string; text: string}[] {
  const bullets: {label: string; text: string}[] = []
  for (const line of lines) {
    if (line.trim() === '') continue
    const match = /^- \*\*(.+?):\*\* (.+)$/.exec(line)
    if (match === null) {
      if (strict) throw new PrivacyTableError(`${label}: unmapped line "${line.trim().slice(0, 60)}"`)
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
function applyFootnotes(
  lines: readonly string[],
  rows: ReadonlyMap<string, Row>,
  accumulators: ReadonlyMap<string, Accumulator>,
): void {
  for (const {label, text} of bulletsOf(lines, 'Privacy footnotes', true)) {
    const targets = resolveLabel(label, rows).map(row => {
      const accumulator = accumulators.get(row.id)
      if (accumulator === undefined) throw new PrivacyTableError(`"${label}" has no accumulator`)
      return accumulator
    })
    const sentences = stripLinks(text)
      .split(/(?<=\.)\s+/)
      .map(sentence => sentence.trim())
      .filter(sentence => sentence !== '' && sentence !== 'Learn more.')

    for (const sentence of sentences) {
      const retained = /retained for (?:up to )?(\d+) days/i.exec(sentence)
      const expiry = /valid through (.+?)\.?$/.exec(sentence)
      if (sentence.startsWith('ZDR disables ') || sentence === 'ZDR agreement is renewed monthly.') {
        // Informational: feature limits and renewal cadence change no snapshot field.
      } else if (retained !== null) {
        for (const target of targets) {
          if (target.row.retentionDays !== Number(retained[1])) {
            throw new PrivacyTableError(`"${label}": footnote retention contradicts the table for "${target.row.name}"`)
          }
          target.qualified = true
        }
      } else if (/permission to use your prompts and completions/.test(sentence)) {
        for (const target of targets) {
          if (!target.row.trainsOnData) {
            throw new PrivacyTableError(
              `"${label}": footnote says training, the table says not used ("${target.row.name}")`,
            )
          }
          target.qualified = true
        }
      } else if (sentence.startsWith('Availability is limited to regions permitted by ')) {
        for (const target of targets) {
          target.regionGated = true
          target.qualified = true
        }
      } else if (expiry !== null && sentence.startsWith('The current agreement is valid through ')) {
        const date = parseAgreementDate(expiry[1] ?? '')
        for (const target of targets) {
          if (target.agreementExpiry !== null && target.agreementExpiry !== date) {
            throw new PrivacyTableError(`"${label}": conflicting agreement dates for "${target.row.name}"`)
          }
          target.agreementExpiry = date
          target.qualified = true
        }
      } else {
        throw new PrivacyTableError(`"${label}": unmapped footnote sentence "${sentence.slice(0, 80)}"`)
      }
    }
  }
}

/** The "Enable restricted models" bullets: the only place that names the Global-region requirement. */
function applyRestrictedModels(
  lines: readonly string[],
  rows: ReadonlyMap<string, Row>,
  accumulators: ReadonlyMap<string, Accumulator>,
): void {
  const bullets = bulletsOf(sectionLines(lines, '### Enable restricted models'), 'Enable restricted models', false)
  if (bullets.length === 0) throw new PrivacyTableError('Enable restricted models: no bullets found')
  for (const {label, text} of bullets) {
    const targets = resolveLabel(label, rows).map(row => accumulators.get(row.id))
    const rule = stripLinks(text).trim()
    if (rule === 'select **Global** under **Regions**.') {
      for (const target of targets) if (target !== undefined) target.regionGated = true
    } else if (rule === 'turn on **Allow paid endpoints that train on request data**.') {
      for (const target of targets) {
        if (target !== undefined && !target.row.trainsOnData) {
          throw new PrivacyTableError(`"${label}": opt-in to training contradicts the table for "${target.row.name}"`)
        }
      }
    } else {
      throw new PrivacyTableError(`Enable restricted models: unmapped rule for "${label}"`)
    }
  }
}

/** The model list: every name must match a privacy row, and "(limited regions)" marks a region requirement. */
function applyModelList(
  lines: readonly string[],
  rows: ReadonlyMap<string, Row>,
  accumulators: ReadonlyMap<string, Accumulator>,
): void {
  const intro = lines.findIndex(line => line.trim() === 'The current list of models includes:')
  if (intro === -1) throw new PrivacyTableError('model list not found')
  const listed = new Set<string>()
  let first = intro + 1
  while ((lines[first] ?? '').trim() === '' && first < lines.length) first++
  for (let index = first; index < lines.length && (lines[index] ?? '').startsWith('- '); index++) {
    const line = stripLinks(lines[index] ?? '')
    const match = /^- \*\*(.+?)\*\*(?: \((.*)\))?$/.exec(line)
    if (match === null) throw new PrivacyTableError(`model list: unmapped line "${line.slice(0, 60)}"`)
    const key = normalizeName(match[1] ?? '')
    const row = rows.get(key)
    const accumulator = row === undefined ? undefined : accumulators.get(row.id)
    if (row === undefined || accumulator === undefined) {
      throw new PrivacyTableError(`model list: "${match[1]}" is not in the Privacy table`)
    }
    if (listed.has(key)) throw new PrivacyTableError(`model list: duplicate "${match[1]}"`)
    listed.add(key)
    for (const note of (match[2] ?? '').split(',').map(part => part.trim().toLowerCase())) {
      if (note === '' || note === 'limited time') continue
      if (note === 'limited regions') accumulator.regionGated = true
      else throw new PrivacyTableError(`model list: unmapped note "${note}" on "${match[1]}"`)
    }
  }
  const missing = [...rows.keys()].filter(key => !listed.has(key))
  if (missing.length > 0) throw new PrivacyTableError(`model list is missing Privacy rows: ${missing.join(', ')}`)
}

/**
 * Parse `go.mdx` into the snapshot the deploy reads. `sourceCommit` is the anomalyco/opencode commit the text
 * came from. Throws `PrivacyTableError` on anything it cannot map.
 */
export function parsePrivacyTable(mdx: string, sourceCommit: string): PrivacySnapshot {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit))
    throw new PrivacyTableError('source commit must be 40 lowercase hex characters')

  const lines = mdx.split('\n')
  const endpointIds = readEndpointIds(lines)
  const privacy = sectionLines(lines, '## Privacy')
  const {table, end} = readTable(privacy, 'Privacy')
  const rows = readRows(table, endpointIds)

  const accumulators = new Map<string, Accumulator>()
  for (const row of rows.values()) {
    accumulators.set(row.id, {row, regionGated: false, agreementExpiry: null, qualified: false})
  }

  applyModelList(lines, rows, accumulators)
  applyRestrictedModels(lines, rows, accumulators)
  applyFootnotes(privacy.slice(end), rows, accumulators)

  for (const {row, qualified} of accumulators.values()) {
    if (row.marker && !qualified)
      throw new PrivacyTableError(`Privacy: marker on "${row.name}" has no footnote that qualifies it`)
  }

  const models: PrivacySnapshot['models'] = {}
  for (const {row, regionGated, agreementExpiry} of [...accumulators.values()].sort((a, b) =>
    a.row.id.localeCompare(b.row.id),
  )) {
    models[row.id] = {
      zeroRetention: row.retentionDays === 0,
      trainsOnData: row.trainsOnData,
      regionGated,
      agreementExpiry,
    }
  }

  const snapshot: PrivacySnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: {repo: SNAPSHOT_SOURCE_REPO, path: SNAPSHOT_SOURCE_PATH, commit: sourceCommit},
    models,
  }
  // Self-check: whatever this wrote must pass the same two-stage parse the deploy applies.
  if (parseSnapshot(snapshot).invalid.length > 0)
    throw new PrivacyTableError('parsed an entry that fails the snapshot schema')
  return snapshot
}
