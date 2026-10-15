import {describe, expect, it} from 'bun:test'

import {assertKnownKeyLayout, buildAgentKeyLayout, KEY_LAYOUT_VERSION} from './key-layout'

describe('agent S3 key layout', () => {
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

  it('labels the layout by its own contract, not by an Action version', () => {
    expect(KEY_LAYOUT_VERSION).toBe('fro-bot-agent-s3-layout/1')
    expect(buildAgentKeyLayout('owner', 'repo', 'fro-bot-state').layoutVersion).toBe(KEY_LAYOUT_VERSION)
  })

  it('accepts the current label and the legacy manifest labels that describe the same layout', () => {
    expect(assertKnownKeyLayout(KEY_LAYOUT_VERSION)).toBe(KEY_LAYOUT_VERSION)
    expect(assertKnownKeyLayout(` ${KEY_LAYOUT_VERSION} `)).toBe(KEY_LAYOUT_VERSION)
    expect(assertKnownKeyLayout('fro-bot/agent@v0.118.2')).toBe(KEY_LAYOUT_VERSION)
    expect(assertKnownKeyLayout('fro-bot/agent@v0.119.2')).toBe(KEY_LAYOUT_VERSION)
  })

  it('fails closed for unknown labels, the retired v0.96.0 layout (no Action lock grant), and bare refs or SHAs', () => {
    for (const label of [
      '',
      'fro-bot/agent@v0.0.0',
      'fro-bot/agent@v0.96.0',
      'fro-bot-agent-s3-layout/2',
      'v0.119.2',
      '83ed683da24111bd1474eb4bda39715ed5799bc2',
      'fro-bot/agent@7d273ac643c8f9c0dc8615222677693dc337adef',
    ]) {
      expect(() => assertKnownKeyLayout(label), label).toThrow(/unknown key layout/i)
    }
  })

  it('builds the identical layout for any repository regardless of the Action version in use', () => {
    // Pinned output: the layout is the Action's S3 key contract. A change here is a re-provision event.
    expect(buildAgentKeyLayout('marcusrbrown', 'infra', 'fro-bot-state')).toEqual({
      layoutVersion: KEY_LAYOUT_VERSION,
      sessionPrefix: 'fro-bot-state/github/marcusrbrown/infra/',
      lockKey: 'fro-bot-state/coordination/marcusrbrown/infra/locks/repo.json',
      actionLockKey: 'fro-bot-state/coordination/marcusrbrown/infra/locks/action.json',
      lockPrefix: 'fro-bot-state/coordination/marcusrbrown/infra/locks/',
      listBucketPrefixes: [
        'fro-bot-state/github/marcusrbrown/infra/',
        'fro-bot-state/coordination/marcusrbrown/infra/locks/',
      ],
    })
  })
})
