---
title: "A trailing comma in .systematic.jsonc fails the scheduled Fro Bot run at the plugin gate"
date: 2026-11-08
module: .systematic.jsonc
problem_type: integration_issue
component: tooling
severity: high
root_cause: config_error
resolution_type: code_fix
symptoms:
  - "Scheduled fro-bot.yaml run fails in Run Fro Bot with kind: plugin-gate"
  - "Required OpenCode plugin(s) not active: systematic (failed)"
  - "No daily autohealing report is published"
tags: [systematic, opencode-plugin, jsonc, scheduled-run, plugin-gate, eslint, fro-bot]
---

# A trailing comma in .systematic.jsonc fails the scheduled Fro Bot run at the plugin gate

## Problem

Systematic 3.31.2 cannot parse trailing commas in `.systematic.jsonc`. When parsing fails, the required plugin doesn't load, the OpenCode V2 server refuses to start, and the scheduled Fro Bot run stops before the agent runs.

## Symptoms

In the `Run Fro Bot` step of the `Fro Bot (storage)` job (run 42157207404), a warning with `"kind":"plugin-gate"` was followed by:

```text
##[error]OpenCode V2 start failed (plugins): OpenCode V2 server failed to start: Required OpenCode plugin(s) not active: systematic (failed)
```

## What Didn't Work

Nothing checked the file before the run. Prettier's default `trailingComma` setting writes trailing commas into JSONC, and the file was not linted against the parser that actually reads it.

## Solution

#1816 removed the commas:

```diff
-    "sources": [{"name": "runbooks", "format": "markdown", "roots": ["docs/runbooks"]}],
-  },
+    "sources": [{"name": "runbooks", "format": "markdown", "roots": ["docs/runbooks"]}]
+  }
```

It also pinned the format in `eslint.config.ts`:

```ts
  {
    // Systematic parses its config without trailing-comma support (marcusrbrown/systematic#1313).
    name: 'systematic config overrides',
    files: ['.systematic.jsonc'],
    rules: {
      'prettier/prettier': ['error', {trailingComma: 'none'}],
    },
  },
```

## Why This Works

The plugin gate treats a required plugin that fails to load as a startup failure, not a warning. A config file the plugin can't parse is a load failure. The ESLint override keeps `eslint --fix` and lint-staged from adding the commas back.

## Prevention

- Any repo file an action-run OpenCode plugin reads is a hard dependency of the scheduled run. Lint or validate it in CI against what the plugin accepts.
- Treat a missing daily report as a failure signal.
- Drop the `trailingComma: 'none'` override once Systematic accepts trailing commas (marcusrbrown/systematic#1313).

## Related

- [Fro Bot schedule session bloat no-op](../workflow-issues/fro-bot-schedule-session-bloat-no-op-2026-06-14.md) covers the other scheduled-run failure, where the run exits green and does nothing. This failure is loud instead.
