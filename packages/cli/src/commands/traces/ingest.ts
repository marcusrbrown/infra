import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'
import type {IngestState, RemoteDeps} from './remote'

import {z} from 'zod'

import {resolveTracesHost, resolveTracesOrigin, TRACES_GROUPS} from './host'
import {
  DEPLOY_FINISHED_SENTINEL,
  DEPLOY_UNFINISHED_SENTINEL,
  hasSentinel,
  ingestStateSentinel,
  LOCK_BUSY_SENTINEL,
  OPEN_REFUSED_SENTINEL,
  REMOTE_COMMANDS,
  runRemote,
  withRemoteSession,
} from './remote'
import {failingLines, getReporterDetail, isPassing} from './status'

declare const process: {
  env: Record<string, string | undefined>
}

// ─── What the public endpoint says ────────────────────────────────────────────
//
// Caddy decides each ingest path from its state file: off answers 404 (no route), held answers 503, and
// open proxies to the collector, which answers 401 to a request with no token. So an unauthenticated POST to
// each path says which state Caddy is really in, from outside the host. That observed answer, not the
// command's own exit status, is what these commands trust.

export type PathStatus = number | 'unreachable'

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>

export interface IngestDeps extends RemoteDeps {
  /** Reaches the public endpoint. The default is the global `fetch`. */
  fetch?: FetchLike
  sleep?: (ms: number) => Promise<void>
  /** Observations before giving up while Caddy restarts. */
  attempts?: number
  intervalMs?: number
}

const DEFAULT_ATTEMPTS = 15
const DEFAULT_INTERVAL_MS = 2000
const REQUEST_TIMEOUT_MS = 10_000

const EXPECTED_STATUS: Record<IngestState, number> = {off: 404, held: 503, open: 401}

/** An unauthenticated, empty-bodied POST to each group's ingest path. It carries no token and no trace. */
export async function probeIngestPaths(
  origin: string,
  fetchFn: FetchLike = (url, init) => fetch(url, init),
): Promise<Record<string, PathStatus>> {
  const entries = await Promise.all(
    TRACES_GROUPS.map(async group => {
      try {
        const response = await fetchFn(`${origin}/${group}/v1/traces`, {
          method: 'POST',
          headers: {'content-type': 'application/json'},
          body: '{}',
          redirect: 'manual',
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
        response.body?.cancel().catch(() => undefined)
        return [group, response.status] as const
      } catch {
        return [group, 'unreachable'] as const
      }
    }),
  )
  return Object.fromEntries(entries)
}

/** The state the statuses show, or `undefined` when they disagree or are not one of the three known answers. */
export function observedState(statuses: Record<string, PathStatus>): IngestState | undefined {
  const values = Object.values(statuses)
  return (Object.keys(EXPECTED_STATUS) as IngestState[]).find(state =>
    values.every(value => value === EXPECTED_STATUS[state]),
  )
}

function describeStatuses(statuses: Record<string, PathStatus>): string {
  return Object.entries(statuses)
    .map(([group, status]) => `${group} ${status}`)
    .join(', ')
}

async function waitForState(
  origin: string,
  state: IngestState,
  deps: IngestDeps,
): Promise<{proven: boolean; statuses: Record<string, PathStatus>}> {
  const attempts = deps.attempts ?? DEFAULT_ATTEMPTS
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms))
  let statuses: Record<string, PathStatus> = {}

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    statuses = await probeIngestPaths(origin, deps.fetch)
    if (observedState(statuses) === state) return {proven: true, statuses}
    if (attempt < attempts) await sleep(deps.intervalMs ?? DEFAULT_INTERVAL_MS)
  }
  return {proven: false, statuses}
}

// ─── Changing the state on the host ───────────────────────────────────────────

type SetResult =
  | {ok: true}
  /** Opening only: a deploy is running or did not finish. The host changed nothing. */
  | {ok: false; reason: 'deploy-unfinished'}
  /** The ingest lock was not free in 30 seconds. The host changed nothing. */
  | {ok: false; reason: 'lock-busy'}
  | {ok: false; reason: 'failed'; error: string}

function hasLine(stdout: string, line: string): boolean {
  return stdout.split('\n').some(entry => entry.trim() === line)
}

/**
 * Write the state into the host's `.env` and recreate only the Caddy container. The new state line travels
 * on stdin; the remote command is fixed. Success needs exit 0 and the sentinel the command prints last.
 *
 * The command runs under the ingest lock. Opening is refused, inside that same locked script, while a deploy
 * is running or did not finish; holding never is.
 */
