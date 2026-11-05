import {z} from 'zod'

/**
 * OpenCode Go exposure policy: the reviewed privacy snapshot, the tracked settings, and the one pure eligibility
 * function the deploy, the monitor and the refresh script share. A model is eligible only when every check
 * passes; anything unknown, invalid or expired is excluded, never assumed safe.
 */

export const SNAPSHOT_SCHEMA_VERSION = 1 as const
export const SNAPSHOT_SOURCE_REPO = 'anomalyco/opencode'
export const SNAPSHOT_SOURCE_PATH = 'services/www/src/docs/content/console/go.mdx'

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(isRealIsoDate, {message: 'not a real calendar date'})

/** True for a `YYYY-MM-DD` string that names a real calendar day. */
function isRealIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
}

/** One model's privacy terms. Strict: an entry with an unknown or invalid field is excluded on its own. */
export const modelEntrySchema = z.strictObject({
  /** The table says "0 days". Any retention period, or "Not ZDR", is false. */
  zeroRetention: z.boolean(),
  /** Any "trains on data" / "may use data for training" flag is true. */
  trainsOnData: z.boolean(),
  /** The model needs a region the default workspace policy does not allow (for example Global). */
  regionGated: z.boolean(),
  /** Last UTC day the data agreement is valid, inclusive; null when the source gives no expiry. */
  agreementExpiry: isoDateSchema.nullable(),
})
export type ModelEntry = z.infer<typeof modelEntrySchema>

const snapshotSourceSchema = z.strictObject({
  repo: z.literal(SNAPSHOT_SOURCE_REPO),
  path: z.literal(SNAPSHOT_SOURCE_PATH),
  commit: z.string().regex(/^[0-9a-f]{40}$/),
})

/** The envelope is strict; entries are held as `unknown` here and parsed one by one in `parseSnapshot`. */
const snapshotEnvelopeSchema = z.strictObject({
  schemaVersion: z.literal(SNAPSHOT_SCHEMA_VERSION),
  source: snapshotSourceSchema,
  models: z.record(z.string().min(1).max(128), z.unknown()),
})

/** The snapshot file shape, as the parser writes it and `privacy-snapshot.json` stores it. */
export interface PrivacySnapshot {
  schemaVersion: typeof SNAPSHOT_SCHEMA_VERSION
  source: z.infer<typeof snapshotSourceSchema>
  models: Record<string, ModelEntry>
}

/** A snapshot after two-stage parsing: valid entries, plus the ids whose own entry failed validation. */
export interface ParsedSnapshot {
  source: PrivacySnapshot['source']
  models: Record<string, ModelEntry>
  /** Ids whose entries failed validation. Sorted; eligibility reports them as `invalid-entry`. */
  invalid: string[]
}

/**
 * Parse a snapshot in two stages. A top-level shape failure throws; an entry whose own fields are invalid is
 * recorded in `invalid` and the rest of the snapshot stays usable. Errors name fields, never values.
 */
export function parseSnapshot(raw: unknown): ParsedSnapshot {
  const envelope = snapshotEnvelopeSchema.safeParse(raw)
  if (!envelope.success) {
    throw new Error(`privacy snapshot has an invalid shape: ${describeIssues(envelope.error)}`)
  }
  const models: Record<string, ModelEntry> = {}
  const invalid: string[] = []
  for (const [id, value] of Object.entries(envelope.data.models)) {
    const entry = modelEntrySchema.safeParse(value)
    if (entry.success) models[id] = entry.data
    else invalid.push(id)
  }
  return {source: envelope.data.source, models, invalid: invalid.sort()}
}

export const settingsSchema = z.strictObject({
  enabled: z.boolean(),
  defaultProbeModel: z.string().min(1).optional(),
})
export type OpenCodeGoSettings = z.infer<typeof settingsSchema>

export function parseSettings(raw: unknown): OpenCodeGoSettings {
  const result = settingsSchema.safeParse(raw)
  if (!result.success) throw new Error(`opencode-go settings are invalid: ${describeIssues(result.error)}`)
  return result.data
}

export const EXCLUSION_REASONS = [
  'not-in-snapshot',
  'not-live',
  'trains-on-data',
  'not-zero-retention',
  'region-gated',
  'agreement-expired',
  'invalid-entry',
] as const
export type ExclusionReason = (typeof EXCLUSION_REASONS)[number]

export interface Exclusion {
  id: string
  reason: ExclusionReason
}

export interface EligibilityResult {
  /** Sorted ids that may be exposed. */
  eligible: string[]
  /** Every live or snapshot id that may not, sorted by id, once each with its first applicable reason. */
  excluded: Exclusion[]
}

/**
 * Decide which models may be exposed. `liveIds` is the unauthenticated Go model list and `todayUtc` is a
 * `YYYY-MM-DD` UTC date; an agreement expiring on `todayUtc` is still valid. Throws on a malformed date rather
 * than returning a partial answer.
 */
export function computeEligibility(
  snapshot: ParsedSnapshot,
  liveIds: readonly string[],
  todayUtc: string,
): EligibilityResult {
  if (!isRealIsoDate(todayUtc)) throw new Error('todayUtc must be a real YYYY-MM-DD date')

  const live = new Set(liveIds)
  const invalid = new Set(snapshot.invalid)
  const ids = [...new Set([...live, ...Object.keys(snapshot.models), ...invalid])].sort()

  const eligible: string[] = []
  const excluded: Exclusion[] = []
  for (const id of ids) {
    const reason = exclusionReason(snapshot, invalid, live, id, todayUtc)
    if (reason === undefined) eligible.push(id)
    else excluded.push({id, reason})
  }
  return {eligible, excluded}
}

function exclusionReason(
  snapshot: ParsedSnapshot,
  invalid: ReadonlySet<string>,
  live: ReadonlySet<string>,
  id: string,
  todayUtc: string,
): ExclusionReason | undefined {
  if (invalid.has(id)) return 'invalid-entry'
  const entry = snapshot.models[id]
  if (entry === undefined) return 'not-in-snapshot'
  if (!live.has(id)) return 'not-live'
  if (entry.trainsOnData) return 'trains-on-data'
  if (!entry.zeroRetention) return 'not-zero-retention'
  if (entry.regionGated) return 'region-gated'
  // ISO dates compare correctly as strings; the expiry day itself is still valid.
  if (entry.agreementExpiry !== null && entry.agreementExpiry < todayUtc) return 'agreement-expired'
  return undefined
}

/** Field paths and issue codes only: zod messages can echo the rejected value. */
function describeIssues(error: z.ZodError): string {
  return error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.code}`).join('; ')
}
