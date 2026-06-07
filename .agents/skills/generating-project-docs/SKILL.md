---
name: generating-project-docs
description: Use when creating, refreshing, or updating this repo's agent-facing system docs — ARCHITECTURE.md and STRUCTURE.md, or scoped section updates within them
argument-hint: "[architecture|structure|all|section-name]"
---

# Generating Project Documentation

## Overview

This is a Bun-workspace monorepo of personal infrastructure deploys (apps under `apps/`, shared libraries under `packages/`, a goke CLI, GitHub Actions deploy pipelines, an MCP bridge). Its surface — apps, CLI commands, deploy contracts, pinned upstream versions — changes constantly, so generated docs go stale fast.

**Core principle:** Derive every fact from the live repository. Optimize for an AI agent that needs to orient and make a correct change. Preserve each document's evolved structure. Never regress to a generic template.

If you cannot point at a file or command that justifies a sentence, do not write it.

**Scope:** This skill owns `ARCHITECTURE.md` and `STRUCTURE.md` (root-level, agent-facing system docs). It does NOT own `README.md` — the `/generate-readme` OpenCode command (`.opencode/commands/generate-readme.md`) owns that. When this skill creates ARCHITECTURE.md / STRUCTURE.md, the deep structural content moves OUT of the README into them, and the README links to them.

## When to Use

- Creating `ARCHITECTURE.md` or `STRUCTURE.md` for the first time (neither exists yet)
- Refreshing them after a new app, package, CLI command, or deploy contract lands
- Fixing documentation drift (app/package counts, directory layout, CLI surface, codemap paths)
- Updating a scoped section (e.g. only the `## Codemap` block or the "Where to Add New Code" checklist)

## When NOT to Use

- Updating `README.md` — use the `/generate-readme` command instead
- Writing planning docs (`docs/brainstorms/`, `docs/plans/`, `docs/solutions/`) — those follow their own templates
- Writing per-app operational docs (`apps/*/AGENTS.md`, `packages/*/AGENTS.md`) — those are nearest-context runbooks with their own shape; ARCHITECTURE/STRUCTURE link TO them, they are not regenerated here

## Arguments

```
$ARGUMENTS
```

- **Empty or `architecture`** — Create/update `ARCHITECTURE.md` (default)
- **`structure`** — Create/update `STRUCTURE.md`
- **`all`** — Both docs
- **`<section-name>`** — Update only that named section within the target doc (e.g. `codemap`, `invariants`, `where-to-add`)

For scoped updates: read the current document, locate the section by heading, replace only that section's content. Preserve surrounding structure exactly.

## Pre-Generation Inventory

Before writing anything, gather these from the live repo. Count things; never estimate or carry over from a previous draft or from the README.

| Source | What to extract |
|--------|----------------|
| `ls -d apps/*/` | exact app list (keeweb, cliproxy, gateway, umami, …) |
| `ls -d packages/*/` | exact package list (cli, shared, …) |
| `cat package.json` | workspaces globs, root scripts (`provision:*`, `deploy:*`, `test`, `lint`), version |
| `cat apps/*/package.json packages/*/package.json` | per-workspace name, description, scripts |
| `grep -nE "register[A-Z]" packages/cli/src/cli.ts` | exact CLI command-group registrations |
| `ls packages/cli/src/commands/*/` | per-app subcommand files (status, deploy, …) |
| `find . -name AGENTS.md -not -path '*/node_modules/*' -not -path './.slim/*'` | the real AGENTS.md hierarchy to cross-link |
| `ls .github/workflows/*.yaml` | workflow + deploy-pipeline inventory |
| `cat apps/*/upstream.json 2>/dev/null` | pinned upstream daemon refs (gateway) |
| `git log --oneline -15` | recent change context |
| Current target doc (if it exists) | existing structure, headings, voice |

Use `find ... -exec` or `while IFS= read -r` for shell loops over file lists. Unquoted `for f in $VAR` does not word-split a multiline variable reliably.

Counts and paths MUST come from live `ls`/`find`/`grep`. Exclude `.slim/clonedeps/` (vendored dependency source) from every inventory — it is not part of this repo's structure.

## AI-Agent Optimization Rules (Non-Negotiable)

These docs are read by coding agents that need to make a correct change fast. Optimize for retrieval and action, not prose.

