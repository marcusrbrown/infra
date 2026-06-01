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

/** Extract all text block content from a CallToolResult, joined by newline. */
function allText(result: CallToolResult): string {
  return result.content
    .filter((block): block is {type: 'text'; text: string} => block.type === 'text')
    .map(block => block.text)
    .join('\n')
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
  // gateway_backup reads GATEWAY_HOST before attempting any SSH call.
  // When GATEWAY_HOST is unset the action exits synchronously with a
  // well-known error message — no network contact is made.
  // The MCP layer must wrap that failure as an error CallToolResult
  // (isError: true) rather than throwing, and the content must contain
  // the exact error message from gatewayBackupAction so we catch contract
  // regressions if the message ever changes.

  test('gateway_backup wraps missing-GATEWAY_HOST as an error CallToolResult with the known message', async () => {
    const originalHost = process.env.GATEWAY_HOST

    try {
      // Delete GATEWAY_HOST to trigger the fast synchronous error path inside
      // gatewayBackupAction — no SSH or network call is made.
      delete process.env.GATEWAY_HOST

      const rawResult = await client.callTool(
        {
          name: 'gateway_backup',
          arguments: {},
        },
        CallToolResultSchema,
      )

      const result: CallToolResult = CallToolResultSchema.parse(rawResult)

      // The MCP layer must surface the error as a content block, not a thrown exception.
      expect(result.isError).toBe(true)
      expect(result.content.length).toBeGreaterThan(0)

      // The content must carry the exact contract-bearing error string from
      // gatewayBackupAction. This assertion fails if the error message changes.
      expect(allText(result)).toContain('Gateway host not set. Export GATEWAY_HOST before running backup.')
    } finally {
      if (originalHost === undefined) {
        delete process.env.GATEWAY_HOST
      } else {
        process.env.GATEWAY_HOST = originalHost
      }
    }
  })

  // ── Mode C contract: cliproxy_keys_list ───────────────────────────────────
  //
  // Mode C: when a command returns structured data AND prints to stdout,
  // the CallToolResult must contain BOTH a stdout text block AND a
  // stringified return-value text block.
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

      const text = allText(result)

      // One block must contain the formatted stdout (key names printed by the action)
      expect(text).toContain('fro-bot-test1')

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

  // ── Positional-arg routing: cliproxy_keys_add ─────────────────────────────
  //
  // The MCP inputSchema for cliproxy_keys_add has a single required property
  // `key` (derived from the command's positional `<key>` argument). This test
  // proves that goke routes the MCP argument value through to the action's
  // positional parameter (apiKeyToAdd) by asserting the key name appears in
  // the action's output text.
  //
  // Verified inputSchema (empirical): { properties: { key: { type: "string",
  //   description: "Management API key…" }, url: { type: "string" } },
  //   required: ["key"] }

  test('cliproxy_keys_add routes the positional key argument through MCP', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.CLIPROXY_MANAGEMENT_KEY

    try {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'test-management-key'

      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        const method = typeof _init?.method === 'string' ? _init.method.toUpperCase() : 'GET'
        if (method === 'GET') {
          // Return empty current key list so the new key is not already present
          return new Response(JSON.stringify([]), {
            status: 200,
            headers: {'content-type': 'application/json'},
          })
        }

        // PUT response — the action ignores the body and logs the new count
        return new Response(JSON.stringify(['tier1-test-key']), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }) as typeof fetch

      const rawResult = await client.callTool(
        {
          name: 'cliproxy_keys_add',
          // `key` is the positional <key> arg (the API key to add).
          // Verified from listTools() inputSchema — required property.
          arguments: {key: 'tier1-test-key'},
        },
        CallToolResultSchema,
      )

      const result: CallToolResult = CallToolResultSchema.parse(rawResult)

      expect(result.isError).not.toBe(true)
      // The action logs `Added key "tier1-test-key"` — presence proves the
      // positional arg was correctly routed from the MCP call.
      expect(allText(result)).toContain('tier1-test-key')
    } finally {
      globalThis.fetch = originalFetch
      if (originalKey === undefined) {
        delete process.env.CLIPROXY_MANAGEMENT_KEY
      } else {
        process.env.CLIPROXY_MANAGEMENT_KEY = originalKey
      }
    }
  })

  // ── Positional-arg routing: cliproxy_keys_remove ──────────────────────────
  //
  // The MCP inputSchema for cliproxy_keys_remove has a required property `key`
  // (derived from the positional `<key>` argument). The action issues a DELETE
  // request with `?value=<apiKeyToRemove>` and logs the response. The fetch mock
  // echoes back the query-parameter value so we can assert it was routed correctly.
  //
  // Verified inputSchema (empirical): { properties: { key: { type: "string" },
  //   url: { type: "string" } }, required: ["key"] }

  test('cliproxy_keys_remove routes the positional key argument through MCP', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.CLIPROXY_MANAGEMENT_KEY

    try {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'test-management-key'

      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        // The action appends ?value=<apiKeyToRemove> — echo it back in the
        // response body so the assertion can verify positional routing.
        const urlStr = typeof _url === 'string' ? _url : _url instanceof URL ? _url.href : (_url as Request).url
        const url = new URL(urlStr)
        const removedKey = url.searchParams.get('value') ?? 'unknown'
        return new Response(JSON.stringify({removed: removedKey}), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }) as typeof fetch

      const rawResult = await client.callTool(
        {
          name: 'cliproxy_keys_remove',
          // `key` is the positional <key> arg (the API key to remove).
          // Verified from listTools() inputSchema — required property.
          arguments: {key: 'tier1-test-remove-key'},
        },
        CallToolResultSchema,
      )

      const result: CallToolResult = CallToolResultSchema.parse(rawResult)

      expect(result.isError).not.toBe(true)
      // The response includes the echoed ?value= param — proves the positional
      // arg was routed to the DELETE URL query parameter.
      expect(allText(result)).toContain('tier1-test-remove-key')
    } finally {
      globalThis.fetch = originalFetch
      if (originalKey === undefined) {
        delete process.env.CLIPROXY_MANAGEMENT_KEY
      } else {
        process.env.CLIPROXY_MANAGEMENT_KEY = originalKey
      }
    }
  })

  // ── Positional-arg routing: cliproxy_config_set ───────────────────────────
  //
  // The MCP inputSchema for cliproxy_config_set has two required properties:
  // `field` and `value` (both positional). The action PUT-s `{value: <parsed>}`
  // to the field-specific endpoint and logs the response JSON. Returning the
  // value in the mock response lets us assert both positionals were routed.
  //
  // Verified inputSchema (empirical): { properties: { field: { type: "string",
  //   description: "Positional argument field" }, value: { type: "string",
  //   description: "Positional argument value" }, url: …, key: … },
  //   required: ["field","value"] }

  test('cliproxy_config_set routes both positional arguments (field and value) through MCP', async () => {
    const originalFetch = globalThis.fetch
    const originalKey = process.env.CLIPROXY_MANAGEMENT_KEY

    try {
      process.env.CLIPROXY_MANAGEMENT_KEY = 'test-management-key'

      globalThis.fetch = (async (_url: string | URL | Request, _init?: RequestInit): Promise<Response> => {
        // Echo back the parsed body so we can assert the value was routed.
        // The action sends {value: <parsedValue>}. We return it as-is.
        const body = _init?.body
        const parsed: unknown = body ? JSON.parse(String(body)) : {}
        return new Response(JSON.stringify(parsed), {
          status: 200,
          headers: {'content-type': 'application/json'},
        })
      }) as typeof fetch

      const rawResult = await client.callTool(
        {
          name: 'cliproxy_config_set',
          // `field` and `value` are the positional args from `<field> <value>`.
          // `proxy-url` is a string-type mutable field — no parsing needed.
          arguments: {field: 'proxy-url', value: 'tier1-test-url'},
        },
        CallToolResultSchema,
      )

      const result: CallToolResult = CallToolResultSchema.parse(rawResult)

      expect(result.isError).not.toBe(true)
      // The response echoes back {value: "tier1-test-url"} — presence of the
      // value proves positional routing worked end-to-end.
      expect(allText(result)).toContain('tier1-test-url')
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
