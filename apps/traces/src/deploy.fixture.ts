// A simulated traces host behind a recording `Runner`, for the deploy tests. Nothing here spawns a process or
// reaches a network. The simulation answers the deploy's remote steps by their `# traces-step:` marker and keeps
// just enough state (files, the ingest state, what Caddy serves, ClickHouse tables, the object store, the
// reporter's verdict, the bootstrap key) for a second deploy to see what the first one left.

import type {Runner, RunResult} from '../server/provision'
import type {DeployDeps, DeployInputs, IngestState} from './deploy'

import {chmodSync, writeFileSync} from 'node:fs'
import {join} from 'node:path'

import {
  ALERT_CONTACT_POINT_UID,
  ALERT_RULE_GROUPS,
  GATED_SERVICES,
  generateVoidTokenLine,
  REPORTER_DETAIL_COMMAND,
  SERVICES,
} from './deploy'
import {SENDER_GROUPS, TRACES_DEPLOY_MARKER, TRACES_VOID_TOKEN_PREFIX} from './host'
import {OBJECT_STORE_PREFIXES, RETENTION_TABLES} from './retention'

export const EPOCH = 1_700_000_000

/** The owner and mode a script's own `chown` and `chmod` give its temporary file, as `stat -c '%u:%g %a'` prints them. */
function attributesOf(command: string): string {
  const owner = /\bchown (\S+) "\$t"/.exec(command)?.[1] ?? 'unset:unset'
  const mode = /\bchmod (\d+) "\$t"/.exec(command)?.[1] ?? '0'
  const numeric = owner.replaceAll('root', '0')
  return `${numeric} ${Number.parseInt(mode, 8).toString(8)}`
}

/**
 * What the simulation reads out of a script's text, so that it behaves as the script would: the owner id in the
 * ownership prelude, and the id the first script writes into the marker.
 */
const OWNER_CHECK = /\[ "\$traces_owner" = ([\da-f]{32,128}) \]/
const HEX_ID = /\b([\da-f]{32,128})\b/

/**
 * The step lock as the script text takes it: `exec 8>>FILE; if ! flock -w SECONDS 8; then echo SENTINEL; exit 1; fi`.
 * The simulation waits for the lock for that many seconds of simulated time (`FakeHost.elapse`), and answers with
 * the script's own sentinel when the time runs out. A script without that text takes no lock.
 */
const STEP_LOCK = /exec 8>>(\S+); if ! flock -w (\d+) 8; then echo (\w+); exit 1; fi/

/** Steps that change nothing on the host. Every other step must carry the ownership prelude (default-deny). */
const READ_ONLY_STEPS: readonly RegExp[] = [
  /^ssh-exit$/,
  /^storage-probe$/,
  /^host-state$/,
  /^compare:/,
  /^token-dirs$/,
  /^ingest-state$/,
  /^drift-check$/,
  /^disk-free$/,
  /^digest:/,
  /^bootstrap-probe$/,
  /^bootstrap-hygiene$/,
  /^grafana-signin$/,
  /^grafana-alerting$/,
  /^probe-ingest$/,
  /^retention-read-/,
  /^raw:reporter-detail$/,
]

/** True for a step that changes nothing on the host. Everything else must carry the ownership prelude. */
export function isReadOnlyStep(step: string): boolean {
  return READ_ONLY_STEPS.some(pattern => pattern.test(step))
}

const ok = (stdout: string): RunResult => ({exitCode: 0, stdout, stderr: ''})
const fail = (stderr: string, exitCode = 1): RunResult => ({exitCode, stdout: '', stderr})

export interface Call {
  argv: readonly string[]
  command: string
  stdin: string | undefined
  /** The step marker, or `raw:<what>` for the two commands the CLI shares, or `ssh-exit`. */
  step: string
}

