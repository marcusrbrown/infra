import {resolve} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  checkVolumeProbeResult,
  GATEWAY_COMPOSE_PROJECT_NAME,
  MITMPROXY_CERTS_VOLUME,
  volumeProbeCommand,
} from './volume'

// packages/ must not import from apps/, so the drift guard reads the app source as text.
const REPO_ROOT = resolve(import.meta.dir, '../../../../..')
const COMPOSE_PROJECT_NAME_DECLARATION = /^export const COMPOSE_PROJECT_NAME = '([^']+)'$/gm

describe('gateway volume naming', () => {
  it('uses the compose-prefixed volume name', () => {
    expect(MITMPROXY_CERTS_VOLUME).toBe('fro-bot_mitmproxy-certs')
  })

  it('matches the compose project name used by the gateway deploy', async () => {
    const source = await Bun.file(resolve(REPO_ROOT, 'apps/gateway/src/deploy.ts')).text()
    const declarations = [...source.matchAll(COMPOSE_PROJECT_NAME_DECLARATION)]

    expect(
      declarations,
      "apps/gateway/src/deploy.ts must declare `export const COMPOSE_PROJECT_NAME = '...'` exactly once",
    ).toHaveLength(1)
    expect([GATEWAY_COMPOSE_PROJECT_NAME]).toEqual(declarations.map(match => match[1] ?? ''))
  })
})

describe('volumeProbeCommand', () => {
  it('emits an explicit EXISTS/MISSING sentinel command', () => {
    expect(volumeProbeCommand('fro-bot_mitmproxy-certs')).toBe(
      'docker volume inspect fro-bot_mitmproxy-certs >/dev/null 2>&1 && echo EXISTS || echo MISSING',
    )
  })
})

describe('checkVolumeProbeResult', () => {
  const ok = {stderr: '', exitCode: 0}

  it('passes only for exit 0 with the EXISTS sentinel', () => {
    expect(checkVolumeProbeResult('v', {...ok, stdout: 'EXISTS\n'})).toBeUndefined()
  })

  it('names the volume for MISSING', () => {
    expect(checkVolumeProbeResult('v', {...ok, stdout: 'MISSING\n'})).toContain('Docker volume v does not exist')
  })

  it('fails closed on unrecognized or empty output', () => {
    expect(checkVolumeProbeResult('v', {...ok, stdout: ''})).toContain('unrecognized')
    expect(checkVolumeProbeResult('v', {...ok, stdout: 'EXISTS but not really'})).toContain('unrecognized')
  })

  it('fails closed on non-zero exit regardless of output', () => {
    const error = checkVolumeProbeResult('v', {stdout: 'EXISTS\n', stderr: 'boom', exitCode: 1})
    expect(error).toContain('exit 1')
    expect(error).toContain('boom')
  })
})
