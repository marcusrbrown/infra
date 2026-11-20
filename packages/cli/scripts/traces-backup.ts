#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, non-published daily backup of the trace data volume.
 *
 * Run by `.github/workflows/traces-backup.yaml`. Three commands, one per workflow step:
 *
 * - `backup`  The `backup` job (declares no Environment: it must never wait on a reviewer or create a Deployment
 *             record). Finds the live volume, snapshots it, confirms the
 *             snapshot from a read-back listing, prunes old snapshots and checks the age of the newest. Holds the
 *             DigitalOcean token and neither the issue token nor the webhook. Exits 1 on any failure.
 * - `issue`   The `alert` job, first step. Reads the backup job's result and keeps ONE open issue per outage. Holds the
 *             workflow token and neither the DigitalOcean token nor the webhook. Writes the step outputs `notify`
 *             (`created` | `recovered` | `none`) and `issue-number`.
 * - `notify`  The `alert` job, second step. Posts ONE Discord message when `notify` is `created` or `recovered`.
 *             Holds the webhook and no token. Always exits 0.
 *
 * The DigitalOcean API is called with `fetch` (no `doctl`, no install step). Endpoints:
 *   GET    /v2/droplets?name=traces              droplet:read
 *   GET    /v2/volumes                           block_storage:read
 *   POST   /v2/volumes/{id}/snapshots            block_storage_snapshot:create (+ tag:create for the tag)
 *   GET    /v2/snapshots?resource_type=volume    snapshot:read (+ tag:read, or tags read back as empty)
 *   DELETE /v2/volumes/snapshots/{id}            block_storage_snapshot:delete
 * Every list follows `links.pages.next`, after checking that the link stays on `api.digitalocean.com`.
 *
 * The live volume is the ONE volume whose name is `traces-data` or starts `traces-data-` AND that is attached to the
 * droplet named `traces`. A restore swaps in a volume named `traces-data-restore-<date>`, so the match is never by a
 * fixed name or id. Zero or more than one match is a failure, never a guess.
 *
 * What the job may delete (`isOurs`): a snapshot of a volume, named `traces-<yyyymmdd>-<hhmm>` (a daily backup) or
 * `traces-pre-<label>` (a manual pre-upgrade backup), that either carries this job's tag (`traces-backup`) or comes from
 * a volume in the `traces-data` family. The name must match strictly in both cases, so a tag alone is not enough, and a
 * snapshot of another volume or one named any other way is never touched. The tag is the job's mark and also reaches
 * snapshots of a volume that has since been deleted; the family clause reaches an untagged manual snapshot of the live
 * volume, which would otherwise outlive the 8 days the retention promise states. The two name shapes are how a daily
 * backup and a pre-upgrade backup are told apart: only a daily backup counts as "the newest snapshot", so a manual
 * snapshot can never hide a broken daily job.
 *
 * Order and guards:
 * 1. Create `traces-<yyyymmdd>-<hhmm>` (UTC) with the tag. A failure is recorded and the run goes on.
 * 2. Read the snapshots back. When the create succeeded, it must be listed and be the newest daily snapshot.
 * 3. The newest daily snapshot must be at most 36 hours old, or the run fails.
 * 4. Prune only when step 3 passed: a broken backup must not also erase history. Delete our snapshots older than 8 days,
 *    oldest first, at most 10 a run, so a wrong clock or a long backlog cannot wipe the history in one run.
 *
 * Not deployed yet: when `TRACES_DOMAIN` is unset the job exits green with a notice and the alert job does nothing. The
 * workflow merges before the host exists. Only the domain says "not deployed": with the domain set, a missing
 * `TRACES_SNAPSHOT_DO_TOKEN` fails the run (`snapshot-token-missing`) and opens the alert like any other failure, so a
 * deleted or renamed secret cannot silently disable the backups.
 *
 * Safety contract:
 * - ZERO package imports (`node:fs`, the sibling `alert-issue.ts` and `deploy-gate-notify.ts`).
 * - The token, API response bodies and volume or snapshot ids are never written to a log, a summary, an issue or Discord.
 *   Failures are fixed reason codes (`do-api:<stage>:http-<status>`, `:timeout`, `:network`, `:malformed`).
 * - A re-run (`github.run_attempt` above 1) makes no alert API call: it would replay an old backup result.
 *
 * Environment inputs (names are this script's contract):
 * - `TRACES_SNAPSHOT_DO_TOKEN`      `backup` only: a repository secret, scoped to volume and snapshot actions. Required once
 *                                   `TRACES_DOMAIN` is set.
 * - `TRACES_DOMAIN`                 `backup`: repository variable, documented value `traces.fro.bot`. Unset means the stack
 *                                   is not deployed yet; set means it exists (the droplet is found by name).
 * - `ALERT_BACKUP_RESULT`           `issue`, `notify`: `needs.backup.result` (`success|failure|cancelled|skipped`).
 * - `ALERT_BACKUP_DEPLOYED`         `issue`, `notify`: `needs.backup.outputs.deployed` (`true|false`, empty if unset).
 * - `ALERT_REHEARSE`                `none` | `fail` | `clear`; empty (a scheduled run) reads as `none`.
 * - `ALERT_RUN_ATTEMPT`             `issue`: `github.run_attempt`. Anything but exactly `1` is a re-run.
 * - `ALERT_NOTIFY`, `ALERT_ISSUE_NUMBER`   `notify`: the issue step's outputs.
 * - `CLIPROXY_AUTH_MONITOR_DISCORD_WEBHOOK` `notify` only. Missing or blank => skipped.
 * - `GH_TOKEN`                      `issue` only, consumed by `gh`.
 * - `GITHUB_REPOSITORY`, `GITHUB_SERVER_URL`, `GITHUB_RUN_ID`, `GITHUB_WORKFLOW`, `GITHUB_ACTOR`,
 *   `GITHUB_REPOSITORY_OWNER`, `GITHUB_OUTPUT`, `GITHUB_STEP_SUMMARY`: set by the runner.
 */

import type {FetchLike} from './deploy-gate-notify'
import {
  AlertFailure,
  appendTo,
  blobUrl,
  isRecord,
  issueUrl,
  oneOf,
  parseAttempt,
  printLine,
  readRehearse,
  readRunContext,
  realIssueDeps,
  realNotifyDeps,
  reconcileAlertIssue,
  rehearsalPlan,
  runDiscordStepWith,
  runIssueStepWith,
  runUrl,
  type AlertSpec,
  type Attempt,
  type GhRunner,
  type Identity,
  type IssueContent,
  type IssueOutcome,
  type IssueStepDeps,
  type NotifyStepDeps,
  type NotifySummary,
  type Plan,
  type Rehearse,
  type RunContext,
} from './alert-issue'

// ─── Contract constants ──────────────────────────────────────────────────────

export const ALERT_LABEL = 'traces-backup-failure'
export const REAL_MARKER = '<!-- traces-backup-alert:v1 -->'
export const REHEARSAL_MARKER = '<!-- traces-backup-alert-rehearsal:v1 -->'

/** The droplet that carries the volume. Mirrors `TRACES_DROPLET_NAME` in `apps/traces/src/host.ts` (a test pins it). */
export const DROPLET_NAME = 'traces'
/** The volume name family. Mirrors `TRACES_VOLUME_NAME` in `apps/traces/src/host.ts` (a test pins it). */
export const VOLUME_NAME = 'traces-data'
/** The tag this job puts on every snapshot it creates. */
export const SNAPSHOT_TAG = 'traces-backup'
export const API_ORIGIN = 'https://api.digitalocean.com'
/** Snapshots older than this are pruned. */
export const RETENTION_DAYS = 8
/** The newest daily snapshot must be younger than this, or the run fails and nothing is pruned. */
export const MAX_NEWEST_AGE_HOURS = 36
/** A run deletes at most this many snapshots, oldest first. */
export const MAX_DELETES_PER_RUN = 10

const MAX_PAGES = 50
const REQUEST_TIMEOUT_MS = 30_000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const DAILY_NAME = /^traces-\d{8}-\d{4}$/
const MANUAL_NAME = /^traces-pre-[a-z0-9][a-z0-9-]{0,40}$/
/** Ids are UUIDs; anything else never reaches a URL. */
const ID_PATTERN = /^[\w-]{1,64}$/

const LABEL_COLOR = 'b60205'
const LABEL_DESCRIPTION = 'Trace data snapshot backup failures'
const REAL_TITLE = 'Trace data backup is failing'
const REHEARSAL_TITLE = '[Rehearsal] Trace data backup alert'
const RUNBOOK_PATH = 'docs/runbooks/trace-collection.md'
const ALERT_NAME = 'Trace backup alert'
const REHEARSAL_RESULT_NOTE = 'rehearsal; no backup ran'

const BACKUP_RESULTS = ['success', 'failure', 'cancelled', 'skipped'] as const
const DEPLOYED_VALUES = ['true', 'false', ''] as const

export type BackupResult = (typeof BACKUP_RESULTS)[number]

const SPEC: AlertSpec = {
  label: ALERT_LABEL,
  labelColor: LABEL_COLOR,
  labelDescription: LABEL_DESCRIPTION,
  markers: {real: REAL_MARKER, rehearsal: REHEARSAL_MARKER},
  titles: {real: REAL_TITLE, rehearsal: REHEARSAL_TITLE},
  // A daily job: each failing day adds one comment to the open issue.
  commentOnRepeat: true,
}

// ─── DigitalOcean API ────────────────────────────────────────────────────────

export interface DoDeps {
  readonly fetch: FetchLike
  readonly token: string
  readonly timeoutMs?: number
}

/** A failure with a fixed reason code: the stage and the HTTP status, never a body, an id or an error message. */
function apiFailure(stage: string, detail: string): AlertFailure {
  return new AlertFailure(`do-api:${stage}:${detail}`)
}

/** Sends one request and returns the response body as text. The timeout covers the body read too. */
async function request(
  deps: DoDeps,
  stage: string,
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  payload?: unknown,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? REQUEST_TIMEOUT_MS)
  let status = 0
  let text = ''
  try {
    const response = await deps.fetch(url, {
      method,
      headers: {
        accept: 'application/json',
        authorization: `Bearer ${deps.token}`,
        ...(payload === undefined ? {} : {'content-type': 'application/json'}),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      // A redirect is never followed: the token goes to api.digitalocean.com and nowhere else.
      redirect: 'manual',
      signal: controller.signal,
    })
    status = response.status
    if (response.ok) text = await response.text()
  } catch {
    // Never surface error text: runtime fetch errors can embed the request URL.
    throw apiFailure(stage, controller.signal.aborted ? 'timeout' : 'network')
  } finally {
    clearTimeout(timer)
  }
  if (status < 200 || status > 299) throw apiFailure(stage, `http-${status}`)
  return text
}

async function requestJson(
  deps: DoDeps,
  stage: string,
  method: 'GET' | 'POST',
  url: string,
  payload?: unknown,
): Promise<Record<string, unknown>> {
  const text = await request(deps, stage, method, url, payload)
  try {
    const parsed: unknown = JSON.parse(text)
    if (isRecord(parsed)) return parsed
  } catch {
    // Falls through to the fixed failure below.
  }
  throw apiFailure(stage, 'malformed')
}

/** The next page's URL, or `null`. A link that leaves `api.digitalocean.com` is refused, so the token cannot be sent away. */
function nextPage(record: Record<string, unknown>, stage: string): string | null {
  const links = record.links
  const pages = isRecord(links) ? links.pages : undefined
  const next = isRecord(pages) ? pages.next : undefined
  if (typeof next !== 'string' || next === '') return null
  let url: URL
  try {
    url = new URL(next)
  } catch {
    throw apiFailure(stage, 'bad-next-link')
  }
  if (url.origin !== API_ORIGIN || !url.pathname.startsWith('/v2/')) throw apiFailure(stage, 'bad-next-link')
  return url.toString()
}

async function listAll(deps: DoDeps, stage: string, path: string, key: string): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = []
  let next: string | null = `${API_ORIGIN}${path}`
  for (let page = 0; next !== null; page++) {
    if (page >= MAX_PAGES) throw apiFailure(stage, 'too-many-pages')
    const record: Record<string, unknown> = await requestJson(deps, stage, 'GET', next)
    const entries = record[key]
    if (!Array.isArray(entries)) throw apiFailure(stage, 'malformed')
    for (const entry of entries as unknown[]) {
      if (!isRecord(entry)) throw apiFailure(stage, 'malformed')
      items.push(entry)
    }
    next = nextPage(record, stage)
  }
  return items
}