export interface FakeOptions {
  /** Replace the storage probe's whole answer. */
  storageAnswer?: RunResult
  /** Reply to a step instead of simulating it. Return undefined to fall through. */
  override?: (step: string, call: Call) => RunResult | undefined
  /** Free bytes the host reports. */
  freeBytes?: number
  /** The digest the running collector reports, instead of the one in `.env`. */
  runningDigest?: string
  /** Status the bootstrap probe answers, instead of deriving it from whether the key is live. */
  bootstrapStatus?: string
  /** Setting the ingest state succeeds but Caddy keeps serving what it served. */
  stateIgnored?: boolean
  /**
   * The remote command that sets this state runs and takes effect, but its reply is lost (ssh drops): the caller
   * sees a failed command. Fires once.
   */
  loseReplyOn?: IngestState
  /**
   * Called after a step has passed its ownership check, before it does its work. A promise keeps the step "in
   * flight": it holds the step lock (if its script text takes one) until the promise settles.
   */
  inFlight?: (step: string, call: Call) => Promise<void> | undefined
  /** Mutations of the reporter's verdict. */
  checkStatus?: Record<string, 'pass' | 'warn' | 'fail' | 'unknown'>
  /** Seconds the reporter's verdict is dated after the restart (negative: older than the restart). */
  verdictOffset?: number
  /** The reporter's `ok` flag, `ran` and `stale`. */
  verdict?: {ok?: boolean; ran?: boolean; stale?: boolean}
  /** The reporter cannot be read at all. */
  reporterUnreadable?: boolean
  /** The canary command fails (exec error, or output that is not the expected document). */
  canaryUnreadable?: boolean | 'garbled'
  /** Probe answers per route state, instead of the simulation's. */
  probeOverride?: (served: IngestState | 'none') => Record<string, number> | undefined
  /** ClickHouse tables that exist at the start (name -> ttl text as ClickHouse echoes it). */
  tables?: Record<string, string | undefined>
  /** ALTER answers success but changes nothing. */
  alterIgnored?: boolean
  /**
   * The HTTP code Grafana gives the sign-in check with the password file's password (`000` is no answer), or a
   * function of the attempt (1 for the first). Default: 200.
   */
  grafana?: string | ((attempt: number) => string)
  /**
   * What Grafana's provisioning API says about alerting: everything the files define (default), or one thing wrong.
   */
  alerting?: 'no-contact-point' | 'wrong-type' | 'no-group' | 'partial-group' | 'http-401'
}

export class FakeHost {
  calls: Call[] = []
  /** Plain files by path relative to the app directory. */
  files = new Map<string, string>()
  /** The `.env` content without its state line, and the state line. */
  env: string | undefined
  envState: IngestState | undefined
  /** What Caddy is serving right now. */
  served: IngestState | 'none' = 'none'
  /**
   * Owner and mode of a plain file or `.env`, by path, in the form `stat -c '%u:%g %a'` prints (`472:472 400`).
   * Set by a write from the script's own `chown` and `chmod`; a test sets one to simulate drift. A file with no
   * entry has whatever the deploy would set, so that a seeded file is not drift.
   */
  fileAttrs = new Map<string, string>()
  /** Token files, by group. `undefined` is absent. */
  tokens = new Map<string, string | undefined>()
  /** Owner and mode of a token file, by group, as `fileAttrs`. Only creating a token file ever sets one. */
  tokenAttrs = new Map<string, string>()
  pendingRestarts: string[] = []
  /** The deploy marker's content, when it exists. */
  marker: string | undefined
  /** The marker was written by a script that did not take the ingest lock. */
  unlockedMarker = false
  /** Steps refused because the marker no longer held the id in their prelude (they changed nothing). */
  refused: string[] = []
  /** Steps that change the host and carried no ownership prelude. A correct deploy leaves this empty. */
  unguarded: string[] = []
  /** Steps that change the host, or take it over, and did not take the step lock. A correct deploy leaves this empty. */
  unlocked: string[] = []
  /** Who holds the step lock right now (the step's name), and who is waiting for it, in order. */
  stepLockHolder: string | undefined
  private stepWaiters: {step: string; remaining: number; resolve: (got: boolean) => void}[] = []
  /** What happened, in order: `lock:<step>`, `marker:<id>`, `done:<step>` (the lock is released), `busy:<step>`. */
  events: string[] = []
  /** What each compose service is running: whether it runs, and its `config-hash` label. */
  running = new Map<string, {running: boolean; hash: string}>()
  private replyLost = false
  bootstrapPending: string | undefined
  /** Langfuse holds a live full-access bootstrap key. */
  bootstrapKeyLive = false
  /** The running Langfuse container carries bootstrap key variables. */
  runningHasBootstrap = false
  /** The image the running collector was started from. */
  runningImage: string | undefined
  reporterAt = EPOCH - 100
  /** How many times the canary command actually ran (a refused step does not count). */
  canaryRuns = 0
  tables: Map<string, string | undefined>
  rules: {Prefix: string; Days: number}[] = []
  clock = EPOCH

  constructor(readonly options: FakeOptions = {}) {
    this.tables = new Map(
      Object.entries(
        options.tables ?? {events_full: undefined, events_core: undefined, topic_facet_summaries: undefined},
      ),
    )
  }

