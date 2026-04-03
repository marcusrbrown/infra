#!/usr/bin/env bun

import {goke} from 'goke'
import pkg from '../package.json' with {type: 'json'}
import {registerKeewebDeploy} from './commands/keeweb-deploy'
import {registerKeewebStatus} from './commands/keeweb-status'
import {registerMcp} from './commands/mcp'

const cli = goke('infra')

cli.option('--verbose', 'Enable verbose output for all commands')

registerKeewebStatus(cli)
registerKeewebDeploy(cli)
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
