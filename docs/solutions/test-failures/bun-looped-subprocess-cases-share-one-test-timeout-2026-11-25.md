---
title: "Looped real-subprocess cases inside one Bun test share its 5 s timeout"
date: 2026-11-25
module: apps/dashboard
problem_type: test_failure
component: testing_framework
symptoms:
  - "A dashboard remote-deploy test times out at about 5000 ms, intermittently"
  - "The timeout also shows when the test file runs alone"
  - "Nothing in the code under test sleeps, polls or waits on a lock"
root_cause: async_timing
resolution_type: test_fix
severity: low
tags: [bun-test, timeout, flaky-test, subprocess, test-structure, dashboard]
---

# Looped real-subprocess cases inside one Bun test share its 5 s timeout

## Problem

A test that loops over independent cases, each running a real subprocess, gives all of them one Bun test timeout (5000 ms by default). Under CPU load their combined runtime goes past it.

## Symptoms

- Two tests in `apps/dashboard/src/remote-deploy.test.ts` that looped 4 and 6 real `bash` transactions inside one `it` failed with `timed out after 5000ms`.
- The failure also reproduced when the file ran alone.

## What Didn't Work

- Raising the timeout can reduce the flake, but keeps one shared budget that grows with the number of cases and with machine load.

## Solution

Give each case its own test, with an `it` inside the loop or `it.each`. The bodies and assertions stay the same, and no timeout is raised. See `apps/dashboard/src/remote-deploy.test.ts:3245-3248`:

```ts
  for (const identity of ['', 'abcdef123456\n0123456789abcdef', 'ABCDEF123456', 'abc123']) {
    it(`rejects empty, multiple, and malformed running dashboard container identities: ${JSON.stringify(identity)}`, async () => {
```

## Why This Works

Bun's timeout applies to each test. With one test per case, each subprocess run has its own budget, and a failure names its case.

## Prevention

- Before raising a timeout, check whether the test body runs several independent cases.
- A loop of in-process, stubbed cases inside one `it` is fine.
- Check a split under CPU load, for example with several busy-loop processes running.

## Related Issues

- #2077
