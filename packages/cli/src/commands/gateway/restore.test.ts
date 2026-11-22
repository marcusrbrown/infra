import {existsSync, statSync} from 'node:fs'
import {dirname} from 'node:path'

import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {CLOSE_TIMEOUT_MS, restoreGatewayCa, validateBackupArchive, type RestoreSpawnFn} from './restore'

// ─── SpawnFn helpers ──────────────────────────────────────────────────────────

/**
 * Creates a multi-step spawn mock. Each call to the returned function pops the
 * next response from the queue. Throws if called more times than expected.
 */
function makeSpawnSequence(responses: {stdout: string; stderr: string; exitCode: number}[]): RestoreSpawnFn {
  const queue = [...responses]
  return (_cmd, _opts) => {
    const next = queue.shift()
    if (!next) {
      throw new Error('Unexpected spawn call — queue exhausted')
    }
    const encoder = new TextEncoder()
    return {
      stdout: new ReadableStream({
        start(controller) {
          if (next.stdout) controller.enqueue(encoder.encode(next.stdout))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          if (next.stderr) controller.enqueue(encoder.encode(next.stderr))
          controller.close()
        },
      }),
      exited: Promise.resolve(next.exitCode),
    }
  }
}

const VOLUME = 'fro-bot_mitmproxy-certs'
const PROBE_CMD = `docker volume inspect ${VOLUME} >/dev/null 2>&1 && echo EXISTS || echo MISSING`

const isProbe = (cmd: string[]): boolean => cmd.at(-1)?.startsWith('docker volume inspect') === true

/**
 * Wraps a spawn mock so the volume existence probe answers `probe` (default EXISTS),
 * while every other command is delegated to `inner`. All argv arrays, including the
 * probe, are appended to `calls` when provided.
 */
function withVolumeProbe(
  inner: RestoreSpawnFn,
  probe: {stdout: string; stderr?: string; exitCode?: number} = {stdout: 'EXISTS\n'},
  calls?: string[][],
): RestoreSpawnFn {
  const encoder = new TextEncoder()
  return (cmd, opts) => {
    calls?.push([...cmd])
    if (!isProbe(cmd)) return inner(cmd, opts)
    return {
      stdout: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(probe.stdout))
          controller.close()
        },
      }),
      stderr: new ReadableStream({
        start(controller) {
          if (probe.stderr) controller.enqueue(encoder.encode(probe.stderr))
          controller.close()
        },
      }),
      exited: Promise.resolve(probe.exitCode ?? 0),
    }
  }
}

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Creates a minimal non-empty tar file at the given path and returns the path.
 * Content is arbitrary bytes — tests only care that the file is non-empty.
 */
async function writeFakeTar(path: string): Promise<string> {
  await Bun.write(path, new Uint8Array([0x75, 0x73, 0x74, 0x61, 0x72])) // "ustar" magic
  return path
}

// ─── restoreGatewayCa — happy path ───────────────────────────────────────────

