import {z} from 'zod'

/**
 * The unauthenticated OpenCode Go models list: the machine-readable half of the privacy evidence. Every entry
 * carries a `go` object with three booleans (https://opencode.ai/docs/console/api/models):
 *
 * - `training`: whether the model trains on requests;
 * - `zdr`: whether it retains none of your data;
 * - `limited_regions`: whether some countries are refused it.
 *
 * Upstream documents that an entry can appear without `go` when its data source is unavailable. This parser never
 * reads that as "all false": a response that is missing, malformed or changed in shape throws `LiveModelsError`,
 * and the refresh stops with the snapshot untouched. Fields it does not read are ignored, so upstream can add
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

const goSchema = z.object({
  training: z.boolean(),
  zdr: z.boolean(),
  limited_regions: z.boolean(),
})

const entrySchema = z.object({
  id: z.string().regex(MODEL_ID_RE).max(MAX_ID_LENGTH),
  name: z.string().min(1),
  go: goSchema,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Field paths and issue codes only: zod messages can echo the rejected value. */
const describeIssues = (error: z.ZodError): string =>
  error.issues.map(issue => `${issue.path.join('.') || '(entry)'}: ${issue.code}`).join('; ')

/** Parse the models endpoint response body. Throws `LiveModelsError` on any deviation from the expected shape. */
export function parseLiveModels(payload: unknown): LiveModel[] {
  if (!isRecord(payload) || payload.object !== 'list' || !Array.isArray(payload.data)) {
    throw new LiveModelsError('live models response is not an object list with a data array')
  }
  if (payload.data.length === 0) throw new LiveModelsError('live models response lists no models')

  const seen = new Set<string>()
  const models: LiveModel[] = []
  for (const [index, item] of payload.data.entries()) {
    // The id is untrusted until it passes both checks, so it never reaches a message before then.
    const label =
      isRecord(item) && typeof item.id === 'string' && item.id.length <= MAX_ID_LENGTH && MODEL_ID_RE.test(item.id)
        ? item.id
        : `#${index}`
    if (isRecord(item) && !isRecord(item.go)) {
      throw new LiveModelsError(`live model ${label} has no go privacy object`)
    }
    const entry = entrySchema.safeParse(item)
    if (!entry.success) {
      throw new LiveModelsError(`live model ${label} is invalid: ${describeIssues(entry.error)}`)
    }
    const {id, name, go} = entry.data
    if (seen.has(id)) throw new LiveModelsError(`live models response has a duplicate id ${id}`)
    seen.add(id)
    models.push({id, name, training: go.training, zdr: go.zdr, limitedRegions: go.limited_regions})
  }
  return models
}
