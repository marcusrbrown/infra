---
title: Docker-based MCP server fails with -32000 because OpenCode {env:} interpolation reads an empty process env
date: 2026-06-12
category: docs/solutions/integration-issues
module: opencode.jsonc
problem_type: integration_issue
component: tooling
symptoms:
  - 'OpenCode MCP sidebar showed "MCP error -32000: Connection closed" immediately on startup'
  - 'opencode debug config --pure showed environment: {DISCORD_TOKEN: "", DISCORD_GUILD_ID: ""}'
  - 'the docker container exited instantly because Discord login failed with empty credentials'
  - 'docker run --env-file .env was rejected: variable "-----END OPENSSH PRIVATE KEY-----" contains whitespaces'
root_cause: config_error
resolution_type: config_change
severity: high
related_components:
  - opencode.jsonc
tags:
  - mcp
  - opencode
  - docker
  - env-interpolation
  - discord
  - dotenv
---

# Docker-based MCP server fails with -32000 because OpenCode {env:} interpolation reads an empty process env

## Problem

A Docker-based MCP server (`saseq/discord-mcp:1.0.0`, a Spring Boot/JVM stdio server) added to `opencode.jsonc` failed instantly with `MCP error -32000: Connection closed`. The `{env:VAR}` interpolation that was supposed to inject `DISCORD_TOKEN`/`DISCORD_GUILD_ID` from the repo `.env` resolved to empty strings, so the container failed Discord login and exited before completing the MCP handshake.

## Symptoms

- `MCP error -32000: Connection closed` in the OpenCode MCP sidebar, **immediately** (not after a delay)
- `opencode debug config --pure` showed `environment: { DISCORD_TOKEN: '', DISCORD_GUILD_ID: '' }`
- A manual `docker run` of the image with a real MCP `initialize` over stdin worked fine (server healthy) — so the failure was credential delivery, not the image
- `docker run --env-file .env` failed: `docker: invalid env file (.env): variable '-----END OPENSSH PRIVATE KEY-----"' contains whitespaces`

## What Didn't Work

- **Closing stdin too early in the manual probe.** The first manual `docker run` "failed" only because the probe sent the `initialize` line and immediately closed stdin; the container exited before responding. Holding stdin open (a trailing `sleep`) returned a valid response — the image was healthy all along.
- **Bumping `timeout` alone.** The JVM cold-start (~30s to answer `initialize`) did race the default 30000ms connect timeout, so the bump to 60000 was necessary — but after restart it still errored *instantly*, which proved the timeout was not the primary cause.
- **`docker run --env-file .env`.** Docker's env-file parser is strict and rejects this repo's `.env` because the multi-line `VPN_SSH_KEY` PEM contains whitespace.

## Solution

OpenCode's `{env:VAR}` interpolation reads **OpenCode's own process environment**, which does not carry the repo-root `.env`. Only the `infra` MCP server picks up `.env` automatically — because it is a `bun run` command and Bun auto-loads `.env` from its cwd. A `docker run` server gets nothing.

Fix: source `.env` in a shell wrapper (the shell parses the multi-line PEM fine, unlike Docker's `--env-file`) and forward only the two needed vars into the container via `-e`. Drop the broken `environment` block entirely.

```jsonc
// Before — {env:} reads OpenCode's empty process env:
{
  "command": ["docker", "run", "--rm", "-i", "-e", "DISCORD_TOKEN", "-e", "DISCORD_GUILD_ID", "saseq/discord-mcp:1.0.0"],
  "environment": {
    "DISCORD_TOKEN": "{env:DISCORD_TOKEN}",
    "DISCORD_GUILD_ID": "{env:DISCORD_GUILD_ID}",
  },
}

// After — shell wrapper sources .env, forwards only the two vars:
{
  "command": [
    "sh", "-c",
    "set -a; . ./.env; set +a; exec docker run --rm -i -e DISCORD_TOKEN -e DISCORD_GUILD_ID saseq/discord-mcp:1.0.0",
  ],
  "timeout": 60000,
}
```

OpenCode launches local MCP servers with `cwd` = project root (the directory containing `opencode.jsonc`), so `. ./.env` resolves.

Verified: the container logs into the guild and lists its tools; OpenCode shows the server Connected.

## Why This Works

The `bun run` infra server worked only because **Bun auto-loads `.env`** from its cwd at startup — an accident of that server's runtime, not an OpenCode feature. OpenCode itself never loads `.env`, so `{env:VAR}` (which reads OpenCode's process env) yields empty strings for any var that lives only in `.env`. The shell wrapper closes the gap by explicitly sourcing `.env` at launch and forwarding only the required vars, keeping every other `.env` value (including secrets) out of the container.

The decisive diagnostic was **`opencode debug config --pure`**: it prints the resolved, post-interpolation config. Empty strings where `{env:}` values were expected is the unambiguous signature of an interpolation gap.

## Prevention

- For any MCP server that is **not** a `bun run` command but needs repo `.env` secrets, do not rely on `{env:...}` interpolation — OpenCode's process env won't have them.
- Do not use `--env-file .env` when `.env` contains PEMs or other multi-line/whitespace values; Docker's parser rejects them. Source `.env` in a shell wrapper instead and forward only the vars you need via `-e`.
- When an MCP server shows `-32000` immediately, run `opencode debug config --pure` and check the resolved `environment` block for empty values before assuming a timeout or a broken image.
- A `-32000` that's instant is a different failure from a `-32000` that appears after ~30s: instant ⇒ the process exited (bad/empty config); delayed ⇒ a connect-timeout race (raise `timeout`).

## Related Issues

- PR #506 — `fix(mcp): wire Discord MCP env from .env and gate destructive tools` (merged `790812a`)
- `docs/solutions/integration-issues/gateway-mention-loop-model-config-2026-06-04.md` — adjacent: OpenCode/`WORKSPACE_OPENCODE_CONFIG` env wiring in the gateway workspace (different layer, same `.env`-discipline family)
- `docs/solutions/integration-issues/gateway-mention-loop-permission-and-empty-workspace-2026-06-05.md` — adjacent OpenCode-config failure mode, distinct from this MCP env-interpolation gap