export interface Droplet {
  readonly id: number
}

export interface Volume {
  readonly id: string
  readonly name: string
  readonly dropletIds: readonly number[]
}

export interface Snapshot {
  readonly id: string
  readonly name: string
  readonly createdAt: number
  readonly resourceId: string
  readonly resourceType: string
  readonly tags: readonly string[]
}

async function listDroplets(deps: DoDeps): Promise<Droplet[]> {
  const items = await listAll(deps, 'list-droplets', `/v2/droplets?name=${DROPLET_NAME}&per_page=200`, 'droplets')
  return items.flatMap(item =>
    item.name === DROPLET_NAME && Number.isInteger(item.id) ? [{id: item.id as number}] : [],
  )
}

async function listVolumes(deps: DoDeps): Promise<Volume[]> {
  const items = await listAll(deps, 'list-volumes', '/v2/volumes?per_page=200', 'volumes')
  return items.map(item => {
    if (typeof item.id !== 'string' || typeof item.name !== 'string') throw apiFailure('list-volumes', 'malformed')
    const dropletIds = Array.isArray(item.droplet_ids)
      ? (item.droplet_ids as unknown[]).filter((id): id is number => Number.isInteger(id))
      : []
    return {id: item.id, name: item.name, dropletIds}
  })
}

async function listSnapshots(deps: DoDeps): Promise<Snapshot[]> {
  const items = await listAll(deps, 'list-snapshots', '/v2/snapshots?resource_type=volume&per_page=200', 'snapshots')
  return items.map(item => {
    const createdAt = typeof item.created_at === 'string' ? Date.parse(item.created_at) : Number.NaN
    if (
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.resource_id !== 'string' ||
      typeof item.resource_type !== 'string' ||
      Number.isNaN(createdAt)
    ) {
      throw apiFailure('list-snapshots', 'malformed')
    }
    const tags = Array.isArray(item.tags)
      ? (item.tags as unknown[]).filter((tag): tag is string => typeof tag === 'string')
      : []
    return {
      id: item.id,
      name: item.name,
      createdAt,
      resourceId: item.resource_id,
      resourceType: item.resource_type,
      tags,
    }
  })
}

