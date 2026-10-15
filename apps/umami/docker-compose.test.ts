import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

describe('umami docker compose', () => {
  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.7-alpine@sha256:d8542f48d34a9cf4e4c11a478865229840e87e4c96ea3f439101f31a5d35f75f',
    )
  })
})
