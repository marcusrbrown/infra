#!/usr/bin/env bun

// ─── Traces deploy ────────────────────────────────────────────────────────────
//
// Brings the trace stack up privately, proves each gate, and only then opens the public ingest route.
//
// Order (the plan's Unit 4):
//   1. validate every input, before any SSH
//   2. DNS preflight
//   3. verify the volume mount, sentinel and storage paths (`checkTracesStorage`); stop if it fails
//   4. read the host's state (ingest state, bootstrap key on record, restarts left over from a failed deploy)
//   5. compare every file with the host. If ingest is open and a gated service (the collector, a backend or
//      their configuration) is about to change, hold the route (503), and prove it from inside the host
//   6. write directories, deny-all token files (only if absent), secret files, configs and the reporter source
//   7. prune images, check free space, pull the ingest services (never Grafana or Prometheus)
//   8. start the stores and Langfuse, assert and read back retention, start Tempo, the collector and the reporter,
//      verify the collector's image digest
//   9. run the gates, then set the route: open only when every gate passes AND TRACES_INGEST_OPEN is exactly
//      `true`; otherwise off (first bring-up) or held (it was open before). The canary gate sends the deploy's one
//      canary (the reporter's `--canary-once` mode, by exec) once the reporter's verdict is fresh
//  10. pull and start the monitoring services, Prometheus and then Grafana, then remove the deploy marker, which ends
//      the route's work. They are monitoring, not the route: they are pulled and started only after the route is decided,
//      each as an operator gate (`prometheus-ready`, `grafana-ready`), so a failed pull or start fails the run and never
//      holds or closes ingest. Both are recreated on every deploy, so a changed file of theirs is applied here. Only
//      then check Grafana's sign-in (the password file works) and its provisioned alerting (the Discord contact point
//      and the rule groups exist), unless Grafana did not start: read-only, after the route is final, and a failure
//      fails the run (`OperatorSurfaceError`) without touching the route
//
// Overlapping deploys: the last deploy to start owns the host. Each deploy writes a random id into the deploy marker
// in its first host script; every later script that changes the host checks, in the same script, that the marker
// still holds that id (`ownershipPrelude`) and otherwise prints `DEPLOY_OVERTAKEN` and changes nothing. An overtaken
// deploy stops at its next step and never opens the route or removes the marker. Every such step also holds the step
// lock from before its check until its shell ends, and the takeover takes the same lock before it writes the marker:
// a newer deploy cannot take the host while an older deploy's step is in flight, so from the moment it owns the host
// no other deploy's step is running or can start.
//
// Everything a host does goes through one injected `Runner`, so tests assert on every argv and every stdin
// byte and nothing here reaches a network in a test.
//
// Rules this file keeps:
//   - a secret travels over SSH stdin only; the ssh argv and the ssh child's environment carry none
//   - the inputs are exactly `TRACES_DEPLOY_SECRETS`, `TRACES_DEPLOY_VARS` and `TRACES_DEPLOY_BUILD_INPUTS`;
//     no sender token, snapshot token or cloud API token is ever read
//   - a remote probe prints a sentinel and needs exit 0 plus a recognised sentinel; an unrecognised answer
//     fails closed. No remote command redirects to the null device or deletes outside the app directory and /tmp
//   - a token file is created with one void line when absent and is otherwise never written, replaced, truncated or removed
//   - the ingest state is written and Caddy recreated with the same on-host mechanism as `traces ingest`
//     (`packages/cli/src/commands/traces/remote.ts`); a test pins the two strings together

import type {MaterializedIdentity} from '@marcusrbrown/infra-shared/server/droplet-helpers'
import type {RemoteExec, Runner, RunResult} from '../server/provision'
import type {SenderGroup} from './host'
import type {RetentionReport} from './retention'

import {Buffer} from 'node:buffer'
import {randomBytes} from 'node:crypto'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {materializeIdentityFile} from '@marcusrbrown/infra-shared/server/droplet-helpers'

import {bashCommand, checkTracesStorage, shellQuote} from '../server/provision'
import {
  GRAFANA_USER_ID,
  PROMETHEUS_USER_ID,
  SENDER_GROUPS,
  TEMPO_USER_ID,
  TRACES_APP_DIR,
  TRACES_DEPLOY_MARKER,
  TRACES_DEPLOY_STEP_LOCK,
  TRACES_DOCKER_ROOT,
  TRACES_INGEST_LOCK,
  TRACES_LOCK_BUSY_SENTINEL,
  TRACES_PENDING_RESTARTS,
  TRACES_SENTINEL_CONTENT,
  TRACES_SENTINEL_PATH,
  TRACES_VOID_TOKEN_PREFIX,
  TRACES_VOLUME_MOUNT,
  validateTracesHost,
} from './host'
import {assertRetention} from './retention'

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** Environment secrets the deploy reads. The workflow passes exactly these; a conventions test compares them. */
export const TRACES_DEPLOY_SECRETS = [
  'TRACES_SSH_KEY',
  'TRACES_HOST',
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
  'TRACES_LANGFUSE_USER_EMAIL',
  'TRACES_LANGFUSE_USER_PASSWORD',
  'TRACES_LANGFUSE_PUBLIC_KEY',
  'TRACES_LANGFUSE_SECRET_KEY',
  'TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY',
  'TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY',
] as const

/** Environment variables (not secret). */
export const TRACES_DEPLOY_VARS = ['TRACES_DOMAIN', 'TRACES_INGEST_OPEN'] as const

/** Passed by the workflow from its build job; not stored anywhere. */
export const TRACES_DEPLOY_BUILD_INPUTS = ['TRACES_COLLECTOR_IMAGE'] as const

export type DeployInputName =
  | (typeof TRACES_DEPLOY_SECRETS)[number]
  | (typeof TRACES_DEPLOY_VARS)[number]
  | (typeof TRACES_DEPLOY_BUILD_INPUTS)[number]

/** Ambient names the SSH child needs. They are not inputs and carry no secret. */
const AMBIENT_ENV = ['PATH', 'HOME', 'SSH_AUTH_SOCK'] as const

export type EnvLike = Readonly<Record<string, string | undefined>>

export interface KeyPair {
  publicKey: string
  secretKey: string
}

export interface DeployInputs {
  host: string
  domain: string
  collectorImage: string
  /** The private key for CI. Unset in local mode, where `SSH_AUTH_SOCK` carries the identity. */
  sshKey: string | undefined
  postgresPassword: string
  clickhousePassword: string
  clickhouseReaderPassword: string
  redisPassword: string
  minioPassword: string
  nextauthSecret: string
  salt: string
  encryptionKey: string
  grafanaAdminPassword: string
  grafanaSecretKey: string
  /** Where Grafana's alert rules post. Reaches Grafana only, as an environment variable from the host `.env`. */
  discordWebhookUrl: string
  langfuseUserEmail: string
  langfuseUserPassword: string
  /** The Application-role key the collector sends with. Unset on the first deploy. */
  langfuseKey: KeyPair | undefined
  /** The full-access key Langfuse creates on its first boot. Supplied for that one deploy. */
  bootstrapKey: KeyPair | undefined
  /** True only for the exact value `true`. */
  ingestOpen: boolean
  /** Set when TRACES_INGEST_OPEN holds something other than `true`, `false` or nothing. */
  ingestOpenWarning: string | undefined
}

