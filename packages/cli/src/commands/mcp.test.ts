/**
 * Tier-1 in-process MCP integration test.
 *
 * Uses @modelcontextprotocol/sdk's InMemoryTransport to spin up the MCP server
 * in-process (no subprocess) and assert the tool list + call contracts.
 *
 * // FALLBACK: If InMemoryTransport proves incompatible with @goke/mcp@0.0.10's
 * // transport injection in a future SDK version, switch to subprocess mode:
 * //
 * //   const proc = Bun.spawn(['bun', 'run', 'packages/cli/src/cli.ts', 'mcp'], {
 * //     stdin: 'pipe',
 * //     stdout: 'pipe',
 * //     stderr: 'pipe',
 * //   })
 * //   const transport = new StdioClientTransport({
 * //     readable: proc.stdout,
 * //     writable: proc.stdin,
 * //   })
 * //   const client = new Client({name: 'test-client', version: '1.0.0'}, {capabilities: {}})
 * //   await client.connect(transport)
 * //   // ... same assertions below ...
 * //   await client.close()
 * //   proc.kill()
 */

import {createMcpAction} from '@goke/mcp'
import {Client} from '@modelcontextprotocol/sdk/client'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {goke} from 'goke'

import {registerCliproxyCommands} from './cliproxy'
import {registerGatewayCommands} from './gateway'
import {registerKeewebCommands} from './keeweb'
import {MCP_ALLOWLIST, registerMcp} from './mcp'
import {registerStatus} from './status'
import {registerUmamiCommands} from './umami'
import {registerVpnCommands} from './vpn'

// ─── Tool name constants ──────────────────────────────────────────────────────

/**
 * The MCP tool surface, pinned as an INDEPENDENT literal (deliberately NOT
 * derived from MCP_ALLOWLIST) so allowlist drift surfaces as a test failure —
 * per the Tier-1 test bar in packages/cli/AGENTS.md. Six read-only status tools.
 */
const EXPECTED_TOOLS = [
  'cliproxy_status',
  'gateway_status',
  'keeweb_status',
  'status',
  'umami_status',
  'vpn_status',
].sort()

/**
 * CLI-only commands that must NOT appear in the MCP tool list: the
 * non-interactive/streaming-only commands plus the source-gated sensitive
 * commands (mutating or secret-disclosing).
 */
const CLI_ONLY_TOOLS = [
  // Non-interactive / streaming — excluded since before the source-gate change
  'cliproxy_deploy',
  'cliproxy_login',
  'cliproxy_open',
  'cliproxy_setup',
  'gateway_deploy',
  'gateway_logs',
  'gateway_restore',
  'keeweb_deploy',
  'keeweb_open',
  'umami_deploy',
  'umami_logs',
  // Source-gated sensitive commands (mutating or secret-disclosing)
  'gateway_backup',
  'cliproxy_keys_list',
  'cliproxy_keys_add',
  'cliproxy_keys_remove',
  'cliproxy_config_get',
  'cliproxy_config_set',
  // VPN: mutating / sensitive / log-streaming — CLI-only
  'vpn_deploy',
  'vpn_logs',
  'vpn_client_add',
  'vpn_client_list',
  'vpn_client_remove',
].sort()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestCli(): ReturnType<typeof goke> {
  const cli = goke('infra')
  cli.option('--verbose', 'Enable verbose output for all commands')
  registerKeewebCommands(cli)
  registerCliproxyCommands(cli)
  registerGatewayCommands(cli)
  registerUmamiCommands(cli)
  registerVpnCommands(cli)
  registerStatus(cli)
  registerMcp(cli)
  return cli
}

// ─── Suite ────────────────────────────────────────────────────────────────────

describe('mcp integration (Tier-1, in-process)', () => {
  let client: Client

  beforeAll(async () => {
    const cli = buildTestCli()

    // Simulate goke having matched the 'mcp' command so createMcpAction
    // auto-excludes it from the tool list (it reads cli.matchedCommandName).
    cli.matchedCommandName = 'mcp'

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()

    // createMcpAction supports a custom createTransport factory (Option A).
    // We inject the in-memory server transport so no stdio is involved.
    const mcpAction = createMcpAction({
      cli,
      commandFilter: (name: string) => MCP_ALLOWLIST.has(name),
      createTransport: () => serverTransport,
    })

    // Start the server (non-blocking — server.connect() resolves once the
    // transport handshake completes, then the server listens for requests).
    await mcpAction()

    client = new Client({name: 'test-client', version: '1.0.0'}, {capabilities: {}})
    await client.connect(clientTransport)
  })

  afterAll(async () => {
    await client?.close()
  })

  // ── tools/list assertions ──────────────────────────────────────────────────

  test('tools/list returns exactly the allowlist tool names', async () => {
    const result = await client.listTools()
    const names = result.tools.map((t: {name: string}) => t.name).sort()
    expect(names).toEqual(EXPECTED_TOOLS)
  })

  test('source-gated sensitive commands are absent from the MCP tool list', async () => {
    const result = await client.listTools()
    const names = new Set(result.tools.map((t: {name: string}) => t.name))
    for (const excluded of CLI_ONLY_TOOLS) {
      expect(names.has(excluded)).toBe(false)
    }
  })
})
