import type {goke} from 'goke'

import {registerUmamiDeploy} from './deploy'
import {registerUmamiLogs} from './logs'
import {registerUmamiStatus} from './status'

export {getUmamiStatusSummary} from './status'

export function registerUmamiCommands(cli: ReturnType<typeof goke>): void {
  registerUmamiStatus(cli)
  registerUmamiDeploy(cli)
  registerUmamiLogs(cli)
}
