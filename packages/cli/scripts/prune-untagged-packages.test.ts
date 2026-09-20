/// <reference types="bun" />

/**
 * Behavior contract for the repo-local untagged GHCR package pruner.
 *
 * Every test drives `pruneUntaggedPackages` through an injectable native
 * `fetch` boundary backed by an in-memory fake GitHub REST + GHCR registry.
 * No test performs a live network call.
 */

import type {FetchLike} from './prune-untagged-packages'
import {describe, expect, it} from 'bun:test'
import {nextLink, OWNER, pruneUntaggedPackages, readPrunerEnv, TARGET_PACKAGES} from './prune-untagged-packages'

// ─── Fixture constants ───────────────────────────────────────────────────────

const TOKEN = 'test-token-must-never-be-logged'

interface FakeVersion {
  id: number
  digest: string
  tags: string[]
}

interface FakeManifest {
  mediaType?: string
  manifests?: {digest: string}[]
}

class FakeRegistry {
  versions: Record<string, FakeVersion[]> = {'infra-gateway': [], 'infra-workspace': []}
  manifests: Record<string, Record<string, FakeManifest>> = {'infra-gateway': {}, 'infra-workspace': {}}
  listPageSize: number | null = null
  deletedIds: Record<string, number[]> = {'infra-gateway': [], 'infra-workspace': []}
  requests: {method: string; url: string}[] = []
  override?: (method: string, url: URL) => Response | undefined

  readonly fetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init?.method ?? 'GET').toUpperCase()
    this.requests.push({method, url: url.href})

    const overridden = this.override?.(method, url)
    if (overridden !== undefined) return overridden

    // Registry token endpoint.
    if (url.host === 'ghcr.io' && url.pathname === '/token') {
      return new Response(JSON.stringify({token: 'registry-token'}), {status: 200})
    }

    // Registry manifest endpoint.
    const manifestMatch = url.pathname.match(/^\/v2\/([^/]+)\/([^/]+)\/manifests\/(.+)$/)
    if (url.host === 'ghcr.io' && manifestMatch) {
      const [, owner, pkg, digest] = manifestMatch
      if (owner !== OWNER) return new Response('', {status: 404})
      const manifest = this.manifests[pkg ?? '']?.[digest ?? '']
      if (manifest === undefined) return new Response('', {status: 404})
      return new Response(JSON.stringify(manifest), {status: 200})
    }

    // GitHub package versions list (specified-user form).
    const listMatch = url.pathname.match(/^\/users\/([^/]+)\/packages\/container\/([^/]+)\/versions$/)
    if (listMatch !== null && method === 'GET') {
      const [, owner, pkg = ''] = listMatch
      if (owner !== OWNER) return new Response('', {status: 404})
      const all = this.versions[pkg] ?? []
      const records = all.map(v => ({id: v.id, name: v.digest, metadata: {container: {tags: v.tags}}}))
      if (this.listPageSize === null) return new Response(JSON.stringify(records), {status: 200})
      const page = Number(url.searchParams.get('page') ?? '1')
      const start = (page - 1) * this.listPageSize
      const slice = records.slice(start, start + this.listPageSize)
      const headers = new Headers()
      if (start + this.listPageSize < records.length) {
        headers.set(
          'link',
          `<https://api.github.com/users/${OWNER}/packages/container/${pkg}/versions?per_page=${this.listPageSize}&page=${page + 1}>; rel="next"`,
        )
      }
      return new Response(JSON.stringify(slice), {status: 200, headers})
    }

    // GitHub package version delete (specified-user form).
    const deleteMatch = url.pathname.match(/^\/users\/([^/]+)\/packages\/container\/([^/]+)\/versions\/(\d+)$/)
    if (deleteMatch !== null && method === 'DELETE') {
      const [, owner, pkg = '', idText] = deleteMatch
      if (owner !== OWNER) return new Response('', {status: 404})
      const id = Number(idText)
      this.deletedIds[pkg] ??= []
      this.deletedIds[pkg].push(id)
      return new Response('', {status: 204})
    }

    return new Response(JSON.stringify({message: 'Not Found'}), {status: 404})
  }
}

function fixtureRealisticPackage(
  registry: FakeRegistry,
  pkg: string,
  taggedCount: number,
  untaggedCount: number,
): void {
  const versions: FakeVersion[] = []
  for (let index = 0; index < taggedCount; index++) {
    const digest = `sha256:tagged-${pkg}-${index}`
    versions.push({id: 1000 + index, digest, tags: [`v${index}`]})
    registry.manifests[pkg] ??= {}
    registry.manifests[pkg][digest] = {mediaType: 'application/vnd.docker.distribution.manifest.v2+json'}
  }
  for (let index = 0; index < untaggedCount; index++) {
    versions.push({id: 5000 + index, digest: `sha256:untagged-${pkg}-${index}`, tags: []})
  }
  registry.versions[pkg] = versions
}

