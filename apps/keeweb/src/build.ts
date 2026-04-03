#!/usr/bin/env bun

import path from 'node:path'

const KEEWEB_VERSION = '1.18.7'
const DOWNLOAD_URL = 'https://github.com/keeweb/keeweb/releases/download/v1.18.7/KeeWeb-1.18.7.html.zip'

const ZIP_FILENAME = `KeeWeb-${KEEWEB_VERSION}.html.zip`

const rootDir = path.resolve(import.meta.dir, '..')
const cacheDir = path.join(rootDir, '.cache')
const zipPath = path.join(cacheDir, ZIP_FILENAME)
const distDir = path.join(rootDir, 'dist')
const configTemplatePath = path.join(rootDir, 'config', 'config.json')
const nginxTemplatePath = path.join(rootDir, 'config', 'kw.igg.ms.conf')
const distConfigPath = path.join(distDir, 'config.json')
const distNginxPath = path.join(distDir, 'kw.igg.ms.conf')

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

async function streamToText(stream?: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) {
    return ''
  }

  return await new Response(stream).text()
}

async function runCommand(command: string[], context: string): Promise<void> {
  const proc = Bun.spawn(command, {
    cwd: rootDir,
    stderr: 'pipe',
    stdout: 'pipe',
  })

  const exitCode = await proc.exited
  if (exitCode === 0) {
    return
  }

  const [stdout, stderr] = await Promise.all([streamToText(proc.stdout), streamToText(proc.stderr)])

  const details = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n')
  throw new Error(`${context} failed (exit ${exitCode})${details ? `:\n${details}` : ''}`)
}

async function ensureRequiredFiles(): Promise<void> {
  if (!(await Bun.file(configTemplatePath).exists())) {
    throw new Error(`Missing required file: ${configTemplatePath}`)
  }

  if (!(await Bun.file(nginxTemplatePath).exists())) {
    throw new Error(`Missing required file: ${nginxTemplatePath}`)
  }
}

async function ensureCachedArchive(): Promise<void> {
  logStep('Ensuring cache directory exists')
  await runCommand(['mkdir', '-p', cacheDir], 'Creating cache directory')

  if (await Bun.file(zipPath).exists()) {
    logStep(`Using cached archive: ${ZIP_FILENAME}`)
    return
  }

  logStep(`Downloading KeeWeb v${KEEWEB_VERSION} archive`)
  const response = await fetch(DOWNLOAD_URL)
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText} (${DOWNLOAD_URL})`)
  }

  await Bun.write(zipPath, response)
  logSuccess(`Downloaded and cached ${ZIP_FILENAME}`)
}

async function extractArchive(): Promise<void> {
  logStep('Rebuilding dist directory')
  await runCommand(['rm', '-rf', distDir], 'Clearing dist directory')
  await runCommand(['mkdir', '-p', distDir], 'Creating dist directory')

  logStep('Extracting KeeWeb archive')
  await runCommand(['unzip', '-q', '-o', zipPath, '-d', distDir], 'Extracting archive')

  if (!(await Bun.file(path.join(distDir, 'index.html')).exists())) {
    throw new Error('Archive extracted, but dist/index.html is missing')
  }
}

async function writeConfigWithSecret(): Promise<void> {
  logStep('Injecting DROPBOX_APP_SECRET into dist/config.json')

  const raw = await Bun.file(configTemplatePath).text()
  let config: Record<string, unknown>

  try {
    config = JSON.parse(raw) as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`Failed to parse ${configTemplatePath}: ${message}`)
  }

  const settings =
    typeof config.settings === 'object' && config.settings !== null ? (config.settings as Record<string, unknown>) : {}

  settings.dropboxSecret = process.env.DROPBOX_APP_SECRET || ''
  config.settings = settings

  await Bun.write(distConfigPath, `${JSON.stringify(config, null, 2)}\n`)
}

async function copyNginxConfig(): Promise<void> {
  logStep('Copying nginx config into dist')
  await Bun.write(distNginxPath, Bun.file(nginxTemplatePath))
}

async function main(): Promise<void> {
  logStep(`Starting KeeWeb build for v${KEEWEB_VERSION}`)

  await ensureRequiredFiles()
  await ensureCachedArchive()
  await extractArchive()
  await writeConfigWithSecret()
  await copyNginxConfig()

  logSuccess(`Build complete: ${distDir}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  logError(message)
  process.exit(1)
})
