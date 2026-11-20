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
//   7. prune images, check free space, pull
//   8. start the stores and Langfuse, assert and read back retention, start Tempo, Grafana, the collector and
//      the reporter, verify the collector's image digest
//   9. run the gates, then set the route: open only when every gate passes AND TRACES_INGEST_OPEN is exactly
//      `true`; otherwise off (first bring-up) or held (it was open before)
//
// Overlapping deploys: the last deploy to start owns the host. Each deploy writes a random id into the deploy marker
// in its first host script; every later script that changes the host checks, in the same script, that the marker
// still holds that id (`ownershipPrelude`) and otherwise prints `DEPLOY_OVERTAKEN` and changes nothing. An overtaken
// deploy stops at its next step and never opens the route or removes the marker.
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
  SENDER_GROUPS,
  TRACES_APP_DIR,
  TRACES_DEPLOY_MARKER,
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
    grafanaAdminPassword: requireUrlSafe(env, 'TRACES_GRAFANA_ADMIN_PASSWORD', 16),
    grafanaSecretKey: requireUrlSafe(env, 'TRACES_GRAFANA_SECRET_KEY', 16),
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
  'health-reporter',
] as const

export type Service = (typeof SERVICES)[number]

/**
 * The services whose change puts data or the public route at risk: the collector, the backends and their
 * configuration, and Caddy (its configuration is the route). Grafana and the health reporter are not gated.
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
// own UID from the compose file.
const COLLECTOR_GID = '65532'
const GRAFANA_UID = '472'
const REPORTER_UID = '10010'

const COMPOSE_PROJECT_VOLUME = 'traces_collector_queue'

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
// older one refuse itself. A step of the older deploy that was already running when it was overtaken still
// completes: overlapping deploys remain something to avoid.

/** Printed (exit 1, nothing changed) by a script whose deploy no longer owns the marker. */
export const DEPLOY_OVERTAKEN_SENTINEL = 'DEPLOY_OVERTAKEN'

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
 * The check every script that changes the host starts with (after the ingest lock, in the scripts that take it): the
 * marker must exist and its first field must be this deploy's id. Otherwise the script prints the sentinel and exits
 * non-zero before it has changed anything. One line, so it also fits the `; `-joined state-change command.
 */
export function ownershipPrelude(id: string, marker: string = TRACES_DEPLOY_MARKER): string {
  assertDeployId(id)
  if (!SAFE_PATH.test(marker) || marker.includes('..')) throw new Error(`Unsafe marker path: ${marker}`)
  return `if [ -f ${marker} ] && read -r traces_owner traces_rest < ${marker} && [ "$traces_owner" = ${id} ]; then :; else echo ${DEPLOY_OVERTAKEN_SENTINEL}; exit 1; fi`
}

