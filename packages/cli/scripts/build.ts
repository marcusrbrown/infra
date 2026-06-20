#!/usr/bin/env bun

/**
 * Build script for @marcusrbrown/infra CLI.
 *
 * Bundles packages/cli into dist/ with:
 * - 5 public deps kept EXTERNAL (not inlined)
 * - @marcusrbrown/infra-shared INLINED (once Unit 4 adds the import)
 * - known_hosts file-asset copied into dist/ by Bun's asset loader
 * - Shebang + executable bit on dist/cli.js (Bun sets these automatically)
 *
 * Style mirrors apps/keeweb/src/build.ts.
 */

import {chmodSync, existsSync, mkdirSync, rmSync} from 'node:fs'
import {join, resolve} from 'node:path'

// ── Paths ─────────────────────────────────────────────────────────────────────

const pkgDir = resolve(import.meta.dir, '..')
const srcDir = join(pkgDir, 'src')
const distDir = join(pkgDir, 'dist')

// ── ANSI helpers ──────────────────────────────────────────────────────────────

const ANSI = {
  blue: '\u001B[1;34m',
  green: '\u001B[1;32m',
  red: '\u001B[1;31m',
  reset: '\u001B[0m',
}

function logStep(message: string): void {
  console.log(`${ANSI.blue}==>${ANSI.reset} ${message}`)
}

function logSuccess(message: string): void {
  console.log(`${ANSI.green}✓${ANSI.reset} ${message}`)
}

function logError(message: string): void {
  console.error(`${ANSI.red}ERROR:${ANSI.reset} ${message}`)
}

// ── External deps (kept as runtime imports in the bundle) ─────────────────────

const EXTERNAL_DEPS = ['@clack/prompts', '@goke/mcp', 'goke', 'string-dedent', 'zod'] as const

// ── Build ─────────────────────────────────────────────────────────────────────

export async function build(): Promise<void> {
  // 1. Clean dist/
  logStep('Cleaning dist/')
  if (existsSync(distDir)) {
    rmSync(distDir, {recursive: true, force: true})
  }
  mkdirSync(distDir, {recursive: true})

  // 2. Run Bun.build with two entrypoints
  logStep('Bundling CLI entrypoints')
  const result = await Bun.build({
    entrypoints: [join(srcDir, 'cli.ts'), join(srcDir, 'commands', 'vpn', 'peers.ts')],
    outdir: distDir,
    target: 'bun',
    format: 'esm',
    external: [...EXTERNAL_DEPS],
    // Bun preserves the relative structure under the common ancestor (src/).
    // With entrypoints at src/cli.ts and src/commands/vpn/peers.ts, the
    // common ancestor is src/, so outputs land at:
    //   dist/cli.js
    //   dist/commands/vpn/peers.js
    // The known_hosts file-asset is auto-copied to dist/ with a content-hash
    // suffix (e.g. known_hosts-<hash>.) and the path constant in the bundle
    // is rewritten to the dist-relative path.
  })

  if (!result.success) {
    for (const log of result.logs) {
      logError(String(log))
    }
    throw new Error('Bun.build failed — see logs above')
  }

  logSuccess(`Bundled ${result.outputs.length} output(s)`)

  // 3. Verify expected outputs exist
  const cliBin = join(distDir, 'cli.js')
  const peersOut = join(distDir, 'commands', 'vpn', 'peers.js')

  if (!existsSync(cliBin)) {
    throw new Error(`Expected output missing: ${cliBin}`)
  }
  if (!existsSync(peersOut)) {
    throw new Error(`Expected output missing: ${peersOut}`)
  }

  // 4. Shebang + exec bit
  // Bun automatically copies the shebang from src/cli.ts (which starts with
  // #!/usr/bin/env bun) and sets the executable bit on the output. We verify
  // and enforce both as a safety net.
  const cliBinText = await Bun.file(cliBin).text()
  if (!cliBinText.startsWith('#!/usr/bin/env bun')) {
    logStep('Prepending shebang to dist/cli.js')
    await Bun.write(cliBin, `#!/usr/bin/env bun\n${cliBinText}`)
  }
  chmodSync(cliBin, 0o755)
  logSuccess('dist/cli.js: shebang present, executable bit set')

  // 5. Verify known_hosts asset landed in dist/
  // Bun copies the file-asset (imported with {type:'file'}) to outdir and
  // rewrites the path constant in the bundle. The emitted filename includes a
  // content-hash suffix (e.g. known_hosts-<hash>.).
  const assetFiles = result.outputs.filter(o => o.kind === 'asset')
  if (assetFiles.length === 0) {
    // Fallback: Bun did not auto-copy the asset — copy it explicitly.
    logStep('known_hosts asset not auto-copied; copying explicitly')
    const srcAsset = join(srcDir, 'resources', 'known_hosts')
    const distResourcesDir = join(distDir, 'resources')
    mkdirSync(distResourcesDir, {recursive: true})
    await Bun.write(join(distResourcesDir, 'known_hosts'), Bun.file(srcAsset))
    logSuccess('Copied known_hosts to dist/resources/known_hosts (explicit fallback)')
  } else {
    for (const asset of assetFiles) {
      logSuccess(`Asset emitted: ${asset.path}`)
    }
  }

  logSuccess(`Build complete → ${distDir}`)
}

// ── Entry guard ───────────────────────────────────────────────────────────────

if (import.meta.main) {
  build().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    logError(message)
    process.exit(1)
  })
}
