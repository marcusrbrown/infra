import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

// Line-based slice of a top-level compose section (`services:` child or `volumes:`), so db assertions cannot be
// satisfied by text that belongs to another service.
function section(header: string): string {
  const lines = compose.split('\n')
  const start = lines.indexOf(header)
  if (start === -1) throw new Error(`compose section not found: ${header}`)
  const indent = header.length - header.trimStart().length
  const rest = lines.slice(start + 1)
  const end = rest.findIndex(line => line.trim() !== '' && line.length - line.trimStart().length <= indent)
  return [header, ...(end === -1 ? rest : rest.slice(0, end))].join('\n')
}

const db = section('  db:')
const volumes = section('volumes:')

describe('umami docker compose', () => {
  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.7-alpine@sha256:eb4d35b7452d1ab6171fbdbe8d9275b2301dad6dad92115d91e19fb9b24d510f',
    )
  })

  describe('db service (Postgres 18 layout)', () => {
    it('pins the staging-validated Postgres image by digest', () => {
      expect(db).toContain(
        '    image: postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5\n',
      )
    })

    it('mounts the new named volume at /var/lib/postgresql', () => {
      expect(db).toContain('\n      - umami-db-data-pg18:/var/lib/postgresql\n')
    })

    it('does not reference the PG15 data path or the old volume anywhere in db', () => {
      expect(db).not.toContain('/var/lib/postgresql/data')
      expect(db).not.toMatch(/umami-db-data(?!-pg18)/)
    })

    it('does not override PGDATA', () => {
      expect(db).not.toContain('PGDATA')
    })
  })

  it('declares only the pg18 database volume', () => {
    expect(volumes).toContain('\n  umami-db-data-pg18:')
    expect(volumes).not.toMatch(/umami-db-data(?!-pg18)/)
  })
})