const URL_SAFE = /^[\w.~-]+$/
const HEX_64 = /^[\da-f]{64}$/
const KEY_VALUE = /^[\w-]{8,128}$/
const EMAIL = /^[^\s@,'"$`\\#:;]{1,64}@[a-z\d.-]{1,190}\.[a-z]{2,24}$/i
const DOMAIN = /^(?=.{4,253}$)[a-z\d](?:[a-z\d-]*[a-z\d])?(?:\.[a-z\d](?:[a-z\d-]*[a-z\d])?)+$/
/** A published GHCR image, pinned by digest. The tag, when present, is informational. */
const DISCORD_WEBHOOK = /^https:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/api\/webhooks\/\d{17,20}\/[\w-]{20,100}$/
const COLLECTOR_IMAGE = /^ghcr\.io\/[\da-z][\w./-]*(?::[\w.-]+)?@sha256:[\da-f]{64}$/

function read(env: EnvLike, name: DeployInputName): string {
  return env[name]?.trim() ?? ''
}

function requireValue(env: EnvLike, name: DeployInputName): string {
  const value = read(env, name)
  if (value === '') throw new Error(`${name} is required for deploy`)
  return value
}

/** A secret that goes into a URL, a file or `.env`: URL-safe characters only, with a floor on its length. */
function requireUrlSafe(env: EnvLike, name: DeployInputName, min: number, max = 128): string {
  const value = requireValue(env, name)
  // The value is never echoed: a malformed secret may be the wrong secret.
  if (!URL_SAFE.test(value)) {
    throw new Error(`${name} must use only letters, digits and the characters . _ ~ - (it goes inside connection URLs)`)
  }
  if (value.length < min || value.length > max) {
    throw new Error(`${name} must be ${min} to ${max} characters long`)
  }
  return value
}

/**
 * The shortest Grafana admin password the deploy accepts. Grafana's built-in password is `admin`; the sign-in check
 * sends no request with it (a failed login counts against the admin account), so it proves "not the default" by
 * this floor instead: a password of this length can never be `admin`, and one 200 with the file's value proves
 * that is what the account holds.
 */
export const GRAFANA_ADMIN_PASSWORD_MIN = 16

function optionalPair(env: EnvLike, publicName: DeployInputName, secretName: DeployInputName): KeyPair | undefined {
  const publicKey = read(env, publicName)
  const secretKey = read(env, secretName)
  if (publicKey === '' && secretKey === '') return undefined
  if (publicKey === '' || secretKey === '') {
    throw new Error(`${publicName} and ${secretName} must be set together or both left unset`)
  }
  for (const [name, value] of [
    [publicName, publicKey],
    [secretName, secretKey],
  ] as const) {
    if (!KEY_VALUE.test(value)) throw new Error(`${name} must be 8 to 128 letters, digits, _ or -`)
  }
  return {publicKey, secretKey}
}

/**
 * Read and validate every input. Throws, naming the input and never its value, before any SSH argv exists.
 * Reads only the names in the exported lists (and nothing from the environment but those).
 */
export function readInputs(env: EnvLike): DeployInputs {
  let host: string
  try {
    host = validateTracesHost(read(env, 'TRACES_HOST'))
  } catch {
    // TRACES_HOST is a secret: the message names it and never repeats it.
    throw new Error('TRACES_HOST is required and must be a hostname or address (letters, digits, dots, hyphens)')
  }

  const domain = read(env, 'TRACES_DOMAIN')
  if (!DOMAIN.test(domain)) throw new Error('TRACES_DOMAIN must be a lower-case DNS name such as traces.fro.bot')

  const collectorImage = read(env, 'TRACES_COLLECTOR_IMAGE')
  if (!COLLECTOR_IMAGE.test(collectorImage)) {
    throw new Error(
      'TRACES_COLLECTOR_IMAGE must be a ghcr.io image pinned by digest (name@sha256:<64 hex>); it comes from the workflow build job',
    )
  }

  // Never echoed: the address is the credential.
  const discordWebhookUrl = requireValue(env, 'TRACES_DISCORD_WEBHOOK_URL')
  if (!DISCORD_WEBHOOK.test(discordWebhookUrl)) {
    throw new Error(
      'TRACES_DISCORD_WEBHOOK_URL must be a Discord webhook address: https://discord.com/api/webhooks/<id>/<token>',
    )
  }

  const encryptionKey = requireValue(env, 'TRACES_ENCRYPTION_KEY')
  if (!HEX_64.test(encryptionKey)) throw new Error('TRACES_ENCRYPTION_KEY must be 64 lower-case hex characters')

  const email = requireValue(env, 'TRACES_LANGFUSE_USER_EMAIL')
  if (!EMAIL.test(email)) throw new Error('TRACES_LANGFUSE_USER_EMAIL must be a plain email address')

  const sshKey = read(env, 'TRACES_SSH_KEY')
  if (sshKey === '' && (env.SSH_AUTH_SOCK ?? '') === '') {
    throw new Error('SSH context is required: set TRACES_SSH_KEY (CI) or run with SSH_AUTH_SOCK set (local)')
  }

  const rawOpen = read(env, 'TRACES_INGEST_OPEN')

  return {
    host,
    domain,
    collectorImage,
    sshKey: sshKey === '' ? undefined : sshKey,
    postgresPassword: requireUrlSafe(env, 'TRACES_POSTGRES_PASSWORD', 24),
    clickhousePassword: requireUrlSafe(env, 'TRACES_CLICKHOUSE_PASSWORD', 24),
    clickhouseReaderPassword: requireUrlSafe(env, 'TRACES_CLICKHOUSE_READER_PASSWORD', 24),
    redisPassword: requireUrlSafe(env, 'TRACES_REDIS_PASSWORD', 24),
    minioPassword: requireUrlSafe(env, 'TRACES_MINIO_PASSWORD', 24),
    nextauthSecret: requireUrlSafe(env, 'TRACES_NEXTAUTH_SECRET', 32),
    salt: requireUrlSafe(env, 'TRACES_SALT', 16),
    encryptionKey,
    grafanaAdminPassword: requireUrlSafe(env, 'TRACES_GRAFANA_ADMIN_PASSWORD', GRAFANA_ADMIN_PASSWORD_MIN),
    grafanaSecretKey: requireUrlSafe(env, 'TRACES_GRAFANA_SECRET_KEY', 16),
    discordWebhookUrl,
    langfuseUserEmail: email,
    langfuseUserPassword: requireUrlSafe(env, 'TRACES_LANGFUSE_USER_PASSWORD', 12),
    langfuseKey: optionalPair(env, 'TRACES_LANGFUSE_PUBLIC_KEY', 'TRACES_LANGFUSE_SECRET_KEY'),
    bootstrapKey: optionalPair(env, 'TRACES_LANGFUSE_BOOTSTRAP_PUBLIC_KEY', 'TRACES_LANGFUSE_BOOTSTRAP_SECRET_KEY'),
    ingestOpen: rawOpen === 'true',
    ingestOpenWarning:
      rawOpen === '' || rawOpen === 'true' || rawOpen === 'false'
        ? undefined
        : 'TRACES_INGEST_OPEN is set to something other than `true`; only the exact value `true` opens ingest, so it stays closed',
  }
}

// ─── What lands on the host ───────────────────────────────────────────────────

export const SERVICES = [
  'caddy',
  'collector',
  'langfuse-web',
  'langfuse-worker',
  'clickhouse',
  'minio',
  'redis',
  'postgres',
  'tempo',
  'grafana',
  'prometheus',
  'health-reporter',
] as const

export type Service = (typeof SERVICES)[number]

/**
 * The services that only raise the alarm: Grafana (it owns the alert rules) and Prometheus (it holds the metrics they
 * read). No trace passes through either, nothing in the compose file depends on either, and neither is gated. They are
 * pulled and started after the route is decided, as operator gates, so a failure of either never holds or closes ingest.
 */
export const MONITORING_SERVICES = ['grafana', 'prometheus'] as const satisfies readonly Service[]

/** Every other service: the ones the route depends on. The route-critical pull and start cover these and no others. */
export const INGEST_SERVICES: readonly Service[] = SERVICES.filter(
  service => !(MONITORING_SERVICES as readonly string[]).includes(service),
)

/**
 * The services whose change puts data or the public route at risk: the collector, the backends and their
 * configuration, and Caddy (its configuration is the route). Grafana, Prometheus and the health reporter are not
 * gated: none of them is on the path of a trace, and none holds trace content.
 * On an open route a change to any of these holds the route first and reopens it only after the gates pass.
 */
export const GATED_SERVICES: readonly Service[] = [
  'caddy',
  'collector',
  'langfuse-web',
  'langfuse-worker',
  'clickhouse',
  'minio',
  'redis',
  'postgres',
  'tempo',
]

/** What a changed file restarts. `compose` means the compose file or `.env`: compose recreates what it changes. */
export type Touch = Service | 'compose'

export type IngestState = 'off' | 'held' | 'open'

// Container users. The collector image's built-in `nonroot` user, the Grafana image's user, and the reporter's
// user, which is Tempo's (the reporter lists Tempo's 0700 directories; see `TEMPO_USER_ID` in `host.ts`).
const COLLECTOR_GID = '65532'
const GRAFANA_UID = String(GRAFANA_USER_ID)
const REPORTER_UID = String(TEMPO_USER_ID)
const PROMETHEUS_UID = String(PROMETHEUS_USER_ID)

const COMPOSE_PROJECT_VOLUME = 'traces_collector_queue'
const PROMETHEUS_PROJECT_VOLUME = 'traces_prometheus_data'

/** Fixed Langfuse bootstrap identifiers: one organisation, one project, one user. */
const INIT = {
  orgId: 'traces',
  orgName: 'Traces',
  projectId: 'traces',
  projectName: 'traces',
  userName: 'Operator',
} as const

/**
 * The `.env` the compose file reads, without the ingest-state line (the deploy appends that, so it can be
 * compared with the host's file and so the state is never decided by the content).
 *
 * The Langfuse key variables are written only when the bootstrap pair is supplied. Langfuse's init creates an
 * API key from them when no key with that public key exists (`web/src/initialize.ts` at v4.83.0), so a deleted
 * key comes back on the next boot while they are present. Absent, nothing is created.
 */
export function buildEnvFile(inputs: DeployInputs): string {
  const lines = [
    `POSTGRES_PASSWORD=${inputs.postgresPassword}`,
    `CLICKHOUSE_PASSWORD=${inputs.clickhousePassword}`,
    `CLICKHOUSE_READER_PASSWORD=${inputs.clickhouseReaderPassword}`,
    `MINIO_ROOT_PASSWORD=${inputs.minioPassword}`,
    `REDIS_AUTH=${inputs.redisPassword}`,
    `SALT=${inputs.salt}`,
    `ENCRYPTION_KEY=${inputs.encryptionKey}`,
    `NEXTAUTH_SECRET=${inputs.nextauthSecret}`,
    `TRACES_DISCORD_WEBHOOK_URL=${inputs.discordWebhookUrl}`,
    `TRACES_DOMAIN=${inputs.domain}`,
    `TRACES_COLLECTOR_IMAGE=${inputs.collectorImage}`,
    `LANGFUSE_INIT_ORG_ID=${INIT.orgId}`,
    `LANGFUSE_INIT_ORG_NAME=${INIT.orgName}`,
    `LANGFUSE_INIT_PROJECT_ID=${INIT.projectId}`,
    `LANGFUSE_INIT_PROJECT_NAME=${INIT.projectName}`,
    `LANGFUSE_INIT_USER_EMAIL=${inputs.langfuseUserEmail}`,
    `LANGFUSE_INIT_USER_NAME=${INIT.userName}`,
    `LANGFUSE_INIT_USER_PASSWORD=${inputs.langfuseUserPassword}`,
  ]
  if (inputs.bootstrapKey !== undefined) {
    lines.push(
      `LANGFUSE_INIT_PROJECT_PUBLIC_KEY=${inputs.bootstrapKey.publicKey}`,
      `LANGFUSE_INIT_PROJECT_SECRET_KEY=${inputs.bootstrapKey.secretKey}`,
    )
  }
  return `${lines.join('\n')}\n`
}

/**
 * The Basic credential the collector sends to Langfuse, as the file the collector reads at start. With no key
 * pair yet the file still has to exist (the collector will not start without it); it then holds a credential
 * Langfuse refuses, so the collector can start while ingest is off.
 */
export function langfuseBasicValue(key: KeyPair | undefined): string {
  const pair = key === undefined ? 'pk-lf-unset:sk-lf-unset' : `${key.publicKey}:${key.secretKey}`
  return Buffer.from(pair, 'utf8').toString('base64')
}

export interface RemoteFile {
  /** Path relative to the app directory. */
  path: string
  content: string
  /** `user:group`, numeric where the container user has no name on the host. */
  owner: string
  mode: string
  touches: readonly Touch[]
  /** `.env` is compared and written without its ingest-state line. */
  kind: 'plain' | 'env'
}

/** Every file under `apps/traces` the deploy uploads, and what a change to it restarts. */
export const UPLOADED_FILES: readonly {local: string; remote: string; touches: readonly Touch[]}[] = [
  {local: 'docker-compose.yaml', remote: 'docker-compose.yaml', touches: ['compose']},
  {local: 'config/Caddyfile', remote: 'config/Caddyfile', touches: ['caddy']},
  {local: 'config/ingest/off.caddy', remote: 'config/ingest/off.caddy', touches: ['caddy']},
  {local: 'config/ingest/held.caddy', remote: 'config/ingest/held.caddy', touches: ['caddy']},
  {local: 'config/ingest/open.caddy', remote: 'config/ingest/open.caddy', touches: ['caddy']},
  {local: 'config/otelcol.yaml', remote: 'config/otelcol.yaml', touches: ['collector']},
  {local: 'config/tempo.yaml', remote: 'config/tempo.yaml', touches: ['tempo']},
  {
    local: 'config/clickhouse/system-log-ttl.xml',
    remote: 'config/clickhouse/system-log-ttl.xml',
    touches: ['clickhouse'],
  },
  {
    local: 'config/clickhouse-users/traces-reader.xml',
    remote: 'config/clickhouse-users/traces-reader.xml',
    touches: ['clickhouse'],
  },
  {
    local: 'config/grafana/datasources/tempo.yaml',
    remote: 'config/grafana/datasources/tempo.yaml',
    touches: ['grafana'],
  },
  {
    local: 'config/grafana/datasources/prometheus.yaml',
    remote: 'config/grafana/datasources/prometheus.yaml',
    touches: ['grafana'],
  },
  {
    local: 'config/grafana/alerting/contact-points.yaml',
    remote: 'config/grafana/alerting/contact-points.yaml',
    touches: ['grafana'],
  },
  {
    local: 'config/grafana/alerting/policies.yaml',
    remote: 'config/grafana/alerting/policies.yaml',
    touches: ['grafana'],
  },
  {
    local: 'config/grafana/alerting/rules.yaml',
    remote: 'config/grafana/alerting/rules.yaml',
    touches: ['grafana'],
  },
  {local: 'config/prometheus/prometheus.yml', remote: 'config/prometheus/prometheus.yml', touches: ['prometheus']},
  {local: 'src/health-report.ts', remote: 'health-reporter/health-report.ts', touches: ['health-reporter']},
]

export function buildSecretFiles(inputs: DeployInputs): RemoteFile[] {
  return [
    {
      path: 'secrets/collector/langfuse-basic',
      // No trailing newline: the collector sends the file's bytes as the credential.
      content: langfuseBasicValue(inputs.langfuseKey),
      owner: `root:${COLLECTOR_GID}`,
      mode: '0440',
      touches: ['collector'],
      kind: 'plain',
    },
    {
      path: 'secrets/grafana/admin-password',
      content: inputs.grafanaAdminPassword,
      owner: `${GRAFANA_UID}:${GRAFANA_UID}`,
      mode: '0400',
      touches: ['grafana'],
      kind: 'plain',
    },
    {
      path: 'secrets/grafana/secret-key',
      content: inputs.grafanaSecretKey,
      owner: `${GRAFANA_UID}:${GRAFANA_UID}`,
      mode: '0400',
      touches: ['grafana'],
      kind: 'plain',
    },
    {
      // The reporter reads both files on every run, so a change needs no restart.
      path: 'secrets/reporter/clickhouse-password',
      content: inputs.clickhouseReaderPassword,
      owner: `${REPORTER_UID}:${REPORTER_UID}`,
      mode: '0400',
      touches: [],
      kind: 'plain',
    },
    {
      path: 'secrets/reporter/minio-password',
      content: inputs.minioPassword,
      owner: `${REPORTER_UID}:${REPORTER_UID}`,
      mode: '0400',
      touches: [],
      kind: 'plain',
    },
  ]
}

export function buildEnvManagedFile(inputs: DeployInputs): RemoteFile {
  return {
    path: '.env',
    content: buildEnvFile(inputs),
    owner: 'root:root',
    mode: '0600',
    touches: ['compose'],
    kind: 'env',
  }
}

/** Reads `apps/traces`'s uploaded files through an injected reader. */
export async function loadUploadedFiles(readFile: (relative: string) => Promise<string>): Promise<RemoteFile[]> {
  return Promise.all(
    UPLOADED_FILES.map(async spec => ({
      path: spec.remote,
      content: await readFile(spec.local),
      owner: 'root:root',
      mode: '0644',
      touches: spec.touches,
      kind: 'plain' as const,
    })),
  )
}

// ─── Remote scripts ───────────────────────────────────────────────────────────
//
// Every script is one `bash -o pipefail -c` command with a `# traces-step:` marker and a sentinel as its last
// line. Variable parts are validated against fixed alphabets or taken from fixed lists; file contents and
// credentials arrive on stdin.

const SAFE_PATH = /^\/[\w./-]+$/

function remotePath(relative: string): string {
  const path = `${TRACES_APP_DIR}/${relative}`
  if (!SAFE_PATH.test(path) || path.includes('..')) throw new Error(`Unsafe remote path: ${relative}`)
  return path
}

/** The same compose prefix `traces status`/`logs`/`ingest` use. */
export const COMPOSE = `docker compose --project-directory ${TRACES_APP_DIR}`

function relativeToApp(absolute: string): string {
  if (!absolute.startsWith(`${TRACES_APP_DIR}/`)) throw new Error(`Not under the app directory: ${absolute}`)
  return absolute.slice(TRACES_APP_DIR.length + 1)
}

/** The deploy marker and the pending-restart record, relative to the app directory (their paths live in `host.ts`). */
const MARKER_FILE = relativeToApp(TRACES_DEPLOY_MARKER)
const STEP_LOCK_FILE = relativeToApp(TRACES_DEPLOY_STEP_LOCK)
const PENDING_RESTARTS_FILE = relativeToApp(TRACES_PENDING_RESTARTS)
/** The only files `removeOwnFileScript` will delete. */
const OWN_FILES: readonly string[] = [MARKER_FILE, PENDING_RESTARTS_FILE, 'secrets/bootstrap-pending']

const TOKEN_FILE_OWNER = `root:${COLLECTOR_GID}`
const TOKEN_FILE_MODE = '0640'
const SECRET_DIR_MODE = '0750'

function assertService(service: string): asserts service is Service {
  if (!(SERVICES as readonly string[]).includes(service)) throw new Error(`Unknown service: ${service}`)
}

function step(name: string, body: string): string {
  return `set -eu\n# traces-step:${name}\n${body}`
}

// ─── Ownership: the last deploy to start owns the host ────────────────────────
//
// A deploy is many separate SSH commands, so no lock can span it. Ownership does instead: the first host script
// writes this deploy's random id into the marker, and every script that changes the host begins by checking that
// the marker still holds that id. A newer deploy overwrites the marker, which makes every later script of the
// older one refuse itself.
//
// The check guards the start of a step, not its end, so a per-step lock closes the rest: every script that changes
// the host takes `flock` on `TRACES_DEPLOY_STEP_LOCK` (descriptor 8) before the check and holds it until its shell
// exits, and the takeover takes the same lock before it writes the marker. A step that passed its check therefore
// finishes before any newer deploy can take the host, and once a deploy owns the host no other deploy's step is
// running or can start. When a script takes both locks, the step lock comes first; the ingest lock (descriptor 9)
// is held only around the state read and write and the Caddy recreate.

/** Printed (exit 1, nothing changed) by a script whose deploy no longer owns the marker. */
export const DEPLOY_OVERTAKEN_SENTINEL = 'DEPLOY_OVERTAKEN'

/** Printed (exit 1, nothing changed) by a script that could not take the step lock within its wait. */
export const DEPLOY_STEP_BUSY_SENTINEL = 'DEPLOY_STEP_BUSY'

/**
 * How long an ordinary step waits for the step lock. It only ever contends with a takeover, which holds the lock for
 * the length of one read and one file write (plus up to 30 s for the ingest lock), so a minute is generous.
 */
export const STEP_LOCK_WAIT_SECONDS = 60

/**
 * How long the takeover waits for an older deploy's step that is in flight: 15 minutes. A step can be an image pull
 * (bounded at 30 minutes) or a service start (20 minutes); most are seconds. Fifteen minutes rides out a slow pull
 * or start without leaving a stuck deploy waiting for hours; a takeover that times out changes nothing and can simply
 * be retried once the other deploy's step has finished.
 */
export const TAKEOVER_LOCK_WAIT_SECONDS = 900

/**
 * Opens the lock file on descriptor 8 and takes the lock, for at most `waitSeconds`. A lock not taken prints the
 * sentinel and exits non-zero before anything has changed. The lock is released when the script's shell exits, however
 * it ends, so it covers the whole step. One line, so it also fits the `; `-joined state-change command.
 */
function stepLockFragment(waitSeconds: number, lock: string = TRACES_DEPLOY_STEP_LOCK): string {
  if (!SAFE_PATH.test(lock) || lock.includes('..')) throw new Error(`Unsafe lock path: ${lock}`)
  return `exec 8>>${lock}; if ! flock -w ${waitSeconds} 8; then echo ${DEPLOY_STEP_BUSY_SENTINEL}; exit 1; fi`
}

const DEPLOY_ID = /^[\da-f]{32,128}$/

/** 16 random bytes as hex. Injectable so a test can fix it. */
export function generateDeployId(random: (size: number) => Uint8Array = size => randomBytes(size)): string {
  return Buffer.from(random(16)).toString('hex')
}

function assertDeployId(id: string): string {
  // The id is spliced into scripts: only lower-case hex of a length that cannot be guessed is accepted.
  if (!DEPLOY_ID.test(id)) throw new Error('The deploy id must be 32 to 128 lower-case hex characters')
  return id
}

/**
 * What every script that changes the host starts with, in this order: the step lock (held to the end of the script,
 * so the check below stays true for the whole step: nobody can take the host while it is held), then the check. The
 * marker must exist and its first field must be this deploy's id. Otherwise the script prints the sentinel and exits
 * non-zero before it has changed anything. In a script that also takes the ingest lock this comes before it (lock
 * order: step lock, then ingest lock). One line, so it also fits the `; `-joined state-change command.
 * `marker` and `lock` exist so a test can run a script against a scratch directory.
 */
export function ownershipPrelude(
  id: string,
  marker: string = TRACES_DEPLOY_MARKER,
  lock: string = TRACES_DEPLOY_STEP_LOCK,
): string {
  assertDeployId(id)
  if (!SAFE_PATH.test(marker) || marker.includes('..')) throw new Error(`Unsafe marker path: ${marker}`)
  return `${stepLockFragment(STEP_LOCK_WAIT_SECONDS, lock)}; if [ -f ${marker} ] && read -r traces_owner traces_rest < ${marker} && [ "$traces_owner" = ${id} ]; then :; else echo ${DEPLOY_OVERTAKEN_SENTINEL}; exit 1; fi`
}

/** A script that changes the host: the step lock and the ownership check come before anything else it does. */
function guardedStep(name: string, id: string, body: string, paths?: {marker: string; lock: string}): string {
  return step(name, `${ownershipPrelude(id, paths?.marker, paths?.lock)}\n${body}`)
}

export const HOST_STATE_SENTINEL = 'TRACES_HOST_STATE_READ'

/**
 * The first thing the deploy does to the host, in one script under the ingest lock: read everything it needs to
 * know (the route state included), then write the deploy marker. Because the marker is written under the same
 * lock the CLI's open script takes, and that script refuses while the marker exists, a manual open either finished
 * before this script ran (and is in what it reads) or is refused from this instant on: the route state the deploy
 * acts on cannot go stale. The previous marker, if any, is reported before it is replaced.
 *
 * The marker holds this deploy's id and the UTC time on one line (`<id> <timestamp>`). Writing it is how a deploy
 * takes the host: whichever deploy wrote it last owns the host, and an older one is refused at its next step. The
 * takeover first takes the step lock, which every other deploy script that changes the host holds for its whole
 * step: it waits (up to `TAKEOVER_LOCK_WAIT_SECONDS`) for an older deploy's step that is in flight, so when it writes
 * the marker no other deploy's step is running. Not obtaining the lock prints `DEPLOY_STEP_BUSY` and exits non-zero
 * with nothing changed. The step lock comes before the ingest lock. Otherwise this script never refuses: a marker a
 * failed deploy left behind never blocks the next deploy.
 *
 * Prints `key=value` lines. The bootstrap values are secrets printed to stdout; they are parsed in memory and never
 * logged.
 */
export function beginDeployScript(id: string): string {
  assertDeployId(id)
  return step(
    'host-state',
    `cd ${TRACES_APP_DIR}
${stepLockFragment(TAKEOVER_LOCK_WAIT_SECONDS)}
exec 9>>${TRACES_INGEST_LOCK}
if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi
if [ -f .env ]; then
  state=$(sed -n 's/^TRACES_INGEST_STATE=//p' .env | tail -n 1)
  printf 'has_env=1\\ningest=%s\\n' "\${state:-off}"
  printf 'env_bootstrap_public=%s\\n' "$(sed -n 's/^LANGFUSE_INIT_PROJECT_PUBLIC_KEY=//p' .env | tail -n 1)"
  printf 'env_bootstrap_secret=%s\\n' "$(sed -n 's/^LANGFUSE_INIT_PROJECT_SECRET_KEY=//p' .env | tail -n 1)"
else
  printf 'has_env=0\\ningest=none\\nenv_bootstrap_public=\\nenv_bootstrap_secret=\\n'
fi
if [ -f secrets/bootstrap-pending ]; then
  printf 'pending=%s\\n' "$(cat secrets/bootstrap-pending)"
else
  printf 'pending=\\n'
fi
if [ -f ${TRACES_PENDING_RESTARTS} ]; then
  printf 'restarts=%s\\n' "$(tr '\\n' ' ' < ${TRACES_PENDING_RESTARTS})"
else
  printf 'restarts=\\n'
fi
if [ -f ${TRACES_DEPLOY_MARKER} ]; then
  printf 'marker=1\\n'
else
  printf 'marker=0\\n'
fi
printf 'epoch=%s\\n' "$(date -u +%s)"
t=$(mktemp ${TRACES_APP_DIR}/.traces-tmp.XXXXXX)
trap 'rm -f "$t"' EXIT
printf '%s %s\\n' ${id} "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" > "$t"
chmod 0644 "$t"
mv -f "$t" ${TRACES_DEPLOY_MARKER}
echo ${HOST_STATE_SENTINEL}`,
  )
}

export interface HostState {
  hasEnv: boolean
  /** A previous deploy did not finish: the marker file exists. */
  marker: boolean
  /** `none` when there is no `.env` yet. */
  ingest: IngestState | 'none'
  /** The bootstrap pair as the host's `.env` holds it. */
  envBootstrap: KeyPair | undefined
  /** A pair an earlier deploy set aside until it can prove the key dead. */
  pendingBootstrap: KeyPair | undefined
  /** Services and `compose` left unrestarted by a deploy that failed after writing files. */
  pendingRestarts: Touch[]
  /** The host clock, in seconds. */
  epoch: number
}

function parsePair(publicKey: string, secretKey: string, label: string): KeyPair | undefined {
  if (publicKey === '' && secretKey === '') return undefined
  if (publicKey === '' || secretKey === '' || !KEY_VALUE.test(publicKey) || !KEY_VALUE.test(secretKey)) {
    throw new Error(`The host's ${label} is not a complete key pair; fix it by hand before deploying`)
  }
  return {publicKey, secretKey}
}

function keyValueLines(stdout: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const line of stdout.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) values.set(line.slice(0, at), line.slice(at + 1).trim())
  }
  return values
}

