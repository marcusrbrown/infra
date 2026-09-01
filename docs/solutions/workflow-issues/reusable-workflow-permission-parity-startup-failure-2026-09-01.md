---
title: Reusable workflow permission parity causes deploy router startup failure
date: 2026-09-01
category: docs/solutions/workflow-issues
module: infra
problem_type: workflow_issue
component: development_workflow
root_cause: config_error
resolution_type: code_fix
severity: critical
symptoms:
  - 'Deploy router run is startup_failure with zero jobs created'
  - 'GitHub reports "This run likely failed because of a workflow file issue"'
  - 'Direct workflow_dispatch of the same callee succeeds while the router call fails'
tags:
  - github-actions
  - reusable-workflow
  - permissions
  - startup-failure
  - deploy
  - workflow-call
---

# Reusable workflow permission parity causes deploy router startup failure

## Diagnostic signature

The deploy router run is **`startup_failure`** with zero jobs created, and GitHub reports
**"This run likely failed because of a workflow file issue"**. The same callee succeeds under a
direct `workflow_dispatch` but fails when invoked through `workflow_call`. That discriminator
points to the caller/callee boundary rather than the callee's deploy logic.

## Cause

A reusable workflow's jobs cannot request a `GITHUB_TOKEN` permission scope that its caller does
not grant. The caller's job-level `permissions:` block caps the callee's workflow-level and
job-level permissions; a job-level block replaces, rather than merges with, the caller workflow's
top-level block.

## Why local checks miss it

`actionlint` has no cross-workflow permission-cap check, and both workflow files parse as valid
YAML. Add a repository convention test that resolves local reusable-workflow calls and verifies
that each caller's effective grant covers the maximum permission demand of its callee.

## Pre-merge verification

Dispatch the router on a branch:

```sh
gh workflow run deploy.yaml --ref <branch>
```

Jobs being created at all proves startup validation passed. Non-`main` refs are refused at the
per-app Environment branch policy with zero steps executed, so nothing deploys.

## Prior art

The underlying permission rule was documented in June 2026 in
`docs/solutions/best-practices/off-droplet-docker-image-build-gateway-deploy-2026-06-04.md`,
but documentation alone did not prevent recurrence. The executable parity check is the guardrail.