/** A script that changes the host: the ownership check comes before anything else it does. */
function guardedStep(name: string, id: string, body: string, marker?: string): string {
  return step(name, `${ownershipPrelude(id, marker)}\n${body}`)
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
 * takes the host: whichever deploy wrote it last owns the host, and an older one is refused at its next step. This
 * script never refuses: a marker a failed deploy left behind never blocks the next deploy.
 *
 * Prints `key=value` lines. The bootstrap values are secrets printed to stdout; they are parsed in memory and never
 * logged.
 */
export function beginDeployScript(id: string): string {
  assertDeployId(id)
  return step(
    'host-state',
    `cd ${TRACES_APP_DIR}
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
    'config/grafana/datasources',
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
    `${appDir}/${MARKER_FILE}`,
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

/** Compares stdin with a file on the host. `.env` is compared without its ingest-state line. Writes nothing. */
export function compareFileScript(path: string, kind: 'plain' | 'env'): string {
  const target = remotePath(path)
  const same = kind === 'env' ? `grep -v '^TRACES_INGEST_STATE=' ${target} | cmp -s "$t" -` : `cmp -s "$t" ${target}`
  return step(
    `compare:${path}`,
    `t=$(mktemp /tmp/traces-cmp.XXXXXX)
cat > "$t"
if [ ! -e ${target} ]; then
  rm -f "$t"
  echo ${FILE_COMPARE_SENTINELS[2]}
elif ${same}; then
  rm -f "$t"
  echo ${FILE_COMPARE_SENTINELS[0]}
else
  rm -f "$t"
  echo ${FILE_COMPARE_SENTINELS[1]}
fi`,
  )
}

export const FILE_WRITTEN_SENTINEL = 'TRACES_FILE_WRITTEN'

const OWNER = /^(?:root|\d+):(?:root|\d+)$/
const MODE = /^0[0-7]{3}$/

/**
 * Write stdin to a file: a temporary file in the same directory with its owner and mode set first, then an atomic
 * rename. A reader never sees a half-written secret or a file with the wrong owner.
 *
 * For `.env` the script runs under the ingest lock and re-reads the route state from the file it is about to replace.
 * It appends the less open of the planned state and the one on the host: a hold or off that is there stays, so a
 * `traces ingest hold` run during the deploy is never undone by a cached state; a state of `open` on the host becomes
 * the planned one; a host with no `.env` gets the planned one. It prints `TRACES_ENV_STATE=<state written>` so the
 * deploy knows what the host has. Only the deploy's own gated open step (`setIngestStateCommand`) ever opens.
 *
 * It begins with the ownership check (after the lock, for `.env`): a deploy that was overtaken writes nothing.
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
${lock}${prelude}
t=$(mktemp ${directory}/.traces-tmp.XXXXXX)
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
 * The marker is removed by compare-and-delete: under the ingest lock (the one a manual `traces ingest open` and the
 * deploy's own open take), in the same script, it is removed only if it still holds this deploy's id. A deploy that
 * was overtaken, or whose marker is already gone, prints `DEPLOY_OVERTAKEN` and removes nothing.
 */
export function removeOwnFileScript(id: string, path: string): string {
  if (!OWN_FILES.includes(path)) throw new Error(`${path} is not a file this deploy owns`)
  const body = `rm -f ${remotePath(path)}\necho ${REMOVED_SENTINEL}`
  if (path !== MARKER_FILE) return guardedStep(`remove:${path}`, id, body)
  return step(
    `remove:${path}`,
    `exec 9>>${TRACES_INGEST_LOCK}
if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi
${ownershipPrelude(id)}
${body}`,
  )
}

/**
 * The state line and the Caddy recreate, as `traces ingest hold|open` does them (`REMOTE_COMMANDS.writeIngestState`),
 * inside `flock -w 30` on the ingest lock so that two transitions never interleave. The lock is taken on file
 * descriptor 9 before the state is read and is held until the command ends, which is after Caddy was recreated.
 * A lock that cannot be taken in 30 seconds prints `LOCK_BUSY` and fails; it is never skipped. The compose
 * command gets descriptor 9 closed, so nothing it starts can outlive the lock. The new line travels on stdin.
 * A test compares this with the CLI's text.
 *
 * The deploy's version adds one thing the CLI's lacks: under the lock, before anything is written, it checks that
 * the marker still holds this deploy's id. The check and the write share the lock, so a deploy that was overtaken
 * can neither open nor hold the route after the newer deploy took the host, and nothing falls between them.
 */
export function setIngestStateCommand(state: IngestState, id: string): string {
  return [
    'set -e',
    `cd ${TRACES_APP_DIR}`,
    `exec 9>>${TRACES_INGEST_LOCK}`,
    `if ! flock -w 30 9; then echo ${TRACES_LOCK_BUSY_SENTINEL}; exit 1; fi`,
    ownershipPrelude(id),
    'test -f .env',
    't=$(mktemp ./.env.XXXXXX)',
    `{ grep -v '^TRACES_INGEST_STATE=' .env || true; cat; } > "$t"`,
    'chmod 600 "$t"',
    'mv "$t" .env',
    `${COMPOSE} up -d --force-recreate --no-deps caddy 9>&-`,
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

export function pullScript(id: string): string {
  return composeStep('pull', id, `timeout 1800 ${COMPOSE} pull`)
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
    `mp=$(docker volume inspect ${COMPOSE_PROJECT_VOLUME} --format '{{.Mountpoint}}')
case "$mp" in
  ${TRACES_DOCKER_ROOT}/volumes/*/_data) ;;
  *) echo "queue volume is not under the Docker data root on the volume" >&2; exit 1 ;;
esac
chown ${COLLECTOR_GID}:${COLLECTOR_GID} "$mp"
chmod 0700 "$mp"
owner=$(stat -c '%u:%g' "$mp")
if [ "$owner" != ${COLLECTOR_GID}:${COLLECTOR_GID} ]; then
  echo "queue volume owner is not ${COLLECTOR_GID}" >&2
  exit 1
fi
echo ${QUEUE_SENTINEL}`,
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
}

export interface ReporterDetail {
  ran: boolean
  stale: boolean
  ok: boolean
  at: string | null
  checks: ReporterCheck[]
}

const CHECK_STATUSES: readonly string[] = ['pass', 'warn', 'fail', 'unknown']

/**
 * Read the reporter's answer out of the remote output. It needs exit 0, the sentinel line that proves the
 * command ran to its end, and a body of the expected shape. Anything else is `undefined`, never a pass.
 */
export function parseReporterDetail(result: RunResult): ReporterDetail | undefined {
  if (result.exitCode !== 0) return undefined
  const lines = result.stdout.split('\n')
  const end = lines.findIndex(line => line.trim() === REPORTER_DETAIL_SENTINEL)
  if (end === -1) return undefined

  let json: unknown
  try {
    json = JSON.parse(lines.slice(0, end).join('\n'))
  } catch {
    return undefined
  }
  if (typeof json !== 'object' || json === null) return undefined
  const body = json as Record<string, unknown>
  if (
    body.schemaVersion !== 1 ||
    typeof body.ran !== 'boolean' ||
    typeof body.stale !== 'boolean' ||
    typeof body.ok !== 'boolean' ||
    !(typeof body.at === 'string' || body.at === null) ||
    !Array.isArray(body.checks)
  ) {
    return undefined
  }
  const checks: ReporterCheck[] = []
  for (const entry of body.checks as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return undefined
    const check = entry as Record<string, unknown>
    if (typeof check.id !== 'string' || typeof check.detail !== 'string' || typeof check.status !== 'string') {
      return undefined
    }
    if (!CHECK_STATUSES.includes(check.status)) return undefined
    checks.push({id: check.id, status: check.status as ReporterCheck['status'], detail: check.detail})
  }
  return {ran: body.ran, stale: body.stale, ok: body.ok, at: body.at, checks}
}

/** The three checks that prove a trace reached both backends and that the keep-list held. */
export const CANARY_CHECKS = ['canary-send', 'canary-langfuse', 'canary-tempo'] as const

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

export interface GateResult {
  id: GateId
  /** `skipped` is a gate that was not evaluated; it never counts as a pass. */
  status: 'pass' | 'fail' | 'skipped'
  detail: string
  /**
   * `config` gates say whether the operator has asked for ingest to be open yet (the key pair, the variable).
   * Failing one is an expected state, not a failure. `safety` gates are about the stack: failing one fails the deploy.
   */
  kind: 'config' | 'safety'
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
  bootstrap: {
    /** The pair is still among the deploy's inputs. */
    supplied: boolean
    probe: BootstrapProbe
    hygiene: {envFile: number; running: number} | undefined
  }
}

function failingChecks(detail: ReporterDetail): string {
  const lines = detail.checks
    .filter(check => check.status === 'fail' || check.status === 'unknown')
    .map(check => `${check.id}: ${check.detail}`)
  if (!detail.ran) lines.push('the reporter has not finished a run')
  else if (detail.stale) lines.push('the last run is older than two intervals')
  return lines.length === 0 ? 'the verdict does not pass' : lines.join('; ')
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
      const canary = CANARY_CHECKS.map(id => detail.checks.find(check => check.id === id))
      const bad = CANARY_CHECKS.filter((_id, index) => canary[index]?.status !== 'pass')
      gate(
        'canary',
        bad.length === 0,
        bad.length === 0
          ? 'the canary reached both backends and the keep-list held'
          : bad.map(id => `${id}: ${detail.checks.find(check => check.id === id)?.detail ?? 'missing'}`).join('; '),
      )
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

/** Open only when nothing is missing: every gate is a pass. A skipped gate is not a pass. */
export function mayOpen(gates: readonly GateResult[]): boolean {
  return gates.length > 0 && gates.every(gate => gate.status === 'pass')
}

export function failedSafetyGates(gates: readonly GateResult[]): GateResult[] {
  return gates.filter(gate => gate.kind === 'safety' && gate.status === 'fail')
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
}

export const DEFAULT_LIMITS: Limits = {
  proofAttempts: 15,
  proofIntervalMs: 3000,
  retentionAttempts: 30,
  retentionIntervalMs: 10_000,
  verdictAttempts: 40,
  verdictIntervalMs: 5000,
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
        ? 'Ingest is held (every ingest path answers 503, which senders retry).'
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
 * Another deploy started on this host after this one and took it over (it wrote its own id into the marker). This
 * deploy stopped at its next step. It is the one failure that leaves the route and the marker alone: the host now
 * belongs to the newer deploy, and a hold, an open or a marker removal from here could undo what that deploy did.
 * Steps of this deploy that were already running when it was overtaken still completed.
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
 */
export async function performDeploy(
  inputs: DeployInputs,
  rawExec: RemoteExec,
  deps: DeployDeps,
): Promise<DeployResult> {
  const {log} = deps
  const deployId = assertDeployId(deps.deployId())

  // Whether another deploy took the host over, and whether this one's last route change left it open. An object, not
  // bare variables: both are set from inside `exec` and read in the catch below.
  const ownership = {overtaken: false, opened: false}
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
  log(`==> Reading the host state and taking the deploy marker (under the ingest lock; deploy ${deployId.slice(0, 8)})`)
  const host = parseHostState(
    (await sh('Read host state', beginDeployScript(deployId), [HOST_STATE_SENTINEL])).result.stdout,
  )

  // 5. Compare every file, so the decision to hold is made before anything changes.
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
      compareFileScript(file.path, file.kind),
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
  const gatedChange = changed.some(touch => touch === 'compose' || (GATED_SERVICES as readonly Touch[]).includes(touch))

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

  /** The very last step of a deploy that evaluated every gate and left the route in its final state. */
  const finish = async (result: DeployResult): Promise<DeployResult> => {
    // Compare-and-delete under the ingest lock: only the deploy that owns the marker removes it.
    await sh('Remove the deploy marker', removeOwnFileScript(deployId, MARKER_FILE), [REMOVED_SENTINEL])
    return result
  }

  let phase: 'stage' | 'apply' = 'stage'
  try {
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

    log('==> Starting Tempo, Grafana, the collector and the reporter')
    const publicServices: Service[] = ['tempo', 'grafana', 'collector']
    const staleOthers = stale(publicServices)
    if (staleOthers.length > 0) {
      await sh('Recreate changed services', upScript(deployId, 'up-stale-public', staleOthers, {force: true}), [
        STEP_SENTINEL('up-stale-public'),
      ])
    }
    await sh('Start Tempo, Grafana and the collector', upScript(deployId, 'up-public', publicServices), [
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
    let probe: BootstrapProbe = 'none-on-record'
    let hygiene: {envFile: number; running: number} | undefined
    if (keyPairSet) {
      verdict = await awaitFreshVerdict(exec, deps, sinceEpoch)

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
      bootstrap: {supplied: inputs.bootstrapKey !== undefined, probe, hygiene},
    })
    for (const line of describeGates(gates)) log(`  ${line}`)

    const unmet = gates.filter(entry => entry.status !== 'pass').map(entry => `${entry.id}: ${entry.detail}`)
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
    // Whatever else failed, and wherever: the route is closed from the host's own answer before this deploy gives up.
    const closed = await secureRoute()
    const cause = errorMessage(error)
    // The hold is checked like every other change. If it finds this deploy was overtaken meanwhile, it changed nothing,
    // and the failure that brought us here is reported next to it.
    if (ownership.overtaken) throw new DeployOvertakenError({opened: ownership.opened, failure: cause})
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
