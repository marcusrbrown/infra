import type {SpawnFn, SpawnOptions} from '../remote'

import {chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {TRACES_APP_DIR} from '../host'
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

// ─── A host that runs the real remote scripts ─────────────────────────────────────────
//
// The ingest scripts are shell. A scratch directory stands in for the app directory and a real `sh` runs the
// script text, so what a script does with the deploy marker, the pending-restarts file, the lock and `.env`
// is proven by its effect on real files. `docker` is a shim that only records its arguments.

/**
 * The host has util-linux `flock`. macOS has none. Where it is missing, a shim over the system `perl` stands in:
 * it takes the same `flock -w SECONDS FD` call and takes a real, kernel-level `flock(2)` on the descriptor, so two
 * shells holding the same file really do exclude each other.
 */
export const HAS_REAL_FLOCK = Bun.which('flock') !== null
export const CAN_LOCK = HAS_REAL_FLOCK || Bun.which('perl') !== null
const FLOCK_SHIM = [
  '#!/usr/bin/perl',
  'use Fcntl qw(:flock);',
  'use Time::HiRes qw(time sleep);',
  'my ($wait, $fd) = (0, undef);',
  'while (@ARGV) { my $arg = shift @ARGV; if ($arg eq "-w") { $wait = shift @ARGV } else { $fd = $arg } }',
  'open(my $fh, ">&=", $fd) or exit 1;',
  'my $deadline = time + $wait;',
  'while (1) { if (flock($fh, LOCK_EX | LOCK_NB)) { exit 0 } if (time >= $deadline) { exit 1 } sleep(0.05) }',
  '',
].join('\n')

export interface ScratchHost {
  /** The directory standing in for the app directory. */
  dir: string
  /** The `.env` text. */
  env: () => string
  /** Create an empty file under the app directory (the deploy marker, the pending-restarts file). */
  touch: (name: string) => void
  exists: (name: string) => boolean
  /** The arguments of every `docker` call, one line each. */
  dockerCalls: () => string[]
  /** Files in the app directory other than the ones the test made: a leftover temporary file shows here. */
  strays: () => string[]
  /** Run a remote script under a real `sh`, with the scratch directory standing in for the app directory. */
  run: (command: string, stdin?: string) => {exitCode: number; stdout: string; stderr: string}
  /** Hold the ingest lock in another process until `release` is called. Resolves once the lock is held. */
  holdLock: (lockFile: string) => Promise<() => void>
  cleanup: () => void
}

export function createScratchHost(initialEnv = 'FOO=bar\nTRACES_INGEST_STATE=held\n'): ScratchHost {
  const root = mkdtempSync(join(tmpdir(), 'traces-remote-'))
  const dir = join(root, 'app')
  const shimDir = join(root, 'shim')
  const dockerLog = join(root, 'docker.log')
  mkdirSync(dir)
  mkdirSync(shimDir)
  writeFileSync(dockerLog, '')
  writeFileSync(join(dir, '.env'), initialEnv)
  writeFileSync(join(shimDir, 'docker'), '#!/bin/sh\necho "$@" >> "$SHIM_DOCKER_LOG"\n')
  chmodSync(join(shimDir, 'docker'), 0o755)
  if (!HAS_REAL_FLOCK && CAN_LOCK) {
    writeFileSync(join(shimDir, 'flock'), FLOCK_SHIM)
    chmodSync(join(shimDir, 'flock'), 0o755)
  }
  const baseline = new Set(readdirSync(dir))
  const environment = {PATH: `${shimDir}:${process.env.PATH ?? ''}`, HOME: dir, SHIM_DOCKER_LOG: dockerLog}
  const localise = (command: string): string => command.replaceAll(TRACES_APP_DIR, dir)

  return {
    dir,
    env: () => readFileSync(join(dir, '.env'), 'utf8'),
    touch: name => {
      writeFileSync(join(dir, name), '')
      baseline.add(name)
    },
    exists: name => existsSync(join(dir, name)),
    dockerCalls: () =>
      readFileSync(dockerLog, 'utf8')
        .split('\n')
        .filter(line => line !== ''),
    strays: () => readdirSync(dir).filter(name => !baseline.has(name) && !name.startsWith('.ingest.lock')),
    run: (command, stdin) => {
      const result = Bun.spawnSync(['sh', '-c', localise(command)], {
        stdin: new TextEncoder().encode(stdin ?? ''),
        env: environment,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      return {exitCode: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString()}
    },
    holdLock: async lockFile => {
      const child = Bun.spawn(
        ['sh', '-c', 'exec 9>>"$1"; flock -w 5 9 && echo held && exec sleep 20', 'sh', localise(lockFile)],
        {env: environment, stdout: 'pipe', stderr: 'pipe'},
      )
      const reader = child.stdout.getReader()
      const first = await reader.read()
      if (!new TextDecoder().decode(first.value).includes('held')) throw new Error('the lock was not taken')
      return () => child.kill()
    },
    cleanup: () => rmSync(root, {recursive: true, force: true}),
  }
}

export const RUNNING_SERVICES = [
  {Service: 'caddy', State: 'running', Health: 'healthy'},
  {Service: 'collector', State: 'running', Health: ''},
  {Service: 'health-reporter', State: 'running', Health: 'healthy'},
]
  .map(entry => JSON.stringify(entry))
  .join('\n')
