---
date: 2026-06-30
topic: harness-credential-broker
---

# Harness Merge-Agent Credential Broker

## Summary

Stand up a token broker in front of cliproxy that mints a short-lived, narrowly-scoped credential for each harness integration run, authenticated by the run's GitHub OIDC identity. The runner receives only an expiring, single-purpose token; the durable provider key never leaves the broker boundary.

---

## Problem Frame

The `fro-bot/agent` harness release pipeline runs an autonomous LLM merge agent to resolve the OpenCode upstream carry set during integration. That merge runs on a bare `ubuntu-latest` GitHub-hosted runner, and the durable model-provider credential is written to disk there (`~/.local/share/opencode/auth.json`, mode `0600`, owned by `runner`). The agent's `bash` tool runs as the same `runner` user, so the file mode gives no protection — a `cat` returns the raw key. The integrate job has unrestricted network egress, so a credential that can be read can also be exfiltrated anywhere.

The agent processes untrusted upstream carry refs (`refs/pull/N/head` from `anomalyco/opencode`), so this is a live prompt-injection surface. For the duration of the merge, both read and exfiltration of the durable key are open. The `fro-bot/agent` side can add defense-in-depth, but it cannot remove the root cause: the agent legitimately needs to reach the model, so a usable credential must exist where the agent runs. The only way to make the readable credential low-value is to ensure the thing on the runner is not the durable key.

cliproxy already fronts the provider credentials for this deployment, which makes its boundary the right place to issue and revoke per-run tokens.

---

## Actors

- A1. Harness integrate job: the GitHub-hosted `ubuntu-latest` job in `fro-bot/agent` that runs the merge agent. Presents a GitHub OIDC token and requests a per-run credential. The consuming-side change lives in that repo, not here.
- A2. Credential broker: the infra-owned service that verifies the OIDC token against an allowlist, mints a short-lived cliproxy credential, and revokes it at run end.
- A3. cliproxy: the existing proxy that holds the durable provider/OAuth credentials and serves model traffic for accepted keys.
- A4. Merge agent: the autonomous LLM running inside A1 with a prompt-injection exposure via untrusted carry refs. The threat actor whose blast radius the short-lived token is meant to shrink.

---

## Key Flows

- F1. Mint at job start
  - **Trigger:** The harness integrate job begins.
  - **Actors:** A1, A2, A3
  - **Steps:** A1 obtains a GitHub OIDC token for the run. A1 calls the broker (A2) presenting that token. A2 fully verifies the token (issuer, audience, signature, freshness), rejects replayed assertions, and checks claims against its allowlist. On match, A2 mints a short-lived, capability-bounded cliproxy credential and returns it as the OpenCode `auth.json` payload.
  - **Outcome:** The runner holds only a short-lived, single-purpose token valid against cliproxy. The durable key is not on the runner.
  - **Covered by:** R1, R2, R3, R4, R5, R6, R7, R8

- F2. Use during merge
  - **Trigger:** The merge agent makes model calls.
  - **Actors:** A4, A3
  - **Steps:** The agent authenticates to cliproxy with the short-lived token. cliproxy serves model traffic within the token's capability bound for the run.
  - **Outcome:** The merge reaches the model it needs without ever holding the durable credential. The token grants no access beyond that model traffic.
  - **Covered by:** R8

- F3. Expire / revoke at run end
  - **Trigger:** The run finishes (success, failure, or cancellation).
  - **Actors:** A1, A2
  - **Steps:** The token reaches its short TTL and/or the run signals completion so the broker revokes it. For a run that crashes or cancels without signalling, a broker-side sweeper revokes by run identity. After expiry or revocation, presenting the token to cliproxy fails.
  - **Outcome:** A token read and exfiltrated during the run is useless once the run ends; it cannot be replayed for general provider access.
  - **Covered by:** R9, R10, R11

---

## Requirements

**Credential isolation**
- R1. The durable model-provider credential must never be present on the harness integrate runner at any point during a run.
- R2. The runner-side credential must be a short-lived token usable only against cliproxy, carrying no durable or general provider access.
- R3. The broker must return the credential as an OpenCode `auth.json` payload the harness can consume directly. The exact field layout is pinned during planning against the harness action contract; the harness-side injection of that payload is the deferred consuming-side work (`fro-bot/agent#1060`), not this broker.