/** Creates the snapshot and returns its id. Volume snapshots are instant; the read-back confirms it. */
async function createSnapshot(deps: DoDeps, volumeId: string, name: string): Promise<string> {
  if (!ID_PATTERN.test(volumeId)) throw apiFailure('create-snapshot', 'bad-id')
  const record = await requestJson(deps, 'create-snapshot', 'POST', `${API_ORIGIN}/v2/volumes/${volumeId}/snapshots`, {
    name,
    tags: [SNAPSHOT_TAG],
  })
  const snapshot = record.snapshot
  if (!isRecord(snapshot) || typeof snapshot.id !== 'string') throw apiFailure('create-snapshot', 'malformed')
  return snapshot.id
}

async function deleteSnapshot(deps: DoDeps, snapshotId: string): Promise<void> {
  if (!ID_PATTERN.test(snapshotId)) throw apiFailure('delete-snapshot', 'bad-id')
  await request(deps, 'delete-snapshot', 'DELETE', `${API_ORIGIN}/v2/volumes/snapshots/${snapshotId}`)
}

// ─── Selection ───────────────────────────────────────────────────────────────

/** `traces-data`, or `traces-data-<anything>` such as the `traces-data-restore-<date>` a restore swaps in. */
export function isFamilyVolume(name: string): boolean {
  return name === VOLUME_NAME || name.startsWith(`${VOLUME_NAME}-`)
}