  readonly run: Runner = async (argv, runOptions) => {
    const command = argv.at(-1) ?? ''
    const call: Call = {
      argv,
      command,
      stdin: runOptions?.stdin,
      step: argv.includes('-O') && argv.includes('exit') ? 'ssh-exit' : stepOf(command),
    }
    this.calls.push(call)
    // What the script's own ownership check does: the marker must still hold this deploy's id.
    const owner = OWNER_CHECK.exec(command)?.[1]
    if (owner === undefined && !isReadOnlyStep(call.step)) {
      this.unguarded.push(call.step)
    }
    const lock = STEP_LOCK.exec(command)
    if (lock === null && (owner !== undefined || call.step === 'host-state')) this.unlocked.push(call.step)
    const step = call.step
    if (lock?.[2] !== undefined && !(await this.takeStepLock(step, Number(lock[2])))) {
      this.events.push(`busy:${step}`)
      return {exitCode: 1, stdout: `${lock[3] ?? ''}\n`, stderr: ''}
    }
    try {
      if (owner !== undefined && this.markerOwner() !== owner) {
        this.refused.push(call.step)
        return {exitCode: 1, stdout: 'DEPLOY_OVERTAKEN\n', stderr: ''}
      }
      if (lock !== null || owner !== undefined) await this.options.inFlight?.(call.step, call)
      const overridden = this.options.override?.(call.step, call)
      if (overridden !== undefined) return overridden
      return this.handle(call)
    } finally {
      if (lock !== null) this.releaseStepLock(step)
    }
  }

  private takeStepLock(step: string, waitSeconds: number): Promise<boolean> {
    if (this.stepLockHolder === undefined) {
      this.stepLockHolder = step
      this.events.push(`lock:${step}`)
      return Promise.resolve(true)
    }
    return new Promise<boolean>(resolve => {
      this.stepWaiters.push({step, remaining: waitSeconds, resolve})
    })
  }

  private releaseStepLock(step: string): void {
    this.events.push(`done:${step}`)
    const next = this.stepWaiters.shift()
    if (next === undefined) {
      this.stepLockHolder = undefined
      return
    }
    // The lock goes to the first one waiting, before anything else can ask for it.
    this.stepLockHolder = next.step
    this.events.push(`lock:${next.step}`)
    next.resolve(true)
  }

  /** The steps waiting for the step lock, in order. */
  get waitingForStepLock(): string[] {
    return this.stepWaiters.map(waiter => waiter.step)
  }

  /** Simulated seconds pass: a step whose `flock -w` has run out gives up, as the script does. */
  elapse(seconds: number): void {
    for (const waiter of [...this.stepWaiters]) {
      waiter.remaining -= seconds
      if (waiter.remaining <= 0) {
        this.stepWaiters.splice(this.stepWaiters.indexOf(waiter), 1)
        waiter.resolve(false)
      }
    }
  }

  /** The id the marker holds: its first field. */
  markerOwner(): string | undefined {
    return this.marker?.split(' ')[0]
  }

  get steps(): string[] {
    return this.calls.map(call => call.step)
  }

  indexOf(step: string | RegExp): number {
    return this.steps.findIndex(entry => (typeof step === 'string' ? entry === step : step.test(entry)))
  }

  count(step: string | RegExp): number {
    return this.steps.filter(entry => (typeof step === 'string' ? entry === step : step.test(entry))).length
  }

  stdinFor(step: string): string | undefined {
    return this.calls.find(call => call.step === step)?.stdin
  }

  setStates(): IngestState[] {
    return this.calls
      .filter(call => call.step.startsWith('raw:set-state:'))
      .map(call => call.step.slice('raw:set-state:'.length) as IngestState)
  }

  writes(): string[] {
    return this.steps.filter(entry => entry.startsWith('write:')).map(entry => entry.slice('write:'.length))
  }

