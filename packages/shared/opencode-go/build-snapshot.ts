import type {PrivacySnapshot} from './eligibility'
import type {LiveModel, NoPrivacyModel} from './live-models'
import type {DocsPrivacyRow, OrphanFootnote} from './parse-privacy-table'

import {parseSnapshot, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SOURCE_PATH, SNAPSHOT_SOURCE_REPO} from './eligibility'
import {DOCS_NAME_ALIASES, normalizeModelName, quoted, reportText} from './model-names'
import {notAModel, PrivacyTableError} from './parse-privacy-table'

export {DOCS_NAME_ALIASES, normalizeModelName}

/**
 * Build the privacy snapshot from the two sources, with the most restrictive value winning:
 *
 * - the docs page (`console/go.mdx`) has retention days, the agreement expiry and the workspace Global rule;
 * - the live models list has `training`, `zdr` and `limited_regions` for every model.
 *
 * A model is cleared only when neither source objects, and only a model both sources know gets an entry. A model
 * one source does not know is left out of the snapshot (so eligibility excludes it as `not-in-snapshot`) and
 * reported in `unmatched`: a new model reaching the API before the docs is ordinary, and a refresh that stopped
 * for it would leave every other restriction stale. A join that is itself wrong (one name fitting several models,
 * two rows resolving to one model) throws `PrivacyTableError`, so the refresh stops instead of guessing. Both
 * inputs are passed in; this module does no I/O.
 *
 * A Privacy footnote can name a model the page gave no row (`options.orphanFootnotes`). The parser cannot tell such a
 * model from a typo, because only the live list can, so the join does: a footnote label that exactly names a live
 * model with no row leaves that model out and reports it; any other such label throws. The footnote is never read
 * as evidence, so it can leave a model out and can never put one in.
 */

export type SnapshotFact = 'zeroRetention' | 'trainsOnData' | 'regionGated'

/**
 * Where the two sources differ on a fact. `conflict`: both state it and they disagree. `api-only`: the API
 * restricts the model and the page makes no statement about that fact. The snapshot holds the restrictive value
 * either way. Not reported: the docs-only Global rule and agreement expiry, which the API cannot state by design.
 */
export interface Disagreement {
  id: string
  name: string
  fact: SnapshotFact
  kind: 'conflict' | 'api-only'
  api: string
  docs: string
  /** The value written to the snapshot, as `yes` or `no`. */
  snapshot: 'yes' | 'no'
}

/** A model one source knows and the other does not. It has no snapshot entry. */
export interface Unmatched {
  /**
   * What is missing: `docs` is a live model with no Privacy row, `footnote` is such a model that a Privacy footnote
   * names (a footnote with no row), `api` is a Privacy row with no live model, and `privacy` is a live model
   * upstream published no `go` privacy fields for (whatever the page says about it).
   */
  missing: 'docs' | 'footnote' | 'api' | 'privacy'
  /** The live model id; null for a Privacy row, which has none. */
  id: string | null
  name: string
}

/** One left-out model as a report line. The names come from public upstream text, so they are sanitised. */
export function describeUnmatched(item: Unmatched): string {
  const live = `live model ${reportText(item.id ?? '')} named ${reportText(item.name)}`
  if (item.missing === 'privacy') {
    return `${live}: upstream published no privacy fields (\`go\`) for it, so it has no entry`
  }
  if (item.missing === 'footnote') return `${live}: footnote only, no Privacy row, so it has no entry`
  return item.missing === 'docs'
    ? `${live}: no Privacy row on the page`
    : `Privacy row ${reportText(item.name)}: no live model`
}

const FACT_LABELS: Readonly<Record<SnapshotFact, string>> = {
  zeroRetention: 'zero retention',
  trainsOnData: 'trains on data',
  regionGated: 'region-gated',
}

/** One disagreement as a report line, with the upstream-derived name sanitised. */
export const describeDisagreement = (d: Disagreement): string =>
  `${reportText(d.id)} (${reportText(d.name)}), ${FACT_LABELS[d.fact]}: API ${d.api}; docs: ${d.docs}; snapshot: ${d.snapshot}`

export interface BuiltSnapshot {
  snapshot: PrivacySnapshot
  disagreements: Disagreement[]
  /** Docs rows with no live model first, in page order, then live models with no docs row, in list order. */
  unmatched: Unmatched[]
}

