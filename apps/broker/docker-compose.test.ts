import {describe, expect, it} from 'bun:test'

const compose = await Bun.file(new URL('docker-compose.yaml', import.meta.url)).text()

describe('broker docker compose', () => {
  it('caddy image is digest-pinned (tag@sha256:...)', () => {
    // Digest-pinned images have the form name:tag@sha256:<hash>
    expect(compose).toMatch(/image: caddy:\S+@sha256:[a-f0-9]{64}/)
  })

  it('broker image is digest-pinned (tag@sha256:...)', () => {
    expect(compose).toMatch(/image: oven\/bun:\S+@sha256:[a-f0-9]{64}/)
  })

  it('uses the last known linux/amd64-compatible Caddy image', () => {
    expect(compose).toContain(
      'image: caddy:2.11.3-alpine@sha256:86deaf5e3d3408a6ccec08fbb79989783dd26e206ae10bcf78a801dc8c9ab794',
    )
  })

  it('fails on a tag-only (un-digest-pinned) image', () => {
    // Simulate a compose file with a tag-only image (no digest)
    const tagOnlyCompose = compose.replace(/image: caddy:\S+@sha256:[a-f0-9]{64}/, 'image: caddy:2.11.3-alpine')
    // A tag-only image does NOT match the digest-pinned pattern
    expect(tagOnlyCompose).not.toMatch(/image: caddy:\S+@sha256:[a-f0-9]{64}/)
  })

  it('caddy healthcheck probes the broker /healthz endpoint', () => {
    expect(compose).toContain('http://broker:3000/healthz')
  })

  it('broker service exposes port 3000', () => {
    expect(compose).toContain("'3000'")
  })

  it('broker service has a comment explaining cliproxy reachability via public FQDN', () => {
    expect(compose).toContain('cliproxy.fro.bot')
    expect(compose).toContain('PUBLIC')
  })

  it('broker service mounts only the bundle (no source bind-mount)', () => {
    // Must mount the pre-built bundle at /app/main.js, not the whole source tree
    expect(compose).toContain('./dist/main.js:/app/main.js:ro')
    expect(compose).not.toContain('./:/app')
  })

  it('broker service runs bun main.js (not bun run src/main.ts)', () => {
    expect(compose).toContain('command: [bun, main.js]')
    expect(compose).not.toContain('src/main.ts')
  })
})