  private handle(call: Call): RunResult {
    const {step, command, stdin = ''} = call
    if (step === 'ssh-exit') return ok('')

    if (step === 'raw:set-state') {
      const state = /^TRACES_INGEST_STATE=(off|held|open)$/m.exec(stdin)?.[1] as IngestState | undefined
      if (state === undefined) return fail('bad state line')
      call.step = `raw:set-state:${state}`
      this.envState = state
      if (!this.options.stateIgnored) {
        this.served = state
        this.running.set('caddy', {running: true, hash: this.expectedHash('caddy')})
      }
      if (this.options.loseReplyOn === state && !this.replyLost) {
        this.replyLost = true
        return {exitCode: 255, stdout: '', stderr: 'client_loop: send disconnect: Broken pipe'}
      }
      return ok(`TRACES_INGEST_STATE_SET=${state}\n`)
    }
    if (step === 'raw:reporter-detail') {
      if (this.options.reporterUnreadable) return fail('exec failed')
      return ok(`${JSON.stringify(this.reporterDetail())}\nTRACES_DETAIL_END\n`)
    }
    if (step === 'reporter-canary') {
      this.canaryRuns += 1
      if (this.options.canaryUnreadable === 'garbled') return ok('not json\nTRACES_CANARY_END\n')
      if (this.options.canaryUnreadable) return fail('exec failed')
      return ok(`${JSON.stringify({schemaVersion: 1, checks: this.canaryChecks()})}\nTRACES_CANARY_END\n`)
    }

    switch (true) {
      case step === 'storage-probe': {
        return (
          this.options.storageAnswer ??
          ok(
            [
              'mount_source=/dev/sda',
              'root_source=/dev/vda1',
              'sentinel=traces-volume-v1',
              'docker_root=/mnt/traces/docker',
              'containerd_root=/mnt/traces/containerd',
              'docker_source=/dev/sda',
              'containerd_source=/dev/sda',
              'TRACES_STORAGE_PROBED',
              '',
            ].join('\n'),
          )
        )
      }
      case step === 'host-state': {
        const pair = this.envBootstrapPair()
        const reply = ok(
          [
            `has_env=${this.env === undefined ? 0 : 1}`,
            `marker=${this.marker === undefined ? 0 : 1}`,
            `ingest=${this.envState ?? 'none'}`,
            `env_bootstrap_public=${pair?.[0] ?? ''}`,
            `env_bootstrap_secret=${pair?.[1] ?? ''}`,
            `pending=${this.bootstrapPending ?? ''}`,
            `restarts=${this.pendingRestarts.join(' ')}`,
            `epoch=${this.clock}`,
            'TRACES_HOST_STATE_READ',
            '',
          ].join('\n'),
        )
        // The script writes the marker only if its text says so, and under the lock only if its text says so.
        if (command.includes('mv -f') && command.includes(TRACES_DEPLOY_MARKER)) {
          this.marker = `${HEX_ID.exec(command)?.[1] ?? 'no-id'} ${new Date(this.clock * 1000).toISOString()}\n`
          this.events.push(`marker:${this.markerOwner()}`)
          if (!command.includes('flock -w 30')) this.unlockedMarker = true
        }
        return reply
      }
      case step === 'prepare-dirs': {
        return ok('TRACES_DIRS_READY\n')
      }
      case step.startsWith('token-file:'): {
        const group = step.slice('token-file:'.length)
        if (this.tokens.get(group) === undefined) {
          // Created with exactly what arrived on stdin (the void line), or empty if the script sent nothing.
          this.tokens.set(group, stdin === '' ? '' : `${stdin.trimEnd()}\n`)
          this.tokenAttrs.set(group, attributesOf(command))
          return ok('TRACES_TOKEN_CREATED\n')
        }
        return ok('TRACES_TOKEN_PRESENT\n')
      }
      case step === 'token-dirs': {
        const counting = command.includes('awk')
        const lines = SENDER_GROUPS.map(group => {
          const content = this.tokens.get(group)
          if (content === undefined) return `token_file=${group}:absent`
          if (!counting) return `token_file=${group}:present`
          if (content.trim() === '') return `token_file=${group}:empty`
          const real = content
            .split('\n')
            .map(line => line.trim().split(/\s+/)[0] ?? '')
            .filter(first => first !== '' && !first.startsWith(TRACES_VOID_TOKEN_PREFIX)).length
          return `token_file=${group}:tokens:${real}`
        })
        return ok(`${lines.join('\n')}\nTRACES_TOKEN_DIRS_CHECKED\n`)
      }
      case step.startsWith('compare:'): {
        const path = step.slice('compare:'.length)
        const current = path === '.env' ? this.env : this.files.get(path)
        if (current === undefined) return ok('TRACES_FILE_ABSENT\n')
        if (current !== stdin) return ok('TRACES_FILE_DIFFERENT\n')
        // The script compares the file's owner and mode with the pair it names, if its text says to.
        // (The command arrives shell-quoted, so each single quote of the script may be spelled `'\''`.)
        const expected = /\[ "\$attr" = ['\\]+([^'\\]+)/.exec(command)?.[1]
        if (expected !== undefined && (this.fileAttrs.get(path) ?? expected) !== expected) {
          return ok('TRACES_FILE_DIFFERENT\n')
        }
        return ok('TRACES_FILE_SAME\n')
      }
      case step.startsWith('write:'): {
        const path = step.slice('write:'.length)
        if (path === '.env') {
          this.env = stdin
          const planned = /planned=(off|held|open)/.exec(command)?.[1] as IngestState | undefined
          if (planned === undefined) {
            this.envState = /TRACES_INGEST_STATE=%s.*? (off|held|open) >>/.exec(command)?.[1] as IngestState
          } else if (command.includes('flock -w 30') && (this.envState === 'held' || this.envState === 'off')) {
            // Re-read under the lock: never write a state more open than the one on the host.
          } else {
            this.envState = planned
          }
        } else if (path === '.deploy-in-progress') {
          this.marker = stdin
        } else if (path === '.pending-restarts') {
          this.pendingRestarts = stdin.split('\n').filter(line => line !== '')
        } else if (path === 'secrets/bootstrap-pending') {
          this.bootstrapPending = stdin
        } else {
          this.files.set(path, stdin)
        }
        if (path === '.env' || !path.startsWith('.')) this.fileAttrs.set(path, attributesOf(command))
        return ok(
          path === '.env' && this.envState !== undefined
            ? `TRACES_ENV_STATE=${this.envState}\nTRACES_FILE_WRITTEN\n`
            : 'TRACES_FILE_WRITTEN\n',
        )
      }
      case step === 'remove:.deploy-in-progress': {
        this.marker = undefined
        return ok('TRACES_REMOVED\n')
      }
      case step === 'ingest-state': {
        return ok(`ingest=${this.envState ?? 'none'}\nTRACES_INGEST_STATE_READ\n`)
      }
      case step === 'drift-check': {
        const lines = GATED_SERVICES.map(service => {
          const entry = this.running.get(service)
          if (entry === undefined) return `drift ${service} missing`
          if (!entry.running) return `drift ${service} stopped`
          return entry.hash === this.expectedHash(service) ? `same ${service}` : `drift ${service} hash`
        })
        return ok(`${lines.join('\n')}\nTRACES_DRIFT_CHECKED\n`)
      }
      case step === 'remove:.pending-restarts': {
        this.pendingRestarts = []
        return ok('TRACES_REMOVED\n')
      }
      case step === 'remove:secrets/bootstrap-pending': {
        this.bootstrapPending = undefined
        return ok('TRACES_REMOVED\n')
      }
      case step === 'disk-free': {
        return ok(`free_bytes=${this.options.freeBytes ?? 60 * 1024 ** 3}\nTRACES_DISK_PROBED\n`)
      }
      case step === 'prune-images':
      case step === 'pull':
      case step.startsWith('pull-'):
      case step === 'create-collector':
      case step === 'create-prometheus':
      case step === 'create-embedder': {
        return ok(`epoch=${this.clock}\nTRACES_STEP_OK:${step}\n`)
      }
      case step === 'queue-volume': {
        return ok('TRACES_QUEUE_VOLUME_READY\n')
      }
      case step === 'prometheus-volume': {
        return ok('TRACES_PROMETHEUS_VOLUME_READY\n')
      }
      case step === 'embedder-volume': {
        return ok('TRACES_EMBEDDER_VOLUME_READY\n')
      }
      case step.startsWith('up-'): {
        return this.up(step, command)
      }
      case step === 'digest:collector': {
        const digest = this.options.runningDigest ?? /@(sha256:[\da-f]{64})/.exec(this.runningImage ?? '')?.[1] ?? ''
        return ok(`repo_digests=["ghcr.io/example/repo/traces-collector@${digest}"]\nTRACES_DIGEST_READ\n`)
      }
      case step === 'bootstrap-probe': {
        const status = this.options.bootstrapStatus ?? (this.bootstrapKeyLive ? '200' : '401')
        return ok(`TRACES_BOOTSTRAP_HTTP=${status}\nTRACES_BOOTSTRAP_PROBED\n`)
      }
      case step === 'bootstrap-hygiene': {
        const inEnv = this.envBootstrapPair() === undefined ? 0 : 2
        return ok(
          `TRACES_HYGIENE env_file=${inEnv} running=${this.runningHasBootstrap ? 2 : 0}\nTRACES_HYGIENE_CHECKED\n`,
        )
      }
      case step === 'grafana-signin': {
        const attempt = this.count('grafana-signin')
        const configured = this.options.grafana ?? '200'
        const code = typeof configured === 'function' ? configured(attempt) : configured
        return ok(`TRACES_GRAFANA_FILE_HTTP=${code}\nTRACES_GRAFANA_PROBED\n`)
      }
      case step === 'grafana-alerting': {
        return ok(this.alertingAnswer())
      }
      case step === 'probe-ingest': {
        const codes = this.options.probeOverride?.(this.served) ?? this.probeCodes()
        const lines = SENDER_GROUPS.map(
          group => `TRACES_INGEST_CODE ${group} ${String(codes[group] ?? 0).padStart(3, '0')}`,
        )
        return ok(`${lines.join('\n')}\nTRACES_INGEST_PROBED\n`)
      }
      case step.startsWith('retention-'): {
        return this.retention(step, command, stdin)
      }
      default: {
        return fail(`unexpected step ${step}`)
      }
    }
  }

