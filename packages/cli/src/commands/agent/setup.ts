import type {goke} from 'goke'

import {registerSetupCommand, runSetupCommand, type RunSetupDeps, type SetupOptions} from './setup-core'
import {
  applyStorageSetup,
  prepareStorageSetup,
  registerAgentStorageCommand,
  type StorageOptions,
  type StorageSetupDeps,
} from './storage'

export * from './setup-core'
export * from './storage'

export interface AgentSetupOptions extends SetupOptions {
  /** Opt-in S3 handoff verification and variable wiring. */
  storage?: StorageOptions | boolean
}

export interface RunAgentSetupDeps extends RunSetupDeps {
  storage?: StorageSetupDeps
}

export function registerAgentSetup(cli: ReturnType<typeof goke>): void {
  registerSetupCommand(cli, 'agent setup')
  registerAgentStorageCommand(cli)
}

export async function runAgentSetupCommand(options: AgentSetupOptions, deps: RunAgentSetupDeps = {}): Promise<void> {
  const {storage, ...setupOptions} = options
  const {storage: storageDeps, ...setupDeps} = deps

  // Storage prechecks intentionally happen before model setup. A stale
  // manifest, missing AWS resource, static-credential attempt, or OIDC drift
  // therefore produces zero GitHub writes from this command.
  const preparedStorage = storage
    ? await prepareStorageSetup(setupOptions.repo ?? '', storage === true ? {} : storage, storageDeps)
    : undefined

  await runSetupCommand(setupOptions, {
    ...setupDeps,
    commandLabel: deps.commandLabel ?? 'agent setup',
  })

  if (preparedStorage) {
    await applyStorageSetup(preparedStorage, storageDeps)
  }
}
