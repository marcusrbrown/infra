import type {goke} from 'goke'

import {registerAgentSetup} from './setup'

export function registerAgentCommands(cli: ReturnType<typeof goke>): void {
  registerAgentSetup(cli)
}
