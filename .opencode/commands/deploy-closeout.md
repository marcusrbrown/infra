---
description: Close out a merged infra deploy through its approval gate and verify the live service
---

# Deploy Close-out

<target>
$ARGUMENTS
</target>

Close out the merged deployment described by `<target>`. Expected input is an app name and optionally a PR number, merge commit, or workflow run ID (for example: `dashboard PR #954` or `gateway run 30208274363`). If the app is missing or ambiguous, ask one targeted question before continuing.

## Workflow

1. **Load the app contract**
   - Read `apps/<app>/AGENTS.md` and the relevant deploy workflow/script before making assumptions.
   - Identify the app's environment name, deploy workflow, health/status command, and post-deploy verification ritual.

2. **Verify merge and deployment identity**
   - Confirm the PR is merged when a PR is provided.
   - Record the merge commit SHA.
   - Locate the aggregate `deploy.yaml` run and the routed `deploy-<app>` job for that exact SHA.
   - Do not treat a similarly named or newer run as evidence for the requested deployment.

3. **Respect the environment gate**
   - If the deploy is waiting for GitHub Environment approval, report the run/job URL and exact environment gate.
   - Never approve an environment, trigger a deploy, rerun/cancel a workflow, merge a PR, or enable automerge without explicit approval for that action.
   - Use the question tool for the approval boundary, then stop until the user responds.

4. **Monitor to terminal state**
   - After the user approves the gate, monitor the exact deploy job until success or failure.
   - Delegate mechanical `gh` run monitoring and bounded log retrieval to a command-execution subagent when available (for example, `fast-generic`); otherwise run bounded read-only `gh` commands directly.
   - On failure, fetch the exact failing step and bounded log excerpt. Report root cause separately from remediation; do not mutate production without approval.

5. **Verify the live service**
   - Run the app's documented status/health checks from `apps/<app>/AGENTS.md` and the infra CLI.
   - Verify the behavior changed by the merged diff, not merely container/process health.
   - Use artifact-specific evidence when relevant:
     - image change: running digest matches the pinned/deployed digest;
     - bind-mounted config or artifact: consuming container/process restarted or reloaded in the deploy window (`StartedAt`, reload timestamp, checksum, or equivalent), and the live endpoint reflects the new behavior;
     - secret/config rotation: readback proves the new state is active without exposing secret values;
     - routing change: probe both the changed route and unchanged control routes, including status and content type where relevant.
   - A green workflow and a correct file on disk are not sufficient proof that the running process loaded the change.

6. **Close out precisely**
   - State a binary result: `COMPLETE` or `NOT COMPLETE`.
   - Separate: deploy result, live verification evidence, and any remaining blocker.
   - Do not suggest unrelated follow-up work. If complete, identify only genuinely pending user actions (for example, a docs-only PR awaiting manual merge).

## Constraints

- This command is read-only except for user-approved actions at explicit gates.
- Do not expose secrets, raw environment values, or unbounded production logs.
- Prefer a repository-search specialist for codebase discovery, a documentation specialist for external/upstream contracts, and an implementation specialist only for a separately approved code change. When named global agents are available, these map to `explorer`, `librarian`, and `fixer`. Do not route diagnosis, architecture, docs research, or code edits to a generic command-execution agent.
