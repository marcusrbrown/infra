import {describe, expect, it} from 'bun:test'

import {AGENT_ACTION_LAYOUT_VERSION, assertKnownKeyLayout, buildAgentKeyLayout} from './key-layout'

describe('pinned agent action S3 key layout', () => {
  it('builds canonical session, lock, and ListBucket prefixes', () => {
    const layout = buildAgentKeyLayout('marcusrbrown', 'infra', '/fro-bot-state///')

    expect(layout.sessionPrefix).toBe('fro-bot-state/github/marcusrbrown/infra/')
    expect(layout.lockKey).toBe('fro-bot-state/coordination/marcusrbrown/infra/locks/repo.json')
    expect(layout.actionLockKey).toBe('fro-bot-state/coordination/marcusrbrown/infra/locks/action.json')
    expect(layout.actionLockKey.startsWith(layout.lockPrefix)).toBe(true)
    expect(layout.listBucketPrefixes).toEqual([
      'fro-bot-state/github/marcusrbrown/infra/',
      'fro-bot-state/coordination/marcusrbrown/infra/locks/',
    ])
    expect(layout.sessionPrefix.startsWith('/')).toBe(false)
    expect(layout.sessionPrefix.endsWith('//')).toBe(false)
  })

  it('delimiter-bounds a repository prefix so a sibling repository is not covered', () => {
    const layout = buildAgentKeyLayout('owner', 'repo', 'fro-bot-state')
    const siblingSessionPrefix = 'fro-bot-state/github/owner/repo-evil/'

    expect(siblingSessionPrefix.startsWith(layout.sessionPrefix)).toBe(false)
    expect(layout.sessionPrefix).toBe('fro-bot-state/github/owner/repo/')
    expect(() => buildAgentKeyLayout('owner/repo', 'infra', 'fro-bot-state')).toThrow(/single path segment/i)
  })

  it('fails closed for an unknown action version and accepts the pinned version', () => {
    expect(assertKnownKeyLayout(AGENT_ACTION_LAYOUT_VERSION)).toBe(AGENT_ACTION_LAYOUT_VERSION)
    expect(() => assertKnownKeyLayout('fro-bot/agent@v0.0.0')).toThrow(/unknown|verified|layout/i)
  })

  it('admits only the pinned layout, tag, and SHA forms; the retired v0.96.0 layout fails closed', () => {
    expect(assertKnownKeyLayout('v0.118.2')).toBe(AGENT_ACTION_LAYOUT_VERSION)
    expect(assertKnownKeyLayout('77f2bad7d68ac38279cd0fa28f38b26a0cd15dfb')).toBe(AGENT_ACTION_LAYOUT_VERSION)
    expect(assertKnownKeyLayout('fro-bot/agent@77f2bad7d68ac38279cd0fa28f38b26a0cd15dfb')).toBe(
      AGENT_ACTION_LAYOUT_VERSION,
    )
    expect(() => assertKnownKeyLayout('fro-bot/agent@v0.96.0')).toThrow(/unknown|verified|layout/i)
    expect(() => assertKnownKeyLayout('c29ac295b8da06768b140c32e5bd0ae3aff45dc6')).toThrow(/unknown|verified|layout/i)
  })
})
