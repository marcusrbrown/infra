import type {goke} from 'goke'

import type {ActionCtx} from '../lib/action-ctx'
import type {ProbeOutcome} from '../status/declared'
import type {RunIdentity} from '../status/history'
import type {AppId, Observation} from '../status/observation'
import type {StatusDependencies} from './status'

import {z} from 'zod'
import {assembleAppStatus, DECLARED_OBSERVATIONS} from '../status/declared'
import {resolveGithubToken} from '../status/github-api'
import {githubObservationsFor, runGithubReads} from '../status/github-reads'
import {
  compactSample,
  HistoryError,
  loadHistory,
  mergeHistory,
  recordByApp,
  serializeHistory,
  writeHistory,
} from '../status/history'
import {APP_IDS} from '../status/observation'

declare const process: {
  env: Record<string, string | undefined>
}

/** Only the public probes and the two GitHub readers: no SSH collectors, no deploy secrets. */
export type SnapshotDependencies = Pick<
  StatusDependencies,
  'publicProbes' | 'readDeployStates' | 'readMonitorState' | 'fetch' | 'now'
>

type Env = Record<string, string | undefined>

/**
 * `GITHUB_RUN_ID` and `GITHUB_RUN_ATTEMPT` identify a sample. A run outside Actions is `local-<ISO time>` attempt 1,
 * so separate local invocations never dedupe against each other.
 */
export function resolveRunIdentity(env: Env, now: Date): RunIdentity {
  const run = env.GITHUB_RUN_ID?.trim() ?? ''
  if (run === '') return {run: `local-${now.toISOString()}`, att: 1}

  const attempt = env.GITHUB_RUN_ATTEMPT?.trim() ?? ''
  if (!/^\d{1,20}$/.test(run) || (attempt !== '' && !/^\d{1,5}$/.test(attempt))) {
    throw new HistoryError('invalid-run')
  }

  return {run, att: attempt === '' ? 1 : Number(attempt)}
}

function resolveNow(value: string | undefined, clock: () => Date): Date {
  if (value === undefined) return clock()

  if (!z.iso.datetime().safeParse(value).success) throw new HistoryError('invalid-now')
  return new Date(value)
}

/** The observations this command owns: public probes plus the GitHub readers. */
const SNAPSHOT_IDS = recordByApp(
  app =>
    new Set(
      DECLARED_OBSERVATIONS[app]
        .filter(declared => declared.owner === 'probe' || declared.owner === 'github')
        .map(declared => declared.id),
    ),
)

async function runProbe(probe: ((options?: undefined) => Promise<Observation>) | undefined): Promise<ProbeOutcome> {
  if (probe === undefined) return {kind: 'none'}

  try {
    return {kind: 'ok', observation: await probe()}
  } catch {
    return {kind: 'failed'}
  }
}

async function collectObservations(
  deps: SnapshotDependencies,
  token: string | undefined,
  now: Date,
): Promise<Record<AppId, Observation[]>> {
  const reads = runGithubReads(deps, {token, now, ...(deps.fetch === undefined ? {} : {fetch: deps.fetch})})
  const probes = await Promise.all(APP_IDS.map(async app => [app, await runProbe(deps.publicProbes[app])] as const))
  const settled = await reads

  return recordByApp(app => {
    const probe = probes.find(([candidate]) => candidate === app)?.[1] ?? ({kind: 'none'} as const)
    const status = assembleAppStatus(app, probe, {kind: 'none'}, now, githubObservationsFor(app, settled, now))
    return status.observations.filter(observation => SNAPSHOT_IDS[app].has(observation.id))
  })
}

/** Failure text is a fixed category, never URLs, hosts, paths or underlying error text. */
function describeFailure(error: unknown): string {
  if (error instanceof HistoryError) return error.message
  if (error instanceof Error && 'code' in error && typeof error.code === 'string' && /^E[A-Z\d]+$/.test(error.code)) {
    return `filesystem error (${error.code})`
  }

  return 'unexpected error'
}

export async function statusSnapshotAction(
  options: {history: string; bootstrap?: boolean; now?: string},
  ctx: ActionCtx,
  deps: SnapshotDependencies,
  env: Env = process.env,
): Promise<void> {
  try {
    const now = resolveNow(options.now, deps.now)
    const identity = resolveRunIdentity(env, now)
    // Fail before any network call when the history is missing, already there, or unreadable.
    const previous = await loadHistory(options.history, options.bootstrap === true ? 'bootstrap' : 'existing')

    const observations = await collectObservations(deps, resolveGithubToken(env), now)
    const incoming = recordByApp(app => compactSample(observations[app], identity, now))
    const merged = mergeHistory({previous, incoming, now})

    // A rerun of the same run and attempt changes nothing, so it writes nothing.
    if (previous === undefined || merged.added > 0 || merged.trimmed > 0) {
      await writeHistory(options.history, merged.history)
    }

    ctx.console.log(`samples: ${APP_IDS.map(app => `${app}=${merged.history.apps[app].length}`).join(' ')}`)
    ctx.console.log(`added: ${merged.added}`)
    ctx.console.log(`trimmed: ${merged.trimmed}`)
    ctx.console.log(`bytes: ${serializeHistory(merged.history).bytes}`)
  } catch (error) {
    ctx.console.error(`status snapshot failed: ${describeFailure(error)}`)
    ctx.process.exit(1)
  }
}

export function registerStatusSnapshot(cli: ReturnType<typeof goke>, deps: SnapshotDependencies): void {
  cli
    .command(
      'status snapshot',
      'Take one public-safe status sample and merge it into the 90-day history directory. Runs only the public HTTPS probes, the GitHub Deployments reader and the auth monitor reader (GITHUB_TOKEN or GH_TOKEN, read-only); it uses no SSH and no deploy secrets. Stages every file as a temp file before renaming any into place; any invariant violation exits non-zero and writes nothing. Prints counts only. Exits 0 once the snapshot is written, even when observations are fail or unknown, because those are data. CLI-only: not exposed over MCP.',
    )
    .option(
      '--history <dir>',
      z
        .string()
        .min(1)
        .describe(
          'History directory holding meta.json and apps/<app>.json. It must already contain a valid history unless --bootstrap is given.',
        ),
    )
    .option(
      '--bootstrap',
      z
        .boolean()
        .describe(
          'Create the history and its first sample. Fails if meta.json or any app file already exists; without this flag a missing history fails.',
        ),
    )
    .option(
      '--now [iso]',
      z
        .string()
        .describe(
          'UTC ISO timestamp (for example 2026-11-01T12:00:00Z) to use as the sample time and the 90-day trim reference instead of the clock. Intended for tests and replays.',
        ),
    )
    .example('# Create the first history sample in an empty directory')
    .example('infra status snapshot --history ./status-history --bootstrap')
    .example('# Append a sample to an existing history')
    .example('infra status snapshot --history ./status-history')
    .action((options, ctx) => statusSnapshotAction(options, ctx, deps))
}
