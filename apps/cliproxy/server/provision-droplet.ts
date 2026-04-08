#!/usr/bin/env bun

import {randomBytes} from 'node:crypto'
import {appendFileSync, readFileSync} from 'node:fs'
import {resolve} from 'node:path'

const DROPLET_NAME = 'cliproxy'
const DROPLET_IMAGE = 'docker-20-04'
const DROPLET_SIZE = 's-1vcpu-1gb'
const DROPLET_REGION = 'nyc1'
const CLIPROXY_DOMAIN = process.env.CLIPROXY_DOMAIN ?? 'cliproxy.fro.bot'
const REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/cliproxy'

function local(command: string[]): string[] {
  return command
}

function ssh(host: string, command: string): string[] {
  return [
    'ssh',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    `${REMOTE_USER}@${host}`,
    command,
  ]
}

function scp(host: string, source: string, target: string): string[] {
  return [
    'scp',
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=10',
    source,
    `${REMOTE_USER}@${host}:${target}`,
  ]
}

async function run(label: string, command: string[]) {
  console.log(`\u001B[1;34m==>\u001B[0m ${label}`)
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (stdout.trim()) console.log(stdout.trim())
  if (code !== 0) {
    console.error(`\u001B[1;31mFAILED:\u001B[0m ${label}`)
    if (stderr.trim()) console.error(stderr.trim())
    process.exit(1)
  }
}

