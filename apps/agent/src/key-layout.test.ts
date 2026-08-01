import {describe, expect, it} from 'bun:test'

import {AGENT_ACTION_LAYOUT_VERSION, assertKnownKeyLayout, buildAgentKeyLayout} from './key-layout'

describe('pinned agent action S3 key layout', () => {
  it('builds canonical session, lock, and ListBucket prefixes', () => {
    const layout = buildAgentKeyLayout('marcusrbrown', 'infra', '/fro-bot-state///')

    expect(layout.sessionPrefix).toBe('fro-bot-state/github/marcusrbrown-infra/storage/')
    expect(layout.lockKey).toBe('fro-bot-state/coordination/github/marcusrbrown-infra/locks/storage.lock')
    expect(layout.listBucketPrefixes).toEqual([
      'fro-bot-state/github/marcusrbrown-infra/storage/',
      'fro-bot-state/coordination/github/marcusrbrown-infra/locks/',
    ])
    expect(layout.sessionPrefix.startsWith('/')).toBe(false)
    expect(layout.sessionPrefix.endsWith('//')).toBe(false)
  })

  it('delimiter-bounds a repository prefix so a sibling repository is not covered', () => {
    const layout = buildAgentKeyLayout('owner', 'repo', 'fro-bot-state')
    const siblingSessionPrefix = 'fro-bot-state/github/owner-repo-evil/storage/'

    expect(siblingSessionPrefix.startsWith(layout.sessionPrefix)).toBe(false)
    expect(layout.sessionPrefix).toBe('fro-bot-state/github/owner-repo/storage/')
    expect(() => buildAgentKeyLayout('owner/repo', 'infra', 'fro-bot-state')).toThrow(/single path segment/i)
  })

  it('fails closed for an unknown action version and accepts the pinned version', () => {
    expect(assertKnownKeyLayout(AGENT_ACTION_LAYOUT_VERSION)).toBe(AGENT_ACTION_LAYOUT_VERSION)
    expect(() => assertKnownKeyLayout('fro-bot/agent@v0.0.0')).toThrow(/unknown|verified|layout/i)
  })
})