export function parseHostState(stdout: string): HostState {
  const values = keyValueLines(stdout)
  const ingest = values.get('ingest')
  if (ingest !== 'off' && ingest !== 'held' && ingest !== 'open' && ingest !== 'none') {
    // The route's state is unknown, so nothing may be assumed about it.
    throw new Error('The host reported an ingest state this deploy does not recognise; refusing to continue')
  }
  const hasEnv = values.get('has_env')
  if (hasEnv !== '0' && hasEnv !== '1') throw new Error('The host did not report whether it has a .env')
  const marker = values.get('marker')
  if (marker !== '0' && marker !== '1') throw new Error('The host did not report whether a deploy marker exists')
  const epoch = Number(values.get('epoch'))
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('The host did not report its clock')

  const pending = values.get('pending') ?? ''
  const pendingPair =
    pending === ''
      ? undefined
      : (() => {
          const [publicKey = '', secretKey = '', ...rest] = pending.split(':')
          if (rest.length > 0) throw new Error("The host's pending bootstrap record is not a key pair")
          return parsePair(publicKey, secretKey, 'pending bootstrap record')
        })()

  const restarts = (values.get('restarts') ?? '').split(/\s+/).filter(name => name !== '')
  for (const name of restarts) {
    if (name !== 'compose' && !(SERVICES as readonly string[]).includes(name)) {
      throw new Error("The host's pending-restart record names something this deploy does not know")
    }
  }

  return {
    hasEnv: hasEnv === '1',
    marker: marker === '1',
    ingest,
    envBootstrap: parsePair(
      values.get('env_bootstrap_public') ?? '',
      values.get('env_bootstrap_secret') ?? '',
      'bootstrap key variables',
    ),
    pendingBootstrap: pendingPair,
    pendingRestarts: restarts as Touch[],
    epoch,
  }
}

export const DIRS_SENTINEL = 'TRACES_DIRS_READY'

/** Directories and their owners. Created or corrected; nothing inside a token directory is touched. */
export function prepareDirsScript(id: string): string {
  const dir = (relative: string): string => remotePath(relative)
  const plain = [
    'config',
    'config/ingest',
    'config/clickhouse',
    'config/clickhouse-users',
    'config/grafana',
    'config/grafana/alerting',
    'config/grafana/datasources',
    'config/prometheus',
    'health-reporter',
    'secrets',
  ].map(dir)
  const collector = [dir('secrets/collector'), dir('tokens'), ...SENDER_GROUPS.map(group => dir(`tokens/${group}`))]
  return guardedStep(
    'prepare-dirs',
    id,
    `mountpoint -q ${TRACES_VOLUME_MOUNT}
grep -qx ${TRACES_SENTINEL_CONTENT} ${TRACES_SENTINEL_PATH}
install -d -o root -g root -m 0755 ${plain.join(' ')}
install -d -o root -g ${COLLECTOR_GID} -m ${SECRET_DIR_MODE} ${collector.join(' ')}
install -d -o root -g ${GRAFANA_UID} -m ${SECRET_DIR_MODE} ${dir('secrets/grafana')}
install -d -o root -g ${REPORTER_UID} -m ${SECRET_DIR_MODE} ${dir('secrets/reporter')}
echo ${DIRS_SENTINEL}`,
  )
}

export const TOKEN_SENTINELS = ['TRACES_TOKEN_CREATED', 'TRACES_TOKEN_PRESENT'] as const

/**
 * Create `tokens/<group>/token` as a deny-all file when it does not exist, and do nothing at all when it does. A
 * token file is never empty: the pinned collector's credential file watcher rejects an empty file (it fails at start
 * and keeps the previous credentials on reload), so a missing file is created with one void line, `trc_void_<43
 * base64url> void <timestamp>`, a token nobody knows. The line is generated by the deploy on the machine that runs it
 * and arrives on stdin; it is not in this script's text. It is written to a temporary file in the token directory
 * with its owner and mode set, then hard-linked into place: `ln` fails when the target exists, so a file that appears
 * in between is never replaced. The temporary name is removed on exit. This script never writes, replaces, truncates
 * or removes an existing token file. `appDir` exists so a test can run the real script against a scratch directory.
 */
export function tokenFileScript(group: SenderGroup, id: string, appDir: string = TRACES_APP_DIR): string {
  if (!(SENDER_GROUPS as readonly string[]).includes(group)) throw new Error(`Unknown sender group: ${group}`)
  const file = `${appDir}/tokens/${group}/token`
  const directory = `${appDir}/tokens/${group}`
  if (!SAFE_PATH.test(file) || file.includes('..')) throw new Error('Unsafe token path')
  return guardedStep(
    `token-file:${group}`,
    id,
    String.raw`f=${file}
line=$(cat)
t=$(mktemp ${directory}/.void.XXXXXX)
trap 'rm -f "$t"' EXIT
printf '%s\n' "$line" > "$t"
chown ${TOKEN_FILE_OWNER} "$t"
chmod ${TOKEN_FILE_MODE} "$t"
if [ -e "$f" ] || [ -L "$f" ]; then
  if [ -f "$f" ]; then
    echo ${TOKEN_SENTINELS[1]}
  else
    echo "token path exists and is not a regular file" >&2
    exit 1
  fi
elif ln "$t" "$f"; then
  echo ${TOKEN_SENTINELS[0]}
elif [ -f "$f" ]; then
  echo ${TOKEN_SENTINELS[1]}
else
  echo "token path could not be created" >&2
  exit 1
fi`,
    {marker: `${appDir}/${MARKER_FILE}`, lock: `${appDir}/${STEP_LOCK_FILE}`},
  )
}

/** A void token line: a token nobody knows, `trc_void_<43 base64url chars from 32 random bytes> void <UTC timestamp>`. */
export function generateVoidTokenLine(
  now: Date = new Date(),
  random: (size: number) => Uint8Array = size => randomBytes(size),
): string {
  return `${TRACES_VOID_TOKEN_PREFIX}${Buffer.from(random(32)).toString('base64url')} void ${now.toISOString()}`
}

export const TOKEN_DIRS_SENTINEL = 'TRACES_TOKEN_DIRS_CHECKED'

/**
 * Per group, what the token file is: `absent`, `empty` (no non-blank character, which is what the collector's watcher
 * refuses), or `tokens:<n>` with n the number of real token lines (a non-blank line whose first field does not start
 * with the void prefix; a deny-all file is `tokens:0`). Only counts are printed, never a line.
 */
export function tokenDirsScript(): string {
  const checks = SENDER_GROUPS.map(group => {
    const file = remotePath(`tokens/${group}/token`)
    return `f=${file}
if [ ! -f "$f" ]; then
  echo token_file=${group}:absent
elif ! grep -q '[^[:space:]]' "$f"; then
  echo token_file=${group}:empty
else
  n=$(awk -v p='${TRACES_VOID_TOKEN_PREFIX}' 'NF > 0 && index($1, p) != 1 {n++} END {print n + 0}' "$f")
  echo "token_file=${group}:tokens:$n"
fi`
  })
  return step('token-dirs', `${checks.join('\n')}\necho ${TOKEN_DIRS_SENTINEL}`)
}

/** `absent`, `empty`, or the number of real token lines (0 is a deny-all file). */
export type TokenFileState = 'absent' | 'empty' | number

export function parseTokenFiles(stdout: string): Record<string, TokenFileState> {
  const states: Record<string, TokenFileState> = {}
  for (const match of stdout.matchAll(/^token_file=([\w-]+):(absent|empty|tokens:(\d+))$/gm)) {
    const group = match[1]
    if (group === undefined) continue
    states[group] = match[2] === 'absent' ? 'absent' : match[2] === 'empty' ? 'empty' : Number(match[3])
  }
  return states
}

export const FILE_COMPARE_SENTINELS = ['TRACES_FILE_SAME', 'TRACES_FILE_DIFFERENT', 'TRACES_FILE_ABSENT'] as const

const OWNER = /^(?:root|\d+):(?:root|\d+)$/
const MODE = /^0[0-7]{3}$/

/**
 * An owner and mode as `stat -c '%u:%g %a'` prints them: the numeric user and group (`root` is 0) and the mode in
 * octal without its leading zero, so `root:65532` and `0440` are `0:65532 440`.
 */
function statForm(file: Pick<RemoteFile, 'owner' | 'mode'>): string {
  if (!OWNER.test(file.owner)) throw new Error(`Unsafe owner: ${file.owner}`)
  if (!MODE.test(file.mode)) throw new Error(`Unsafe mode: ${file.mode}`)
  const owner = file.owner.replaceAll('root', '0')
  return `${owner} ${Number.parseInt(file.mode, 8).toString(8)}`
}

/**
 * Compares stdin with a file on the host, and the file's owner and mode with the pair the deploy would give it. A file
 * whose content matches but whose owner or mode differs is `DIFFERENT`: it is rewritten, so a service that mounts it
 * is recreated as for a content change. (The reporter's secret files are the case that needs it: they sit on the host
 * owned by the reporter's old user, with unchanged content.) `.env` is compared without its ingest-state line. Writes
 * nothing. Token files are never compared: deploy creates one only when it is absent and never touches it after.
 *
 * `stat -c` is GNU coreutils, which the host (Ubuntu) has. A host that cannot answer fails the step (`set -e`): it
 * is never read as "same".
 */
export function compareFileScript(
  path: string,
  kind: 'plain' | 'env',
  attrs: Pick<RemoteFile, 'owner' | 'mode'>,
): string {
  const target = remotePath(path)
  const same = kind === 'env' ? `grep -v '^TRACES_INGEST_STATE=' ${target} | cmp -s "$t" -` : `cmp -s "$t" ${target}`
  return step(
    `compare:${path}`,
    `t=$(mktemp /tmp/traces-cmp.XXXXXX)
trap 'rm -f "$t"' EXIT
cat > "$t"
if [ ! -e ${target} ]; then
  status=${FILE_COMPARE_SENTINELS[2]}
elif ! ${same}; then
  status=${FILE_COMPARE_SENTINELS[1]}
else
  attr=$(stat -c '%u:%g %a' ${target})
  if [ "$attr" = '${statForm(attrs)}' ]; then status=${FILE_COMPARE_SENTINELS[0]}; else status=${FILE_COMPARE_SENTINELS[1]}; fi
fi
echo "$status"`,
  )
}

export const FILE_WRITTEN_SENTINEL = 'TRACES_FILE_WRITTEN'

/**
 * Write stdin to a file: a temporary file in the same directory with its owner and mode set first, then an atomic
 * rename. A reader never sees a half-written secret or a file with the wrong owner.
 *
 * For `.env` the script takes the ingest lock (after the step lock and the check) and re-reads the route state from the file it is about to replace.
 * It appends the less open of the planned state and the one on the host: a hold or off that is there stays, so a
 * `traces ingest hold` run during the deploy is never undone by a cached state; a state of `open` on the host becomes
 * the planned one; a host with no `.env` gets the planned one. It prints `TRACES_ENV_STATE=<state written>` so the
 * deploy knows what the host has. Only the deploy's own gated open step (`setIngestStateCommand`) ever opens.
 *
 * It begins with the step lock and the ownership check: a deploy that was overtaken writes nothing.
 */
export function writeFileScript(
  id: string,
  file: Pick<RemoteFile, 'path' | 'owner' | 'mode' | 'kind'>,
  state?: IngestState,
): string {
  const prelude = ownershipPrelude(id)
  if (!OWNER.test(file.owner)) throw new Error(`Unsafe owner: ${file.owner}`)
  if (!MODE.test(file.mode)) throw new Error(`Unsafe mode: ${file.mode}`)
  const target = remotePath(file.path)
  const directory = target.slice(0, target.lastIndexOf('/'))
  if (file.kind === 'env' && state === undefined) throw new Error('The .env needs an ingest state')
  const lock =
    file.kind === 'env'
      ? `exec 9>>${TRACES_INGEST_LOCK}
if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi
`
      : ''
  const decide =
    file.kind === 'env'
      ? `planned=${state}
state=$planned
if [ -f ${target} ]; then
  cur=$(sed -n 's/^TRACES_INGEST_STATE=//p' ${target} | tail -n 1)
  case "\${cur:-off}" in
    open) ;;
    held|off) state=\${cur:-off} ;;
    *) state=held ;;
  esac
fi
printf 'TRACES_INGEST_STATE=%s\\n' "$state" >> "$t"
`
      : ''
  const report = file.kind === 'env' ? 'echo TRACES_ENV_STATE=$state\n' : ''
  return step(
    `write:${file.path}`,
    `umask 077
${prelude}
${lock}t=$(mktemp ${directory}/.traces-tmp.XXXXXX)
trap 'rm -f "$t"' EXIT
cat > "$t"
${decide}chown ${file.owner} "$t"
chmod ${file.mode} "$t"
mv -f "$t" ${target}
${report}echo ${FILE_WRITTEN_SENTINEL}`,
  )
}

export const REMOVED_SENTINEL = 'TRACES_REMOVED'

/**
 * Remove one file the deploy itself owns, inside the app directory, only while this deploy still owns the host.
 *
 * The marker is removed by compare-and-delete: in the same script, under the step lock (which keeps another deploy
 * from taking the host between the check and the delete) and the ingest lock (the one a manual `traces ingest open`
 * and the deploy's own open take), it is removed only if it still holds this deploy's id. A deploy that was
 * overtaken, or whose marker is already gone, prints `DEPLOY_OVERTAKEN` and removes nothing.
 */
export function removeOwnFileScript(id: string, path: string): string {
  if (!OWN_FILES.includes(path)) throw new Error(`${path} is not a file this deploy owns`)
  const body = `rm -f ${remotePath(path)}\necho ${REMOVED_SENTINEL}`
  if (path !== MARKER_FILE) return guardedStep(`remove:${path}`, id, body)
  return step(
    `remove:${path}`,
    `${ownershipPrelude(id)}
exec 9>>${TRACES_INGEST_LOCK}
if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi
${body}`,
  )
}

/**
 * The state line and the Caddy recreate, as `traces ingest hold|open` does them (`REMOTE_COMMANDS.writeIngestState`),
 * inside `flock -w 30` on the ingest lock so that two transitions never interleave. The lock is taken on file
 * descriptor 9 before the state is read and is held until the command ends, which is after Caddy was recreated.
 * A lock that cannot be taken in 30 seconds prints `LOCK_BUSY` and fails; it is never skipped. The compose
 * command gets descriptors 8 and 9 closed, so nothing it starts can outlive either lock. The new line travels on
 * stdin. A test compares this with the CLI's text.
 *
 * The deploy's version adds the step lock and the ownership check, first (lock order: step lock, then ingest lock):
 * before anything is written it checks that the marker still holds this deploy's id, and the step lock keeps that
 * true until the command ends. So a deploy that was overtaken can neither open nor hold the route after the newer
 * deploy took the host, and nothing falls between the check and the write.
 */
