import type {goke} from 'goke'

import {registerVpnClient} from './client'
import {registerVpnDeploy} from './deploy'
import {registerVpnLogs} from './logs'
import {registerVpnStatus} from './status'

export {getVpnStatusSummary} from './shared'

export function registerVpnCommands(cli: ReturnType<typeof goke>): void {
  registerVpnStatus(cli)
  registerVpnDeploy(cli)
  registerVpnLogs(cli)
  registerVpnClient(cli)
}
