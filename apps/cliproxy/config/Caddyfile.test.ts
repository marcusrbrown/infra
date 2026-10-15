import {describe, expect, it} from 'bun:test'

const caddyfile = await Bun.file(new URL('Caddyfile', import.meta.url)).text()

// Text-level assertions: the file's structure is pinned, Caddy's runtime behavior is not modeled.
// Strip comments so assertions cannot be satisfied by explanatory text.
const config = caddyfile
  .split('\n')
  .filter(line => !line.trim().startsWith('#'))
  .join('\n')

const CREDENTIAL_HEADERS = ['X-Management-Key', 'Authorization', 'Cookie', 'X-Api-Key']

/** Body of the brace-balanced block opened by the final `{` of `opener`'s match. */
function blockAfter(text: string, opener: RegExp): string {
  const match = opener.exec(text)
  if (match === null) throw new Error(`block opener not found: ${opener}`)
  const open = match.index + match[0].length - 1
  if (text[open] !== '{') throw new Error(`block opener must end with '{': ${opener}`)
  let depth = 0
  for (let i = open; i < text.length; i++) {
    if (text[i] === '{') depth++
    else if (text[i] === '}' && --depth === 0) return text.slice(open + 1, i)
  }
  throw new Error('unbalanced braces in Caddyfile')
}

const siteBlock = blockAfter(config, /^\{\$CLIPROXY_DOMAIN\} \{/m)
const siteLogBlock = blockAfter(siteBlock, /^\s*log \{/m)
const globalLogBlock = blockAfter(blockAfter(config, /^\{(?=\n)/m), /^\s*log \{/m)

describe('cliproxy Caddyfile logging', () => {
  it('logs only management API requests', () => {
    expect(siteBlock).toMatch(/^\s*@not_management not path \/v0\/management\/\*$/m)
    expect(siteBlock).toMatch(/^\s*log_skip @not_management$/m)
    expect(siteBlock).not.toContain('skip_log')
  })

  it('writes the management access log as JSON to stdout', () => {
    expect(siteLogBlock).toMatch(/^\s*output stdout$/m)
    expect(siteLogBlock).toMatch(/^\s*format filter \{/m)
    expect(siteLogBlock).toMatch(/^\s*wrap json$/m)
  })

  it.each(CREDENTIAL_HEADERS)('deletes the %s request header from the access log', header => {
    expect(siteLogBlock).toContain(`request>headers>${header} delete`)
  })

  // Proxy errors log the full request through the default logger, outside the site `log` block.
  it.each(CREDENTIAL_HEADERS)('deletes the %s request header from the default (error) logger', header => {
    expect(globalLogBlock).toContain(`request>headers>${header} delete`)
  })

  it('keeps reverse_proxy pointed at cli-proxy-api', () => {
    expect(siteBlock).toMatch(/^\s*reverse_proxy cli-proxy-api:8317$/m)
  })
})