1. **Codemap by symbol/path, never by line number.** Reference `apps/gateway/src/deploy.ts` and the `main()` export, not "line 240". Line numbers rot on the next edit; agents symbol-search.
2. **Invariants stated as enforceable rules.** Phrase as constraints an agent can self-check: "Only `apps/keeweb/deploy.sh` is Bash", "Never pass secret bytes via argv", "`apps/` is deployable units; `packages/` is reusable libraries — `packages/` never imports from `apps/`". Mirror the `(enforced)` anti-patterns already in root `AGENTS.md`.
3. **Prescriptive "Where to Add New X".** Don't just list what exists — give the step-by-step pattern: "New app → create `apps/<name>/`, mirror `apps/cliproxy/` (compose + `src/deploy.ts` + `server/provision-droplet.ts`), add to `package.json` workspaces, add `provision:<name>`/`deploy:<name>` root scripts, add `apps/<name>/AGENTS.md`, add a `deploy-<name>.yaml` workflow."
4. **Tables for codemap and key-file lookup** (agents parse `| role | path |` better than prose). Prose for data flow and rationale.
5. **Cross-link to nearest-context AGENTS.md.** Each app/package has its own `AGENTS.md` runbook. ARCHITECTURE/STRUCTURE point at them for operational detail and do not duplicate it.
6. **State the boundary upfront.** Each doc opens by saying what it covers and where to go for the rest: "This describes system shape and invariants. For deploy procedures see `apps/<name>/AGENTS.md`; for the CLI surface see `packages/cli/AGENTS.md`; for where things live see `STRUCTURE.md`."
7. **Describe shape, not volatile specifics.** Don't hardcode port numbers, version refs, or exact CLI flags that live in source — name the source of truth instead (e.g. "the pinned daemon ref lives in `apps/gateway/upstream.json`").

## Document Division of Labor

Keep the two docs disjoint so they don't drift into each other.

| `ARCHITECTURE.md` (why / how it fits) | `STRUCTURE.md` (where things live) |
|---------------------------------------|------------------------------------|
| System shape: apps vs packages vs CLI vs MCP bridge | Directory tree with inline purpose comments |
| Codemap: role → path table | Per-directory purpose subsections |
| Data flow: CLI → command module → SSH/deploy / MCP bridge → tool | Naming conventions (files, tests, commands) |
| Invariants CI/review enforce | Key file locations (entry points, config, tests) |
| Cross-cutting concerns (secrets, deploy gating, host-key pinning, paths-filter) | "Where to Add New Code" checklist |
| "Where to add a new app / command" patterns (the *why*/integration) | Build-artifact + fixture/snapshot locations |

## Section Order

Read the target doc first (if it exists) and preserve its evolved structure. The lists below are the starting shape for first creation; confirm against the live file before regenerating. New top-level sections need explicit approval.

### `ARCHITECTURE.md`

Following matklad's "Bird's Eye" pattern, optimized for agents.

1. `# Architecture` — H1 + 1–2 sentence orientation pointing at `STRUCTURE.md` and the AGENTS.md hierarchy, and the boundary statement (rule 6 above)
2. `## Bird's Eye Overview` — two paragraphs: the monorepo's job (deploy + manage personal infra) and its shape (each `apps/<name>` is a self-contained DigitalOcean/Docker-Compose deploy unit; `packages/cli` is the unified operator surface; `packages/shared` holds cross-app helpers; the MCP bridge re-exposes read commands)
3. `## Codemap` — role → path table (deploy scripts, provision scripts, CLI command groups, shared helpers, MCP bridge, conventions test) using symbols/paths, no line numbers
4. `## Data Flow` — operator/agent → `packages/cli` command → goke action → SSH/Docker-Compose on droplet, and the MCP-bridge path (`ctx`-captured read commands only)
5. `## Invariants` — numbered, enforceable; mirror root `AGENTS.md` anti-patterns (Bash-script rule, secrets-never-in-argv, `apps`↔`packages` import direction, SHA-pinned actions, `.yaml` workflows, no `as any`, paths-filter `predicate-quantifier: every`)
6. `## Cross-Cutting Concerns` — secret materialization, GitHub Environment deploy gating, pinned host keys (`.github/known_hosts`), upstream pin + verify-at-tag (gateway), conventions test as executable enforcement
7. `## Where to Add New Code` — integration-level patterns (new app, new CLI command group, new deploy workflow), each cross-linking STRUCTURE.md for the mechanical layout

### `STRUCTURE.md`

Audience: an agent that needs to know where to put a change.

1. `# Structure` — H1 + cross-references to `ARCHITECTURE.md` and the AGENTS.md hierarchy
2. `## Directory Layout` — ASCII tree of `apps/`, `packages/`, `.github/`, `docs/`, `.agents/`, `.opencode/` with inline purpose comments (exclude `.slim/`)
3. `## Directory Purposes` — H3 per top-level dir (`apps/`, `packages/`, `.github/`, `docs/`, `.agents/skills/`, `.opencode/commands/`)
4. `## Key File Locations` — categorized tables: Entry Points, Per-App Deploy/Provision, CLI Commands, Config, Tests, CI/Deploy
5. `## Naming Conventions` — files, colocated `*.test.ts`, `__fixtures__/`/`__snapshots__/`, command modules (`<action>.ts` under `commands/<app>/` + barrel `index.ts`), host validators (`host.ts` per app)
6. `## Where to Add New Code` — mechanical checklist (new app, new command, new shared helper, new test, new workflow, new docs page), deferring the *why* to ARCHITECTURE.md

