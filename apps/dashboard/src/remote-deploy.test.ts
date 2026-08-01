import {chmodSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync} from 'node:fs'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

import {describe, expect, it} from 'bun:test'

import {
  buildRemoteSshCommand,
  decodeRemotePayload,
  encodeRemotePayload,
  REMOTE_PAYLOAD_FIELD_LIMITS,
  REMOTE_TRANSACTION_PROGRAM,
  runRemoteTransaction,
  type RemoteDeployPayload,
} from './remote-deploy'

const fixture: RemoteDeployPayload = {
  env: 'DASHBOARD_DOMAIN=dashboard.example\n',
  compose: `services:\n  dashboard:\n    image: ghcr.io/fro-bot/dashboard@sha256:${'a'.repeat(64)}\n`,
  caddyfile: 'dashboard.example {\n  reverse_proxy dashboard:3000\n}\n',
  githubAppKey: '-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----\n',
}

const localEnv = {
  PATH: '/custom/bin:/usr/bin',
  HOME: '/Users/operator',
  SSH_AUTH_SOCK: '/private/tmp/ssh-agent.sock',
  DASHBOARD_DOMAIN: 'dashboard.example',
}

const requiredWireFields = (): readonly [string, string][] => [
  ['env', fixture.env],
  ['compose', fixture.compose],
  ['caddyfile', fixture.caddyfile],
  ['github_app_key', fixture.githubAppKey],
]

const makeFramedPayload = (fields: readonly [string, string][], version = 1, trailing = ''): Uint8Array => {
  const encoder = new TextEncoder()
  const body = fields.map(([name, value]) => `field ${name} ${encoder.encode(value).byteLength}\n${value}`).join('')
  return encoder.encode(`dashboard-deploy-payload v${version}\n${body}end\n${trailing}`)
}

const concatBytes = (...parts: readonly Uint8Array[]): Uint8Array => {
  const result = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0))
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

const runShellProgram = async (program: string, payload: Uint8Array) => {
  const process = Bun.spawn(['bash', '-c', program], {stdin: 'pipe', stdout: 'pipe', stderr: 'pipe'})
  process.stdin.write(payload)
  process.stdin.end()
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  return {stdout, stderr, exitCode}
}

const adaptProgramForUnprivilegedHarness = (runtimeRoot: string): string => {
  const uid = process.getuid?.() ?? 501
  const gid = process.getgid?.() ?? 20
  const program = REMOTE_TRANSACTION_PROGRAM.replaceAll(
    '"/run/dashboard-deploy/lock"',
    JSON.stringify(`${runtimeRoot}/lock`),
  )
    .replaceAll('"/run/dashboard-deploy"', JSON.stringify(runtimeRoot))
    .replaceAll('0:0:700:directory', `${uid}:${gid}:700:Directory`)
    .replaceAll('0:0:600:regular file', `${uid}:${gid}:600:Regular File`)
    .replaceAll('install -d -m 0700 -o 0 -g 0', `install -d -m 0700 -o ${uid} -g ${gid}`)
    .replaceAll('install -m 0600 -o 0 -g 0', `install -m 0600 -o ${uid} -g ${gid}`)
    .replaceAll('chown 0:0', `chown ${uid}:${gid}`)
    .replaceAll('realpath -e --', 'realpath --')
  return `
stat() {
  if [ "$1" = "-c" ]; then
    format="$2"
    shift 2
    [ "$1" = "--" ] && shift
    case "$format" in
      "%u:%g:%a:%F") /usr/bin/stat -f "%u:%g:%Lp:%HT" "$1" ;;
      "%s") /usr/bin/stat -f "%z" "$1" ;;
      *) return 1 ;;
    esac
  else
    command stat "$@"
  fi
}
flock() { return 0; }
${program}`
}

describe('remote deploy payload protocol', () => {
  it('round-trips a valid data-only payload', () => {
    const encoded = encodeRemotePayload(fixture)

    expect(decodeRemotePayload(encoded)).toEqual(fixture)
  })

  it('keeps metacharacter payload values out of the fixed SSH command', () => {
    const secretFixture = {
      ...fixture,
      env: 'DASHBOARD_DOMAIN=dashboard.example\nOAUTH=$(touch /tmp/pwned); echo "quoted"\n',
      githubAppKey: '-----BEGIN PRIVATE KEY-----\nline\n-----END PRIVATE KEY-----\n',
    }
    const command = buildRemoteSshCommand({host: 'dashboard.example'})

    expect(command.join(' ')).not.toContain(secretFixture.env)
    expect(command.join(' ')).not.toContain(secretFixture.githubAppKey)
    expect(command.join(' ')).toContain('dashboard-deploy-payload v1')
    expect(command.join(' ')).toContain('DOCKER_CONTEXT=default')
    expect(command.join(' ')).toContain('DOCKER_HOST=unix:///var/run/docker.sock')
    expect(command.join(' ')).toContain('/usr/bin/env -i')
    expect(command.join(' ')).not.toContain('BASH_ENV=')
    expect(command.join(' ')).not.toContain('ENV=')
    expect(command.join(' ')).not.toContain('COMPOSE_FILE=')
    expect(command.join(' ')).not.toContain('COMPOSE_PROJECT_NAME=')
  })
})

