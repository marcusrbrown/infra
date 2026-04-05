#!/usr/bin/env bun

import {goke} from 'goke'
import pkg from '../package.json' with {type: 'json'}
import {registerCliproxyConfig} from './commands/cliproxy-config'
import {registerCliproxyDeploy} from './commands/cliproxy-deploy'
import {registerCliproxyKeys} from './commands/cliproxy-keys'
import {registerCliproxyLogin} from './commands/cliproxy-login'
import {registerCliproxyStatus} from './commands/cliproxy-status'
import {registerKeewebDeploy} from './commands/keeweb-deploy'
import {registerKeewebStatus} from './commands/keeweb-status'
import {registerMcp} from './commands/mcp'

const cli = goke('infra')

cli.option('--verbose', 'Enable verbose output for all commands')

registerKeewebStatus(cli)
registerKeewebDeploy(cli)
registerCliproxyStatus(cli)
registerCliproxyDeploy(cli)
registerCliproxyConfig(cli)
registerCliproxyKeys(cli)
registerCliproxyLogin(cli)
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
