import type {goke} from 'goke'
import type {ActionCtx} from '../../lib/action-ctx'

import {z} from 'zod'

import {validateVpnHost} from './host'
import {getVpnWgStatus, type SpawnFn} from './shared'

export {getVpnStatusSummary} from './shared'

declare const process: {
  env: Record<string, string | undefined>
  exitCode?: number
}

// ─── Action (exported for direct testing) ────────────────────────────────────

export async function vpnStatusAction(
  options: {key?: string | undefined},
  ctx: ActionCtx,
  spawn?: SpawnFn,
): Promise<void> {
  const hostEnvKey = options.key ?? 'VPN_HOST'
  const host = process.env[hostEnvKey]

  if (!host) {
    ctx.console.error(`VPN host not set. Export ${hostEnvKey} or pass --key <env-name> pointing to a set variable.`)
    ctx.process.exit(1)
    return
  }

  try {
    validateVpnHost(host)
  } catch (error) {
    ctx.console.error(error instanceof Error ? error.message : String(error))
    ctx.process.exit(1)
    return
  }

  ctx.console.log('VPN status')
  ctx.console.log('')

  const result = await getVpnWgStatus(host, spawn)

  if (!result.ok && !result.wgShow) {
    ctx.console.error(`Error: ${result.error ?? 'Unknown error'}`)
    ctx.process.exit(1)
    return
  }

  const wgShow = result.wgShow

  if (wgShow?.serverPublicKey) {
    ctx.console.log(`Server public key: ${wgShow.serverPublicKey}`)
  }

  ctx.console.log(`Peers: ${wgShow?.peerCount ?? 0}`)
  ctx.console.log('')

  if (result.ok && wgShow?.interfaceUp) {
    ctx.console.log('Status: OK')
  } else {
    ctx.console.log('Status: DEGRADED (WireGuard interface not up)')
    ctx.process.exit(1)
  }
}

// ─── Command registration ─────────────────────────────────────────────────────

export function registerVpnStatus(cli: ReturnType<typeof goke>): void {
  cli
    .command('vpn status', 'Show operational health of the VPN box via SSH and wg show.')
    .option(
      '--key [key]',
      z.string().describe('Environment variable name holding the SSH host. Falls back to VPN_HOST when omitted.'),
    )
    .action((options, ctx) => vpnStatusAction(options, ctx))
}
