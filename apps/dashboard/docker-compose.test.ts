import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

describe('dashboard docker compose', () => {
  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.4-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
    )
  })

  it('references a pinned ghcr.io/fro-bot/dashboard image with a sha256 digest', () => {
    // Validates format: ghcr.io/fro-bot/dashboard:<tag>@sha256:<64 hex chars>
    // Does not pin a specific historical tag/digest — Renovate bumps update the compose file.
    expect(compose).toMatch(/image: ghcr\.io\/fro-bot\/dashboard:[^@]+@sha256:[0-9a-f]{64}/)
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

  it('caddy service has dashboard.fro.bot network alias on the default network', () => {
    // The dashboard server validates operator sessions by calling
    // https://dashboard.fro.bot/operator/session server-side. The alias routes
    // that internal call to Caddy (which proxies /operator/* to the gateway VPC)
    // instead of hairpinning to the droplet's public IP (DigitalOcean has no NAT loopback).
    expect(compose).toContain('- dashboard.fro.bot')
    // Alias must be nested under caddy's networks.default block
    const caddySection = compose.slice(compose.indexOf('  caddy:'))
    const nextServiceIdx = caddySection.indexOf('\n  dashboard:')
    const caddyBlock = nextServiceIdx === -1 ? caddySection : caddySection.slice(0, nextServiceIdx)
    expect(caddyBlock).toContain('aliases:')
    expect(caddyBlock).toContain('- dashboard.fro.bot')
  })

  it('both caddy and dashboard services are on the default network (existing DNS intact)', () => {
    // Ensures dashboard:3000 DNS still resolves — both services must be on the same network.
    // When any service declares explicit networks:, Docker Compose stops auto-attaching others.
    // Both must explicitly list default so caddy can reach dashboard:3000.
    const caddySection = compose.slice(compose.indexOf('  caddy:'))
    const dashboardSection = compose.slice(compose.indexOf('  dashboard:'))

    // caddy must declare networks: with default
    const caddyNetworksIdx = caddySection.indexOf('    networks:')
    expect(caddyNetworksIdx).toBeGreaterThan(-1)
    const caddyNetworksBlock = caddySection.slice(caddyNetworksIdx, caddyNetworksIdx + 200)
    expect(caddyNetworksBlock).toContain('default:')

    // dashboard must declare networks: with default
    const dashboardNetworksIdx = dashboardSection.indexOf('    networks:')
    expect(dashboardNetworksIdx).toBeGreaterThan(-1)
    const dashboardNetworksBlock = dashboardSection.slice(dashboardNetworksIdx, dashboardNetworksIdx + 200)
    expect(dashboardNetworksBlock).toContain('default:')
  })
})
