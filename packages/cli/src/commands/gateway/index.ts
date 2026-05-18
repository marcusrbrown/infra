import type {goke} from 'goke'

import {registerGatewayBackup} from './backup'
import {registerGatewayDeploy} from './deploy'
import {registerGatewayLogs} from './logs'
import {registerGatewayRestore} from './restore'
import {registerGatewayStatus} from './status'

export {getGatewayStatusSummary} from './status'

export function registerGatewayCommands(cli: ReturnType<typeof goke>): void {
  registerGatewayStatus(cli)
  registerGatewayDeploy(cli)
  registerGatewayLogs(cli)
  registerGatewayBackup(cli)
  registerGatewayRestore(cli)
}
