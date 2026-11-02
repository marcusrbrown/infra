import {z} from 'zod'

/**
 * The public status history contract, shared by the CLI (writer) and the docs site (reader): the app ids,
 * the compact sample / meta / app-file schemas, and the observation-kind of each id the history can carry.
 * The CLI keeps the merge, invariants and disk I/O; the site keeps rendering. Neither copies a schema.
 */

export const HISTORY_SCHEMA_VERSION = 1 as const
export const HISTORY_WINDOW_DAYS = 90
export const HISTORY_WINDOW_MS = HISTORY_WINDOW_DAYS * 24 * 60 * 60_000

export const APP_IDS = ['keeweb', 'cliproxy', 'gateway', 'umami', 'dashboard', 'vpn', 'broker'] as const
export type AppId = (typeof APP_IDS)[number]

export const OBSERVATION_KINDS = ['reachability', 'container-health', 'deploy-state', 'end-to-end', 'resource'] as const
export type ObservationKind = (typeof OBSERVATION_KINDS)[number]

/** Most observations one sample can carry; the largest app declares four. */
const MAX_OBSERVATIONS_PER_SAMPLE = 32

const isoTimestampSchema = z.iso.datetime()

/**
 * The detail keys a public sample may carry. There is no free-text field, so raw response bodies, URLs and
 * error messages have nowhere to go. The CLI's full observation detail extends this with `durationMs`.
 */
export const sampleDetailSchema = z.strictObject({
  statusCode: z.number().int().min(100).max(599).optional(),
  contractVersion: z.string().min(1).max(64).optional(),
  /** When the observed state began (a deployment status `created_at`), e.g. "waiting since". */
  since: isoTimestampSchema.optional(),
  /** When the monitor's probe ran, as its probe line reports it. */
  probeAt: isoTimestampSchema.optional(),
  reason: z
    .string()
    .max(32)
    .regex(/^[a-z][a-z0-9_-]*$/)
    .optional(),
})
export type SampleDetail = z.infer<typeof sampleDetailSchema>

export const resultCodeSchema = z.enum(['p', 'f', 'u', 'n'])
export type ResultCode = z.infer<typeof resultCodeSchema>

const observationIdSchema = z
  .string()
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/)

export const historySampleSchema = z
  .strictObject({
    /** When the snapshot ran. */
    t: isoTimestampSchema,
    /** `GITHUB_RUN_ID`, or `local-<ISO time>` for a run outside Actions (bare `local` is the legacy form). */
    run: z.string().regex(/^(?:\d{1,20}|local(?:-\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z)?)$/),
    /** `GITHUB_RUN_ATTEMPT`. */
    att: z.number().int().min(1).max(10_000),
    r: z.record(observationIdSchema, resultCodeSchema),
    d: z.record(observationIdSchema, sampleDetailSchema).optional(),
  })
  .refine(sample => {
    const count = Object.keys(sample.r).length
    return count >= 1 && count <= MAX_OBSERVATIONS_PER_SAMPLE
  }, 'r must hold 1 to 32 results')
  .refine(sample => Object.keys(sample.d ?? {}).every(id => id in sample.r), 'd may only describe ids present in r')

export type HistorySample = z.infer<typeof historySampleSchema>

export const historyMetaSchema = z.strictObject({
  schemaVersion: z.literal(HISTORY_SCHEMA_VERSION),
  lastSampleAt: isoTimestampSchema,
})
export type HistoryMeta = z.infer<typeof historyMetaSchema>

export const historyAppFileSchema = z.array(historySampleSchema)

export interface History {
  meta: HistoryMeta
  apps: Record<AppId, HistorySample[]>
}

/**
 * The observation ids a sample can carry and the kind each proves. Mirrors the CLI's declared observations
 * (`DECLARED_OBSERVATIONS`); a CLI test fails if the two drift. The site labels results by kind only.
 */
export const OBSERVATION_KINDS_BY_ID: Record<AppId, Readonly<Record<string, ObservationKind>>> = {
  keeweb: {'public-reachability': 'reachability', 'deploy-state': 'deploy-state'},
  cliproxy: {
    'public-reachability': 'reachability',
    'container-running': 'container-health',
    'deploy-state': 'deploy-state',
    'provider-route': 'end-to-end',
  },
  gateway: {
    'public-reachability': 'reachability',
    'compose-services': 'container-health',
    'workspace-memory': 'resource',
    'deploy-state': 'deploy-state',
  },
  umami: {
    'public-reachability': 'reachability',
    'compose-services': 'container-health',
    'deploy-state': 'deploy-state',
  },
  dashboard: {
    'public-reachability': 'reachability',
    'compose-services': 'container-health',
    'deploy-state': 'deploy-state',
  },
  vpn: {
    'public-reachability': 'reachability',
    'wireguard-interface': 'container-health',
    'deploy-state': 'deploy-state',
    'egress-route': 'end-to-end',
  },
  broker: {'public-reachability': 'reachability', 'deploy-state': 'deploy-state'},
}
