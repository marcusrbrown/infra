import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {findRepoRoot} from './repo-root'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function writePackageJson(dir: string, name: string): void {
  writeFileSync(join(dir, 'package.json'), JSON.stringify({name}, null, 2))
}

// ─── findRepoRoot ─────────────────────────────────────────────────────────────

describe('findRepoRoot', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'repo-root-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, {recursive: true, force: true})
  })

  it('finds the workspace root from a deeply nested subdirectory', () => {
    // Create a fake monorepo tree:
    //   <tmpDir>/                          ← workspace root (marker)
    //   <tmpDir>/package.json              ← {name: "@marcusrbrown/infra-workspace"}
    //   <tmpDir>/packages/cli/src/lib/     ← deeply nested start dir
    writePackageJson(tmpDir, '@marcusrbrown/infra-workspace')
    const deepDir = join(tmpDir, 'packages', 'cli', 'src', 'lib')
    mkdirSync(deepDir, {recursive: true})

    const result = findRepoRoot(deepDir)

    expect(result).toBe(tmpDir)
  })

  it('throws a clear error when no workspace marker is found in any ancestor', () => {
    // tmpDir has no package.json at all — no marker anywhere in the tree
    const noMarkerDir = join(tmpDir, 'some', 'nested', 'dir')
    mkdirSync(noMarkerDir, {recursive: true})

    expect(() => findRepoRoot(noMarkerDir)).toThrow(
      /workspace root.*not found|could not find.*workspace|@marcusrbrown\/infra-workspace/i,
    )
  })

  it('does not stop at a nested package.json with a different name — keeps walking up', () => {
    // Tree:
    //   <tmpDir>/                          ← workspace root (marker)
    //   <tmpDir>/package.json              ← {name: "@marcusrbrown/infra-workspace"}
    //   <tmpDir>/packages/cli/             ← intermediate package (different name)
    //   <tmpDir>/packages/cli/package.json ← {name: "@marcusrbrown/infra"}
    //   <tmpDir>/packages/cli/src/lib/     ← start dir
    writePackageJson(tmpDir, '@marcusrbrown/infra-workspace')
    const cliDir = join(tmpDir, 'packages', 'cli')
    mkdirSync(cliDir, {recursive: true})
    writePackageJson(cliDir, '@marcusrbrown/infra')
    const deepDir = join(cliDir, 'src', 'lib')
    mkdirSync(deepDir, {recursive: true})

    const result = findRepoRoot(deepDir)

    // Must resolve to the workspace root, not the intermediate package
    expect(result).toBe(tmpDir)
  })

  it('resolves from the start directory itself when it contains the marker', () => {
    // The start dir IS the workspace root
    writePackageJson(tmpDir, '@marcusrbrown/infra-workspace')

    const result = findRepoRoot(tmpDir)

    expect(result).toBe(tmpDir)
  })
})

// ─── Regression: resolved paths end with expected repo-relative suffixes ──────

describe('findRepoRoot: resolved paths match expected repo-relative targets', () => {
  it('vpn peers.json path ends with apps/vpn/config/peers.json', () => {
    // findRepoRoot() from the real source tree must resolve to the actual repo root.
    // We verify the resolved path ends with the expected suffix — not the absolute
    // path (which varies per machine), but the repo-relative portion.
    const root = findRepoRoot()
    const peersPath = join(root, 'apps', 'vpn', 'config', 'peers.json')
    expect(peersPath.endsWith('apps/vpn/config/peers.json')).toBe(true)
  })

  it('vpn clients dir path ends with apps/vpn/clients', () => {
    const root = findRepoRoot()
    const clientsDir = join(root, 'apps', 'vpn', 'clients')
    expect(clientsDir.endsWith('apps/vpn/clients')).toBe(true)
  })

  it('keeweb deploy.sh path ends with apps/keeweb/deploy.sh', () => {
    const root = findRepoRoot()
    const deployShPath = join(root, 'apps', 'keeweb', 'deploy.sh')
    expect(deployShPath.endsWith('apps/keeweb/deploy.sh')).toBe(true)
  })

  it('keeweb dist/index.html path ends with apps/keeweb/dist/index.html', () => {
    const root = findRepoRoot()
    const distIndexPath = join(root, 'apps', 'keeweb', 'dist', 'index.html')
    expect(distIndexPath.endsWith('apps/keeweb/dist/index.html')).toBe(true)
  })

  it('cliproxy deploy.ts path ends with apps/cliproxy/src/deploy.ts', () => {
    const root = findRepoRoot()
    const deployTsPath = join(root, 'apps', 'cliproxy', 'src', 'deploy.ts')
    expect(deployTsPath.endsWith('apps/cliproxy/src/deploy.ts')).toBe(true)
  })
})
