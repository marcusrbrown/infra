# Operator Surface Acceptance (Automated)

How an agent runs the operator surface acceptance checks with [agent-browser](https://github.com/vercel-labs/agent-browser). Run it after every paired gateway + dashboard operator-contract deploy, then post the results. [`operator-surface-acceptance.md`](operator-surface-acceptance.md) is the full manual checklist; this runbook references its check numbers and does not repeat what each check expects. `<expected>` means the contract version reported by `/operator/health`. After a gateway release deploy, also run the [gateway release gates](#gateway-release-gates-agent-run).

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

Run the [checks that launch nothing](#checks-that-launch-nothing) first, then spend the nine launches below, at least 20 seconds apart. The limit is keyed to the operator, so manual launches and earlier passes in the same hour count too. The [gateway release gates](#gateway-release-gates-agent-run) share the window and spend 5 launches (G1.10, G2b, G3.1, G5.1, G5.3). Start the second of the two sets at least 60 minutes after the first launch of the earlier set, or after a gateway restart, which clears the counters (G3.4 restarts the gateway). The nine launches plus one in reserve fit only in a fresh window. Launch against `fro-bot/agent`. One launch stays in reserve; do not retry a launch that created a run.

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

Run L9 after L8 has finished, and launch nothing else until L9 ends. The first reason can appear within about 15–20 seconds of launch, so start the observer at launch. `awaiting-background-task` lasts roughly 40–45 seconds and is the only reason that tells a background run from a plain one, because every run ends with about 5 seconds of `confirming-completion`. A stretch with no reason between the subagent finishing and confirmation starting is normal. Steps 1–3 must fit inside the `awaiting-background-task` window: have every command ready before you launch, and do not spend the window on setup.

Timing procedure:

- Commands in one session run one at a time. An `eval` that waits blocks every later command, so record frames with a non-blocking observer: right after pressing Launch, run one `eval` that finds the new run, starts a stream reader that stores each `status` frame with a timestamp on `window.__obs.frames` and each `output` frame on `window.__obs.output`, and returns at once. The run can take a few seconds to appear, so the snippet retries for up to 10 seconds. Define `launchedAt` inline as the time just before the press, and take it from the shell clock truncated to whole seconds. Read `window.__obs` later with a single `eval`. Do not reload before step 5, because a reload discards the observer.

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
    const obs = (window.__obs = {runId: run.runId, frames: [], output: [], end: null})
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
          const event = (frame.match(/^event: (.*)$/m) || [])[1]
          if (event !== "status" && event !== "output") continue
          const data = JSON.parse((frame.match(/^data: (.*)$/m) || [])[1] || "null")
          const at = new Date().toISOString()
          if (event === "output")
            obs.output.push({at, seq: data?.seq, final: data?.final === true, text: data?.text ?? ""})
          else obs.frames.push({at, status: data?.status, waitReason: data?.waitReason ?? null})
        }
      }
      obs.end = "closed"
    })().catch(() => {
      obs.end = "error"
    })
    return run.runId
  })()
  ```

- A new run's card opens expanded. Confirm that in a snapshot and leave it expanded.
- Right after the observer returns, use short `wait --text` calls instead of polling: `wait --text "Waiting on a background task"` times out after about 25 seconds, so repeat it once, until about 60 seconds after launch. The "Confirming it has finished" line shows for only about 5 seconds near the end; the observer's frames are the record for it.
- Do not wrap agent-browser commands in `timeout`. Killing the wrapper can kill the browser daemon, which discards the page and the observer.
- Take timings from the observer's frame timestamps and the run's `createdAt`. Do not use the `updatedAt` in `/operator/runs`: it does not change when the reason changes.

1. Screenshot and snapshot the reason line under the repo name as soon as a `wait --text` call sees it. If no line shows within about 45 seconds, look for `background dispatch observed` in `bunx @marcusrbrown/infra gateway logs gateway`; the line carries the session ID, not the run ID, so match it to the launch by order. Without that line, record check 17 as `not triggered` with the run ID and skip to step 5. With that line but no label yet, keep waiting another 30 seconds before recording a failure.
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

   Record `status` and `waitReason`. Expect `running` with `awaiting-background-task`; `null` means the quiet stretch has begun, so record that and move on.

3. Expand the card again and `wait --text` for the current reason line. Screenshot it. If the quiet stretch has begun, no line shows; record that instead of a failure.
4. Not automatable (see [Not automatable](#not-automatable)). Record `not automated`.
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
- [Check 17](operator-surface-acceptance.md#17-run-wait-reason) step 4 (reconnect). Browser offline mode does not drop an open SSE stream, so the card never reconnects. The behaviour is covered by fro-bot/dashboard `web/src/operator/wait-reason-label.test.ts` (a reconnecting connection clears the label, and a replayed running frame shows it again). `not automated`.
- [Check 17](operator-surface-acceptance.md#17-run-wait-reason) step 6: "Finishing its reply" and "Agent still working" have no safe trigger. Record them only when they occur.

---

## Logout

Run [check 15](operator-surface-acceptance.md#15-logout-and-csrf) last, after every launch check and after the [gateway release gates](#gateway-release-gates-agent-run) when they run in the same sitting. Run the snippets from the manual runbook as page-context `eval` code that keeps `csrfToken` in a variable and returns only status codes. `/operator/session` returns 401 afterwards.

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

3. Confirm the `fro-bot/.github` `data` branch survived a promotion. Run it only when a `Merge Data Branch` promotion ran during the pass or the operator dispatched one for this purpose; otherwise record `not demonstrated`. Both commands are read-only and need only the `gh` login the gateway gates already use. Read the branch tip before the promotion starts (at the start of the pass, alongside the run list in step 1, or just before the dispatch) and again after it finishes:

   ```bash
   gh api repos/fro-bot/.github/git/ref/heads/data --jq .object.sha
   ```

   Then compare the two, old tip first:

   ```bash
   gh api repos/fro-bot/.github/compare/<old-sha>...<new-sha> --jq .status
   ```

   Pass: `ahead`, which means the old tip is an ancestor of the new one. `identical` means the branch did not move, so the check is not demonstrated: record that. Failure: `diverged`, `behind` or a `404`, which means `data` was replaced or reset; report it to the operator (see [check 5](operator-surface-acceptance.md#5-launch-and-stream) step 4 for the reseed). Record both short SHAs and the status with the results.

4. Save evidence under `/tmp/operator-acceptance-<expected>/`: a screenshot per check named `NN-name.png`, and secret-free JSON for health, the `ready` frame, `/operator/runs`, and `/operator/session` (`login`, `expiresAt`, and `push` only).
5. Before recording a result, read the saved JSON back from disk. A subagent's summary is not evidence.
6. Record results as [Record results](operator-surface-acceptance.md#record-results) describes. Add a result column to the per-check list with one of `pass`, `fail`, `skip`, `not automated`, or `simulated`, and cite the run ID for checks 5–11, 13 and 17.

---

## Gateway release gates (agent-run)

How an agent runs the gateway release gates after a Fro Bot gateway deploy moves to a new upstream ref (`apps/gateway/upstream.json`). The gates cover stale-credential removal on OpenCode V2, `/fro-bot cancel`, ownership persistence across a gateway restart, approval attribution, and that a rejected command does not run. The agent drives the droplet over SSH, reads run state from S3, launches and cancels runs from the dashboard session, and reads Discord threads over REST.

Each check is one of two kinds:

- **Automated.** Runs on a dashboard-launched run and needs no Discord action. Every release runs these: P0–P2, G1, G2b.1, G3 and G5.
- **Discord pass.** Needs a Discord-started run or a human Discord action. The agent cannot act in Discord as the operator: the gateway drops messages written by bots, and Discord accepts slash commands and button clicks only from users. These checks form one [Discord pass](#discord-pass), run in one sitting, and only when [it is triggered](#when-the-discord-pass-runs). Its operator steps are marked **Operator action**.

A release is a new upstream ref. A redeploy at the same ref runs no gates: its new image digests are covered by the P0 checks of the next release.

- G1, G2b.1, G3 and G5 use the dashboard session from [Browser session](#browser-session). Sign in first. When both passes run in one sitting, finish these gates before [Logout](#logout).
- The automated gates spend 5 launches (G1.10, G2b.1, G3.1, G5.1, G5.3) from the [launch budget](#launch-budget). The gateway gates and the browser pass share one per-operator window of 10 launches per hour. Start the second set at least 60 minutes after the first launch of the earlier set, or after a gateway restart, which clears the counters (G3.4 restarts the gateway).
- Every command below is a pattern: copy it and fill the placeholders. Add no script files to the repo.

### Inputs

| Variable       | Value                                                                                        |
| -------------- | -------------------------------------------------------------------------------------------- |
| `REPO`         | Absolute path of the repo checkout. Run from it so Bun finds the root `.env`.                |
| `WORK`         | `mktemp -d` for this pass. Holds the SSH key and the SSH control socket.                     |
| `REF`          | Upstream ref under test, as pinned in `apps/gateway/upstream.json`.                          |
| `OCV`          | OpenCode V2 version the deploying `build-images` job built (`--build-arg OPENCODE_VERSION`). |
| `TAG`          | `ACCEPT-$REF`. Prefix for every plant, probe and marker.                                     |
| `OWNER_REPO`   | `<owner>/<repo>` of the test repo the gates launch against.                                  |
| `OP_LOGIN`     | Operator's GitHub login.                                                                     |
| `CHANNEL`      | Discord pass only. ID of the Discord channel bound to `$OWNER_REPO`. Operator supplies it.   |
| `OP_ID`        | Discord pass only. Operator's Discord user ID. Operator supplies it.                         |
| `TRIGGER_ROLE` | Discord pass only. Trigger role ID (G2a). Operator supplies it.                              |

Secrets come from the repo-root `.env` through `envval` below: `GATEWAY_HOST`, `GATEWAY_SSH_KEY`, `S3_BUCKET`, `S3_REGION`, optional `S3_ENDPOINT`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, and, for the Discord pass only, `DISCORD_TOKEN` and `DISCORD_GUILD_ID`. The `AWS_*` keys can list and get in the state bucket. Never print, log, or save a value from `.env`.

### Rules

- Run the patterns under `bash`. `zsh` does not word-split unquoted `$(…)`. Tool calls may not share shell state: repeat the [helpers](#helpers) block at the head of each call, with the same `WORK`.
- Droplet commands run as `root` over SSH with the pinned host key. Many short calls trip SSH rate limits, so every call goes through one multiplexed connection (`gw`).
- On the droplet host, do not run `rm`, `mv`, `cp`, `mknod`, `chmod`, or `chown`.
- Do not redirect any remote command to `/dev/*`, including `2>/dev/null`. Use `2>&1`.
- Do not run `docker compose up`, `down`, or `pull`.
- Restart only `workspace` (G1) and `gateway` (G3), and only after `idle_check` succeeds.
- Container-side cleanup is allowed only for the gate's own plants, through `$DC exec -T -u 10001 workspace`.
- Gateway and workspace logs are unredacted. Filter with `grep` and save only the matched lines.
- A secret in argv is a leak: the SSH key lives in a mode 600 file, and the Discord token goes to `curl` on stdin.
- End of pass: `gw 'stat -c "%F %t,%T %a" /dev/null'` must print `character special file 1,3 666`. Anything else: stop and report it to the operator. Do not repair it.

### Helpers

```bash
REPO=<repo-root>; cd "$REPO"
WORK=${WORK:-$(mktemp -d)}; echo "WORK=$WORK"
envval() { (cd "$REPO" && NAME=$1 bun -e 'process.stdout.write(process.env[process.env.NAME] ?? "")'); }

GATEWAY_HOST=$(envval GATEWAY_HOST)
[[ $GATEWAY_HOST =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]] || { echo "invalid GATEWAY_HOST"; false; }   # a '-' prefix would be read as an ssh option
[ -s "$WORK/key" ] || (umask 077; { envval GATEWAY_SSH_KEY; echo; } > "$WORK/key")
chmod 600 "$WORK/key"

gw() {
  ssh -i "$WORK/key" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes \
    -o UserKnownHostsFile="$REPO/.github/known_hosts" \
    -o ControlMaster=auto -o ControlPersist=600 -o ControlPath="$WORK/cm" "root@$GATEWAY_HOST" "$@"
}
DC='docker compose --project-directory /opt/gateway/deploy'
wsx() { gw "$DC exec -T -u 10001 workspace sh -s"; }     # container shell as uid 10001; the script comes on stdin
glog() { gw "docker logs --timestamps --since $1 fro-bot-gateway-1 2>&1"; }

export AWS_ACCESS_KEY_ID=$(envval AWS_ACCESS_KEY_ID) AWS_SECRET_ACCESS_KEY=$(envval AWS_SECRET_ACCESS_KEY) AWS_DEFAULT_REGION=$(envval S3_REGION)
S3_BUCKET=$(envval S3_BUCKET); S3_ENDPOINT=$(envval S3_ENDPOINT); [ -z "$S3_ENDPOINT" ] || export AWS_ENDPOINT_URL_S3=$S3_ENDPOINT
BASE=fro-bot-state/discord-gateway
s3cat() { aws s3 cp "s3://$S3_BUCKET/$1" -; }
etag() { aws s3api head-object --bucket "$S3_BUCKET" --key "$1" --query ETag --output text; }
runkeys() { aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$BASE/$1/runs/" --query "sort_by(Contents,&LastModified)[-${2:-3}:].Key" --output text | tr '\t' '\n'; }

dget() { printf 'header = "Authorization: Bot %s"\n' "$(envval DISCORD_TOKEN)" | curl -sS -K - "https://discord.com/api/v10$1"; }
thread() { dget "/channels/$1/messages?limit=50" | jq -r 'reverse[] | [.timestamp[11:23], (.edited_timestamp // "-"), "mentions=\(.mentions|length)", "roles=\(.mention_roles|length)", "everyone=\(.mention_everyone)", (.content|tojson), ([.embeds[]|{title,description}]|tojson)] | @tsv'; }

wait_healthy() {   # $1 = container name
  for i in $(seq 72); do
    [ "$(gw "docker inspect --format '{{.State.Health.Status}}' $1")" = healthy ] && { echo "health: healthy $(date -u +%FT%TZ)"; return 0; }
    sleep 5
  done
  echo "health: not healthy after 6 min"; return 1
}

readyz() { wsx <<'EOF'
curl -sS -w '\nhttp=%{http_code}\n' http://127.0.0.1:9100/readyz
EOF
}

idle_check() {   # succeeds only when every run record of every bound repo is terminal; any listing, read or parse error fails
  local active=0 bad=0 repo key phase b bkeys rkeys repos
  bkeys=$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$BASE/_/_/bindings/by-channel/" --query 'Contents[].Key' --output text) \
    || { echo "idle-check: binding listing failed"; return 1; }
  [ -n "$bkeys" ] && [ "$bkeys" != None ] || { echo "idle-check: no bindings listed"; return 1; }
  repos=$(for b in $bkeys; do s3cat "$b" | jq -er '"\(.owner)/\(.repo)"' || echo "ERR:$b"; done | sort -u)
  case $repos in *ERR:*) echo "idle-check: unreadable binding"; return 1 ;; esac
  for repo in $repos; do
    rkeys=$(aws s3api list-objects-v2 --bucket "$S3_BUCKET" --prefix "$BASE/$repo/runs/" --query 'Contents[].Key' --output text) \
      || { echo "idle-check: run listing failed for $repo"; return 1; }
    [ "$rkeys" = None ] && continue
    for key in $rkeys; do
      phase=$(s3cat "$key" | jq -er .phase) || { echo "unreadable: $key"; bad=$((bad+1)); continue; }
      case $phase in
        COMPLETED|FAILED|CANCELLED) ;;
        *) active=$((active+1)); echo "active: $key $phase" ;;
      esac
    done
  done
  echo "idle-check active=$active unreadable=$bad $(date -u +%FT%TZ)"; [ "$active" -eq 0 ] && [ "$bad" -eq 0 ]
}
```

- Channel bindings are `$BASE/_/_/bindings/by-channel/<channelId>.json` with `{owner, repo}`. Run records are `$BASE/<owner>/<repo>/runs/<runId>.json` with `run_id`, `surface`, `thread_id`, `phase`, `started_at`, `last_heartbeat`, and `details.{rootSessionId, ownedSessionIds, cancelledBy}`.
- `idle_check` reads every run record of every bound repo; the CLI paginates the listings. Run it immediately before each restart. Any phase other than `COMPLETED`, `FAILED` or `CANCELLED` counts as active, and a listing, read or parse failure fails the check. A bound repo with no run records lists as `None` and counts as zero runs.
- `runkeys` (newest N records) is for finding the run under test. It is not an idle check.
- The first message in a run thread carries one mention. Every other message must carry none.

### When the Discord pass runs

Decide this once per release, before P0, and record the deciding item. The last pass is recorded on the `Discord pass:` line of the Results comment in the release tracker (currently fro-bot/.github#3512). If the tracker closes, the operator carries the newest `Discord pass:` line into the first results comment of the successor tracker, and `TRACKER` below changes.

The pass runs when any of these holds, checked in this order. Record the first one that holds:

1. `never passed`: no `Discord pass:` line yields an anchor.
2. `trigger check failed`: a query errors; the anchor is not an ancestor of `$REF`; or the file list of the compare is empty, has 300 or more files, or lacks the `patch` of a pin file.
3. `stale (<n> refs)`: `<n>` is 3 or more.
4. A [checklist](#discord-pass-checklist) item.
5. `none`: nothing holds. The pass does not run.

**1. Anchor.** The anchor is the ref of the newest `PASS`. A `FAIL` or `INCOMPLETE` pass leaves the anchor where it was, so the next release diffs from the last `PASS`. The tracker has more than 200 comments: without `--paginate`, `gh api` returns the first page only. Only comments from the owner, members and collaborators count.

```bash
set -o pipefail
TRACKER=repos/fro-bot/.github/issues/3512
LAST=$(gh api --paginate "$TRACKER/comments?per_page=100" --jq '.[] | select(.author_association | IN("OWNER","MEMBER","COLLABORATOR")) | .body | split("\r?\n"; null)[] | select(test("^Discord pass: (PASS on|[A-Z]+ on|not run)"))' | tail -n 1) \
  || { echo "trigger check failed: tracker query"; false; }
ANCHOR=$(printf '%s\n' "$LAST" | sed -nE 's/^Discord pass: (PASS on|[A-Z]+ on [^;]*; last passed on|not run[^;]*; last passed on) (v[0-9]+\.[0-9]+\.[0-9]+).*/\2/p')
echo "anchor: ${ANCHOR:-never passed}"
```

**2. Staleness.** Count the fro-bot/agent releases after the anchor, up to and including `$REF`, in semver order. Undeployed tags count too. Non-semver tags (the `*-harness.*` builds) are filtered out. An anchor or `$REF` missing from the list is an error.

```bash
count_refs() {   # $1 = anchor, $2 = REF
  gh api --paginate repos/fro-bot/agent/releases --jq '.[] | select(.draft | not) | .tag_name | select(test("^v[0-9]+\\.[0-9]+\\.[0-9]+$"))' \
    | jq -Rn --arg a "$1" --arg r "$2" '[inputs | {t: ., k: (ltrimstr("v") | split(".") | map(tonumber))}] | sort_by(.k) | map(.t) | (index($a)) as $i | (index($r)) as $j | if $i == null or $j == null or $j < $i then error("anchor or ref not in release list") else $j - $i end'
}
count_refs "$ANCHOR" "$REF"
```

**3. Diff.** Read the compare from the anchor to `$REF`. The compare endpoint lists changed files on its first page only, capped at 300 for the whole comparison, so `--paginate` adds none. A list of 300 means it may be truncated: that is `trigger check failed`. The first call must print `ahead`. `diverged` means the anchor is not an ancestor, and `identical` means a same-ref redeploy: run no gates. Then check the file list against the [checklist](#discord-pass-checklist). The patch of a pin file can be absent for a large diff; that is `unreadable` and requires the pass.

```bash
gh api "repos/fro-bot/agent/compare/$ANCHOR...$REF" --jq '"\(.status) ahead_by=\(.ahead_by) commits=\(.total_commits)"'
gh api "repos/fro-bot/agent/compare/$ANCHOR...$REF" --jq '[.files[] | {filename, previous_filename, status, patch}]' > "$WORK/compare.json"
jq 'length | if . == 0 or . >= 300 then "trigger check failed: \(.) files" else "files: \(.)" end' "$WORK/compare.json"

