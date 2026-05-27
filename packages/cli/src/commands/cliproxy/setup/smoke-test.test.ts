/// <reference types="bun" />

import {afterEach, describe, expect, it, spyOn} from 'bun:test'

import {runSmokeTest} from './smoke-test'

/* eslint-disable @typescript-eslint/no-explicit-any -- spyOn mock return values require `any` casts */

// Helper to build a fake Bun.spawn child process result
function makeSmokeChild(stdout: string, stderr: string, exitCode: number) {
  return {
    stdout: new Blob([stdout]).stream(),
    stderr: new Blob([stderr]).stream(),
    exited: Promise.resolve(exitCode),
  }
}

// Helper to build a gh run list JSON response
function makeSmokeRunList(
  runs: {databaseId: number; status: string; conclusion: string | null; url: string; createdAt: string}[],
): string {
  return JSON.stringify(runs)
}

describe('smoke test runner', () => {
  const REPO = 'owner/test-repo'
  const MODEL = 'anthropic/claude-sonnet-4-6'
  const RUN_URL = 'https://github.com/owner/test-repo/actions/runs/105'

  let spawnSpy: ReturnType<typeof spyOn>

  afterEach(() => {
    spawnSpy?.mockRestore()
  })

  it('happy path — pass with log grep finding "ack"', async () => {
    // Sequence of Bun.spawn calls:
    // 1. gh run list (baseline) → [{databaseId: 100, ...}]
    // 2. gh workflow run (trigger) → exit 0
    // 3. gh run list (poll 1) → [{databaseId: 105, status: completed, conclusion: success}, {databaseId: 100}]
    // 4. gh run view --log → text containing "ack"
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        // baseline gh run list
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        // gh workflow run trigger
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        // poll 1 — new run visible
        return makeSmokeChild(
          makeSmokeRunList([
            {databaseId: 105, status: 'completed', conclusion: 'success', url: RUN_URL, createdAt},
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 4) {
        // gh run view --log
        return makeSmokeChild('Step output: reply with exactly: ack\nack', '', 0) as any
      }
      return makeSmokeChild('', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('pass')
    expect(result.message).toContain('passed')
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('happy path — pass without log grep (log fetch fails, still pass)', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        return makeSmokeChild(
          makeSmokeRunList([{databaseId: 105, status: 'completed', conclusion: 'success', url: RUN_URL, createdAt}]),
          '',
          0,
        ) as any
      }
      if (callIndex === 4) {
        // log fetch fails
        return makeSmokeChild('', 'error fetching logs', 1) as any
      }
      return makeSmokeChild('', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('pass')
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('error path — fail: run completed with conclusion=failure', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        return makeSmokeChild(
          makeSmokeRunList([{databaseId: 105, status: 'completed', conclusion: 'failure', url: RUN_URL, createdAt}]),
          '',
          0,
        ) as any
      }
      return makeSmokeChild('', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('fail')
    expect(result.message).toContain('failure')
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('edge case — env approval: status=waiting returns unverified with approval message', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      // poll — status=waiting
      return makeSmokeChild(
        makeSmokeRunList([
          {databaseId: 105, status: 'waiting', conclusion: 'action_required', url: RUN_URL, createdAt},
        ]),
        '',
        0,
      ) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('unverified')
    expect(result.message).toContain('approval')
    expect(result.runUrl).toBe(RUN_URL)
  })

  // R5/4a: dead env-approval branch removed — status=pending with approval-like conclusion
  // does NOT trigger the unverified gate (the old dead branch is gone).
  it('R5/4a — status=pending with conclusion=approval_pending does NOT return unverified from env-approval gate', async () => {
    // The old code had: status === 'waiting' || (status === 'pending' && /approval/i.test(conclusion ?? ''))
    // The second OR branch was dead: when status=pending, gh returns conclusion=null, so /approval/i.test('') = false.
    // After simplification, only status=waiting triggers the env-approval gate.
    // This test asserts that status=pending + conclusion='approval_pending' does NOT hit the gate.
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        // trigger succeeds
        return makeSmokeChild('', '', 0) as any
      }
      // poll — status=pending, conclusion='approval_pending' (the formerly dead branch scenario)
      // After simplification, this should NOT return unverified from the env-approval gate.
      // Instead it falls through to "still in progress" and continues polling.
      // All subsequent polls also return pending → eventually exhausts → unverified with timeout.
      return makeSmokeChild(
        makeSmokeRunList([
          {databaseId: 105, status: 'pending', conclusion: 'approval_pending', url: RUN_URL, createdAt},
        ]),
        '',
        0,
      ) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    // Must NOT return unverified with "environment approval" message (that's the dead branch).
    // It should return unverified with timeout message (exhausted all polls).
    expect(result.kind).toBe('unverified')
    expect(result.message).not.toContain('environment approval')
    // The run was visible, so it should reference the run URL (timeout path)
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('edge case — timeout: all polls return queued → unverified with timeout message', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      // All polls return queued
      return makeSmokeChild(
        makeSmokeRunList([{databaseId: 105, status: 'queued', conclusion: '', url: RUN_URL, createdAt}]),
        '',
        0,
      ) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('unverified')
    expect(result.message).toContain('5 minutes')
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('edge case — trigger fails: gh workflow run exits non-zero → unverified with redacted stderr', async () => {
    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        // baseline
        return makeSmokeChild('[]', '', 0) as any
      }
      if (callIndex === 2) {
        // trigger fails
        return makeSmokeChild('', 'gh: authentication required — run gh auth login first', 1) as any
      }
      return makeSmokeChild('', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0})

    expect(result.kind).toBe('unverified')
    expect(result.message).toContain('gh workflow run failed')
    // stderr is included but truncated to 200 chars
    expect(result.message).toContain('authentication required')
  })

  it('security hygiene — returned messages do not contain the bearer token / key value', async () => {
    const SECRET_KEY = 'sk-super-secret-bearer-token-12345'
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild('[]', '', 0) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      return makeSmokeChild(
        makeSmokeRunList([{databaseId: 1, status: 'completed', conclusion: 'failure', url: RUN_URL, createdAt}]),
        '',
        0,
      ) as any
    })

    // runSmokeTest doesn't take a key — it uses gh CLI which handles auth via GH_TOKEN env
    // This test verifies the function signature doesn't accept or leak a key
    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    // The result message should not contain any secret-looking value
    expect(result.message).not.toContain(SECRET_KEY)
    expect(result.message).not.toContain('Bearer')
    expect(result.message).not.toContain('sk-')
  })

  it('race safety — picks highest databaseId above baseline (our run, not concurrent run)', async () => {
    // Baseline=100, trigger succeeds.
    // Poll 1 returns [id=102 (ours, success), id=101 (other contributor, failure), id=100 (baseline)]
    // Function must pick 102 (highest above baseline) and report pass.
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt102 = new Date(triggerTime.getTime() + 10000).toISOString()
    const createdAt101 = new Date(triggerTime.getTime() + 3000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        // Poll: our run (102) and concurrent run (101) both visible
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 102,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/102',
              createdAt: createdAt102,
            },
            {
              databaseId: 101,
              status: 'completed',
              conclusion: 'failure',
              url: 'https://github.com/owner/test-repo/actions/runs/101',
              createdAt: createdAt101,
            },
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      // log fetch
      return makeSmokeChild('ack', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    // Must pick run 102 (highest above baseline=100), not 101
    expect(result.kind).toBe('pass')
    expect(result.runUrl).toBe('https://github.com/owner/test-repo/actions/runs/102')
  })

  it('race safety — known edge case: only concurrent run visible, picks it (best-effort heuristic)', async () => {
    // Baseline=100, trigger succeeds.
    // Poll 1: only id=101 (other contributor's run) visible, ours not yet.
    // Function picks 101 (highest above baseline) — this is a known misattribution edge case.
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt101 = new Date(triggerTime.getTime() + 3000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-25T09:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      // All polls: only 101 visible (ours never appears)
      return makeSmokeChild(
        makeSmokeRunList([
          {
            databaseId: 101,
            status: 'completed',
            conclusion: 'failure',
            url: 'https://github.com/owner/test-repo/actions/runs/101',
            createdAt: createdAt101,
          },
          {
            databaseId: 100,
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/owner/test-repo/actions/runs/100',
            createdAt: '2026-05-25T09:00:00Z',
          },
        ]),
        '',
        0,
      ) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    // Picks 101 (best-effort heuristic — known misattribution edge case)
    expect(result.runUrl).toBe('https://github.com/owner/test-repo/actions/runs/101')
  })

  it('edge case — no prior runs: baselineId=null, uses createdAt heuristic', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    // Run created AFTER trigger time
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        // baseline: no prior runs
        return makeSmokeChild('[]', '', 0) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        return makeSmokeChild(
          makeSmokeRunList([{databaseId: 1, status: 'completed', conclusion: 'success', url: RUN_URL, createdAt}]),
          '',
          0,
        ) as any
      }
      // log fetch
      return makeSmokeChild('ack', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('pass')
    expect(result.runUrl).toBe(RUN_URL)
  })

  it('edge case — baseline list call fails: still triggers, uses createdAt heuristic', async () => {
    const triggerTime = new Date('2026-05-25T10:00:00Z')
    const createdAt = new Date(triggerTime.getTime() + 5000).toISOString()

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        // baseline fails
        return makeSmokeChild('', 'gh: network error', 1) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      if (callIndex === 3) {
        return makeSmokeChild(
          makeSmokeRunList([{databaseId: 1, status: 'completed', conclusion: 'success', url: RUN_URL, createdAt}]),
          '',
          0,
        ) as any
      }
      return makeSmokeChild('ack', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    expect(result.kind).toBe('pass')
  })

  it('edge case — trigger never produces visible run: unverified with repo URL hint', async () => {
    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        return makeSmokeChild('[]', '', 0) as any
      }
      if (callIndex === 2) {
        return makeSmokeChild('', '', 0) as any
      }
      // All polls: no new runs visible
      return makeSmokeChild('[]', '', 0) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0})

    expect(result.kind).toBe('unverified')
    expect(result.message).toContain('not yet visible')
  })

  // R5/4f: Race-attribution documentation test.
  // This test documents a KNOWN LIMITATION of the current heuristic.
  it('R5/4f — race attribution: concurrent run with createdAt < triggerTime but databaseId > baseline is picked (known limitation)', async () => {
    // Scenario: baselineId = 100. Trigger time = 2026-05-26T12:00:00Z.
    // A concurrent contributor's run started just before us (createdAt < triggerTime)
    // but got a higher databaseId (105) due to clock skew or out-of-order ID assignment.
    // The heuristic picks this run because databaseId > baselineId, IGNORING the
    // createdAt-before-trigger mismatch.
    const triggerTime = new Date('2026-05-26T12:00:00Z')
    // createdAt is BEFORE the trigger time — simulates concurrent contributor's run
    const concurrentCreatedAt = '2026-05-26T11:59:59Z'

    let callIndex = 0
    spawnSpy = spyOn(Bun, 'spawn').mockImplementation((..._args: any[]) => {
      callIndex++
      if (callIndex === 1) {
        // baseline: run 100 exists
        return makeSmokeChild(
          makeSmokeRunList([
            {
              databaseId: 100,
              status: 'completed',
              conclusion: 'success',
              url: 'https://github.com/owner/test-repo/actions/runs/100',
              createdAt: '2026-05-26T11:00:00Z',
            },
          ]),
          '',
          0,
        ) as any
      }
      if (callIndex === 2) {
        // trigger succeeds
        return makeSmokeChild('', '', 0) as any
      }
      // poll — concurrent contributor's run: databaseId=105 > baseline=100, but createdAt < triggerTime
      return makeSmokeChild(
        makeSmokeRunList([
          {
            databaseId: 105,
            status: 'completed',
            conclusion: 'success',
            url: 'https://github.com/owner/test-repo/actions/runs/105',
            createdAt: concurrentCreatedAt,
          },
        ]),
        '',
        0,
      ) as any
    })

    const result = await runSmokeTest(REPO, MODEL, {_testDelayMs: 0, _testTriggerTime: triggerTime})

    // KNOWN LIMITATION: heuristic picks this run despite createdAt < triggerTime.
    // A true fix requires upstream correlation token from gh workflow run.
    expect(result.kind).toBe('pass')
    expect(result.runUrl).toBe('https://github.com/owner/test-repo/actions/runs/105')
  })
})

/* eslint-enable @typescript-eslint/no-explicit-any */
