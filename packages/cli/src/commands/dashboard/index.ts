import type {goke} from 'goke'

import {registerDashboardDeploy} from './deploy'
import {registerDashboardLogs} from './logs'
import {registerDashboardStatus} from './status'

export {getDashboardStatusSummary} from './status'

export function registerDashboardCommands(cli: ReturnType<typeof goke>): void {
  registerDashboardStatus(cli)
  registerDashboardDeploy(cli)
  registerDashboardLogs(cli)
}