# globs: prints each matching path
jq -r --arg re '^(packages/gateway/src/(program\.ts|config\.ts|(discord|bindings|execute|approvals|operator-contract|web/operator)/.*)|packages/runtime/src/(coordination|agent)/.*)$' \
  '.[] | select([.filename, (.previous_filename // empty)] | any(test($re))) | .filename' "$WORK/compare.json"

# pin fields: prints each changed pin line, or "unreadable"
jq -r '
  def pin(f; re): .[] | select(.filename == f) | if .patch == null then "unreadable: \(f)" else (.patch | split("\n")[] | select(test(re)) | "\(f): \(.[0:60])") end;
  pin("packages/gateway/package.json"; "^[-+]\\s*\"discord\\.js\"\\s*:"),
  pin("packages/runtime/package.json"; "^[-+]\\s*\"@opencode-ai/sdk\"\\s*:"),
  pin("package.json"; "^[-+]\\s*\"@opencode-ai/sdk\"\\s*:"),
  pin("deploy/workspace.Dockerfile"; "^[-+]ARG OPENCODE_VERSION="),
  pin("packages/runtime/src/shared/opencode-v2-pin.json"; "^[-+]\\s*\"version\"\\s*:"),
  pin("bun.lock"; "^[-+]\\s*\"(discord\\.js|@opencode-ai/sdk)\"\\s*:")
