import {readFile, stat} from 'node:fs/promises'
import {describe, expect, it} from 'bun:test'

const appDirectory = new URL('.', import.meta.url).pathname
const servicePath = `${appDirectory}systemd/umami-retention.service`
const timerPath = `${appDirectory}systemd/umami-retention.timer`
const runnerPath = `${appDirectory}retention.sh`
const checkSqlPath = `${appDirectory}retention-check.sql`
const applySqlPath = `${appDirectory}retention.sql`

async function artifact(path: string): Promise<string> {
  expect(await Bun.file(path).exists()).toBe(true)
  return readFile(path, 'utf8')
}

describe('Umami retention systemd service contract', () => {
  it('runs the versioned retention runner as a bounded root oneshot', async () => {
    const service = await artifact(servicePath)

    expect(service).toContain('[Service]')
    expect(service).toContain('Type=oneshot')
    expect(service).toContain('User=root')
    expect(service).toContain('Group=root')
    expect(service).toContain('WorkingDirectory=/opt/umami')
    expect(service).toContain(
      'ExecStart=/opt/umami/retention/current/retention.sh --apply --compose-file /opt/umami/docker-compose.yaml',
    )
    expect(service).toContain('TimeoutStartSec=30min')
    expect(service).toContain('Restart=no')
  })

  it('does not deprioritize the thin Docker client process', async () => {
    const service = await artifact(servicePath)

    expect(service).not.toContain('Nice=')
    expect(service).not.toContain('IOSchedulingClass=')
    expect(service).not.toContain('IOSchedulingPriority=')
  })

  it('does not add a service install target that could enable it during deploy', async () => {
    const service = await artifact(servicePath)

    expect(service).not.toContain('[Install]')
    expect(service).not.toContain('Restart=always')
    expect(service).not.toContain('Restart=on-failure')
  })
})

describe('Umami retention systemd timer contract', () => {
  it('runs daily in UTC with persistent, minute-accurate randomized scheduling', async () => {
    const timer = await artifact(timerPath)

    expect(timer).toContain('[Timer]')
    expect(timer).toContain('# The run lands between 00:30 and 01:00 UTC.')
    expect(timer).toContain('OnCalendar=*-*-* 00:30:00 UTC')
    expect(timer).toContain('Persistent=true')
    expect(timer).toContain('RandomizedDelaySec=30m')
    expect(timer).toContain('AccuracySec=1min')
    expect(timer).toContain('Unit=umami-retention.service')
  })
})

describe('Umami retention deployment artifact modes', () => {
  it('keeps the runner executable and data/unit files 0644-equivalent', async () => {
    const expectedModes = [
      {mode: 0o755, path: runnerPath},
      {mode: 0o644, path: checkSqlPath},
      {mode: 0o644, path: applySqlPath},
      {mode: 0o644, path: servicePath},
      {mode: 0o644, path: timerPath},
    ] as const

    await Promise.all(
      expectedModes.map(async ({mode, path}) => {
        const file = await stat(path)
        expect(file.mode & 0o777).toBe(mode)
      }),
    )
  })
})