async function setIngestState(host: string, state: 'held' | 'open', deps: IngestDeps): Promise<SetResult> {
  const result = await runRemote(host, REMOTE_COMMANDS.writeIngestState(state), {
    stdin: `TRACES_INGEST_STATE=${state}\n`,
    spawn: deps.spawn,
    session: deps.session,
  })

  if (hasSentinel(result, ingestStateSentinel(state))) return {ok: true}
  if (state === 'open' && result.exitCode === 0 && hasLine(result.stdout, OPEN_REFUSED_SENTINEL)) {
    return {ok: false, reason: 'deploy-unfinished'}
  }
  if (hasLine(result.stdout, LOCK_BUSY_SENTINEL)) return {ok: false, reason: 'lock-busy'}
  return {
    ok: false,
    reason: 'failed',
    error: `exit ${result.exitCode}: ${result.stderr || 'no confirmation from the host'}`,
  }
}

const LOCK_BUSY_MESSAGE =
  'another ingest change holds the host lock (a deploy, or another `traces ingest` command); it was not free within 30 seconds'

// ─── Actions ──────────────────────────────────────────────────────────────────

interface Targets {
  host: string
  origin: string
}

function resolveTargets(options: {key?: string | undefined}, ctx: ActionCtx): Targets | undefined {
  try {
    return {host: resolveTracesHost(process.env, options.key), origin: resolveTracesOrigin(process.env)}
  } catch (error) {
    ctx.console.error(error instanceof Error ? error.message : String(error))
    ctx.process.exit(1)
    return undefined
  }
}

/**
 * Each action below runs its host calls inside one `withRemoteSession` and exits only after it ends: the flows
 * return whether they succeeded, because `ctx.process.exit` ends the process and would skip closing the connection.
 */

/**
 * Hold the ingest route at once: every ingest path answers 503, which senders retry. It does not consult the
 * reporter. It says "held" only after an unauthenticated request from outside the host has been answered 503
 * on every ingest path.
 */
export async function tracesIngestHoldAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: IngestDeps = {},
): Promise<void> {
  const targets = resolveTargets(options, ctx)
  if (targets === undefined) return

  const ok = await withRemoteSession(deps.spawn, session => holdFlow(targets, ctx, {...deps, session}))
  if (!ok) ctx.process.exit(1)
}

async function holdFlow(targets: Targets, ctx: ActionCtx, deps: IngestDeps): Promise<boolean> {
  const set = await setIngestState(targets.host, 'held', deps)
  if (!set.ok) {
    // A hold is never refused for a deploy. Only the lock or the host command can stop it.
    const why =
      set.reason === 'lock-busy' ? LOCK_BUSY_MESSAGE : set.reason === 'failed' ? set.error : 'unexpected answer'
    ctx.console.error(`Could not set the ingest state on the host (${why}). Ingest may still be open.`)
    return false
  }

  const proof = await waitForState(targets.origin, 'held', deps)
  if (!proof.proven) {
    ctx.console.error(
      `Ingest hold NOT confirmed. The host state was set, but the public endpoint did not answer 503 on every ingest path (${describeStatuses(proof.statuses)}). Check Caddy with: infra traces logs caddy`,
    )
    return false
  }

  ctx.console.log(
    `Ingest is held: every ingest path answered 503 from outside the host (${describeStatuses(proof.statuses)}).`,
  )
  ctx.console.log(
    'Only a deploy, or `traces ingest open` with a passing health verdict and no unfinished deploy, reopens it.',
  )
  return true
}

/**
 * Open the ingest route. It refuses unless the health reporter's latest verdict is fresh and passing, and
 * says which checks are not. It also refuses while a deploy is running or did not finish: that check is made
 * on the host, inside the same locked script that writes the state, so a deploy that starts between the
 * verdict and the write cannot be undone. It says "open" only after an unauthenticated request from outside
 * has been answered 401 on every ingest path (routed to the collector, which wants a token).
 */
export async function tracesIngestOpenAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: IngestDeps = {},
): Promise<void> {
  const targets = resolveTargets(options, ctx)
  if (targets === undefined) return

  const ok = await withRemoteSession(deps.spawn, session => openFlow(targets, ctx, {...deps, session}))
  if (!ok) ctx.process.exit(1)
}