function options(registry: FakeRegistry, apply = false): Parameters<typeof pruneUntaggedPackages>[0] {
  return {token: TOKEN, apply, fetch: registry.fetch}
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

describe('prune-untagged-packages: pure contracts', () => {
  it('extracts only the rel=next Link target', () => {
    expect(nextLink(null)).toBeNull()
    expect(nextLink('<https://api.github.com/a>; rel="last"')).toBeNull()
    expect(
      nextLink('<https://api.github.com/x?page=2>; rel="next", <https://api.github.com/x?page=9>; rel="last"'),
    ).toBe('https://api.github.com/x?page=2')
  })

  it('resolves the pruner env and rejects a missing token', () => {
    expect(readPrunerEnv({}, [])).toBeNull()
    expect(readPrunerEnv({GITHUB_TOKEN: 't'}, [])).toEqual({token: 't', apply: false})
    expect(readPrunerEnv({GITHUB_TOKEN: 't'}, ['--apply'])).toEqual({token: 't', apply: true})
  })
})

// ─── Happy paths ─────────────────────────────────────────────────────────────

describe('prune-untagged-packages: dry-run', () => {
  it('paginates fully across multiple pages and reports counts without deleting', async () => {
    const registry = new FakeRegistry()
    for (const pkg of TARGET_PACKAGES) fixtureRealisticPackage(registry, pkg, 26, 55)
    registry.listPageSize = 20

    const summaries = await pruneUntaggedPackages(options(registry, false))

    expect(summaries).toHaveLength(2)
    for (const summary of summaries) {
      expect(summary.status).toBe('completed')
      expect(summary.mode).toBe('dry-run')
      expect(summary.tagged).toBe(26)
      expect(summary.untagged).toBe(55)
      expect(summary.deleted).toBe(0)
      expect(summary.skipped).toBe(55)
    }
    const deleteCalls = registry.requests.filter(request => request.method === 'DELETE')
    expect(deleteCalls).toHaveLength(0)
  })
})

describe('prune-untagged-packages: apply', () => {
  it('deletes exactly the untagged version ids and no tagged ones', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 3, 4)
    registry.versions['infra-workspace'] = []
    fixtureRealisticPackage(registry, 'infra-workspace', 3, 2)

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    const workspace = summaries.find(summary => summary.package === 'infra-workspace')
    expect(gateway?.status).toBe('completed')
    expect(gateway?.deleted).toBe(4)
    expect(workspace?.status).toBe('completed')
    expect(workspace?.deleted).toBe(2)

    expect(registry.deletedIds['infra-gateway']?.sort((a, b) => a - b)).toEqual([5000, 5001, 5002, 5003])
    expect(registry.deletedIds['infra-workspace']?.sort((a, b) => a - b)).toEqual([5000, 5001])
    // Tagged ids never appear in any DELETE call.
    const allDeleted = [
      ...(registry.deletedIds['infra-gateway'] ?? []),
      ...(registry.deletedIds['infra-workspace'] ?? []),
    ]
    expect(allDeleted.every(id => id >= 5000)).toBe(true)
  })
})

// ─── Safety gates ─────────────────────────────────────────────────────────────

