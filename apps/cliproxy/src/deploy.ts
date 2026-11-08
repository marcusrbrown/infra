#!/usr/bin/env bun

import type {OpenAICompatEntry} from '@marcusrbrown/infra-shared/cliproxy/management'
import type {Exclusion, OpenCodeGoSettings, ParsedSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import {existsSync, mkdtempSync, rmSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {
  applyOAuthModelAlias,
  applyOpenAICompat,
  ManagementHttpError,
  patchOpenAICompatDisabled,
  readBackOAuthModelAlias,
  readBackOpenAICompat,
  readOAuthModelAliasFromConfig,
  setEqualOAuthModelAlias,
  setEqualOpenAICompat,
} from '@marcusrbrown/infra-shared/cliproxy/management'
import {computeEligibility, parseSettings, parseSnapshot} from '@marcusrbrown/infra-shared/opencode-go/eligibility'
import snapshotJson from '@marcusrbrown/infra-shared/opencode-go/privacy-snapshot.json'
import settingsJson from '@marcusrbrown/infra-shared/opencode-go/settings.json'

const DEFAULT_REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/cliproxy'

export interface DeployEnv {
  readonly [key: string]: string
  PATH: string
  HOME: string
  SSH_AUTH_SOCK: string
  CLIPROXY_DOMAIN: string
  CLIPROXY_MANAGEMENT_KEY: string
  /** The OpenCode Go API key written into the proxy's `opencode-go` upstream entry. Never reaches ssh/scp. */
  CLIPROXY_OPENCODE_GO_KEY: string
  /** A downstream proxy key, used only for this deploy's own `/v1/*` calls. Never reaches ssh/scp. */
  CLIPROXY_API_KEY: string
}

export interface DeployFiles {
  compose: string
  config: string
  caddy: string
}

/** Overrides for the tracked OpenCode Go policy; tests inject fixtures, production uses the committed files. */
export interface OpenCodeGoOptions {
  /** Raw settings JSON; defaults to `packages/shared/opencode-go/settings.json`. */
  settings?: unknown
  /** Raw privacy snapshot JSON; defaults to `packages/shared/opencode-go/privacy-snapshot.json`. */
  snapshot?: unknown
  /** Clock for the agreement-expiry check; defaults to the current time. */
  now?: () => Date
  /** Sleep used by the readback and visibility polls; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>
}

export interface DeployOptions {
  fetch?: typeof globalThis.fetch
  spawn?: typeof Bun.spawn
  files?: DeployFiles
  env?: DeployEnv
  /** Parent directory for the SSH control socket; defaults to os.tmpdir(). */
  tempRoot?: string
  opencodeGo?: OpenCodeGoOptions
}

function resolveDeployFiles(): DeployFiles {
  const appRoot = resolve(import.meta.dir, '..')

  return {
    compose: resolve(appRoot, 'docker-compose.yaml'),
    config: resolve(appRoot, 'config/config.yaml'),
    caddy: resolve(appRoot, 'config/Caddyfile'),
  }
}

function getDeployEnv(): DeployEnv {
  const path = process.env.PATH
  const home = process.env.HOME
  const sshAuthSock = process.env.SSH_AUTH_SOCK
  const host = process.env.CLIPROXY_DOMAIN

  if (!path) {
    throw new Error('PATH is required for deploy')
  }

  if (!home) {
    throw new Error('HOME is required for deploy')
  }

  if (!sshAuthSock) {
    throw new Error('SSH_AUTH_SOCK is required for deploy. Start ssh-agent and load your key first.')
  }

  if (!host) {
    throw new Error('CLIPROXY_DOMAIN is required for deploy.')
  }

  return {
    PATH: path,
    HOME: home,
    SSH_AUTH_SOCK: sshAuthSock,
    CLIPROXY_DOMAIN: host,
    CLIPROXY_MANAGEMENT_KEY: process.env.CLIPROXY_MANAGEMENT_KEY ?? '',
    CLIPROXY_OPENCODE_GO_KEY: process.env.CLIPROXY_OPENCODE_GO_KEY ?? '',
    CLIPROXY_API_KEY: process.env.CLIPROXY_API_KEY ?? '',
  }
}

/** Keys that exist only for this process's own HTTP calls. */
const HTTP_ONLY_ENV_KEYS: ReadonlySet<string> = new Set(['CLIPROXY_OPENCODE_GO_KEY', 'CLIPROXY_API_KEY'])

/** The environment handed to `ssh`/`scp` children: the deploy env without the Go and downstream keys. */
function childProcessEnv(env: DeployEnv): Record<string, string> {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !HTTP_ONLY_ENV_KEYS.has(name)))
}

function validatePreconditions(files = resolveDeployFiles(), env?: DeployEnv): DeployFiles {
  if (!existsSync(files.compose)) {
    throw new Error(`Missing deploy file: ${files.compose}`)
  }

  if (!existsSync(files.config)) {
    throw new Error(`Missing deploy file: ${files.config}`)
  }

  if (!existsSync(files.caddy)) {
    throw new Error(`Missing deploy file: ${files.caddy}`)
  }

  if (!env) getDeployEnv()

  return files
}

