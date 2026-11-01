import type {FetchLike, GitHubReadOptions} from './github-api'
import type {AppId, Observation, ObservationDetail} from './observation'
import {z} from 'zod'

import {notMeasured, observe} from './collect'
import {GITHUB_REPOSITORY, githubGetJson, hasToken} from './github-api'
import {APP_IDS} from './observation'

/**
 * Deploy state from the GitHub Deployments API: one environment per app, named after the app.
 *
 * Each app costs two calls: the newest deployment, then that deployment's newest status. The read never
 * walks history, so an `inactive` newest status is reported as such (see `mapDeploymentState`).
 *
 * `observedAt` is the read time. When the observed state began (the status `created_at`) is kept apart in
 * `detail.since`, so "waiting since" never looks like a fresh observation.
 */

export const DEPLOY_STATE_ID = 'deploy-state'
export const DEPLOY_STATE_CALLS_PER_APP = 2
/** Hard ceiling on GitHub API calls for one `readDeployStates`: 2 per app, 14 for 7 apps. */
export const DEPLOY_STATE_CALL_BUDGET = APP_IDS.length * DEPLOY_STATE_CALLS_PER_APP

const SPEC = {id: DEPLOY_STATE_ID, kind: 'deploy-state', source: 'github-api'} as const

const deploymentListSchema = z.array(z.object({id: z.number().int().positive()}))
const statusListSchema = z.array(z.object({state: z.string().min(1).max(32), created_at: z.iso.datetime()}))

export type DeployStateMapping = {result: 'pass' | 'fail'} | {result: 'unknown'; reason: string}

/**
 * Recorded against the live repo (see `__fixtures__/deployments-*.json`):
 * - A gate that is rejected or cancelled ends the sequence in `error` (cancelled run) or `failure` (failed
 *   run), after `waiting`. Both are `fail`.
 * - `inactive` appears only after a deployment is superseded by a later successful one (26 of 26 histories
 *   we could see were `inactive` after `success`), or alone on old deployments whose earlier statuses are
 *   gone. The newest deployment should never be superseded, so a newest status of `inactive` is
 *   anomalous and its real outcome is not recoverable without walking history: `unknown`, reason `inactive`.
 * - Anything unrecognized is `unknown`, never `pass`.
 */
export function mapDeploymentState(state: string): DeployStateMapping {
  switch (state) {
    case 'success':
      return {result: 'pass'}
    case 'failure':
    case 'error':
      return {result: 'fail'}
    case 'waiting':
      return {result: 'unknown', reason: 'at_gate'}
    case 'queued':
    case 'in_progress':
    case 'pending':
      return {result: 'unknown', reason: 'running'}
    case 'inactive':
      return {result: 'unknown', reason: 'inactive'}
    default:
      return {result: 'unknown', reason: 'unknown-state'}
  }
}

function apiError(now: Date): Observation {
  return observe(SPEC, 'unknown', {detail: {reason: 'api-error'}, now})
}

async function readAppDeployState(app: AppId, fetchFn: FetchLike, token: string, now: Date): Promise<Observation> {
  const deployments = await githubGetJson(
    fetchFn,
    token,
    `/repos/${GITHUB_REPOSITORY}/deployments?environment=${encodeURIComponent(app)}&per_page=1`,
    deploymentListSchema,
  )
  if (!deployments.ok) return apiError(now)

  const newest = deployments.data[0]
  if (newest === undefined) return notMeasured(SPEC, 'none')

  const statuses = await githubGetJson(
    fetchFn,
    token,
    `/repos/${GITHUB_REPOSITORY}/deployments/${newest.id}/statuses?per_page=1`,
    statusListSchema,
  )
  if (!statuses.ok) return apiError(now)

  const status = statuses.data[0]
  if (status === undefined) return observe(SPEC, 'unknown', {detail: {reason: 'no-status'}, now})

  const mapping = mapDeploymentState(status.state)
  const detail: ObservationDetail = {
    ...('reason' in mapping ? {reason: mapping.reason} : {}),
    since: status.created_at,
  }

  return observe(SPEC, mapping.result, {detail, now})
}

/**
 * One `deploy-state` observation per app. Without a token nothing is requested and every app is
 * `not_measured`. A failure for one app never affects another.
 */
export async function readDeployStates(options: GitHubReadOptions): Promise<Record<AppId, Observation>> {
  const now = options.now ?? new Date()
  const {token} = options
  if (!hasToken(token)) {
    return Object.fromEntries(APP_IDS.map(app => [app, notMeasured(SPEC, 'missing-config')])) as Record<
      AppId,
      Observation
    >
  }

  const fetchFn: FetchLike = options.fetch ?? fetch
  const entries = await Promise.all(
    APP_IDS.map(async app => [app, await readAppDeployState(app, fetchFn, token, now)] as const),
  )

  return Object.fromEntries(entries) as Record<AppId, Observation>
}
