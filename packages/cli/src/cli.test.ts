import {resolve} from 'node:path'
import {describe, expect, it} from 'bun:test'

declare const process: {
  env: Record<string, string | undefined>
}

const cliDir = resolve(import.meta.dir, '..')

async function runCli(...args: string[]) {
  const proc = Bun.spawn(['bun', 'src/cli.ts', ...args], {
    cwd: cliDir,
    env: {...process.env, NO_COLOR: '1'},
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
    expect(stdout).toContain('status')
    expect(stdout).toContain('mcp')
    // Normalize version so snapshot survives changeset bumps
    const stableOutput = stdout.replace(/infra\/\d+\.\d+\.\d+/, 'infra/x.x.x')
    expect(stableOutput).toMatchSnapshot()
  })

  it('shows keeweb deploy help with expected flags', async () => {
    const {stdout, stderr, exitCode} = await runCli('keeweb', 'deploy', '--help')

    expect(exitCode).toBe(0)
    expect(stderr).toBe('')
    expect(stdout).toContain('--local')
    expect(stdout).toContain('--nginx')
    expect(stdout).toContain('--dry-run')
  })

  it('errors on an unknown command', async () => {
    const {stderr, exitCode} = await runCli('nonexistent')

    expect(exitCode).toBe(1)
    expect(stderr).toContain('Unknown command')
  })

  it('exits non-zero and prints an error for an invalid option', async () => {
    const {stdout, stderr, exitCode} = await runCli('keeweb', 'deploy', '--bogus')

    expect(exitCode).not.toBe(0)
    expect(stdout).toBe('')
    expect(stderr).toContain('--bogus')
  })
})