const yesNo = (value: boolean): 'yes' | 'no' => (value ? 'yes' : 'no')

const docsRetention = (row: DocsPrivacyRow): string =>
  row.retentionDays === null ? 'Not ZDR' : `${row.retentionDays} ${row.retentionDays === 1 ? 'day' : 'days'}`

interface Joined {
  matched: Map<string, {row: DocsPrivacyRow; model: LiveModel}>
  unmatched: Unmatched[]
}

/** A live entry the join can see: `model` is null when upstream published no privacy fields for it. */
interface LiveRef {
  id: string
  name: string
  model: LiveModel | null
}

/**
 * Pair each docs row with its live model. A row or model without a partner is reported, not paired, and a live model
 * with no privacy fields is reported and never paired; an ambiguous pairing throws. Models with no privacy fields
 * take part in the name join so they cannot hide an ambiguity, and so their docs row is not misreported.
 *
 * An orphan footnote label is matched the way a row name is (by normalized name, or by the reviewed alias map) and
 * is accepted only when it names exactly one live model that no row claimed. A label for a claimed model is a
 * footnote the parser could not resolve to its row, so its terms would be lost: that throws, as does any label that
 * names no live model. An accepted label changes the report for its model (`footnote`), and nothing else.
 */
function joinSources(
  docs: readonly DocsPrivacyRow[],
  live: readonly LiveModel[],
  noPrivacy: readonly NoPrivacyModel[],
  aliases: Readonly<Record<string, string>>,
  orphanFootnotes: readonly OrphanFootnote[],
): Joined {
  const refs: LiveRef[] = [
    ...live.map(model => ({id: model.id, name: model.name, model})),
    ...noPrivacy.map(item => ({...item, model: null})),
  ]
  const refByName = new Map<string, LiveRef>()
  const refById = new Map<string, LiveRef>()
  for (const ref of refs) {
    const key = normalizeModelName(ref.name)
    const same = refByName.get(key)
    if (same !== undefined) {
      throw new PrivacyTableError(
        `join: live models ${quoted(same.id)} and ${quoted(ref.id)} have the same name after normalization`,
      )
    }
    refByName.set(key, ref)
    refById.set(ref.id, ref)
  }

  const aliasById = new Map(Object.entries(aliases))
  /** The live entries a normalized name stands for: the one that bears it, and the one a reviewed alias names. */
  const candidatesFor = (key: string): Map<string, LiveRef> => {
    const candidates = new Map<string, LiveRef>()
    const named = refByName.get(key)
    if (named !== undefined) candidates.set(named.id, named)
    const aliasId = aliasById.get(key)
    const aliased = aliasId === undefined ? undefined : refById.get(aliasId)
    if (aliased !== undefined) candidates.set(aliased.id, aliased)
    return candidates
  }
  const matched: Joined['matched'] = new Map()
  const claimed = new Map<string, string>()
  const unmatched: Unmatched[] = []
  const docsKeys = new Set<string>()
  for (const row of docs) {
    const key = normalizeModelName(row.name)
    if (docsKeys.has(key)) throw new PrivacyTableError(`join: duplicate Privacy row ${quoted(row.name)}`)
    docsKeys.add(key)

    const candidates = candidatesFor(key)
    if (candidates.size > 1) {
      throw new PrivacyTableError(
        `join: Privacy row ${quoted(row.name)} matches more than one live model (${[...candidates.keys()].sort().join(', ')})`,
      )
    }
    const [ref] = candidates.values()
    if (ref === undefined) {
      unmatched.push({missing: 'api', id: null, name: row.name})
      continue
    }
    const taken = claimed.get(ref.id)
    if (taken !== undefined) {
      throw new PrivacyTableError(
        `join: Privacy rows ${quoted(taken)} and ${quoted(row.name)} resolve to the same live model ${quoted(ref.id)}`,
      )
    }
    claimed.set(ref.id, row.name)
    // A model with no privacy fields has no evidence to pair with the row: it gets no entry (and is reported below).
    if (ref.model !== null) matched.set(ref.id, {row, model: ref.model})
  }

  const footnoted = new Set<string>()
  for (const {label} of orphanFootnotes) {
    const candidates = candidatesFor(normalizeModelName(label))
    const [ref] = candidates.values()
    if (candidates.size !== 1 || ref === undefined || claimed.has(ref.id)) throw new PrivacyTableError(notAModel(label))
    footnoted.add(ref.id)
  }

  for (const ref of refs) {
    if (ref.model === null) unmatched.push({missing: 'privacy', id: ref.id, name: ref.name})
  }
  for (const model of live) {
    if (!claimed.has(model.id)) {
      unmatched.push({missing: footnoted.has(model.id) ? 'footnote' : 'docs', id: model.id, name: model.name})
    }
  }
  // A join that pairs nothing is a join that is wrong (a format change), not a quiet day.
  if (matched.size === 0) throw new PrivacyTableError('join: no docs row matches any live model')
  return {matched, unmatched}
}