  /**
   * `traces ingest open` by another operator. Like the CLI's script, it is refused while a deploy marker or a
   * pending-restart record exists. Returns whether the route was opened.
   */
  manualOpen(): boolean {
    if (this.marker !== undefined || this.pendingRestarts.length > 0) return false
    this.envState = 'open'
    this.served = 'open'
    return true
  }

  /** `traces ingest hold` by another operator: always allowed. */
  manualHold(): void {
    this.envState = 'held'
    this.served = 'held'
  }

  /** What `docker compose config --hash <service>` would answer for the files on the host now. */
  expectedHash(service: string): string {
    const env = (this.env ?? '')
      .split('\n')
      .filter(line => !line.startsWith('TRACES_INGEST_STATE='))
      .join('\n')
    return `${service}:${Bun.hash(`${this.files.get('docker-compose.yaml') ?? ''}\u0000${env}`).toString(16)}`
  }

  /** What the alerting probe prints for the configured state of Grafana's provisioned alerting. */
  private alertingAnswer(): string {
    const mode = this.options.alerting
    const type = mode === 'wrong-type' ? 'webhook' : 'discord'
    const points =
      mode === 'no-contact-point'
        ? '[]'
        : `[{"uid":"${ALERT_CONTACT_POINT_UID}","name":"Traces Discord","type":"${type}","settings":{},"disableResolveMessage":false,"provenance":"file"}]`
    const groups = ALERT_RULE_GROUPS.filter((_group, index) => !(mode === 'no-group' && index === 0)).map(group => {
      const count = mode === 'partial-group' && group === ALERT_RULE_GROUPS[0] ? group.rules - 1 : group.rules
      return `TRACES_GRAFANA_RULE_GROUP=${group.name} ${count}`
    })
    const code = mode === 'http-401' ? '401' : '200'
    return [
      `TRACES_GRAFANA_CP_HTTP=${code}`,
      `TRACES_GRAFANA_CP_BODY=${points}`,
      `TRACES_GRAFANA_RULES_HTTP=${code}`,
      ...groups,
      'TRACES_GRAFANA_ALERTING_PROBED',
      '',
    ].join('\n')
  }