describe('remote deploy payload negative cases', () => {
  const oversizedPayload: RemoteDeployPayload = {
    env: 'e'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.env),
    compose: 'c'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.compose),
    caddyfile: 'c'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.caddyfile),
    githubAppKey: 'k'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.github_app_key),
  }

  const cases: readonly [string, () => void][] = [
    ['unknown field', () => decodeRemotePayload(makeFramedPayload([['unknown', 'value'], ...requiredWireFields()]))],
    [
      'duplicate field',
      () =>
        decodeRemotePayload(
          makeFramedPayload([['env', fixture.env], ['env', fixture.env], ...requiredWireFields().slice(1)]),
        ),
    ],
    ['missing field', () => decodeRemotePayload(makeFramedPayload(requiredWireFields().slice(0, 3)))],
    ['trailing bytes', () => decodeRemotePayload(concatBytes(encodeRemotePayload(fixture), new Uint8Array([0x58])))],
    [
      'per-field oversized value',
      () => encodeRemotePayload({...fixture, env: 'x'.repeat(REMOTE_PAYLOAD_FIELD_LIMITS.env + 1)}),
    ],
    ['total-size overflow', () => encodeRemotePayload(oversizedPayload)],
    ['empty field', () => encodeRemotePayload({...fixture, env: ''})],
    ['NUL byte', () => encodeRemotePayload({...fixture, env: 'safe\0unsafe'})],
    ['unsupported version', () => decodeRemotePayload(makeFramedPayload(requiredWireFields(), 2))],
  ]

  for (const [name, action] of cases) {
    it(`rejects ${name}`, () => {
      expect(action).toThrow()
    })
  }
})

