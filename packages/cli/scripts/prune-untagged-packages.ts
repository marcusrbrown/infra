#!/usr/bin/env bun
/// <reference types="bun" />

/**
 * Repo-local, one-shot pruner for untagged GHCR container versions (issue
 * #1327). Deletes only untagged versions of `infra-gateway` and
 * `infra-workspace` that are provably orphaned — never referenced as a child
 * manifest by any tagged version.
 *
 * Dry-run is the default; deletion requires an explicit `apply: true`. Every
 * safety gate aborts the whole run for that package without deleting
 * anything, fail-closed on any ambiguity (never mapping an inconclusive probe
 * to "safe to delete" — see ARCHITECTURE.md invariant 14). This is
 * repo-local workflow code invoked only by
 * `.github/workflows/prune-packages.yaml`'s manual dispatch — it is not a
 * CLI command, MCP tool, package export, or published file.
 */

import {z} from 'zod'

// ─── Contract constants ──────────────────────────────────────────────────────

export const TARGET_PACKAGES = ['infra-gateway', 'infra-workspace'] as const
export type TargetPackage = (typeof TARGET_PACKAGES)[number]

export const OWNER = 'marcusrbrown'
export const API_VERSION = '2022-11-28'
export const PER_PAGE = 100
export const MAX_PAGES = 50
export const CANDIDATE_CAP = 500

const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
].join(', ')

const LIST_MEDIA_TYPES = new Set([
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
])

export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

// ─── Pure pagination helper ──────────────────────────────────────────────────

export function nextLink(linkHeader: string | null): string | null {
  if (linkHeader === null || linkHeader.trim() === '') return null
  for (const part of linkHeader.split(',')) {
    const match = part.match(/<([^>]+)>\s*;\s*rel="next"/)
    if (match?.[1] !== undefined) return match[1]
  }
  return null
}

// ─── Zod response schemas ────────────────────────────────────────────────────

const versionSchema = z.object({
  id: z.number().int(),
  name: z.string(),
  metadata: z
    .object({
      container: z.object({tags: z.array(z.string())}).optional(),
    })
    .optional(),
})
type VersionRecord = z.infer<typeof versionSchema>

const registryTokenSchema = z.object({token: z.string().min(1)})

const manifestSchema = z.object({
  mediaType: z.string().optional(),
  manifests: z.array(z.object({digest: z.string()})).optional(),
})

// ─── Error classification ────────────────────────────────────────────────────

class PrunerAbort extends Error {
  readonly code: string
  readonly reason: string

  constructor(code: string, reason: string) {
    super(`${code}: ${reason}`)
    this.name = 'PrunerAbort'
    this.code = code
    this.reason = reason
  }
}

// ─── Public types ────────────────────────────────────────────────────────────

export interface PrunerOptions {
  readonly token: string
  readonly fetch: FetchLike
  readonly apply: boolean
  readonly apiBaseUrl?: string
  readonly registryBaseUrl?: string
  readonly log?: (message: string) => void
}

export interface PackageSummary {
  readonly package: TargetPackage
  readonly tagged: number
  readonly untagged: number
  readonly deleted: number
  readonly skipped: number
  readonly mode: 'dry-run' | 'apply'
  readonly status: 'completed' | 'aborted'
  readonly abort_code: string | null
  readonly abort_reason: string | null
}

function tagsOf(version: VersionRecord): string[] {
  return version.metadata?.container?.tags ?? []
}

function isUntagged(version: VersionRecord): boolean {
  return tagsOf(version).length === 0
}

export function summaryLine(summary: PackageSummary): string {
  return JSON.stringify(summary)
}

function abortedSummary(
  pkg: TargetPackage,
  mode: 'dry-run' | 'apply',
  progress: {tagged: number; untagged: number; deleted: number},
  code: string,
  reason: string,
): PackageSummary {
  return {
    package: pkg,
    tagged: progress.tagged,
    untagged: progress.untagged,
    deleted: progress.deleted,
    skipped: progress.untagged - progress.deleted,
    mode,
    status: 'aborted',
    abort_code: code,
    abort_reason: reason,
  }
}

// ─── Pruner ───────────────────────────────────────────────────────────────────