  private envBootstrapPair(): [string, string] | undefined {
    const publicKey = /^LANGFUSE_INIT_PROJECT_PUBLIC_KEY=(.+)$/m.exec(this.env ?? '')?.[1]
    const secretKey = /^LANGFUSE_INIT_PROJECT_SECRET_KEY=(.+)$/m.exec(this.env ?? '')?.[1]
    return publicKey !== undefined && secretKey !== undefined ? [publicKey, secretKey] : undefined
  }

  private probeCodes(): Record<string, number> {
    const code = this.served === 'open' ? 401 : this.served === 'held' ? 503 : 404
    return Object.fromEntries(SENDER_GROUPS.map(group => [group, code]))
  }

  private up(step: string, command: string): RunResult {
    const match = /--wait-timeout 600 (?:--force-recreate --no-deps )?([^\n]+)\n/.exec(command)
    const services = (match?.[1] ?? '').trim().split(' ')
    for (const service of services) {
      if (!(SERVICES as readonly string[]).includes(service)) return fail(`unknown service ${service}`)
    }
    const image = /^TRACES_COLLECTOR_IMAGE=(.+)$/m.exec(this.env ?? '')?.[1]
    if (services.includes('collector') || step === 'up-public') this.runningImage = image
    if (services.includes('langfuse-web')) {
      // Langfuse's init creates the bootstrap key from the variables it boots with.
      const pair = this.envBootstrapPair()
      this.runningHasBootstrap = pair !== undefined
      if (pair !== undefined) this.bootstrapKeyLive = true
    }
    if (services.includes('health-reporter')) this.reporterAt = this.clock + (this.options.verdictOffset ?? 10)
    if (services.includes('caddy') && this.envState !== undefined) this.served = this.envState
    // Compose converges what it is asked to start: every named service runs what the files now say.
    for (const service of services) this.running.set(service, {running: true, hash: this.expectedHash(service)})
    return ok(`epoch=${this.clock}\nTRACES_STEP_OK:${step}\n`)
  }

  reporterDetail(): Record<string, unknown> {
    const required = [
      'collector-health',
      'collector-queues',
      'collector-failures',
      'collector-refused',
      'tempo-ready',
      'tempo-discards',
      'tempo-truncation',
      'langfuse-web',
      'langfuse-worker',
      'volume-space',
      'root-space',
      'data-age-clickhouse',
      'data-age-object-store',
      'data-age-tempo',
    ]
    const passes = (check: {status: string}): boolean => check.status === 'pass' || check.status === 'warn'
    const checks = this.checksFor(required).map(check => ({...check, scope: 'ingest'}))
    const monitoring = this.checksFor(['grafana-health', 'prometheus-health', 'embedder-health']).map(check => ({
      ...check,
      scope: 'monitoring',
    }))
    const allPass = checks.every(passes)
    return {
      schemaVersion: 1,
      generatedAt: new Date((this.clock + 60) * 1000).toISOString(),
      intervalMs: 300_000,
      ran: this.options.verdict?.ran ?? true,
      stale: this.options.verdict?.stale ?? false,
      ok: this.options.verdict?.ok ?? allPass,
      monitoringOk: monitoring.every(passes),
      at: new Date(this.reporterAt * 1000).toISOString(),
      checks: [...checks, ...monitoring],
    }
  }

