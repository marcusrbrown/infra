import {resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'

import {getOpenerCommand, KEEWEB_URL} from './open'

const cliDir = resolve(import.meta.dir, '../../..')

describe('keeweb open', () => {
  describe('getOpenerCommand', () => {
    it('returns "open" on darwin', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', {value: 'darwin', configurable: true})

      expect(getOpenerCommand()).toBe('open')

      Object.defineProperty(process, 'platform', {value: originalPlatform, configurable: true})
    })

    it('returns "xdg-open" on linux', () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, 'platform', {value: 'linux', configurable: true})

      expect(getOpenerCommand()).toBe('xdg-open')

      Object.defineProperty(process, 'platform', {value: originalPlatform, configurable: true})
    })
  })

  describe('KEEWEB_URL', () => {
    it('is the expected URL', () => {
      expect(KEEWEB_URL).toBe('https://kw.igg.ms/')
    })
  })

  describe('CLI help', () => {
    it('prints help text', async () => {
      const proc = Bun.spawn(['bun', 'src/cli.ts', 'keeweb', 'open', '--help'], {
        cwd: cliDir,
        env: {...process.env, NO_COLOR: '1'},
        stdout: 'pipe',
        stderr: 'pipe',
      })

      const [stdout, , exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])

      expect(exitCode).toBe(0)
      expect(stdout).toContain('Open KeeWeb in the default browser')
    })
  })
})