/**
 * Join the docs rows to the live models and merge their facts. `sourceCommit` is the anomalyco/opencode commit the
 * page came from. `options.aliases` defaults to the reviewed {@link DOCS_NAME_ALIASES}; `options.noPrivacy` is the live
 * entries that carry no privacy fields (from `parseLiveModels`), which get no entry; `options.orphanFootnotes` is the
 * footnotes the parser found for no row (from `parsePrivacyDocsWithOrphans`), each of which must name a live model.
 */
export function buildSnapshot(
  docs: readonly DocsPrivacyRow[],
  live: readonly LiveModel[],
  sourceCommit: string,
  options: {
    aliases?: Readonly<Record<string, string>>
    noPrivacy?: readonly NoPrivacyModel[]
    orphanFootnotes?: readonly OrphanFootnote[]
  } = {},
): BuiltSnapshot {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new PrivacyTableError('source commit must be 40 lowercase hex characters')
  }
  if (docs.length === 0) throw new PrivacyTableError('join: the docs page has no Privacy rows')
  if (live.length === 0) throw new PrivacyTableError('join: the live models list is empty')

  const {matched: joined, unmatched} = joinSources(
    docs,
    live,
    options.noPrivacy ?? [],
    options.aliases ?? DOCS_NAME_ALIASES,
    options.orphanFootnotes ?? [],
  )
  const models: PrivacySnapshot['models'] = {}
  const disagreements: Disagreement[] = []

  for (const [id, {row, model}] of [...joined.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const docsZeroRetention = row.retentionDays === 0
    const entry = {
      // Both sources must say so: a retention period on either side is a retention period.
      zeroRetention: model.zdr && docsZeroRetention,
      // Either source granting training use is enough.
      trainsOnData: model.training || row.trainingGranted,
      // Either source restricting the model's regions is enough.
      regionGated: model.limitedRegions || row.availabilityLimited || row.regionRequirement,
      agreementExpiry: row.agreementExpiry,
    }
    models[id] = entry

    const report = (fact: SnapshotFact, kind: Disagreement['kind'], api: string, docsText: string): void => {
      disagreements.push({id, name: row.name, fact, kind, api, docs: docsText, snapshot: yesNo(entry[fact])})
    }

    if (model.zdr !== docsZeroRetention) {
      report('zeroRetention', 'conflict', `zdr: ${model.zdr}`, docsRetention(row))
    }
    if (model.training !== row.trainingGranted) {
      if (row.trainingGranted) report('trainsOnData', 'conflict', 'training: false', 'grants training use')
      else report('trainsOnData', 'api-only', 'training: true', 'no training statement')
    }
    // `regionRequirement` is not compared: the API's `limited_regions` does not describe workspace regions.
    if (model.limitedRegions !== row.availabilityLimited) {
      if (row.availabilityLimited) {
        report('regionGated', 'conflict', 'limited_regions: false', 'availability limited to permitted regions')
      } else {
        report('regionGated', 'api-only', 'limited_regions: true', 'no availability statement')
      }
    }
  }

  const snapshot: PrivacySnapshot = {
    schemaVersion: SNAPSHOT_SCHEMA_VERSION,
    source: {repo: SNAPSHOT_SOURCE_REPO, path: SNAPSHOT_SOURCE_PATH, commit: sourceCommit},
    models,
  }
  // Self-check: whatever this wrote must pass the same two-stage parse the deploy applies.
  if (parseSnapshot(snapshot).invalid.length > 0) {
    throw new PrivacyTableError('built an entry that fails the snapshot schema')
  }
  return {snapshot, disagreements, unmatched}
}