export function setIngestStateCommand(state: IngestState, id: string): string {
  return [
    'set -e',
    `cd ${TRACES_APP_DIR}`,
    ownershipPrelude(id),
    `exec 9>>${TRACES_INGEST_LOCK}`,
    `if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi`,
    'test -f .env',
    't=$(mktemp ./.env.XXXXXX)',
    `{ grep -v '^TRACES_INGEST_STATE=' .env || true; cat; } > "$t"`,
    'chmod 600 "$t"',
    'mv "$t" .env',
    `${COMPOSE} up -d --force-recreate --no-deps caddy 8>&- 9>&-`,
    `echo TRACES_INGEST_STATE_SET=${state}`,
  ].join('; ')
}

export const INGEST_STATE_STDIN = (state: IngestState): string => `TRACES_INGEST_STATE=${state}\n`

export const INGEST_STATE_READ_SENTINEL = 'TRACES_INGEST_STATE_READ'

/** What the host's `.env` says the route is now: `off`, `held`, `open`, or `none` when there is no `.env`. Read only. */
export function readIngestStateScript(): string {
  return step(
    'ingest-state',
    `cd ${TRACES_APP_DIR}
if [ -f .env ]; then
  state=$(sed -n 's/^TRACES_INGEST_STATE=//p' .env | tail -n 1)
  printf 'ingest=%s\\n' "\${state:-off}"
else
  printf 'ingest=none\\n'
fi
echo ${INGEST_STATE_READ_SENTINEL}`,
  )
}

export const DRIFT_SENTINEL = 'TRACES_DRIFT_CHECKED'

/**
 * For each gated service: is a container there, is it running, and does its `com.docker.compose.config-hash` label
 * equal what `docker compose config --hash <service>` computes from the files on disk now? Changes nothing.
 *
 * It is run only when the compose file and `.env` are byte-identical to the host's (apart from the state line), so
 * "the files on disk now" are also the files a `compose up` this deploy runs would read: a hash that differs means
 * `up` would recreate that service, and a service that is not running is one `up` would start.
 */
export function driftScript(): string {
  return step(
    'drift-check',
    `cd ${TRACES_APP_DIR}
for svc in ${GATED_SERVICES.join(' ')}; do
  expected=$(${COMPOSE} config --hash "$svc" | sed -n "s/^$svc //p" | head -n 1)
  cid=$(${COMPOSE} ps -a -q "$svc" | head -n 1)
  if [ -z "$cid" ]; then
    echo "drift $svc missing"
    continue
  fi
  running=$(docker inspect --format '{{.State.Running}}' "$cid")
  actual=$(docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$cid")
  if [ "$running" != true ]; then
    echo "drift $svc stopped"
  elif [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
    echo "drift $svc hash"
  else
    echo "same $svc"
  fi
done
echo ${DRIFT_SENTINEL}`,
  )
}

/**
 * The gated services the drift probe says are not running what the files say. `undefined` is an answer that cannot
 * be trusted (no sentinel, a service missing, a word that is not `same` or `drift`): the caller treats it as drift.
 */
export function parseDrift(stdout: string): Service[] | undefined {
  const lines = stdout
    .split('\n')
    .map(line => line.trim())
    .filter(line => line !== '')
  if (lines.at(-1) !== DRIFT_SENTINEL) return undefined
  const seen = new Map<string, 'same' | 'drift'>()
  for (const line of lines.slice(0, -1)) {
    const match = /^(same|drift) ([\w-]+)(?: (?:missing|stopped|hash))?$/.exec(line)
    if (match?.[1] === undefined || match[2] === undefined) return undefined
    if (!(GATED_SERVICES as readonly string[]).includes(match[2]) || seen.has(match[2])) return undefined
    seen.set(match[2], match[1] === 'same' ? 'same' : 'drift')
  }
  if (GATED_SERVICES.some(service => !seen.has(service))) return undefined
  return GATED_SERVICES.filter(service => seen.get(service) === 'drift')
}

/** The reporter's loopback listener, reached by exec exactly as `traces status` does. */
export const REPORTER_DETAIL_SENTINEL = 'TRACES_DETAIL_END'
export const REPORTER_DETAIL_COMMAND = `${COMPOSE} exec -T health-reporter wget -q -O - http://127.0.0.1:8081/detail && echo && echo ${REPORTER_DETAIL_SENTINEL}`

export const INGEST_PROBE_SENTINEL = 'TRACES_INGEST_PROBED'

/**
 * An unauthenticated, empty-bodied POST to each ingest path through Caddy, from inside the host: the answer is
 * 404 when ingest is off, 503 when held and 401 (the collector wants a token) when open. `--resolve` points the
 * public name at this host, so the real certificate and the real route are used. The body of the answer is
 * never printed.
 */
export function probeIngestScript(domain: string): string {
  if (!DOMAIN.test(domain)) throw new Error('Unsafe domain')
  return `set -u
# traces-step:probe-ingest
for g in ${SENDER_GROUPS.join(' ')}; do
  out=$(curl -sS --max-time 10 --resolve ${domain}:443:127.0.0.1 -X POST -H 'content-type: application/json' --data '{}' -w '\\nTRACES_HTTP=%{http_code}' "https://${domain}/$g/v1/traces" 2>&1) || true
  code=$(printf '%s' "$out" | sed -n 's/.*TRACES_HTTP=\\([0-9]*\\)$/\\1/p' | tail -n 1)
  echo "TRACES_INGEST_CODE $g \${code:-000}"
done
echo ${INGEST_PROBE_SENTINEL}`
}

export type PathStatus = number | 'unreachable'

export function parseIngestProbe(stdout: string): Record<string, PathStatus> {
  const statuses: Record<string, PathStatus> = {}
  for (const line of stdout.split('\n')) {
    const match = /^TRACES_INGEST_CODE (\S+) (\d{3})$/.exec(line.trim())
    if (match?.[1] !== undefined && match[2] !== undefined) {
      statuses[match[1]] = match[2] === '000' ? 'unreachable' : Number(match[2])
    }
  }
  return statuses
}

const EXPECTED_STATUS: Record<IngestState, number> = {off: 404, held: 503, open: 401}

/** True only when every group answered, and every answer is the one that state produces. */
export function provesState(statuses: Record<string, PathStatus>, state: IngestState): boolean {
  return SENDER_GROUPS.every(group => statuses[group] === EXPECTED_STATUS[state])
}

export const DISK_SENTINEL = 'TRACES_DISK_PROBED'

/** Free bytes on the volume. */
export function diskScript(): string {
  return step(
    'disk-free',
    String.raw`printf 'free_bytes=%s\n' "$(df -B1 --output=avail ${TRACES_VOLUME_MOUNT} | tail -n 1 | tr -d ' ')"
echo ${DISK_SENTINEL}`,
  )
}

/** Below this the pull could fill the volume; the Langfuse images alone are about 9 GB. */
export const MIN_FREE_BYTES = 5 * 1024 ** 3

export const STEP_SENTINEL = (name: string): string => `TRACES_STEP_OK:${name}`

function composeStep(name: string, id: string, command: string): string {
  // The ownership check comes first: an overtaken deploy runs nothing and reads no clock.
  // The host's clock is read before the command runs: a verdict produced by a restarted service is newer than this.
  return step(
    name,
    `cd ${TRACES_APP_DIR}\n${ownershipPrelude(id)}\nprintf 'epoch=%s\\n' "$(date -u +%s)"\n${command}\necho ${STEP_SENTINEL(name)}`,
  )
}

export function pruneScript(id: string): string {
  return composeStep('prune-images', id, 'docker image prune -af')
}

/**
 * `docker compose pull` for named services only (the ingest services by default). An unscoped pull would take the
 * monitoring images into the route-critical step, where a registry failure on one of them holds ingest.
 */
export function pullScript(id: string, name = 'pull', services: readonly string[] = INGEST_SERVICES): string {
  for (const service of services) assertService(service)
  if (services.length === 0) throw new Error('pullScript needs at least one service')
  return composeStep(name, id, `timeout 1800 ${COMPOSE} pull ${services.join(' ')}`)
}

export interface UpOptions {
  /** Recreate even when compose sees no change. Always paired with `--no-deps`. */
  force?: boolean
}

/** `up -d --wait` for named services only; compose recreates exactly those whose configuration changed. */
export function upScript(id: string, name: string, services: readonly string[], options: UpOptions = {}): string {
  for (const service of services) assertService(service)
  if (services.length === 0) throw new Error('upScript needs at least one service')
  const flags = options.force === true ? '--force-recreate --no-deps ' : ''
  return composeStep(name, id, `timeout 1200 ${COMPOSE} up -d --wait --wait-timeout 600 ${flags}${services.join(' ')}`)
}

/** Create (never recreate) the collector container, which also creates its queue volume. */
export function createCollectorScript(id: string): string {
  return composeStep('create-collector', id, `${COMPOSE} create --no-recreate collector`)
}

export const QUEUE_SENTINEL = 'TRACES_QUEUE_VOLUME_READY'
export const PROMETHEUS_VOLUME_SENTINEL = 'TRACES_PROMETHEUS_VOLUME_READY'

/**
 * Give a named volume's directory to the user its container runs as, and read the owner back. The directory must be
 * under Docker's data root on the encrypted volume; nothing else is ever changed.
 */
function volumeOwnerBody(label: string, volume: string, uid: string, sentinel: string): string {
  return `mp=$(docker volume inspect ${volume} --format '{{.Mountpoint}}')
case "$mp" in
  ${TRACES_DOCKER_ROOT}/volumes/*/_data) ;;
  *) echo "${label} volume is not under the Docker data root on the volume" >&2; exit 1 ;;
esac
chown ${uid}:${uid} "$mp"
chmod 0700 "$mp"
owner=$(stat -c '%u:%g' "$mp")
if [ "$owner" != ${uid}:${uid} ]; then
  echo "${label} volume owner is not ${uid}" >&2
  exit 1
fi
echo ${sentinel}`
}

/**
 * The collector runs as UID 65532 and a fresh named volume is root-owned. Ownership is set here, once, on the
 * volume's directory (never on anything but a path under Docker's data root on the encrypted volume) and read
 * back, instead of relying on Docker copying ownership out of the image: the host keeps images in the
 * containerd store, where that copy is the least-tested path, and a volume created root-owned by any earlier
 * start would never inherit it.
 */
export function queueVolumeScript(id: string): string {
  return guardedStep(
    'queue-volume',
    id,
    volumeOwnerBody('queue', COMPOSE_PROJECT_VOLUME, COLLECTOR_GID, QUEUE_SENTINEL),
  )
}

/** Create (never recreate) the Prometheus container, which also creates its data volume. */
export function createPrometheusScript(id: string): string {
  return composeStep('create-prometheus', id, `${COMPOSE} create --no-recreate prometheus`)
}

/**
 * Prometheus runs as `nobody` (65534) and a fresh named volume is root-owned, so its first start would fail to write
 * its data. Ownership is set here, once, as for the collector's queue volume, instead of relying on Docker copying
 * it out of the image.
 */
export function prometheusVolumeScript(id: string): string {
  return guardedStep(
    'prometheus-volume',
    id,
    volumeOwnerBody('prometheus data', PROMETHEUS_PROJECT_VOLUME, PROMETHEUS_UID, PROMETHEUS_VOLUME_SENTINEL),
  )
}

export const DIGEST_SENTINEL = 'TRACES_DIGEST_READ'

/** The repo digests of the image a service is actually running (two-step: container, then image). */
export function runningDigestScript(service: Service): string {
  assertService(service)
  return step(
    `digest:${service}`,
    String.raw`cd ${TRACES_APP_DIR}
cid=$(${COMPOSE} ps -q ${service})
if [ -z "$cid" ]; then echo "${service} is not running" >&2; exit 1; fi
img=$(docker inspect --format '{{.Image}}' "$cid")
printf 'repo_digests=%s\n' "$(docker inspect --format '{{json .RepoDigests}}' "$img")"
echo ${DIGEST_SENTINEL}`,
  )
}

export const GRAFANA_PROBE_SENTINEL = 'TRACES_GRAFANA_PROBED'

/**
 * What the Grafana sign-in check got: the HTTP status for the password read from `secrets/grafana/admin-password`
 * (`000` is no answer, or no password file), and, when the check could not be run at all, why.
 */
export interface GrafanaSignIn {
  code: string
  error?: string
}

/**
 * Signs in to Grafana on its loopback port, from the host, once, with the admin password from its secret file.
 * Grafana reads that file only if it can enter the secret directory; when it cannot it logs "Permission denied"
 * and starts on its defaults, which this check is there to catch. There is no second request with the default
 * password: Grafana counts failed Basic Auth logins per username (5 in 5 minutes), so each deploy would spend one on
 * the admin account. One 200 with the file's password proves the account's password is the file's value, and the
 * input check (`GRAFANA_ADMIN_PASSWORD_MIN`) keeps that value from being the default.
 *
 * The password never leaves the host's shell. It is read from the file inside the script, put into a curl config
 * with the shell's own `printf` (a builtin, so it is in no argv) and handed to curl on stdin (`-K -`). No credential
 * is a curl argument. The probe stays on loopback whatever the host's environment holds: `-q`, which curl honours
 * only as its first argument, skips `.curlrc`, and `--noproxy '*'` ignores `http_proxy` and the like. The response
 * body is captured and dropped, curl's errors are off (`-s`), and only the status code is printed. The password
 * alphabet is URL-safe (`requireUrlSafe`), so it needs no quoting inside the config.
 */
export function grafanaSignInScript(): string {
  return `set -u
# traces-step:grafana-signin
cd ${TRACES_APP_DIR}
url=http://127.0.0.1:3001/api/user
file=secrets/grafana/admin-password
code=000
if [ -s "$file" ]; then
  out=$(printf 'user = "admin:%s"\\n' "$(cat "$file")" | curl -q -s --noproxy '*' --max-time 10 -K - -w '\\nTRACES_HTTP=%{http_code}' "$url") || true
  code=$(printf '%s' "$out" | sed -n 's/.*TRACES_HTTP=\\([0-9]*\\)$/\\1/p' | tail -n 1)
fi
echo "TRACES_GRAFANA_FILE_HTTP=\${code:-000}"
echo ${GRAFANA_PROBE_SENTINEL}`
}

/** The status code from a complete answer; undefined for anything else. */
export function parseGrafanaProbe(stdout: string): string | undefined {
  const code = /^TRACES_GRAFANA_FILE_HTTP=(\d{3})$/m.exec(stdout)?.[1]
  if (code === undefined) return undefined
  if (!stdout.split('\n').some(line => line.trim() === GRAFANA_PROBE_SENTINEL)) return undefined
  return code
}

/** The contact point the alerting files provision; pinned to `config/grafana/alerting/contact-points.yaml` by a test. */
export const ALERT_CONTACT_POINT_UID = 'traces-discord'

/** The rule groups the rules file provisions and how many rules each holds; pinned to `rules.yaml` by a test. */
export const ALERT_RULE_GROUPS: readonly {name: string; rules: number}[] = [
  {name: 'stack', rules: 4},
  {name: 'collector', rules: 3},
  {name: 'tempo', rules: 2},
  {name: 'storage', rules: 4},
]

export const GRAFANA_ALERTING_SENTINEL = 'TRACES_GRAFANA_ALERTING_PROBED'

/**
 * What Grafana says about its provisioned alerting, or why the check could not be made. Parsed, not validated: the
 * contact-point list is kept as text for `evaluateGrafanaAlerting` to read.
 */
export type GrafanaAlerting =
  | {error: string}
  | {
      contactPoints: {code: string; body: string}
      rules: {code: string; groups: Record<string, number>}
    }

/**
 * Reads two lists from Grafana's provisioning API on its loopback port, from the host, with the admin password from
 * its secret file (the same credential handling as `grafanaSignInScript`: the password is in a curl config on stdin,
 * in no argv). It only reads: it sends no notification and changes no rule.
 *
 *   - the contact points, with every `settings` object cut out on the host, so the webhook address (which Grafana
 *     redacts anyway) could not reach the output;
 *   - the alert rules, counted by rule group on the host.
 */
export function grafanaAlertingScript(): string {
  return `set -u
# traces-step:grafana-alerting
cd ${TRACES_APP_DIR}
base=http://127.0.0.1:3001/api/v1/provisioning
file=secrets/grafana/admin-password
get() {
  code=000
  body=
  if [ -s "$file" ]; then
    out=$(printf 'user = "admin:%s"\\n' "$(cat "$file")" | curl -q -s --noproxy '*' --max-time 10 -K - -w '\\nTRACES_HTTP=%{http_code}' "$1") || true
    code=$(printf '%s' "$out" | sed -n 's/.*TRACES_HTTP=\\([0-9]*\\)$/\\1/p' | tail -n 1)
    body=$(printf '%s' "$out" | sed 's/TRACES_HTTP=[0-9]*$//' | tr -d '\\n')
  fi
  code=\${code:-000}
}
get "$base/contact-points"
echo "TRACES_GRAFANA_CP_HTTP=$code"
printf 'TRACES_GRAFANA_CP_BODY=%s\\n' "$(printf '%s' "$body" | sed 's/"settings":{[^}]*}/"settings":{}/g')"
get "$base/alert-rules"
echo "TRACES_GRAFANA_RULES_HTTP=$code"
printf '%s' "$body" | grep -o '"ruleGroup":"[^"]*"' | sort | uniq -c | sed -n 's/^ *\\([0-9]*\\) "ruleGroup":"\\([^"]*\\)"$/TRACES_GRAFANA_RULE_GROUP=\\2 \\1/p'
echo ${GRAFANA_ALERTING_SENTINEL}`
}

