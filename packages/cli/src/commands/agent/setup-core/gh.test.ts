import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {runCommand} from './gh'

const runCommandEnvKey = 'INFRA_RUN_COMMAND_TEST_ENV'
let envBeforeEach: string | undefined

beforeEach(() => {
  envBeforeEach = process.env[runCommandEnvKey]
})

afterEach(() => {
  if (envBeforeEach === undefined) delete process.env[runCommandEnvKey]
  else process.env[runCommandEnvKey] = envBeforeEach
})

describe('bounded CLI subprocesses', () => {
  it('reports a missing CLI as an actionable error', async () => {
    await expect(runCommand('/definitely/missing/gh', [], 50)).rejects.toThrow(/CLI not found/i)
  })

  it('reports a timeout separately from a non-zero exit', async () => {
    await expect(runCommand('bun', ['-e', 'await Bun.sleep(1000)'], 10)).rejects.toThrow(/timed out/i)
  })

  it('passes an explicit child environment without changing default inheritance', async () => {
    process.env[runCommandEnvKey] = 'default-value'

    const inherited = await runCommand(
      'bun',
      ['-e', `process.stdout.write(process.env.${runCommandEnvKey} ?? '')`],
      1_000,
    )
    const explicit = await runCommand(
      'bun',
      ['-e', `process.stdout.write(process.env.${runCommandEnvKey} ?? '')`],
      1_000,
      undefined,
      {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? '',
        [runCommandEnvKey]: 'explicit-value',
      },
    )

    expect(inherited.stdout).toBe('default-value')
    expect(explicit.stdout).toBe('explicit-value')
  })

  it('redacts exact credential values from captured stdout and stderr', async () => {
    const accessKey = 'agent-access-redaction-fixture'
    const secretKey = 'agent-secret-redaction-fixture'
    const sessionToken = 'agent-session-redaction-fixture'
    const stdout = `stdout:${accessKey}:${secretKey}:${sessionToken}`
    const stderr = `stderr:${sessionToken}:${secretKey}:${accessKey}`
    const child = await runCommand(
      'bun',
      ['-e', `process.stdout.write(${JSON.stringify(stdout)}); process.stderr.write(${JSON.stringify(stderr)})`],
      1_000,
      undefined,
      {PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? ''},
      [accessKey, secretKey, sessionToken],
    )

    expect(child.stdout).toBe('stdout:[REDACTED]:[REDACTED]:[REDACTED]')
    expect(child.stderr).toBe('stderr:[REDACTED]:[REDACTED]:[REDACTED]')
    expect(child.stdout).not.toContain(accessKey)
    expect(child.stdout).not.toContain(secretKey)
    expect(child.stdout).not.toContain(sessionToken)
    expect(child.stderr).not.toContain(accessKey)
    expect(child.stderr).not.toContain(secretKey)
    expect(child.stderr).not.toContain(sessionToken)
  })

  it('does not include redacted values in operation errors', async () => {
    const credential = 'agent-operation-redaction-fixture'
    const failure = await runCommand('/definitely/missing/aws', [credential], 50, undefined, {}, [credential]).catch(
      error => error,
    )

    expect(failure).toBeInstanceOf(Error)
    expect(failure instanceof Error ? failure.message : '').not.toContain(credential)
  })
})
