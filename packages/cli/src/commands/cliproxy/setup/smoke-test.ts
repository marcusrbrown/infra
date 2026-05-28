/// <reference types="bun" />

import {z} from 'zod'

export type SmokeResult =
  | {kind: 'pass'; message: string; runUrl: string}
  | {kind: 'fail'; message: string; runUrl: string}
  | {kind: 'unverified'; message: string; runUrl?: string}

// Zod schemas for gh CLI JSON output — single source of truth.
const baselineRunSchema = z.array(z.object({databaseId: z.number()}))

const ghRunEntrySchema = z.object({
  databaseId: z.number(),
  status: z.string(),
  conclusion: z.string().nullable(),
  url: z.string(),
  createdAt: z.string(),
})

const pollRunListSchema = z.array(ghRunEntrySchema)

// Exported for tests only.
export type GhRunEntry = z.infer<typeof ghRunEntrySchema>

// Exported for tests only. Override poll delays and trigger time.
export interface SmokeTestInternals {
  /** Override per-poll delay in ms (default: real backoff schedule). */
  _testDelayMs?: number
  /** Override the trigger timestamp used for createdAt heuristic. */
  _testTriggerTime?: Date
}

/**
 * Run an optional post-mutation smoke test by triggering `fro-bot.yaml` and
 * polling for completion. Returns a non-blocking SmokeResult — never throws.
 *
 * Race-safe: captures the highest existing run ID before triggering, then
 * filters poll results to runs with databaseId > baselineId. When no prior
 * runs exist (baselineId=null), falls back to createdAt > triggerTime.
 *
 * Known edge case: if a concurrent contributor's run appears before ours,
 * we pick the highest databaseId above baseline — this may misattribute
 * the concurrent run as ours. This is the best heuristic available without
 * a run-specific correlation ID from `gh workflow run`.
 */
