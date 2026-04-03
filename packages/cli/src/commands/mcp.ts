import type {goke} from 'goke'
import {createMcpAction} from '@goke/mcp'

export function registerMcp(cli: ReturnType<typeof goke>): void {
  cli
    .command('mcp', 'Start a stdio MCP server exposing all CLI commands as tools for coding agents')
    .action(createMcpAction({cli}))
}
