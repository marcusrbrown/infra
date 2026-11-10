---
title: "Gate a human-only release check on a last-pass anchor and a diff trigger, not on a passive ledger"
date: 2026-11-10
problem_type: best_practice
component: development_workflow
severity: medium
module: docs/runbooks
applies_when:
  - "A release gate has checks that only a human can run, such as Discord clicks and slash commands"
  - "A proposal tracks pending human verification in a new state store or with a timer"
  - "A gate check was written around a Discord-started run but exercises code with no surface branch"
tags: [release-gates, discord-pass, anchor, staleness, fail-closed, gateway, dashboard, human-in-the-loop]
---

# Gate a human-only release check on a last-pass anchor and a diff trigger, not on a passive ledger

## Context

Every gateway release gate used to start from an operator `@fro-bot` mention, and Gates 2 and 4 needed slash commands, a role toggle and button clicks. So every release needed a scripted Discord session. The agent cannot do these steps. The gateway ignores bot-authored messages (the `message.author.bot` guard in the `messageCreate` handler of `packages/gateway/src/program.ts` in fro-bot/agent), Discord accepts slash commands and button clicks only from users, and the `DISCORD_TOKEN` that the repo's Discord MCP reads is the gateway's own bot token, so anything sent with it is bot-authored.

## Guidance

**Split the checks by what they need.** A dashboard launch and a Discord mention reach the same `launchWork` entry in fro-bot/agent, and the ownership code has no surface branch. So any check that needs a run but no Discord action runs on a dashboard-launched run, on every new upstream ref, with no human:

- G1 and G3 run on dashboard runs. A dashboard run has no thread, so G1.10 reads the reply from the final `output` frame (`final: true`) of `GET /operator/runs/:runId/stream`, not from a thread. An empty final frame fails.
- G2b.1 checks only the run record, because a dashboard run posts no cancel notice.
- Checks that read a thread or a Discord card stay with a human: the mention reply, the cancel notices, the targeting rows, and every G4 card. That includes the dashboard-decided G4c, G4d and G4f, because only a Discord-started run has a card to edit.

**Run the human pass only when a trigger fires.** The order is in [When the Discord pass runs](../../runbooks/operator-surface-acceptance-automated.md#when-the-discord-pass-runs): no anchor (`never passed`), any error in the trigger check itself, an anchor 3 or more release tags old, or a compare file that matches the [checklist](../../runbooks/operator-surface-acceptance-automated.md#discord-pass-checklist). If none holds, every Discord row reports `not run` and names the anchor.

**Keep the only state in one required result line.** Every Results comment in the release tracker carries a `Discord pass:` line in one of three forms ([Results](../../runbooks/operator-surface-acceptance-automated.md#results)). The anchor is the ref of the newest `PASS` line. Only `PASS` moves it, so after a failed or incomplete pass the next release is judged against the same baseline. The reader paginates (the tracker is past 200 comments) and counts only owner, member and collaborator comments, so a drive-by comment cannot move the anchor. A missing line means `never passed`.

## Why This Matters

The first design waited for evidence from normal Discord use and kept a ledger of pending, passed and unverified checks with a time limit. Review rejected it, for three reasons:

- Normal use never produces the staged checks: a removed trigger role, the Discord-then-dashboard cancel race, the targeting threads, and dashboard decisions on a Discord-started run. Those rows would have ended as "unverified", which is a label, not evidence.
- No component runs a timer, so a time limit would never fire.
- A ledger reset on every digest change erases the record of what was never checked.

The anchored design adds no store, timer or schedule. It asks for a human only when the diff or the anchor's age calls for one, and the release record shows what was skipped.

## When to Apply

- A gate has human-only checks, and you can name from the diff which paths put them at risk.
- A long run of `not run` results would be the dangerous failure, so a staleness bound is needed.
- A check is written around one surface: first ask whether the code under test branches on surface.

## Examples

- First use: agent v0.137.0. The trigger was `never passed`, the automated gates passed on 3 dashboard launches, and the Discord pass passed in one sitting, which set the first anchor.
- A hand-made thread under an unbound channel answers `unbound-channel`, not `not-a-run-thread`. Make the G2d thread in the bound channel.

## Related

- [GitHub's compare endpoint lists at most 300 changed files](../integration-issues/github-compare-api-300-file-cap-fail-closed-trigger-check-2026-11-10.md)
- [Gateway release gates](../../runbooks/operator-surface-acceptance-automated.md#gateway-release-gates-agent-run)
- Requirements: `docs/brainstorms/2026-11-09-gateway-release-gates-discord-pass-requirements.md`; plan: `docs/plans/2026-11-09-001-feat-gateway-release-gates-discord-pass-plan.md`