async function runCommand(
  label: string,
  command: string[],
  env: Record<string, string>,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<void> {
  console.warn(`\u001B[1;34m==>\u001B[0m ${label}`)

  const proc = spawnFn(command, {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const exitCode = await proc.exited

  if (stdout.trim()) {
    console.warn(stdout.trim())
  }

  if (exitCode !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) {
      console.error(stderr.trim())
    }
    throw new Error(`Command failed with exit code ${exitCode}: ${command.join(' ')}`)
  }
}

// Every ssh/scp call shares one control socket: the droplet's UFW rate-limits new SSH connections (6 per 30 s).
function controlOptions(controlPath: string): string[] {
  return ['-o', 'ControlMaster=auto', '-o', `ControlPath=${controlPath}`, '-o', 'ControlPersist=60s']
}

function sshCommand(host: string, command: string, controlPath: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    ...controlOptions(controlPath),
    `${DEFAULT_REMOTE_USER}@${host}`,
    command,
  ]
}

function scpCommand(host: string, source: string, destination: string, controlPath: string): string[] {
  return [
    'scp',
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    ...controlOptions(controlPath),
    source,
    `${DEFAULT_REMOTE_USER}@${host}:${destination}`,
  ]
}

/**
 * Probes whether a file exists on the remote host, distinguishing a confirmed answer from a
 * failed probe. A bare SSH exit code cannot tell a genuine absence apart from a transport
 * failure (connection refused, auth failure, host unreachable, `test` unavailable) — the
 * remote command therefore emits an explicit `EXISTS`/`MISSING` sentinel that is checked
 * alongside the exit code.
 *
 * @throws {Error} if the exit code or output cannot be confidently mapped to EXISTS/MISSING.
 * The caller (config.yaml upload gating) must never treat an inconclusive probe as "file
 * absent": doing so would silently overwrite the live config.yaml and wipe its runtime API
 * keys, so callers must let this throw abort the deploy rather than fall back to a guess.
 */
async function remoteFileExists(
  host: string,
  path: string,
  env: Record<string, string>,
  controlPath: string,
  spawnFn: typeof Bun.spawn = Bun.spawn,
): Promise<boolean> {
  const proc = spawnFn(sshCommand(host, `test -f '${path}' && echo EXISTS || echo MISSING`, controlPath), {
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const stdout = (await new Response(proc.stdout).text()).trim()
  const stderr = (await new Response(proc.stderr).text()).trim()
  const exitCode = await proc.exited

  if (exitCode === 0 && stdout === 'EXISTS') {
    return true
  }
  if (exitCode === 0 && stdout === 'MISSING') {
    return false
  }

  throw new Error(
    `Could not determine whether remote file '${path}' exists (exit code: ${exitCode}${
      stderr ? `, stderr: ${stderr}` : ''
    }). Aborting deploy: treating an inconclusive probe as "file absent" would risk overwriting config.yaml and wiping its runtime API keys.`,
  )
}

async function healthCheck(env: DeployEnv, fetchImpl: typeof globalThis.fetch = globalThis.fetch): Promise<void> {
  const host = env.CLIPROXY_DOMAIN
  const url = `https://${host}/v0/management/config`

  const headers = new Headers()
  if (env.CLIPROXY_MANAGEMENT_KEY) {
    headers.set('x-management-key', env.CLIPROXY_MANAGEMENT_KEY)
  }

  // healthCheck runs after compose-up (irreversible),
  // give slow startup 30s room while still bounding the wait.
  const response = await fetchImpl(url, {headers, signal: AbortSignal.timeout(30_000)})

  if (!response.ok) {
    await response.text()
    throw new Error(`Health check failed (${response.status} ${response.statusText}) at ${url}`)
  }

  console.warn(`\u001B[1;32m✓\u001B[0m Health check passed: ${url}`)
}

/** CLIProxyAPI answers 403 `{"error":"IP banned due to too many failed attempts. …"}` while a source IP is banned. */
const MANAGEMENT_IP_BAN_MESSAGE =
  'CLIProxyAPI management API is temporarily banning this source IP after repeated bad keys (about 30 min). ' +
  'The key may be fine — wait, then retry; see #1544.'

/** True when a management 403 body carries the IP-ban text. An unreadable body is not a ban. Body is never echoed. */
async function isManagementIpBanResponse(response: Response): Promise<boolean> {
  try {
    return /ip banned/i.test((await response.text()).slice(0, 512))
  } catch {
    return false
  }
}

export async function preflightManagementKeyCheck(
  env: DeployEnv,
  files: {config: string},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  const key = env.CLIPROXY_MANAGEMENT_KEY
  const host = env.CLIPROXY_DOMAIN

  if (!key) {
    // If the alias block is non-empty, fail early BEFORE compose-up rather
    // than wasting ~90s and failing mid-deploy in applyOAuthModelAliasStep.
    const desired = readOAuthModelAliasFromConfig(files.config)
    if (desired.claude.length > 0) {
      throw new Error(
        'oauth-model-alias block present in config.yaml but CLIPROXY_MANAGEMENT_KEY is not set — aliases cannot be applied. Set CLIPROXY_MANAGEMENT_KEY or remove the block.',
      )
    }
    console.warn('\u001B[1;33m⚠\u001B[0m  CLIPROXY_MANAGEMENT_KEY not set — skipping pre-deploy validation')
    return
  }

  const url = `https://${host}/v0/management/config`
  const headers = new Headers()
  headers.set('x-management-key', key)

  try {
    const response = await fetchImpl(url, {headers, signal: AbortSignal.timeout(10_000)})

    if (response.ok) {
      console.warn('\u001B[1;32m✓\u001B[0m Pre-deploy validation passed: management key accepted')
      return
    }

    if (response.status === 401 || response.status === 403) {
      if (response.status === 403 && (await isManagementIpBanResponse(response))) {
        throw new Error(MANAGEMENT_IP_BAN_MESSAGE)
      }
      throw new Error(
        "Management key is invalid. Verify CLIPROXY_MANAGEMENT_KEY matches MANAGEMENT_PASSWORD in the server's /opt/cliproxy/.env",
      )
    }

    throw new Error(`Proxy is unhealthy (HTTP ${response.status}). Resolve before deploying.`)
  } catch (error: unknown) {
    if (error instanceof Error && error.message.includes('Management key')) {
      throw error
    }
    if (error instanceof Error && error.message.includes('Proxy is unhealthy')) {
      throw error
    }
    if (error instanceof Error && error.message === MANAGEMENT_IP_BAN_MESSAGE) {
      throw error
    }
    // Network errors (ECONNREFUSED, DNS failure, timeout) — server not yet running
    console.warn('\u001B[1;33m⚠\u001B[0m  Could not reach proxy — skipping pre-deploy validation (first deploy?)')
  }
}

/** Sleep helper — injectable in tests to avoid real delays. */
async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * Apply the `oauth-model-alias` block from the tracked config to the live proxy
 * via the management API. Runs after `docker compose up -d --wait` (the management
 * API is reachable) and before `healthCheck`.
 *
 * - Empty alias block → skip (nothing to apply).
 * - Non-empty block + missing management key → hard-fail (operator intent is clear).
 * - PUT → read-back (with bounded retry for hot-reload race) → set-equality check → hard-fail on mismatch.
 * - Fork verification via /v1/models is best-effort: warns on mismatch, never throws.
 */
export async function applyOAuthModelAliasStep(
  env: DeployEnv,
  files: {config: string},
  fetchImpl: typeof globalThis.fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const desired = readOAuthModelAliasFromConfig(files.config)

  if (desired.claude.length === 0) {
    console.warn('\u001B[1;34m==>\u001B[0m Skipping oauth-model-alias (no entries in config)')
    return
  }

  const key = env.CLIPROXY_MANAGEMENT_KEY
  if (!key) {
    throw new Error(
      'oauth-model-alias block is present in config.yaml but CLIPROXY_MANAGEMENT_KEY is not set — cannot apply aliases. Set CLIPROXY_MANAGEMENT_KEY to proceed.',
    )
  }

  const baseUrl = `https://${env.CLIPROXY_DOMAIN}`

  console.warn(`\u001B[1;34m==>\u001B[0m Applying ${desired.claude.length} oauth-model-alias entries`)
  await applyOAuthModelAlias({baseUrl, key, body: desired, fetch: fetchImpl})

  // Bounded retry for hot-reload race — daemon may reload config async after PUT.
  // Retry up to 3 times on mismatch only; HTTP errors from readback propagate immediately.
  const MAX_ATTEMPTS = 3
  const BACKOFFS = [0, 500, 1000] // ms before each attempt (0 = immediate first try)
  let lastMismatchError: Error | null = null

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const backoff = BACKOFFS[attempt] ?? 0
    if (backoff > 0) {
      await sleepFn(backoff)
    }

    const actual = await readBackOAuthModelAlias({baseUrl, key, fetch: fetchImpl})
    if (setEqualOAuthModelAlias(desired, actual)) {
      lastMismatchError = null
      break
    }

    // Show full canonical key per entry (name + alias + fork) so mismatches
    // where only name or fork differs are visible, not just alias.
    const desiredLines = desired.claude.map(e => `    name=${e.name} alias=${e.alias} fork=${e.fork}`).join('\n')
    const actualLines = actual.claude.map(e => `    name=${e.name} alias=${e.alias} fork=${e.fork}`).join('\n')
    lastMismatchError = new Error(
      `oauth-model-alias read-back mismatch after PUT.\n` +
        `  desired (${desired.claude.length} entries):\n${desiredLines}\n` +
        `  actual  (${actual.claude.length} entries):\n${actualLines}`,
    )
  }

  if (lastMismatchError) {
    throw lastMismatchError
  }

  // Fork verification: best-effort only — requires a downstream api-key, not the management key.
  // The management read-back above already proves the aliases were stored.
  const apiKey = process.env.CLIPROXY_API_KEY
  if (apiKey) {
    try {
      const modelsResponse = await fetchImpl(`${baseUrl}/v1/models`, {
        headers: {Authorization: `Bearer ${apiKey}`},
        signal: AbortSignal.timeout(10_000),
      })
      if (modelsResponse.ok) {
        const modelsPayload: unknown = await modelsResponse.json()
        const modelsData =
          modelsPayload !== null && typeof modelsPayload === 'object' && 'data' in modelsPayload
            ? (modelsPayload as {data: unknown}).data
            : undefined
        const modelIds: string[] = Array.isArray(modelsData)
          ? modelsData
              .map((m: unknown) =>
                m !== null && typeof m === 'object' && 'id' in m && typeof (m as {id: unknown}).id === 'string'
                  ? (m as {id: string}).id
                  : '',
              )
              .filter(Boolean)
          : []
        const missing = desired.claude.flatMap(e => {
          const absent: string[] = []
          if (!modelIds.includes(e.alias)) absent.push(e.alias)
          if (!modelIds.includes(e.name)) absent.push(e.name)
          return absent
        })
        if (missing.length > 0) {
          console.warn(
            `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models missing expected IDs: ${missing.join(', ')} (aliases stored; this may be a propagation delay)`,
          )
        }
      } else {
        console.warn(
          `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models returned HTTP ${modelsResponse.status} — skipping fork check (aliases stored)`,
        )
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      console.warn(
        `\u001B[1;33m⚠\u001B[0m  Fork verification: /v1/models probe failed (${msg}) — skipping (aliases stored)`,
      )
    }
  } else {
    console.warn(
      '\u001B[1;34m==>\u001B[0m Fork verification skipped (CLIPROXY_API_KEY not set; management read-back already proved aliases were stored)',
    )
  }

  console.warn(`\u001B[1;32m✓\u001B[0m Applied ${desired.claude.length} oauth-model-alias entries successfully`)
}

// ─── OpenCode Go upstream ─────────────────────────────────────────────────────

const GO_ENTRY_NAME = 'opencode-go'
const GO_BASE_URL = 'https://opencode.ai/inference/go/openai/v1'
const GO_LIVE_MODELS_URL = 'https://opencode.ai/inference/go/v1/models'
const GO_SESSION_HEADER = 'x-opencode-session'
const GO_RUNBOOK = 'docs/runbooks/cliproxy-opencode-go.md'

/** Waits before each readback attempt after the PUT: the proxy reloads in about 180 ms. */
const GO_READBACK_BACKOFFS_MS = [0, 500, 1000]
/** Waits before each visibility attempt after the write: about 5.5 s in total. */
const GO_VISIBILITY_BACKOFFS_MS = [0, 250, 500, 750, 1000, 1000, 1000, 1000]

export type OpenCodeGoPlan =
  {enabled: false} | {enabled: true; eligible: string[]; excluded: Exclusion[]; probeModel: string}

/** The write reached the proxy but a later check failed, so the live state is unproven. */
export class OpenCodeGoUnverifiedError extends Error {
  constructor(stage: string, detail: string) {
    super(
      `OpenCode Go entry APPLIED but UNVERIFIED (${stage}): ${detail}. ` +
        `Do not assume Go routing works. Follow ${GO_RUNBOOK} to inspect or disable the entry.`,
    )
    this.name = 'OpenCodeGoUnverifiedError'
  }
}

/** Replace every non-empty secret occurrence so an error can carry upstream text safely. */
function redact(text: string, env: DeployEnv): string {
  let result = text
  for (const secret of [env.CLIPROXY_OPENCODE_GO_KEY, env.CLIPROXY_API_KEY, env.CLIPROXY_MANAGEMENT_KEY]) {
    if (secret) result = result.split(secret).join('[redacted]')
  }
  return result
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Run a mutating management call. Only a 4xx answer (other than 408) proves the proxy rejected the write and
 * left the live entry alone, so it passes through as an ordinary failure. A transport error, a timeout, a 408
 * or a 5xx may follow a write the proxy already applied, so each raises {@link OpenCodeGoUnverifiedError}.
 */
async function sendGoWrite(write: () => Promise<void>, env: DeployEnv): Promise<void> {
  try {
    await write()
  } catch (error) {
    const rejected =
      error instanceof ManagementHttpError && error.status >= 400 && error.status < 500 && error.status !== 408
    if (rejected) throw error
    throw new OpenCodeGoUnverifiedError(
      'write',
      `the request was sent and its outcome is unknown: ${redact(describeError(error), env)}`,
    )
  }
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

async function fetchLiveGoIds(fetchImpl: typeof globalThis.fetch): Promise<string[]> {
  const failure = (detail: string): Error => new Error(`Could not fetch the live OpenCode Go model list (${detail})`)

  let response: Response
  try {
    response = await fetchImpl(GO_LIVE_MODELS_URL, {signal: AbortSignal.timeout(10_000)})
  } catch (error) {
    throw failure(describeError(error))
  }
  if (!response.ok) {
    await response.text()
    throw failure(`HTTP ${response.status}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw failure('malformed JSON')
  }
  const data = isRecordLike(payload) ? payload.data : undefined
  if (!Array.isArray(data)) throw failure('unexpected shape')
  return data.flatMap(item => (isRecordLike(item) && typeof item.id === 'string' && item.id !== '' ? [item.id] : []))
}

/**
 * Pre-SSH validation of the OpenCode Go step. Parses the tracked policy, and — when Go is enabled — requires the
 * three keys, reads the live Go model list and computes the eligible set. Throws before any write or SSH.
 *
 * Disabled mode needs no Go key, no downstream key and no network: it only has to parse the tracked policy.
 */
export async function preflightOpenCodeGo(
  env: DeployEnv,
  options: OpenCodeGoOptions = {},
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<OpenCodeGoPlan> {
  const settings: OpenCodeGoSettings = parseSettings(options.settings ?? settingsJson)
  const snapshot: ParsedSnapshot = parseSnapshot(options.snapshot ?? snapshotJson)

  if (!settings.enabled) {
    console.warn('\u001B[1;34m==>\u001B[0m OpenCode Go is disabled in settings.json — the proxy entry will be disabled')
    return {enabled: false}
  }

  const missing = (
    [
      'CLIPROXY_OPENCODE_GO_KEY',
      'CLIPROXY_API_KEY',
      'CLIPROXY_MANAGEMENT_KEY',
    ] as const satisfies readonly (keyof DeployEnv)[]
  ).filter(name => !env[name])
  if (missing.length > 0) {
    throw new Error(
      `OpenCode Go is enabled (packages/shared/opencode-go/settings.json) but ${missing.join(', ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Set ${missing.length === 1 ? 'it' : 'them'} or disable Go in settings.json.`,
    )
  }

  const liveIds = await fetchLiveGoIds(fetchImpl)
  const todayUtc = (options.now?.() ?? new Date()).toISOString().slice(0, 10)
  const {eligible, excluded} = computeEligibility(snapshot, liveIds, todayUtc)

  console.warn(
    `\u001B[1;34m==>\u001B[0m OpenCode Go: ${eligible.length} eligible model(s), ${excluded.length} excluded`,
  )
  for (const {id, reason} of excluded) console.warn(`    excluded: ${id} (${reason})`)

  const [firstEligible] = eligible
  if (firstEligible === undefined) {
    throw new Error(
      'no eligible OpenCode Go models: every live or snapshot model is excluded, so nothing may be exposed. ' +
        'Review packages/shared/opencode-go/privacy-snapshot.json.',
    )
  }
  const preferred = settings.defaultProbeModel
  const probeModel = preferred !== undefined && eligible.includes(preferred) ? preferred : firstEligible

  return {enabled: true, eligible, excluded, probeModel}
}

interface ServedModel {
  id: string
  ownedBy: string
}

/** Read `/v1/models` with the downstream key. Errors carry the status only. */
async function readServedModels(
  baseUrl: string,
  apiKey: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<ServedModel[]> {
  const response = await fetchImpl(`${baseUrl}/v1/models`, {
    headers: {Authorization: `Bearer ${apiKey}`},
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    await response.text()
    throw new Error(`GET /v1/models failed with HTTP ${response.status}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new Error('GET /v1/models returned malformed JSON')
  }
  const data = isRecordLike(payload) ? payload.data : undefined
  if (!Array.isArray(data)) throw new TypeError('GET /v1/models returned an unexpected shape')
  return data.flatMap(item =>
    isRecordLike(item) && typeof item.id === 'string'
      ? [{id: item.id, ownedBy: typeof item.owned_by === 'string' ? item.owned_by : ''}]
      : [],
  )
}

function buildGoEntry(goKey: string, eligible: readonly string[]): OpenAICompatEntry {
  return {
    name: GO_ENTRY_NAME,
    prefix: GO_ENTRY_NAME,
    'base-url': GO_BASE_URL,
    'api-key-entries': [{'api-key': goKey}],
    models: eligible.map(id => ({name: id, alias: id})),
    // Maps the client's own header onto the upstream request; the proxy never forwards headers wholesale.
    headers: {[GO_SESSION_HEADER]: '$X-Opencode-Session'},
    disabled: false,
  }
}

/** Names of the entry fields that differ. Field names only: values include the api-key. */
function differingFields(desired: OpenAICompatEntry, actual: OpenAICompatEntry | undefined): string[] {
  if (actual === undefined) return ['entry missing']
  const fields: string[] = []
  const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)
  if (desired.prefix !== actual.prefix) fields.push('prefix')
  if (desired['base-url'] !== actual['base-url']) fields.push('base-url')
  if (desired.disabled !== actual.disabled) fields.push('disabled')
  const modelNames = (entry: OpenAICompatEntry): string[] =>
    entry.models.map(model => JSON.stringify([model.name, model.alias])).sort()
  if (!same(modelNames(desired), modelNames(actual))) fields.push('models')
  if (!same(desired.headers, actual.headers)) fields.push('headers')
  const keys = (entry: OpenAICompatEntry): string[] => entry['api-key-entries'].map(item => item['api-key']).sort()
  if (!same(keys(desired), keys(actual))) fields.push('api-key-entries')
  return fields
}

/** Throws unless the live section is empty or holds only the `opencode-go` entry. */
function assertOwnedSection(live: readonly OpenAICompatEntry[]): void {
  const foreign = live.filter(entry => entry.name !== GO_ENTRY_NAME).map(entry => entry.name)
  if (foreign.length > 0) {
    throw new Error(
      `Refusing to write openai-compatibility: the live section holds other entries (${foreign.join(', ')}). ` +
        `Infra owns only "${GO_ENTRY_NAME}" and the write replaces the whole list. Remove or migrate them first; see ${GO_RUNBOOK}.`,
    )
  }
}

/** Models whose id would be shadowed by, or shadow, an eligible Go id served by another provider. */
function findCollisions(served: readonly ServedModel[], eligible: readonly string[]): ServedModel[] {
  const wanted = new Set(eligible.flatMap(id => [id, `${GO_ENTRY_NAME}/${id}`]))
  return served.filter(model => wanted.has(model.id) && model.ownedBy !== GO_ENTRY_NAME)
}

/** Problems with the served model list: missing or duplicated eligible ids, and Go-owned ids that must not exist. */
function visibilityProblems(served: readonly ServedModel[], eligible: readonly string[]): string[] {
  const problems: string[] = []
  const expected = new Set(eligible.flatMap(id => [id, `${GO_ENTRY_NAME}/${id}`]))
  const goOwned = served.filter(model => model.ownedBy === GO_ENTRY_NAME)

  for (const id of expected) {
    const count = goOwned.filter(model => model.id === id).length
    if (count === 0) problems.push(`${id} is not visible under owned_by ${GO_ENTRY_NAME}`)
    else if (count > 1) problems.push(`${id} is listed ${count} times`)
  }
  for (const model of goOwned) {
    if (!expected.has(model.id))
      problems.push(`${model.id} is exposed under owned_by ${GO_ENTRY_NAME} but is not eligible`)
  }
  return problems
}

async function pollUntil<T>(
  backoffs: readonly number[],
  sleepFn: (ms: number) => Promise<void>,
  attempt: () => Promise<{done: true; value: T} | {done: false; reason: string}>,
): Promise<{ok: true; value: T} | {ok: false; reason: string}> {
  let reason = 'no attempt made'
  for (const backoff of backoffs) {
    if (backoff > 0) await sleepFn(backoff)
    const result = await attempt()
    if (result.done) return {ok: true, value: result.value}
    reason = result.reason
  }
  return {ok: false, reason}
}

const GO_BILLING_TOKEN = /^[\w.-]{1,32}$/

/**
 * One real request through the proxy at `max_tokens: 1`; requires a 2xx that names a `billing_source`. A source
 * other than `go` means the Go usage window ran out and the account fell back to credits: the route works, so it
 * passes with a warning. Returns the bounded billing token (`go`, the fallback token, or `other`).
 */
async function runGoSmokeRequest(
  baseUrl: string,
  apiKey: string,
  model: string,
  fetchImpl: typeof globalThis.fetch,
): Promise<string> {
  const response = await fetchImpl(`${baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      [GO_SESSION_HEADER]: `infra-deploy-${crypto.randomUUID()}`,
    },
    body: JSON.stringify({model, messages: [{role: 'user', content: 'Reply with OK'}], max_tokens: 1}),
    signal: AbortSignal.timeout(30_000),
  })
  if (!response.ok) {
    await response.text()
    throw new OpenCodeGoUnverifiedError('smoke request', `the proxy answered HTTP ${response.status}`)
  }

  let payload: unknown
  try {
    payload = await response.json()
  } catch {
    throw new OpenCodeGoUnverifiedError('smoke request', 'the 2xx response was not JSON, so billing_source is unknown')
  }
  const usage = isRecordLike(payload) ? payload.usage : undefined
  const opencode = isRecordLike(usage) ? usage.opencode : undefined
  const billing = isRecordLike(opencode) ? opencode.billing_source : undefined
  if (typeof billing !== 'string' || billing === '') {
    const seen = typeof billing === 'string' ? JSON.stringify(billing) : 'missing'
    throw new OpenCodeGoUnverifiedError('smoke request', `billing_source was ${seen}, expected "go"`)
  }
  if (billing === 'go') return 'go'

  const token = GO_BILLING_TOKEN.test(billing) ? billing : 'other'
  console.warn(
    `\u001B[1;33m⚠\u001B[0m  OpenCode Go smoke request billed to "${token}", not "go" (Go usage window exhausted or credits fallback); route works`,
  )
  return token
}

/**
 * Apply the tracked OpenCode Go upstream to the live proxy and prove it routes. Runs after the alias step
 * and before `healthCheck`.
 *
 * Before the write (plain errors, live proxy untouched): foreign entries, a disabled live entry while Go is
 * enabled, id collisions with other providers, and a 4xx answer to the write itself. From the moment the write
 * is sent, every other failure is an {@link OpenCodeGoUnverifiedError} naming the runbook.
 *
 * Disabled mode disables the existing entry with a field-scoped PATCH and expects no Go ids to be served.
 */
export async function applyOpenCodeGoStep(
  env: DeployEnv,
  plan: OpenCodeGoPlan,
  fetchImpl: typeof globalThis.fetch,
  sleepFn: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  const managementKey = env.CLIPROXY_MANAGEMENT_KEY
  if (!managementKey) {
    if (plan.enabled) throw new Error('CLIPROXY_MANAGEMENT_KEY is required to apply the OpenCode Go entry.')
    console.warn(
      '\u001B[1;33m⚠\u001B[0m  CLIPROXY_MANAGEMENT_KEY not set — cannot confirm the OpenCode Go entry is disabled',
    )
    return
  }

  const baseUrl = `https://${env.CLIPROXY_DOMAIN}`
  const live = await readBackOpenAICompat({baseUrl, key: managementKey, fetch: fetchImpl})
  assertOwnedSection(live)
  const liveEntry = live.find(entry => entry.name === GO_ENTRY_NAME)

  if (!plan.enabled) {
    await disableGoEntry(env, baseUrl, liveEntry, fetchImpl, sleepFn)
    return
  }

  if (liveEntry?.disabled === true) {
    throw new Error(
      `The live "${GO_ENTRY_NAME}" entry is disabled but settings.json says enabled. ` +
        `Re-enable it deliberately first; see ${GO_RUNBOOK}.`,
    )
  }

  const collisions = findCollisions(await readServedModels(baseUrl, env.CLIPROXY_API_KEY, fetchImpl), plan.eligible)
  if (collisions.length > 0) {
    throw new Error(
      `Refusing to expose OpenCode Go: these ids are already served by another provider: ${collisions
        .map(model => `${model.id} (owned_by ${model.ownedBy || 'unknown'})`)
        .join(', ')}.`,
    )
  }

  const desired = buildGoEntry(env.CLIPROXY_OPENCODE_GO_KEY, plan.eligible)
  console.warn(`\u001B[1;34m==>\u001B[0m Applying OpenCode Go upstream (${plan.eligible.length} models)`)
  await sendGoWrite(() => applyOpenAICompat({baseUrl, key: managementKey, body: [desired], fetch: fetchImpl}), env)

  let billedTo = 'go'
  try {
    const readback = await pollUntil(GO_READBACK_BACKOFFS_MS, sleepFn, async () => {
      const actual = await readBackOpenAICompat({baseUrl, key: managementKey, fetch: fetchImpl})
      if (setEqualOpenAICompat([desired], actual)) return {done: true, value: true}
      const fields = differingFields(
        desired,
        actual.find(entry => entry.name === GO_ENTRY_NAME),
      )
      return {done: false, reason: `differs in: ${fields.join(', ') || 'entry set'}`}
    })
    if (!readback.ok) throw new OpenCodeGoUnverifiedError('read-back', `the live entry ${readback.reason}`)

    const visible = await pollUntil(GO_VISIBILITY_BACKOFFS_MS, sleepFn, async () => {
      const problems = visibilityProblems(
        await readServedModels(baseUrl, env.CLIPROXY_API_KEY, fetchImpl),
        plan.eligible,
      )
      return problems.length === 0 ? {done: true, value: true} : {done: false, reason: problems.join('; ')}
    })
    if (!visible.ok) throw new OpenCodeGoUnverifiedError('visibility', visible.reason)

    billedTo = await runGoSmokeRequest(baseUrl, env.CLIPROXY_API_KEY, plan.probeModel, fetchImpl)
  } catch (error) {
    if (error instanceof OpenCodeGoUnverifiedError) throw error
    throw new OpenCodeGoUnverifiedError('post-write check', redact(describeError(error), env))
  }

  console.warn(
    `\u001B[1;32m✓\u001B[0m OpenCode Go applied and verified: ${plan.eligible.length} models visible, smoke request ${
      billedTo === 'go' ? 'billed to Go' : `served (billed to "${billedTo}")`
    }`,
  )
}

async function disableGoEntry(
  env: DeployEnv,
  baseUrl: string,
  liveEntry: OpenAICompatEntry | undefined,
  fetchImpl: typeof globalThis.fetch,
  sleepFn: (ms: number) => Promise<void>,
): Promise<void> {
  if (liveEntry === undefined) {
    console.warn(`\u001B[1;34m==>\u001B[0m No live "${GO_ENTRY_NAME}" entry — nothing to disable`)
    return
  }

  if (liveEntry.disabled !== true) {
    console.warn(`\u001B[1;34m==>\u001B[0m Disabling the live "${GO_ENTRY_NAME}" entry`)
    await sendGoWrite(
      () =>
        patchOpenAICompatDisabled({
          baseUrl,
          key: env.CLIPROXY_MANAGEMENT_KEY,
          name: GO_ENTRY_NAME,
          disabled: true,
          fetch: fetchImpl,
        }),
      env,
    )
  }

  if (!env.CLIPROXY_API_KEY) {
    console.warn(
      '\u001B[1;33m⚠\u001B[0m  CLIPROXY_API_KEY not set — skipping the check that no OpenCode Go model is served',
    )
    return
  }

  try {
    const gone = await pollUntil(GO_VISIBILITY_BACKOFFS_MS, sleepFn, async () => {
      const served = (await readServedModels(baseUrl, env.CLIPROXY_API_KEY, fetchImpl)).filter(
        model => model.ownedBy === GO_ENTRY_NAME,
      )
      return served.length === 0
        ? {done: true, value: true}
        : {done: false, reason: `still served: ${served.map(model => model.id).join(', ')}`}
    })
    if (!gone.ok) throw new OpenCodeGoUnverifiedError('visibility', gone.reason)
  } catch (error) {
    if (error instanceof OpenCodeGoUnverifiedError) throw error
    throw new OpenCodeGoUnverifiedError('post-write check', redact(describeError(error), env))
  }

  console.warn(`\u001B[1;32m✓\u001B[0m OpenCode Go disabled and verified: no Go model is served`)
}

export async function deploy(opts: DeployOptions = {}): Promise<void> {
  const env = opts.env ?? getDeployEnv()
  const files = validatePreconditions(opts.files, env)
  const host = env.CLIPROXY_DOMAIN
  const forceConfig = process.argv.includes('--force-config')
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const spawnFn = opts.spawn ?? Bun.spawn

  // Validate management key before any SSH, upload, or container operation.
  await preflightManagementKeyCheck(env, files, fetchImpl)

  // Validate the OpenCode Go policy, keys and live model list before any SSH, the same way.
  const goPlan = await preflightOpenCodeGo(env, opts.opencodeGo, fetchImpl)
  const childEnv = childProcessEnv(env)

  let tmpDir: string | undefined

  try {
    // Control socket lives in a per-deploy temp dir; a short fixed name keeps the path under the unix socket limit.
    tmpDir = mkdtempSync(join(opts.tempRoot ?? tmpdir(), 'cliproxy-deploy-'))
    const controlPath = join(tmpDir, 'cm')

    await runCommand(
      'Creating remote directories',
      sshCommand(host, `mkdir -p ${REMOTE_DIR}/config`, controlPath),
      childEnv,
      spawnFn,
    )

    await runCommand(
      'Uploading docker-compose.yaml',
      scpCommand(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`, controlPath),
      childEnv,
      spawnFn,
    )
    await runCommand(
      'Uploading config/Caddyfile',
      scpCommand(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`, controlPath),
      childEnv,
      spawnFn,
    )

    // config.yaml contains runtime state (API keys, settings) managed via the management API.
    // Only upload on first deploy or when explicitly forced. Overwriting would wipe API keys.
    const configExists = await remoteFileExists(
      host,
      `${REMOTE_DIR}/config/config.yaml`,
      childEnv,
      controlPath,
      spawnFn,
    )
    const trackedConfigUploaded = !configExists || forceConfig
    if (trackedConfigUploaded) {
      const label = forceConfig
        ? 'Uploading config/config.yaml (forced)'
        : 'Uploading config/config.yaml (first deploy)'
      await runCommand(
        label,
        scpCommand(host, files.config, `${REMOTE_DIR}/config/config.yaml`, controlPath),
        childEnv,
        spawnFn,
      )
    } else {
      console.warn(
        '\u001B[1;34m==>\u001B[0m Skipping config/config.yaml (exists on server, use --force-config to overwrite)',
      )
    }

    // Reclaim disk from unused images before pulling (best-effort; failure only warns).
    try {
      await runCommand(
        'Pruning unused images (disk reclaim)',
        sshCommand(host, 'docker image prune -af', controlPath),
        childEnv,
        spawnFn,
      )
    } catch (error) {
      console.warn(
        '[deploy] Image prune failed (non-fatal, continuing):',
        error instanceof Error ? error.message : error,
      )
    }

    await runCommand(
      'Updating Docker Compose stack',
      // --wait blocks until caddy reports healthy; caddy's healthcheck probes
      // http://cli-proxy-api:8317/healthz, so a healthy caddy transitively proves
      // the proxy is serving. --wait-timeout caps the block at 90s.
      sshCommand(
        host,
        `cd ${REMOTE_DIR} && docker compose pull && docker compose up -d --wait --wait-timeout 90`,
        controlPath,
      ),
      childEnv,
      spawnFn,
    )

    // Apply oauth-model-alias after the stack is healthy (management API reachable)
    // and before healthCheck so a failed alias apply fails the deploy.
    await applyOAuthModelAliasStep(env, files, fetchImpl)

    // Apply the OpenCode Go upstream last, so the live proxy is already serving; a failure here fails the deploy
    // before healthCheck.
    await applyOpenCodeGoStep(env, goPlan, fetchImpl, opts.opencodeGo?.sleep)

    await healthCheck(env, fetchImpl)
  } finally {
    if (tmpDir) {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  }
}

if (import.meta.main) {
  deploy().catch((error: unknown) => {
    console.error(error)
    process.exit(1)
  })
}