/** The one volume of the family that is attached to the droplet. Zero or several is a failure, never a guess. */
export function selectLiveVolume(volumes: readonly Volume[], droplets: readonly Droplet[]): Volume {
  if (droplets.length === 0) throw new AlertFailure('droplet-not-found')
  if (droplets.length > 1) throw new AlertFailure('droplet-ambiguous')
  const dropletId = droplets[0]?.id
  const live = volumes.filter(
    volume => isFamilyVolume(volume.name) && dropletId !== undefined && volume.dropletIds.includes(dropletId),
  )
  const [only] = live
  if (only === undefined) throw new AlertFailure('volume-not-found')
  if (live.length > 1) throw new AlertFailure('volume-ambiguous')
  return only
}

/** The volumes that exist now, split by whether they are in the `traces-data` family. */
export interface VolumeScope {
  readonly family: ReadonlySet<string>
  readonly others: ReadonlySet<string>
}

export function scopeOf(volumes: readonly Volume[]): VolumeScope {
  return {
    family: new Set(volumes.filter(volume => isFamilyVolume(volume.name)).map(volume => volume.id)),
    others: new Set(volumes.filter(volume => !isFamilyVolume(volume.name)).map(volume => volume.id)),
  }
}

/**
 * Whether this job may delete the snapshot. See the header: a strict name AND (this job's tag OR a source volume in the
 * family). Neither alone is enough, and a snapshot of an existing volume outside the family is never ours, tagged or not.
 * A snapshot whose source volume is gone (a swapped-out volume) is ours only by the tag.
 */
