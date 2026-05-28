import type {goke} from 'goke'
import {createMcpAction} from '@goke/mcp'

/**
 * Commands intentionally excluded from MCP exposure (not in MCP_ALLOWLIST):
 *
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
 */
export const MCP_ALLOWLIST: ReadonlySet<string> = new Set([
  'gateway status',
  'gateway backup',
  'cliproxy status',
  'cliproxy keys list',
  'cliproxy keys add',
  'cliproxy keys remove',
  'cliproxy config get',
  'cliproxy config set',
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
