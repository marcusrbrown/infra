# Operator Surface Acceptance (Automated)

How an agent runs the operator surface acceptance checks with [agent-browser](https://github.com/vercel-labs/agent-browser). Run it after every paired gateway + dashboard operator-contract deploy, then post the results. [`operator-surface-acceptance.md`](operator-surface-acceptance.md) is the full manual checklist; this runbook references its check numbers and does not repeat what each check expects. `<expected>` means the contract version reported by `/operator/health`.

---

## Browser session

Every agent-browser command uses the same session:

```bash
agent-browser --session infra-operator-acceptance --restore --restore-save auto <command>
```

- Session state lives in `~/.agent-browser/sessions/`, outside the repo. Put no credentials in `.env` or in tracked files.
- `--allowed-domains` cannot be combined with `--restore`. Do not pass it. If the error keeps appearing after you drop the flag, the session daemon has cached it: run `agent-browser --session infra-operator-acceptance close`, then delete `~/.agent-browser/infra-operator-acceptance.config` and `.target`. The saved sign-in state in `sessions/` is kept.
- Never type credentials. Never print cookies, CSRF tokens, session IDs, or push endpoints. Keep them inside `eval` and report only non-secret fields.
- If the session lands on a GitHub login page, stop and ask the operator to sign in once in a headed window (see setup below).

### One-time setup

1. Run `agent-browser --session infra-operator-acceptance --restore --restore-save auto --headed open https://dashboard.fro.bot/operator/auth/github/start`.
2. The operator signs in to GitHub in that window. The browser returns to the dashboard signed in.
3. Close the headed browser. Later runs reuse the saved state headless.

### Session lifetime

The dashboard session lasts seven days. When it lapses, or after logout, opening `/operator/auth/github/start` signs back in without interaction as long as the GitHub cookie is still valid. When the GitHub cookie has also lapsed, the page lands on a GitHub login: stop and ask the operator.

### Tool notes

- `eval` does not allow top-level `await`. Wrap code in an async IIFE: `(async () => { … })()`. Pipe multi-line code with `eval --stdin`.
- Pass absolute paths to `screenshot`. A relative path resolves against the browser daemon's working directory, not your shell's.
- Refs (`@eN`) change after a reload. Re-run `snapshot -i` before using one.
- A run card expands and collapses on click, and a list refresh can reset it. Re-snapshot to confirm the card state before acting.
- Select the repository in the Launch panel before filling the prompt.
- Every command opens the browser if it is closed. Never poll or retry with `eval` in a loop; each iteration relaunches Chrome.
- Close the session when the pass ends.

---

## Launch budget

The gateway allows 3 launches per minute and 10 per hour per operator, in fixed windows. A refused launch shows "Too many launch requests" in the Launch panel (`429 rate limited`) and creates no run. A refusal can last until the hourly window ends, so retries do not help.

Run the [checks that launch nothing](#checks-that-launch-nothing) first, then spend the nine launches below, at least 20 seconds apart. The limit is keyed to the operator, so manual launches and earlier passes in the same hour count too. Launch against `fro-bot/agent`. One launch stays in reserve; do not retry a launch that created a run.

| Launch | Prompt | Covers |
| --- | --- | --- |
| L1 | Inert prompt: `Reply with only the word OK. <img src=x onerror=alert(1)> <b>bold tag</b> **markdown bold** [link](https://example.com)` | [5](operator-surface-acceptance.md#5-launch-and-stream), [6](operator-surface-acceptance.md#6-single-cancel-after-completion), [8](operator-surface-acceptance.md#8-checkout-details), [16 step 1](operator-surface-acceptance.md#16-launch-prompt) |
| L2 | 8,000-unit prompt | [16 step 2](operator-surface-acceptance.md#16-launch-prompt) |
| L3 | Approval trigger, press "Once" | [9](operator-surface-acceptance.md#9-tool-approval) steps 1, 2 |
| L4 | Approval trigger, press "Always" then "Confirm always" | [9](operator-surface-acceptance.md#9-tool-approval) step 5 |
| L5 | Approval trigger, press "Reject" | [9](operator-surface-acceptance.md#9-tool-approval) step 3; also shows a new run prompts again after "Always" |
| L6 | Question trigger, choose an option and "Submit answers" | [10](operator-surface-acceptance.md#10-agent-question) steps 1, 2 |
| L7 | Question trigger, press "Skip" | [10](operator-surface-acceptance.md#10-agent-question) step 3 |
| L8 | Question trigger, then cancel while the question is open | [7](operator-surface-acceptance.md#7-cancel-a-running-run), [10](operator-surface-acceptance.md#10-agent-question) step 5 |
| L9 | Background-subagent drain trigger | [17](operator-surface-acceptance.md#17-run-wait-reason) steps 1–5 |

- The approval, question and drain trigger prompts are in [check 9](operator-surface-acceptance.md#9-tool-approval), [check 10](operator-surface-acceptance.md#10-agent-question) and [check 17](operator-surface-acceptance.md#17-run-wait-reason).
- Generate the 8,000-unit and 8,001-unit prompt files with the one-liner in [check 16](operator-surface-acceptance.md#16-launch-prompt), then fill the field from the file: `fill @eN "$(cat /tmp/prompt-8000.txt)"`.
- While an approval (L3–L5) or question (L6, L7) is pending, collapse the card and wait about 20 seconds for the list refresh to cover the collapsed-badge steps ([9 step 4](operator-surface-acceptance.md#9-tool-approval), [10 step 7](operator-surface-acceptance.md#10-agent-question)). Expand it again before pressing a button.
- In L1, expand the card while the run is live for [check 8](operator-surface-acceptance.md#8-checkout-details). After it finishes, confirm the card has no Cancel control ([check 6](operator-surface-acceptance.md#6-single-cancel-after-completion)). For [check 16 step 1](operator-surface-acceptance.md#16-launch-prompt), hook `window.alert` with `eval` before expanding, then confirm that the `<img>` and `<b>` text is literal, `<strong>` wraps "markdown bold", the link shows its host, and no alert fired.
- Cancel asks for confirmation: press "Cancel run", then "Confirm cancel".

### L9 wait reason

Run L9 after L8 has finished, and launch nothing else until L9 ends. The reason is not on the wire for the first 85–90 seconds after launch. Then `awaiting-background-task` lasts about 40 seconds and `confirming-completion` about 15, so the window is roughly 55 seconds. Steps 1–4 must fit inside it: have every command ready before you launch, and do not spend the window on setup.

Timing procedure:

- Commands in one session run one at a time. An `eval` that waits blocks every later command, so record frames with a non-blocking observer: right after pressing Launch, run one `eval` that finds the new run, starts a stream reader that stores each `status` frame with a timestamp on `window.__obs`, and returns at once. The run can take a few seconds to appear, so the snippet retries for up to 10 seconds. Define `launchedAt` inline as the time just before the press, and take it from the shell clock truncated to whole seconds. Read `window.__obs` later with a single `eval`. Do not reload before step 5, because a reload discards the observer.

  ```js
  ;(async () => {
    const since = Date.parse(launchedAt)
    let run
    for (let i = 0; i < 10 && !run; i++) {
      const {runs} = await fetch("/operator/runs", {credentials: "same-origin"}).then(res => res.json())
      run = runs.find(r => Date.parse(r.createdAt) >= since)
      if (!run) await new Promise(resolve => setTimeout(resolve, 1000))
    }
    if (!run) return null
    const obs = (window.__obs = {runId: run.runId, frames: [], end: null})
    void (async () => {
      const res = await fetch(`/operator/runs/${run.runId}/stream`, {
        credentials: "same-origin",
        headers: {accept: "text/event-stream"},
      })
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ""
      for (;;) {
        const {value, done} = await reader.read()
        if (done) break
        buf += decoder.decode(value, {stream: true})
        const frames = buf.split("\n\n")
        buf = frames.pop()
        for (const frame of frames) {
          if ((frame.match(/^event: (.*)$/m) || [])[1] !== "status") continue
          const data = JSON.parse((frame.match(/^data: (.*)$/m) || [])[1] || "null")
          obs.frames.push({at: new Date().toISOString(), status: data?.status, waitReason: data?.waitReason ?? null})
        }
      }
      obs.end = "closed"
    })().catch(() => {
      obs.end = "error"
    })
    return run.runId
  })()
  ```

- A new run's card opens expanded. Confirm that in a snapshot, leave it expanded, and run nothing else until about 80 seconds after launch.
- From about 80 seconds, use short `wait --text` calls instead of polling: `wait --text "Waiting on a background task"` times out after about 25 seconds, so repeat it until about 120 seconds after launch. If the line has already moved on, it reads "Confirming it has finished"; record whichever label shows.
- Do not wrap agent-browser commands in `timeout`. Killing the wrapper can kill the browser daemon, which discards the page and the observer.
- Take timings from the observer's frame timestamps and the run's `createdAt`. Do not use the `updatedAt` in `/operator/runs`: it does not change when the reason changes.

1. Screenshot and snapshot the reason line under the repo name as soon as a `wait --text` call sees it. If no line shows within about 120 seconds, look for `background dispatch observed` in `bunx @marcusrbrown/infra gateway logs gateway`; the line carries the session ID, not the run ID, so match it to the launch by order. Without that line, record check 17 as `not triggered` with the run ID and skip to step 5. With that line but no label yet, keep waiting another 30–60 seconds before recording a failure.
2. Collapse the card, wait about 20 seconds for the list refresh, and screenshot it. While it is collapsed, read the run's current status once from page context. Define `runId` inline. The gateway replays the latest status to a new stream, so the first `status` frame is the current one:

   ```js
   ;(async () => {
     const ctl = new AbortController()
     const timer = setTimeout(() => ctl.abort(), 10000)
     try {
       const res = await fetch(`/operator/runs/${runId}/stream`, {
         credentials: "same-origin",
         signal: ctl.signal,
         headers: {accept: "text/event-stream"},
       })
       const reader = res.body.getReader()
       const decoder = new TextDecoder()
       let buf = ""
       for (;;) {
         const {value, done} = await reader.read()
         if (done) break
         buf += decoder.decode(value, {stream: true})
         for (const frame of buf.split("\n\n").slice(0, -1)) {
           if ((frame.match(/^event: (.*)$/m) || [])[1] !== "status") continue
           const data = JSON.parse((frame.match(/^data: (.*)$/m) || [])[1] || "null")
           ctl.abort()
           return {status: data?.status, waitReason: data?.waitReason ?? null}
         }
       }
     } catch {
     } finally {
       clearTimeout(timer)
     }
     return {status: null, waitReason: null}
   })()
   ```

   Record `status` and `waitReason`. Expect `running` with `awaiting-background-task` or `confirming-completion`.

3. Expand the card again and `wait --text` for the current reason line, which may already read "Confirming it has finished". Screenshot it.
4. Run `set offline on`, wait about 5 seconds, and snapshot: the line is blank while the card reconnects. Run `set offline off`, wait about 10 seconds, and snapshot again: the line shows the current reason. If the run has already finished, record step 4 as `not run` with the timestamps. In one pass, 5 seconds of `set offline on` left the open stream connected and the line never went blank. If that happens, record step 4 as `inconclusive`, not as a failure.
5. Wait for the terminal status. Confirm the card is expanded (its text includes "Raw text") and the line is gone, reload, and confirm the card is expanded again and the line stays gone.

### Cancel safety

Cancel only L8. A cancelled session can keep writing to the shared checkout after the cancel returns. Leftover files make every later launch on that repo fail with "Checkout refused: uncommitted changes" until an operator cleans the checkout. L8 asks a question and writes nothing. Never cancel a run whose prompt creates or edits files.

---

## Checks that launch nothing

Run these first, in this order.

1. **[Check 1, health.](operator-surface-acceptance.md#1-health)** `curl -s https://dashboard.fro.bot/operator/health`. Record the JSON and use its `contractVersion` as `<expected>`.
2. **[Check 2, sign-in.](operator-surface-acceptance.md#2-sign-in)** Open `https://dashboard.fro.bot/`. Confirm the operator UI shows and `/operator/session` returns 200 with the operator login. Do not run the OAuth start flow when the session is valid.
3. **[Check 4, contract handshake.](operator-surface-acceptance.md#4-contract-handshake)** Pick a run ID from the `/operator/runs` response. Read the first SSE event from page context and stop:

   ```js
   ;(async () => {
     const ctl = new AbortController()
     const res = await fetch(`/operator/runs/${runId}/stream`, {
       credentials: "same-origin",
       signal: ctl.signal,
       headers: {accept: "text/event-stream"},
     })
     const reader = res.body.getReader()
     const decoder = new TextDecoder()
     let buf = ""
     while (!buf.includes("\n\n")) {
       const {value, done} = await reader.read()
       if (done) break
       buf += decoder.decode(value, {stream: true})
     }
     ctl.abort()
     const frame = buf.split("\n\n")[0]
     const data = JSON.parse((frame.match(/^data: (.*)$/m) || [])[1] || "null")
     return {
       status: res.status,
       event: (frame.match(/^event: (.*)$/m) || [])[1],
       contractVersion: data?.contractVersion,
     }
   })()
   ```

   Define `runId` inline. Record the event name and `contractVersion`; do not echo the full frame.

4. **Launch lists bound repos and Recent Runs is non-empty** ([check 5](operator-surface-acceptance.md#5-launch-and-stream) step 4). Open the Launch panel and record the repo count. Close the panel without launching.
5. **[Check 11, expired output.](operator-surface-acceptance.md#11-expired-output)** Use a run that finished before the latest gateway restart. Load `https://dashboard.fro.bot/#<runId>`, reload, and read the card text. Without a reload, the hash change does not open the card.
6. **[Check 12, step 3.](operator-surface-acceptance.md#12-push)** Read the `push` field of the `/operator/session` response and record it. The delivery steps are not automatable.
7. **[Check 13, simulated.](operator-surface-acceptance.md#13-question-notification-deep-link)** Load `https://dashboard.fro.bot/#<runId>` for a run in the list, reload, and confirm that run opens and the "That run isn't in your recent runs." notice is absent. Record the result as `simulated`.
8. **[Check 14, session durability.](operator-surface-acceptance.md#14-session-durability)** Read `expiresAt` from `/operator/session`. The sign-in time is `expiresAt` minus seven days. The result is meaningful only when that time precedes the latest gateway restart; then a 200 now proves the session survived. When sign-in follows the restart, record `not demonstrable` with the `expiresAt` value. A 401 when sign-in precedes the restart is a failure.
9. **[Check 16, step 3.](operator-surface-acceptance.md#16-launch-prompt)** Open the Launch panel and fill the 8,001-unit prompt. Confirm the Launch button is disabled and the inline "Prompt is too long" status shows. Click Launch anyway and confirm the run count is unchanged. This check launches nothing.

---

## Not automatable

Record these as `skip` or `not automated`:

- [Check 3](operator-surface-acceptance.md#3-non-allowlisted-account): there is one operator and no second account. `skip`.
- [Check 10](operator-surface-acceptance.md#10-agent-question) step 4 (Discord settlement) and step 6 (question push). `not automated`.
- [Check 12](operator-surface-acceptance.md#12-push) delivery steps. `not automated`.
- [Check 13](operator-surface-acceptance.md#13-question-notification-deep-link) notification taps. The deep-link simulation above covers only that `/#<runId>` opens the run.
- [Check 16](operator-surface-acceptance.md#16-launch-prompt) step 4 has no safe trigger. `skip`.
- [Check 17](operator-surface-acceptance.md#17-run-wait-reason) step 6: "Finishing its reply" and "Agent still working" have no safe trigger. Record them only when they occur.

---

## Logout

Run [check 15](operator-surface-acceptance.md#15-logout-and-csrf) last, after every launch check. Run the snippets from the manual runbook as page-context `eval` code that keeps `csrfToken` in a variable and returns only status codes. `/operator/session` returns 401 afterwards.

Then open `https://dashboard.fro.bot/operator/auth/github/start` so the saved session is signed in for the next run. If that page lands on a GitHub login, stop and ask the operator.

---

## Afterwards

1. Collect every run ID the pass created from the `/operator/runs` response. Compare the list with the one read before the first launch.
2. Optionally confirm that no workspace checkout is dirty. This is read-only; run it on the gateway droplet against the checkout on the `fro-bot_workspace-repos` volume:

   ```bash
   git -c safe.directory='*' -C <checkout> status --porcelain
   ```

   Empty output means clean. Any output means the next launch on that repo fails with "Checkout refused: uncommitted changes"; report it to the operator. The gateway log may not show the refusal, so the checkout status is the reliable signal.

   Clean up only with the operator's approval, one path at a time. Before removing a file, confirm three things: it is the only dirty path, nothing holds it open (`fuser`/`lsof`), and its size and mtime are stable. Remove it as root, because the workspace UID 10001 has no host account and `sudo -u '#10001'` fails. Then read back `git status --porcelain` and run one `Reply with only the word OK.` launch on that repo. That launch uses the reserve launch.

3. Save evidence under `/tmp/operator-acceptance-<expected>/`: a screenshot per check named `NN-name.png`, and secret-free JSON for health, the `ready` frame, `/operator/runs`, and `/operator/session` (`login`, `expiresAt`, and `push` only).
4. Before recording a result, read the saved JSON back from disk. A subagent's summary is not evidence.
5. Record results as [Record results](operator-surface-acceptance.md#record-results) describes. Add a result column to the per-check list with one of `pass`, `fail`, `skip`, `not automated`, or `simulated`, and cite the run ID for checks 5–11, 13 and 17.
