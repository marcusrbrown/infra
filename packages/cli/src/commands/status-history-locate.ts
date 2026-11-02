import type {goke} from 'goke'

import type {ActionCtx} from '../lib/action-ctx'
import type {FetchLike} from '../status/github-api'
import type {StatusDependencies} from './status'

import {appendFile} from 'node:fs/promises'
import {z} from 'zod'
import {GITHUB_REPOSITORY, githubGetJson, hasToken, resolveGithubToken} from '../status/github-api'

declare const process: {
  env: Record<string, string | undefined>
}

export const HISTORY_ARTIFACT_NAME = 'status-history'
export const SNAPSHOT_WORKFLOW_PATH = '.github/workflows/status-snapshot.yaml'
export const SNAPSHOT_WORKFLOW_FILE = 'status-snapshot.yaml'
/** At most this many candidate run lookups; past that the answer is an error, never `empty`. */
export const HISTORY_LOCATE_RUN_CHECK_BUDGET = 5
/** The list call, the candidate run lookups, and the one latest-successful-run call that guards against staleness. */
export const HISTORY_LOCATE_CALL_BUDGET = 1 + HISTORY_LOCATE_RUN_CHECK_BUDGET + 1
const LIST_PAGE_SIZE = 100
const WRITER_EVENTS: ReadonlySet<string> = new Set(['schedule', 'workflow_dispatch'])
const REPOSITORY_PATTERN = /^[\w.-]+\/[\w.-]+$/

const artifactsSchema = z.object({
  total_count: z.number().int().nonnegative(),
  artifacts: z.array(
    z.object({
      name: z.string(),
      expired: z.boolean(),
      created_at: z.iso.datetime({offset: true}),
      workflow_run: z.object({id: z.number().int().positive(), head_branch: z.string().nullable()}).nullable(),
    }),
  ),
})
const latestRunSchema = z.object({workflow_runs: z.array(z.object({id: z.number().int().positive()}))})
const runSchema = z.object({
  id: z.number().int().positive(),
  event: z.string(),
  head_branch: z.string().nullable(),
  path: z.string(),
})

export type LocateFailure =
  | 'api-error'
  | 'incomplete-listing'
  | 'invalid-repository'
  | 'missing-token'
  | 'run-check-budget-exceeded'
  | 'stale-artifact'

/** Three states: found, confirmed empty, or an error. An error is never reported as `empty`. */
export type LocateResult = {state: 'found'; runId: number} | {state: 'empty'} | {state: 'error'; reason: LocateFailure}

type Env = Record<string, string | undefined>

/**
 * Find the newest usable `status-history` artifact. Usable means: not expired, built on `main`, and produced by
 * a `schedule` or `workflow_dispatch` run of the snapshot workflow (the only writer). Newest first, the first
 * candidate whose run checks out wins.
 *
 * A found artifact must also come from the newest successful snapshot run on `main`. If a later successful run
 * produced no visible artifact (or the listing lags), the artifact is stale: appending to it would fork the
 * history, so the answer is an error and the workflow writes no sample.
 */
export async function locateHistory(fetchFn: FetchLike, token: string, repository: string): Promise<LocateResult> {
  const listed = await githubGetJson(
    fetchFn,
    token,
    `/repos/${repository}/actions/artifacts?name=${HISTORY_ARTIFACT_NAME}&per_page=${LIST_PAGE_SIZE}`,
    artifactsSchema,
  )
  if (!listed.ok) return {state: 'error', reason: 'api-error'}

  const candidates = listed.data.artifacts
    .filter(artifact => artifact.name === HISTORY_ARTIFACT_NAME && !artifact.expired)
    .flatMap(artifact =>
      artifact.workflow_run?.head_branch === 'main'
        ? [{createdAt: Date.parse(artifact.created_at), runId: artifact.workflow_run.id}]
        : [],
    )
    .toSorted((left, right) => right.createdAt - left.createdAt)

  let checked = 0
  for (const candidate of candidates) {
    if (checked >= HISTORY_LOCATE_RUN_CHECK_BUDGET) return {state: 'error', reason: 'run-check-budget-exceeded'}
    checked += 1

    const run = await githubGetJson(fetchFn, token, `/repos/${repository}/actions/runs/${candidate.runId}`, runSchema)
    if (!run.ok) return {state: 'error', reason: 'api-error'}

    const {data} = run
    if (
      data.id === candidate.runId &&
      data.head_branch === 'main' &&
      WRITER_EVENTS.has(data.event) &&
      data.path === SNAPSHOT_WORKFLOW_PATH
    ) {
      return confirmNewest(fetchFn, token, repository, candidate.runId)
    }
  }

  // A truncated listing cannot prove there is nothing further back.
  if (listed.data.total_count > listed.data.artifacts.length) return {state: 'error', reason: 'incomplete-listing'}
  return {state: 'empty'}
}

async function confirmNewest(
  fetchFn: FetchLike,
  token: string,
  repository: string,
  runId: number,
): Promise<LocateResult> {
  const latest = await githubGetJson(
    fetchFn,
    token,
    `/repos/${repository}/actions/workflows/${SNAPSHOT_WORKFLOW_FILE}/runs?branch=main&status=success&per_page=1`,
    latestRunSchema,
  )
  if (!latest.ok) return {state: 'error', reason: 'api-error'}
  return latest.data.workflow_runs[0]?.id === runId
    ? {state: 'found', runId}
    : {state: 'error', reason: 'stale-artifact'}
}

function outputLines(result: LocateResult & {state: 'found' | 'empty'}): string {
  return result.state === 'found' ? `state=found\nrun-id=${result.runId}\n` : 'state=empty\n'
}

export async function statusHistoryLocateAction(
  ctx: ActionCtx,
  deps: Pick<StatusDependencies, 'fetch'> = {},
  env: Env = process.env,
): Promise<void> {
  const fail = (reason: LocateFailure | 'output-file-error'): void => {
    ctx.console.error(`status history-locate failed: ${reason}`)
    ctx.process.exit(1)
  }

  const token = resolveGithubToken(env)
  if (!hasToken(token)) return fail('missing-token')

  const repository = env.GITHUB_REPOSITORY?.trim() || GITHUB_REPOSITORY
  if (!REPOSITORY_PATTERN.test(repository)) return fail('invalid-repository')

  const result = await locateHistory(deps.fetch ?? fetch, token, repository)
  if (result.state === 'error') return fail(result.reason)

  const outputPath = env.GITHUB_OUTPUT?.trim() ?? ''
  if (outputPath !== '') {
    try {
      await appendFile(outputPath, outputLines(result))
    } catch {
      return fail('output-file-error')
    }
  }

  ctx.console.log(result.state === 'found' ? `found run-id=${result.runId}` : 'empty')
}

export function registerStatusHistoryLocate(
  cli: ReturnType<typeof goke>,
  deps: Pick<StatusDependencies, 'fetch'>,
): void {
  cli
    .command(
      'status history-locate',
      'Find the newest usable status-history artifact for the snapshot workflow. Needs GITHUB_TOKEN or GH_TOKEN (read-only, actions: read) and reads GITHUB_REPOSITORY. Prints exactly "found run-id=<id>" or "empty" and exits 0; any API error, truncated listing, exhausted call budget or stale artifact (not from the newest successful snapshot run on main) exits non-zero, so an outage is never mistaken for an empty history. When GITHUB_OUTPUT is set it also appends state= and run-id= lines. CLI-only: not exposed over MCP.',
    )
    .example('# Locate the history artifact in CI')
    .example('infra status history-locate')
    .action((_options, ctx) => statusHistoryLocateAction(ctx, deps))
}
