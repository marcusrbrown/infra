import {readFileSync} from 'node:fs'
import {describe, expect, test} from 'bun:test'

import {GO_LIVE_MODELS_URL, LiveModelsError, parseLiveModels} from './live-models'

const payload = (): {object: string; data: Record<string, unknown>[]} =>
  JSON.parse(readFileSync(new URL('__fixtures__/live-models.json', import.meta.url), 'utf8'))

const withEntry = (change: (entry: Record<string, unknown>) => void, index = 0) => {
  const body = payload()
  const entry = body.data[index]
  if (entry === undefined) throw new Error('fixture has no such entry')
  change(entry)
  return body
}

describe('parseLiveModels', () => {
  test('reads the three privacy booleans of every model in the pinned response', () => {
    const models = parseLiveModels(payload())
    expect(models).toHaveLength(31)
    expect(models.find(model => model.id === 'beam-free')).toEqual({
      id: 'beam-free',
      name: 'Beam Free',
      training: false,
      zdr: false,
      limitedRegions: true,
    })
    expect(models.find(model => model.id === 'deepseek-v4.1-flash')).toEqual({
      id: 'deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash 1017',
      training: false,
      zdr: true,
      limitedRegions: false,
    })
  })

  test('ignores fields it does not read, so the API can add them', () => {
    const body = withEntry(entry => {
      entry.brand_new_field = {anything: true}
      const go = entry.go as Record<string, unknown>
      go.another_new_field = 'x'
    })
    expect(parseLiveModels(body)).toHaveLength(31)
  })

  test('the endpoint is the unauthenticated Go models list', () => {
    expect(GO_LIVE_MODELS_URL).toBe('https://opencode.ai/inference/go/v1/models')
  })
})

describe('parseLiveModels fails closed', () => {
  test('on an entry with no go object, which upstream says happens when its data source is down', () => {
    const body = withEntry(entry => {
      delete entry.go
    })
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
    expect(() => parseLiveModels(body)).toThrow(/deepseek-v4\.1-flash.*no go privacy object/)
  })

  test('on a go value that is null or not an object', () => {
    expect(() =>
      parseLiveModels(
        withEntry(entry => {
          entry.go = null
        }),
      ),
    ).toThrow(LiveModelsError)
    expect(() =>
      parseLiveModels(
        withEntry(entry => {
          entry.go = 'zdr'
        }),
      ),
    ).toThrow(LiveModelsError)
  })

  test.each(['training', 'zdr', 'limited_regions'])('on a go object missing %s', field => {
    const body = withEntry(entry => {
      delete (entry.go as Record<string, unknown>)[field]
    })
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
    expect(() => parseLiveModels(body)).toThrow(new RegExp(String.raw`go\.${field}`))
  })

  test.each([
    ['a string', 'false'],
    ['a number', 0],
    ['null', null],
  ])('on a privacy field that is %s instead of a boolean', (_label, value) => {
    for (const field of ['training', 'zdr', 'limited_regions']) {
      const body = withEntry(entry => {
        ;(entry.go as Record<string, unknown>)[field] = value
      })
      expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
    }
  })

  test('on an entry with no usable id or name', () => {
    expect(() =>
      parseLiveModels(
        withEntry(entry => {
          delete entry.id
        }),
      ),
    ).toThrow(LiveModelsError)
    expect(() =>
      parseLiveModels(
        withEntry(entry => {
          entry.id = 'Not A Valid Id'
        }),
      ),
    ).toThrow(LiveModelsError)
    expect(() =>
      parseLiveModels(
        withEntry(entry => {
          entry.name = ''
        }),
      ),
    ).toThrow(LiveModelsError)
  })

  test('without echoing an over-long id, which is checked for length before it is used in a message', () => {
    const body = withEntry(entry => {
      entry.id = 'a'.repeat(5000)
      delete entry.go
    })
    let message = ''
    try {
      parseLiveModels(body)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('no go privacy object')
    expect(message).not.toContain('aaaaaaaaaa')
    expect(message.length).toBeLessThan(200)
  })

  test('on a duplicate id', () => {
    const body = payload()
    body.data.push(structuredClone(body.data[0] ?? {}))
    expect(() => parseLiveModels(body)).toThrow(/duplicate/i)
  })

  test.each([
    ['null', null],
    ['an array', []],
    ['no data field', {object: 'list'}],
    ['a data field that is not an array', {object: 'list', data: {}}],
    ['an empty list', {object: 'list', data: []}],
    ['another object type', {object: 'collection', data: [{id: 'x'}]}],
  ])('on a response that is %s', (_label, body) => {
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
  })

  test('without echoing a rejected value', () => {
    const body = withEntry(entry => {
      ;(entry.go as Record<string, unknown>).zdr = 'sentinel-secret-value'
    })
    expect(() => parseLiveModels(body)).not.toThrow(/sentinel-secret-value/)
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
  })
})