/** A complete answer only: both status lines, the contact-point line and the sentinel. Anything else is `undefined`. */
export function parseGrafanaAlerting(stdout: string): GrafanaAlerting | undefined {
  if (!stdout.split('\n').some(line => line.trim() === GRAFANA_ALERTING_SENTINEL)) return undefined
  const contactCode = /^TRACES_GRAFANA_CP_HTTP=(\d{3})$/m.exec(stdout)?.[1]
  const rulesCode = /^TRACES_GRAFANA_RULES_HTTP=(\d{3})$/m.exec(stdout)?.[1]
  const body = /^TRACES_GRAFANA_CP_BODY=(.*)$/m.exec(stdout)?.[1]
  if (contactCode === undefined || rulesCode === undefined || body === undefined) return undefined
  const groups: Record<string, number> = {}
  for (const match of stdout.matchAll(/^TRACES_GRAFANA_RULE_GROUP=([\w-]+) (\d+)$/gm)) {
    if (match[1] !== undefined && match[2] !== undefined) groups[match[1]] = Number(match[2])
  }
  return {contactPoints: {code: contactCode, body}, rules: {code: rulesCode, groups}}
}

export const BOOTSTRAP_PROBE_SENTINEL = 'TRACES_BOOTSTRAP_PROBED'

/**
 * Ask Langfuse, with the bootstrap pair, for the project list: a read endpoint that answers 200 to a live key and
 * 401 to a dead one. The credential (base64 `public:secret`) arrives on stdin and is read by a short Node program
 * inside the Langfuse container (Node is what that image runs), so it is in no argv on this side. Only the status
 * code is printed, never a body; a request that could not be made prints 0, which is never read as "dead".
 */
export const BOOTSTRAP_PROBE_PROGRAM =
  'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>fetch("http://127.0.0.1:3000/api/public/projects",{headers:{authorization:"Basic "+s.trim()}}).then(r=>console.log(r.status),()=>console.log(0)))'

export function bootstrapProbeScript(): string {
  return `set -u
# traces-step:bootstrap-probe
cd ${TRACES_APP_DIR}
code=$(${COMPOSE} exec -T langfuse-web node -e ${shellQuote(BOOTSTRAP_PROBE_PROGRAM)}) || true
echo "TRACES_BOOTSTRAP_HTTP=\${code:-000}"
echo ${BOOTSTRAP_PROBE_SENTINEL}`
}

export const HYGIENE_SENTINEL = 'TRACES_HYGIENE_CHECKED'

/**
 * Counts, without printing any value, the bootstrap key variables that carry a value in the host's `.env` and in
 * every running container's environment. (The compose file passes them through as empty strings, so the names
 * are always present in the web container: only a non-empty value counts.)
 */
export function hygieneScript(): string {
  return String.raw`set -u
# traces-step:bootstrap-hygiene
cd ${TRACES_APP_DIR}
pattern='^LANGFUSE_INIT_PROJECT_\(PUBLIC\|SECRET\)_KEY=.'
in_env=$(grep -c "$pattern" .env || true)
running=0
for id in $(${COMPOSE} ps -q); do
  n=$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$id" | grep -c "$pattern" || true)
  running=$((running + n))
done
echo "TRACES_HYGIENE env_file=$in_env running=$running"
echo ${HYGIENE_SENTINEL}`
}

// ─── Running remote steps ─────────────────────────────────────────────────────

function clip(text: string): string {
  const flat = text.replaceAll(/\s+/g, ' ').trim()
  return flat.length > 240 ? `${flat.slice(0, 240)}…` : flat
}

function lastLine(result: RunResult): string | undefined {
  return result.stdout
    .split('\n')
    .map(line => line.trim())
    .findLast(line => line !== '')
}

export interface StepOutcome<T extends string> {
  sentinel: T
  result: RunResult
}

export async function runStep<T extends string>(
  exec: RemoteExec,
  label: string,
  script: string,
  accepted: readonly T[],
  stdin?: string,
): Promise<StepOutcome<T>> {
  const result = await exec(bashCommand(script), stdin)
  if (result.exitCode !== 0) {
    throw new Error(
      `${label} failed (exit ${result.exitCode}): ${clip(result.stderr) || clip(result.stdout) || 'no output'}`,
    )
  }
  const last = lastLine(result)
  const match = accepted.find(sentinel => sentinel === last)
  if (match === undefined) {
    throw new Error(`${label}: unrecognised answer from the host (expected ${accepted.join(' or ')})`)
  }
  return {sentinel: match, result}
}

// ─── The reporter's verdict ───────────────────────────────────────────────────

export interface ReporterCheck {
  id: string
  status: 'pass' | 'warn' | 'fail' | 'unknown'
  detail: string
  /** Absent from a reporter that predates the split; read as `ingest`. */
  scope?: 'ingest' | 'monitoring'
}

export interface ReporterDetail {
  ran: boolean
  stale: boolean
  /** The ingest verdict. The `reporter-verdict` gate reads this and nothing about monitoring. */
  ok: boolean
  /** Grafana and Prometheus. Informational here: it never reaches a gate. */
  monitoringOk?: boolean
  at: string | null
  checks: ReporterCheck[]
}

const CHECK_STATUSES: readonly string[] = ['pass', 'warn', 'fail', 'unknown']

/**
 * Read the reporter's answer out of the remote output. It needs exit 0, the sentinel line that proves the
 * command ran to its end, and a body of the expected shape. Anything else is `undefined`, never a pass.
 */
export function parseReporterDetail(result: RunResult): ReporterDetail | undefined {
  const body = readSentinelDocument(result, REPORTER_DETAIL_SENTINEL)
  if (
    body === undefined ||
    body.schemaVersion !== 1 ||
    typeof body.ran !== 'boolean' ||
    typeof body.stale !== 'boolean' ||
    typeof body.ok !== 'boolean' ||
    !(typeof body.at === 'string' || body.at === null)
  ) {
    return undefined
  }
  if (body.monitoringOk !== undefined && typeof body.monitoringOk !== 'boolean') return undefined
  const checks = readChecks(body.checks)
  if (checks === undefined) return undefined
  return {
    ran: body.ran,
    stale: body.stale,
    ok: body.ok,
    ...(body.monitoringOk === undefined ? {} : {monitoringOk: body.monitoringOk}),
    at: body.at,
    checks,
  }
}

