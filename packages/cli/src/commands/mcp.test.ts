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

import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js'

import {createMcpAction} from '@goke/mcp'
import {Client} from '@modelcontextprotocol/sdk/client'
import {InMemoryTransport} from '@modelcontextprotocol/sdk/inMemory.js'
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js'
import {afterAll, beforeAll, describe, expect, test} from 'bun:test'
import {goke} from 'goke'

import {registerCliproxyCommands} from './cliproxy'
import {registerGatewayCommands} from './gateway'
import {registerKeewebCommands} from './keeweb'
import {registerMcp} from './mcp'
import {registerStatus} from './status'

// ─── Tool name constants (re-derived here, not imported from mcp.ts) ──────────

/** The 10 commands exposed via MCP (MCP_ALLOWLIST), with spaces replaced by underscores. */
const EXPECTED_TOOLS = [
  'cliproxy_config_get',
  'cliproxy_config_set',
  'cliproxy_keys_add',
  'cliproxy_keys_list',
  'cliproxy_keys_remove',
  'cliproxy_status',
  'gateway_backup',
  'gateway_status',
  'keeweb_status',
  'status',
].sort()

/** The 9 CLI-only commands that must NOT appear in the MCP tool list. */
const CLI_ONLY_TOOLS = [
  'cliproxy_deploy',
  'cliproxy_login',
  'cliproxy_open',
  'cliproxy_setup',
  'gateway_deploy',
  'gateway_logs',
  'gateway_restore',
  'keeweb_deploy',
  'keeweb_open',
].sort()

/** The MCP allowlist (mirrors mcp.ts — re-declared here to avoid coupling). */
const MCP_ALLOWLIST = new Set<string>([
  'gateway status',
  'gateway backup',
  'cliproxy status',
  'cliproxy keys list',
  'cliproxy keys add',
  'cliproxy keys remove',
  'cliproxy config get',
  'cliproxy config set',
  'keeweb status',
  'status',
])

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestCli(): ReturnType<typeof goke> {
  const cli = goke('infra')
  cli.option('--verbose', 'Enable verbose output for all commands')
  registerKeewebCommands(cli)
  registerCliproxyCommands(cli)
  registerGatewayCommands(cli)
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

  test('tools/list returns exactly the 10 allowlist tool names', async () => {
    const result = await client.listTools()
    const names = result.tools.map((t: {name: string}) => t.name).sort()
    expect(names).toEqual(EXPECTED_TOOLS)
  })

  test('cli-only commands are absent from the tool list', async () => {
    const result = await client.listTools()
    const names = new Set(result.tools.map((t: {name: string}) => t.name))
    for (const excluded of CLI_ONLY_TOOLS) {
      expect(names.has(excluded)).toBe(false)
    }
  })

  // ── Mode B contract: gateway_backup ───────────────────────────────────────
  //
  // gateway_backup tries to SSH to a real droplet, which is unreachable in CI.
  // We assert the contract: the tool returns a non-empty CallToolResult.
  // In CI the result will be an error CallToolResult (isError: true) because
  // SSH fails — that's fine; the contract is that the MCP layer wraps the
  // error and returns content rather than throwing.

  test('gateway_backup returns a non-empty CallToolResult (Mode B contract)', async () => {
    const rawResult = await client.callTool(
      {
        name: 'gateway_backup',
        arguments: {},
      },
      CallToolResultSchema,
    )
    // Parse through the schema to get a properly typed result.
    // The tool must return at least one content block (even on SSH failure).
    const result: CallToolResult = CallToolResultSchema.parse(rawResult)
    expect(result.content.length).toBeGreaterThan(0)
  })

  // ── Mode C contract: cliproxy_keys_list ───────────────────────────────────
  //
  // Mode C: when a command returns structured data AND prints to stdout,
  // the CallToolResult must contain BOTH a stdout text block AND a
  // stringified return-value text block.
  //
  // Re-enable after Unit 4 lands (cliproxy keys list refactor to return
  // structured data alongside ctx-printed text).

  // Re-enable after Unit 4 lands (cliproxy keys list refactor to return
  // structured data alongside ctx-printed text).
  test.skip('cliproxy_keys_list returns BOTH stdout block AND structured return block (Mode C contract)', async () => {
    // TODO(Unit 4): assert result contains BOTH a stdout text block AND a
    // stringified return-value text block once cliproxy keys list returns
    // structured data alongside ctx-printed text.
  })
})
