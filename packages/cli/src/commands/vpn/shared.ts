import type {AppCollection} from '../../status/collect'

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {redactHost} from '../../lib/redact'
import {buildIdentityArgs} from '../../lib/ssh-identity'
import {observe} from '../../status/collect'
import {declaredObservation} from '../../status/declared'
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
  /** Exit code of the SSH command when it ran and failed; 255 is SSH itself failing. */
  exitCode?: number
}

/**
 * Fetch VPN status via SSH + `wg show wg0`.
 *
 * SSH-only — never calls the Lightsail/AWS API.
 * Validates host before constructing any SSH argv.
 */
export async function getVpnWgStatus(host: string, spawn: SpawnFn = defaultSpawn): Promise<VpnStatusResult> {
  validateVpnHost(host)

  const knownHostsArgs = buildKnownHostsArgs()
  const {args: identityArgs, cleanup} = buildIdentityArgs(process.env.VPN_SSH_KEY)

  const sshCmd = [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    ...knownHostsArgs,
    ...identityArgs,
    `ubuntu@${host}`,
    'sudo wg show wg0',
  ]

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }

  let stdoutText: string
  let stderrText: string
  let exitCode: number

  try {
    const child = spawn(sshCmd, {env, stdout: 'pipe', stderr: 'pipe'})
    ;[stdoutText, stderrText, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
  } finally {
    cleanup()
  }

  if (exitCode !== 0) {
    const redacted = redactHost(stderrText.trim(), host) || 'unknown error'
    return {
      ok: false,
      error: `SSH command failed (exit ${exitCode}): ${redacted}`,
      exitCode,
    }
  }

  const wgShow = parseWgShowOutput(stdoutText)

  return {ok: wgShow.interfaceUp, wgShow}
}

// ─── Unified status aggregator export ────────────────────────────────────────

const SSH_FAILURE_EXIT_CODE = 255

/**
 * Get the VPN's WireGuard observation and facts for the unified status command.
 *
 * SSH + `wg show` only — never calls the Lightsail/AWS API.
 * The MCP runtime needs no AWS credentials to call this function.
 * SSH exit 255 is `unknown` (the interface could not be observed). Any other nonzero exit from
 * `sudo wg show wg0`, or output without an interface, means SSH worked and wg0 is down: `fail`.
 *
 * @param host - The VPN box hostname or IP (validated before SSH).
 * @param spawn - Injectable spawn function (defaults to Bun.spawn).
 */
export async function getVpnStatusSummary(host: string, spawn?: SpawnFn): Promise<AppCollection> {
  const result = await getVpnWgStatus(host, spawn)
  const spec = declaredObservation('vpn', 'wireguard-interface')

  if (result.exitCode === SSH_FAILURE_EXIT_CODE) {
    return {observations: [observe(spec, 'unknown', {detail: {reason: 'ssh-failed'}})], facts: {}}
  }

  if (!result.ok || !result.wgShow) {
    return {observations: [observe(spec, 'fail', {detail: {reason: 'interface-down'}})], facts: {}}
  }

  return {
    observations: [observe(spec, 'pass')],
    facts: {peerCount: result.wgShow.peerCount, serverPublicKey: result.wgShow.serverPublicKey ?? null},
  }
}
