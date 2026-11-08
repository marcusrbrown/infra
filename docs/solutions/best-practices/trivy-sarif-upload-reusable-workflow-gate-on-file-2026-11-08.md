---
title: "Upload Trivy SARIF from a reusable workflow: gate on the file, not hashFiles"
date: 2026-11-08
module: .github/workflows/deploy-gateway.yaml
problem_type: best_practice
component: development_workflow
severity: medium
applies_when:
  - "A reusable workflow writes a file outside GITHUB_WORKSPACE and a later step must consume it conditionally"
  - "Adding security-events: write to a job inside a reusable workflow"
  - "Triaging Trivy code-scanning alerts on the gateway or workspace images"
tags: [github-actions, trivy, sarif, code-scanning, reusable-workflows, hashfiles, permissions]
---

# Upload Trivy SARIF from a reusable workflow: gate on the file, not hashFiles

## Context

The deploy router `deploy.yaml` calls `scan-images` in `deploy-gateway.yaml` as a reusable workflow. That job scans the gateway and workspace images by digest. On `main`, it also writes SARIF and uploads it to code scanning under the `trivy-gateway` and `trivy-workspace` categories (#1815, PR #1836). The job is report-only and never blocks a deploy.

## Guidance

**Gate the upload on the file itself.** `hashFiles()` only sees `GITHUB_WORKSPACE`. SARIF written to `$RUNNER_TEMP` is outside that directory, so a `hashFiles` guard returns an empty string and skips every upload without an error. The generating step checks the file and exports a flag instead:

```bash
if [[ -s "$sarif_file" && -r "$sarif_file" ]]; then
  echo "path=$sarif_file" >> "$GITHUB_OUTPUT"
  echo "ready=true" >> "$GITHUB_OUTPUT"
else
  echo "::warning::No SARIF report was produced for infra-gateway@$GATEWAY_DIGEST; code scanning was NOT updated, so this is not a clean scan"
  echo "ready=false" >> "$GITHUB_OUTPUT"
fi
```

The upload step runs only when `github.ref == 'refs/heads/main' && steps.gateway-sarif.outputs.ready == 'true'`. The warning ensures a skipped upload never reads as a clean scan.

**Grant the scope on the caller too.** `security-events: write` on `scan-images` must also appear on the router's `deploy-gateway` caller job, next to `contents` and `packages`. The permission-parity test in `packages/cli/src/conventions.test.ts` checks the caller grant. See [Reusable workflow permission parity](../workflow-issues/reusable-workflow-permission-parity-startup-failure-2026-09-01.md).

**Things that are not needed.**

- `actions: read`, because the repo is public.
- A checkout. `upload-sarif` falls back to `GITHUB_SHA` and `GITHUB_REF`.

**Keep it non-blocking.**

- Trivy runs with `--exit-code 0`.
- The job keeps `continue-on-error: true`.
- Each upload step also has `continue-on-error: true`, so a failed gateway upload doesn't skip the workspace scan.

## Why This Matters

A `hashFiles` guard on `$RUNNER_TEMP` fails silently. The pipeline stays green and code scanning shows nothing. A missing caller grant takes down the whole deploy router, not just the scan.

## When to Apply

- Any step that consumes a file another step wrote under `$RUNNER_TEMP`.
- Any new `permissions:` scope on a job inside a reusable workflow.
- Triage of Trivy alerts on `ghcr.io/marcusrbrown/infra-gateway` or `infra-workspace`.

## Examples

**Triaging findings.** Check whether a finding is in the base image before changing infra dependencies. The first alerts were all in the npm CLI that ships with the Node base image (`usr/local/lib/node_modules/npm/node_modules/`). That fix belongs in the upstream `fro-bot/agent` Dockerfiles; fro-bot/agent#2117 tracks it.

**Exercising the scan.** On a push, the router's gateway filter matches `apps/gateway/**` except Markdown, tests, fixtures and snapshots, so a workflow-only push does not run the scan. To exercise it, dispatch `deploy-gateway.yaml` on `main`, then reject the approval gate. The scan runs before the gate.
