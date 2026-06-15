import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

describe('dashboard docker compose', () => {
  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794',
    )
  })

  it('references the ghcr.io/marcusrbrown/infra-dashboard image', () => {
    expect(compose).toContain('image: ghcr.io/marcusrbrown/infra-dashboard:')
  })

  it('has read_only: true on the dashboard service (security hardening)', () => {
    expect(compose).toContain('read_only: true')
  })

  it('drops ALL capabilities on the dashboard service (security hardening)', () => {
    expect(compose).toContain('cap_drop:')
    expect(compose).toContain('- ALL')
  })

  it('sets no-new-privileges on the dashboard service (security hardening)', () => {
    expect(compose).toContain('no-new-privileges:true')
  })

  it('bind-mounts the GitHub App key at /run/secrets/github-app.pem (security hardening)', () => {
    expect(compose).toContain('/run/secrets/github-app.pem')
  })

  it('healthcheck references /api/healthz', () => {
    expect(compose).toContain('/api/healthz')
  })
})
