import type {goke} from 'goke'

import {registerBrokerDeploy} from './deploy'
import {registerBrokerLogs} from './logs'
import {registerBrokerStatus} from './status'

export function registerBrokerCommands(cli: ReturnType<typeof goke>): void {
  registerBrokerStatus(cli)
  registerBrokerDeploy(cli)
  registerBrokerLogs(cli)
}