describe('restoreGatewayCa — happy path', () => {
  let tmpInput: string

  beforeEach(async () => {
    tmpInput = `/tmp/test-restore-input-${Date.now()}.tar`
    await writeFakeTar(tmpInput)
  })

  afterEach(() => {
    Bun.spawnSync(['rm', '-f', tmpInput])
  })

  it('succeeds when SCP + docker copy + restart + confirmation all pass', async () => {
    // Build a real tar with the two CA files so local extraction works
    const certContent = '-----BEGIN CERTIFICATE-----\nFAKECERT\n-----END CERTIFICATE-----\n'
    const keyContent = '-----BEGIN PRIVATE KEY-----\nFAKEKEY\n-----END PRIVATE KEY-----\n'

    const tarDir = `/tmp/test-tar-dir-${Date.now()}`
    const realTar = `/tmp/test-real-tar-${Date.now()}.tar`
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    try {
      // Sequence: tar -tf (validate), mktemp (ssh), scp, chmod, docker run (extract),
      // docker compose restart, docker run read cert, docker run read key, rm cleanup
      const spawn = makeSpawnSequence([
        {stdout: 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n', stderr: '', exitCode: 0}, // tar -tf validate
        {stdout: '/tmp/gateway-ca-restore-abc123.tar\n', stderr: '', exitCode: 0}, // mktemp ssh
        {stdout: '', stderr: '', exitCode: 0}, // scp
        {stdout: '', stderr: '', exitCode: 0}, // chmod 600
        {stdout: '', stderr: '', exitCode: 0}, // docker run extract
        {stdout: '', stderr: '', exitCode: 0}, // docker compose restart
        {stdout: certContent, stderr: '', exitCode: 0}, // docker run read cert
        {stdout: keyContent, stderr: '', exitCode: 0}, // docker run read key
        {stdout: '', stderr: '', exitCode: 0}, // rm cleanup
      ])

      const result = await restoreGatewayCa(
        {host: 'gateway.example.com', input: realTar, includeCa: true},
        withVolumeProbe(spawn),
      )

      expect(result.ok).toBe(true)
      if (result.ok) {
        expect(result.confirmed).toBe(true)
      }
    } finally {
      Bun.spawnSync(['rm', '-rf', tarDir, realTar])
    }
  })

  it('deletes the tmp file from the droplet on success (cleanup)', async () => {
    const deletedPaths: string[] = []

    // Track which commands are called to verify cleanup
    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      const cmdStr = cmd.join(' ')
      // The rm -f is issued as an SSH command: ['ssh', ..., 'rm -f <path>']
      // The last element of the ssh command array is the remote command string
      if (cmdStr.includes('rm -f')) {
        const remoteCmd = cmd.at(-1) ?? ''
        const match = remoteCmd.match(/rm -f (.+)/)
        if (match?.[1]) deletedPaths.push(match[1])
      }

      const encoder = new TextEncoder()
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      return {
        stdout: new ReadableStream({
          start(controller) {
            if (isTarTf) controller.enqueue(encoder.encode('mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'))
            else if (isMktemp) controller.enqueue(encoder.encode('/tmp/gateway-ca-restore-cleanup-test.tar\n'))
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

    await restoreGatewayCa(
      {host: 'gateway.example.com', input: tmpInput, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    // At least one rm -f was issued for the tmp file
    expect(deletedPaths.length).toBeGreaterThan(0)
  })
})

describe('restoreGatewayCa — tmp cleanup on failure', () => {
  let tmpInput: string

  beforeEach(async () => {
    tmpInput = `/tmp/test-restore-fail-${Date.now()}.tar`
    await writeFakeTar(tmpInput)
  })

  afterEach(() => {
    Bun.spawnSync(['rm', '-f', tmpInput])
  })

  it('deletes the tmp file from the droplet even when docker run fails', async () => {
    const deletedPaths: string[] = []

    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      const cmdStr = cmd.join(' ')
      // rm -f is issued as SSH remote command string
      if (cmdStr.includes('rm -f')) {
        const remoteCmd = cmd.at(-1) ?? ''
        const match = remoteCmd.match(/rm -f (.+)/)
        if (match?.[1]) deletedPaths.push(match[1])
      }

      const encoder = new TextEncoder()
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      const isDockerRun = cmdStr.includes('docker run') && cmdStr.includes('tar -xf')
      return {
        stdout: new ReadableStream({
          start(controller) {
            if (isTarTf) controller.enqueue(encoder.encode('mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'))
            else if (isMktemp) controller.enqueue(encoder.encode('/tmp/gateway-ca-restore-fail-test.tar\n'))
            controller.close()
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            if (isDockerRun) controller.enqueue(encoder.encode('tar: error'))
            controller.close()
          },
        }),
        exited: Promise.resolve(isDockerRun ? 1 : 0),
      }
    }

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: tmpInput, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    expect(result.ok).toBe(false)
    expect(deletedPaths.length).toBeGreaterThan(0)
  })
})

describe('restoreGatewayCa — error paths', () => {
  it('exits before SSH when --input points at an empty file', async () => {
    const emptyPath = `/tmp/test-empty-${Date.now()}.tar`
    await Bun.write(emptyPath, new Uint8Array(0))

    try {
      const neverSpawn: RestoreSpawnFn = () => {
        throw new Error('spawn must not be called for empty input')
      }

      const result = await restoreGatewayCa(
        {host: 'gateway.example.com', input: emptyPath, includeCa: true},
        neverSpawn,
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/empty/i)
      }
    } finally {
      Bun.spawnSync(['rm', '-f', emptyPath])
    }
  })

  it('rejects a malicious host and does not invoke ssh', async () => {
    const tmpInput2 = `/tmp/test-restore-sec-${Date.now()}.tar`
    await writeFakeTar(tmpInput2)

    try {
      const neverSpawn: RestoreSpawnFn = () => {
        throw new Error('spawn must not be called for an invalid host')
      }

      await expect(
        restoreGatewayCa({host: '-oProxyCommand=touch /tmp/sec5-pwned', input: tmpInput2, includeCa: true}, neverSpawn),
      ).rejects.toThrow('Invalid GATEWAY_HOST')
    } finally {
      Bun.spawnSync(['rm', '-f', tmpInput2])
    }
  })

  it('exits non-zero with mismatch diagnostic when confirmation fails', async () => {
    const tmpInput3 = `/tmp/test-restore-mismatch-${Date.now()}.tar`
    await writeFakeTar(tmpInput3)

    try {
      // Sequence: tar -tf validate, mktemp, scp, chmod, docker run extract, restart,
      // cert read returns WRONG content, key read, rm cleanup
      const spawn = makeSpawnSequence([
        {stdout: 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n', stderr: '', exitCode: 0}, // tar -tf validate
        {stdout: '/tmp/gateway-ca-restore-abc123.tar\n', stderr: '', exitCode: 0}, // mktemp
        {stdout: '', stderr: '', exitCode: 0}, // scp
        {stdout: '', stderr: '', exitCode: 0}, // chmod 600
        {stdout: '', stderr: '', exitCode: 0}, // docker run extract
        {stdout: '', stderr: '', exitCode: 0}, // docker compose restart
        {stdout: 'WRONG_CERT', stderr: '', exitCode: 0}, // docker exec cert — mismatch
        {stdout: 'WRONG_KEY', stderr: '', exitCode: 0}, // docker exec key — mismatch
        {stdout: '', stderr: '', exitCode: 0}, // rm cleanup
      ])

      const result = await restoreGatewayCa(
        {host: 'gateway.example.com', input: tmpInput3, includeCa: true},
        withVolumeProbe(spawn),
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/mismatch/i)
      }
    } finally {
      Bun.spawnSync(['rm', '-f', tmpInput3])
    }
  })
})

describe('restoreGatewayCa — edge case: --no-include-ca', () => {
  it('refuses with a clear message when includeCa is false', async () => {
    const tmpInput4 = `/tmp/test-restore-noca-${Date.now()}.tar`
    await writeFakeTar(tmpInput4)

    try {
      const result = await restoreGatewayCa({host: 'gateway.example.com', input: tmpInput4, includeCa: false})

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/only CA restore/i)
      }
    } finally {
      Bun.spawnSync(['rm', '-f', tmpInput4])
    }
  })
})

// ─── COR3: Cleanup failure preserves primary error ────────────────────────────

describe('restoreGatewayCa — cleanup failure preserves primary error (COR3)', () => {
  it('rejects with the docker failure error when both docker run and rm cleanup fail', async () => {
    const tmpInput5 = `/tmp/test-restore-cor3-${Date.now()}.tar`
    await writeFakeTar(tmpInput5)

    try {
      const encoder = new TextEncoder()
      const spawnBothFail: RestoreSpawnFn = (cmd, _opts) => {
        const cmdStr = cmd.join(' ')
        const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
        const isMktemp = cmdStr.includes('mktemp')
        const isDockerExtract = cmdStr.includes('docker run') && cmdStr.includes('tar -xf')
        const isRmCleanup = cmdStr.includes('rm -f')

        // tar -tf and mktemp succeed; scp succeeds; docker extract fails; rm cleanup also fails
        const exitCode = isDockerExtract || isRmCleanup ? 1 : 0
        const stderrMsg = isDockerExtract ? 'docker: fatal error' : isRmCleanup ? 'rm: permission denied' : ''

        return {
          stdout: new ReadableStream({
            start(controller) {
              if (isTarTf) controller.enqueue(encoder.encode('mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'))
              else if (isMktemp) controller.enqueue(encoder.encode('/tmp/gateway-ca-restore-cor3-test.tar\n'))
              controller.close()
            },
          }),
          stderr: new ReadableStream({
            start(controller) {
              if (stderrMsg) controller.enqueue(encoder.encode(stderrMsg))
              controller.close()
            },
          }),
          exited: Promise.resolve(exitCode),
        }
      }

      const result = await restoreGatewayCa(
        {host: 'gateway.example.com', input: tmpInput5, includeCa: true},
        withVolumeProbe(spawnBothFail),
      )

      // Must reflect the docker failure, not the rm failure
      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toContain('docker run extract failed')
        expect(result.error).not.toContain('rm: permission denied')
      }
    } finally {
      Bun.spawnSync(['rm', '-f', tmpInput5])
    }
  })
})

// ─── SEC2: mktemp-based unguessable remote path ───────────────────────────────

describe('restoreGatewayCa — SEC2: unguessable remote tmp path via mktemp', () => {
  it('uses the mktemp-returned path as the SCP destination and for chmod before docker run', async () => {
    const tarDir = `/tmp/test-sec2-tar-dir-${Date.now()}`
    const realTar = `/tmp/test-sec2-tar-${Date.now()}.tar`
    const certContent = 'CERT'
    const keyContent = 'KEY'
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    const capturedCmds: string[][] = []
    const unguessablePath = '/tmp/gateway-ca-restore-X7k9mQ.tar'

    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      capturedCmds.push([...cmd])
      const cmdStr = cmd.join(' ')
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      let stdout: string
      if (isTarTf) {
        stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
      } else if (isMktemp) {
        stdout = `${unguessablePath}\n`
      } else {
        stdout = certContent
      }
      const encoder = new TextEncoder()
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(stdout))
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

    await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    // SCP destination must use the unguessable path
    const scpCmd = capturedCmds.find(c => c[0] === 'scp')
    expect(scpCmd).toBeDefined()
    expect(scpCmd?.at(-1)).toBe(`root@gateway.example.com:${unguessablePath}`)

    // chmod 600 must be called on the unguessable path before docker run
    const chmodIdx = capturedCmds.findIndex(c => c.join(' ').includes('chmod 600'))
    const dockerRunIdx = capturedCmds.findIndex(
      c => c.join(' ').includes('docker run') && c.join(' ').includes('tar -xf'),
    )
    expect(chmodIdx).toBeGreaterThan(-1)
    expect(dockerRunIdx).toBeGreaterThan(-1)
    expect(chmodIdx).toBeLessThan(dockerRunIdx)
    expect(capturedCmds[chmodIdx]?.join(' ')).toContain(unguessablePath)

    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })
})

// ─── SSH and SCP commands include repo-pinned UserKnownHostsFile ─────────────

describe('restoreGatewayCa — SSH and SCP commands include UserKnownHostsFile', () => {
  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to every ssh invocation', async () => {
    const tarDir = `/tmp/test-kh-ssh-tar-dir-${Date.now()}`
    const realTar = `/tmp/test-kh-ssh-tar-${Date.now()}.tar`
    const certContent = 'CERT'
    const keyContent = 'KEY'
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    const capturedCmds: string[][] = []
    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      capturedCmds.push([...cmd])
      const cmdStr = cmd.join(' ')
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      const encoder = new TextEncoder()
      let stdout = ''
      if (isTarTf) stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
      else if (isMktemp) stdout = '/tmp/gateway-ca-restore-kh-test.tar\n'
      else stdout = certContent
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(stdout))
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

    await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    // Every ssh invocation must include UserKnownHostsFile
    const sshCmds = capturedCmds.filter(c => c[0] === 'ssh')
    expect(sshCmds.length).toBeGreaterThan(0)
    for (const sshCmd of sshCmds) {
      const knownHostsIdx = sshCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
      expect(knownHostsIdx).toBeGreaterThan(-1)
      expect(sshCmd[knownHostsIdx - 1]).toBe('-o')
      expect(sshCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)
    }

    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })

  it('passes -o UserKnownHostsFile=<repo>/.github/known_hosts to the scp invocation', async () => {
    const tarDir = `/tmp/test-kh-scp-tar-dir-${Date.now()}`
    const realTar = `/tmp/test-kh-scp-tar-${Date.now()}.tar`
    const certContent = 'CERT'
    const keyContent = 'KEY'
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    const capturedCmds: string[][] = []
    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      capturedCmds.push([...cmd])
      const cmdStr = cmd.join(' ')
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      const encoder = new TextEncoder()
      let stdout = ''
      if (isTarTf) stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
      else if (isMktemp) stdout = '/tmp/gateway-ca-restore-kh-scp-test.tar\n'
      else stdout = certContent
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(stdout))
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

    await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    const scpCmd = capturedCmds.find(c => c[0] === 'scp')
    expect(scpCmd).toBeDefined()
    if (scpCmd === undefined) throw new Error('expected an scp command to be captured')
    const knownHostsIdx = scpCmd.findIndex(arg => arg.startsWith('UserKnownHostsFile='))
    expect(knownHostsIdx).toBeGreaterThan(-1)
    expect(scpCmd[knownHostsIdx - 1]).toBe('-o')
    expect(scpCmd[knownHostsIdx]).toMatch(/\.github[/\\]known_hosts$/)

    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })

  it('does not weaken StrictHostKeyChecking in ssh or scp commands', async () => {
    const tarDir = `/tmp/test-kh-strict-tar-dir-${Date.now()}`
    const realTar = `/tmp/test-kh-strict-tar-${Date.now()}.tar`
    const certContent = 'CERT'
    const keyContent = 'KEY'
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    const capturedCmds: string[][] = []
    const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
      capturedCmds.push([...cmd])
      const cmdStr = cmd.join(' ')
      const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
      const isMktemp = cmdStr.includes('mktemp')
      const encoder = new TextEncoder()
      let stdout = ''
      if (isTarTf) stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
      else if (isMktemp) stdout = '/tmp/gateway-ca-restore-kh-strict-test.tar\n'
      else stdout = certContent
      return {
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(stdout))
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

    await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(spawnCapture),
    )

    // All ssh and scp commands must have StrictHostKeyChecking=yes
    const sshAndScpCmds = capturedCmds.filter(c => c[0] === 'ssh' || c[0] === 'scp')
    expect(sshAndScpCmds.length).toBeGreaterThan(0)
    for (const cmd of sshAndScpCmds) {
      const strictIdx = cmd.findIndex(arg => arg.startsWith('StrictHostKeyChecking='))
      expect(strictIdx).toBeGreaterThan(-1)
      expect(cmd[strictIdx]).toBe('StrictHostKeyChecking=yes')
    }

    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })
})

