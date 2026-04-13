#!/usr/bin/env bun

import {goke} from 'goke'
import pkg from '../package.json' with {type: 'json'}
import {registerCliproxyCommands} from './commands/cliproxy'
import {registerKeewebCommands} from './commands/keeweb'
import {registerMcp} from './commands/mcp'
import {registerStatus} from './commands/status'

declare const process: {
  argv: string[]
  exit: (code?: number) => never
}

const cli = goke('infra')

cli.option('--verbose', 'Enable verbose output for all commands')

registerKeewebCommands(cli)
registerCliproxyCommands(cli)
registerStatus(cli)
registerMcp(cli)

cli.help()
cli.version(pkg.version)

try {
  cli.parse(process.argv, {run: false})
  await cli.runMatchedCommand()
} catch (error) {
  if (error instanceof Error) {
    console.error(error.message)
  }
  process.exit(1)
}
