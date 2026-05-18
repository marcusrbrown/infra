import type {goke} from 'goke'

import {registerGatewayDeploy} from './deploy'
import {registerGatewayLogs} from './logs'
import {registerGatewayStatus} from './status'

export {getGatewayStatusSummary} from './status'

export function registerGatewayCommands(cli: ReturnType<typeof goke>): void {
  registerGatewayStatus(cli)
  registerGatewayDeploy(cli)
  registerGatewayLogs(cli)
}
