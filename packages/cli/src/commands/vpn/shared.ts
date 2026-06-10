import type {StatusSummary} from '../status'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {redactHost} from '../../lib/redact'
import {validateVpnHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
}

// ─── Types ────────────────────────────────────────────────────────────────────

export interface WgShowResult {
  interfaceUp: boolean
  serverPublicKey?: string
  peerCount: number
}

export type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Parse `wg show wg0` output into a structured result.
 *
 * Pure function — no IO.
 */
export function parseWgShowOutput(output: string): WgShowResult {
  const trimmed = output.trim()

  if (!trimmed || !trimmed.includes('interface:')) {
    return {interfaceUp: false, peerCount: 0}
  }

  // Extract server public key from "  public key: <key>" line
  // Use a possessive-style pattern to avoid backtracking: match leading spaces,
  // then the literal label, then capture the key (non-space chars).
  const pubKeyMatch = /^ +public key: +(\S+)/m.exec(trimmed)
  const serverPublicKey = pubKeyMatch?.[1]?.trim()

  // Count peer blocks
  const peerCount = (trimmed.match(/^peer:/gm) ?? []).length

  return {
    interfaceUp: true,
    serverPublicKey,
    peerCount,
  }
}

// ─── SSH-backed status fetch ──────────────────────────────────────────────────

function defaultSpawn(
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
): ReturnType<SpawnFn> {
  return Bun.spawn(cmd, opts) as ReturnType<SpawnFn>
}

export interface VpnStatusResult {
  ok: boolean
  wgShow?: WgShowResult
  error?: string
}

/**
 * Fetch VPN status via SSH + `wg show wg0`.
 *
 * SSH-only — never calls the Lightsail/AWS API.
 * Validates host before constructing any SSH argv.
 */
export async function getVpnWgStatus(host: string, spawn: SpawnFn = defaultSpawn): Promise<VpnStatusResult> {
  validateVpnHost(host)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...buildKnownHostsArgs(),
    `root@${host}`,
    'wg show wg0',
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})

  const [stdoutText, stderrText, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])

  if (exitCode !== 0) {
    const redacted = redactHost(stderrText.trim(), host) || 'unknown error'
    return {
      ok: false,
      error: `SSH command failed (exit ${exitCode}): ${redacted}`,
    }
  }

  const wgShow = parseWgShowOutput(stdoutText)

  return {ok: wgShow.interfaceUp, wgShow}
}

// ─── Unified status aggregator export ────────────────────────────────────────

/**
 * Get a structured VPN status summary for the unified status dashboard.
 *
 * SSH + `wg show` only — never calls the Lightsail/AWS API.
 * The MCP runtime needs no AWS credentials to call this function.
 *
 * @param host - The VPN box hostname or IP (validated before SSH).
 * @param spawn - Injectable spawn function (defaults to Bun.spawn).
 */
export async function getVpnStatusSummary(host: string, spawn?: SpawnFn): Promise<StatusSummary> {
  const result = await getVpnWgStatus(host, spawn)

  if (!result.ok || !result.wgShow) {
    const errorMsg = result.error ?? 'WireGuard interface not up'
    return {
      app: 'vpn',
      http: `ERROR: ${errorMsg}`,
      lastDeploy: '—',
      version: '—',
      contentHash: '—',
      usageStats: '—',
    }
  }

  const {wgShow} = result
  const pubKeyInfo = wgShow.serverPublicKey ? ` pubkey:${wgShow.serverPublicKey}` : ''
  const peerInfo = `${wgShow.peerCount} peer(s)`

  return {
    app: 'vpn',
    http: `OK: wg0 up,${pubKeyInfo} ${peerInfo}`,
    lastDeploy: '—',
    version: '—',
    contentHash: '—',
    usageStats: '—',
  }
}