**Mint authentication and authorization**
- R4. The broker must authenticate each mint request using the run's GitHub OIDC token — it must not rely on a shared, durable mint secret presented by the runner.
- R5. The broker must fully verify the OIDC token before minting: GitHub issuer, a broker-specific audience, signature against GitHub's published keys, and token freshness/expiry. A token failing any check mints nothing.
- R6. The broker must reject replay of an OIDC assertion — a given assertion mints at most once — so an exfiltrated assertion cannot be re-exchanged for fresh credentials within its validity window.
- R7. The broker must mint only for OIDC identities matching a tight allowlist pinned on repository, workflow, and ref/environment, using only claims whose trust properties have been verified. When a request's claims do not match the allowlist, the broker must refuse to mint.

**Token capability and lifetime**
- R8. The minted token must grant only the model access the merge legitimately needs through cliproxy, and nothing more (no management actions, no general provider access).
- R9. Minted tokens must carry a short TTL scoped to the expected run duration, after which cliproxy rejects them.
- R10. A minted token must be revocable, and revocation/expiry must take effect such that replay after the run ends fails against cliproxy.
- R11. TTL must be the mandatory backstop, and a broker-side sweeper keyed by run identity must revoke tokens for runs that crash or cancel without signalling completion, bounding how long a token outlives a failed run.

**Operational safety**
- R12. The mint and revoke paths must never print, log, or otherwise surface token material, OIDC assertions, or the durable secret.
- R13. The broker must emit structured audit events for mint, deny, and revoke decisions carrying run identity and decision metadata only — never token bodies, assertions, or secrets.
- R14. The broker must hold the durable credential within its own boundary only, never passing it to the runner or embedding it in a minted token.

---

## Acceptance Examples

- AE1. **Covers R4, R5, R7.** Given an OIDC token whose issuer, audience, signature, and freshness all verify and whose claims match the pinned repository, workflow, and ref/environment, when the integrate job requests a credential, the broker mints a short-lived cliproxy token.
- AE2. **Covers R7.** Given an OIDC token from the allowlisted repository but a different workflow, when a mint is requested, the broker refuses and mints nothing.
- AE3. **Covers R6.** Given an OIDC assertion that already minted once, when it is presented again within its validity window, the broker refuses the second mint.
- AE4. **Covers R8.** Given a valid minted token, when it is used against cliproxy for a non-model or management action, the request is denied; only the merge's model traffic is served.
- AE5. **Covers R9, R10.** Given a token minted for a run, when the run ends and the token is presented to cliproxy afterward, the request fails.
- AE6. **Covers R11.** Given a run that crashes without signalling completion, when the sweeper interval elapses, the run's token is revoked and subsequent use against cliproxy fails.
- AE7. **Covers R1, R2.** Given a completed run, when the runner filesystem and environment are inspected, no durable provider credential is present — only the (now-invalid) short-lived token.

---

## Success Criteria

- A read-plus-exfiltration of the runner-side credential during a harness merge yields only a near-expiry, capability-bounded, cliproxy-only token that cannot be replayed for general provider access after the run ends.
- Within a run's TTL window, the token a prompt-injected agent could spend reaches only the merge's model traffic through cliproxy — not management actions or general provider access. The broker shrinks the in-run blast radius; it does not stop an injected agent from using the token it legitimately holds during the run.
- The merge agent still reaches the model it needs throughout the run.
- A downstream implementer can build the broker and its cliproxy integration from this doc without having to decide the trust model, the credential lifetime semantics, or where the durable key lives — those are settled here.

---

## Scope Boundaries

- Egress containment for the integrate job (constraining outbound reach to {cliproxy, github, npm}) is a separate, tracked follow-up. The broker alone satisfies this doc's acceptance criteria by making a stolen token low-value; egress containment is additive defense, handled as its own unit.
- The consuming-side workflow change in `fro-bot/agent` (requesting the OIDC token, calling the broker, passing only the minted token to the action) is out of scope here. It is tracked in `fro-bot/agent#1060` and picked up there via a `@fro-bot` mention once this broker ships.
- In-repo defense-in-depth on the `fro-bot/agent` side (env hygiene, the residual exposure write-up) lives in `fro-bot/agent#1060`, not here.
- Replacing the static cliproxy bearer-key model for other consumers is out of scope; this is a new per-run path, not a migration of existing keys.

---

## Key Decisions

