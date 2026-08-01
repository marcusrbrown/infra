import {describe, expect, it} from 'bun:test'

import {runCommand} from './gh'

describe('bounded CLI subprocesses', () => {
  it('reports a missing CLI as an actionable error', async () => {
    await expect(runCommand('/definitely/missing/gh', [], 50)).rejects.toThrow(/CLI not found/i)
  })

  it('reports a timeout separately from a non-zero exit', async () => {
    await expect(runCommand('bun', ['-e', 'await Bun.sleep(1000)'], 10)).rejects.toThrow(/timed out/i)
  })
})
