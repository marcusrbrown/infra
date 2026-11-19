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
    const {models, noPrivacy} = parseLiveModels(payload())
    expect(models).toHaveLength(31)
    expect(noPrivacy).toEqual([])
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
    expect(parseLiveModels(body).models).toHaveLength(31)
  })

  test('the endpoint is the unauthenticated Go models list', () => {
    expect(GO_LIVE_MODELS_URL).toBe('https://opencode.ai/inference/go/v1/models')
  })
})

describe('parseLiveModels fails closed', () => {
  test.each([
    ['a string', 'zdr'],
    ['an array', []],
    ['a number', 1],
    ['true', true],
    ['an empty object', {}],
  ])('on a go value that is present but is %s: the contract changed, so every entry is suspect', (_label, go) => {
    const body = withEntry(entry => {
      entry.go = go
    })
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
    expect(() => parseLiveModels(body)).toThrow(/deepseek-v4\.1-flash/)
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
    })
    let message = ''
    try {
      parseLiveModels(body)
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('is invalid')
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

describe('parseLiveModels on entries with no go object', () => {
  const without = (...indexes: number[]) => {
    const body = payload()
    for (const index of indexes) delete body.data[index]?.go
    return body
  }
  /** The first `count` entries lose their go object. */
  const firstWithout = (count: number) => without(...Array.from({length: count}, (_, i) => i))

  test('one entry without go is set aside, not an error, and the other 30 keep their privacy fields', () => {
    const {models, noPrivacy} = parseLiveModels(without(0))
    expect(models).toHaveLength(30)
    expect(models.some(model => model.id === 'deepseek-v4.1-flash')).toBe(false)
    expect(noPrivacy).toEqual([{id: 'deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash 1017'}])
  })

  test('go: null is the same as an absent go object', () => {
    const body = withEntry(entry => {
      entry.go = null
    })
    expect(parseLiveModels(body).noPrivacy.map(item => item.id)).toEqual(['deepseek-v4.1-flash'])
  })

  test('an entry that carries only OpenAI’s fields, as upstream documents for a data-source outage, is set aside', () => {
    const body = payload()
    body.data[0] = {
      id: 'deepseek-v4.1-flash',
      object: 'model',
      created: 1,
      owned_by: 'opencode',
      name: 'deepseek-v4.1-flash',
    }
    expect(parseLiveModels(body).noPrivacy).toEqual([{id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash'}])
  })

  test('a set-aside entry never becomes a model with default values', () => {
    const {models} = parseLiveModels(without(0, 1, 2))
    expect(models.map(model => model.id)).not.toContain('deepseek-v4.1-flash')
    expect(models).toHaveLength(28)
  })

  test('an entry without go still needs a valid id and name, and a unique id', () => {
    const noGo = (change: (entry: Record<string, unknown>) => void) =>
      withEntry(entry => {
        delete entry.go
        change(entry)
      })
    expect(() => parseLiveModels(noGo(entry => (entry.id = 'Not A Valid Id')))).toThrow(LiveModelsError)
    expect(() => parseLiveModels(noGo(entry => (entry.name = '')))).toThrow(LiveModelsError)
    const body = without(0)
    body.data.push({...body.data[1], id: 'deepseek-v4.1-flash'})
    expect(() => parseLiveModels(body)).toThrow(/duplicate/i)
  })

  test('every entry without go is an outage, and throws', () => {
    const body = firstWithout(31)
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
    expect(() => parseLiveModels(body)).toThrow(/no entry has a go object/)
  })

  test('exactly half without go is a gap and is set aside; one more is an outage and throws', () => {
    const half = parseLiveModels(firstWithout(15))
    expect(half.models).toHaveLength(16)
    expect(half.noPrivacy).toHaveLength(15)
    const over = firstWithout(16)
    expect(() => parseLiveModels(over)).toThrow(/more than half/)
  })

  test('the boundary follows the size of the list', () => {
    const small = (count: number) => ({object: 'list', data: payload().data.slice(0, count)})
    const two = small(2)
    delete two.data[0]?.go
    expect(parseLiveModels(two).noPrivacy).toHaveLength(1)
    const one = small(1)
    delete one.data[0]?.go
    expect(() => parseLiveModels(one)).toThrow(LiveModelsError)
    const four = small(4)
    delete four.data[0]?.go
    delete four.data[1]?.go
    expect(parseLiveModels(four).noPrivacy).toHaveLength(2)
    delete four.data[2]?.go
    expect(() => parseLiveModels(four)).toThrow(/more than half/)
  })

  test('a malformed go object still throws even when other entries have none', () => {
    const body = without(0)
    ;(body.data[1]?.go as Record<string, unknown>).zdr = 'yes'
    expect(() => parseLiveModels(body)).toThrow(LiveModelsError)
  })
})
