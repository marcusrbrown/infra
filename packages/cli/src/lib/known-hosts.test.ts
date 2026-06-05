import {existsSync, mkdirSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {describe, expect, it} from 'bun:test'

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

// ─── resolveKnownHostsPath (new: multi-layout resolution) ────────────────────

describe('resolveKnownHostsPath', () => {
  it('returns the packaged resource path when only src/resources/known_hosts exists (installed package layout)', () => {
    // Simulate: node_modules/@marcusrbrown/infra/src/lib/known-hosts.ts
    // Only src/resources/known_hosts exists; no .github/known_hosts at any ancestor.
    const tmpDir = join(tmpdir(), `known-hosts-installed-${Date.now()}`)
    const libDir = join(tmpDir, 'node_modules', '@marcusrbrown', 'infra', 'src', 'lib')
    const resourcesDir = join(tmpDir, 'node_modules', '@marcusrbrown', 'infra', 'src', 'resources')
    mkdirSync(libDir, {recursive: true})
    mkdirSync(resourcesDir, {recursive: true})
    writeFileSync(join(resourcesDir, 'known_hosts'), 'example.com ssh-ed25519 AAAA...\n')

    try {
      // Pass the simulated import.meta.dir (the lib dir inside the package)
      const result = resolveKnownHostsPath(libDir)
      expect(result).not.toBeNull()
      expect(result).toBe(join(resourcesDir, 'known_hosts'))
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('prefers .github/known_hosts over packaged resource when both exist (repo checkout layout)', () => {
    // Mirror the real layout: packages/cli/src/lib is 4 levels deep from repo root.
    // tmpDir is the "repo root"; libDir is tmpDir/packages/cli/src/lib.
    const tmpDir = join(tmpdir(), `known-hosts-both-${Date.now()}`)
    const libDir = join(tmpDir, 'packages', 'cli', 'src', 'lib')
    const githubDir = join(tmpDir, '.github')
    const resourcesDir = join(tmpDir, 'packages', 'cli', 'src', 'resources')
    mkdirSync(libDir, {recursive: true})
    mkdirSync(githubDir, {recursive: true})
    mkdirSync(resourcesDir, {recursive: true})
    writeFileSync(join(githubDir, 'known_hosts'), 'repo.example.com ssh-ed25519 AAAA...\n')
    writeFileSync(join(resourcesDir, 'known_hosts'), 'packaged.example.com ssh-ed25519 AAAA...\n')

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

  it('throws a clear error when neither .github/known_hosts nor packaged resource exists', () => {
    const tmpDir = join(tmpdir(), `known-hosts-none-${Date.now()}`)
    const libDir = join(tmpDir, 'src', 'lib')
    mkdirSync(libDir, {recursive: true})

    try {
      expect(() => resolveKnownHostsPath(libDir)).toThrow(
        'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout',
      )
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
    const tmpDir = join(tmpdir(), `known-hosts-test-${Date.now()}`)
    const libDir = join(tmpDir, 'src', 'lib')
    mkdirSync(libDir, {recursive: true})

    try {
      expect(() => buildKnownHostsArgs(libDir)).toThrow(
        'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout',
      )
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
    }
  })

  it('returns UserKnownHostsFile args pointing to the packaged resource in installed layout', () => {
    const tmpDir = join(tmpdir(), `known-hosts-installed-${Date.now()}`)
    const libDir = join(tmpDir, 'node_modules', '@marcusrbrown', 'infra', 'src', 'lib')
    const resourcesDir = join(tmpDir, 'node_modules', '@marcusrbrown', 'infra', 'src', 'resources')
    mkdirSync(libDir, {recursive: true})
    mkdirSync(resourcesDir, {recursive: true})
    writeFileSync(join(resourcesDir, 'known_hosts'), 'example.com ssh-ed25519 AAAA...\n')

    try {
      const args = buildKnownHostsArgs(libDir)
      expect(args).toHaveLength(2)
      expect(args[0]).toBe('-o')
      expect(args[1]).toBe(`UserKnownHostsFile=${join(resourcesDir, 'known_hosts')}`)
    } finally {
      rmSync(tmpDir, {recursive: true, force: true})
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