export async function pruneUntaggedPackages(options: PrunerOptions): Promise<PackageSummary[]> {
  const apiBase = (options.apiBaseUrl ?? 'https://api.github.com').replace(/\/+$/, '')
  const registryBase = (options.registryBaseUrl ?? 'https://ghcr.io').replace(/\/+$/, '')
  const fetcher = options.fetch
  const log = options.log ?? (() => {})
  const mode: 'dry-run' | 'apply' = options.apply ? 'apply' : 'dry-run'

  const githubHeaders: Record<string, string> = {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${options.token}`,
    'x-github-api-version': API_VERSION,
    'user-agent': 'infra-prune-untagged-packages',
  }

  async function githubRequest(
    method: string,
    urlOrPath: string,
  ): Promise<{status: number; headers: Headers; json: unknown}> {
    const url = urlOrPath.startsWith('http')
      ? urlOrPath
      : `${apiBase}${urlOrPath.startsWith('/') ? '' : '/'}${urlOrPath}`
    let response: Response
    try {
      response = await fetcher(url, {method, headers: githubHeaders})
    } catch {
      throw new PrunerAbort('network_error', `network error during ${method} ${urlOrPath}`)
    }
    const text = await response.text().catch(() => '')
    let json: unknown
    if (text.length > 0) {
      try {
        json = JSON.parse(text)
      } catch {
        json = undefined
      }
    }
    return {status: response.status, headers: response.headers, json}
  }

  async function fetchAllVersions(pkg: TargetPackage): Promise<VersionRecord[]> {
    const collected: VersionRecord[] = []
    // Specified-user form: GITHUB_TOKEN in a workflow has no /user context.
    // GitHub documents this LIST form for public packages only — both targets are public.
    let next: string | null = `/users/${OWNER}/packages/container/${pkg}/versions?per_page=${PER_PAGE}`
    let pageNumber = 0
    while (next !== null) {
      pageNumber += 1
      if (pageNumber > MAX_PAGES) throw new PrunerAbort('pagination_incomplete', 'page limit exceeded')
      const result = await githubRequest('GET', next)
      if (result.status !== 200) {
        throw new PrunerAbort('pagination_failed', `status ${result.status} on page ${pageNumber}`)
      }
      const parsed = z.array(versionSchema).safeParse(result.json)
      if (!parsed.success) throw new PrunerAbort('pagination_invalid', `invalid version page ${pageNumber}`)
      collected.push(...parsed.data)
      const rawNext = nextLink(result.headers.get('link'))
      if (rawNext === null) {
        next = null
        continue
      }
      let resolved: URL
      try {
        resolved = new URL(rawNext, apiBase)
      } catch {
        throw new PrunerAbort('pagination_incomplete', 'unparseable pagination link')
      }
      if (resolved.origin !== new URL(apiBase).origin) {
        throw new PrunerAbort('pagination_incomplete', 'pagination link origin mismatch')
      }
      next = resolved.href
    }
    return collected
  }

  async function fetchRegistryToken(pkg: TargetPackage): Promise<string> {
    const url = `${registryBase}/token?scope=repository:${OWNER}/${pkg}:pull&service=ghcr.io`
    let response: Response
    try {
      response = await fetcher(url, {method: 'GET'})
    } catch {
      throw new PrunerAbort('registry_token_failed', 'network error fetching registry token')
    }
    if (response.status !== 200) throw new PrunerAbort('registry_token_failed', `status ${response.status}`)
    const json: unknown = await response.json().catch(() => undefined)
    const parsed = registryTokenSchema.safeParse(json)
    if (!parsed.success) throw new PrunerAbort('registry_token_failed', 'invalid registry token response')
    return parsed.data.token
  }

  async function fetchManifest(
    pkg: TargetPackage,
    digest: string,
    registryToken: string,
  ): Promise<z.infer<typeof manifestSchema>> {
    const url = `${registryBase}/v2/${OWNER}/${pkg}/manifests/${digest}`
    let response: Response
    try {
      response = await fetcher(url, {
        method: 'GET',
        headers: {authorization: `Bearer ${registryToken}`, accept: MANIFEST_ACCEPT},
      })
    } catch {
      throw new PrunerAbort('manifest_fetch_failed', `network error fetching manifest ${digest}`)
    }
    if (response.status !== 200) {
      throw new PrunerAbort('manifest_fetch_failed', `status ${response.status} fetching manifest ${digest}`)
    }
    const json: unknown = await response.json().catch(() => undefined)
    const parsed = manifestSchema.safeParse(json)
    if (!parsed.success) throw new PrunerAbort('manifest_fetch_failed', `invalid manifest body for ${digest}`)
    return parsed.data
  }

  async function deleteVersion(pkg: TargetPackage, id: number): Promise<void> {
    const result = await githubRequest('DELETE', `/users/${OWNER}/packages/container/${pkg}/versions/${id}`)
    if (result.status < 200 || result.status >= 300) {
      throw new PrunerAbort('delete_failed', `status ${result.status} deleting version ${id}`)
    }
  }

  async function pruneOnePackage(pkg: TargetPackage): Promise<PackageSummary> {
    const progress = {tagged: 0, untagged: 0, deleted: 0}
    try {
      // Gate a: pagination must be provably complete.
      const versions = await fetchAllVersions(pkg)
      const tagged = versions.filter(version => !isUntagged(version))
      const untagged = versions.filter(version => isUntagged(version))
      progress.tagged = tagged.length
      progress.untagged = untagged.length

      // Gate f: a package with zero tagged versions means something is wrong.
      if (tagged.length === 0) throw new PrunerAbort('no_tagged_versions', `${pkg} has zero tagged versions`)

      // Gate e: candidate cap guards against an unexpected API shape.
      if (untagged.length > CANDIDATE_CAP) {
        throw new PrunerAbort('candidate_cap_exceeded', `${untagged.length} untagged versions exceed ${CANDIDATE_CAP}`)
      }

      const registryToken = await fetchRegistryToken(pkg)

      // Gates b, c, d: fetch every tagged manifest, abort on index shape or
      // any structural child reference, and collect child digests.
      const childDigests = new Set<string>()
      for (const version of tagged) {
        const manifest = await fetchManifest(pkg, version.name, registryToken)
        if (manifest.mediaType !== undefined && LIST_MEDIA_TYPES.has(manifest.mediaType)) {
          throw new PrunerAbort('manifest_is_index', `tagged version ${version.name} is a manifest list/image index`)
        }
        if (manifest.manifests !== undefined) {
          for (const child of manifest.manifests) childDigests.add(child.digest)
        }
      }

      const untaggedDigests = new Set(untagged.map(version => version.name))
      for (const digest of childDigests) {
        if (untaggedDigests.has(digest)) {
          throw new PrunerAbort(
            'untagged_referenced_as_child',
            `untagged digest ${digest} is referenced as a child manifest`,
          )
        }
      }

      if (!options.apply) {
        log(`${pkg}: dry-run — ${untagged.length} untagged version(s) would be deleted`)
        return {
          package: pkg,
          tagged: tagged.length,
          untagged: untagged.length,
          deleted: 0,
          skipped: untagged.length,
          mode: 'dry-run',
          status: 'completed',
          abort_code: null,
          abort_reason: null,
        }
      }

      for (const version of untagged) {
        await deleteVersion(pkg, version.id)
        progress.deleted += 1
      }
      log(`${pkg}: deleted ${progress.deleted} untagged version(s)`)
      return {
        package: pkg,
        tagged: tagged.length,
        untagged: untagged.length,
        deleted: progress.deleted,
        skipped: 0,
        mode: 'apply',
        status: 'completed',
        abort_code: null,
        abort_reason: null,
      }
    } catch (error) {
      if (error instanceof PrunerAbort) {
        log(`${pkg}: aborted — ${error.code}`)
        return abortedSummary(pkg, mode, progress, error.code, error.reason)
      }
      const reason = error instanceof Error ? error.message : 'unexpected failure'
      log(`${pkg}: aborted — internal_error`)
      return abortedSummary(pkg, mode, progress, 'internal_error', reason)
    }
  }

  const summaries: PackageSummary[] = []
  for (const pkg of TARGET_PACKAGES) {
    summaries.push(await pruneOnePackage(pkg))
  }
  return summaries
}

// ─── Environment + entrypoint ────────────────────────────────────────────────

export interface PrunerEnv {
  token: string
  apply: boolean
}

export function readPrunerEnv(environment: Record<string, string | undefined>, args: string[]): PrunerEnv | null {
  const token = environment.GITHUB_TOKEN
  if (token === undefined || token === '') return null
  return {token, apply: args.includes('--apply')}
}

async function main(): Promise<void> {
  const env = readPrunerEnv(process.env, process.argv.slice(2))
  if (env === null) {
    process.stderr.write('GITHUB_TOKEN is required\n')
    process.exitCode = 1
    return
  }
  const summaries = await pruneUntaggedPackages({
    token: env.token,
    apply: env.apply,
    fetch: globalThis.fetch.bind(globalThis),
  })
  for (const summary of summaries) {
    process.stdout.write(`${summaryLine(summary)}\n`)
  }
  const failed = summaries.some(summary => summary.status === 'aborted')
  process.exitCode = failed ? 1 : 0
}

if (import.meta.main) {
  await main()
}
