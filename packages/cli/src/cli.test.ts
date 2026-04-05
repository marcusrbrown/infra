import {resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'

const cliDir = resolve(import.meta.dir, '..')

async function runCli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd: cliDir,
    stdout: 'pipe',
    stderr: 'pipe',
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])

  return {stdout, stderr, exitCode}
}

describe('infra CLI', () => {
  it('shows root help with registered top-level commands', async () => {
    const {stdout, stderr, exitCode} = await runCli('--help')

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('keeweb')
    expect(stdout).toContain('mcp')
    expect(stdout).toMatchSnapshot()
  })

  it('shows keeweb deploy help with expected flags', async () => {
    const {stdout, stderr, exitCode} = await runCli('keeweb', 'deploy', '--help')

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('--local')
    expect(stdout).toContain('--nginx')
    expect(stdout).toContain('--dry-run')
  })

  it('falls back to root help for an unknown command', async () => {
    const {stdout, stderr, exitCode} = await runCli('nonexistent')

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('Usage:')
  })

  it('exits non-zero and prints an error for an invalid option', async () => {
    const {stdout, stderr, exitCode} = await runCli('keeweb', 'deploy', '--bogus')

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('--bogus')
  })
})