export function isOurs(snapshot: Snapshot, scope: VolumeScope): boolean {
  if (snapshot.resourceType !== 'volume') return false
  if (!DAILY_NAME.test(snapshot.name) && !MANUAL_NAME.test(snapshot.name)) return false
  if (scope.others.has(snapshot.resourceId)) return false
  return snapshot.tags.includes(SNAPSHOT_TAG) || scope.family.has(snapshot.resourceId)
}

/** A daily backup of ours. Only these count as "the newest snapshot". */
export function isDaily(snapshot: Snapshot, scope: VolumeScope): boolean {
  return isOurs(snapshot, scope) && DAILY_NAME.test(snapshot.name)
}

export function snapshotName(now: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  const date = `${now.getUTCFullYear()}${pad(now.getUTCMonth() + 1)}${pad(now.getUTCDate())}`
  return `traces-${date}-${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}`
}

// ─── Backup ──────────────────────────────────────────────────────────────────

export interface BackupDeps {
  readonly fetch: FetchLike
  readonly now: () => Date
  readonly writeOutput: (name: string, value: string) => void
  readonly log: (line: string) => void
  readonly appendSummary: (line: string) => void
  readonly timeoutMs?: number
}

export interface BackupOutcome {
  readonly exitCode: 0 | 1
  readonly deployed: boolean
  readonly failures: readonly string[]
  readonly created: boolean
  readonly deleted: number
  /** Age of the newest daily snapshot after the create step, in whole hours; `null` when there is none. */
  readonly newestAgeHours: number | null
}

function reasonOf(error: unknown): string {
  return error instanceof AlertFailure ? error.reason : 'internal-error'
}

