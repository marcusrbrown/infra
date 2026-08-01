import type {goke} from 'goke'

import {registerSetupCommand} from '../agent/setup-core'

export * from '../agent/setup-core'

/**
 * Compatibility registration for the legacy multiword command.
 * The implementation lives in the neutral agent setup core so `cliproxy`
 * does not remain the architectural owner of generalized agent setup.
 */
export function registerCliproxySetup(cli: ReturnType<typeof goke>): void {
  registerSetupCommand(cli, 'cliproxy setup')
}
