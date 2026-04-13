import type {goke} from 'goke'

import {registerKeewebDeploy} from './deploy'
import {registerKeewebOpen} from './open'
import {registerKeewebStatus} from './status'

export function registerKeewebCommands(cli: ReturnType<typeof goke>): void {
  registerKeewebStatus(cli)
  registerKeewebDeploy(cli)
  registerKeewebOpen(cli)
}
