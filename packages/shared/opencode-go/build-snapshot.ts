import type {PrivacySnapshot} from './eligibility'
import type {LiveModel} from './live-models'
import type {DocsPrivacyRow} from './parse-privacy-table'

import {parseSnapshot, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SOURCE_PATH, SNAPSHOT_SOURCE_REPO} from './eligibility'
import {DOCS_NAME_ALIASES, excerpt, normalizeModelName, quoted} from './model-names'
import {PrivacyTableError} from './parse-privacy-table'

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
  /** Which side lacks it: `docs` is a live model with no Privacy row, `api` is a Privacy row with no live model. */
  missing: 'docs' | 'api'
  /** The live model id; null for a Privacy row, which has none. */
  id: string | null
  name: string
}

/** One left-out model as a report line. The names come from public upstream text, so they are length-bounded. */
export const describeUnmatched = (item: Unmatched): string =>
  item.missing === 'docs'
    ? `live model \`${item.id ?? ''}\` ("${excerpt(item.name)}"): no Privacy row on the page`
    : `Privacy row "${excerpt(item.name)}": no live model`

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

/**
 * Pair each docs row with its live model. A row or model without a partner is reported, not paired; an ambiguous
 * pairing throws.
 */
function joinSources(
  docs: readonly DocsPrivacyRow[],
  live: readonly LiveModel[],
  aliases: Readonly<Record<string, string>>,
): Joined {
  const liveByName = new Map<string, LiveModel>()
  const liveById = new Map<string, LiveModel>()
  for (const model of live) {
    const key = normalizeModelName(model.name)
    const same = liveByName.get(key)
    if (same !== undefined) {
      throw new PrivacyTableError(
        `join: live models ${quoted(same.id)} and ${quoted(model.id)} have the same name after normalization`,
      )
    }
    liveByName.set(key, model)
    liveById.set(model.id, model)
  }

  const aliasById = new Map(Object.entries(aliases))
  const matched: Joined['matched'] = new Map()
  const unmatched: Unmatched[] = []
  const docsKeys = new Set<string>()
  for (const row of docs) {
    const key = normalizeModelName(row.name)
    if (docsKeys.has(key)) throw new PrivacyTableError(`join: duplicate Privacy row ${quoted(row.name)}`)
    docsKeys.add(key)

    const candidates = new Map<string, LiveModel>()
    const named = liveByName.get(key)
    if (named !== undefined) candidates.set(named.id, named)
    const aliasId = aliasById.get(key)
    const aliased = aliasId === undefined ? undefined : liveById.get(aliasId)
    if (aliased !== undefined) candidates.set(aliased.id, aliased)

    if (candidates.size > 1) {
      throw new PrivacyTableError(
        `join: Privacy row ${quoted(row.name)} matches more than one live model (${[...candidates.keys()].sort().join(', ')})`,
      )
    }
    const [model] = candidates.values()
    if (model === undefined) {
      unmatched.push({missing: 'api', id: null, name: row.name})
      continue
    }
    const taken = matched.get(model.id)
    if (taken !== undefined) {
      throw new PrivacyTableError(
        `join: Privacy rows ${quoted(taken.row.name)} and ${quoted(row.name)} resolve to the same live model ${quoted(model.id)}`,
      )
    }
    matched.set(model.id, {row, model})
  }

  for (const model of live) {
    if (!matched.has(model.id)) unmatched.push({missing: 'docs', id: model.id, name: model.name})
  }
  // A join that pairs nothing is a join that is wrong (a format change), not a quiet day.
  if (matched.size === 0) throw new PrivacyTableError('join: no docs row matches any live model')
  return {matched, unmatched}
}

/**
 * Join the docs rows to the live models and merge their facts. `sourceCommit` is the anomalyco/opencode commit the
 * page came from. `aliases` defaults to the reviewed {@link DOCS_NAME_ALIASES}.
 */
export function buildSnapshot(
  docs: readonly DocsPrivacyRow[],
  live: readonly LiveModel[],
  sourceCommit: string,
  aliases: Readonly<Record<string, string>> = DOCS_NAME_ALIASES,
): BuiltSnapshot {
  if (!/^[0-9a-f]{40}$/.test(sourceCommit)) {
    throw new PrivacyTableError('source commit must be 40 lowercase hex characters')
  }
  if (docs.length === 0) throw new PrivacyTableError('join: the docs page has no Privacy rows')
  if (live.length === 0) throw new PrivacyTableError('join: the live models list is empty')

  const {matched: joined, unmatched} = joinSources(docs, live, aliases)
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
