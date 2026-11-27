import {Buffer} from 'node:buffer'
// Reader token extraction. MCP clients send `Authorization: Bearer <token>`. The stock Langfuse CLI sends
// `Authorization: Basic <user:secret>`, so the token may also be the Basic password. Whichever form arrives, the gate
// replaces the header with the host credential before anything is forwarded.

const MAX_HEADER_LENGTH = 1024

export function extractToken(headers: Headers): string | null {
  const value = headers.get('authorization')
  if (value === null || value.length === 0 || value.length > MAX_HEADER_LENGTH) return null

  const bearer = /^bearer +(\S+)$/i.exec(value)
  if (bearer) return bearer[1] ?? null

  const basic = /^basic +([\w+/=-]+)$/i.exec(value)
  if (!basic) return null
  const decoded = decodeBase64(basic[1] ?? '')
  if (decoded === null) return null
  const colon = decoded.indexOf(':')
  if (colon === -1) return null
  const password = decoded.slice(colon + 1)
  return password.length > 0 ? password : null
}

function decodeBase64(value: string): string | null {
  try {
    return Buffer.from(value, 'base64').toString('utf8')
  } catch {
    return null
  }
}
