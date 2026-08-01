import type {goke} from 'goke'

import {registerSetupCommand, runSetupCommand, type RunSetupDeps, type SetupOptions} from './setup-core'

export * from './setup-core'

export function registerAgentSetup(cli: ReturnType<typeof goke>): void {
  registerSetupCommand(cli, 'agent setup')
}

export async function runAgentSetupCommand(options: SetupOptions, deps: RunSetupDeps = {}): Promise<void> {
  await runSetupCommand(options, {
    ...deps,
    commandLabel: deps.commandLabel ?? 'agent setup',
  })
}
