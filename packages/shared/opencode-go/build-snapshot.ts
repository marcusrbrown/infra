import type {PrivacySnapshot} from './eligibility'
import type {LiveModel} from './live-models'
import type {DocsPrivacyRow} from './parse-privacy-table'

import {parseSnapshot, SNAPSHOT_SCHEMA_VERSION, SNAPSHOT_SOURCE_PATH, SNAPSHOT_SOURCE_REPO} from './eligibility'
import {PrivacyTableError} from './parse-privacy-table'

/**
 * Build the privacy snapshot from the two sources, with the most restrictive value winning:
 *
 * - the docs page (`console/go.mdx`) has retention days, the agreement expiry and the workspace Global rule;
 * - the live models list has `training`, `zdr` and `limited_regions` for every model.
 *
 * A model is cleared only when neither source objects. Anything the two sources cannot jointly account for throws
 * `PrivacyTableError`, so the refresh stops instead of writing a snapshot that reads "unknown" as "fine". Both
 * inputs are passed in; this module does no I/O.
 */

/**
 * Docs display names that do not normalize to the API's `name`, mapped to the API id they mean. Reviewed by hand:
 * add an entry only after checking that the two names are the same model. The docs page calls the model
 * "DeepSeek V4.1 Flash"; the API names it "DeepSeek V4.1 Flash 1017".
 */
export const DOCS_NAME_ALIASES: Readonly<Record<string, string>> = {
  'deepseek v4.1 flash': 'deepseek-v4.1-flash',
}

/** Case, whitespace and hyphen/space differences are not differences between names. Nothing else is. */
export const normalizeModelName = (name: string): string =>
  name.toLowerCase().replaceAll('-', ' ').replaceAll(/\s+/g, ' ').trim()

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

export interface BuiltSnapshot {
  snapshot: PrivacySnapshot
  disagreements: Disagreement[]
}

const yesNo = (value: boolean): 'yes' | 'no' => (value ? 'yes' : 'no')

const docsRetention = (row: DocsPrivacyRow): string =>
  row.retentionDays === null ? 'Not ZDR' : `${row.retentionDays} ${row.retentionDays === 1 ? 'day' : 'days'}`

/** The docs row each live model maps to; throws when any row or model is left without exactly one partner. */
function joinSources(
  docs: readonly DocsPrivacyRow[],
  live: readonly LiveModel[],
  aliases: Readonly<Record<string, string>>,
): Map<string, {row: DocsPrivacyRow; model: LiveModel}> {
  const liveByName = new Map<string, LiveModel[]>()
  const liveById = new Map<string, LiveModel>()
  for (const model of live) {
    const key = normalizeModelName(model.name)
    liveByName.set(key, [...(liveByName.get(key) ?? []), model])
    liveById.set(model.id, model)
  }

  const aliasById = new Map(Object.entries(aliases))
  const joined = new Map<string, {row: DocsPrivacyRow; model: LiveModel}>()
  const docsKeys = new Set<string>()
  for (const row of docs) {
    const key = normalizeModelName(row.name)
    if (docsKeys.has(key)) throw new PrivacyTableError(`join: duplicate Privacy row "${row.name}"`)
    docsKeys.add(key)

    const candidates = new Map<string, LiveModel>()
    for (const model of liveByName.get(key) ?? []) candidates.set(model.id, model)
    const aliasId = aliasById.get(key)
    const aliased = aliasId === undefined ? undefined : liveById.get(aliasId)
    if (aliased !== undefined) candidates.set(aliased.id, aliased)

    if (candidates.size === 0) {
      throw new PrivacyTableError(`join: Privacy row "${row.name}" matches no live model`)
    }
    if (candidates.size > 1) {
      throw new PrivacyTableError(
        `join: Privacy row "${row.name}" matches more than one live model (${[...candidates.keys()].sort().join(', ')})`,
      )
    }
    const [model] = candidates.values()
    if (model === undefined) throw new PrivacyTableError(`join: Privacy row "${row.name}" matches no live model`)
    const taken = joined.get(model.id)
    if (taken !== undefined) {
      throw new PrivacyTableError(
        `join: Privacy rows "${taken.row.name}" and "${row.name}" resolve to the same live model ${model.id}`,
      )
    }
    joined.set(model.id, {row, model})
  }

  for (const model of live) {
    if (!joined.has(model.id)) {
      throw new PrivacyTableError(
        `join: live model ${model.id} ("${model.name}") has no Privacy row, so it has no retention or agreement evidence`,
      )
    }
  }
  return joined
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

  const joined = joinSources(docs, live, aliases)
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
  return {snapshot, disagreements}
}
