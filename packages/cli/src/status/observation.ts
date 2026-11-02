import {APP_IDS, OBSERVATION_KINDS, sampleDetailSchema} from '@marcusrbrown/infra-shared/status/history-schema'
import {z} from 'zod'

export {APP_IDS, OBSERVATION_KINDS} from '@marcusrbrown/infra-shared/status/history-schema'
export type {AppId, ObservationKind} from '@marcusrbrown/infra-shared/status/history-schema'

/**
 * The typed status contract emitted by `status --json` (and read by the snapshot and the public site).
 *
 * The version is the literal integer 1 and readers reject anything else. The schemas are strict, so any
 * change to the shape bumps `schemaVersion`.
 *
 * Every observation says what it proves (`kind`), how it came out (`result`), when (`observedAt`) and
 * how it was measured (`source`). `unknown` means the check could not decide; `not_measured` means it
 * was never attempted (missing config, not applicable).
 */
export const STATUS_SCHEMA_VERSION = 1 as const

export const OBSERVATION_RESULTS = ['pass', 'fail', 'unknown', 'not_measured'] as const
export const OBSERVATION_SOURCES = ['http', 'ssh', 'github-api', 'monitor', 'config'] as const

export type ObservationResult = (typeof OBSERVATION_RESULTS)[number]
export type ObservationSource = (typeof OBSERVATION_SOURCES)[number]

const isoTimestampSchema = z.iso.datetime()

/**
 * Detail is deliberately a closed, bounded set of scalar keys: a status code, a duration, a contract
 * version, two ISO times (`since`, `probeAt`) and a short slug-shaped reason. There is no free-text field, so raw response bodies, URLs and
 * error messages have nowhere to go.
 */
export const observationDetailSchema = sampleDetailSchema.extend({
  durationMs: z.number().int().min(0).max(600_000).optional(),
})

const observationBaseShape = {
  id: z
    .string()
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  kind: z.enum(OBSERVATION_KINDS),
  source: z.enum(OBSERVATION_SOURCES),
  detail: observationDetailSchema.optional(),
}

/**
 * `observedAt` is null exactly when the result is `not_measured`. Modelling this as a union on `result`
 * makes the other three combinations unrepresentable.
 */
export const observationSchema = z.discriminatedUnion('result', [
  z.strictObject({
    ...observationBaseShape,
    result: z.enum(['pass', 'fail', 'unknown']),
    observedAt: isoTimestampSchema,
  }),
  z.strictObject({
    ...observationBaseShape,
    result: z.literal('not_measured'),
    observedAt: z.null(),
  }),
])

export type Observation = z.infer<typeof observationSchema>
export type ObservationDetail = z.infer<typeof observationDetailSchema>

export type JsonValue = string | number | boolean | null | JsonValue[] | {[key: string]: JsonValue}

/** `facts` carry non-check values (version, content hash, usage, the gateway workspace): any JSON. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
)

export const appStatusSchema = z
  .strictObject({
    app: z.enum(APP_IDS),
    observations: z.array(observationSchema),
    facts: z.record(z.string().max(64), jsonValueSchema),
  })
  .check(ctx => {
    const seen = new Set<string>()
    for (const [index, observation] of ctx.value.observations.entries()) {
      if (seen.has(observation.id)) {
        ctx.issues.push({
          code: 'custom',
          message: `Duplicate observation id "${observation.id}" for app "${ctx.value.app}"`,
          input: ctx.value,
          path: ['observations', index, 'id'],
        })
      }
      seen.add(observation.id)
    }
  })

export type AppStatus = z.infer<typeof appStatusSchema>

export const statusEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    generatedAt: isoTimestampSchema,
    apps: z.array(appStatusSchema),
  })
  .check(ctx => {
    const seen = new Set<string>()
    for (const [index, entry] of ctx.value.apps.entries()) {
      if (seen.has(entry.app)) {
        ctx.issues.push({
          code: 'custom',
          message: `Duplicate app entry "${entry.app}"`,
          input: ctx.value,
          path: ['apps', index, 'app'],
        })
      }
      seen.add(entry.app)
    }
  })

export type StatusEnvelope = z.infer<typeof statusEnvelopeSchema>
