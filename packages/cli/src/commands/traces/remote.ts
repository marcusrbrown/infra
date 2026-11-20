// ─── Remote commands over SSH ─────────────────────────────────────────────────
//
// One place that builds every ssh argv the traces commands use, so the rules hold for all of them:
//   - the host is validated before it reaches an argv, and nothing else from the caller does
//   - host keys come from the pinned known_hosts file, with StrictHostKeyChecking=yes
//   - the argv is an array handed to the spawner, never a shell string on this side
//   - a remote command is a fixed string. Anything that varies (a file's contents) goes over stdin
//   - a remote probe prints a sentinel; success needs exit 0 and a recognised sentinel
//   - no remote command redirects to the null device, deletes outside the app directory and /tmp, or
//     redirects a descriptor to a device file

import {buildKnownHostsArgs} from '../../lib/known-hosts'
import {redactHost} from '../../lib/redact'
import {buildIdentityArgs} from '../../lib/ssh-identity'
import {TRACES_APP_DIR, validateTracesHost} from './host'

declare const process: {
  env: Record<string, string | undefined>
}

// ─── Spawning ─────────────────────────────────────────────────────────────────

export interface SpawnOptions {
  env: Record<string, string>
  stdout: 'pipe' | 'inherit'
  stderr: 'pipe' | 'inherit'
  /** Bytes written to the child's stdin and then closed. Omitted: stdin is not connected. */
  stdin?: Uint8Array
  signal?: AbortSignal
}

export interface SpawnedChild {
  stdout: ReadableStream<Uint8Array> | null
  stderr: ReadableStream<Uint8Array> | null
  exited: Promise<number>
}

export type SpawnFn = (cmd: string[], opts: SpawnOptions) => SpawnedChild

export function defaultSpawn(cmd: string[], opts: SpawnOptions): SpawnedChild {
  const {stdin, ...rest} = opts
  return Bun.spawn(cmd, {...rest, ...(stdin === undefined ? {} : {stdin})}) as SpawnedChild
}

function childEnv(): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: process.env.HOME ?? '/tmp',
    ...(process.env.SSH_AUTH_SOCK ? {SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK} : {}),
  }
}

// ─── ssh argv ─────────────────────────────────────────────────────────────────

const REMOTE_USER = 'root'

/** Options every ssh invocation carries. */
function baseSshArgs(): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', ...buildKnownHostsArgs()]
}

export interface SshArgv {
  argv: string[]
  /** Removes the temporary identity file, if one was written. */
  cleanup: () => void
}

/** `ssh ... root@host '<remote command>'`. The host is validated here, once, for every caller. */
export function buildRemoteArgv(host: string, remoteCommand: string): SshArgv {
  validateTracesHost(host)
  const identity = buildIdentityArgs(process.env.TRACES_SSH_KEY)
  return {
    argv: ['ssh', ...baseSshArgs(), ...identity.args, `${REMOTE_USER}@${host}`, remoteCommand],
    cleanup: identity.cleanup,
  }
}

export interface TunnelPorts {
  langfuse: number
  grafana: number
}

/**
 * `ssh -N -L ...` forwarding exactly the two given loopback ports to the same loopback ports on the host.
 * No command runs on the host. Nothing is forwarded unless it is listed here.
 */
export function buildTunnelArgv(host: string, ports: TunnelPorts): SshArgv {
  validateTracesHost(host)
  const identity = buildIdentityArgs(process.env.TRACES_SSH_KEY)
  const forward = (port: number): string => `127.0.0.1:${port}:127.0.0.1:${port}`
  return {
    argv: [
      'ssh',
      '-N',
      ...baseSshArgs(),
      '-o',
      'ExitOnForwardFailure=yes',
      '-o',
      'ServerAliveInterval=30',
      '-L',
      forward(ports.langfuse),
      '-L',
      forward(ports.grafana),
      ...identity.args,
      `${REMOTE_USER}@${host}`,
    ],
    cleanup: identity.cleanup,
  }
}

// ─── Running a remote command ─────────────────────────────────────────────────

export interface RemoteResult {
  exitCode: number
  stdout: string
  stderr: string
}

export interface RunRemoteOptions {
  spawn?: SpawnFn
  signal?: AbortSignal
  /** Contents handed to the remote command on stdin. */
  stdin?: string
}

/**
 * Run one fixed remote command. Standard error comes back with the host name removed, so an error shown to
 * an MCP consumer or a log cannot carry a misdirected secret.
 */
export async function runRemote(
  host: string,
  remoteCommand: string,
  options: RunRemoteOptions = {},
): Promise<RemoteResult> {
  const {argv, cleanup} = buildRemoteArgv(host, remoteCommand)
  const spawn = options.spawn ?? defaultSpawn
  try {
    const child = spawn(argv, {
      env: childEnv(),
      stdout: 'pipe',
      stderr: 'pipe',
      ...(options.stdin === undefined ? {} : {stdin: new TextEncoder().encode(options.stdin)}),
      ...(options.signal === undefined ? {} : {signal: options.signal}),
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      child.stdout === null ? Promise.resolve('') : new Response(child.stdout).text(),
      child.stderr === null ? Promise.resolve('') : new Response(child.stderr).text(),
      child.exited,
    ])
    return {exitCode, stdout, stderr: redactHost(stderr.trim(), host)}
  } finally {
    cleanup()
  }
}

/** Run a command attached to this terminal, for `traces logs` and the tunnel. */
export async function runAttached(argv: SshArgv, spawn: SpawnFn = defaultSpawn): Promise<number> {
  try {
    const child = spawn(argv.argv, {env: childEnv(), stdout: 'inherit', stderr: 'inherit'})
    return await child.exited
  } finally {
    argv.cleanup()
  }
}

