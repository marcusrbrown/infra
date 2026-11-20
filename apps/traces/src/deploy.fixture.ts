// A simulated traces host behind a recording `Runner`, for the deploy tests. Nothing here spawns a process or
// reaches a network. The simulation answers the deploy's remote steps by their `# traces-step:` marker and keeps
// just enough state (files, the ingest state, what Caddy serves, ClickHouse tables, the object store, the
// reporter's verdict, the bootstrap key) for a second deploy to see what the first one left.

import type {Runner, RunResult} from '../server/provision'
import type {DeployDeps, DeployInputs, IngestState} from './deploy'

import {REPORTER_DETAIL_COMMAND, SERVICES} from './deploy'
import {SENDER_GROUPS} from './host'
import {OBJECT_STORE_PREFIXES, RETENTION_TABLES} from './retention'

export const EPOCH = 1_700_000_000

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
  /** Mutations of the reporter's verdict. */
  checkStatus?: Record<string, 'pass' | 'warn' | 'fail' | 'unknown'>
  /** Seconds the reporter's verdict is dated after the restart (negative: older than the restart). */
  verdictOffset?: number
  /** The reporter's `ok` flag, `ran` and `stale`. */
  verdict?: {ok?: boolean; ran?: boolean; stale?: boolean}
  /** The reporter cannot be read at all. */
  reporterUnreadable?: boolean
  /** Probe answers per route state, instead of the simulation's. */
  probeOverride?: (served: IngestState | 'none') => Record<string, number> | undefined
  /** ClickHouse tables that exist at the start (name -> ttl text as ClickHouse echoes it). */
  tables?: Record<string, string | undefined>
  /** ALTER answers success but changes nothing. */
  alterIgnored?: boolean
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
  /** Token files, by group. `undefined` is absent. */
  tokens = new Map<string, string | undefined>()
  pendingRestarts: string[] = []
  bootstrapPending: string | undefined
  /** Langfuse holds a live full-access bootstrap key. */
  bootstrapKeyLive = false
  /** The running Langfuse container carries bootstrap key variables. */
  runningHasBootstrap = false
  /** The image the running collector was started from. */
  runningImage: string | undefined
  reporterAt = EPOCH - 100
  tables: Map<string, string | undefined>
  rules: {Prefix: string; Days: number}[] = []
  clock = EPOCH

  constructor(readonly options: FakeOptions = {}) {
    this.tables = new Map(Object.entries(options.tables ?? {events_full: undefined, events_core: undefined}))
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
    const overridden = this.options.override?.(call.step, call)
    if (overridden !== undefined) return overridden
    return this.handle(call)
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
      this.envState = state
      if (!this.options.stateIgnored) this.served = state
      call.step = `raw:set-state:${state}`
      return ok(`TRACES_INGEST_STATE_SET=${state}\n`)
    }
    if (step === 'raw:reporter-detail') {
      if (this.options.reporterUnreadable) return fail('exec failed')
      return ok(`${JSON.stringify(this.reporterDetail())}\nTRACES_DETAIL_END\n`)
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
        return ok(
          [
            `has_env=${this.env === undefined ? 0 : 1}`,
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
      }
      case step === 'prepare-dirs': {
        return ok('TRACES_DIRS_READY\n')
      }
      case step.startsWith('token-file:'): {
        const group = step.slice('token-file:'.length)
        if (this.tokens.get(group) === undefined) {
          this.tokens.set(group, '')
          return ok('TRACES_TOKEN_CREATED\n')
        }
        return ok('TRACES_TOKEN_PRESENT\n')
      }
      case step === 'token-dirs': {
        const lines = SENDER_GROUPS.map(
          group => `token_file=${group}:${this.tokens.get(group) === undefined ? 'absent' : 'present'}`,
        )
        return ok(`${lines.join('\n')}\nTRACES_TOKEN_DIRS_CHECKED\n`)
      }
      case step.startsWith('compare:'): {
        const path = step.slice('compare:'.length)
        const current = path === '.env' ? this.env : this.files.get(path)
        if (current === undefined) return ok('TRACES_FILE_ABSENT\n')
        return ok(current === stdin ? 'TRACES_FILE_SAME\n' : 'TRACES_FILE_DIFFERENT\n')
      }
      case step.startsWith('write:'): {
        const path = step.slice('write:'.length)
        if (path === '.env') {
          this.env = stdin
          this.envState = /TRACES_INGEST_STATE=%s.*? (off|held|open) >>/.exec(command)?.[1] as IngestState
        } else if (path === '.pending-restarts') {
          this.pendingRestarts = stdin.split('\n').filter(line => line !== '')
        } else if (path === 'secrets/bootstrap-pending') {
          this.bootstrapPending = stdin
        } else {
          this.files.set(path, stdin)
        }
        return ok('TRACES_FILE_WRITTEN\n')
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
      case step === 'create-collector': {
        return ok(`epoch=${this.clock}\nTRACES_STEP_OK:${step}\n`)
      }
      case step === 'queue-volume': {
        return ok('TRACES_QUEUE_VOLUME_READY\n')
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
      'canary-send',
      'canary-langfuse',
      'canary-tempo',
    ]
    const checks = required.map(id => ({
      id,
      status: this.options.checkStatus?.[id] ?? 'pass',
      detail: this.options.checkStatus?.[id] === undefined ? 'fine' : `${id} was made to fail`,
    }))
    const allPass = checks.every(check => check.status === 'pass' || check.status === 'warn')
    return {
      schemaVersion: 1,
      generatedAt: new Date((this.clock + 60) * 1000).toISOString(),
      intervalMs: 300_000,
      ran: this.options.verdict?.ran ?? true,
      stale: this.options.verdict?.stale ?? false,
      ok: this.options.verdict?.ok ?? allPass,
      at: new Date(this.reporterAt * 1000).toISOString(),
      checks,
    }
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
}

export function testDeps(host: FakeHost, overrides: Partial<DeployDeps> = {}): TestDeps {
  const logs: string[] = []
  const identityPaths: string[] = []
  const cleaned: string[] = []
  const deps: Partial<DeployDeps> = {
    run: host.run,
    resolve: async () => ['198.51.100.7'],
    readFile: async relative => `# ${relative}\n`,
    materializeIdentity: () => {
      identityPaths.push('/scratch/id')
      return {path: '/scratch/id', cleanup: () => cleaned.push('identity')}
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
    },
    ...overrides,
  }
  return {deps, logs, identityPaths, cleaned}
}

export function requiredTableNames(): string[] {
  return RETENTION_TABLES.filter(table => table.required).map(table => table.name)
}

export type {DeployInputs}