async function openFlow(targets: Targets, ctx: ActionCtx, deps: IngestDeps): Promise<boolean> {
  const detail = await getReporterDetail(targets.host, deps)
  if (!detail.ok) {
    ctx.console.error(
      `Refusing to open ingest: the health reporter could not be read (${detail.reason === 'ssh-failed' ? 'ssh or exec failed' : 'unreadable answer'}). Nothing was changed.`,
    )
    return false
  }
  if (!isPassing(detail.detail)) {
    ctx.console.error('Refusing to open ingest: the health verdict is not passing. Nothing was changed.')
    for (const line of failingLines(detail.detail, {scope: 'ingest'})) ctx.console.error(`  ${line}`)
    return false
  }

  const set = await setIngestState(targets.host, 'open', deps)
  if (!set.ok) {
    if (set.reason === 'deploy-unfinished') {
      ctx.console.error(
        'Refusing to open ingest: a deploy is running or did not finish (the deploy marker or its pending restarts exist on the host), so the services may have changed and not been verified. Nothing was changed. Run the deploy to completion with `infra traces deploy`; it opens ingest itself once every gate passes.',
      )
    } else if (set.reason === 'lock-busy') {
      ctx.console.error(`Could not open ingest: ${LOCK_BUSY_MESSAGE}. Nothing was changed. Try again.`)
    } else {
      ctx.console.error(`Could not set the ingest state on the host (${set.error}).`)
    }
    return false
  }

  const proof = await waitForState(targets.origin, 'open', deps)
  if (!proof.proven) {
    ctx.console.error(
      `Ingest open NOT confirmed. The host state was set, but the public endpoint did not answer 401 (token required) on every ingest path (${describeStatuses(proof.statuses)}). Run \`infra traces ingest hold\` if it should not be open.`,
    )
    return false
  }

  ctx.console.log(
    `Ingest is open: every ingest path reached the collector and asked for a token (${describeStatuses(proof.statuses)}).`,
  )
  return true
}

/** Report the configured state, the state seen from outside, and the health verdict. Changes nothing. */
export async function tracesIngestStatusAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  deps: IngestDeps = {},
): Promise<void> {
  const targets = resolveTargets(options, ctx)
  if (targets === undefined) return

  const ok = await withRemoteSession(deps.spawn, session => statusFlow(targets, ctx, {...deps, session}))
  if (!ok) ctx.process.exit(1)
}

async function statusFlow(targets: Targets, ctx: ActionCtx, deps: IngestDeps): Promise<boolean> {
  const [configured, deployState, statuses, detail] = await Promise.all([
    runRemote(targets.host, REMOTE_COMMANDS.readIngestState, deps),
    runRemote(targets.host, REMOTE_COMMANDS.readDeployState, deps),
    probeIngestPaths(targets.origin, deps.fetch),
    getReporterDetail(targets.host, deps),
  ])

  const match = /^TRACES_INGEST_STATE=(off|held|open)$/m.exec(configured.stdout)
  const configuredState = configured.exitCode === 0 ? match?.[1] : undefined
  const observed = observedState(statuses)

  ctx.console.log(`Configured on the host: ${configuredState ?? 'unknown'}`)
  ctx.console.log(`Seen from outside:      ${observed ?? 'unrecognised'} (${describeStatuses(statuses)})`)
  ctx.console.log(
    `Health verdict:         ${detail.ok ? (isPassing(detail.detail) ? 'passing' : 'not passing') : 'unreadable'}`,
  )
  if (hasSentinel(deployState, DEPLOY_UNFINISHED_SENTINEL)) {
    ctx.console.log(
      'Deploy:                 unfinished (a deploy is running or did not finish; run it to completion. `ingest open` is refused until it does)',
    )
  } else if (hasSentinel(deployState, DEPLOY_FINISHED_SENTINEL)) {
    ctx.console.log('Deploy:                 finished')
  } else {
    ctx.console.log('Deploy:                 unknown (the host did not answer)')
  }

  if (configuredState === undefined || observed === undefined || configuredState !== observed) {
    ctx.console.error('The configured state and the state seen from outside do not match, or one could not be read.')
    return false
  }
  return true
}

// ─── Command registration ─────────────────────────────────────────────────────

const keyOption = z
  .string()
  .optional()
  .describe('Environment variable name holding the SSH host. Falls back to TRACES_HOST, then traces.fro.bot.')

export function registerTracesIngest(cli: ReturnType<typeof goke>): void {
  cli
    .command(
      'traces ingest hold',
      'Emergency close: hold the ingest route (every ingest path answers 503) and prove it from outside the host.',
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesIngestHoldAction(options, ctx))

  cli
    .command(
      'traces ingest open',
      'Open the ingest route. Refuses unless the health reporter verdict is passing and no deploy is running or unfinished; proves the route is live from outside.',
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesIngestOpenAction(options, ctx))

  cli
    .command(
      'traces ingest status',
      'Show the configured ingest state, the state seen from outside the host, and the health verdict.',
    )
    .option('--key [key]', keyOption)
    .action((options, ctx) => tracesIngestStatusAction(options, ctx))
}