/** The JSON object before the sentinel line, from a command that exited 0. Anything else is `undefined`. */
function readSentinelDocument(result: RunResult, sentinel: string): Record<string, unknown> | undefined {
  if (result.exitCode !== 0) return undefined
  const lines = result.stdout.split('\n')
  const end = lines.findIndex(line => line.trim() === sentinel)
  if (end === -1) return undefined
  let json: unknown
  try {
    json = JSON.parse(lines.slice(0, end).join('\n'))
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return undefined
  return json as Record<string, unknown>
}

function readChecks(value: unknown): ReporterCheck[] | undefined {
  if (!Array.isArray(value)) return undefined
  const checks: ReporterCheck[] = []
  for (const entry of value as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const check = entry as Record<string, unknown>
    if (typeof check.id !== 'string' || typeof check.detail !== 'string' || typeof check.status !== 'string') {
      return undefined
    }
    if (!CHECK_STATUSES.includes(check.status)) return undefined
    if (check.scope !== undefined && check.scope !== 'ingest' && check.scope !== 'monitoring') return undefined
    checks.push({
      id: check.id,
      status: check.status as ReporterCheck['status'],
      detail: check.detail,
      ...(check.scope === undefined ? {} : {scope: check.scope}),
    })
  }
  return checks
}

/** The three checks that prove a trace reached both backends and that the keep-list held. */
export const CANARY_CHECKS = ['canary-send', 'canary-langfuse', 'canary-tempo'] as const

/**
 * The deploy's one canary: the reporter script run once more inside its own container, in `--canary-once` mode (the
 * flag is pinned to `CANARY_ONCE_FLAG` in `health-report.ts` by a test). It prints the three canary checks and exits 0
 * whatever they say.
 *
 * It writes a trace into the stack, so it is a step that changes the host: it takes the step lock and checks the deploy
 * marker (`ownershipPrelude`), and holds the lock through the send and the readback, which is the whole `exec`. An
 * overtaken deploy prints `DEPLOY_OVERTAKEN` and runs nothing; a lock that is not free in time prints
 * `DEPLOY_STEP_BUSY`.
 */
export const CANARY_SENTINEL = 'TRACES_CANARY_END'
export function canaryScript(id: string): string {
  return guardedStep(
    'reporter-canary',
    id,
    `${COMPOSE} exec -T health-reporter bun run --no-install /app/health-report.ts --canary-once && echo && echo ${CANARY_SENTINEL}`,
  )
}

/** The canary checks, from a complete answer only (exit 0, the sentinel, a body of the expected shape). */
export function parseCanaryChecks(result: RunResult): ReporterCheck[] | undefined {
  const body = readSentinelDocument(result, CANARY_SENTINEL)
  if (body === undefined || body.schemaVersion !== 1) return undefined
  return readChecks(body.checks)
}

/** What the deploy knows about its canary: it was not run, it could not be read, or these are its checks. */
export type CanaryState = {state: 'skipped'} | {state: 'unreadable'} | {state: 'ran'; checks: ReporterCheck[]}

// ─── Gates ────────────────────────────────────────────────────────────────────

export type GateId =
  | 'langfuse-key'
  | 'ingest-variable'
  | 'retention'
  | 'token-directories'
  | 'reporter-verdict'
  | 'canary'
  | 'bootstrap-key'
  | 'bootstrap-variables'
  | 'grafana-signin'
  | 'grafana-alerting'
  | 'prometheus-ready'
  | 'grafana-ready'

export interface GateResult {
  id: GateId
  /** `skipped` is a gate that was not evaluated; it never counts as a pass. */
  status: 'pass' | 'fail' | 'skipped'
  detail: string
  /**
   * `config` gates say whether the operator has asked for ingest to be open yet (the key pair, the variable).
   * Failing one is an expected state, not a failure. `safety` gates are about the stack: failing one fails the deploy
   * and keeps the route closed. `operator` gates are about a surface the operator uses (Grafana, behind the SSH
   * tunnel) that has no bearing on whether traces can be received: failing one fails the run, but only after the
   * route is decided, and it never holds, closes or keeps closed the ingest route.
   */
  kind: 'config' | 'safety' | 'operator'
}

export type VerdictState =
  | {state: 'skipped'}
  | {state: 'unreadable'}
  | {state: 'timeout'; detail: ReporterDetail | undefined}
  | {state: 'fresh'; detail: ReporterDetail}

export type BootstrapProbe = 'dead' | 'live' | 'inconclusive' | 'none-on-record'

export interface GateInputs {
  keyPairSet: boolean
  ingestVariableTrue: boolean
  retentionDetail: string
  /** Per group: does its token file exist. */
  tokenFiles: Record<string, TokenFileState> | undefined
  verdict: VerdictState
  canary: CanaryState
  bootstrap: {
    /** The pair is still among the deploy's inputs. */
    supplied: boolean
    probe: BootstrapProbe
    hygiene: {envFile: number; running: number} | undefined
  }
}

function failingChecks(detail: ReporterDetail): string {
  // Only ingest checks: a failing monitoring check is not why this verdict fails.
  const lines = detail.checks
    .filter(check => check.scope !== 'monitoring')
    .filter(check => check.status === 'fail' || check.status === 'unknown')
    .map(check => `${check.id}: ${check.detail}`)
  if (!detail.ran) lines.push('the reporter has not finished a run')
  else if (detail.stale) lines.push('the last run is older than two intervals')
  return lines.length === 0 ? 'the verdict does not pass' : lines.join('; ')
}

/**
 * The one operator gate. Not part of `evaluateGates`: the route is decided from the route gates alone, and this runs
 * afterwards (`performDeploy`), so no outcome of the Grafana check can reach the route. Pure: pass is a 200 with the
 * password file's password. Because the deploy refuses a Grafana admin password shorter than 16 characters (so never
 * Grafana's default, `admin`), a 200 also means the account is not on its default password.
 */
export function evaluateGrafana(signIn: GrafanaSignIn): GateResult {
  const gate = (pass: boolean, detail: string): GateResult => ({
    id: 'grafana-signin',
    status: pass ? 'pass' : 'fail',
    detail,
    kind: 'operator',
  })
  if (signIn.code === '200') {
    return gate(true, 'Grafana signs in with the admin password file (HTTP 200)')
  }
  if (signIn.error !== undefined) {
    return gate(false, `the Grafana sign-in check could not be run: ${signIn.error}.`)
  }
  if (signIn.code === '000') {
    return gate(
      false,
      'Grafana did not answer on 127.0.0.1:3001 (no HTTP response, or the admin password file is missing on the host).',
    )
  }
  const hint =
    signIn.code === '401'
      ? ' Grafana reads the password file only when it can enter /run/secrets/grafana, and applies it only when it creates its database: see "Grafana sign-in check fails" in docs/runbooks/trace-collection.md.'
      : ''
  return gate(false, `the admin password file was not accepted (HTTP ${signIn.code}, expected 200).${hint}`)
}

/**
 * The second operator gate: Grafana has provisioned the Discord contact point and every rule group the files define.
 * Pure. It proves the files were read and accepted (Grafana refuses a file it cannot parse, and the contact point only
 * exists with a valid webhook address); it does not prove a message reaches Discord, because it sends none.
 */
export function evaluateGrafanaAlerting(probe: GrafanaAlerting): GateResult {
  const gate = (pass: boolean, detail: string): GateResult => ({
    id: 'grafana-alerting',
    status: pass ? 'pass' : 'fail',
    detail,
    kind: 'operator',
  })
  if ('error' in probe) return gate(false, `the Grafana alerting check failed: ${probe.error}.`)

  const refused = (what: string, code: string): GateResult | undefined =>
    code === '200'
      ? undefined
      : gate(
          false,
          code === '000'
            ? `Grafana did not answer for the ${what} (no HTTP response, or the admin password file is missing on the host).`
            : `Grafana refused the ${what} (HTTP ${code}, expected 200).`,
        )

  const contactRefused = refused('contact point list', probe.contactPoints.code)
  if (contactRefused !== undefined) return contactRefused
  let points: unknown
  try {
    points = JSON.parse(probe.contactPoints.body)
  } catch {
    return gate(false, 'the contact point list could not be read.')
  }
  if (!Array.isArray(points)) return gate(false, 'the contact point list could not be read.')
  const point = points.find(
    (entry: unknown): entry is {uid: string; type?: unknown} =>
      typeof entry === 'object' && entry !== null && 'uid' in entry && entry.uid === ALERT_CONTACT_POINT_UID,
  )
  if (point === undefined) {
    return gate(false, `the Discord contact point (uid ${ALERT_CONTACT_POINT_UID}) is not provisioned.`)
  }
  if (point.type !== 'discord') {
    return gate(
      false,
      `the contact point ${ALERT_CONTACT_POINT_UID} has type ${JSON.stringify(point.type)}, expected "discord".`,
    )
  }

  const rulesRefused = refused('alert rule list', probe.rules.code)
  if (rulesRefused !== undefined) return rulesRefused
  const short = ALERT_RULE_GROUPS.filter(group => (probe.rules.groups[group.name] ?? 0) !== group.rules).map(
    group => `${group.name} (${probe.rules.groups[group.name] ?? 0} of ${group.rules})`,
  )
  if (short.length > 0) return gate(false, `rule group missing or incomplete: ${short.join(', ')}.`)
  const total = ALERT_RULE_GROUPS.reduce((sum, group) => sum + group.rules, 0)
  return gate(
    true,
    `the Discord contact point and ${ALERT_RULE_GROUPS.length} rule groups (${total} rules) are provisioned`,
  )
}

/**
 * Evaluate every gate. Pure: the whole decision about what may be opened is a function of these inputs, so each
 * gate has a failing case in the tests. With no key pair the stack cannot deliver to Langfuse, so everything that
 * needs a delivering stack, and the bootstrap-key checks (which exist to be proven before opening), are skipped.
 */
export function evaluateGates(input: GateInputs): GateResult[] {
  const gates: GateResult[] = []
  const gate = (id: GateId, pass: boolean, detail: string, kind: GateResult['kind'] = 'safety'): void => {
    gates.push({id, status: pass ? 'pass' : 'fail', detail, kind})
  }
  const skipped = (id: GateId, detail: string): void => {
    gates.push({id, status: 'skipped', detail, kind: 'safety'})
  }

  gate(
    'langfuse-key',
    input.keyPairSet,
    input.keyPairSet
      ? 'the Langfuse key pair is set'
      : 'TRACES_LANGFUSE_PUBLIC_KEY and TRACES_LANGFUSE_SECRET_KEY are not set',
    'config',
  )
  gate(
    'ingest-variable',
    input.ingestVariableTrue,
    input.ingestVariableTrue ? 'TRACES_INGEST_OPEN is true' : 'TRACES_INGEST_OPEN is not exactly true',
    'config',
  )
  gate('retention', true, input.retentionDetail)

  // A token file must exist and must not be empty (the collector's watcher rejects an empty file). A file with no real
  // token is a legitimate deny-all state: the group refuses everything. Only real token lines are counted.
  const tokenProblems = SENDER_GROUPS.flatMap((group): string[] => {
    const state = input.tokenFiles?.[group]
    if (state === undefined || state === 'absent') return [`no token file for ${group}`]
    if (state === 'empty') {
      return [
        `the token file for ${group} is empty: the collector rejects an empty file, does not start watching it and keeps its previous tokens; repair it with \`traces sender revoke --all\` (deny-all for every group) and restart the collector`,
      ]
    }
    return []
  })
  gate(
    'token-directories',
    tokenProblems.length === 0,
    tokenProblems.length === 0
      ? `every sender group has a usable token file (real tokens: ${SENDER_GROUPS.map(group => `${group} ${input.tokenFiles?.[group]}`).join(', ')})`
      : tokenProblems.join('; '),
  )

  if (!input.keyPairSet) {
    const why = 'not evaluated: the Langfuse key pair is not set'
    skipped('reporter-verdict', why)
    skipped('canary', why)
    skipped('bootstrap-key', why)
    skipped('bootstrap-variables', why)
    return gates
  }

  switch (input.verdict.state) {
    case 'fresh': {
      const {detail} = input.verdict
      gate(
        'reporter-verdict',
        detail.ran && !detail.stale && detail.ok,
        detail.ran && !detail.stale && detail.ok ? 'the reporter verdict is fresh and passing' : failingChecks(detail),
      )
      const {canary} = input
      if (canary.state === 'ran') {
        const bad = CANARY_CHECKS.filter(id => canary.checks.find(check => check.id === id)?.status !== 'pass')
        gate(
          'canary',
          bad.length === 0,
          bad.length === 0
            ? 'the canary reached both backends and the keep-list held'
            : bad.map(id => `${id}: ${canary.checks.find(check => check.id === id)?.detail ?? 'missing'}`).join('; '),
        )
      } else {
        gate('canary', false, canary.state === 'unreadable' ? 'the canary could not be run' : 'the canary was not run')
      }
      break
    }
    case 'timeout': {
      const why = 'no fresh reporter verdict arrived in time'
      gate(
        'reporter-verdict',
        false,
        input.verdict.detail === undefined ? why : `${why}; ${failingChecks(input.verdict.detail)}`,
      )
      gate('canary', false, why)
      break
    }
    case 'unreadable': {
      const why = 'the reporter could not be read'
      gate('reporter-verdict', false, why)
      gate('canary', false, why)
      break
    }
    case 'skipped': {
      skipped('reporter-verdict', 'not evaluated')
      skipped('canary', 'not evaluated')
      break
    }
  }

  const {bootstrap} = input
  if (bootstrap.supplied) {
    gate(
      'bootstrap-key',
      false,
      'the bootstrap key pair is still supplied: delete the TRACES_LANGFUSE_BOOTSTRAP_* secrets and the key in Langfuse, then redeploy',
    )
  } else {
    switch (bootstrap.probe) {
      case 'dead': {
        gate('bootstrap-key', true, 'Langfuse refuses the bootstrap key (401)')
        break
      }
      case 'none-on-record': {
        gate('bootstrap-key', true, 'no bootstrap key is on record for this host')
        break
      }
      case 'live': {
        gate(
          'bootstrap-key',
          false,
          'Langfuse still accepts the bootstrap key: delete it in the Langfuse UI (Settings, API keys), then redeploy',
        )
        break
      }
      case 'inconclusive': {
        gate('bootstrap-key', false, 'the bootstrap key could not be proven dead (the request did not answer 401)')
        break
      }
    }
  }

  const {hygiene} = bootstrap
  if (hygiene === undefined) {
    gate('bootstrap-variables', false, 'the bootstrap variables could not be checked')
  } else {
    const clean = hygiene.envFile === 0 && hygiene.running === 0
    gate(
      'bootstrap-variables',
      clean,
      clean
        ? 'no bootstrap key variable on the host or in any running container'
        : `bootstrap key variables still present (host .env: ${hygiene.envFile}, running containers: ${hygiene.running})`,
    )
  }

  return gates
}

/**
 * Open only when nothing is missing: every gate that is about the route is a pass. A skipped gate is not a pass.
 * `operator` gates are left out on purpose: they decide whether the run fails, never whether traces are received.
 */
export function mayOpen(gates: readonly GateResult[]): boolean {
  const aboutTheRoute = gates.filter(gate => gate.kind !== 'operator')
  return aboutTheRoute.length > 0 && aboutTheRoute.every(gate => gate.status === 'pass')
}

export function failedSafetyGates(gates: readonly GateResult[]): GateResult[] {
  return gates.filter(gate => gate.kind === 'safety' && gate.status === 'fail')
}

/** The operator-surface gates that failed. The run fails for these after the route is set; the route is untouched. */
export function failedOperatorGates(gates: readonly GateResult[]): GateResult[] {
  return gates.filter(gate => gate.kind === 'operator' && gate.status === 'fail')
}

function describeGates(gates: readonly GateResult[]): string[] {
  return gates.map(
    gate => `${gate.status === 'pass' ? '✓' : gate.status === 'skipped' ? '-' : '✗'} ${gate.id}: ${gate.detail}`,
  )
}

// ─── SSH ──────────────────────────────────────────────────────────────────────

export interface SshTarget {
  host: string
  /** Private-key file for CI. Unset in local mode, where the agent carries the identity. */
  identityFile: string | undefined
  /** Socket every call shares, so one TCP and auth handshake serves the whole deploy. */
  controlPath: string
  /** The pinned host keys. In CI the workflow copies them to `~/.ssh/known_hosts`, so this is unset there. */
  knownHostsFile: string | undefined
}

const REMOTE_USER = 'root'

function baseSshArgs(target: SshTarget): string[] {
  return [
    ...(target.identityFile === undefined ? [] : ['-i', target.identityFile, '-o', 'IdentitiesOnly=yes']),
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'ServerAliveInterval=30',
    ...(target.knownHostsFile === undefined ? [] : ['-o', `UserKnownHostsFile=${target.knownHostsFile}`]),
    '-o',
    'ControlMaster=auto',
    '-o',
    `ControlPath=${target.controlPath}`,
    '-o',
    'ControlPersist=120s',
  ]
}

/** The ssh argv for one remote command. The host is validated; the command is a fixed script, never a secret. */
export function sshArgv(target: SshTarget, command: string): string[] {
  validateTracesHost(target.host)
  return ['ssh', ...baseSshArgs(target), `${REMOTE_USER}@${target.host}`, command]
}

/** Closes the shared connection. */
export function closeMasterArgv(target: SshTarget): string[] {
  validateTracesHost(target.host)
  return ['ssh', ...baseSshArgs(target), '-O', 'exit', `${REMOTE_USER}@${target.host}`]
}

export function createDeployExec(run: Runner, target: SshTarget): RemoteExec {
  return (command, stdin) =>
    stdin === undefined ? run(sshArgv(target, command)) : run(sshArgv(target, command), {stdin})
}

/**
 * The only environment an ssh child gets. The deploy's own environment holds every secret; none of it is passed
 * on. The key reaches ssh as a file (`-i`) and the agent through its socket.
 */
export function sshChildEnv(env: EnvLike): Record<string, string> {
  const child: Record<string, string> = {}
  for (const name of AMBIENT_ENV) {
    const value = env[name]
    if (value !== undefined && value !== '') child[name] = value
  }
  if (child.PATH === undefined) child.PATH = '/usr/bin:/bin'
  if (child.HOME === undefined) child.HOME = '/tmp'
  return child
}

export function createSpawnRunner(env: EnvLike): Runner {
  const childEnv = sshChildEnv(env)
  return async (argv, options) => {
    const proc = Bun.spawn([...argv], {
      env: childEnv,
      stdin: options?.stdin === undefined ? 'ignore' : new TextEncoder().encode(options.stdin),
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    return {exitCode, stdout, stderr}
  }
}

// ─── Orchestration ────────────────────────────────────────────────────────────

export interface Limits {
  /** Tries to prove a route state from inside the host while Caddy restarts. */
  proofAttempts: number
  proofIntervalMs: number
  /** Tries for Langfuse to finish creating its tables. */
  retentionAttempts: number
  retentionIntervalMs: number
  /** Tries for a reporter verdict newer than the restart. */
  verdictAttempts: number
  verdictIntervalMs: number
  /** Tries for Grafana to answer the sign-in check, after the route is final (a 2xx to 4xx answer is settled and is not retried). */
  grafanaAttempts: number
  grafanaIntervalMs: number
}

export const DEFAULT_LIMITS: Limits = {
  proofAttempts: 15,
  proofIntervalMs: 3000,
  retentionAttempts: 30,
  retentionIntervalMs: 10_000,
  verdictAttempts: 40,
  verdictIntervalMs: 5000,
  grafanaAttempts: 12,
  grafanaIntervalMs: 5000,
}

export interface DeployDeps {
  run: Runner
  /** Resolves a name to its addresses; throws when it does not resolve. */
  resolve: (host: string) => Promise<string[]>
  /** Reads a file of `apps/traces` by its path relative to that directory. */
  readFile: (relative: string) => Promise<string>
  materializeIdentity: (privateKey: string) => MaterializedIdentity
  makeTempDir: () => {path: string; cleanup: () => void}
  knownHostsFile: string | undefined
  sleep: (ms: number) => Promise<void>
  log: (message: string) => void
  limits: Limits
  /** A fresh void token line for each token file created. Never logged or kept. */
  voidTokenLine: () => string
  /** This deploy's id, written into the marker: 16 or more random bytes as hex. Injectable so a test can fix it. */
  deployId: () => string
}

const APP_ROOT = resolve(import.meta.dir, '..')

export function defaultDeps(env: EnvLike): DeployDeps {
  const knownHosts = resolve(APP_ROOT, '..', '..', '.github', 'known_hosts')
  return {
    run: createSpawnRunner(env),
    resolve: async host => {
      const answers = await Bun.dns.lookup(host)
      if (answers.length === 0) throw new Error(`DNS resolution returned no results for ${host}`)
      return answers.map(answer => answer.address)
    },
    readFile: relative => Bun.file(resolve(APP_ROOT, relative)).text(),
    materializeIdentity: materializeIdentityFile,
    makeTempDir: () => {
      const path = mkdtempSync(join(tmpdir(), 'traces-deploy-'))
      return {path, cleanup: () => rmSync(path, {recursive: true, force: true})}
    },
    knownHostsFile: existsSync(knownHosts) ? knownHosts : undefined,
    sleep: ms => new Promise(done => setTimeout(done, ms)),
    log: message => console.warn(message),
    limits: DEFAULT_LIMITS,
    voidTokenLine: () => generateVoidTokenLine(),
    deployId: () => generateDeployId(),
  }
}

/**
 * The deploy completed and left the route where its other gates put it, and an operator surface (Grafana) failed its
 * check. Unlike every other failure it is thrown outside the failure handler: it does not hold, close or probe the
 * route, because Grafana has nothing to do with receiving traces. `ingest` is where the route is; `result` is what
 * the deploy would have returned, gates included.
 */
export class OperatorSurfaceError extends Error {
  readonly ingest: IngestState
  readonly result: DeployResult
  constructor(result: DeployResult, failed: readonly GateResult[]) {
    super(
      `The stack was deployed, but an operator-surface check failed. ${failed.map(gate => `${gate.id}: ${gate.detail}`).join(' ')} Ingest is ${result.ingest}: this failure did not change the route, which the other gates decided. Fix the cause and deploy again.`,
    )
    this.name = 'OperatorSurfaceError'
    this.ingest = result.ingest
    this.result = result
  }
}

export interface DeployResult {
  /** The route state the deploy left. */
  ingest: IngestState
  gates: GateResult[]
  /** Gates that were not met, in order, as `id: detail`. Empty when the route is open. */
  unmet: string[]
  retention: RetentionReport
  /** Services recreated or restarted by changed files; empty when nothing changed. */
  changed: Touch[]
  /** Gated services that were not running what the files say when the deploy began (an open route is held for these). */
  drifted: Service[]
  heldForUpdate: boolean
}

/**
 * A failure after the first `compose up`: the host is partly or wholly updated and the update has not been
 * verified. `ingest` says where the public route was left. Run the deploy again, or `traces status`.
 */
export class AppliedButUnverifiedError extends Error {
  readonly ingest: 'held' | 'off' | 'unknown'
  constructor(cause: string, ingest: 'held' | 'off' | 'unknown') {
    const where =
      ingest === 'held'
        ? 'Ingest is held (every ingest path answers 503, which senders retry); if the route was open, holding it rewrote the ingest state and restarted Caddy.'
        : ingest === 'off'
          ? 'Ingest is off (no ingest route).'
          : 'Ingest may be open: the deploy could not confirm the route closed. Run `traces ingest hold` now.'
    super(
      `Applied but unverified: the host was updated and the update did not verify. ${cause}. ${where} Fix the cause and deploy again; only a deploy that passes every gate reopens ingest.`,
    )
    this.name = 'AppliedButUnverifiedError'
    this.ingest = ingest
  }
}

/**
 * The files could not be compared with the host, so nothing on it was changed: the failure came after the deploy took
 * its marker and before its first write. `ingest` says where the route was left. The marker stays, so the next deploy
 * holds an open route before it changes anything. Unlike `AppliedButUnverifiedError` it never says the host was updated.
 */
export class FilesNotComparedError extends Error {
  readonly ingest: 'held' | 'off' | 'unknown'
  constructor(cause: string, ingest: 'held' | 'off' | 'unknown') {
    const where =
      ingest === 'held'
        ? 'Ingest is held (every ingest path answers 503, which senders retry); if the route was open, holding it rewrote the ingest state and restarted Caddy.'
        : ingest === 'off'
          ? 'Ingest is off (no ingest route).'
          : 'Ingest may be open: the deploy could not confirm the route closed. Run `traces ingest hold` now.'
    super(
      `The files could not be compared with the host: ${cause}. The update was not applied: no file of the stack was written and no service was updated. ${where} The deploy marker stays, so the next deploy holds an open route before it changes anything. Deploy again once the host answers.`,
    )
    this.name = 'FilesNotComparedError'
    this.ingest = ingest
  }
}

/**
 * Another deploy started on this host after this one and took it over (it wrote its own id into the marker). This
 * deploy stopped at its next step. It is the one failure that leaves the route and the marker alone: the host now
 * belongs to the newer deploy, and a hold, an open or a marker removal from here could undo what that deploy did.
 * The takeover waited for any step of this deploy that was in flight (the step lock), so nothing of this deploy was
 * running when the newer deploy took the host.
 */
export class DeployOvertakenError extends Error {
  constructor(options: {opened?: boolean; failure?: string} = {}) {
    const stopped =
      options.opened === true
        ? 'this one stopped after it had opened ingest'
        : 'this one stopped without opening ingest'
    super(
      `Another deploy started on this host and took over; ${stopped}. It left the ingest route and the deploy marker to the newer deploy${options.opened === true ? ', whose gates decide whether the route stays open' : ''}.${options.failure === undefined ? '' : ` Before that this deploy had failed: ${options.failure}.`}`,
    )
    this.name = 'DeployOvertakenError'
  }
}

/**
 * A script could not take the step lock in time, so it changed nothing. For the takeover (this deploy does not own
 * the host yet) it means another deploy's step is still running after the whole wait; for an ordinary step it means a
 * newer deploy is taking the host over right now.
 */
export class DeployStepBusyError extends Error {
  constructor(options: {takeover: boolean}) {
    super(
      options.takeover
        ? `Another deploy's step is still running on this host: this deploy waited ${TAKEOVER_LOCK_WAIT_SECONDS / 60} minutes for it and did not take the host. Nothing was changed. Retry when that deploy finishes.`
        : `A step could not start: the deploy step lock stayed busy for ${STEP_LOCK_WAIT_SECONDS} seconds, because another deploy is taking over the host. The step changed nothing.`,
    )
    this.name = 'DeployStepBusyError'
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Resolves the preflight DNS check: the name must resolve, and to this host when the host is an IPv4 address. */
export async function preflightDns(domain: string, host: string, resolveHost: DeployDeps['resolve']): Promise<void> {
  let addresses: string[]
  try {
    addresses = await resolveHost(domain)
  } catch (error) {
    throw new Error(`DNS preflight failed for ${domain}: ${errorMessage(error)}`)
  }
  if (addresses.length === 0) throw new Error(`DNS preflight failed for ${domain}: no addresses`)
  const isIpv4 = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)
  if (isIpv4 && addresses.some(address => /^\d{1,3}(?:\.\d{1,3}){3}$/.test(address)) && !addresses.includes(host)) {
    throw new Error(
      `DNS preflight failed: ${domain} does not resolve to the deploy host. Point its A record at the droplet before deploying, or Caddy cannot get a certificate.`,
    )
  }
}

function digestOf(image: string): string {
  const at = image.indexOf('@')
  return at === -1 ? '' : image.slice(at + 1)
}

async function setIngestState(exec: RemoteExec, state: IngestState, id: string): Promise<void> {
  const result = await exec(setIngestStateCommand(state, id), INGEST_STATE_STDIN(state))
  if (lastLine(result) === TRACES_LOCK_BUSY_SENTINEL) {
    throw new Error(
      `Could not set the ingest state to ${state}: the ingest lock was busy for 30 seconds (another ingest change is in progress)`,
    )
  }
  if (result.exitCode !== 0 || lastLine(result) !== `TRACES_INGEST_STATE_SET=${state}`) {
    throw new Error(
      `Could not set the ingest state to ${state} on the host (exit ${result.exitCode}): ${clip(result.stderr) || 'no confirmation'}`,
    )
  }
}

/** Retries from inside the host until Caddy answers every ingest path as `state` does, or the attempts run out. */
async function proveState(
  exec: RemoteExec,
  deps: DeployDeps,
  domain: string,
  state: IngestState,
  attempts: number = deps.limits.proofAttempts,
): Promise<{proven: boolean; statuses: Record<string, PathStatus>}> {
  let statuses: Record<string, PathStatus> = {}
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = await exec(bashCommand(probeIngestScript(domain)))
    if (result.exitCode === 0 && lastLine(result) === INGEST_PROBE_SENTINEL) {
      statuses = parseIngestProbe(result.stdout)
      if (provesState(statuses, state)) return {proven: true, statuses}
    }
    if (attempt < attempts) await deps.sleep(deps.limits.proofIntervalMs)
  }
  return {proven: false, statuses}
}

function describeStatuses(statuses: Record<string, PathStatus>): string {
  const parts = SENDER_GROUPS.map(group => `${group} ${statuses[group] ?? 'no answer'}`)
  return parts.join(', ')
}

async function awaitFreshVerdict(exec: RemoteExec, deps: DeployDeps, sinceEpoch: number): Promise<VerdictState> {
  let last: ReporterDetail | undefined
  let everReadable = false
  for (let attempt = 1; attempt <= deps.limits.verdictAttempts; attempt += 1) {
    const detail = parseReporterDetail(await exec(REPORTER_DETAIL_COMMAND))
    if (detail !== undefined) {
      everReadable = true
      last = detail
      // The verdict must have been produced after the restart: an older one says nothing about this deploy.
      if (detail.ran && detail.at !== null && Date.parse(detail.at) / 1000 >= sinceEpoch) {
        return {state: 'fresh', detail}
      }
    }
    if (attempt < deps.limits.verdictAttempts) await deps.sleep(deps.limits.verdictIntervalMs)
  }
  return everReadable ? {state: 'timeout', detail: last} : {state: 'unreadable'}
}

/**
 * Asks the host for Grafana's sign-in answer until it is settled (an HTTP status from 200 to 499: Grafana is up and
 * has decided) or the attempts run out. A `000` or a 5xx is Grafana not up yet. A settled answer is not retried, which
 * also keeps a wrong password from being tried over and over against Grafana's login lockout. An answer that cannot
 * be read counts as no answer. A rejected execution (the runner threw) is kept, and if it is how the last attempt
 * ended it is the reason reported. This never throws: it runs after the route is final and is not allowed to fail
 * the deploy any other way than the operator-surface error.
 */
async function awaitGrafanaSignIn(exec: RemoteExec, deps: DeployDeps): Promise<GrafanaSignIn> {
  const settled = /^[2-4]\d\d$/
  let last: GrafanaSignIn = {code: '000'}
  for (let attempt = 1; attempt <= deps.limits.grafanaAttempts; attempt += 1) {
    try {
      const result = await exec(bashCommand(grafanaSignInScript()))
      last = {code: (result.exitCode === 0 ? parseGrafanaProbe(result.stdout) : undefined) ?? '000'}
    } catch (error) {
      last = {code: '000', error: clip(errorMessage(error))}
    }
    if (settled.test(last.code)) return last
    if (attempt < deps.limits.grafanaAttempts) await deps.sleep(deps.limits.grafanaIntervalMs)
  }
  return last
}

/**
 * One read of Grafana's provisioned alerting. Grafana has already answered the sign-in check, so there is no wait and
 * no retry: a refusal here is a real one, and a second try would only spend another request on the admin account. An
 * answer that cannot be read, or a rejected execution, is a failed check and never a pass. This never throws.
 */
async function awaitGrafanaAlerting(exec: RemoteExec): Promise<GrafanaAlerting> {
  try {
    const result = await exec(bashCommand(grafanaAlertingScript()))
    const parsed = result.exitCode === 0 ? parseGrafanaAlerting(result.stdout) : undefined
    return parsed ?? {error: 'its answer could not be read'}
  } catch (error) {
    return {error: clip(errorMessage(error))}
  }
}

async function runCanaryOnce(exec: RemoteExec, deployId: string): Promise<CanaryState> {
  const checks = parseCanaryChecks(await exec(bashCommand(canaryScript(deployId))))
  return checks === undefined ? {state: 'unreadable'} : {state: 'ran', checks}
}

function parseEpoch(result: RunResult): number {
  const epoch = Number(/^epoch=(\d+)$/m.exec(result.stdout)?.[1])
  if (!Number.isInteger(epoch) || epoch <= 0) throw new Error('The host did not report its clock')
  return epoch
}

function pairToStdin(pair: KeyPair): string {
  return `${pair.publicKey}:${pair.secretKey}`
}

/**
 * The deploy proper, over an `exec` that already speaks to the host. Exported for tests; `deploy` is the entry
 * point that builds the ssh transport.
 *
 * `runDeploy` decides and verifies the route from the route gates alone, removes the marker and returns. Only then are
 * Grafana's sign-in and its provisioned alerting checked, over the bare `rawExec` and outside `runDeploy`'s failure handler (which would close the
 * route). No outcome of that check (a pass, a refusal, a timeout, a rejected execution, malformed output) can reach
 * the route: it is read-only, it comes after the route is final, and a failure becomes `OperatorSurfaceError`, which
 * fails the run. A deploy that already failed never gets here.
 */
export async function performDeploy(
  inputs: DeployInputs,
  rawExec: RemoteExec,
  deps: DeployDeps,
): Promise<DeployResult> {
  const routed = await runDeploy(inputs, rawExec, deps)
  // Both Grafana checks need Grafana. When it did not start (`grafana-ready` is the failure) they are not run: the
  // sign-in check would spend its whole retry window on a service that is not there.
  const grafanaDown = routed.gates.some(gate => gate.id === 'grafana-ready' && gate.status !== 'pass')
  const notRun = (id: 'grafana-signin' | 'grafana-alerting', why: string): GateResult => ({
    id,
    status: 'skipped',
    detail: `not run: ${why}`,
    kind: 'operator',
  })
  const grafana = grafanaDown
    ? notRun('grafana-signin', 'Grafana did not start (see grafana-ready)')
    : evaluateGrafana(await awaitGrafanaSignIn(rawExec, deps))
  // The alerting check signs in again. After a refused password it is not run: that would be one more failed login.
  const alerting: GateResult =
    grafana.status === 'pass'
      ? evaluateGrafanaAlerting(await awaitGrafanaAlerting(rawExec))
      : notRun(
          'grafana-alerting',
          grafanaDown ? 'Grafana did not start (see grafana-ready)' : 'the sign-in check did not pass',
        )
  for (const line of describeGates([grafana, alerting])) deps.log(`  ${line}`)
  const result: DeployResult = {...routed, gates: [...routed.gates, grafana, alerting]}
  const failed = failedOperatorGates(result.gates)
  if (failed.length > 0) throw new OperatorSurfaceError(result, failed)
  return result
}

async function runDeploy(inputs: DeployInputs, rawExec: RemoteExec, deps: DeployDeps): Promise<DeployResult> {
  const {log} = deps
  const deployId = assertDeployId(deps.deployId())

  // Whether another deploy took the host over, and whether this one's last route change left it open. An object, not
  // bare variables: both are set from inside `exec` and read in the catch below.
  const ownership = {overtaken: false, opened: false, taken: false}
  /**
   * Every remote command goes through here. A script that was refused because this deploy no longer owns the marker
   * exits non-zero and prints the sentinel; that becomes `DeployOvertakenError` wherever it happened, and the flag
   * survives any `catch` between here and the handler at the bottom that wraps or swallows the error.
   */
  const exec: RemoteExec = async (command, stdin) => {
    const result = await rawExec(command, stdin)
    if (result.exitCode !== 0 && result.stdout.split('\n').some(line => line.trim() === DEPLOY_OVERTAKEN_SENTINEL)) {
      ownership.overtaken = true
      throw new DeployOvertakenError({opened: ownership.opened})
    }
    // The step lock was not free in time: nothing ran. Before the takeover this deploy does not own the host yet.
    if (result.exitCode !== 0 && result.stdout.split('\n').some(line => line.trim() === DEPLOY_STEP_BUSY_SENTINEL)) {
      throw new DeployStepBusyError({takeover: !ownership.taken})
    }
    return result
  }
  const sh = <T extends string>(
    label: string,
    script: string,
    accepted: readonly T[],
    stdin?: string,
  ): Promise<StepOutcome<T>> => runStep(exec, label, script, accepted, stdin)

  // 3. The volume, the sentinel and the storage paths. Nothing is written before this passes.
  log('==> Checking the volume and storage paths')
  await checkTracesStorage(exec)

  // 4. What the host says about itself.
  log(
    `==> Reading the host state and taking the deploy marker (waits for another deploy's running step; under the ingest lock; deploy ${deployId.slice(0, 8)})`,
  )
  const host = parseHostState(
    (await sh('Read host state', beginDeployScript(deployId), [HOST_STATE_SENTINEL])).result.stdout,
  )
  // The marker is this deploy's: it owns the host, and no other deploy's step is running.
  ownership.taken = true

  // The route as this deploy believes it to be. It is only ever a plan: after a failure the host is asked.
  let route: IngestState | 'none' = host.ingest
  let heldForUpdate = false

  const setState = async (state: IngestState): Promise<void> => {
    // An open that was attempted counts as open from before the remote call: a lost reply says nothing about the host.
    if (state === 'open') route = 'open'
    await setIngestState(exec, state, deployId)
    route = state
    ownership.opened = state === 'open'
  }
  const prove = (state: IngestState): ReturnType<typeof proveState> => proveState(exec, deps, inputs.domain, state)

  /**
   * After a failure: make sure the route is closed, from what the host says and not from what this deploy last
   * wrote (a reply can be lost after the host acted, and another operator can open the route meanwhile). Off or
   * held is accepted only when the host's `.env` says so and Caddy answers every path as that state does; a host
   * with no `.env` runs nothing. Anything else is held and proven 503. `unknown` means that could not be done.
   */
  const secureRoute = async (): Promise<'held' | 'off' | 'unknown'> => {
    try {
      const read = await exec(bashCommand(readIngestStateScript()))
      if (read.exitCode === 0 && lastLine(read) === INGEST_STATE_READ_SENTINEL) {
        const state = /^ingest=(off|held|open|none)$/m.exec(read.stdout)?.[1]
        if (state === 'none') return 'off'
        if ((state === 'off' || state === 'held') && (await proveState(exec, deps, inputs.domain, state, 1)).proven)
          return state
      }
    } catch {
      // Not read: treated as not confirmed.
    }
    try {
      await setState('held')
      return (await prove('held')).proven ? 'held' : 'unknown'
    } catch {
      return 'unknown'
    }
  }

  /**
   * One monitoring service: pulled, then started, as an operator gate. Its failure (a registry that does not answer, a
   * digest that is not there, a start that does not come up healthy, a volume that cannot be handed over) is a result
   * and not an exception: it must not reach the failure handler below, which would hold the route. Every step is
   * guarded like any other change to the host, and a refusal (another deploy owns the host, or its step is running)
   * is the one thing rethrown, since it ends this deploy. The service is recreated on every deploy, as the reporter
   * is, so a changed file of its own (`prometheus.yml`, a Grafana provisioning file) is applied here, and a start that
   * failed last time is retried even though the files then match the host's: no pending-restart record is needed.
   */
  const startMonitoringService = async (
    id: 'prometheus-ready' | 'grafana-ready',
    label: string,
    run: () => Promise<unknown>,
  ): Promise<GateResult> => {
    const gate = (pass: boolean, detail: string): GateResult => ({
      id,
      status: pass ? 'pass' : 'fail',
      detail,
      kind: 'operator',
    })
    try {
      await run()
      return gate(true, `${label} was pulled, started and reports healthy`)
    } catch (error) {
      if (ownership.overtaken || error instanceof DeployStepBusyError) throw error
      return gate(false, `${label} did not start (${clip(errorMessage(error))}). Ingest is not affected.`)
    }
  }

  /**
   * Prometheus and Grafana, after the route is decided and proven. Nothing here is in the route-critical pull or start.
   * The two are independent: one failing does not stop the other. Prometheus goes first, because Grafana's alert rules
   * read it.
   */
  const startMonitoring = async (): Promise<GateResult[]> => {
    log(
      '==> Pulling and starting Prometheus and Grafana (after the route is decided; a failure here fails the run and never touches the route)',
    )
    const prometheus = await startMonitoringService('prometheus-ready', 'Prometheus', async () => {
      await sh('Pull the Prometheus image', pullScript(deployId, 'pull-prometheus', ['prometheus']), [
        STEP_SENTINEL('pull-prometheus'),
      ])
      await sh('Create the Prometheus container', createPrometheusScript(deployId), [
        STEP_SENTINEL('create-prometheus'),
      ])
      await sh('Prepare the Prometheus data volume', prometheusVolumeScript(deployId), [PROMETHEUS_VOLUME_SENTINEL])
      await sh('Start Prometheus', upScript(deployId, 'up-prometheus', ['prometheus'], {force: true}), [
        STEP_SENTINEL('up-prometheus'),
      ])
    })
    const grafana = await startMonitoringService('grafana-ready', 'Grafana', async () => {
      await sh('Pull the Grafana image', pullScript(deployId, 'pull-grafana', ['grafana']), [
        STEP_SENTINEL('pull-grafana'),
      ])
      await sh('Start Grafana', upScript(deployId, 'up-grafana', ['grafana'], {force: true}), [
        STEP_SENTINEL('up-grafana'),
      ])
    })
    return [prometheus, grafana]
  }

  /** The very last step of a deploy that evaluated every gate and left the route in its final state. */
  const finish = async (result: DeployResult): Promise<DeployResult> => {
    const monitoring = await startMonitoring()
    for (const line of describeGates(monitoring)) log(`  ${line}`)
    // Compare-and-delete under the ingest lock: only the deploy that owns the marker removes it.
    await sh('Remove the deploy marker', removeOwnFileScript(deployId, MARKER_FILE), [REMOVED_SENTINEL])
    return {...result, gates: [...result.gates, ...monitoring]}
  }

  // `compare`: nothing on the host has changed yet. `stage`: files and the route may have. `apply`: the stack has.
  let phase: 'compare' | 'stage' | 'apply' = 'compare'
  try {
    // 5. Compare every file, so the decision to hold is made before anything changes. This runs after the marker was
    // taken and so under the failure handler below: a comparison that cannot be trusted (a lost reply, a host whose
    // `stat` fails) closes the route like any other failure, instead of leaving an open route open and unreported.
    log('==> Comparing files with the host')
    const files: RemoteFile[] = [
      ...(await loadUploadedFiles(deps.readFile)),
      ...buildSecretFiles(inputs),
      buildEnvManagedFile(inputs),
    ]
    const comparisons: {file: RemoteFile; status: (typeof FILE_COMPARE_SENTINELS)[number]}[] = []
    for (const file of files) {
      const {sentinel} = await sh(
        `Compare ${file.path}`,
        compareFileScript(file.path, file.kind, file),
        FILE_COMPARE_SENTINELS,
        file.content,
      )
      comparisons.push({file, status: sentinel})
    }

    const restarts = new Set<Touch>(host.pendingRestarts)
    for (const {file, status} of comparisons) {
      if (status !== 'TRACES_FILE_SAME') for (const touch of file.touches) restarts.add(touch)
    }
    const changed = [...restarts]
    const gatedChange = changed.some(
      touch => touch === 'compose' || (GATED_SERVICES as readonly Touch[]).includes(touch),
    )

    // Is what runs what the files say? Asked only on an open route whose files are all unchanged: then "the files on
    // disk" are also what a `compose up` below would read, and a hash that differs, or a service that is not running,
    // is a change `up` would make with senders connected. A probe that cannot be trusted counts as drift.
    let drifted: Service[] = []
    let driftUnverified = false
    if (host.ingest === 'open' && host.hasEnv && !gatedChange && !host.marker) {
      try {
        const answer = await sh('Compare the running services with the files', driftScript(), [DRIFT_SENTINEL])
        const parsed = parseDrift(answer.result.stdout)
        if (parsed === undefined) driftUnverified = true
        else drifted = parsed
      } catch {
        driftUnverified = true
      }
    }

    const holdReasons: string[] = []
    if (gatedChange) holdReasons.push('a gated service is about to change')
    if (host.marker) holdReasons.push('a previous deploy did not finish')
    if (drifted.length > 0) holdReasons.push(`${drifted.join(', ')} not running what the files say`)
    if (driftUnverified) holdReasons.push('the running services could not be compared with the files')
    phase = 'stage'

    // A gated change on an open route: hold first, and prove it before anything else happens.
    if (route === 'open' && holdReasons.length > 0) {
      log(`==> Holding the ingest route before the update (${holdReasons.join('; ')})`)
      try {
        await setState('held')
        const proof = await prove('held')
        if (!proof.proven) {
          throw new Error(`the route did not answer 503 on every ingest path (${describeStatuses(proof.statuses)})`)
        }
      } catch (error) {
        throw new Error(`Could not hold the ingest route before the update: ${errorMessage(error)}`)
      }
      heldForUpdate = true
    }

    const planned: IngestState = route === 'none' ? 'off' : route

    // 6. Directories, empty token files (only when absent), restart record, secret files, configs.
    log('==> Preparing directories and token files')
    await sh('Prepare directories', prepareDirsScript(deployId), [DIRS_SENTINEL])
    for (const group of SENDER_GROUPS) {
      const {sentinel} = await sh(
        `Token file for ${group}`,
        tokenFileScript(group, deployId),
        TOKEN_SENTINELS,
        `${deps.voidTokenLine()}\n`,
      )
      if (sentinel === 'TRACES_TOKEN_CREATED') log(`  created a deny-all token file for ${group}`)
    }

    // A bootstrap pair that is not among the inputs but is on the host (in the `.env` about to be replaced) is set
    // aside until Langfuse is proven to refuse it. `.env` is rewritten without it, so this is its only copy.
    const recorded = inputs.bootstrapKey === undefined ? (host.envBootstrap ?? host.pendingBootstrap) : undefined
    if (recorded !== undefined && host.pendingBootstrap === undefined) {
      await sh(
        'Set the bootstrap pair aside',
        writeFileScript(deployId, {
          path: 'secrets/bootstrap-pending',
          owner: 'root:root',
          mode: '0400',
          kind: 'plain',
        }),
        [FILE_WRITTEN_SENTINEL],
        pairToStdin(recorded),
      )
    }

    // Written before any file changes: a deploy that fails after this leaves a record the next one acts on.
    if (changed.length > 0) {
      await sh(
        'Record the pending restarts',
        writeFileScript(deployId, {path: PENDING_RESTARTS_FILE, owner: 'root:root', mode: '0600', kind: 'plain'}),
        [FILE_WRITTEN_SENTINEL],
        `${changed.join('\n')}\n`,
      )
    }

    log('==> Writing files')
    const ordered = [
      ...comparisons.filter(entry => entry.file.kind !== 'env'),
      ...comparisons.filter(entry => entry.file.kind === 'env'),
    ]
    for (const {file, status} of ordered) {
      if (status === 'TRACES_FILE_SAME') continue
      const written = await sh(
        `Write ${file.path}`,
        writeFileScript(deployId, file, file.kind === 'env' ? planned : undefined),
        [FILE_WRITTEN_SENTINEL],
        file.content,
      )
      if (file.kind === 'env') {
        // The script keeps a hold or off that is on the host: what it wrote is what the host has.
        const onHost = /^TRACES_ENV_STATE=(off|held|open)$/m.exec(written.result.stdout)?.[1] as IngestState | undefined
        if (onHost !== undefined && onHost !== planned) {
          log(`  the host's ingest state is ${onHost}, not ${planned}: keeping ${onHost}`)
          route = onHost
        }
      }
    }

    // 7. Reclaim disk, check there is room, pull.
    log('==> Pruning unused images, checking free space, pulling images')
    try {
      await sh('Prune unused images', pruneScript(deployId), [STEP_SENTINEL('prune-images')])
    } catch (error) {
      // A failed prune is tolerated; being overtaken is not.
      if (ownership.overtaken) throw error
      log(`  image prune failed (continuing): ${errorMessage(error)}`)
    }
    const disk = await sh('Check free space', diskScript(), [DISK_SENTINEL])
    const free = Number(/^free_bytes=(\d+)$/m.exec(disk.result.stdout)?.[1])
    if (!Number.isFinite(free)) throw new Error('The host did not report its free space')
    if (free < MIN_FREE_BYTES) {
      throw new Error(
        `Only ${(free / 1024 ** 3).toFixed(1)} GiB are free on the volume; at least ${(MIN_FREE_BYTES / 1024 ** 3).toFixed(0)} GiB are needed to pull images`,
      )
    }
    await sh('Pull images', pullScript(deployId), [STEP_SENTINEL('pull')])

    // 8. From here on a failure leaves a partly updated host.
    phase = 'apply'
    const stale = (services: readonly Service[]): Service[] =>
      host.hasEnv ? services.filter(service => restarts.has(service)) : []

    log('==> Starting the collector container and its queue volume')
    await sh('Create the collector container', createCollectorScript(deployId), [STEP_SENTINEL('create-collector')])
    await sh('Prepare the collector queue volume', queueVolumeScript(deployId), [QUEUE_SENTINEL])

    const privateServices: Service[] = ['postgres', 'redis', 'minio', 'clickhouse', 'langfuse-web', 'langfuse-worker']
    log('==> Starting the stores and Langfuse')
    const staleStores = stale(privateServices)
    if (staleStores.length > 0) {
      await sh('Recreate changed stores', upScript(deployId, 'up-stale-private', staleStores, {force: true}), [
        STEP_SENTINEL('up-stale-private'),
      ])
    }
    await sh('Start the stores and Langfuse', upScript(deployId, 'up-private', privateServices), [
      STEP_SENTINEL('up-private'),
    ])

    log('==> Asserting retention')
    let retention: RetentionReport | undefined
    for (let attempt = 1; retention === undefined; attempt += 1) {
      const outcome = await assertRetention(exec, ownershipPrelude(deployId))
      if (outcome.status === 'ready') {
        retention = outcome.report
      } else if (attempt >= deps.limits.retentionAttempts) {
        throw new Error(
          `Langfuse has not created ${outcome.missing.join(', ')} after ${attempt} checks (its migrations did not finish)`,
        )
      } else {
        await deps.sleep(deps.limits.retentionIntervalMs)
      }
    }

    log('==> Starting Tempo, the collector and the reporter')
    const publicServices: Service[] = ['tempo', 'collector']
    const staleOthers = stale(publicServices)
    if (staleOthers.length > 0) {
      await sh('Recreate changed services', upScript(deployId, 'up-stale-public', staleOthers, {force: true}), [
        STEP_SENTINEL('up-stale-public'),
      ])
    }
    await sh('Start Tempo and the collector', upScript(deployId, 'up-public', publicServices), [
      STEP_SENTINEL('up-public'),
    ])

    // The reporter is always recreated last: its first run starts at once, so the verdict it produces is newer
    // than every change above, and the gates below never read a verdict from before the update.
    const restarted = await sh(
      'Restart the health reporter',
      upScript(deployId, 'up-reporter', ['health-reporter'], {force: true}),
      [STEP_SENTINEL('up-reporter')],
    )
    const sinceEpoch = parseEpoch(restarted.result)

    log('==> Verifying the collector image')
    const digest = await sh('Read the running collector image', runningDigestScript('collector'), [DIGEST_SENTINEL])
    const expectedDigest = digestOf(inputs.collectorImage)
    const reported = /^repo_digests=(.*)$/m.exec(digest.result.stdout)?.[1] ?? ''
    if (!reported.includes(expectedDigest)) {
      throw new Error(
        `The running collector image does not match the built digest (expected ${expectedDigest}; host reports ${reported || 'none'})`,
      )
    }

    log('==> Starting Caddy')
    const caddyStale = host.hasEnv && restarts.has('caddy')
    await sh('Start Caddy', upScript(deployId, 'up-caddy', ['caddy'], caddyStale ? {force: true} : {}), [
      STEP_SENTINEL('up-caddy'),
    ])

    // Every restart this deploy owed has happened, Caddy's included.
    if (changed.length > 0 || host.pendingRestarts.length > 0) {
      await sh('Clear the pending restarts', removeOwnFileScript(deployId, PENDING_RESTARTS_FILE), [REMOVED_SENTINEL])
    }

    // 9. Gates.
    log('==> Running the gates')
    const tokens = await sh('Check token files', tokenDirsScript(), [TOKEN_DIRS_SENTINEL])
    const tokenFiles = parseTokenFiles(tokens.result.stdout)

    const keyPairSet = inputs.langfuseKey !== undefined
    let verdict: VerdictState = {state: 'skipped'}
    let canary: CanaryState = {state: 'skipped'}
    let probe: BootstrapProbe = 'none-on-record'
    let hygiene: {envFile: number; running: number} | undefined
    if (keyPairSet) {
      verdict = await awaitFreshVerdict(exec, deps, sinceEpoch)
      if (verdict.state === 'fresh') {
        // The one canary of this deploy, sent only now that the reporter's own checks are fresh. The periodic verdict
        // sends none.
        log('==> Running the canary')
        canary = await runCanaryOnce(exec, deployId)
      }

      const pair = inputs.bootstrapKey ?? host.envBootstrap ?? host.pendingBootstrap
      if (pair !== undefined) {
        const answer = await sh(
          'Probe the bootstrap key',
          bootstrapProbeScript(),
          [BOOTSTRAP_PROBE_SENTINEL],
          `${Buffer.from(pairToStdin(pair), 'utf8').toString('base64')}\n`,
        )
        const code = /^TRACES_BOOTSTRAP_HTTP=(\d{3})$/m.exec(answer.result.stdout)?.[1]
        probe = code === '401' ? 'dead' : code === '200' ? 'live' : 'inconclusive'
        // The record is dropped only once the key is proven dead, and only when it is not still being supplied.
        if (probe === 'dead' && inputs.bootstrapKey === undefined && recorded !== undefined) {
          await sh('Drop the bootstrap record', removeOwnFileScript(deployId, 'secrets/bootstrap-pending'), [
            REMOVED_SENTINEL,
          ])
        }
      }

      const checked = await sh('Check the bootstrap variables', hygieneScript(), [HYGIENE_SENTINEL])
      const counts = /^TRACES_HYGIENE env_file=(\d+) running=(\d+)$/m.exec(checked.result.stdout)
      if (counts?.[1] !== undefined && counts[2] !== undefined) {
        hygiene = {envFile: Number(counts[1]), running: Number(counts[2])}
      }
    }

    const gates = evaluateGates({
      keyPairSet,
      ingestVariableTrue: inputs.ingestOpen,
      retentionDetail: `30-day TTL on ${retention.tables.join(', ')}; 30-day expiry on ${retention.prefixes.join(', ')}`,
      tokenFiles,
      verdict,
      canary,
      bootstrap: {supplied: inputs.bootstrapKey !== undefined, probe, hygiene},
    })
    for (const line of describeGates(gates)) log(`  ${line}`)

    // An operator gate is not about the route: it is reported by its own error, after the route is set.
    const unmet = gates
      .filter(entry => entry.kind !== 'operator' && entry.status !== 'pass')
      .map(entry => `${entry.id}: ${entry.detail}`)
    const failures = failedSafetyGates(gates)

    if (mayOpen(gates)) {
      if (route !== 'open') {
        log('==> Opening the ingest route')
        await setState('open')
      }
      const proof = await prove('open')
      if (!proof.proven) {
        throw new Error(
          `the open route was not confirmed from inside the host (${describeStatuses(proof.statuses)}); expected 401 on every ingest path`,
        )
      }
      log(
        `Ingest is open: every ingest path reached the collector and asked for a token (${describeStatuses(proof.statuses)}).`,
      )
      return await finish({ingest: 'open', gates, unmet: [], retention, changed, drifted, heldForUpdate})
    }

    // Not openable. An open route is held; a held or off route stays as it is.
    if (route === 'open') {
      log('==> Holding the ingest route (the gates are not all met)')
      await setState('held')
      const proof = await prove('held')
      if (!proof.proven) {
        throw new Error(`the held route was not confirmed from inside the host (${describeStatuses(proof.statuses)})`)
      }
    }

    if (failures.length > 0) {
      throw new Error(`Gates failed: ${failures.map(entry => `${entry.id}: ${entry.detail}`).join('; ')}`)
    }

    const final: IngestState = route === 'none' ? 'off' : route
    log(`Ingest is ${final.toUpperCase()}. Gates not met:`)
    for (const line of unmet) log(`  - ${line}`)
    return await finish({ingest: final, gates, unmet, retention, changed, drifted, heldForUpdate})
  } catch (error) {
    // The one failure that deliberately leaves the route and the marker alone. The host belongs to the newer deploy
    // now: a hold from here could undo what it did, and it will close or open the route from what it finds. Nothing
    // is read, held, probed or removed.
    if (ownership.overtaken) throw new DeployOvertakenError({opened: ownership.opened})
    // A comparison step cannot itself be refused by the step lock (it takes none): the reply means a newer deploy is
    // mid-takeover, so, as an overtaken deploy does, this one leaves the route to it and reports the busy lock as it is.
    if (phase === 'compare' && error instanceof DeployStepBusyError) throw error
    // Whatever else failed, and wherever: the route is closed from the host's own answer before this deploy gives up.
    const closed = await secureRoute()
    const cause = errorMessage(error)
    // The hold is checked like every other change. If it finds this deploy was overtaken meanwhile, it changed nothing,
    // and the failure that brought us here is reported next to it.
    if (ownership.overtaken) throw new DeployOvertakenError({opened: ownership.opened, failure: cause})
    if (phase === 'compare') throw new FilesNotComparedError(cause, closed)
    if (phase === 'apply') throw new AppliedButUnverifiedError(cause, closed)
    if (closed === 'unknown') {
      throw new Error(
        `${cause}. Ingest may be open: the deploy could not confirm the route closed. Run \`traces ingest hold\` now.`,
      )
    }
    if (heldForUpdate) {
      throw new Error(
        `${cause}. Ingest was held for this update and stays held; a deploy that passes every gate reopens it.`,
      )
    }
    if (closed === 'held') {
      throw new Error(`${cause}. Ingest is held because the deploy failed; a deploy that passes every gate reopens it.`)
    }
    throw error
  }
}

// ─── Entry point ──────────────────────────────────────────────────────────────

export interface DeployOptions {
  env?: EnvLike
  deps?: Partial<DeployDeps>
}

/**
 * Deploys the trace stack. Inputs are validated before any SSH argv exists; then the shared connection, the
 * storage check and the steps in the file header run in order.
 */
export async function deploy(options: DeployOptions = {}): Promise<DeployResult> {
  const env = options.env ?? process.env
  const inputs = readInputs(env)
  const deps: DeployDeps = {...defaultDeps(env), ...options.deps}

  if (inputs.ingestOpenWarning !== undefined) deps.log(`[warn] ${inputs.ingestOpenWarning}`)
  await preflightDns(inputs.domain, inputs.host, deps.resolve)

  const temp = deps.makeTempDir()
  const identity = inputs.sshKey === undefined ? undefined : deps.materializeIdentity(inputs.sshKey)
  const target: SshTarget = {
    host: inputs.host,
    identityFile: identity?.path,
    // One connection per deploy in a directory of its own: a short fixed name keeps the socket path under the
    // 104-byte limit on macOS.
    controlPath: join(temp.path, 'cm'),
    knownHostsFile: deps.knownHostsFile,
  }
  try {
    return await performDeploy(inputs, createDeployExec(deps.run, target), deps)
  } finally {
    try {
      await deps.run(closeMasterArgv(target))
    } catch {
      // The control master also exits on its own after ControlPersist.
    }
    identity?.cleanup()
    temp.cleanup()
  }
}

if (import.meta.main) {
  deploy().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
