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
 * - `dashboard deploy` — intentionally CLI-only: mutates live deployment and requires environment approval
 * - `dashboard logs`   — intentionally CLI-only: streams logs that may emit sensitive data (DB passwords, app secrets)
 *
 * Source-gated sensitive commands (security — CLI-only, never MCP-exposed):
 * - `gateway backup`       — secret-bearing: writes CA private key material to a tarball; CLI-only
 * - `cliproxy keys list`   — secret-disclosing: prints live bearer tokens in plaintext; CLI-only
 * - `cliproxy keys add`    — mutating: creates live bearer tokens on the proxy; CLI-only
 * - `cliproxy keys remove` — mutating: revokes live bearer tokens on the proxy; CLI-only
 * - `cliproxy config get`  — secret-disclosing: dumps management config incl. management key; CLI-only
 * - `cliproxy config set`  — mutating: overwrites CLIProxyAPI runtime config; CLI-only
 * - `vpn deploy`           — mutating: deploys WireGuard config to live VPN box; CLI-only
 * - `vpn logs`             — sensitive: streams journalctl logs that may reveal peer IPs/traffic; CLI-only
 * - `vpn client add`       — mutating: generates keypair + appends peer + triggers redeploy; CLI-only
 * - `vpn client list`      — sensitive: lists peer public keys and tunnel IPs; CLI-only
 * - `vpn client remove`    — mutating: removes peer + triggers redeploy; CLI-only
 * - `broker deploy`         — mutating: deploys the credential broker to a live droplet; CLI-only
 * - `broker logs`           — sensitive: streams logs that may reveal run identities and minted key prefixes; CLI-only
 *
 * A defense-in-depth backstop also denies these in opencode.jsonc `permission`
 * so that even if MCP_ALLOWLIST were mistakenly re-expanded, opencode's native
 * tool permission check would block execution. Both layers are enforced by
 * the `gates every sensitive infra MCP tool` test in conventions.test.ts.
 */
export const MCP_ALLOWLIST: ReadonlySet<string> = new Set([
  'gateway status',
  'cliproxy status',
  'cliproxy models',
  'keeweb status',
  'umami status',
  'dashboard status',
  'vpn status',
  'broker status',
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