  /** What the one-shot canary prints: the three canary checks, mutated by `checkStatus` like the verdict's. */
  canaryChecks(): Record<string, unknown>[] {
    return this.checksFor(['canary-send', 'canary-langfuse', 'canary-tempo'])
  }

  private checksFor(ids: readonly string[]): {id: string; status: string; detail: string}[] {
    return ids.map(id => ({
      id,
      status: this.options.checkStatus?.[id] ?? 'pass',
      detail: this.options.checkStatus?.[id] === undefined ? 'fine' : `${id} was made to fail`,
    }))
  }

  private retention(step: string, command: string, stdin: string): RunResult {
    const normalised = (column: string): string => `toDateTime(${column}) + toIntervalDay(30)`
    if (step === 'retention-read-ttl') {
      const rows = [...this.tables.entries()].map(([name, ttl]) =>
        JSON.stringify({
          name,
          create_table_query: `CREATE TABLE default.${name}\n(\n  \`x\` String\n)\nENGINE = ReplacingMergeTree\n${ttl === undefined ? '' : `TTL ${ttl}\n`}SETTINGS a = 1`,
        }),
      )
      return ok(`${rows.join('\n')}\nTRACES_TTL_READ\n`)
    }
    if (step === 'retention-apply-ttl') {
      if (!this.options.alterIgnored) {
        for (const match of stdin.matchAll(/ALTER TABLE default\.(\w+) MODIFY TTL toDateTime\((\w+)\)/g)) {
          if (match[1] !== undefined && match[2] !== undefined) this.tables.set(match[1], normalised(match[2]))
        }
      }
      return ok('TRACES_TTL_APPLIED\n')
    }
    if (step === 'retention-read-lifecycle') {
      if (this.rules.length === 0) return ok('TRACES_ILM_NONE\n')
      const document = {
        Rules: this.rules.map((rule, index) => ({
          ID: `r${index}`,
          Status: 'Enabled',
          Expiration: {Days: rule.Days},
          Filter: {Prefix: rule.Prefix},
        })),
      }
      return ok(`${JSON.stringify(document)}\nTRACES_ILM_READ\n`)
    }
    if (step === 'retention-add-lifecycle') {
      const prefix = OBJECT_STORE_PREFIXES.find(candidate => command.includes(candidate))
      if (prefix !== undefined) this.rules.push({Prefix: prefix, Days: 30})
      return ok('TRACES_ILM_ADDED\n')
    }
    return fail(`unexpected retention step ${step}`)
  }
}

// ─── A real `flock` for tests that run a script in bash ───────────────────────

/**
 * The host has util-linux `flock`. macOS has none. Where it is missing, a stand-in over the system `perl` takes the
 * same `flock -w SECONDS FD` call and takes a real, kernel-level `flock(2)` on the descriptor, so two shells holding
 * the same file really do exclude each other. (The technique of `packages/cli/src/commands/traces/sender.test.ts`.)
 */
export const HAS_REAL_FLOCK = Bun.which('flock') !== null
export const CAN_LOCK = HAS_REAL_FLOCK || Bun.which('perl') !== null