/** Never throws. Exit 1 on any failure; the backup job's conclusion is what the alert job reads. */
export async function runBackup(
  environment: Readonly<Record<string, string | undefined>>,
  deps: BackupDeps,
): Promise<BackupOutcome> {
  const domain = environment.TRACES_DOMAIN?.trim() ?? ''
  // Only an unset domain means "not deployed". A token that is missing once the domain is set is a fault, not a pause:
  // reading it as not deployed would leave every run green while the snapshots age out.
  if (domain === '') {
    deps.writeOutput('deployed', 'false')
    deps.log(
      '::notice::TRACES_DOMAIN not set, so the trace stack is treated as not deployed yet. No snapshot was taken.',
    )
    deps.appendSummary('- Trace snapshot backup: not deployed yet (TRACES_DOMAIN is not set)')
    return {exitCode: 0, deployed: false, failures: [], created: false, deleted: 0, newestAgeHours: null}
  }
  deps.writeOutput('deployed', 'true')

  const token = environment.TRACES_SNAPSHOT_DO_TOKEN?.trim() ?? ''
  if (token === '') {
    const failures = ['snapshot-token-missing']
    deps.log('::error::Trace snapshot backup failed: TRACES_SNAPSHOT_DO_TOKEN is not set. No snapshot was taken.')
    deps.appendSummary(
      '- Trace snapshot backup: no snapshot created, the snapshot token is missing (snapshot-token-missing)',
    )
    return {exitCode: 1, deployed: true, failures, created: false, deleted: 0, newestAgeHours: null}
  }

  const api: DoDeps = {fetch: deps.fetch, token, timeoutMs: deps.timeoutMs}
  const failures: string[] = []
  const now = deps.now()
  const record = (error: unknown): void => {
    failures.push(reasonOf(error))
  }

  // 1. Find the live volume. A failure here skips the create but not the guarded prune below.
  let volumes: Volume[] = []
  let live: Volume | null = null
  try {
    volumes = await listVolumes(api)
    live = selectLiveVolume(volumes, await listDroplets(api))
  } catch (error) {
    record(error)
  }

  // 2. Create.
  let createdId: string | null = null
  if (live !== null) {
    try {
      createdId = await createSnapshot(api, live.id, snapshotName(now))
    } catch (error) {
      record(error)
    }
  }

  // 3. Read back, check the age, prune.
  let deleted = 0
  let newestAgeHours: number | null = null
  try {
    const scope = scopeOf(volumes)
    const snapshots = await listSnapshots(api)
    const daily = snapshots.filter(snapshot => isDaily(snapshot, scope))
    const newest = daily.reduce<Snapshot | null>(
      (best, candidate) => (best === null || candidate.createdAt > best.createdAt ? candidate : best),
      null,
    )

    if (createdId !== null) {
      const listed = snapshots.find(snapshot => snapshot.id === createdId)
      if (listed === undefined) failures.push('created-snapshot-not-listed')
      else if (newest !== null && newest.createdAt > listed.createdAt) failures.push('created-snapshot-not-newest')
    }

    const ageMs = newest === null ? null : now.getTime() - newest.createdAt
    newestAgeHours = ageMs === null ? null : Math.floor(ageMs / HOUR_MS)
    const fresh = ageMs !== null && ageMs <= MAX_NEWEST_AGE_HOURS * HOUR_MS
    if (!fresh) failures.push('newest-snapshot-too-old')

    // A broken backup must not also erase history: prune only behind a fresh snapshot.
    if (fresh) {
      const expired = snapshots
        .filter(snapshot => isOurs(snapshot, scope) && now.getTime() - snapshot.createdAt > RETENTION_DAYS * DAY_MS)
        .sort((left, right) => left.createdAt - right.createdAt)
        .slice(0, MAX_DELETES_PER_RUN)
      for (const snapshot of expired) {
        try {
          await deleteSnapshot(api, snapshot.id)
          deleted += 1
        } catch (error) {
          record(error)
        }
      }
    }
  } catch (error) {
    record(error)
  }

  const created = createdId !== null
  const age = newestAgeHours === null ? 'none found' : `${newestAgeHours} h old`
  deps.appendSummary(
    `- Trace snapshot backup: ${created ? 'snapshot created' : 'no snapshot created'}, ${deleted} pruned, newest daily snapshot ${age}${failures.length === 0 ? '' : ` (${failures.join(', ')})`}`,
  )
  if (failures.length > 0) {
    deps.log(`::error::Trace snapshot backup failed: ${failures.join(', ')}`)
    return {exitCode: 1, deployed: true, failures, created, deleted, newestAgeHours}
  }
  return {exitCode: 0, deployed: true, failures, created, deleted, newestAgeHours}
}

