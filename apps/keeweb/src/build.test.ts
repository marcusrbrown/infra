import {mkdtemp, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {afterEach, describe, expect, it, mock, spyOn} from 'bun:test'

import {ensureCachedArchive, verifyArchiveHash, writeConfigWithSecret} from './build'

const fixturePath = resolve(import.meta.dir, '__fixtures__', 'test-archive.zip')
const realConfigTemplatePath = resolve(import.meta.dir, '..', 'config', 'config.json')
const buildSourcePath = resolve(import.meta.dir, 'build.ts')
const fixtureHash = '71df78439803ab305dcddeab03cd5e75a989f973bbe33caa2da78195abe0022a'
const originalFetch = globalThis.fetch
const originalDropboxSecret = process.env.DROPBOX_APP_SECRET
const tempDirs = new Set<string>()

let digestSpy: ReturnType<typeof spyOn> | undefined

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'keeweb-build-test-'))
  tempDirs.add(dir)
  return dir
}

async function copyFixture(targetPath: string): Promise<void> {
  await Bun.write(targetPath, Bun.file(fixturePath))
}

async function readBuildExpectedHash(): Promise<string> {
  const source = await Bun.file(buildSourcePath).text()
  const match = source.match(/const EXPECTED_SHA256 = '([a-f0-9]+)'/)
  const hash = match?.[1]

  if (!hash) {
    throw new Error('Could not read EXPECTED_SHA256 from build.ts')
  }

  return hash
}

function setFetchMock(implementation: (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>): void {
  globalThis.fetch = mock(implementation) as unknown as typeof fetch
}

function mockDigestHex(hex: string): void {
  const implementation = ((value?: string | Uint8Array) => {
    if (typeof value === 'string') {
      return hex
    }

    if (value) {
      return value
    }

    return new TextEncoder().encode(hex)
  }) as unknown as typeof Bun.CryptoHasher.prototype.digest

  digestSpy = spyOn(Bun.CryptoHasher.prototype, 'digest')
  digestSpy.mockImplementation(implementation)
}

afterEach(async () => {
  digestSpy?.mockRestore()
  digestSpy = undefined
  globalThis.fetch = originalFetch

  if (originalDropboxSecret === undefined) {
    delete process.env.DROPBOX_APP_SECRET
  } else {
    process.env.DROPBOX_APP_SECRET = originalDropboxSecret
  }

  await Promise.all([...tempDirs].map(dir => rm(dir, {recursive: true, force: true})))
  tempDirs.clear()
})

describe('verifyArchiveHash', () => {
  it('accepts an archive with the expected SHA-256', async () => {
    const tempDir = await createTempDir()
    const archivePath = join(tempDir, 'archive.zip')

    await copyFixture(archivePath)

    await verifyArchiveHash(archivePath, fixtureHash)
    expect(await Bun.file(archivePath).exists()).toBe(true)
  })

  it('deletes the archive and throws on SHA-256 mismatch', async () => {
    const tempDir = await createTempDir()
    const archivePath = join(tempDir, 'archive.zip')

    await copyFixture(archivePath)

    expect(verifyArchiveHash(archivePath, 'deadbeef')).rejects.toThrow('SHA-256 mismatch')
    expect(await Bun.file(archivePath).exists()).toBe(false)
  })

  it('throws for a non-existent archive path', async () => {
    const tempDir = await createTempDir()

    expect(verifyArchiveHash(join(tempDir, 'missing.zip'), fixtureHash)).rejects.toThrow()
  })
})

describe('writeConfigWithSecret', () => {
  it('injects DROPBOX_APP_SECRET into the output config without mutating the template', async () => {
    const tempDir = await createTempDir()
    const tempTemplatePath = join(tempDir, 'config.template.json')
    const outputPath = join(tempDir, 'dist-config.json')
    const originalRealTemplate = await Bun.file(realConfigTemplatePath).text()

    await Bun.write(tempTemplatePath, Bun.file(realConfigTemplatePath))
    const originalTempTemplate = await Bun.file(tempTemplatePath).text()
    process.env.DROPBOX_APP_SECRET = 'test-secret-value'

    await writeConfigWithSecret({configTemplatePath: tempTemplatePath, distConfigPath: outputPath})

    const output = JSON.parse(await Bun.file(outputPath).text()) as {
      settings?: {dropboxSecret?: string}
    }

    expect(output.settings?.dropboxSecret).toBe('test-secret-value')
    expect(await Bun.file(tempTemplatePath).text()).toBe(originalTempTemplate)
    expect(await Bun.file(realConfigTemplatePath).text()).toBe(originalRealTemplate)
  })

  it('writes an empty secret when DROPBOX_APP_SECRET is unset', async () => {
    const tempDir = await createTempDir()
    const tempTemplatePath = join(tempDir, 'config.template.json')
    const outputPath = join(tempDir, 'dist-config.json')
    const originalRealTemplate = await Bun.file(realConfigTemplatePath).text()

    await Bun.write(tempTemplatePath, Bun.file(realConfigTemplatePath))
    delete process.env.DROPBOX_APP_SECRET

    await writeConfigWithSecret({configTemplatePath: tempTemplatePath, distConfigPath: outputPath})

    const output = JSON.parse(await Bun.file(outputPath).text()) as {
      settings?: {dropboxSecret?: string}
    }

    expect(output.settings?.dropboxSecret).toBe('')
    expect(await Bun.file(tempTemplatePath).text()).toBe(await Bun.file(realConfigTemplatePath).text())
    expect(await Bun.file(realConfigTemplatePath).text()).toBe(originalRealTemplate)
  })
})

describe('ensureCachedArchive', () => {
  it('downloads the archive into the requested cache path', async () => {
    const tempDir = await createTempDir()
    const tempCacheDir = join(tempDir, '.cache')
    const tempZipPath = join(tempCacheDir, 'test-archive.zip')
    const fixtureBytes = await Bun.file(fixturePath).arrayBuffer()
    const expectedBuildHash = await readBuildExpectedHash()

    setFetchMock(() => Promise.resolve(new Response(fixtureBytes, {status: 200})))
    mockDigestHex(expectedBuildHash)

    await ensureCachedArchive({cacheDir: tempCacheDir, zipPath: tempZipPath})

    expect(await Bun.file(tempZipPath).exists()).toBe(true)
    expect(await Bun.file(tempZipPath).bytes()).toEqual(await Bun.file(fixturePath).bytes())
  })

  it('surfaces fetch failures clearly', async () => {
    const tempDir = await createTempDir()
    const tempCacheDir = join(tempDir, '.cache')
    const tempZipPath = join(tempCacheDir, 'test-archive.zip')

    setFetchMock(() => {
      throw new Error('network down')
    })

    expect(ensureCachedArchive({cacheDir: tempCacheDir, zipPath: tempZipPath})).rejects.toThrow('network down')
    expect(await Bun.file(tempZipPath).exists()).toBe(false)
  })
})
