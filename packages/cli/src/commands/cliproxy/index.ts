import type {goke} from 'goke'

import {registerCliproxyConfig} from './config'
import {registerCliproxyDeploy} from './deploy'
import {registerCliproxyKeys} from './keys'
import {registerCliproxyLogin} from './login'
import {registerCliproxyOpen} from './open'
import {registerCliproxyStatus} from './status'

export function registerCliproxyCommands(cli: ReturnType<typeof goke>): void {
  registerCliproxyStatus(cli)
  registerCliproxyDeploy(cli)
  registerCliproxyConfig(cli)
  registerCliproxyKeys(cli)
  registerCliproxyLogin(cli)
  registerCliproxyOpen(cli)
}
