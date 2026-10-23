import {chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {
  CONTAINER_ID,
  DEGRADED_BODY,
  LIMIT_BYTES,
  MIB,
  READY_BODY,
  STARTED_AT,
  workspaceStdout,
} from './__fixtures__/workspace-probe'
import {
  buildReadyzProbeSnippet,
  buildWorkspaceProbeScript,
  formatWorkspaceMemory,
  formatWorkspaceSummary,
  parseWorkspaceProbeOutput,
} from './workspace-memory'

describe('buildWorkspaceProbeScript', () => {
  const script = buildWorkspaceProbeScript()

  it('addresses the container by the ID compose resolves, never a literal name', () => {
    expect(script).toContain('docker compose --project-directory /opt/gateway/deploy ps -q workspace')
    expect(script).toContain('docker inspect --format')
    expect(script).toContain('docker exec "$id" cat /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.events')
    expect(script).toContain('docker exec "$id" node -e')
    expect(script).not.toMatch(/docker exec workspace/)
    expect(script).not.toMatch(/docker exec fro-bot/)
  })

  it('guards the readyz probe on digit-only reads, a non-zero limit and strictly more than 64 MiB of headroom', () => {
    expect(script).toContain('-gt 67108864')
    expect(script).toContain('[ "$limit" -gt 0 ]')
    expect(script).toContain(`case "$limit" in ''|*[!0-9]*)`)
    expect(script).toContain(`case "$cur" in ''|*[!0-9]*)`)
  })

  it('has no default that turns a missing read into zero', () => {
    expect(script).not.toContain(':-0')
  })

  it('keeps the read-only probe free of write operations', () => {
    expect(script).not.toMatch(/docker (update|restart|stop|kill|rm|compose (up|down|restart))/)
  })
})

async function runSnippet(status: number, body: string): Promise<string> {
  const server = Bun.serve({port: 0, fetch: () => new Response(body, {status})})
  try {
    const child = Bun.spawn(
      [process.execPath, '-e', buildReadyzProbeSnippet(`http://127.0.0.1:${server.port}/readyz`)],
      {
        stdout: 'pipe',
        stderr: 'pipe',
      },
    )
    return await new Response(child.stdout).text()
  } finally {
    await server.stop(true)
  }
}

describe('buildReadyzProbeSnippet — body is read whatever the HTTP status', () => {
  it('prints the JSON body of a 503 response', async () => {
    expect(await runSnippet(503, DEGRADED_BODY)).toBe(DEGRADED_BODY)
  })

  it('prints the JSON body of a 200 response', async () => {
    expect(await runSnippet(200, READY_BODY)).toBe(READY_BODY)
  })

  it('prints nothing when the endpoint is unreachable', async () => {
    const child = Bun.spawn([process.execPath, '-e', buildReadyzProbeSnippet('http://127.0.0.1:1/readyz')], {
      stdout: 'pipe',
      stderr: 'pipe',
    })
    expect(await new Response(child.stdout).text()).toBe('')
  })
})

describe('parseWorkspaceProbeOutput', () => {
  it('parses realistic delimited stdout', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout())

    expect(status).toEqual({
      status: 'ok',
      limitBytes: LIMIT_BYTES,
      currentBytes: 412 * MIB,
      maxEvents: 0,
      oomKills: 0,
      oomKilled: false,
      restartCount: 0,
      startedAt: STARTED_AT,
      opencode: 'ready',
    })
  })

  it('reads max and oom_kill from memory.events, not oom', () => {
    const output = workspaceStdout().replace('max 0\noom 0\noom_kill 0', 'max 3\noom 7\noom_kill 1')
    const status = parseWorkspaceProbeOutput(output)

    expect(status.status === 'ok' && [status.maxEvents, status.oomKills]).toEqual([3, 1])
  })

  it.each(['starting', 'degraded', 'down'] as const)('shows %s from a 503-style body', state => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyz: `{"ready":false,"opencode":"${state}"}`}))

    expect(status.status === 'ok' && status.opencode).toBe(state)
  })

  it('maps an unrecognised opencode value to unknown without losing the memory figures', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyz: '{"ready":false,"opencode":"exploding"}'}))

    expect(status.status).toBe('ok')
    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('maps a JSON body without an opencode field to unknown', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyz: '{"ready":true}'}))

    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('maps an empty body (probe skipped or failed) to unknown while keeping memory figures', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyz: ''}))

    expect(status.status).toBe('ok')
    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('shows skipped when the script printed the skip sentinel near the limit', () => {
    const status = parseWorkspaceProbeOutput(
      workspaceStdout({currentBytes: LIMIT_BYTES - 16 * MIB, readyzSkipped: true}),
    )

    expect(status.status === 'ok' && status.opencode).toBe('skipped')
  })

  it('shows skipped when the script printed the skip sentinel with no limit', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({memory: 0, readyzSkipped: true}))

    expect(status.status === 'ok' && [status.limitBytes, status.opencode]).toEqual([0, 'skipped'])
  })

  it('keeps unknown, not skipped, when the probe ran and returned an empty body', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyz: ''}))

    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('shows unknown when the sentinel is missing and the body is empty, even near the limit', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({currentBytes: LIMIT_BYTES - 16 * MIB, readyz: ''}))

    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('shows unknown when the sentinel is missing and there is no limit', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({memory: 0, readyz: ''}))

    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('does not trust a ready body when usage is within 64 MiB of the limit', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({currentBytes: LIMIT_BYTES - 16 * MIB}))

    expect(status.status).toBe('ok')
    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('does not trust a ready body at exactly 64 MiB of headroom', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({currentBytes: LIMIT_BYTES - 64 * MIB}))

    expect(status.status === 'ok' && status.opencode).toBe('unknown')
  })

  it('trusts the probe body just outside the 64 MiB headroom', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({currentBytes: LIMIT_BYTES - 65 * MIB}))

    expect(status.status === 'ok' && status.opencode).toBe('ready')
  })

  it('reports a zero Memory as no limit and does not trust a probe body', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({memory: 0}))

    expect(status.status === 'ok' && [status.limitBytes, status.opencode]).toEqual([0, 'unknown'])
  })

  it('carries OOMKilled and restart evidence from docker inspect', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({oomKilled: true, restartCount: 4}))

    expect(status.status === 'ok' && [status.oomKilled, status.restartCount]).toEqual([true, 4])
  })

  it.each([
    ['empty output', ''],
    ['id section missing', workspaceStdout({omit: 'id'})],
    ['inspect section missing', workspaceStdout({omit: 'inspect'})],
    ['cgroup section missing', workspaceStdout({omit: 'cgroup'})],
    ['readyz section missing', workspaceStdout({omit: 'readyz'})],
    ['no container ID', workspaceStdout({id: ''})],
    ['two container IDs', workspaceStdout({id: `${CONTAINER_ID}\n${CONTAINER_ID}`})],
    ['non-hex container ID', workspaceStdout({id: 'Error response from daemon'})],
    ['garbage readyz body', workspaceStdout({readyz: '<html>502 Bad Gateway</html>'})],
    ['truncated readyz JSON', workspaceStdout({readyz: '{"ready":fal'})],
    ['inspect with a non-numeric Memory', workspaceStdout().replace(String(LIMIT_BYTES), '<no value>')],
    ['inspect with a bad OOMKilled', workspaceStdout().replace(/ false /, ' maybe ')],
    ['cgroup without oom_kill', workspaceStdout().replace('oom_kill 0\n', '')],
    ['cgroup without max', workspaceStdout().replace('max 0\n', '')],
    ['non-numeric memory.current', workspaceStdout().replace(String(412 * MIB), 'max')],
    ['duplicated section', `${workspaceStdout()}${workspaceStdout()}`],
  ])('reports the whole block unknown: %s', (_label, output) => {
    expect(parseWorkspaceProbeOutput(output).status).toBe('unknown')
  })
})