// ─── COR1: validateBackupArchive ─────────────────────────────────────────────

describe('validateBackupArchive — COR1', () => {
  const env = {PATH: '/usr/bin:/bin', HOME: '/tmp'}

  it('returns undefined for a valid archive with exactly the two expected files', async () => {
    const tarDir = `/tmp/test-cor1-valid-${Date.now()}`
    const tarPath = `/tmp/test-cor1-valid-${Date.now()}.tar`
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, 'cert')
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, 'key')
    Bun.spawnSync(['tar', '-cf', tarPath, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])

    try {
      const spawn = makeSpawnSequence([{stdout: 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n', stderr: '', exitCode: 0}])
      const result = await validateBackupArchive(tarPath, spawn, env)
      expect(result).toBeUndefined()
    } finally {
      Bun.spawnSync(['rm', '-rf', tarDir, tarPath])
    }
  })

  it('returns an error when only the cert is present (missing key)', async () => {
    const spawn = makeSpawnSequence([{stdout: 'mitmproxy-ca-cert.pem\n', stderr: '', exitCode: 0}])
    const result = await validateBackupArchive('/fake/path.tar', spawn, env)
    expect(result).toBeDefined()
    expect(result).toMatch(/malformed/i)
    expect(result).toContain('mitmproxy-ca.pem')
  })

  it('returns an error when extra files are present alongside the two expected files', async () => {
    const spawn = makeSpawnSequence([
      {stdout: 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\nextra-file.txt\n', stderr: '', exitCode: 0},
    ])
    const result = await validateBackupArchive('/fake/path.tar', spawn, env)
    expect(result).toBeDefined()
    expect(result).toMatch(/malformed/i)
    expect(result).toContain('extra-file.txt')
  })

  it('returns an error when filenames differ from expected (cert.pem, key.pem)', async () => {
    const spawn = makeSpawnSequence([{stdout: 'cert.pem\nkey.pem\n', stderr: '', exitCode: 0}])
    const result = await validateBackupArchive('/fake/path.tar', spawn, env)
    expect(result).toBeDefined()
    expect(result).toMatch(/malformed/i)
  })

  it('returns an error and does not proceed to SCP when archive is malformed', async () => {
    const tmpInput = `/tmp/test-cor1-malformed-${Date.now()}.tar`
    await writeFakeTar(tmpInput)

    try {
      let scpCalled = false
      const spawnCapture: RestoreSpawnFn = (cmd, _opts) => {
        if (cmd[0] === 'scp') scpCalled = true
        const isTarTf = cmd[0] === 'tar' && cmd.includes('-tf')
        const encoder = new TextEncoder()
        return {
          stdout: new ReadableStream({
            start(controller) {
              // Only cert, no key — malformed
              if (isTarTf) controller.enqueue(encoder.encode('mitmproxy-ca-cert.pem\n'))
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

      const result = await restoreGatewayCa(
        {host: 'gateway.example.com', input: tmpInput, includeCa: true},
        withVolumeProbe(spawnCapture),
      )

      expect(result.ok).toBe(false)
      if (!result.ok) {
        expect(result.error).toMatch(/malformed/i)
      }
      expect(scpCalled).toBe(false)
    } finally {
      Bun.spawnSync(['rm', '-f', tmpInput])
    }
  })
})

// ─── Volume name + fail-closed existence probe ───────────────────────────────

describe('restoreGatewayCa — volume name and existence probe (fail closed)', () => {
  const certContent = 'CERT'
  const keyContent = 'KEY'
  let tarDir: string
  let realTar: string

  /** Inner mock for everything except the probe: archive listing, mktemp, scp, chmod, docker, cat, rm. */
  const innerSpawn: RestoreSpawnFn = cmd => {
    const cmdStr = cmd.join(' ')
    const encoder = new TextEncoder()
    let stdout = ''
    if (cmd[0] === 'tar' && cmd.includes('-tf')) stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
    else if (cmdStr.includes('mktemp')) stdout = '/tmp/gateway-ca-restore-vol-test.tar\n'
    else if (cmdStr.endsWith('/src/mitmproxy-ca-cert.pem')) stdout = certContent
    else if (cmdStr.endsWith('/src/mitmproxy-ca.pem')) stdout = keyContent
    return {
      stdout: new ReadableStream({
        start(controller) {
          if (stdout) controller.enqueue(encoder.encode(stdout))
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

  beforeEach(async () => {
    tarDir = `/tmp/test-vol-tar-dir-${Date.now()}`
    realTar = `/tmp/test-vol-tar-${Date.now()}.tar`
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])
  })

  afterEach(() => {
    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })

  // The `ssh -O exit` that closes the shared master carries no remote command, so it is not one.
  const remoteCommands = (calls: string[][]): string[] =>
    calls.filter(c => (c[0] === 'ssh' || c[0] === 'scp') && !c.includes('-O')).map(c => c.at(-1) ?? '')

  it('probes first, then targets fro-bot_mitmproxy-certs in every docker command', async () => {
    const calls: string[][] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(innerSpawn, undefined, calls),
    )

    expect(result.ok).toBe(true)

    const remote = remoteCommands(calls)
    const probeIdx = remote.indexOf(PROBE_CMD)
    const mktempIdx = remote.findIndex(c => c.includes('mktemp'))
    expect(probeIdx).toBeGreaterThan(-1)
    expect(probeIdx).toBeLessThan(mktempIdx)

    expect(remote).toContain(
      `docker run --rm -v ${VOLUME}:/dst -v /tmp/gateway-ca-restore-vol-test.tar:/src.tar:ro alpine sh -c 'tar -xf /src.tar -C /dst'`,
    )
    expect(remote).toContain(`docker run --rm -v ${VOLUME}:/src:ro alpine cat /src/mitmproxy-ca-cert.pem`)
    expect(remote).toContain(`docker run --rm -v ${VOLUME}:/src:ro alpine cat /src/mitmproxy-ca.pem`)

    // The bare compose key must never be used as a volume name
    for (const cmd of remote.filter(c => c.includes('docker run'))) {
      expect(cmd).not.toMatch(/-v mitmproxy-certs/)
    }
  })

  it('aborts naming the volume when the probe reports MISSING, before any write', async () => {
    const calls: string[][] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(innerSpawn, {stdout: 'MISSING\n'}, calls),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(VOLUME)
      expect(result.error).toContain('does not exist')
    }
    const remote = remoteCommands(calls)
    expect(remote).toEqual([PROBE_CMD])
    expect(calls.some(c => c[0] === 'scp')).toBe(false)
    expect(remote.some(c => c.includes('docker run') || c.includes('docker compose'))).toBe(false)
  })

  it('aborts naming the volume when the probe output is unrecognized, before any write', async () => {
    const calls: string[][] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(innerSpawn, {stdout: 'unexpected\n'}, calls),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(VOLUME)
      expect(result.error).toContain('unrecognized')
    }
    expect(remoteCommands(calls)).toEqual([PROBE_CMD])
    expect(calls.some(c => c[0] === 'scp')).toBe(false)
  })

  it('aborts when the probe exits non-zero even if it printed EXISTS', async () => {
    const calls: string[][] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      withVolumeProbe(innerSpawn, {stdout: 'EXISTS\n', stderr: 'ssh: connection refused', exitCode: 255}, calls),
    )

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toContain(VOLUME)
      expect(result.error).toContain('connection refused')
    }
    expect(remoteCommands(calls)).toEqual([PROBE_CMD])
    expect(calls.some(c => c[0] === 'scp')).toBe(false)
  })
})

// ─── One SSH connection for the whole restore ────────────────────────────────
//
// The droplet runs `ufw limit 22/tcp`: the sixth new connection from one source within 30 seconds is refused. A
// restore makes eight ssh calls and one scp; run apart they lock the operator out mid-restore, on the emergency
// path. Every call goes over one ControlMaster socket instead, and the master is closed when the restore ends.

describe('restoreGatewayCa — one shared SSH connection', () => {
  const certContent = 'CERT'
  const keyContent = 'KEY'
  let tarDir: string
  let realTar: string

  beforeEach(async () => {
    tarDir = `/tmp/test-cm-tar-dir-${Date.now()}`
    realTar = `/tmp/test-cm-tar-${Date.now()}.tar`
    Bun.spawnSync(['mkdir', '-p', tarDir])
    await Bun.write(`${tarDir}/mitmproxy-ca-cert.pem`, certContent)
    await Bun.write(`${tarDir}/mitmproxy-ca.pem`, keyContent)
    Bun.spawnSync(['tar', '-cf', realTar, '-C', tarDir, 'mitmproxy-ca-cert.pem', 'mitmproxy-ca.pem'])
  })

  afterEach(() => {
    Bun.spawnSync(['rm', '-rf', tarDir, realTar])
  })

  interface Script {
    /** Throws from the spawn function itself (the spawner failing), for a command it matches. */
    throwOn?: (cmd: string[]) => boolean
    /** Answers `EXISTS` to the probe; anything else is the probe's stdout. */
    probe?: string
  }

  /** A spawn that records every argv, and for each ssh call also the state of the socket's directory. */
  function recordingSpawn(calls: string[][], directoryModes: number[], script: Script = {}): RestoreSpawnFn {
    const encoder = new TextEncoder()
    return cmd => {
      calls.push([...cmd])
      const controlArg = cmd.find(arg => arg.startsWith('ControlPath='))
      if (controlArg !== undefined && !cmd.includes('-O')) {
        directoryModes.push(statSync(dirname(controlArg.slice('ControlPath='.length))).mode & 0o777)
      }
      if (script.throwOn?.(cmd)) throw new Error(`spawn failed: ${cmd.at(-1)}`)
      const cmdStr = cmd.join(' ')
      let stdout = ''
      if (cmd[0] === 'tar' && cmd.includes('-tf')) stdout = 'mitmproxy-ca-cert.pem\nmitmproxy-ca.pem\n'
      else if (isProbe(cmd)) stdout = script.probe ?? 'EXISTS\n'
      else if (cmdStr.includes('mktemp')) stdout = '/tmp/gateway-ca-restore-cm-test.tar\n'
      else if (cmdStr.endsWith('/src/mitmproxy-ca-cert.pem')) stdout = certContent
      else if (cmdStr.endsWith('/src/mitmproxy-ca.pem')) stdout = keyContent
      return {
        stdout: new ReadableStream({
          start(controller) {
            if (stdout) controller.enqueue(encoder.encode(stdout))
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

  const isRemoteCall = (cmd: string[]): boolean => (cmd[0] === 'ssh' || cmd[0] === 'scp') && !cmd.includes('-O')
  const isClose = (cmd: string[]): boolean => cmd[0] === 'ssh' && cmd.includes('-O') && cmd.includes('exit')
  const controlPathOf = (cmd: string[]): string | undefined =>
    cmd.find(arg => arg.startsWith('ControlPath='))?.slice('ControlPath='.length)

  it('sends all nine ssh and scp calls over one control socket, so a restore is one connection', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      recordingSpawn(calls, modes),
    )

    expect(result.ok).toBe(true)
    const remote = calls.filter(isRemoteCall)
    // probe, mktemp, scp, chmod, extract, restart, cert, key, rm: nine calls, one connection.
    expect(remote.map(c => c[0])).toEqual(['ssh', 'ssh', 'scp', 'ssh', 'ssh', 'ssh', 'ssh', 'ssh', 'ssh'])
    const sockets = new Set(remote.map(controlPathOf))
    expect(sockets.size).toBe(1)
    const [socket] = [...sockets]
    expect(socket).toBeTruthy()
    expect(socket?.startsWith('/tmp/')).toBe(true)
    for (const call of remote) {
      expect(call).toContain('ControlMaster=auto')
      expect(call.some(arg => arg.startsWith('ControlPersist='))).toBe(true)
    }
    // The first call is the one that opens the master.
    expect(remote[0]?.at(-1)).toBe(PROBE_CMD)
    expect(remote[0]).toContain('ControlMaster=auto')
  })

  it('keeps the control socket in a private directory', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    await restoreGatewayCa({host: 'gateway.example.com', input: realTar, includeCa: true}, recordingSpawn(calls, modes))

    expect(modes.length).toBe(9)
    for (const mode of modes) expect(mode).toBe(0o700)
  })

  it('closes the master over the same socket after the last call, and removes the socket directory', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    await restoreGatewayCa({host: 'gateway.example.com', input: realTar, includeCa: true}, recordingSpawn(calls, modes))

    const closes = calls.filter(isClose)
    expect(closes).toHaveLength(1)
    expect(calls.at(-1)).toBe(closes[0])
    const socket = controlPathOf(closes[0] ?? [])
    expect(socket).toBe(controlPathOf(calls.find(isRemoteCall) ?? []))
    expect(closes[0]?.at(-1)).toBe('root@gateway.example.com')
    expect(existsSync(dirname(socket ?? '/nonexistent/x'))).toBe(false)
  })

  it('closes the master and removes the directory when the probe aborts the restore', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      recordingSpawn(calls, modes, {probe: 'MISSING\n'}),
    )

    expect(result.ok).toBe(false)
    const closes = calls.filter(isClose)
    expect(closes).toHaveLength(1)
    expect(controlPathOf(closes[0] ?? [])).toBe(controlPathOf(calls.find(isRemoteCall) ?? []))
    expect(existsSync(dirname(controlPathOf(closes[0] ?? []) ?? '/nonexistent/x'))).toBe(false)
  })

  it('closes the master and removes the directory when a step throws, and still removes the tmp file first', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    await expect(
      restoreGatewayCa(
        {host: 'gateway.example.com', input: realTar, includeCa: true},
        recordingSpawn(calls, modes, {throwOn: cmd => cmd.at(-1)?.startsWith('docker compose') === true}),
      ),
    ).rejects.toThrow('spawn failed')

    const rmIdx = calls.findIndex(c => c.at(-1)?.startsWith('rm -f') === true)
    const closeIdx = calls.findIndex(isClose)
    expect(rmIdx).toBeGreaterThan(-1)
    expect(closeIdx).toBeGreaterThan(rmIdx)
    expect(calls.filter(isClose)).toHaveLength(1)
    expect(existsSync(dirname(controlPathOf(calls[closeIdx] ?? []) ?? '/nonexistent/x'))).toBe(false)
  })

  it('does not let a failing close change the result', async () => {
    const calls: string[][] = []
    const modes: number[] = []

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      recordingSpawn(calls, modes, {throwOn: isClose}),
    )

    expect(result).toEqual({ok: true, confirmed: true})
    expect(calls.filter(isClose)).toHaveLength(1)
    expect(existsSync(dirname(controlPathOf(calls.find(isClose) ?? []) ?? '/nonexistent/x'))).toBe(false)
  })

  it('opens no connection at all when the archive is rejected before any ssh call', async () => {
    const calls: string[][] = []
    const modes: number[] = []
    const emptyTar = `/tmp/test-cm-empty-${Date.now()}.tar`
    await Bun.write(emptyTar, new Uint8Array(0))

    try {
      await restoreGatewayCa(
        {host: 'gateway.example.com', input: emptyTar, includeCa: true},
        recordingSpawn(calls, modes),
      )
    } finally {
      Bun.spawnSync(['rm', '-f', emptyTar])
    }

    expect(calls).toEqual([])
  })

  // ── The close is bounded ────────────────────────────────────────────────────
  //
  // `ssh -O exit` talks to a local master. If that master stops answering, the close must not hold the restore:
  // the restore's own result, or its own error, still has to reach the caller.

  /** A spawn whose close never answers: its streams never end and `exited` never settles, and it ignores the abort. */
  function hangingClose(inner: RestoreSpawnFn, closeSignals: (AbortSignal | undefined)[]): RestoreSpawnFn {
    return (cmd, opts) => {
      if (!isClose(cmd)) return inner(cmd, opts)
      closeSignals.push((opts as {signal?: AbortSignal}).signal)
      return {
        stdout: new ReadableStream({start() {}}),
        stderr: new ReadableStream({start() {}}),
        exited: new Promise<number>(() => {}),
      }
    }
  }

  it('bounds the close at 5 seconds', () => {
    expect(CLOSE_TIMEOUT_MS).toBe(5000)
  })

  it('returns the restore result within the bound when the close never settles, and aborts the close', async () => {
    const calls: string[][] = []
    const modes: number[] = []
    const closeSignals: (AbortSignal | undefined)[] = []
    const started = Date.now()

    const result = await restoreGatewayCa(
      {host: 'gateway.example.com', input: realTar, includeCa: true},
      hangingClose(recordingSpawn(calls, modes), closeSignals),
      {closeTimeoutMs: 50},
    )

    expect(result).toEqual({ok: true, confirmed: true})
    expect(Date.now() - started).toBeLessThan(2000)
    expect(closeSignals).toHaveLength(1)
    expect(closeSignals[0]).toBeInstanceOf(AbortSignal)
    expect(closeSignals[0]?.aborted).toBe(true)
    expect(existsSync(dirname(controlPathOf(calls.find(isClose) ?? []) ?? '/nonexistent/x'))).toBe(false)
  })

  it('still throws the restore error within the bound when the close never settles', async () => {
    const calls: string[][] = []
    const modes: number[] = []
    const closeSignals: (AbortSignal | undefined)[] = []
    const started = Date.now()

    await expect(
      restoreGatewayCa(
        {host: 'gateway.example.com', input: realTar, includeCa: true},
        hangingClose(
          recordingSpawn(calls, modes, {throwOn: cmd => cmd.at(-1)?.startsWith('docker compose') === true}),
          closeSignals,
        ),
        {closeTimeoutMs: 50},
      ),
    ).rejects.toThrow('spawn failed')

    expect(Date.now() - started).toBeLessThan(2000)
    expect(closeSignals).toHaveLength(1)
  })

  it('hands a prompt close a live abort signal, and does not abort it', async () => {
    const calls: string[][] = []
    const modes: number[] = []
    const closeSignals: (AbortSignal | undefined)[] = []
    const inner = recordingSpawn(calls, modes)
    const spy: RestoreSpawnFn = (cmd, opts) => {
      if (isClose(cmd)) closeSignals.push((opts as {signal?: AbortSignal}).signal)
      return inner(cmd, opts)
    }

    await restoreGatewayCa({host: 'gateway.example.com', input: realTar, includeCa: true}, spy)

    expect(closeSignals).toHaveLength(1)
    expect(closeSignals[0]).toBeInstanceOf(AbortSignal)
    expect(closeSignals[0]?.aborted).toBe(false)
  })
})