describe('remote transaction process boundary', () => {
  it('writes the framed payload only to stdin and closes it before success', async () => {
    const chunks: Uint8Array[] = []
    let closed = false
    let spawnEnv: Readonly<Record<string, string>> | undefined
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('stage=complete\n'))
        controller.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close()
      },
    })

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: (_command, options) => {
          spawnEnv = options.env
          return {
            stdout,
            stderr,
            stdin: {
              write: (data: Uint8Array) => {
                chunks.push(data)
              },
              end: () => {
                closed = true
              },
            },
            exited: Promise.resolve(0),
          }
        },
      }),
    ).resolves.toMatchObject({stage: 'complete'})

    expect(new TextDecoder().decode(chunks[0])).toBe(new TextDecoder().decode(encodeRemotePayload(fixture)))
    expect(closed).toBe(true)
    expect(spawnEnv).toBe(localEnv)
  })

  it('contains fixed runtime validation, lock, and cleanup structure', () => {
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('/run/dashboard-deploy')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('/run/dashboard-deploy/lock')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('flock')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('mktemp')
    expect(REMOTE_TRANSACTION_PROGRAM).toContain('trap')
  })

  it('creates an absent runtime root before opening the lock', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-root-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).toBe(0)
      expect(result.stdout.split('\n')[0]).toBe('stage=remote-transaction-started')
      expect(result.stdout).toContain('stage=complete')
      expect(statSync(runtimeRoot).isDirectory()).toBe(true)
      expect(statSync(runtimeRoot).mode & 0o777).toBe(0o700)
      expect(statSync(join(runtimeRoot, 'lock')).mode & 0o777).toBe(0o600)
      expect(readdirSync(runtimeRoot).filter(name => name.startsWith('attempt.'))).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('rejects an existing runtime root with unsafe mode before lock creation', async () => {
    const parent = mkdtempSync(join(tmpdir(), 'dashboard-deploy-unsafe-'))
    const runtimeRoot = join(realpathSync(parent), 'dashboard-deploy')
    mkdirSync(runtimeRoot, {mode: 0o755})
    chmodSync(runtimeRoot, 0o755)

    try {
      const result = await runShellProgram(
        adaptProgramForUnprivilegedHarness(runtimeRoot),
        encodeRemotePayload(fixture),
      )

      expect(result.exitCode).not.toBe(0)
      expect(result.stdout).toBe('stage=remote-transaction-started\n')
      expect(result.stderr).toContain('runtime root ownership or mode is unsafe')
      expect(readdirSync(runtimeRoot)).toEqual([])
    } finally {
      rmSync(parent, {recursive: true, force: true})
    }
  })

  it('keeps secret-like output out of returned evidence', async () => {
    const secret = 'oauth-secret\n-----BEGIN PRIVATE KEY-----'
    const text = new TextEncoder()
    const process = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode(`stage=complete\nstage=complete ${secret}\n`))
          controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode(secret))
          controller.close()
        },
      }),
      stdin: {
        write: (_data: Uint8Array) => {},
        end: () => {},
      },
      exited: Promise.resolve(0),
    }

    const result = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => process,
    })

    expect(JSON.stringify(result)).not.toContain('oauth-secret')
    expect(JSON.stringify(result)).not.toContain('BEGIN PRIVATE KEY')
  })

  it('reports an early remote exit instead of waiting forever on stdin', async () => {
    const text = new TextEncoder()
    const process = {
      stdout: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(text.encode('stage=remote-transaction-started\n'))
          controller.close()
        },
      }),
      stderr: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      }),
      stdin: {
        write: (_data: Uint8Array) => new Promise<void>(() => {}),
        end: () => {},
      },
      exited: Promise.resolve(75),
    }

    const outcome = await Promise.race([
      runRemoteTransaction({host: 'dashboard.example', payload: fixture, env: localEnv, spawn: () => process}).then(
        () => 'resolved' as const,
        error => error,
      ),
      new Promise<'timed out'>(resolve => setTimeout(() => resolve('timed out'), 100)),
    ])

    expect(outcome).not.toBe('timed out')
    expect(outcome).toMatchObject({stage: 'remote-transaction-started'})
  })

  it('does not treat a zero exit without a completion marker as success', async () => {
    const emptyStream = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close()
        },
      })

    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: emptyStream(),
          stderr: emptyStream(),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(0),
        }),
      }),
    ).rejects.toMatchObject({stage: 'starting'})
  })

  it('reports the last allowlisted remote stage on a nonzero exit', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=payload-decoded\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(1),
        }),
      }),
    ).rejects.toMatchObject({stage: 'payload-decoded', exitCode: 1})
  })

  it('preserves the bounded lock-contention stage', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('preserves a nonzero remote contention result over an EPIPE write failure', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {
              throw new Error('EPIPE')
            },
            end: () => {},
          },
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('keeps stdin close failures authoritative when the remote exits cleanly', async () => {
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('stage=payload-decoded\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {},
            end: () => {
              throw new Error('EPIPE')
            },
          },
          exited: Promise.resolve(0),
        }),
      }),
    ).rejects.toMatchObject({stage: 'payload-decoded'})
  })

  it('preserves a nonzero remote stage over an EPIPE close failure', async () => {
    const text = new TextEncoder()
    await expect(
      runRemoteTransaction({
        host: 'dashboard.example',
        payload: fixture,
        env: localEnv,
        spawn: () => ({
          stdout: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(text.encode('stage=lock-contention\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close()
            },
          }),
          stdin: {
            write: (_data: Uint8Array) => {},
            end: () => {
              throw new Error('EPIPE')
            },
          },
          exited: Promise.resolve(75),
        }),
      }),
    ).rejects.toMatchObject({stage: 'lock-contention', exitCode: 75})
  })

  it('returns only allowlisted operational evidence records', async () => {
    const digest = `sha256:${'b'.repeat(64)}`
    const text = new TextEncoder()
    const result = await runRemoteTransaction({
      host: 'dashboard.example',
      payload: fixture,
      env: localEnv,
      spawn: () => ({
        stdout: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(
              text.encode(
                `stage=complete\nevidence=free-bytes:6442450944\nevidence=service:dashboard\nevidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}\nevidence=secret:oauth-secret\n`,
              ),
            )
            controller.close()
          },
        }),
        stderr: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close()
          },
        }),
        stdin: {write: (_data: Uint8Array) => {}, end: () => {}},
        exited: Promise.resolve(0),
      }),
    })

    expect(result.evidence).toContain('evidence=free-bytes:6442450944')
    expect(result.evidence).toContain('evidence=service:dashboard')
    expect(result.evidence).toContain(`evidence=image:ghcr.io/fro-bot/dashboard:2026.08.01@${digest}`)
    expect(result.evidence.join('\n')).not.toContain('oauth-secret')
  })
})
