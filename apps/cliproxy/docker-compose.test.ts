import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

describe('cliproxy docker compose', () => {
  it('bounds the caddy json-file logs', () => {
    expect(compose).toMatch(
      /caddy:[\s\S]*?logging:\s+driver: json-file\s+options:\s+max-size: 10m\s+max-file: '3'[\s\S]*?cli-proxy-api:/,
    )
  })

  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
    )
  })
})
