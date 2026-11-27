import {Buffer} from 'node:buffer'
import {describe, expect, test} from 'bun:test'

import {extractToken} from './auth'
import {basicHeader, makeToken} from './testing'

const token = makeToken('alice')

function headers(authorization?: string): Headers {
  return authorization === undefined ? new Headers() : new Headers({authorization})
}

describe('extractToken', () => {
  test('reads a Bearer token', () => {
    expect(extractToken(headers(`Bearer ${token}`))).toBe(token)
  })

  test('the Bearer scheme is case-insensitive', () => {
    expect(extractToken(headers(`bearer ${token}`))).toBe(token)
    expect(extractToken(headers(`BEARER ${token}`))).toBe(token)
  })

  test('reads the Basic password whatever the username is', () => {
    expect(extractToken(headers(basicHeader('reader', token)))).toBe(token)
    expect(extractToken(headers(basicHeader('', token)))).toBe(token)
    expect(extractToken(headers(basicHeader('pk-lf-anything', token)))).toBe(token)
  })

  test('a Basic password keeps every colon after the first', () => {
    expect(extractToken(headers(basicHeader('u', 'a:b:c')))).toBe('a:b:c')
  })

  test('the Basic scheme is case-insensitive', () => {
    const value = basicHeader('u', token).replace('Basic', 'basic')
    expect(extractToken(headers(value))).toBe(token)
  })

  test.each([
    ['no header', undefined],
    ['an empty header', ''],
    ['an empty Bearer', 'Bearer '],
    ['a bare Bearer', 'Bearer'],
    ['another scheme', `Digest ${token}`],
    ['a token with no scheme', token],
    ['Basic with no colon', `Basic ${Buffer.from('nocolon').toString('base64')}`],
    ['Basic with an empty password', `Basic ${Buffer.from('user:').toString('base64')}`],
    ['Basic that is not base64', 'Basic !!!not-base64!!!'],
    ['a Bearer value with a space inside', `Bearer ${token} extra`],
    ['two credentials joined by a comma', `Bearer ${token}, Basic ${Buffer.from('u:p').toString('base64')}`],
    ['an oversized header', `Bearer ${'a'.repeat(5000)}`],
  ])('returns null for %s', (_name, value) => {
    expect(extractToken(headers(value))).toBeNull()
  })
})
