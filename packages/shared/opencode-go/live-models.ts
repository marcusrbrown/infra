import {z} from 'zod'

/**
 * The unauthenticated OpenCode Go models list: the machine-readable half of the privacy evidence. Every entry
 * carries a `go` object with three booleans (https://opencode.ai/docs/console/api/models):
 *
 * - `training`: whether the model trains on requests;
 * - `zdr`: whether it retains none of your data;
 * - `limited_regions`: whether some countries are refused it.
 *
 * Upstream documents that when its model data is temporarily unavailable, items still appear with only OpenAI's
 * fields: no `go` object. That is ordinary upstream weather, so an entry with no `go` (absent or null) is set aside
 * in `noPrivacy`, never read as "all false", and the refresh leaves that model out instead of stopping for every
 * model. A response that is wrong as a whole still throws `LiveModelsError` and the refresh stops with the snapshot
 * untouched: a missing or changed envelope, a bad or duplicate id, a `go` that is present but not an object with
 * three booleans (the contract changed, so every entry is suspect), no entry with `go` at all, or more than half
 * the entries without it (a degraded list, not a gap). Fields it does not read are ignored, so upstream can add
 * fields without breaking the refresh.
 */

export const GO_LIVE_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*$/
const MAX_ID_LENGTH = 128

export class LiveModelsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LiveModelsError'
  }
}

/** One live model with the privacy facts the API states for it. */
export interface LiveModel {
  id: string
  /** The display name; the join to the docs page is by this name. */
  name: string
  training: boolean
  zdr: boolean
  limitedRegions: boolean
}

/** An entry with no `go` object: identified, but with no privacy evidence. */
export interface NoPrivacyModel {
  id: string
  name: string
}

export interface ParsedLiveModels {
  /** Entries with all three privacy booleans. */
  models: LiveModel[]
  /** Entries with no `go` object, in list order. They have no privacy facts and must not get an entry. */
  noPrivacy: NoPrivacyModel[]
}

const goSchema = z.object({
  training: z.boolean(),
  zdr: z.boolean(),
  limited_regions: z.boolean(),
})

const identitySchema = z.object({
  id: z.string().regex(MODEL_ID_RE).max(MAX_ID_LENGTH),
  name: z.string().min(1),
})
const entrySchema = identitySchema.extend({go: goSchema})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Field paths and issue codes only: zod messages can echo the rejected value. */
const describeIssues = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.join('.') || '(entry)'}: ${issue.code}`).join('; ')

/** Parse the models endpoint response body. Throws `LiveModelsError` on any deviation from the expected shape. */
export function parseLiveModels(payload: unknown): ParsedLiveModels {
  if (!isRecord(payload) || payload.object !== 'list' || !Array.isArray(payload.data)) {
    throw new LiveModelsError('live models response is not an object list with a data array')
  }
  if (payload.data.length === 0) throw new LiveModelsError('live models response lists no models')

  const seen = new Set<string>()
  const models: LiveModel[] = []
  const noPrivacy: NoPrivacyModel[] = []
  for (const [index, item] of payload.data.entries()) {
    // The id is untrusted until it passes both checks, so it never reaches a message before then.
    const label =
      isRecord(item) && typeof item.id === 'string' && item.id.length <= MAX_ID_LENGTH && MODEL_ID_RE.test(item.id)
        ? item.id
        : `#${index}`
    const hasNoGo = isRecord(item) && (item.go === undefined || item.go === null)
    if (isRecord(item) && !hasNoGo && !isRecord(item.go)) {
      throw new LiveModelsError(`live model ${label} has a go value that is not an object`)
    }
    const invalid = (error: z.ZodError): LiveModelsError =>
      new LiveModelsError(`live model ${label} is invalid: ${describeIssues(error)}`)
    const claim = (id: string): void => {
      if (seen.has(id)) throw new LiveModelsError(`live models response has a duplicate id ${id}`)
      seen.add(id)
    }
    if (hasNoGo) {
      const identity = identitySchema.safeParse(item)
      if (!identity.success) throw invalid(identity.error)
      claim(identity.data.id)
      noPrivacy.push(identity.data)
    } else {
      const entry = entrySchema.safeParse(item)
      if (!entry.success) throw invalid(entry.error)
      const {id, name, go} = entry.data
      claim(id)
      models.push({id, name, training: go.training, zdr: go.zdr, limitedRegions: go.limited_regions})
    }
  }
  if (models.length === 0) {
    throw new LiveModelsError('live models response is degraded: no entry has a go object')
  }
  if (noPrivacy.length * 2 > payload.data.length) {
    throw new LiveModelsError(
      `live models response is degraded: more than half of its ${payload.data.length} entries have no go object`,
    )
  }
  return {models, noPrivacy}
}
