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
import {MCP_ALLOWLIST, registerMcp} from './mcp'
import {registerStatus} from './status'
import {registerUmamiCommands} from './umami'

// ─── Tool name constants ──────────────────────────────────────────────────────

/** Derived from the production MCP_ALLOWLIST — spaces replaced by underscores. */
const EXPECTED_TOOLS = [...MCP_ALLOWLIST].map(name => name.replaceAll(' ', '_')).sort()

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
  'umami_deploy',
  'umami_logs',
].sort()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildTestCli(): ReturnType<typeof goke> {
  const cli = goke('infra')
  cli.option('--verbose', 'Enable verbose output for all commands')
  registerKeewebCommands(cli)
  registerCliproxyCommands(cli)
  registerGatewayCommands(cli)
  registerUmamiCommands(cli)
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
  test('cliproxy_keys_list returns BOTH stdout block AND structured return block (Mode C contract)', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.CLIPROXY_MANAGEMENT_KEY

    try {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'test-management-key'

      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        return new Response(JSON.stringify(['fro-bot-test1', 'fro-bot-test2']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }) as typeof fetch

      const rawResult = await client.callTool(
        {
          name: 'cliproxy_keys_list',
          arguments: {},
        },
        CallToolResultSchema,
      )

      const result: CallToolResult = CallToolResultSchema.parse(rawResult)

      // Mode C contract: at least 2 content blocks (stdout text + structured return)
      expect(result.content.length).toBeGreaterThanOrEqual(2)

      const allText = result.content
        .filter((block): block is {type: 'text'; text: string} => block.type === 'text')
        .map(block => block.text)
        .join('\n')

      // One block must contain the formatted stdout (key names printed by the action)
      expect(allText).toContain('fro-bot-test1')

      // One block must contain the stringified return value (JSON array of key names)
      const hasStructuredReturn = result.content.some(block => {
        if (block.type !== 'text') return false
        try {
          const parsed = JSON.parse(block.text) as unknown
          return Array.isArray(parsed) && parsed.includes('fro-bot-test1') && parsed.includes('fro-bot-test2')
        } catch {
          return false
        }
      })
      expect(hasStructuredReturn).toBe(true)
    } finally {
      globalThis.fetch = originalFetch
      if (originalKey === undefined) {
        delete process.env.CLIPROXY_MANAGEMENT_KEY
      } else {
        process.env.CLIPROXY_MANAGEMENT_KEY = originalKey
      }
    }
  })
})
