---
title: 'Gateway bash approval gate never fired (OpenCode default-allow); deploy code now owns the policy'
date: 2026-06-28
category: docs/solutions/integration-issues/
module: apps/gateway
problem_type: integration_issue
component: tooling
symptoms:
  - Discord Approve/Deny embed never appeared for bash tool calls
  - Workspace OpenCode executed bash with no permission.asked event
  - Deny-flow smoke test was un-exercisable in production
root_cause: missing_permission
resolution_type: code_fix
severity: high
related_components:
  - development_workflow
tags:
  - gateway
  - opencode
  - permission
  - approval
  - bash
  - discord
  - security-boundary
  - fro-bot
---

# Gateway bash approval gate never fired (OpenCode default-allow); deploy code now owns the policy

## Problem

The Fro Bot gateway runs autonomous OpenCode sessions in a sandboxed workspace, triggered by authorized Discord mentions. Destructive bash commands are supposed to route through a Discord Approve/Deny embed, but the gate never fired — every bash command ran autonomously with no prompt, leaving the human approval path un-exercisable.

## Symptoms

- A prompt asking the agent to run a write/delete shell command completed with `Succeeded`; no approval embed was posted.
- Workspace OpenCode executed `tool="bash"` to `state="completed"` and `/permission?session=…` returned `[]` — no `permission.asked` event was ever emitted.
- The deny-flow smoke test (mention destructive command → Approve/Deny → Deny → clean failed run) could not be run because there was nothing to deny.

## What Didn't Work

- **Assuming the approval UI had regressed in a daemon bump.** It hadn't. The gateway forwards whatever `permission.asked` events OpenCode emits; the workspace simply never emitted one for bash, so there was no event to render. The regression hypothesis was discarded after confirming the workspace OpenCode config.
- **The "deny-by-default" framing from the original follow-up note.** A blanket `"bash": "ask"` would make *every* shell command in *every* autonomous run post an Approve/Deny embed and block up to the run deadline — that destroys the gateway's whole purpose (autonomous execution). The real fix is a pattern policy, not a blanket gate.

## Solution

Two parts: the right policy shape, and moving ownership of that policy into reviewed deploy code.

### Root cause

The workspace OpenCode permission config (carried in the `WORKSPACE_OPENCODE_CONFIG` secret) only set `external_directory` and `doom_loop`. Every other tool — including `bash` — fell back to OpenCode's default of `allow`, so bash ran with no `permission.asked` and no Discord gate. This is the *same* config that an earlier fix added to stop headless runs from hanging on unanswered `external_directory` prompts (see Related) — that fix made runs complete by allowing everything, which is exactly what left bash ungated.

### Policy shape — denylist tripwire

`bash` accepts a pattern→action object. Use `"*": "allow"` (keep ordinary commands autonomous) with destructive commands set to `"ask"` (route through the Discord gate). The catch-all `"*"` **must be the first key**: OpenCode's bash matcher is last-matching-rule-wins, so a trailing `"*": "allow"` would override every destructive rule.

```ts
export const WORKSPACE_PERMISSION_POLICY = Object.freeze({
  external_directory: 'allow',
  doom_loop: 'allow',
  bash: Object.freeze({
    '*': 'allow',
    'rm *': 'ask',
    'rmdir *': 'ask',
    'git push *--force*': 'ask',
    'git push *-f*': 'ask',
    'git push +*': 'ask',
    'git reset --hard*': 'ask',
    'git clean *-f*': 'ask',
    'sudo *': 'ask',
    'chmod *': 'ask',
    'chown *': 'ask',
    'curl *-X POST*': 'ask',
    'curl *-d *': 'ask',
    'curl *-T *': 'ask',
    'wget *--post-data*': 'ask',
    'wget *--post-file*': 'ask',
    'apt install*': 'ask',
    'apt-get install*': 'ask',
    'pip install*': 'ask',
    'npm install -g*': 'ask',
    'npm i -g*': 'ask',
  }),
} as const)
```

### Ownership — deploy code, not the secret

`buildGatewayEnvFileContents` (`apps/gateway/src/deploy.ts`) now overwrites `parsed.permission` with `WORKSPACE_PERMISSION_POLICY` after the existing baseURL-egress validation, re-serializes the config, re-checks the size cap on the injected output, then applies the `$`→`$$` escaping. The secret's `permission` block is irrelevant — code wins. The boundary is auditable in git and cannot silently regress through a secret edit.

## Why This Works

OpenCode's wildcard matcher anchors patterns (`^…$`) and escapes regex metacharacters before substituting `*`→`.*`, so `git push +*` compiles to `^git push \+.*$` — `+` is literal and ordinary `git push` is not over-matched. The bash tool parses the shell line into command *nodes* and matches each node's text, so chaining (`x && rm y`) is split and `rm y` is matched on its own — pattern sprawl chasing `&&`/`;`/`$()` evasion is unnecessary. Setting a command to `"ask"` makes OpenCode publish `permission.asked` and block awaiting a decision, which the gateway renders as the Approve/Deny embed.

This is a **human-in-the-loop tripwire**, not a hard sandbox — glob-on-command-string does not survive adversarial obfuscation (renamed binaries, env indirection, interpreter escapes). The real isolation boundary remains container isolation + mitmproxy egress allowlist + authorized-Discord-users; the permission policy is defense-in-depth.

Production verification — gateway logs for the deny smoke showed the full chain that was previously impossible:
`approvals: permission requested` (permission:bash) → `run-core: permission.asked forwarded` → `confirmReply … reply:reject` (the Deny click) → `run-core: permission.replied forwarded` → `session.idle received — stream complete` (clean finish, no hang). The deployed `.env` carried all patterns with `permission.bash` first key `"*"`, confirming the catch-all-first ordering survived the inject → serialize → compose-interpolation round-trip.

## Prevention

- **Own security boundaries in reviewed code, not opaque secrets.** A policy that lives only in a single-line JSON secret can silently sit wrong (here: bash at default-allow) with no diff to catch it. Inject it from a tracked constant so the boundary shows up in review.
- **Know the default.** In OpenCode, only `external_directory` and `doom_loop` default to `ask`; everything else (including `bash`, `edit`) defaults to `allow`. A `permission` block that lists only those two leaves all tools ungated.
- **Catch-all-first is load-bearing.** Last-match-wins means `"*": "allow"` must precede destructive rules. A test asserts `Object.keys(permission.bash)[0] === "*"`.
- **A change that makes runs *complete* may be disabling a gate.** The prior fix allowed everything to stop hangs; that is the inverse of gating destructive actions. When relaxing permissions to fix one symptom, check what gate you're removing.

## Related Issues

- `docs/solutions/integration-issues/gateway-mention-loop-permission-and-empty-workspace-2026-06-05.md` — the direct parent: added `{"external_directory":"allow","doom_loop":"allow"}` to stop headless hangs, which is the config that left bash at default-allow. Its Fix 1 config guidance is now superseded by the code-owned policy here.
- `docs/solutions/integration-issues/gateway-operator-repos-unmounted-and-keyless-bindings-2026-06-24.md` — adjacent gateway fail-closed gating / denylist precedent.