export async function runSmokeTest(
  repo: string,
  _model: string,
  internals: SmokeTestInternals = {},
): Promise<SmokeResult> {
  const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 60_000]
  const delayFn = async (ms: number): Promise<void> => {
    if (internals._testDelayMs !== undefined) {
      if (internals._testDelayMs > 0) {
        await new Promise(resolve => setTimeout(resolve, internals._testDelayMs))
      }
      return
    }
    await new Promise(resolve => setTimeout(resolve, ms))
  }

  const repoUrl = `https://github.com/${repo}`

  // ── Step 1: Capture baseline run ID ──────────────────────────────────────
  let baselineId: number | null = null
  try {
    const baselineChild = Bun.spawn(
      ['gh', 'run', 'list', '--workflow=fro-bot.yaml', '--repo', repo, '--limit', '1', '--json', 'databaseId'],
      {stdout: 'pipe', stderr: 'pipe', env: process.env},
    )
    const [baselineStdout, , baselineExit] = await Promise.all([
      new Response(baselineChild.stdout).text(),
      new Response(baselineChild.stderr).text(),
      baselineChild.exited,
    ])
    if (baselineExit === 0) {
      const parseResult = baselineRunSchema.safeParse(JSON.parse(baselineStdout))
      if (parseResult.success && parseResult.data.length > 0 && parseResult.data[0]) {
        baselineId = parseResult.data[0].databaseId
      }
      // If schema validation fails, baselineId stays null — we'll use createdAt heuristic
    }
    // If baseline call fails, baselineId stays null — we'll use createdAt heuristic
  } catch {
    // Network/parse error — continue with null baseline
  }

  // ── Step 2: Trigger the workflow ──────────────────────────────────────────
  const triggerTime = internals._testTriggerTime ?? new Date()

  const triggerChild = Bun.spawn(
    ['gh', 'workflow', 'run', 'fro-bot.yaml', '--repo', repo, '-f', 'prompt=reply with exactly: ack'],
    {stdout: 'pipe', stderr: 'pipe', env: process.env},
  )
  const [, triggerStderr, triggerExit] = await Promise.all([
    new Response(triggerChild.stdout).text(),
    new Response(triggerChild.stderr).text(),
    triggerChild.exited,
  ])

  if (triggerExit !== 0) {
    const redacted = triggerStderr.slice(0, 200)
    return {kind: 'unverified', message: `gh workflow run failed: ${redacted}`}
  }

  // ── Step 3: Poll for the new run ──────────────────────────────────────────
  let latestMatchedRun: GhRunEntry | undefined

  for (const BACKOFF_M of BACKOFF_MS) {
    await delayFn(BACKOFF_M ?? 60_000)

    let pollRuns: GhRunEntry[] = []
    try {
      const pollChild = Bun.spawn(
        [
          'gh',
          'run',
          'list',
          '--workflow=fro-bot.yaml',
          '--repo',
          repo,
          '--limit',
          '5',
          '--json',
          'databaseId,status,conclusion,url,createdAt',
        ],
        {stdout: 'pipe', stderr: 'pipe', env: process.env},
      )
      const [pollStdout, , pollExit] = await Promise.all([
        new Response(pollChild.stdout).text(),
        new Response(pollChild.stderr).text(),
        pollChild.exited,
      ])
      if (pollExit === 0) {
        const parseResult = pollRunListSchema.safeParse(JSON.parse(pollStdout))
        if (parseResult.success) {
          pollRuns = parseResult.data
        }
        // If schema validation fails, pollRuns stays [] — retry on next poll
      }
    } catch {
      // Parse/network error — retry on next poll
      continue
    }

    // Filter to runs triggered after our baseline
    const candidates = pollRuns.filter(run => {
      if (baselineId !== null) {
        return run.databaseId > baselineId
      }
      // No baseline: use createdAt heuristic
      return new Date(run.createdAt) > triggerTime
    })

    if (candidates.length === 0) {
      // Our run not visible yet — keep polling
      continue
    }

    // Pick the highest databaseId from candidates (most likely ours)
    const matched = candidates.reduce((best, run) => (run.databaseId > best.databaseId ? run : best))
    latestMatchedRun = matched

    const {status, conclusion, url: runUrl} = matched

    // Environment approval gate (simplified — the pending+approval branch was dead).
    // When status=pending, gh returns conclusion=null, so /approval/i.test('') = false.
    // Only status=waiting triggers the env-approval gate.
    if (status === 'waiting') {
      return {kind: 'unverified', message: `Workflow requires environment approval at ${runUrl}`, runUrl}
    }

    if (status === 'completed') {
      if (conclusion === 'success') {
        // Best-effort log grep for "ack"
        let logNote = ''
        try {
          const logChild = Bun.spawn(['gh', 'run', 'view', String(matched.databaseId), '--log', '--repo', repo], {
            stdout: 'pipe',
            stderr: 'pipe',
            env: process.env,
          })
          const [logStdout, , logExit] = await Promise.all([
            new Response(logChild.stdout).text(),
            new Response(logChild.stderr).text(),
            logChild.exited,
          ])
          if (logExit !== 0) {
            logNote = ' (log fetch failed, but run conclusion is success)'
          } else if (!/\back\b/i.test(logStdout)) {
            logNote = ' (log fetch succeeded but "ack" not found in output)'
          }
        } catch {
          logNote = ' (log fetch failed, but run conclusion is success)'
        }
        return {kind: 'pass', message: `Smoke test passed${logNote}`, runUrl}
      }

      return {kind: 'fail', message: `Run completed with conclusion=${conclusion ?? 'unknown'}`, runUrl}
    }

    // Still in progress (queued, in_progress, pending) — continue polling
  }

  // All polls exhausted
  if (latestMatchedRun) {
    return {
      kind: 'unverified',
      message: `Smoke test did not complete in 5 minutes; check ${latestMatchedRun.url}`,
      runUrl: latestMatchedRun.url,
    }
  }

  return {
    kind: 'unverified',
    message: `Smoke test trigger not yet visible; check ${repoUrl}/actions`,
  }
}