' "$WORK/compare.json"
```

**4. Record.** The deciding item goes into the [Results](#results) `Discord pass:` line. When no item holds, the Discord checks are reported as `not run` with the ref of the anchor.

#### Discord pass checklist

A match on any line requires the pass. Test files under these paths count.

| Item | Match in the `compare` file list |
| --- | --- |
| Mention and interaction intake | `packages/gateway/src/program.ts` |
| Gateway config (trigger role, binder allowlist) | `packages/gateway/src/config.ts` |
| Discord handling | `packages/gateway/src/discord/**`, `packages/gateway/src/bindings/**` |
| Shared run, cancel, approval and question code | `packages/gateway/src/{execute,approvals,web/operator}/**`, `packages/gateway/src/operator-contract/**` |
| Runtime run state and agent code | `packages/runtime/src/{coordination,agent}/**` |
| discord.js | the `discord.js` version line in `packages/gateway/package.json`, or in `bun.lock` |
| OpenCode | the `@opencode-ai/sdk` version line in `packages/runtime/package.json`, root `package.json` or `bun.lock`; the `ARG OPENCODE_VERSION=` line in `deploy/workspace.Dockerfile`; the `version` line in `packages/runtime/src/shared/opencode-v2-pin.json` |

Other edits to `bun.lock`, `package.json` and the Dockerfile do not match. Name the matching path or pin line as the trigger.

### Dashboard launches

G1.10, G2b.1, G3.1, G5.1 and G5.3 each launch one run from the dashboard session. Each launch follows the [Launch budget](#launch-budget) spacing. The prompt omits the `@fro-bot` mention.

1. Take `launchedAt` from the shell clock, truncated to whole seconds: `LAUNCHED_AT=$(date -u +%FT%TZ)`.
2. **Launch guard.** In the Launch panel, select `$OWNER_REPO`, then take a fresh `snapshot -i` and read the selected repository. Abort the gate, launch nothing, and record `blocked` unless it equals `$OWNER_REPO`.
3. Fill the prompt and press Launch. For G1.10, start the [observer](#l9-wait-reason) in the next command, with `launchedAt` defined inline. A refusal ("Too many launch requests") created no run: record `blocked` and wait for the window.
4. Confirm the record is under `$OWNER_REPO`. Expect `surface` `web` and `started_at` at or after `$LAUNCHED_AT`. No such record means the run landed elsewhere: stop the gates and report it. Never retry a launch that created a run.

   ```bash
   RUNKEY=$(runkeys "$OWNER_REPO" 1)
   s3cat "$RUNKEY" | jq -c '{run_id, surface, phase, started_at}'
   ```

### Preconditions

| ID | Check | Pass |
| --- | --- | --- |
| P0 | Running image digests equal the digests the deploying `build-images` job pushed, and no gateway deploy is in flight. | Both digests match. |
| P1 | The workspace runs OpenCode V2 at `$OCV`. | `WORKSPACE_IMAGE_OPENCODE_VERSION` and `/readyz` `opencodeVersion` both equal `$OCV`. |
| P2 | The box is idle before every restart. | `idle_check` prints `active=0` and exits 0. |

**P0.** A gateway deploy approved during acceptance recreates the containers between gates. Even when the upstream ref stays the same, the new images have different digests: any change under the gateway path filter triggers a rebuild, and Alpine packages float. So a pass is valid only for one digest pair.

1. List gateway deploys that are waiting, queued or running. Each list must be `[]`. If one is not, tell the operator not to approve any gateway deploy gate until acceptance ends, and note the run IDs.

   ```bash
   for wf in deploy.yaml deploy-gateway.yaml; do for st in waiting queued in_progress; do
     echo "$wf $st"; gh run list --workflow "$wf" --status "$st" --json databaseId,displayTitle,createdAt
   done; done
   ```

2. Find the run that deployed the ref: the newest `deploy.yaml` (or `deploy-gateway.yaml`) run whose gateway job succeeded.

   ```bash
   gh run list --workflow deploy.yaml --status success --limit 10 --json databaseId,headSha,createdAt,displayTitle
   gh run view <runId> --json jobs --jq '.jobs[] | select(.name | test("gateway"; "i")) | [.name, .conclusion] | @tsv'
   ```

3. Read the pushed digests. Expect one `infra-gateway` line and one `infra-workspace` line, each ending `@sha256:<digest>`.

   ```bash
   gh run view <runId> --log | grep 'pushing manifest for'
   ```

4. Read the running digests and compare them with step 3.

   ```bash
   gw sh -s <<'EOF'
   for s in gateway workspace; do
     echo "$s $(docker inspect --format '{{json .RepoDigests}}' "$(docker inspect --format '{{.Image}}' "$(docker compose --project-directory /opt/gateway/deploy ps -q $s)")")"
   done
   EOF
   ```

Repeat step 4 before every gate and compare it with the digests recorded for the pass. A change means a deploy landed: match the new digests against the `build-images` output of the run that deployed them, and re-run any gate whose result spans the change.

**P1.**

```bash
gw "$DC exec -T workspace printenv WORKSPACE_IMAGE_OPENCODE_VERSION"
readyz
```

Expect `$OCV`, then `http=200` with `{"ready":true,"opencode":"ready","opencodeVersion":"<OCV>"}`.

**P2.** Run `idle_check` immediately before each restart. Do not restart when it exits non-zero. Wait and re-check.

### Gate 1: stale credential removal on V2

On V2 the entrypoint removes a stale `auth.json` at `/home/opencode/.local/share/opencode/auth.json`, including a symlink, without following the link. Provider credentials still come from the root-only secret. A `docker compose exec` session has `HOME=/var/lib/workspace-agent/home`, so always use the absolute path. Every G1 check is automated.

| ID | Check | Pass |
| --- | --- | --- |
| G1.1 | Exec identity | `id -u` prints `10001`. |
| G1.2 | Plant a regular file with a fake key | Listing shows `-rw-------` owned by `opencode`. |
| G1.3 | Restart `workspace`, wait healthy | `health: healthy`. |
| G1.4 | File removed | `ABSENT` and `NOT-SYMLINK`. |
| G1.5 | Entrypoint log since the restart | `opencode config: model=set, provider-overlay=merged-into-config-file`; `auth: present (OpenCode V2: …)`; `opencode-server-v2: provider credentials provisioned { providers: […], count: N }` with N of at least 1; no `cannot remove stale auth.json`. |
| G1.6 | `/readyz` | `http=200`, `"ready":true`, `"opencodeVersion":"<OCV>"`. |
| G1.7 | Plant a symlink to a marker, record the marker sha256 | Symlink listed. |
| G1.8 | Restart `workspace`, wait healthy | `health: healthy`. |
| G1.9 | Symlink removed, target intact | `LINK-GONE`, `TARGET-EXISTS`, same sha256 as G1.7, marker text `$TAG-MARKER-DO-NOT-TOUCH`; G1.5 and G1.6 again. |
| G1.10 | Dashboard-launched run still gets a model reply | Run `COMPLETED`; the final `output` frame (`final: true`) has `text` containing `$TAG-OK`. No final frame, or an empty final `text`, is a failure. |
| G1.11 | Cleanup | `CLEAN` and `MARKER-DIR-GONE`. |

Any `PRESENT`, `IS-SYMLINK`, `LINK-STILL-THERE`, changed sha256, or `TARGET-MISSING` is a failure: the removal followed the link or did not run. Run G1.11 after a failure too.

```bash
# G1.1, G1.2: plant as uid 10001. The key is fake; never plant a real provider key.
wsx <<EOF
id -u
mkdir -p /home/opencode/.local/share/opencode
printf '%s\n' '{"anthropic":{"type":"api","key":"$TAG-FAKE-STALE"}}' > /home/opencode/.local/share/opencode/auth.json
chmod 600 /home/opencode/.local/share/opencode/auth.json
ls -l /home/opencode/.local/share/opencode/auth.json
EOF

# G1.3: restart (P2 first)
idle_check && { T1=$(date -u +%FT%TZ); gw "$DC restart workspace"; wait_healthy fro-bot-workspace-1; }

# G1.4, G1.5, G1.6
wsx <<'EOF'
test -e /home/opencode/.local/share/opencode/auth.json && echo PRESENT || echo ABSENT
test -L /home/opencode/.local/share/opencode/auth.json && echo IS-SYMLINK || echo NOT-SYMLINK
EOF
gw "docker logs --since $T1 fro-bot-workspace-1 2>&1" | grep -E 'workspace-entrypoint: (opencode config|auth)|provider credentials provisioned|cannot remove stale auth.json'
readyz

# G1.7
wsx <<EOF
mkdir -p /home/opencode/$TAG /home/opencode/.local/share/opencode
printf '%s\n' '$TAG-MARKER-DO-NOT-TOUCH' > /home/opencode/$TAG/marker
rm -f /home/opencode/.local/share/opencode/auth.json
ln -s /home/opencode/$TAG/marker /home/opencode/.local/share/opencode/auth.json
ls -l /home/opencode/.local/share/opencode/auth.json
sha256sum /home/opencode/$TAG/marker
EOF

# G1.8
idle_check && { T1=$(date -u +%FT%TZ); gw "$DC restart workspace"; wait_healthy fro-bot-workspace-1; }

# G1.9
wsx <<EOF
test -L /home/opencode/.local/share/opencode/auth.json && echo LINK-STILL-THERE || echo LINK-GONE
test -e /home/opencode/$TAG/marker && echo TARGET-EXISTS || echo TARGET-MISSING
sha256sum /home/opencode/$TAG/marker
cat /home/opencode/$TAG/marker
EOF
gw "docker logs --since $T1 fro-bot-workspace-1 2>&1" | grep -E 'workspace-entrypoint: (opencode config|auth)|provider credentials provisioned|cannot remove stale auth.json'
readyz
```

**G1.10.** Launch from the dashboard with the prompt `reply with exactly the word $TAG-OK and nothing else`, following [Dashboard launches](#dashboard-launches). The observer keeps the run's `output` frames on `window.__obs.output`, from launch on, so the check does not depend on the stream's 10-minute replay of the final frame. Wait for `COMPLETED`:

```bash
RUNKEY=$(runkeys "$OWNER_REPO" 1)
for i in $(seq 30); do
  phase=$(s3cat "$RUNKEY" | jq -r .phase)
  case $phase in PENDING|ACKNOWLEDGED|EXECUTING) sleep 10;; *) break;; esac
done
s3cat "$RUNKEY" | jq -c '{run_id, phase}'
```

Then read the observer once, with `tag` defined inline as the value of `$TAG`. It returns booleans only, so the reply text is not echoed:

```js
;(async () => {
  const o = window.__obs
  const fin = o.output.filter(f => f.final).at(-1)
  return {
    runId: o.runId,
    end: o.end,
    finalSeen: Boolean(fin),
    emptyFinal: fin ? fin.text.trim() === "" : null,
    hasMarker: fin ? fin.text.includes(`${tag}-OK`) : null,
  }
})()
```

Pass: `COMPLETED`, `finalSeen` true, `emptyFinal` false, `hasMarker` true. If the page was reloaded and `window.__obs` is gone, re-open `/operator/runs/<runId>/stream` from the page within 10 minutes of completion and read the replayed final `output` frame the same way.

```bash
# G1.11: cleanup, run after the gate and after any failed step
wsx <<EOF
rm -rf /home/opencode/$TAG
rm -f /home/opencode/.local/share/opencode/auth.json
test -e /home/opencode/.local/share/opencode/auth.json && echo STILL-PRESENT || echo CLEAN
test -e /home/opencode/$TAG && echo MARKER-DIR-PRESENT || echo MARKER-DIR-GONE
EOF
```

### Gate 2: `/fro-bot cancel`

G2b.1 is automated. G2a, G2b.2, G2c and G2d are in the [Discord pass](#discord-pass). Three runs use the prompt ``Run `sleep 120` in the shell and report when it finishes.``: C1 is launched from the dashboard; C1-D and C2 are started in Discord with `@fro-bot` in front of the prompt. The prompt writes nothing, so cancelling it is safe (see [Cancel safety](#cancel-safety)). The ephemeral replies to slash commands are not readable over REST: the operator reads each reply and reports it verbatim, and the agent confirms it against the gateway log.

| ID | Group | Check | Pass |
| --- | --- | --- | --- |
| G2a.1 | Discord pass | Trigger role removed from the operator (`false`) | The member read returns `false`. |
| G2a.2 | Discord pass | `/fro-bot cancel` in the idle bound channel | Reply `You do not have permission to cancel runs.`; no `cancel:` line in the gateway log since the command. |
| G2a.3 | Discord pass | Trigger role restored (`true`) | The member read returns `true`. |
| G2a.4 | Discord pass | `/fro-bot cancel` in the idle bound channel | Reply is the `no-executing-run` copy; log `cancel: refused` with `"reason":"no-executing-run"` and `"channelId":"$CHANNEL"`. |
| G2b.1 | Automated | Dashboard-launched run, dashboard cancel (run C1) | Dashboard POST returns 200 with `"phase":"CANCELLED"`; record `CANCELLED` with `details.cancelledBy.kind` `web-operator` and `login` `$OP_LOGIN`. |
| G2b.2 | Discord pass | Discord-started run, dashboard cancel first (run C1-D) | Exactly one notice `Run cancelled by operator $OP_LOGIN.` in the thread, with no mentions. |
| G2c | Discord pass | Discord cancel first, dashboard cancel within about 5 s (run C2) | Log shows `cancel: handled` with `"outcome":"cancelled"`, then `cancelRun: cancel already requested — retrying approval settlement only`, then `run: execution aborted by operator cancel`. Dashboard POST returns 200. Record `CANCELLED` with `details.cancelledBy.kind` `discord-user` and `discordUserId` `$OP_ID`. Exactly one notice `Run cancelled by <@$OP_ID>.`, no mentions. |
| G2d | Discord pass | Targeting rows (below) | Each reproducible row shows its reply and log `reason`. |

The operator is the actor named by `$OP_ID` and `$OP_LOGIN`. Notices are posted in the run thread (`thread_id`), not the channel. A role-restore that does not show `true` blocks G2a.4.

```bash
# G2a.1 / G2a.3: read the operator's roles. Expect false after removal, true after restore.
dget "/guilds/$(envval DISCORD_GUILD_ID)/members/$OP_ID" | jq --arg r "$TRIGGER_ROLE" '.roles | index($r) != null'
# G2a.2 / G2a.4: log check, with T0 taken before the operator acts
T0=$(date -u +%FT%TZ); glog "$T0" | grep 'cancel:'
```

**Operator action (G2a):** remove your own trigger role (keep Manage Channels). After the agent reads `false`, run `/fro-bot cancel` in the bound channel and report the reply. Restore the role. After the agent reads `true`, run `/fro-bot cancel` again and report the reply.

**Targeting copy and reasons**

| Row | Setup | Log `reason` | Reply |
| --- | --- | --- | --- |
| run-finished | `/fro-bot cancel` in the thread of a finished run (the C1-D thread) | `run-finished` | `This run has already finished. Nothing to cancel.` |
| not-a-run-thread | `/fro-bot cancel` in a thread the operator creates by hand in the bound channel | `not-a-run-thread` | `This thread is not a run thread I can find. Use /fro-bot cancel inside the thread of the run you want to stop.` |
| no-executing-run | `/fro-bot cancel` in the idle bound channel (G2a.4) | `no-executing-run` | `No run is executing here. Queued runs are not cancelled by this command; use /fro-bot clear-queue.` |
| unbound-channel | `/fro-bot cancel` in a channel with no binding | `unbound-channel` | `No repo is bound to this channel. Use /fro-bot cancel in a bound channel or in a run thread.` |

For `unbound-channel`, first confirm the channel has no binding: `aws s3 ls "s3://$S3_BUCKET/$BASE/_/_/bindings/by-channel/<channelId>.json"` prints nothing.

Record these rows as `not reproduced`:

- Queued (PENDING) run in a thread: a PENDING run has no thread until it is adopted, so the row cannot be reached.
- `other-channel`, `ambiguous` (the per-channel queue admits one active run) and `lookup-failed`: no safe trigger.

The backticks in the replies render as code formatting in Discord. Any reply outside the table, or a cancel that succeeds where a refusal row applies, is a failure.

**Run C1, dashboard-launched (G2b.1).** Launch the `sleep 120` prompt from the dashboard, following [Dashboard launches](#dashboard-launches). The agent finds the run (`runkeys "$OWNER_REPO" 1`, phase `EXECUTING`), waits 20 seconds, and cancels from the dashboard session:

```bash
cat > "$WORK/cancel.js" <<EOF
;(async () => {
  const runId = '<runId>'
  const {csrfToken} = await fetch('/operator/session/csrf', {credentials: 'same-origin'}).then(r => r.json())
  const res = await fetch('/operator/runs/' + runId + '/cancel', {
    method: 'POST',
    credentials: 'same-origin',
    headers: {'x-csrf-token': csrfToken},
  })
  return {status: res.status, body: await res.json().catch(() => null)}
})()
EOF
agent-browser --session infra-operator-acceptance --restore --restore-save auto eval --stdin < "$WORK/cancel.js"
```

Then verify the record:

```bash
s3cat "$RUNKEY" | jq '{phase, surface, cancelledBy: .details.cancelledBy}'
```

A web run has no Discord thread (`thread_id` is empty) and posts no cancel notice, so the record is the whole check.

**Run C1-D, Discord-started (G2b.2).** In the Discord pass, after the [Mention intake and reply](#discord-pass) check:

**Operator action:** post `@fro-bot` and the `sleep 120` prompt in the bound channel. The agent finds the run and thread (`runkeys "$OWNER_REPO" 1`, phase `EXECUTING`), waits 20 seconds, writes `$WORK/cancel.js` as above with the run ID, and cancels from the dashboard session. Then it verifies the record and notice:

```bash
s3cat "$RUNKEY" | jq '{phase, thread_id, cancelledBy: .details.cancelledBy}'
dget "/channels/<thread_id>/messages?limit=50" | jq -r '.[] | select(.content | startswith("Run cancelled by")) | [.content, (.mentions|length), (.mention_roles|length), .mention_everyone] | @tsv'
```

Expect one row: `Run cancelled by operator $OP_LOGIN.` with `0`, `0`, `false`. Then the operator runs `/fro-bot cancel` in that thread for the `run-finished` row.

**Run C2, Discord first (G2c).** The in-flight collapse is reachable only when the Discord cancel goes first and the dashboard cancel follows within about 5 seconds; the abort settles about 6 seconds after the request. A dashboard-first cancel makes a later Discord cancel resolve `run-finished`.

**Operator action:** post `@fro-bot` and the `sleep 120` prompt. The agent finds the run and thread, writes `$WORK/cancel.js` as above with the new `<runId>`, then starts the following command with a 5-minute tool timeout. It fires the dashboard cancel on the first `cancel: handled` line. Only after it is running, the operator runs `/fro-bot cancel` in the run thread.

```bash
T2=$(date -u +%FT%TZ)
grep -m1 --line-buffered 'cancel: handled' < <(gw "docker logs --timestamps --since $T2 -f fro-bot-gateway-1 2>&1") \
  && agent-browser --session infra-operator-acceptance --restore --restore-save auto eval --stdin < "$WORK/cancel.js"
```

Wait 15 seconds, then check the log and record:

```bash
glog "$T2" | grep -E 'cancel: handled|cancelRun:|execution aborted|suppressing user-facing'
s3cat "$RUNKEY" | jq '{phase, cancelledBy: .details.cancelledBy}'
```

If the log lacks `cancel already requested`, the dashboard cancel landed after the abort settled: record G2c as `not reproduced` and repeat with a fresh run, at most twice.

From agent v0.136.4, a cancelled run that produced no text posts only the cancel notice (fro-bot/agent#2116). A later `_(no output)_` message in the thread fails G2c.

### Gate 3: ownership persistence and restart

A run that spawns a background shell and a background subagent persists its owned sessions without an ownership-persist failure. The finished record survives a gateway restart unchanged. Every G3 check is automated. The ownership code has no surface branch, and restart recovery never reloads ownership, so a dashboard-launched run exercises the same path as a Discord-started one.

| ID | Check | Pass |
| --- | --- | --- |
| G3.1 | Ownership is exercised | The run record shows a non-empty `details.ownedSessionIds` at least once while the run is `EXECUTING`, and the log has both `run-core: background shell adopted into ownership ledger` and `run-core: background dispatch observed -- adopted into ownership ledger`. |
| G3.2 | No persist failure in the run window | No `run: failed to persist ownership onto run state`, no `run: patchRunDetails threw while persisting ownership`, and no `PreconditionFailed` or `"httpStatusCode":412` line inside the window. |
| G3.3 | Final record | `phase` is `COMPLETED`, `details.rootSessionId` is set, and `details.ownedSessionIds` is `[]`. |
| G3.4 | Survives a gateway restart | After the restart the record has the same ETag and body hash; the log shows `discord shard ready` and `recovery: stale-run sweep complete`. |
| G3.5 | Still listed | `/operator/runs` lists the run with its terminal status. |

If G3.1 fails, record `not triggered` and re-run with a clearer prompt. A clean G3.2 on an empty ledger proves nothing.

The gateway logs `412 PreconditionFailed` lines from its boot self-test after every start. Count a 412 only when its timestamp falls inside the run window (the record's `started_at` onward) and, if the line carries a `key`, the key belongs to this run. Run the scan before the restart in G3.4.

**G3.1.** Launch from the dashboard, following [Dashboard launches](#dashboard-launches), with this prompt:

```text
Run `sleep 90` in the background in the shell. Then start a background subagent with the task tool that runs `sleep 60` and reports done. Report when both are finished.
```

```bash
T3=$(date -u +%FT%TZ)   # taken before pressing Launch
# after the launch: RUNKEY is the newest key whose started_at is after T3
RUNKEY=$(runkeys "$OWNER_REPO" 1)
for i in $(seq 30); do
  s3cat "$RUNKEY" | jq -c '{phase, root: .details.rootSessionId, owned: .details.ownedSessionIds}'
  phase=$(s3cat "$RUNKEY" | jq -r .phase)
  case $phase in PENDING|ACKNOWLEDGED|EXECUTING) sleep 20;; *) break;; esac
done

# G3.1, G3.2: scan the run window, before any restart
START=$(s3cat "$RUNKEY" | jq -r .started_at)
glog "$T3" | grep 'adopted into ownership ledger'
glog "$T3" | awk -v s="${START%Z}" '$1 >= s' | grep -E 'failed to persist ownership|patchRunDetails threw|PreconditionFailed|"httpStatusCode":412'

# G3.3
s3cat "$RUNKEY" | jq '{phase, root: .details.rootSessionId, owned: .details.ownedSessionIds}'

# G3.4
before="$(etag "$RUNKEY") $(s3cat "$RUNKEY" | shasum -a 256 | cut -c1-16)"
idle_check && { T4=$(date -u +%FT%TZ); gw "$DC restart gateway"; wait_healthy fro-bot-gateway-1; }
glog "$T4" | grep -E 'discord shard ready|recovery: (scanning repos|stale-run sweep complete)'
after="$(etag "$RUNKEY") $(s3cat "$RUNKEY" | shasum -a 256 | cut -c1-16)"
[ "$before" = "$after" ] && echo "RECORD BYTE-IDENTICAL" || echo "RECORD CHANGED: $before / $after"
```

A grep that prints nothing for G3.2 is the pass. For G3.5, run in the dashboard session with `runId` defined inline:

```js
;(async () => {
  const {runs} = await fetch("/operator/runs", {credentials: "same-origin"}).then(r => r.json())
  const run = runs.find(r => r.runId === runId)
  return {found: Boolean(run), status: run?.status ?? null}
})()
```

### Gate 4: attribution rendering

Settled approval and question cards name the decider and ping nobody. Every G4 check is in the [Discord pass](#discord-pass): the card edits need a Discord-started run, because a web run has no thread. In every row the operator starts the run from Discord. For Discord rows the operator clicks the Discord button. For dashboard rows the agent decides from the signed-in dashboard session and must not touch Discord. In both cases the agent then reads the card over REST.

| ID | Group | Surface | Decision | Expected card |
| --- | --- | --- | --- | --- |
| G4a | Discord pass | Discord | approve | title `✅ Approved`, description `Approved by <@$OP_ID>` |
| G4b | Discord pass | Discord | deny | title `⛔ Denied`, description `Denied by <@$OP_ID>` |
| G4c | Discord pass | Dashboard | approve | title `✅ Approved`, description `Approved by <login> (dashboard)` |
| G4d | Discord pass | Dashboard | deny | title `⛔ Denied`, description `Denied by <login> (dashboard)` |
| G4e | Discord pass | Discord | question answer | title `✅ Answered`, description ending `Answered by <@$OP_ID>`, then an answer field |
| G4f | Discord pass | Dashboard | question answer | title `✅ Answered`, description ending `Answered by <login> (dashboard)`, then an answer field |

Every card must have a title with no mention, `edited_timestamp` set, `mentions` empty, `mention_roles` empty, and `mention_everyone` false. The expected `(dashboard)` suffix on question cards applies to agent v0.136.3 and later.

**Operator action (G4a):** post `@fro-bot Run \`rm -f ./$TAG-probe-approve.txt\` in the shell and report the result.` When the approval card appears in the run thread, click **Approve**.

**Operator action (G4b):** post `@fro-bot Run \`chmod 600 ./$TAG-probe-deny.txt\` in the shell and report the result.` Click **Deny**.

**Operator action (G4e):** post `@fro-bot Before you start, ask me one clarifying question with two options (A or B) using the question tool, then wait for my answer.` Click an option.

The probe targets do not exist, so nothing in the checkout changes. After each run reaches `COMPLETED`, read the card from the run's thread:

```bash
dget "/channels/<thread_id>/messages?limit=50" | jq -c '.[] | select(.embeds | length > 0) | {title: .embeds[0].title, desc: .embeds[0].description, edited: .edited_timestamp, mentions: (.mentions|length), roles: (.mention_roles|length), everyone: .mention_everyone}'
```

**Dashboard rows (G4c, G4d, G4f).** These rows need agent v0.136.4 or later (fro-bot/agent#2115). The operator posts the same prompts as G4a, G4b and G4e, using `$TAG-probe-approve`, `$TAG-probe-deny` and a fresh question, and leaves Discord alone. Then the agent does the following.

1. Find the run. It is the newest entry in `/operator/runs` for the bound repo, with status `waiting_for_approval` or `waiting_for_answer`.
2. Confirm the gateway lists the pending request under the run ID:
   - `GET /operator/runs/<runId>/approvals` returns `{approvals: [{requestID, permission, command}]}` with the probe command.
   - `GET /operator/runs/<runId>/questions` returns `{requests: [{requestID, questions: [{header, text, options}]}]}`.
3. In the dashboard, open the run's collapsed card. Opening `/#<runId>` doesn't expand it. Clicking toggles the card, so take a fresh snapshot after each click.
4. Decide in the card:
   - G4c: the approval prompt shows the command. Click **Once**.
   - G4d: click **Reject**.
   - G4f: pick an option and click **Submit answers**.
5. Check the run after each decision. After **Reject** the run continues, and its reply says the operator rejected the command.
6. Read the card from the thread as for the Discord rows.

The API shapes for a decision without the UI:

- `POST /operator/runs/<runId>/approvals/<requestID>/decision` takes `{decision: 'once'}` or `{decision: 'reject'}`.
- `POST /operator/runs/<runId>/questions/<requestID>/decision` takes `{decision: 'answer', answers: [{options: [0]}]}`.
- Both POSTs need the `x-csrf-token` header from `/operator/session/csrf`. Keep the token inside the `eval`.

**Question rows: no raw question input in the reply (G4e, G4f).** After the question run reaches `COMPLETED`, read its thread with the same `dget` call (`DISCORD_TOKEN`; no other credential) and count the messages whose content or embed text holds the raw input of the question tool. The agent once printed that input at the head of the final reply, as `(questions: [{"question":…`, so the patterns are `(questions:` and `"question":`. Run it for G4f as well as G4e, because the dashboard-answered run is where the leak was first seen (fro-bot/agent#2141).

The final reply is the bot message with non-empty text content, no embed and no attachment, that does not start with `⏳ Working…` and is not `_(no output)_`. The gateway keeps one editable status message that reads `⏳ Working…` (then counts) while the run works. At completion it edits that message into the answer, or deletes it and posts the answer as a new message. A long answer is posted as an attachment, and a card is an embed. The `raw` count covers every bot message that is still in the thread, including the final reply and the question card.

```bash
dget "/channels/<thread_id>/messages?limit=50" | jq -c '
  def bot: select(.author.bot == true);
  {scanned: length,
   final: [.[] | bot | select((.embeds | length) == 0 and (.attachments | length) == 0 and (.content | length) > 0 and (.content | startswith("⏳ Working…") | not) and .content != "_(no output)_")] | length,
   raw: [.[] | bot | select(([.content] + [.embeds[] | .title, .description] | map(. // "") | join("\n")) | test("\\(questions:|\"question\":"))] | length}'
```

Record the three counts, never message text. Pass: `raw` is `0`, `final` is `1` or more, and `scanned` is below 50. Fail: `raw` is `1` or more, whatever the other counts. `not triggered`: `final` is `0`, because no final reply was read (the thread holds only the activity line, the placeholder or an attachment), or `scanned` is `50`, because the page was full and older messages were not read (coverage incomplete).

The scan identifies the final reply by exclusion. It cannot show that the reply is the model's own answer, it cannot read an attachment, and it cannot see the activity line after completion, because that message has become the answer or been deleted. To cover the activity line, run the same command once while the question is open and apply only the `raw` rule to that read.

### Gate 5: rejected command does not run

A bash command the operator rejects does not run. Automated: two dashboard launches on `$OWNER_REPO`, a control (the ask is approved once) and the probe (the ask is rejected). Run it after G3.4, so no gateway restart falls inside it, and before the [Discord pass](#discord-pass).

The command is `chmod 600` on a marker file in the workspace container's `/tmp`. The deploy's permission policy asks before `chmod *` (`WORKSPACE_PERMISSION_POLICY` in `apps/gateway/src/deploy.ts`), and `chmod` changes only the mode, so neither run alters or removes the file's content. The marker stays out of the checkout on purpose: the checkout is shared between runs, and an untracked file there makes the next launch on the repo fail with "Checkout refused: uncommitted changes". The policy sets `external_directory` to `allow`, so a path outside the checkout raises no second ask. The gate plants and removes each marker itself through `wsx`, as uid 10001, the user the agent's tools run as.

| ID | Check | Pass |
| --- | --- | --- |
| G5.1 | Control: the ask for the marker is approved once | An ask with `permission` `bash` names the marker. The decision returns `200` with `{"state":"claimed"}`. The run reaches `COMPLETED`. At terminal and 30 s later the marker is mode `600` with the planted sha256. |
| G5.2 | Control run: a collapsed card keeps its accessible label in step with its badge | The card was collapsed before the decision and is still collapsed at the read. After the run is `succeeded` and the list refreshed, its `aria-label` is exactly `Run, status: Succeeded` and its badge reads `Succeeded`. |
| G5.3 | Probe: the ask for the marker is rejected | An ask with `permission` `bash` names the marker. Every decision returns `200` with `{"state":"claimed"}`. The gateway log has a `permission.replied forwarded` line with `"reply":"reject"` for each reject. |
| G5.4 | The rejected command did not run | At terminal and 30 s later, and again at Finish, the marker is mode `644` with the planted sha256. |

G5.1 comes first and gates the rest. If it does not pass, launch nothing more for this gate and record G5.3 and G5.4 as `blocked`. A control that does not change the mode means the observer, the approval path or the marker location is wrong, and a clean probe would prove nothing.

**Scope.** This gate shows that a reject holds for one listed verb on one path: `chmod`, rejected through the dashboard decision route. It does not show that unlisted commands ask. `WORKSPACE_PERMISSION_POLICY` sets bash `'*'` to `allow` and lists only a few `ask` patterns, so a command that matches none of them (`touch`, `echo >`, `python -c`) runs with no prompt. Whether a wrapper such as `sh -c "chmod …"` matches `chmod *` is not established. The policy's own comment calls it a human-in-the-loop tripwire on top of the container and egress boundary, not a hard sandbox. A PASS here says nothing about commands the policy does not list, and nothing about other routes that could run a rejected command.

Before each launch: P0 step 4 still matches the recorded digests, `idle_check` passes, and the checkout of `$OWNER_REPO` is clean (see [Afterwards](#afterwards), step 2). Never cancel a G5 run (see [Cancel safety](#cancel-safety)). Reject every ask until the run ends. Do not restart the gateway or the workspace between the control launch and the Finish observation.

Helpers, repeated at the head of each call with the [helpers](#helpers) block:

```bash
OUT=/tmp/gateway-acceptance-$REF; mkdir -p "$OUT"
observe() { wsx <<EOF
stat -c 'mode=%a owner=%U size=%s' /tmp/$1.txt 2>&1 || echo ABSENT
sha256sum /tmp/$1.txt 2>&1 || true
EOF
}
plant() {   # $1 = marker; expect mode=644 owner=opencode
  wsx <<EOF
printf '%s\n' '$1' > /tmp/$1.txt
chmod 644 /tmp/$1.txt
EOF
  observe "$1"
}
unplant() { wsx <<EOF
rm -f /tmp/$1.txt
test -e /tmp/$1.txt && echo STILL-PRESENT || echo CLEAN
EOF
}
```

The launch prompt is the same for both runs, with the run's own marker. The model must run the command in the shell:

```text
Run `chmod 600 /tmp/<MARK>.txt` in the shell and report the result.
```

The decider runs in the dashboard page, so the CSRF token stays there. It lists the run's asks every 5 seconds and decides each new one: the ask with `permission` `bash` whose command names the marker gets `decision`, and every other ask is rejected. It never returns command text, only whether the command names the marker. Start it in the command after Launch, the way the [observer](#l9-wait-reason) is started, and read it later with a second `eval`. Do not reload the page before the read. Define `runId` and `mark` inline. The control uses `decision` `"once"` and `delayMs` `20000`; the probe uses `"reject"` and `0`:

```js
;(() => {
  const runId = "<runId>"
  const mark = "<MARK>"
  const decision = "once" // probe: "reject"
  const delayMs = 20000 // probe: 0
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
  const g5 = (window.__g5 = {done: false, reason: null, asks: []})
  void (async () => {
    const {csrfToken} = await fetch("/operator/session/csrf", {credentials: "same-origin"}).then(r => r.json())
    const t0 = Date.now()
    for (let i = 0; ; i++) {
      const body = await fetch(`/operator/runs/${runId}/approvals`, {credentials: "same-origin"})
        .then(r => r.json())
        .catch(() => null)
      for (const a of body?.approvals ?? []) {
        if (g5.asks.some(x => x.requestID === a.requestID)) continue
        const names = a.permission === "bash" && String(a.command ?? "").includes(mark)
        if (names && delayMs > 0) await sleep(delayMs)
        const verdict = names ? decision : "reject"
        const res = await fetch(`/operator/runs/${runId}/approvals/${a.requestID}/decision`, {
          method: "POST",
          credentials: "same-origin",
          headers: {"content-type": "application/json", "x-csrf-token": csrfToken},
          body: JSON.stringify({decision: verdict}),
        })
        const out = await res.json().catch(() => null)
        g5.asks.push({
          requestID: a.requestID,
          permission: a.permission,
          names,
          decision: verdict,
          status: res.status,
          state: out?.state ?? null,
          at: Math.round((Date.now() - t0) / 1000),
        })
      }
      if (g5.asks.length > 5) return void Object.assign(g5, {done: true, reason: "more-than-five-asks"})
      if (Date.now() - t0 > 180000 && !g5.asks.some(x => x.names))
        return void Object.assign(g5, {done: true, reason: "no-ask"})
      if (Date.now() - t0 > 600000) return void Object.assign(g5, {done: true, reason: "timeout"})
      if (i % 3 === 2) {
        const {runs} = await fetch("/operator/runs", {credentials: "same-origin"}).then(r => r.json())
        const status = runs.find(r => r.runId === runId)?.status
        if (["succeeded", "failed", "cancelled"].includes(status))
          return void Object.assign(g5, {done: true, reason: status})
      }
      await sleep(5000)
    }
  })().catch(() => Object.assign(g5, {done: true, reason: "error"}))
  return "started"
})()
```

Read it with `;(() => window.__g5)()`. It holds ask IDs, statuses and states only. The pending-asks route allows 30 requests a minute and the run list 20, so the 5-second poll stays inside both.

1. **G5.1 and G5.2, control.**
   1. Plant: `MARK=$TAG-G5-$(openssl rand -hex 4); plant "$MARK" | tee "$OUT/g5-control.txt"`. Expect `mode=644 owner=opencode`. Any other baseline means the plant failed: stop and record `blocked`.
   2. Take `launchedAt` and `T5=$(date -u +%FT%TZ)` from the shell clock, then launch with the prompt above, following [Dashboard launches](#dashboard-launches). Find the record (`RUNKEY`, `run_id`) and start the decider. Then take a fresh `snapshot -i` and click the new run's card to collapse it. Confirm with `eval` that `document.querySelector('[data-run-id="<runId>"]').dataset.expanded` is `"false"`. The decider approves 20 seconds after it sees the ask, so the collapsed card has refreshed to "Waiting for approval" before the run turns `succeeded`.
   3. Wait for the run record to reach `COMPLETED` (the loop in G1.10), then 30 seconds. Observe and save: `{ date -u +%FT%TZ; observe "$MARK"; } | tee -a "$OUT/g5-control.txt"`. Expect `mode=600` and the planted sha256.
   4. Wait 20 seconds more for the list refresh, with the card still collapsed, and read the card. Save a screenshot to an absolute path under `$OUT`.

      ```js
      ;(() => {
        const card = document.querySelector('[data-run-id="<runId>"]')
        return {
          expanded: card?.dataset.expanded ?? null,
          label: card?.getAttribute("aria-label") ?? null,
          badge: card?.querySelector('[data-role="run-status"]')?.textContent ?? null,
        }
      })()
      ```

      Pass: `expanded` is `"false"`, `label` is `Run, status: Succeeded` and `badge` is `Succeeded`. Fail: a `label` that holds "Waiting for approval" or otherwise differs from the badge; the stale label was `Run, status: Waiting for approval` beside a finished badge. `expanded` of `"true"`, or a run that did not end `succeeded`, is `not triggered`: the card was not collapsed through the refresh, so the label was not exercised.

   5. Read the decider and save the matched log lines: `glog "$T5" | grep -E 'permission\.replied forwarded|approval\.decision' | tee "$OUT/g5-control-log.txt"`. Read the saved files back. Only then remove the control marker: `unplant "$MARK"` must print `CLEAN`.
2. **G5.3 and G5.4, probe.**
   1. Plant a new marker: `MARK=$TAG-G5-$(openssl rand -hex 4); plant "$MARK" | tee "$OUT/g5-probe.txt"`. Expect `mode=644`.
   2. Launch at least 20 seconds after the control launch, as in step 1.2, with the new marker and the decider set to `decision` `"reject"` and `delayMs` `0`. Leave the card as it is, and take a fresh `T5`.
   3. Wait until the decider reports `done` and the run record is terminal, then 30 seconds. Observe and save as above. Read `window.__g5` and save the matched log lines to `$OUT/g5-probe-log.txt`. Each reject needs its `"reply":"reject"` line within 60 seconds of the decision.
3. **At Finish.** Observe the probe marker again and append it to `$OUT/g5-probe.txt`. Read the file back, then `unplant "$MARK"`, which must print `CLEAN`. `ABSENT` at Finish means the container was recreated since the probe: record G5.4's second observation as `not triggered` and name the P0 digest change.

Verdicts, in the [Results](#results) vocabulary:

- **G5.1.** `fail`: the mode is not `600` or the sha256 changed after an approved ask, or the decision's `state` is not `claimed`. `not triggered`: no `bash` ask names the marker within 180 seconds of the decider starting (`no-ask`), the run does not reach `COMPLETED`, or more than five asks arrive. A model that skips the command, or runs it in a form the `chmod *` pattern does not match, raises no ask. No listed ask is never a pass.
- **G5.3.** `fail`: a decision on the marker's ask returns anything but `200` with `{"state":"claimed"}`. The route also answers `200` for outcomes that settled nothing, so `failed_to_settle` and `unavailable` mean the reject may not have settled. `not triggered`: no `bash` ask names the marker, more than five asks arrive, or a reject has no `permission.replied forwarded` line.
- **G5.4.** `fail`: the mode or the sha256 differs from the plant at any observation after a reject. That also covers a model that makes the same change with an allowed verb; read the run transcript to attribute it, and record the verb as a policy gap. `not triggered`: the marker changed and no ask ever named it, so the command ran unasked.
- **Gate.** `PASS` needs G5.1 to G5.4 all `pass`. `FAIL` when any check fails, `INCOMPLETE` when any is `blocked` or `not triggered`, as the Results rules say.

False-pass controls:

1. No listed ask is never a pass. Each run needs an ask that names its own marker.
2. The control proves the observer reads the container the run uses. The baseline read after each plant proves the marker exists at `644`.
3. A late execution would show at terminal plus 30 seconds and again at Finish, after the other gates.
4. The reject is delivered, not assumed: the state must be `claimed` and the gateway log must show the reply reaching the server. A grant cannot answer the probe's ask: the gateway keeps grants per run, and these runs are new.
5. The evidence is saved and read back before any marker is removed.
6. A model that retries after a reject raises a new ask with a new request ID. The decider rejects it, and the gate stops at more than five asks.

### Discord pass

Every check that needs a Discord-started run or a human Discord action. Run it in one sitting with the operator present, after the automated gates and before [Finish](#finish), and only when [it is triggered](#when-the-discord-pass-runs). Start it with [P0](#preconditions): no gateway deploy may be in flight, and the running digests must match. The automated gates and the pass can be hours apart, and a same-ref redeploy in between changes the digests. If the digest pair differs from the automated gates' pair, record both pairs in the P0 row. Steps and pass criteria are in the gate sections linked below. Run in this order:

| Order | ID | Check | Steps |
| --- | --- | --- | --- |
| 1 | DP.1 | Mention intake and reply | below |
| 2 | G2a.1–G2a.4 | Trigger role denial and the idle-channel cancel | [Gate 2](#gate-2-fro-bot-cancel) |
| 3 | G2b.2 | Thread notice on a dashboard cancel (run C1-D) | [Gate 2](#gate-2-fro-bot-cancel) |
| 4 | G2d | Targeting rows; the `run-finished` row uses the C1-D thread | [Gate 2](#gate-2-fro-bot-cancel) |
| 5 | G2c | Discord cancel first, dashboard cancel second (run C2) | [Gate 2](#gate-2-fro-bot-cancel) |
| 6 | G4a–G4f | Attribution rendering | [Gate 4](#gate-4-attribution-rendering) |

**DP.1.** Pass: the run is `COMPLETED` and a bot message in its thread contains `$TAG-OK`.

**Operator action (DP.1):** post in the bound channel: `@fro-bot reply with exactly the word $TAG-OK and nothing else`. The agent finds the run and its thread:

```bash
for k in $(runkeys "$OWNER_REPO" 2); do s3cat "$k" | jq -c '{run_id, phase, thread_id, started_at}'; done
thread <thread_id>
```

Use the newest record that started after the mention. Wait for `COMPLETED`, then expect a bot message containing `$TAG-OK`.

When the pass does not run, report every row above as `not run` in the [Results](#results), with the ref of the anchor.

### Finish

1. Run G1.11 cleanup if it has not run. Make the Gate 5 final observation and remove its marker if that has not run (step 3 of [Gate 5](#gate-5-rejected-command-does-not-run)). Then run the `/dev/null` check from [Rules](#rules).
2. Close the shared connection and remove the key: `ssh -O exit -o ControlPath="$WORK/cm" "root@$GATEWAY_HOST"; rm -rf "$WORK"`.
3. Save matched log lines, record JSON and thread dumps under `/tmp/gateway-acceptance-<REF>/`. Read the saved files back before recording a result.

### Results

Per-check results use `pass`, `fail`, `blocked`, `not reproduced`, `not triggered`, `not automated`, or `not run`. `not run` marks a [Discord pass](#discord-pass) check on a release where the pass did not run; it names the ref of the anchor and counts toward no gate status. A gate is `PASS` when every check that ran passes or is named `not reproduced` above, `INCOMPLETE` when any check is `blocked` or `not triggered`, and `FAIL` when any check fails. A gate whose checks are all `not run` reports `not run`.

The `Discord pass:` line is required. Its three forms are below; `<ref>` is the anchor, or `never` when no pass has passed. Only a `PASS` line moves the anchor.

```text
Discord pass: PASS on <REF> (trigger: <item>)
Discord pass: <FAIL|INCOMPLETE> on <REF> (trigger: <item>); last passed on <ref>
Discord pass: not run (trigger: none); last passed on <ref>
```

`<item>` is the deciding item from [When the Discord pass runs](#when-the-discord-pass-runs): `never passed`, `stale (<n> refs)`, the matching checklist path or pin line, or `trigger check failed`. Post this in the release tracker:

```text
Live acceptance: agent <REF> (OpenCode V2 <OCV>). Run by <operator>, <date>.

Discord pass: <one of the three lines above>

Preconditions:
- P0 running digests match the build: [PASS/FAIL]
  <gateway sha256:<8 hex>…, workspace sha256:<8 hex>…, deploying run <runId>; re-verified before each gate: [yes/no]>
- P1 WORKSPACE_IMAGE_OPENCODE_VERSION = <OCV>: [PASS/FAIL]
- P2 box idle before each restart: [yes/no]
  <number of restarts, idle_check result for each>

Gate 1, stale-credential removal on V2: [PASS/FAIL]
  <stale auth.json ABSENT after restart; symlink gone, target sha256 unchanged; /readyz 200 after both restarts; credentials provisioned (count N); dashboard run <runId> final output frame contained <TAG>-OK; no "cannot remove stale auth.json"; cleanup CLEAN>

Gate 2, /fro-bot cancel: [PASS/FAIL/not run]
  <G2b.1 (run C1 <runId>): dashboard cancel, CANCELLED, cancelledBy web-operator. Discord pass rows, or "not run, last passed on <ref>": (a) denial copy with the operator's trigger role removed, no cancel: log line; restored role reached no-executing-run; (b) G2b.2 (run C1-D <runId>): notice text "<exact>", in the thread, no mentions; (c) G2c (run C2 <runId>): in-flight collapse, Discord first, log "cancel already requested", one notice, CANCELLED, cancelledBy discord-user; (d) G2d rows matched: <list>; not reproduced: <list>>

Gate 3, ownership persistence and restart: [PASS/FAIL]
  <ownedSessionIds non-empty mid-run; adoption lines seen; no persist failure or 412 in the run window; COMPLETED record has rootSessionId set and ownedSessionIds []; same ETag after gateway restart; run still listed>

Gate 5, rejected command does not run: [PASS/INCOMPLETE/FAIL]
  <control run <runId>: ask named the marker, approved once, state claimed, mode 600 at terminal+30s; collapsed card label "Run, status: Succeeded". Probe run <runId>: asks <n>, each reject state claimed with a forwarded reject in the log, mode 644 and sha256 unchanged at terminal+30s and at Finish; cleanup CLEAN. Scope: one listed verb on one path, not unlisted commands>

Mention intake and reply (DP.1): [PASS/FAIL/not run]
  <run <runId> COMPLETED, bot message in the thread contained <TAG>-OK, or "not run, last passed on <ref>">

Gate 4, attribution rendering: [PASS/INCOMPLETE/FAIL/not run]
  <Discord approve/deny/question: plain titles, <@id> descriptions, no mentions on the edits. Dashboard approve, deny and question: cards listed under the run ID, decided in the dashboard, Discord cards end `(dashboard)`, no mentions. Question rows G4e and G4f: no raw question input in the thread (raw 0, final reply identified, scanned below 50). Or "not run, last passed on <ref>">

Drift: <pin vs tracker differences, or none>

Other observations:
- <anything new>
```
