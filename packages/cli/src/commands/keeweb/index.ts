import type {goke} from 'goke'

import {registerKeewebDeploy} from './deploy'
import {registerKeewebStatus} from './status'

export function registerKeewebCommands(cli: ReturnType<typeof goke>): void {
  registerKeewebStatus(cli)
  registerKeewebDeploy(cli)
}
