import {afterEach, beforeEach, describe, expect, it} from 'bun:test'

import {restoreGatewayCa, validateBackupArchive, type RestoreSpawnFn} from './restore'

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

      const result = await restoreGatewayCa({host: 'gateway.example.com', input: realTar, includeCa: true}, spawn)

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

    await restoreGatewayCa({host: 'gateway.example.com', input: tmpInput, includeCa: true}, spawnCapture)

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

    const result = await restoreGatewayCa({host: 'gateway.example.com', input: tmpInput, includeCa: true}, spawnCapture)

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

      const result = await restoreGatewayCa({host: 'gateway.example.com', input: tmpInput3, includeCa: true}, spawn)

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
        spawnBothFail,
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

    await restoreGatewayCa({host: 'gateway.example.com', input: realTar, includeCa: true}, spawnCapture)

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
        spawnCapture,
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