// ─── Environment ─────────────────────────────────────────────────────────────

export interface AlertEnv extends RunContext {
  readonly backupResult: BackupResult
  readonly deployed: (typeof DEPLOYED_VALUES)[number]
  readonly rehearse: Rehearse
  readonly attempt: Attempt
}

export function readAlertEnv(environment: Readonly<Record<string, string | undefined>>): AlertEnv {
  const read = (name: string): string => environment[name]?.trim() ?? ''
  return {
    ...readRunContext(environment),
    backupResult: oneOf(BACKUP_RESULTS, read('ALERT_BACKUP_RESULT'), 'invalid-backup-result'),
    deployed: oneOf(DEPLOYED_VALUES, read('ALERT_BACKUP_DEPLOYED'), 'invalid-backup-deployed'),
    rehearse: readRehearse(environment.ALERT_REHEARSE),
    attempt: parseAttempt(read('ALERT_RUN_ATTEMPT')),
  }
}

// ─── Decision ────────────────────────────────────────────────────────────────

/**
 * `failure` and `cancelled` alert: a job killed by `timeout-minutes` reports as `cancelled`. A green job clears, once it
 * says it took a backup (`deployed=true`); `deployed=false` is the stack not existing yet and does nothing, as does
 * `skipped`. A green job that did not say which is a wiring fault and fails the alert step. A rehearsal ignores the real
 * result and uses its own identity. There is no flap control: a daily backup that fails is not a blip.
 */
export function planBackupAlert(input: Pick<AlertEnv, 'backupResult' | 'deployed' | 'rehearse'>): Plan {
  const rehearsal = rehearsalPlan(input.rehearse)
  if (rehearsal !== null) return rehearsal
  switch (input.backupResult) {
    case 'failure':
    case 'cancelled':
      return {kind: 'alert', identity: 'real'}
    case 'skipped':
      return {kind: 'none'}
    case 'success':
      if (input.deployed === 'true') return {kind: 'clear', identity: 'real'}
      if (input.deployed === 'false') return {kind: 'none'}
      throw new AlertFailure('invalid-backup-deployed')
  }
}

// ─── Content ─────────────────────────────────────────────────────────────────

function resultText(env: AlertEnv): string {
  if (env.rehearse === 'fail') return `failure (${REHEARSAL_RESULT_NOTE})`
  if (env.rehearse === 'clear') return `success (${REHEARSAL_RESULT_NOTE})`
  return env.backupResult
}

function detailLines(env: AlertEnv, prefix: string): string[] {
  return [
    `${prefix}Workflow: ${env.workflow}`,
    `${prefix}Run: ${runUrl(env)}`,
    `${prefix}Backup job result: ${resultText(env)}`,
    `${prefix}Runbook: ${blobUrl(env, RUNBOOK_PATH)}`,
  ]
}

function issueBody(env: AlertEnv, identity: Identity): string {
  if (identity === 'rehearsal') {
    return [
      REHEARSAL_MARKER,
      '**Rehearsal.** This tests the trace backup alert. No backup ran and nothing is wrong. It closes when the workflow is dispatched again with `rehearse-alert` set to `clear`.',
      '',
      ...detailLines(env, '- '),
    ].join('\n')
  }
  return [
    REAL_MARKER,
    `The daily snapshot of the trace data volume failed, or the newest snapshot is older than ${MAX_NEWEST_AGE_HOURS} hours. Until a run succeeds the trace data is not backed up. Open the run for which step failed, then follow the runbook (${RUNBOOK_PATH}).`,
    '',
    ...detailLines(env, '- '),
    '',
    'This issue closes when a backup run succeeds.',
  ].join('\n')
}

