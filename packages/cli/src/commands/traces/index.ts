import type {goke} from 'goke'

import {registerTracesDeploy} from './deploy'
import {registerTracesIngest} from './ingest'
import {registerTracesLogs} from './logs'
import {registerTracesOpen} from './open'
import {registerTracesReader} from './reader'
import {registerTracesReaderBackend} from './reader-backend'
import {registerTracesSender} from './sender'
import {registerTracesStatus} from './status'

export {getTracesStatusSummary} from './status'

export function registerTracesCommands(cli: ReturnType<typeof goke>): void {
  registerTracesStatus(cli)
  registerTracesDeploy(cli)
  registerTracesLogs(cli)
  registerTracesOpen(cli)
  registerTracesIngest(cli)
  registerTracesSender(cli)
  registerTracesReader(cli)
  registerTracesReaderBackend(cli)
}