- What the broker does and does not defend: it removes durable-key theft — the runner never holds a credential worth stealing past the run. It does not stop a prompt-injected agent from spending the token it legitimately holds during the run. Containing that in-run capability is the job of the token's capability bound (R8) and the deferred egress containment, not the broker's existence. The success metric is in-run blast radius, not "the agent can never make a model call".
- Broker in front of cliproxy, not a fork of the upstream proxy: cliproxy is consumed as a pinned, Renovate-tracked Docker image (`apps/cliproxy/AGENTS.md`). Forking it to add native token minting would kill image-pin tracking and add a Go build pipeline, fighting the repo's "pin the upstream image" model. A small infra-native (TypeScript) broker keeps the change in the repo's stack and off the pinned image.
- Broker over extending cliproxy's static management API in place: the existing `/v0/management/api-keys` surface mints and deletes static keys with no TTL, run-binding, capability scope, or OIDC verification. Driving per-run mint/revoke purely through that API (a pre-job add, an `always()` delete) was considered and set aside: TTL would be only as strong as a cleanup step that crashed runs skip, and whatever calls the API still needs the management key in a trusted context — recreating the trust problem the broker exists to solve. The broker centralizes OIDC verification, capability bounding, and sweeper-backed revocation in one owned component instead.
- GitHub OIDC over a shared mint secret: OIDC binds the mint to the specific run's identity, so there is no durable shared secret on the runner to steal or replace. This is the property that lets the runner-side credential stay low-value.
- Tight allowlist (repository + workflow + ref/environment) over repo-only: the merge agent is a prompt-injection surface, so minting must be restricted to the one trusted pipeline's identity rather than any workflow in the repo. The trade-off is that restructuring or renaming that pipeline breaks minting until the allowlist is updated — an acceptable cost for the smaller blast radius.
- The broker holds the durable key, not the runner: this moves the secret to a controlled boundary rather than eliminating it, and makes the broker a high-value target that must be hardened (R-level: secret custody, minimal surface, its own rotation path). A usable credential must exist somewhere the agent can reach the model through; the boundary the agent does not run inside is the right home.

---

## Dependencies / Assumptions

- cliproxy must accept and validate the minted short-lived token, enforce its capability bound, and reject it after expiry/revocation. The current management surface (`packages/shared/cliproxy/management.ts`, `/v0/management/api-keys`) is static bearer-key management with no native TTL, run-binding, capability-scoping, or token-exchange primitive — verified against source. Adding the per-run validation/expiry/capability path is a dependency this work must resolve.
- GitHub OIDC issues a token for the harness job whose claims include repository, workflow, and a ref/environment identifier suitable for the allowlist. Which exact claims are reliable versus forgeable is a planning-time verification.
- The broker becomes the new custodian of the durable provider/OAuth credential, which makes it a high-value compromise target. Its deployment home must give it a hardened, isolated boundary (secret custody, minimal surface, its own rotation/incident path); that hardening is in scope for this work even though the deployment topology is settled during planning.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R9, R10][Technical] Where the per-run token's TTL and revocation are enforced — inside cliproxy's accepted-key validation, in the broker as a gate in front of cliproxy, or both — and what state the broker keeps (e.g., a hash plus server-side metadata) to drive revocation.
- [Affects R4, R5, R7][Needs research] Which GitHub OIDC claims to pin (`repository`, `workflow_ref`, `job_workflow_ref`, `environment`, `ref`) and their reliability guarantees, before fixing the exact allowlist shape.
- [Affects R8][Technical] How cliproxy enforces the token's capability bound — which operations a minted token may and may not perform — given the current static bearer-key model treats accepted keys uniformly.
- [Affects A2][Technical] Where the broker runs and how it deploys (extend the cliproxy stack versus a separate service) and how it holds the durable credential.
- [Affects R11][Technical] The sweeper's interval and how it learns run state (GitHub run status versus a broker-tracked lease), setting the maximum post-crash token lifetime.
- [Affects R3][Technical] The exact OpenCode `auth.json` field layout, confirmed against the harness action contract.

---

## Sources / Research

- `fro-bot/agent#1060` — the root-cause exposure and in-repo defense-in-depth tracking; this broker is the infra-side fix. Update with a `@fro-bot` mention when the broker ships.
- This repo's issue #725 — the originating request and Fro Bot triage (verified against code: static key management only, no TTL/exchange primitive; `.github/workflows/fro-bot.yaml` passes `OPENCODE_AUTH_JSON` durably).
- `packages/shared/cliproxy/management.ts`, `apps/cliproxy/AGENTS.md` — current cliproxy management surface and deploy contract.
- `apps/gateway/src/deploy.ts` — existing `WORKSPACE_EGRESS_HOSTS` mitmproxy allowlist, a reference for the deferred egress-containment follow-up (gateway workspace topology, not directly reusable for a GitHub-hosted job).
