import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {createCapturedCtx, expectCapturedToInclude, MockProcessExit} from '../../lib/mcp-ctx-fixture'
import {vpnStatusAction} from './status'

// ─── SpawnFn helpers ──────────────────────────────────────────────────────────

type SpawnFn = (
  cmd: string[],
  opts: {env: Record<string, string>; stdout: 'pipe'; stderr: 'pipe'},
) => {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  exited: Promise<number>
}

function makeSpawnOk(output: string): SpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(output))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      exited: Promise.resolve(0),
    }
  }
}

function makeSpawnError(message: string): SpawnFn {
  return (_cmd, _opts) => {
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(message))
          controller.close()
        },
      }),
      exited: Promise.resolve(1),
    }
  }
}

// ─── vpnStatusAction ctx capture ─────────────────────────────────────────────

describe('vpnStatusAction — ctx capture', () => {
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    originalEnv = {VPN_HOST: process.env.VPN_HOST}
    process.env.VPN_HOST = '1.2.3.4'
  })

  afterEach(() => {
    if (originalEnv.VPN_HOST === undefined) {
      delete process.env.VPN_HOST
    } else {
      process.env.VPN_HOST = originalEnv.VPN_HOST
    }
  })

  it('routes "Status: OK" to ctx.console.log when wg0 is up', async () => {
    const {ctx, captured} = createCapturedCtx()

    const wgOutput = [
      'interface: wg0',
      '  public key: serverpubkey==',
      '  private key: (hidden)',
      '  listening port: 51820',
    ].join('\n')

    await vpnStatusAction({key: undefined}, ctx, makeSpawnOk(wgOutput))

    expect(expectCapturedToInclude(captured, 'Status: OK')).toBe(true)
  })

  it('routes "VPN status" header to ctx.console.log', async () => {
    const {ctx, captured} = createCapturedCtx()

    const wgOutput = 'interface: wg0\n  public key: key==\n  private key: (hidden)\n  listening port: 51820\n'

    await vpnStatusAction({key: undefined}, ctx, makeSpawnOk(wgOutput))

    expect(expectCapturedToInclude(captured, 'VPN status')).toBe(true)
  })

  it('surfaces the server public key in the output', async () => {
    const {ctx, captured} = createCapturedCtx()

    const wgOutput = 'interface: wg0\n  public key: MYPUBLICKEY==\n  private key: (hidden)\n  listening port: 51820\n'

    await vpnStatusAction({key: undefined}, ctx, makeSpawnOk(wgOutput))

    expect(expectCapturedToInclude(captured, 'MYPUBLICKEY==')).toBe(true)
  })

  it('routes error to ctx.console.error and calls ctx.process.exit(1) when SSH fails', async () => {
    const {ctx, captured} = createCapturedCtx()

    await expect(vpnStatusAction({key: undefined}, ctx, makeSpawnError('Connection refused'))).rejects.toBeInstanceOf(
      MockProcessExit,
    )

    expect(captured.stderr.join('').includes('Error')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })

  it('routes error to ctx.console.error and calls ctx.process.exit(1) when VPN_HOST is unset', async () => {
    delete process.env.VPN_HOST
    const {ctx, captured} = createCapturedCtx()

    await expect(vpnStatusAction({key: undefined}, ctx)).rejects.toBeInstanceOf(MockProcessExit)

    expect(captured.stderr.join('').includes('VPN_HOST')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })

  it('routes "Status: DEGRADED" to ctx.console.log and exits 1 when wg0 is down', async () => {
    const {ctx, captured} = createCapturedCtx()

    // wg show output without "interface:" line means interface is down
    await expect(
      vpnStatusAction({key: undefined}, ctx, makeSpawnOk('wg: The requested operation is not possible')),
    ).rejects.toBeInstanceOf(MockProcessExit)

    expect(expectCapturedToInclude(captured, 'DEGRADED')).toBe(true)
    expect(captured.exit?.code).toBe(1)
  })
})
