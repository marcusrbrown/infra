import type {SpawnFn, SpawnOptions} from '../remote'

import {DETAIL_SENTINEL} from '../remote'

// A spawner for tests: it records every call and answers each remote command from a route function.
// Nothing here starts a process, opens a socket or touches the network.

export interface SpawnCall {
  argv: string[]
  /** The remote command, which is always the last ssh argument. */
  command: string
  /** Bytes the caller wrote to the child's stdin, decoded. */
  stdin: string | undefined
  options: SpawnOptions
}

export interface Reply {
  stdout?: string
  stderr?: string
  exitCode?: number
}

function stream(text: string): ReadableStream<Uint8Array> | null {
  return new Response(text).body
}

export function recordingSpawn(route: (call: SpawnCall) => Reply): {spawn: SpawnFn; calls: SpawnCall[]} {
  const calls: SpawnCall[] = []
  const spawn: SpawnFn = (argv, options) => {
    const call: SpawnCall = {
      argv,
      command: argv.at(-1) ?? '',
      stdin: options.stdin === undefined ? undefined : new TextDecoder().decode(options.stdin),
      options,
    }
    calls.push(call)
    const reply = route(call)
    return {
      stdout: options.stdout === 'pipe' ? stream(reply.stdout ?? '') : null,
      stderr: options.stderr === 'pipe' ? stream(reply.stderr ?? '') : null,
      exited: Promise.resolve(reply.exitCode ?? 0),
    }
  }
  return {spawn, calls}
}

export interface CheckFixture {
  id: string
  status: 'pass' | 'warn' | 'fail' | 'unknown'
  detail: string
}

export function detailBody(
  overrides: {ok?: boolean; stale?: boolean; ran?: boolean; checks?: CheckFixture[]} = {},
): string {
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: '2026-11-20T12:00:00.000Z',
    intervalMs: 300_000,
    ran: overrides.ran ?? true,
    stale: overrides.stale ?? false,
    ok: overrides.ok ?? true,
    at: '2026-11-20T11:58:00.000Z',
    checks: overrides.checks ?? [{id: 'collector-health', status: 'pass', detail: 'collector reports healthy'}],
  })
}

/** What `docker compose exec ... wget` followed by the two sentinel echoes prints. */
export function detailOutput(body: string): string {
  return `${body}\n${DETAIL_SENTINEL}\n`
}

export const RUNNING_SERVICES = [
  {Service: 'caddy', State: 'running', Health: 'healthy'},
  {Service: 'collector', State: 'running', Health: ''},
  {Service: 'health-reporter', State: 'running', Health: 'healthy'},
]
  .map(entry => JSON.stringify(entry))
  .join('\n')