/** True when a probe's output has a line that is exactly the sentinel, and the command exited 0. */
export function hasSentinel(result: RemoteResult, sentinel: string): boolean {
  return result.exitCode === 0 && result.stdout.split('\n').some(line => line.trim() === sentinel)
}

// ─── Fixed remote commands ────────────────────────────────────────────────────

const COMPOSE = `docker compose --project-directory ${TRACES_APP_DIR}`

export const DETAIL_SENTINEL = 'TRACES_DETAIL_END'

// The host's deploy and ingest-state files. Repeated from `apps/traces/src/host.ts` (`packages/` never imports
// `apps/`); a test pins each value to that file.

/** Written by a deploy before its first change and removed as its last step. A failed deploy leaves it. */
export const TRACES_DEPLOY_MARKER = `${TRACES_APP_DIR}/.deploy-in-progress`

/** Restarts a failed deploy left undone. */
export const TRACES_PENDING_RESTARTS = `${TRACES_APP_DIR}/.pending-restarts`

/** `flock` file taken by every script that reads-then-writes the ingest state and recreates Caddy. */
export const TRACES_INGEST_LOCK = `${TRACES_APP_DIR}/.ingest.lock`

/** Printed, with exit 1 and nothing changed, when the ingest lock was not free within 30 seconds. */
export const LOCK_BUSY_SENTINEL = 'TRACES_INGEST_LOCK_BUSY'

/** Printed (exit 0) by the open script when a deploy is running or did not finish. Nothing was changed. */
export const OPEN_REFUSED_SENTINEL = 'TRACES_INGEST_OPEN_REFUSED'

export const DEPLOY_FINISHED_SENTINEL = 'TRACES_DEPLOY=finished'
export const DEPLOY_UNFINISHED_SENTINEL = 'TRACES_DEPLOY=unfinished'

const DEPLOY_UNFINISHED_TEST = `[ -e ${TRACES_DEPLOY_MARKER} ] || [ -e ${TRACES_PENDING_RESTARTS} ]`

/**
 * The ingest lock, taken before anything is read or written and held until the script exits. Descriptor 9 holds
 * the lock file open and `flock -w 30` takes the lock on it, so the lock is released by the shell ending, however
 * it ends. A lock not free in 30 seconds prints the busy sentinel, exits 1 and has changed nothing. The only
 * thing ever redirected to is the lock file: a regular file under the app directory.
 */
const LOCK_INGEST = [
  `l=${TRACES_INGEST_LOCK}`,
  'exec 9>>"$l"',
  `flock -w 30 9 || { echo ${LOCK_BUSY_SENTINEL}; exit 1; }`,
]

export const REMOTE_COMMANDS = {
  composePs: `${COMPOSE} ps --all --format json`,
  /** The reporter's loopback listener, reached by exec because nothing publishes it. */
  reporterDetail: `${COMPOSE} exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail && echo && echo ${DETAIL_SENTINEL}`,
  logs: (service: string, tail: number): string => `${COMPOSE} logs --no-color --tail=${tail} ${service}`,
  /** The ingest state as the host's `.env` says it. Prints `TRACES_INGEST_STATE=<state>` or fails. */
  readIngestState: `test -f ${TRACES_APP_DIR}/.env && s=$(sed -n 's/^TRACES_INGEST_STATE=//p' ${TRACES_APP_DIR}/.env | tail -n 1) && echo "TRACES_INGEST_STATE=\${s:-off}"`,
  /**
   * Whether a deploy is running or did not finish: the marker or the pending-restarts file exists. Prints
   * `TRACES_DEPLOY=unfinished` or `TRACES_DEPLOY=finished`. Reads only; takes no lock.
   */
  readDeployState: `if ${DEPLOY_UNFINISHED_TEST}; then echo ${DEPLOY_UNFINISHED_SENTINEL}; else echo ${DEPLOY_FINISHED_SENTINEL}; fi`,
  /**
   * Replace the TRACES_INGEST_STATE line of `.env` with the line on stdin, atomically, and recreate only
   * the Caddy container, which reads the state when it starts. Prints the sentinel only after both steps.
   *
   * It runs under `flock -w 30` on the ingest lock, so no other transition (a deploy's hold, another command)
   * interleaves. Only opening is restricted: inside that same locked script, opening prints
   * `TRACES_INGEST_OPEN_REFUSED` and changes nothing when the deploy marker or the pending-restarts file
   * exists, so there is no gap between the check and the write. Holding is never refused.
   */
  writeIngestState: (state: IngestState): string =>
    [
      'set -e',
      `cd ${TRACES_APP_DIR}`,
      ...LOCK_INGEST,
      ...(state === 'open' ? [`if ${DEPLOY_UNFINISHED_TEST}; then echo ${OPEN_REFUSED_SENTINEL}; exit 0; fi`] : []),
      'test -f .env',
      't=$(mktemp ./.env.XXXXXX)',
      `{ grep -v '^TRACES_INGEST_STATE=' .env || true; cat; } > "$t"`,
      'chmod 600 "$t"',
      'mv "$t" .env',
      `${COMPOSE} up -d --force-recreate --no-deps caddy`,
      `echo TRACES_INGEST_STATE_SET=${state}`,
    ].join('; '),
} as const

export type IngestState = 'off' | 'held' | 'open'

export function ingestStateSentinel(state: IngestState): string {
  return `TRACES_INGEST_STATE_SET=${state}`
}