function failureComment(env: AlertEnv, identity: Identity): string {
  const lead = identity === 'rehearsal' ? '**Rehearsal.** The alert was triggered again.' : 'The backup failed again.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

function recoveryComment(env: AlertEnv, identity: Identity): string {
  const lead =
    identity === 'rehearsal'
      ? '**Rehearsal.** Cleared by a rehearsal dispatch, so this issue is closed.'
      : 'The backup succeeded, so this issue is closed.'
  return [lead, '', ...detailLines(env, '- ')].join('\n')
}

/** The Discord message. Plain text built from fixed strings and the github context; embeds are suppressed on send. */
export function buildDiscordContent(kind: 'created' | 'recovered', env: AlertEnv, issueNumber: number | null): string {
  const rehearsal = env.rehearse !== 'none'
  const tag = rehearsal ? '[REHEARSAL] ' : ''
  const [workflow, run, result, runbook] = detailLines(env, '')
  const issue = issueNumber === null ? [] : [`Issue: ${issueUrl(env, issueNumber)}`]
  const lines =
    kind === 'created'
      ? [
          `**${tag}Trace data backup failed**`,
          'Until a backup run succeeds the trace data is not backed up. Check it now.',
          ...(rehearsal ? ['Rehearsal: no backup ran and nothing is wrong.'] : []),
        ]
      : [
          `**${tag}Trace data backup recovered**`,
          'A backup run succeeded. The alert issue is closed.',
          ...(rehearsal ? ['Rehearsal: no backup ran and nothing is wrong.'] : []),
        ]
  return [...lines, workflow, run, result, ...issue, runbook].join('\n')
}

function contentFor(env: AlertEnv): IssueContent {
  return {
    body: identity => issueBody(env, identity),
    failureComment: identity => failureComment(env, identity),
    recoveryComment: identity => recoveryComment(env, identity),
  }
}

// ─── Reconciliation ──────────────────────────────────────────────────────────

export async function reconcileBackupAlert(env: AlertEnv, gh: GhRunner): Promise<IssueOutcome> {
  return reconcileAlertIssue({context: env, gh, spec: SPEC, content: contentFor(env)}, planBackupAlert(env))
}

export async function runIssueStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: IssueStepDeps,
): Promise<{readonly exitCode: 0 | 1; readonly outcome: IssueOutcome | null}> {
  return runIssueStepWith({
    alertName: ALERT_NAME,
    rerunHint: 'Wait for the next scheduled backup instead.',
    environment,
    readEnv: readAlertEnv,
    reconcile: env => reconcileBackupAlert(env, deps.gh),
    deps,
  })
}

// ─── Discord ─────────────────────────────────────────────────────────────────

export async function runNotifyStep(
  environment: Readonly<Record<string, string | undefined>>,
  deps: NotifyStepDeps,
): Promise<NotifySummary> {
  return runDiscordStepWith({
    alertName: ALERT_NAME,
    environment,
    buildContent: (kind, issueNumber) => buildDiscordContent(kind, readAlertEnv(environment), issueNumber),
    deps,
  })
}

// ─── Entrypoint ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const command = process.argv[2]

  if (command === 'backup') {
    const outcome = await runBackup(process.env, {
      fetch: globalThis.fetch.bind(globalThis),
      now: () => new Date(),
      writeOutput: (name, value) => appendTo(process.env.GITHUB_OUTPUT, `${name}=${value}`),
      log: printLine,
      appendSummary: line => appendTo(process.env.GITHUB_STEP_SUMMARY, line),
    })
    process.exitCode = outcome.exitCode
    return
  }
  if (command === 'issue') {
    const result = await runIssueStep(process.env, realIssueDeps())
    process.exitCode = result.exitCode
    return
  }
  if (command === 'notify') {
    await runNotifyStep(process.env, realNotifyDeps())
    process.exitCode = 0
    return
  }
  printLine('::error::Usage: traces-backup.ts <backup|issue|notify>')
  process.exitCode = 2
}

if (import.meta.main) {
  try {
    await main()
  } catch {
    // Fixed text only: nothing thrown here may carry a token, a webhook or a response body.
    process.stdout.write('::error::Backup script failed unexpectedly\n')
    process.exitCode = process.argv[2] === 'notify' ? 0 : 1
  }
}