const FLOCK_STAND_IN = [
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

/** Put a `flock` in `directory` when the machine has none. Returns whether scripts that lock can run here. */
export function installFlockStandIn(directory: string): boolean {
  if (HAS_REAL_FLOCK) return true
  if (!CAN_LOCK) return false
  const path = join(directory, 'flock')
  writeFileSync(path, FLOCK_STAND_IN)
  chmodSync(path, 0o755)
  return true
}

export function stepOf(command: string): string {
  if (command.includes('TRACES_INGEST_STATE_SET=')) return 'raw:set-state'
  if (command === REPORTER_DETAIL_COMMAND) return 'raw:reporter-detail'
  const marker = /# traces-step:([^\n]+)\n/.exec(command)?.[1]
  return marker ?? 'unknown'
}

// ─── Inputs and deps for tests ────────────────────────────────────────────────

export const PLACEHOLDER_DIGEST = `sha256:${'a'.repeat(64)}`
export const OTHER_DIGEST = `sha256:${'b'.repeat(64)}`

export function baseEnv(overrides: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    TRACES_SSH_KEY: 'PLACEHOLDER-SSH-PRIVATE-KEY-BODY',
    TRACES_HOST: 'deploy-host.invalid',
    TRACES_DOMAIN: 'traces.fro.bot',
    TRACES_INGEST_OPEN: 'true',
    TRACES_COLLECTOR_IMAGE: `ghcr.io/example/repo/traces-collector@${PLACEHOLDER_DIGEST}`,
    TRACES_POSTGRES_PASSWORD: 'placeholder-postgres-password-0001',
    TRACES_CLICKHOUSE_PASSWORD: 'placeholder-clickhouse-password-0002',
    TRACES_CLICKHOUSE_READER_PASSWORD: 'placeholder-reader-password-000003',
    TRACES_REDIS_PASSWORD: 'placeholder-redis-password-000004',
    TRACES_MINIO_PASSWORD: 'placeholder-minio-password-000005',
    TRACES_NEXTAUTH_SECRET: 'placeholder-nextauth-secret-0000000006',
    TRACES_SALT: 'placeholder-salt-0007',
    TRACES_ENCRYPTION_KEY: '0123456789abcdef'.repeat(4),
    TRACES_GRAFANA_ADMIN_PASSWORD: 'placeholder-grafana-admin-08',
    TRACES_GRAFANA_SECRET_KEY: 'placeholder-grafana-secret-09',
    TRACES_DISCORD_WEBHOOK_URL:
      'https://discord.com/api/webhooks/123456789012345678/placeholder-webhook-token-0123456789abcdef',
    TRACES_LANGFUSE_USER_EMAIL: 'operator@example.invalid',
    TRACES_LANGFUSE_USER_PASSWORD: 'placeholder-ui-password-10',
    TRACES_LANGFUSE_PUBLIC_KEY: 'pk-lf-placeholder-app-public-11',
    TRACES_LANGFUSE_SECRET_KEY: 'sk-lf-placeholder-app-secret-12',
    TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY: undefined,
    TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY: undefined,
  }
  return {...env, ...overrides}
}

/** Every secret-valued input in an environment, for "no secret in argv or logs" checks. */
export function secretValues(env: Record<string, string | undefined>): string[] {
  const secretNames = [
    'TRACES_SSH_KEY',
    'TRACES_POSTGRES_PASSWORD',
    'TRACES_CLICKHOUSE_PASSWORD',
    'TRACES_CLICKHOUSE_READER_PASSWORD',
    'TRACES_REDIS_PASSWORD',
    'TRACES_MINIO_PASSWORD',
    'TRACES_NEXTAUTH_SECRET',
    'TRACES_SALT',
    'TRACES_ENCRYPTION_KEY',
    'TRACES_GRAFANA_ADMIN_PASSWORD',
    'TRACES_GRAFANA_SECRET_KEY',
    'TRACES_DISCORD_WEBHOOK_URL',
    'TRACES_LANGFUSE_USER_PASSWORD',
    'TRACES_LANGFUSE_PUBLIC_KEY',
    'TRACES_LANGFUSE_SECRET_KEY',
    'TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY',
    'TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY',
  ]
  return secretNames.map(name => env[name]).filter((value): value is string => value !== undefined && value !== '')
}

export interface TestDeps {
  deps: Partial<DeployDeps>
  logs: string[]
  identityPaths: string[]
  cleaned: string[]
  /** Every void token line the deploy generated, for "never in argv or logs" checks. */
  voidLines: string[]
}

export function testDeps(host: FakeHost, overrides: Partial<DeployDeps> = {}): TestDeps {
  const logs: string[] = []
  const identityPaths: string[] = []
  const cleaned: string[] = []
  const voidLines: string[] = []
  const deps: Partial<DeployDeps> = {
    run: host.run,
    resolve: async () => ['198.51.100.7'],
    readFile: async relative => `# ${relative}\n`,
    materializeIdentity: () => {
      identityPaths.push('/scratch/id')
      return {path: '/scratch/id', cleanup: () => cleaned.push('identity')}
    },
    voidTokenLine: () => {
      const line = generateVoidTokenLine()
      voidLines.push(line)
      return line
    },
    makeTempDir: () => ({path: '/scratch/deploy', cleanup: () => cleaned.push('temp')}),
    knownHostsFile: undefined,
    sleep: async () => {},
    log: message => logs.push(message),
    limits: {
      proofAttempts: 2,
      proofIntervalMs: 0,
      retentionAttempts: 2,
      retentionIntervalMs: 0,
      verdictAttempts: 2,
      verdictIntervalMs: 0,
      grafanaAttempts: 3,
      grafanaIntervalMs: 0,
    },
    ...overrides,
  }
  return {deps, logs, identityPaths, cleaned, voidLines}
}

export function requiredTableNames(): string[] {
  return RETENTION_TABLES.filter(table => table.required).map(table => table.name)
}

export type {DeployInputs}
