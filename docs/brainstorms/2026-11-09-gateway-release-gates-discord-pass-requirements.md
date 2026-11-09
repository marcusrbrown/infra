---
date: 2026-11-09
topic: gateway-release-gates-discord-pass
---

# Gateway Release Gates: Automated Gates and a Triggered Discord Pass

## Summary

Each gateway release runs the release gates that don't need Discord with no human, using dashboard-launched runs. The checks that need Discord form one Discord pass, and that pass runs only when the release diff touches code on that path or the last pass is three upstream refs old. In every other case the result reports the Discord checks as not run and names the ref where they last passed.

---

## Problem Frame

The gateway release gates in `docs/runbooks/operator-surface-acceptance-automated.md` ("Gateway release gates (agent-run)") run after each gateway upstream bump. Every gate starts its runs with an operator `@fro-bot` mention. Gates 2 and 4 also need the operator to run `/fro-bot cancel`, toggle the trigger role, or click Discord buttons. Each release therefore pulls the operator into a scripted Discord session, even when nothing on the Discord path changed. The v0.136.2 pass ended INCOMPLETE partly on these rows.

An agent-held identity cannot do these steps:

- The gateway drops every message written by a bot before it checks any role (fro-bot/agent v0.136.5 `packages/gateway/src/program.ts:908`). A second bot, a webhook, or the Discord MCP therefore cannot start a run. The token the MCP reads is Fro Bot's own application token.
- Discord accepts slash commands and component clicks only from users. A bot cannot click Approve or Deny, answer a question card, or run `/cancel`.

Waiting for evidence from normal Discord use does not work either. Most Discord checks need staged setup that normal use never produces: removing the trigger role, the Discord-then-dashboard cancel race, the targeting threads, and dashboard decisions on a Discord-started run.

The dashboard reaches the shared engine. Dashboard cancels and decisions run the same cancel, approval and question code as Discord. A dashboard-launched run has no Discord thread, though, so only a Discord-started run exercises the thread notice and card edit branches.

---

## Requirements

**Automated gates, every release**

- R1. G1 (stale credential removal) and G3 (ownership persistence and restart) run on dashboard-launched runs, with no operator action.
- R2. G1.10 proves the model still answers after the restart. It reads the dashboard run's reply for the marker, not a Discord thread message.
- R3. G2b's run-record checks (phase, `cancelledBy`) run on a dashboard-launched run. Its thread-notice check moves to the Discord pass.

**Discord pass**

- R4. The Discord pass is every check that needs a Discord-started run or a human Discord action: mention intake and reply, G2a, the G2b thread notice, G2c, G2d, and G4a–G4f. It runs as one operator sitting, using today's runbook steps and pass criteria.
- R5. The Discord pass runs when the upstream diff since the last Discord pass touches any of these:
  - Discord intake, approval or question cards, or `/cancel`
  - shared run, cancel, approval or question-settlement code
  - discord.js
  - OpenCode
- R6. The Discord pass also runs when the last Discord pass is three or more upstream refs before the release under test.
- R7. The runbook carries a written checklist for the R5 judgement. The release result records which item triggered the Discord pass, or that none did.
- R8. When the Discord pass does not run, the release result reports each Discord check as not run and names the ref of its last pass.

**Scope of a release**

- R9. A release is a new upstream ref. A redeploy at the same ref produces new image digests but runs no gates. The P0 digest checks of the next release cover it.

**Runbook**

- R10. The runbook marks each gate check as automated or Discord pass. It states that the gateway gates take their own hour of launch budget, separate from the browser pass.

---

## Acceptance Examples

- AE1. **Covers R1, R2, R8.** A release changes only the workspace image and the Discord pass last ran one ref earlier. The automated gates pass with no operator action. The result reports the Discord checks as not run and names the ref where they last passed.
- AE2. **Covers R5, R7.** The upstream diff changes approval-card rendering. The agent runs the Discord pass in the same sitting, and the result names the approval-card item as the trigger.
- AE3. **Covers R6.** The last Discord pass was three refs ago and the diff touches no R5 item. The agent runs the Discord pass anyway, and the result records the age as the trigger.
- AE4. **Covers R9.** A same-ref redeploy changes the digests. No gates run. The next release's P0 checks verify the digests it actually runs.

---

## Success Criteria

- A gateway release whose diff touches no R5 item, and whose last Discord pass is fewer than three refs old, reaches a result with no operator action.
- No release result claims a Discord check passed without a Discord pass on that ref. Every result names when the Discord checks last passed.
- A planner can tell which group each runbook check belongs to and what triggers the Discord pass.

---

## Scope Boundaries

- A second Discord bot, a test guild, enabling the Discord MCP, or a user token. Each one acts as a bot or breaks the Discord terms.
- An upstream opt-in that would let an acceptance bot trigger runs.
- Passive confirmation from the operator's normal Discord use.
- Running the gates in CI or on a schedule. Acceptance stays agent-run after a deploy.
- The dashboard browser pass in the same runbook, and `docs/runbooks/operator-surface-acceptance.md`.

---

## Key Decisions

- Drop passive confirmation. Most Discord checks need staged setup, so waiting would mostly produce "unverified" labels and would need a timer that no component runs.
- Trigger on what the diff touches, not on Discord files alone. Discord-started runs use the same cancel, approval and question code as dashboard runs, through branches the dashboard gates never exercise.
- Bound staleness at three upstream refs. A rarely changed Discord path still gets checked against current dependencies and base images.
- Evaluate both triggers at acceptance time. The last pass's ref is the only state to keep.

---

## Dependencies / Assumptions

- A dashboard-launched run records ownership the same way as a Discord-started run, so G3 still proves persistence. This is unverified.
- Upstream unit tests cover the Discord handlers with hand-built fakes, but no test covers dropping messages written by bots.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R1][Needs research] Confirm at the pinned upstream ref that a dashboard-launched run takes the G3 ownership path.
- [Affects R6, R8][Technical] Where the last Discord pass's ref is recorded, so the next acceptance can read it.
- [Affects R5, R7][Technical] Which upstream paths and dependency names the R5 checklist lists.