describe('probe script end to end against a fake docker', () => {
  let dir: string
  let logPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'fake-docker-'))
    logPath = join(dir, 'docker.log')
    writeFileSync(logPath, '')
    const fakeDocker = String.raw`#!/bin/sh
echo "$*" >> "$FAKE_DOCKER_LOG"
case "$1" in
  compose) echo "$FAKE_ID" ;;
  inspect)
    case "$*" in
      *OOMKilled*) echo "$FAKE_LIMIT false 0 2026-10-23T08:20:18.123456789Z" ;;
      *) echo "$FAKE_LIMIT" ;;
    esac ;;
  exec)
    case "$*" in
      *memory.events*) echo "$FAKE_CURRENT"; printf 'low 0\nhigh 0\nmax 3\noom 1\noom_kill 1\n' ;;
      *"cat /sys/fs/cgroup/memory.current"*)
        case "$FAKE_CUR_MODE" in
          fail) exit 1 ;;
          empty) echo "" ;;
          *) echo "$FAKE_CURRENT" ;;
        esac ;;
      *node*) printf '%s' "$FAKE_READYZ" ;;
    esac ;;
esac
`
    writeFileSync(join(dir, 'docker'), fakeDocker)
    chmodSync(join(dir, 'docker'), 0o755)
  })

  afterEach(() => {
    rmSync(dir, {recursive: true, force: true})
  })

  async function runScript(fake: {
    limit: number
    current: number
    readyz?: string
    // How the stand-alone `cat memory.current` read behaves; the memory.events read is unaffected.
    curMode?: 'fail' | 'empty'
  }): Promise<string> {
    const child = Bun.spawn(['sh', '-c', buildWorkspaceProbeScript()], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? '/usr/bin:/bin'}`,
        FAKE_DOCKER_LOG: logPath,
        FAKE_ID: CONTAINER_ID,
        FAKE_LIMIT: String(fake.limit),
        FAKE_CURRENT: String(fake.current),
        FAKE_READYZ: fake.readyz ?? DEGRADED_BODY,
        FAKE_CUR_MODE: fake.curMode ?? '',
      },
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const stdout = await new Response(child.stdout).text()
    await child.exited
    return stdout
  }

  const dockerCalls = () =>
    readFileSync(logPath, 'utf8')
      .split('\n')
      .filter(line => line.length > 0)

  it('resolves the container ID once and addresses every later command by it', async () => {
    const stdout = await runScript({limit: LIMIT_BYTES, current: 412 * MIB})
    expect(dockerCalls().filter(call => call.startsWith('compose ') && call.includes(' ps '))).toEqual([
      `compose --project-directory /opt/gateway/deploy ps -q workspace`,
    ])

    const status = parseWorkspaceProbeOutput(stdout)
    expect(status).toMatchObject({
      status: 'ok',
      maxEvents: 3,
      oomKills: 1,
      opencode: 'degraded',
      currentBytes: 412 * MIB,
    })

    const calls = dockerCalls()
    expect(calls.filter(call => call.startsWith('exec ')).every(call => call.startsWith(`exec ${CONTAINER_ID} `))).toBe(
      true,
    )
    expect(calls.filter(call => call.startsWith('inspect ')).every(call => call.endsWith(` ${CONTAINER_ID}`))).toBe(
      true,
    )
    expect(calls.some(call => call.includes('node -e'))).toBe(true)
  })

  it('does not run the node exec when usage is within 64 MiB of the limit', async () => {
    const stdout = await runScript({limit: LIMIT_BYTES, current: LIMIT_BYTES - 16 * MIB, readyz: READY_BODY})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(false)
    const status = parseWorkspaceProbeOutput(stdout)
    expect(status.status === 'ok' && status.opencode).toBe('skipped')
  })

  it('does not run the node exec at exactly 64 MiB of headroom', async () => {
    const stdout = await runScript({limit: LIMIT_BYTES, current: LIMIT_BYTES - 64 * MIB, readyz: READY_BODY})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(false)
    const status = parseWorkspaceProbeOutput(stdout)
    expect(status.status === 'ok' && status.opencode).toBe('skipped')
  })

  it('runs the node exec one byte beyond 64 MiB of headroom', async () => {
    await runScript({limit: LIMIT_BYTES, current: LIMIT_BYTES - 64 * MIB - 1, readyz: READY_BODY})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(true)
  })

  it('does not run the node exec when the memory.current read fails and prints nothing', async () => {
    const stdout = await runScript({limit: LIMIT_BYTES, current: 412 * MIB, readyz: READY_BODY, curMode: 'fail'})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(false)
    const status = parseWorkspaceProbeOutput(stdout)
    expect(status.status === 'ok' && status.opencode).toBe('skipped')
  })

  it('does not run the node exec when the memory.current read prints an empty line', async () => {
    const stdout = await runScript({limit: LIMIT_BYTES, current: 412 * MIB, readyz: READY_BODY, curMode: 'empty'})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(false)
    const status = parseWorkspaceProbeOutput(stdout)
    expect(status.status === 'ok' && status.opencode).toBe('skipped')
  })

  it('does not run the node exec when no limit is set', async () => {
    const stdout = await runScript({limit: 0, current: 412 * MIB, readyz: READY_BODY})

    expect(dockerCalls().some(call => call.includes('node -e'))).toBe(false)
    const status = parseWorkspaceProbeOutput(stdout)
    expect(status.status === 'ok' && [status.limitBytes, status.opencode]).toEqual([0, 'skipped'])
  })
})

describe('opencode skipped versus unknown in output', () => {
  const nearLimit = parseWorkspaceProbeOutput(
    workspaceStdout({currentBytes: LIMIT_BYTES - 16 * MIB, readyzSkipped: true}),
  )
  const noLimit = parseWorkspaceProbeOutput(workspaceStdout({memory: 0, readyzSkipped: true}))
  const ranEmpty = parseWorkspaceProbeOutput(workspaceStdout({readyz: ''}))

  it('labels a near-limit skip with its reason', () => {
    expect(formatWorkspaceMemory(nearLimit)).toContain('  OpenCode:    skipped (within 64 MiB of the limit)')
    expect(formatWorkspaceSummary(nearLimit)).toBe('workspace mem=880/896MiB oom_kills=0 opencode=skipped')
  })

  it('labels a no-limit skip with its reason', () => {
    expect(formatWorkspaceMemory(noLimit)).toContain('  OpenCode:    skipped (no limit)')
    expect(formatWorkspaceSummary(noLimit)).toBe('workspace mem=412MiB limit=none oom_kills=0 opencode=skipped')
  })

  it('shows a probe that ran without a usable answer as plain unknown', () => {
    expect(formatWorkspaceMemory(ranEmpty)).toContain('  OpenCode:    unknown')
    expect(formatWorkspaceSummary(ranEmpty)).toBe('workspace mem=412/896MiB oom_kills=0 opencode=unknown')
  })

  it('labels a script-side skip with healthy headroom as an unavailable memory read', () => {
    const status = parseWorkspaceProbeOutput(workspaceStdout({readyzSkipped: true}))

    expect(formatWorkspaceMemory(status)).toContain('  OpenCode:    skipped (memory read unavailable)')
  })
})
