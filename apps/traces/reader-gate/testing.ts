import {Buffer} from 'node:buffer'
// Shared helpers for the gate's tests. Nothing here is loaded by the service.
import {createHash} from 'node:crypto'

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** A deterministic token of the real shape: `trc_` plus 43 base64url characters. */
export function makeToken(seed: string): string {
  return `trc_${Buffer.from(sha256Hex(`token:${seed}`), 'hex').toString('base64url')}`
}

export const DATE = '2026-11-27T00:00:00.000Z'

export function fingerprint(token: string): string {
  return sha256Hex(token).slice(0, 12)
}

export function tokenLine(token: string, consumer: string, date = DATE): string {
  return `${token} ${fingerprint(token)} ${consumer} ${date}\n`
}

export function voidLine(seed = 'void'): string {
  return `trc_void_${Buffer.from(sha256Hex(`void:${seed}`), 'hex').toString('base64url')} void ${DATE}\n`
}

export function basicHeader(user: string, secret: string): string {
  return `Basic ${Buffer.from(`${user}:${secret}`).toString('base64')}`
}
