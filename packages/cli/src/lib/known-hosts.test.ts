import * as nodeFs from 'node:fs'
import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {afterEach, describe, expect, it, spyOn} from 'bun:test'

import {buildKnownHostsArgs, resolveKnownHostsPath, resolveRepoKnownHostsPath} from './known-hosts'

// ─── resolveRepoKnownHostsPath ────────────────────────────────────────────────

describe('resolveRepoKnownHostsPath', () => {
  it('returns the path to .github/known_hosts when it exists at the repo root', () => {
    // The actual repo has .github/known_hosts — this test runs from the repo root
    const result = resolveRepoKnownHostsPath()

    expect(result).not.toBeNull()
    expect(result).toMatch(/\.github[/\\]known_hosts$/)
    if (result) expect(existsSync(result)).toBe(true)
  })

  it('returns null when a custom base path has no .github/known_hosts', () => {
    const tmpDir = join(tmpdir(), `known-hosts-test-${Date.now()}`)
    mkdirSync(tmpDir, {recursive: true})

    try {
      const result = resolveRepoKnownHostsPath(tmpDir)
      expect(result).toBeNull()
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('returns the path when a custom base path has .github/known_hosts', () => {
    const tmpDir = join(tmpdir(), `known-hosts-test-${Date.now()}`)
    const githubDir = join(tmpDir, '.github')
    mkdirSync(githubDir, {recursive: true})
    writeFileSync(join(githubDir, 'known_hosts'), 'example.com ssh-ed25519 AAAA...\n')

    try {
      const result = resolveRepoKnownHostsPath(tmpDir)
      expect(result).not.toBeNull()
      expect(result).toBe(join(tmpDir, '.github', 'known_hosts'))
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── resolveKnownHostsPath (multi-layout resolution) ─────────────────────────

describe('resolveKnownHostsPath', () => {
  it('returns .github/known_hosts when running from repo checkout (Layout 1)', () => {
    // The actual repo has .github/known_hosts — no libDir override needed
    const result = resolveKnownHostsPath()

    expect(result).toMatch(/\.github[/\\]known_hosts$/)
    expect(existsSync(result)).toBe(true)
  })

  it('prefers .github/known_hosts over asset path when both exist (repo checkout layout)', () => {
    // Mirror the real layout: packages/cli/src/lib is 4 levels deep from repo root.
    // tmpDir is the "repo root"; libDir is tmpDir/packages/cli/src/lib.
    const tmpDir = join(tmpdir(), `known-hosts-both-${Date.now()}`)
    const libDir = join(tmpDir, 'packages', 'cli', 'src', 'lib')
    const githubDir = join(tmpDir, '.github')
    mkdirSync(libDir, {recursive: true})
    mkdirSync(githubDir, {recursive: true})
    writeFileSync(join(githubDir, 'known_hosts'), 'repo.example.com ssh-ed25519 AAAA...\n')

    try {
      // lib is at tmpDir/packages/cli/src/lib — 4 levels up is tmpDir (the "repo root")
      const result = resolveKnownHostsPath(libDir)
      expect(result).not.toBeNull()
      // Should prefer .github/known_hosts (repo checkout)
      expect(result).toBe(join(githubDir, 'known_hosts'))
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  // ── Asset-path (Layout 2) tests ──────────────────────────────────────────────
  // The file-asset import `knownHostsAssetPath` is a module-level constant resolved
  // by Bun at source-run time to the real src/resources/known_hosts path.
  // Under `bun build`, the bundler copies the asset to dist/ and rewrites the path.
  // We test the asset branch by mocking existsSync so Layout 1 (repo candidate) is
  // absent but the asset path is present.

  describe('asset-path (Layout 2) branch', () => {
    let existsSyncSpy: ReturnType<typeof spyOn>

    afterEach(() => {
      existsSyncSpy?.mockRestore()
    })

    it('returns the file-asset path when the repo candidate is absent but the asset exists', () => {
      // The real asset path is packages/cli/src/resources/known_hosts (exists on disk).
      // We mock existsSync so the repo candidate returns false, asset path returns true.
      // Capture the original before spying to avoid infinite recursion in the mock.
      const originalExistsSync = nodeFs.existsSync
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((p: unknown) => {
        const path = String(p)
        // Suppress Layout 1 (repo .github/known_hosts) so we fall through to Layout 2
        if (path.includes('.github') && path.endsWith('known_hosts')) return false
        // Let the real asset path through (call original, not the spy)
        return originalExistsSync(path)
      })

      const result = resolveKnownHostsPath()

      // Should return the asset path (src/resources/known_hosts)
      expect(result).toMatch(/resources[/\\]known_hosts$/)
      expect(existsSync(result)).toBe(true)
      // Must NOT be a system known_hosts path
      expect(result).not.toMatch(/\.ssh/)
      expect(result).not.toMatch(/\/etc\//)
    })

    it('throws FAIL_CLOSED_ERROR when neither repo candidate nor asset path exists (SECURITY)', () => {
      // Both Layout 1 and Layout 2 absent → must throw, never fall back to system paths
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((_p: unknown) => false)

      expect(() => resolveKnownHostsPath()).toThrow(
        'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout',
      )
    })

    it('SECURITY: never returns a ~/.ssh or system path when resolution fails', () => {
      existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((_p: unknown) => false)

      let threw = false
      let result: string | undefined
      try {
        result = resolveKnownHostsPath()
      } catch {
        threw = true
      }

      // Must throw — never silently return a system path
      expect(threw).toBe(true)
      expect(result).toBeUndefined()
    })
  })

  it('returns asset path when libDir points to a temp dir (Layout 1 miss, Layout 2 hit)', () => {
    // With libDir pointing to a temp dir, Layout 1 won't find .github/known_hosts.
    // Layout 2 uses the module-level asset path (real src/resources/known_hosts),
    // which DOES exist on disk — so it should return the asset path.
    const tmpDir = join(tmpdir(), `known-hosts-none-${Date.now()}`)
    const libDir = join(tmpDir, 'src', 'lib')
    mkdirSync(libDir, {recursive: true})

    try {
      const result = resolveKnownHostsPath(libDir)
      // Layout 2 (asset path) should be found since src/resources/known_hosts exists
      expect(result).toMatch(/resources[/\\]known_hosts$/)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── buildKnownHostsArgs ──────────────────────────────────────────────────────

describe('buildKnownHostsArgs', () => {
  it('returns UserKnownHostsFile args when .github/known_hosts exists at repo root', () => {
    const args = buildKnownHostsArgs()

    // The actual repo has .github/known_hosts
    expect(args).toHaveLength(2)
    expect(args[0]).toBe('-o')
    expect(args[1]).toMatch(/^UserKnownHostsFile=/)
    expect(args[1]).toMatch(/\.github[/\\]known_hosts$/)
  })

  it('throws when no known_hosts file exists (fail-closed behavior)', () => {
    const existsSyncSpy = spyOn(nodeFs, 'existsSync').mockImplementation((_p: unknown) => false)

    try {
      expect(() => buildKnownHostsArgs()).toThrow(
        'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout',
      )
    } finally {
      existsSyncSpy.mockRestore()
    }
  })

  it('returns UserKnownHostsFile args pointing to the custom base path (repo checkout)', () => {
    // Mirror the real layout: packages/cli/src/lib is 4 levels deep from repo root.
    const tmpDir = join(tmpdir(), `known-hosts-test-${Date.now()}`)
    const libDir = join(tmpDir, 'packages', 'cli', 'src', 'lib')
    const githubDir = join(tmpDir, '.github')
    mkdirSync(libDir, {recursive: true})
    mkdirSync(githubDir, {recursive: true})
    writeFileSync(join(githubDir, 'known_hosts'), 'example.com ssh-ed25519 AAAA...\n')

    try {
      const args = buildKnownHostsArgs(libDir)
      expect(args).toHaveLength(2)
      expect(args[0]).toBe('-o')
      expect(args[1]).toBe(`UserKnownHostsFile=${join(githubDir, 'known_hosts')}`)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })
})

// ─── Drift guard: packaged resource matches .github/known_hosts ───────────────

describe('packaged known_hosts resource drift guard', () => {
  const REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..')
  const REPO_KNOWN_HOSTS = join(REPO_ROOT, '.github', 'known_hosts')
  const PACKAGED_RESOURCE = resolve(import.meta.dir, '..', 'resources', 'known_hosts')

  it('src/resources/known_hosts exists in the package source tree', () => {
    expect(existsSync(PACKAGED_RESOURCE)).toBe(true)
  })

  it('src/resources/known_hosts matches .github/known_hosts (no drift)', async () => {
    const repoContent = await Bun.file(REPO_KNOWN_HOSTS).text()
    const packagedContent = await Bun.file(PACKAGED_RESOURCE).text()
    expect(packagedContent).toBe(repoContent)
  })
})