async function runCapture(command: string[]): Promise<string> {
  const proc = Bun.spawn(command, {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const stderr = await new Response(proc.stderr).text()
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(stderr.trim() || `Command failed: ${command.join(' ')}`)
  }
  return stdout.trim()
}

async function sleep(ms: number): Promise<void> {
  await new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function validateDoctl(): Promise<void> {
  if (!Bun.which('doctl')) {
    throw new Error(
      'doctl is required. Install it first: https://docs.digitalocean.com/reference/doctl/how-to/install/',
    )
  }

  await run('Validating doctl authentication', local(['doctl', 'account', 'get']))
}

async function getSshFingerprint(): Promise<string> {
  const raw = await runCapture(local(['doctl', 'compute', 'ssh-key', 'list', '--format', 'FingerPrint', '--no-header']))
  const first = raw
    .split('\n')
    .map(line => line.trim())
    .find(Boolean)

  if (!first) {
    throw new Error('No SSH keys found in DigitalOcean account. Add at least one key before provisioning.')
  }

  return first
}

async function dropletExists(): Promise<boolean> {
  const raw = await runCapture(local(['doctl', 'compute', 'droplet', 'list', '--format', 'Name', '--no-header']))
  const names = raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)

  return names.includes(DROPLET_NAME)
}

async function createDropletIfMissing(): Promise<boolean> {
  const exists = await dropletExists()
  if (exists) {
    console.log(`\u001B[1;34m==>\u001B[0m Droplet ${DROPLET_NAME} already exists — skipping creation`)
    return true
  }

  const fingerprint = await getSshFingerprint()
  await run(
    `Creating droplet ${DROPLET_NAME}`,
    local([
      'doctl',
      'compute',
      'droplet',
      'create',
      DROPLET_NAME,
      '--image',
      DROPLET_IMAGE,
      '--size',
      DROPLET_SIZE,
      '--region',
      DROPLET_REGION,
      '--ssh-keys',
      fingerprint,
      '--wait',
    ]),
  )
  return false
}

async function getDropletIpWithWait(): Promise<string> {
  for (let attempt = 1; attempt <= 20; attempt += 1) {
    const ip = await runCapture(
      local(['doctl', 'compute', 'droplet', 'get', DROPLET_NAME, '--format', 'PublicIPv4', '--no-header']),
    )
    if (ip) {
      return ip
    }
    await sleep(5_000)
  }

  throw new Error('Timed out waiting for droplet IPv4 address')
}

async function validateDns(dropletIp: string): Promise<void> {
  try {
    const resolved = await Bun.dns.lookup(CLIPROXY_DOMAIN)
    const firstResolved = resolved[0]?.address

    if (firstResolved !== dropletIp) {
      console.warn(`DNS not configured. Point cliproxy.fro.bot to ${dropletIp} before running deploy.`)
    }
  } catch {
    console.warn(`DNS not configured. Point cliproxy.fro.bot to ${dropletIp} before running deploy.`)
  }
}

function resolveLocalFiles(): {compose: string; config: string; caddy: string} {
  const appRoot = resolve(import.meta.dir, '..')

  return {
    compose: resolve(appRoot, 'docker-compose.yaml'),
    config: resolve(appRoot, 'config/config.yaml'),
    caddy: resolve(appRoot, 'config/Caddyfile'),
  }
}

async function copyComposeFiles(host: string): Promise<void> {
  const files = resolveLocalFiles()

  await run('Creating remote directories', ssh(host, `mkdir -p ${REMOTE_DIR}/config`))
  await run('Uploading docker-compose.yaml', scp(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`))
  await run('Uploading config/config.yaml', scp(host, files.config, `${REMOTE_DIR}/config/config.yaml`))
  await run('Uploading config/Caddyfile', scp(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`))
}

async function writeRemoteEnvFile(host: string): Promise<string> {
  const managementPassword = randomBytes(32).toString('hex')
  const envFile = `CLIPROXY_DOMAIN=${CLIPROXY_DOMAIN}\nMANAGEMENT_PASSWORD=${managementPassword}\n`

  await run('Writing remote .env file', ssh(host, `cat > ${REMOTE_DIR}/.env << 'ENVFILE'\n${envFile}ENVFILE`))

  return managementPassword
}

async function deployCompose(host: string): Promise<void> {
  await run('Starting Docker Compose stack', ssh(host, `cd ${REMOTE_DIR} && docker compose up -d`))
}

async function waitForSsh(host: string): Promise<void> {
  for (let attempt = 1; attempt <= 24; attempt += 1) {
    const proc = Bun.spawn(ssh(host, 'echo ready'), {stdout: 'pipe', stderr: 'pipe'})
    const code = await proc.exited
    if (code === 0) {
      return
    }

    await sleep(5_000)
  }

  throw new Error('Timed out waiting for SSH connectivity to droplet')
}

async function pinHostKeys(dropletIp: string): Promise<void> {
  const knownHostsPath = resolve(import.meta.dir, '..', '..', '..', '.github', 'known_hosts')

  // Pin unhashed domain-name keys (for CI, which connects by domain)
  const domainKeys = await runCapture(local(['ssh-keyscan', CLIPROXY_DOMAIN]))
  // Pin hashed IP keys (for local provisioning)
  const ipKeys = await runCapture(local(['ssh-keyscan', '-H', dropletIp]))

  if (!domainKeys && !ipKeys) {
    console.warn('Warning: Could not retrieve host keys from droplet. Pin them manually before CI deploy.')
    return
  }

  const existing = readFileSync(knownHostsPath, 'utf-8')
  const marker = `# cliproxy droplet (${dropletIp} / ${CLIPROXY_DOMAIN})`

  if (existing.includes(marker)) {
    console.log(`\u001B[1;34m==>\u001B[0m Host keys already pinned for ${dropletIp}`)
    return
  }

  const newBlock = `\n${marker}\n${domainKeys}\n${ipKeys}\n`
  appendFileSync(knownHostsPath, newBlock)
  console.log(`\u001B[1;32m✓\u001B[0m Pinned host keys for ${dropletIp} / ${CLIPROXY_DOMAIN} in .github/known_hosts`)
  console.log('  Commit the updated .github/known_hosts before running CI deploy.')
}

async function provision(): Promise<void> {
  await validateDoctl()
  const dropletAlreadyExisted = await createDropletIfMissing()

  if (dropletAlreadyExisted && !process.argv.includes('--force')) {
    console.log('Droplet already exists. Use --force to overwrite remote config and secrets.')
    process.exit(0)
  }

  if (dropletAlreadyExisted && process.argv.includes('--force')) {
    console.warn('⚠️  --force: Overwriting remote config and .env on existing droplet')
  }

  const dropletIp = await getDropletIpWithWait()
  await waitForSsh(dropletIp)
  await pinHostKeys(dropletIp)
  await validateDns(dropletIp)
  await copyComposeFiles(dropletIp)
  const managementPassword = await writeRemoteEnvFile(dropletIp)
  await deployCompose(dropletIp)

  console.log('\n\u001B[1;32m✓\u001B[0m CLIProxy droplet provisioned\n')
  console.log(`Droplet IP: ${dropletIp}`)
  console.log(`Management key: ${managementPassword}`)
  console.log(
    '\n⚠️  Save this key — it cannot be recovered. Set it as CLIPROXY_MANAGEMENT_KEY in GitHub secrets and local .env',
  )
  console.log('\nCommit the updated .github/known_hosts before triggering a CI deploy.')
}

provision().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
