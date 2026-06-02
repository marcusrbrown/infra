import type {goke} from 'goke'
import {createMcpAction} from '@goke/mcp'

/**
 * Commands intentionally excluded from MCP exposure (not in MCP_ALLOWLIST):
 *
 * Infrastructure / streaming (deferred or not MCP-suitable):
 * - `gateway deploy`   — subprocess streaming (Bun.spawn with stdout: 'inherit'), deferred to MCP v2 (#291)
 * - `cliproxy deploy`  — subprocess streaming, deferred to MCP v2 (#291)
 * - `keeweb deploy`    — subprocess streaming, deferred to MCP v2 (#291)
 * - `gateway logs`     — subprocess streaming, deferred to MCP v2 (#291)
 * - `cliproxy login`   — interactive (OAuth callback URL paste, requires TTY)
 * - `cliproxy open`    — interactive (SSH TUI session, requires TTY)
 * - `cliproxy setup`   — interactive (@clack/prompts wizard, requires TTY)
 * - `gateway restore`  — destructive policy (replaces mitmproxy CA on live gateway, deferred to MCP v2 #292)
 * - `keeweb open`      — host-machine side effect (spawns local browser, requires user intent)
 * - `umami deploy`     — intentionally CLI-only: mutates live deployment and requires environment approval
 * - `umami logs`       — intentionally CLI-only: streams logs that may emit sensitive data (DB passwords, app secrets)
 *
 * Source-gated sensitive commands (security — CLI-only, never MCP-exposed):
 * - `gateway backup`       — secret-bearing: writes CA private key material to a tarball; CLI-only
 * - `cliproxy keys list`   — secret-disclosing: prints live bearer tokens in plaintext; CLI-only
 * - `cliproxy keys add`    — mutating: creates live bearer tokens on the proxy; CLI-only
 * - `cliproxy keys remove` — mutating: revokes live bearer tokens on the proxy; CLI-only
 * - `cliproxy config get`  — secret-disclosing: dumps management config incl. management key; CLI-only
 * - `cliproxy config set`  — mutating: overwrites CLIProxyAPI runtime config; CLI-only
 *
 * A defense-in-depth backstop also denies these in opencode.jsonc `permission`
 * so that even if MCP_ALLOWLIST were mistakenly re-expanded, opencode's native
 * tool permission check would block execution. Both layers are enforced by
 * the `gates every sensitive infra MCP tool` test in conventions.test.ts.
 */
export const MCP_ALLOWLIST: ReadonlySet<string> = new Set([
  'gateway status',
  'cliproxy status',
  'keeweb status',
  'umami status',
  'status',
])

export function registerMcp(cli: ReturnType<typeof goke>): void {
  cli.command('mcp', 'Start a stdio MCP server exposing all CLI commands as tools for coding agents').action(
    createMcpAction({
      cli,
      commandFilter: name => MCP_ALLOWLIST.has(name),
    }),
  )
}