describe('prune-untagged-packages: safety gates', () => {
  it('aborts and deletes nothing when a tagged manifest is a manifest list / image index', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    const firstDigest = registry.versions['infra-gateway']?.[0]?.digest ?? ''
    registry.manifests['infra-gateway']![firstDigest] = {
      mediaType: 'application/vnd.oci.image.index.v1+json',
      manifests: [{digest: 'sha256:child-1'}],
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('manifest_is_index')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
  })

  it('aborts and deletes nothing when an untagged digest is referenced as a child manifest', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    const firstDigest = registry.versions['infra-gateway']?.[0]?.digest ?? ''
    const childDigest = registry.versions['infra-gateway']?.[2]?.digest ?? '' // an untagged version's digest
    // A manifest that structurally lists a child without claiming a list media type.
    registry.manifests['infra-gateway']![firstDigest] = {
      mediaType: 'application/vnd.docker.distribution.manifest.v2+json',
      manifests: [{digest: childDigest}],
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('untagged_referenced_as_child')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
  })

  it('aborts and deletes nothing when a tagged manifest fetch fails', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    const firstDigest = registry.versions['infra-gateway']?.[0]?.digest ?? ''
    registry.override = (method, url) => {
      if (method === 'GET' && url.pathname === `/v2/${OWNER}/infra-gateway/manifests/${firstDigest}`) {
        return new Response('', {status: 500})
      }
      return undefined
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('manifest_fetch_failed')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
  })

  it('aborts on candidate-cap overflow without fetching any manifest or deleting', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 501)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('candidate_cap_exceeded')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
    const manifestCalls = registry.requests.filter(request => request.url.includes('/infra-gateway/manifests/'))
    expect(manifestCalls).toHaveLength(0)
  })

  it('aborts when a package has zero tagged versions', async () => {
    const registry = new FakeRegistry()
    registry.versions['infra-gateway'] = [{id: 5000, digest: 'sha256:untagged-only', tags: []}]
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('no_tagged_versions')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
  })

  it('aborts pagination when a page request fails and deletes nothing', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    registry.listPageSize = 1
    registry.override = (method, url) => {
      if (
        method === 'GET' &&
        url.pathname === `/users/${OWNER}/packages/container/infra-gateway/versions` &&
        url.searchParams.get('page') === '2'
      ) {
        return new Response(JSON.stringify({message: 'boom'}), {status: 500})
      }
      return undefined
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('pagination_failed')
    expect(registry.deletedIds['infra-gateway']).toEqual([])
  })

  it('stops deleting a package immediately after a failed DELETE and reports it', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    let deleteCalls = 0
    registry.override = (method, url) => {
      if (
        method === 'DELETE' &&
        url.pathname.startsWith(`/users/${OWNER}/packages/container/infra-gateway/versions/`)
      ) {
        deleteCalls += 1
        if (deleteCalls === 2) return new Response(JSON.stringify({message: 'forbidden'}), {status: 403})
      }
      return undefined
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('delete_failed')
    expect(deleteCalls).toBe(2)
    // Deletion started with 3 untagged versions; the 2nd call failed, so exactly
    // 1 deletion landed before the abort.
    expect(gateway?.tagged).toBe(2)
    expect(gateway?.untagged).toBe(3)
    expect(gateway?.deleted).toBe(1)
    expect(gateway?.skipped).toBe(2)

    const workspace = summaries.find(summary => summary.package === 'infra-workspace')
    expect(workspace?.status).toBe('completed')
    expect(workspace?.deleted).toBe(3)
  })

  it('reports zero tagged/untagged/deleted when the abort happens before enumeration completes', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 3)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 3)
    registry.listPageSize = 1
    registry.override = (method, url) => {
      if (
        method === 'GET' &&
        url.pathname === `/users/${OWNER}/packages/container/infra-gateway/versions` &&
        url.searchParams.get('page') === '2'
      ) {
        return new Response(JSON.stringify({message: 'boom'}), {status: 500})
      }
      return undefined
    }

    const summaries = await pruneUntaggedPackages(options(registry, true))

    const gateway = summaries.find(summary => summary.package === 'infra-gateway')
    expect(gateway?.status).toBe('aborted')
    expect(gateway?.abort_code).toBe('pagination_failed')
    expect(gateway?.tagged).toBe(0)
    expect(gateway?.untagged).toBe(0)
    expect(gateway?.deleted).toBe(0)
    expect(gateway?.skipped).toBe(0)
  })

  it('uses the specified-user endpoint form for every list and delete call', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 2)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 2)

    await pruneUntaggedPackages(options(registry, true))

    const githubCalls = registry.requests.filter(request => request.url.includes('api.github.com'))
    expect(githubCalls.length).toBeGreaterThan(0)
    for (const call of githubCalls) {
      expect(new URL(call.url).pathname).toMatch(/^\/users\/marcusrbrown\/packages\/container\//)
    }
    expect(githubCalls.some(call => new URL(call.url).pathname.startsWith('/user/'))).toBe(false)
  })
})

// ─── Terminal summary safety ─────────────────────────────────────────────────

describe('prune-untagged-packages: terminal summary', () => {
  it('never includes the token or manifest bodies in the summary output', async () => {
    const registry = new FakeRegistry()
    fixtureRealisticPackage(registry, 'infra-gateway', 2, 2)
    fixtureRealisticPackage(registry, 'infra-workspace', 2, 2)

    const summaries = await pruneUntaggedPackages(options(registry, false))
    const line = summaries.map(summary => JSON.stringify(summary)).join('\n')

    expect(line).not.toContain(TOKEN)
    expect(line).not.toContain('mediaType')
    expect(line).not.toContain('manifests')
  })
})