## Style Rules (Non-Negotiable)

1. **Voice**: terse, declarative, fact-first. No marketing language ("robust", "powerful", "leverages", "seamless").
2. **Present tense, current state only**: describe what the system IS. Never "previously X", "unchanged behavior", or session/process framing.
3. **No session/process leakage**: never reference subagent names, plan paths, skill names, plan-unit/rule-ID taxonomy, or "how it was built". These docs describe the system, not the work that produced them. Grep gate before save: `grep -nE "\bUnit [0-9]+|\bR[0-9]+\b|ce:[a-z]" ARCHITECTURE.md STRUCTURE.md` returns nothing.
4. **Paths in backticks**: every file, directory, command, env var.
5. **Code blocks language-tagged**: `bash`, `json`, `text` for trees, `mermaid` only if a diagram earns its place.
6. **No secrets, no machine-specifics**: no real secret values, no droplet IPs, no `/Users/...` local paths, no live hostnames beyond the public deploy domains already in the README.
7. **Counts derived from live tooling**: never hardcode "4 apps" without having just run `ls -d apps/*/`.
8. **Symbol references, not line numbers** (restating rule 1 of AI-Agent Optimization because it is the most common rot source).

## Generation Flow

1. **Inventory** — run every command in "Pre-Generation Inventory". Count; don't estimate.
2. **Diff against current doc** — for each section, identify what changed (new app/package, new command group, renamed paths, count drift). First creation: extract the deep structural content from `README.md`'s `## Repository Structure` and the deploy/CI sections, reshaped per the section order above, then leave a lean pointer in the README (coordinate with `/generate-readme`).
3. **Write minimal diff** — update only what changed; keep voice and untouched sections exact.
4. **Verify** — run the quality checks below; re-read end-to-end before saving.

## Quality Checks

**Security (always):**
- [ ] No secrets, tokens, droplet IPs, or local `/Users/...` paths
- [ ] Only public deploy domains referenced (those already public in the README)

**Accuracy (always):**
- [ ] App/package counts and names match `ls -d apps/*/` and `ls -d packages/*/`
- [ ] Every codemap path resolves to a real file on disk
- [ ] CLI command groups match `grep register[A-Z] packages/cli/src/cli.ts`
- [ ] Every cross-link (ARCHITECTURE ↔ STRUCTURE ↔ AGENTS.md ↔ README) resolves
- [ ] No line-number references in any codemap entry

**Style (always):**
- [ ] Headings increase monotonically (H1 → H2 → H3)
- [ ] All code blocks language-tagged; all paths in backticks
- [ ] Taxonomy/process-leakage grep returns nothing (see Style rule 3)

## Common Mistakes

| Mistake | Fix |
|---------|-----|
| Carrying counts/paths from the README or a previous draft | Re-derive from `ls`/`find`/`grep` |
| Line numbers in the codemap | Reference the symbol/path; agents symbol-search |
| Duplicating deploy procedures from `apps/*/AGENTS.md` | Cross-link to the AGENTS.md; don't copy |
| Regenerating the README here | README is owned by `/generate-readme`; this skill owns ARCHITECTURE/STRUCTURE |
| Overlapping ARCHITECTURE and STRUCTURE content | Apply the division-of-labor table; shape/why vs where/layout |
| Including `.slim/clonedeps/` in trees or counts | Exclude vendored dependency source from all inventory |
| Marketing language or "previously X" framing | Delete it; state the present-tense fact |
| Leaking plan/skill/subagent names | These docs describe the system, not how it was built |

## Quick Reference

```bash
# Inventory (run before writing)
ls -d apps/*/ packages/*/                              # apps + packages
grep -nE "register[A-Z]" packages/cli/src/cli.ts       # CLI command groups
find . -name AGENTS.md -not -path '*/node_modules/*' -not -path './.slim/*'   # AGENTS.md hierarchy
ls .github/workflows/*.yaml                            # workflows / deploy pipeline
cat apps/*/upstream.json 2>/dev/null                   # pinned upstream refs
git log --oneline -15                                  # recent change context

# Verify (run after writing)
grep -nE "\bUnit [0-9]+|\bR[0-9]+\b|ce:[a-z]" ARCHITECTURE.md STRUCTURE.md   # must be empty
git diff ARCHITECTURE.md STRUCTURE.md                  # review own diff
```
