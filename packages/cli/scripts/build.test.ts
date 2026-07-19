/**
 * Build script integration tests.
 *
 * These tests run the real Bun.build and assert the dist/ outputs.
 * They are intentionally slow (real bundler invocation) — each test
 * gets a generous timeout.
 *
 * NOTE: We invoke the build script as a subprocess (Bun.spawn) rather than
 * importing the build() function directly. This avoids a Bun 1.3.x test-runner
 * quirk where importing a module that calls Bun.build() causes the test runner
 * to attempt to resolve the build entrypoints as part of its own module graph,
 * producing spurious "Could not resolve" errors even though the files exist.
 * Running the build as a subprocess sidesteps this entirely.
 */

import {existsSync, mkdirSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'

import {afterAll, beforeAll, describe, expect, it} from 'bun:test'

// ── Paths ─────────────────────────────────────────────────────────────────────

const pkgDir = resolve(import.meta.dir, '..')
const distDir = join(pkgDir, 'dist')
const srcDir = join(pkgDir, 'src')

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Run the build script as a subprocess to avoid Bun test-runner module-graph
  // resolution quirks when Bun.build() is called inside an imported module.
  const proc = Bun.spawn(['bun', 'run', 'scripts/build.ts'], {
    cwd: pkgDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    const stdout = await new Response(proc.stdout).text()
    throw new Error(`Build failed (exit ${exitCode}):\n${stdout}\n${stderr}`)
  }
}, 60_000)

afterAll(() => {
  // Leave dist/ in place — it's gitignored build output.
  // Cleaning here would break incremental dev workflows.
})

// ── Happy path ────────────────────────────────────────────────────────────────

describe('dist/cli.js', () => {
  it('exists', () => {
    expect(existsSync(join(distDir, 'cli.js'))).toBe(true)
  })

  it('starts with the bun shebang', async () => {
    const text = await Bun.file(join(distDir, 'cli.js')).text()
    expect(text.startsWith('#!/usr/bin/env bun')).toBe(true)
  })

  it('is executable', () => {
    const mode = statSync(join(distDir, 'cli.js')).mode
    // At least one of owner/group/other exec bits must be set
    expect(mode & 0o111).toBeGreaterThan(0)
  })
})

describe('known_hosts asset', () => {
  it('is present in dist/', () => {
    // Bun emits the asset with a content-hash suffix (e.g. known_hosts-<hash>.)
    // OR the explicit fallback copies it to dist/resources/known_hosts.
    // Either way, at least one of these must exist.
    const distFiles = Array.from(new Bun.Glob('**/*known_hosts*').scanSync({cwd: distDir, absolute: true}))
    expect(distFiles.length).toBeGreaterThan(0)
  })

  it('is byte-equal to src/resources/known_hosts', async () => {
    // Find the emitted asset in dist/
    const distFiles = Array.from(new Bun.Glob('**/*known_hosts*').scanSync({cwd: distDir, absolute: true}))
    expect(distFiles.length).toBeGreaterThan(0)

    const srcAsset = join(srcDir, 'resources', 'known_hosts')
    const srcBytes = await Bun.file(srcAsset).arrayBuffer()

    // All emitted copies must be byte-equal to the source asset
    for (const distFile of distFiles) {
      const distBytes = await Bun.file(distFile).arrayBuffer()
      expect(new Uint8Array(distBytes)).toEqual(new Uint8Array(srcBytes))
    }
  })

  it('resolves the asset when the built CLI runs from a foreign working directory', async () => {
    const foreignCwd = join(tmpdir(), `infra-cli-built-${Date.now()}`)
    mkdirSync(foreignCwd, {recursive: true})

    try {
      const proc = Bun.spawn([process.execPath, join(distDir, 'cli.js'), 'gateway', 'status'], {
        cwd: foreignCwd,
        env: {
          ...process.env,
          GATEWAY_HOST: 'localhost',
          NO_COLOR: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(`${stdout}\n${stderr}`).not.toContain(
        'Pinned SSH known_hosts file not found; reinstall @marcusrbrown/infra or run from the repo checkout',
      )
      expect(`${stdout}\n${stderr}`).toContain('SSH command failed')
      expect(exitCode).not.toBe(127)
    } finally {
      rmSync(foreignCwd, {recursive: true, force: true})
    }
  }, 60_000)
})

// ── Edge: inline/external split ───────────────────────────────────────────────

describe('dist/cli.js inline/external split', () => {
  let cliText: string

  beforeAll(async () => {
    cliText = await Bun.file(join(distDir, 'cli.js')).text()
  })

  it('does NOT contain @marcusrbrown/infra-shared import specifier', () => {
    // infra-shared must be inlined (no import/require specifier in the bundle).
    // Note: the inlined package.json JSON data contains the string as a devDependency
    // key — we check for an actual import/require call, not just any string occurrence.
    // Check for ESM `from "..."` or CJS `require("...")` import specifier.
    // Two separate checks to avoid overlapping quantifiers (regexp/no-super-linear-backtracking).
    expect(cliText).not.toMatch(/from ["']@marcusrbrown\/infra-shared/)
    expect(cliText).not.toMatch(/require\(["']@marcusrbrown\/infra-shared/)
  })

  it('retains external import specifiers for all 5 public deps', () => {
    // The 5 deps must appear as module specifiers (not inlined).
    // We check for their names in import statements / require calls.
    const externalDeps = ['@clack/prompts', '@goke/mcp', 'goke', 'string-dedent', 'zod'] as const
    for (const dep of externalDeps) {
      // Match: import ... from "dep" / import("dep") / require("dep")
      // Use a lenient check — just confirm the dep name appears as a quoted specifier.
      const escaped = dep.replaceAll('/', String.raw`\/`)
      const pattern = new RegExp(`["']${escaped}["']`)
      expect(pattern.test(cliText)).toBe(true)
    }
  })
})

// ── Edge: version display + import.meta.main ──────────────────────────────────

describe('dist/cli.js bundle integrity', () => {
  let cliText: string

  beforeAll(async () => {
    cliText = await Bun.file(join(distDir, 'cli.js')).text()
  })

  it('inlines the package version (JSON import)', async () => {
    // The package.json version is imported with {type:'json'} and should be
    // inlined as a literal string in the bundle.
    const pkgJson = (await Bun.file(join(pkgDir, 'package.json')).json()) as {version: string}
    expect(cliText).toContain(pkgJson.version)
  })

  it('entry code is present (import.meta.main guard inlined by Bun)', () => {
    // Bun evaluates `if (import.meta.main)` at build time for the entry point
    // (always true) and inlines the body directly — the guard itself is removed.
    // Assert the CLI entry code is present in the bundle instead.
    expect(cliText).toContain('cli.parse(process.argv')
    expect(cliText).toContain('cli.runMatchedCommand()')
  })
})
