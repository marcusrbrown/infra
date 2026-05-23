#!/usr/bin/env bun

import {randomBytes} from 'node:crypto'
import {resolve} from 'node:path'

import {
  dropletExists,
  getDropletIpWithWait,
  getSshFingerprint,
  pinHostKeys,
  run,
  scp,
  ssh,
  validateDoctl,
  waitForSsh,
} from '@marcusrbrown/infra-shared/server/droplet-helpers'

const DROPLET_NAME = 'cliproxy'
const DROPLET_IMAGE = 'docker-20-04'
const DROPLET_SIZE = 's-1vcpu-1gb'
const DROPLET_REGION = 'nyc1'
const CLIPROXY_DOMAIN = process.env.CLIPROXY_DOMAIN ?? 'cliproxy.fro.bot'
const REMOTE_USER = process.env.REMOTE_USER ?? 'root'
const REMOTE_DIR = '/opt/cliproxy'

async function createDropletIfMissing(): Promise<boolean> {
  const exists = await dropletExists(DROPLET_NAME)
  if (exists) {
    console.log(`\u001B[1;34m==>\u001B[0m Droplet ${DROPLET_NAME} already exists — skipping creation`)
    return true
  }

  const keyName = process.env.CLIPROXY_SSH_KEY_NAME ?? 'fro-bot-cliproxy'
  const fingerprint = await getSshFingerprint(keyName, {
    envVarName: 'CLIPROXY_SSH_KEY_NAME',
    defaultKeyName: 'fro-bot-cliproxy',
  })
  await run(`Creating droplet ${DROPLET_NAME}`, [
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
  ])
  return false
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

  await run('Creating remote directories', ssh(host, `mkdir -p ${REMOTE_DIR}/config`, REMOTE_USER))
  await run('Uploading docker-compose.yaml', scp(host, files.compose, `${REMOTE_DIR}/docker-compose.yaml`, REMOTE_USER))
  await run('Uploading config/config.yaml', scp(host, files.config, `${REMOTE_DIR}/config/config.yaml`, REMOTE_USER))
  await run('Uploading config/Caddyfile', scp(host, files.caddy, `${REMOTE_DIR}/config/Caddyfile`, REMOTE_USER))
}

async function writeRemoteEnvFile(host: string): Promise<string> {
  const managementPassword = randomBytes(32).toString('hex')
  const envFile = `CLIPROXY_DOMAIN=${CLIPROXY_DOMAIN}\nMANAGEMENT_PASSWORD=${managementPassword}\n`

  await run(
    'Writing remote .env file',
    ssh(host, `cat > ${REMOTE_DIR}/.env << 'ENVFILE'\n${envFile}ENVFILE`, REMOTE_USER),
  )

  return managementPassword
}

async function deployCompose(host: string): Promise<void> {
  await run('Starting Docker Compose stack', ssh(host, `cd ${REMOTE_DIR} && docker compose up -d`, REMOTE_USER))
}

async function provision(): Promise<void> {
  await validateDoctl({checkAuth: true})
  const dropletAlreadyExisted = await createDropletIfMissing()

  if (dropletAlreadyExisted && !process.argv.includes('--force')) {
    console.log('Droplet already exists. Use --force to overwrite remote config and secrets.')
    process.exit(0)
  }

  if (dropletAlreadyExisted && process.argv.includes('--force')) {
    console.warn('⚠️  --force: Overwriting remote config and .env on existing droplet')
  }

  const dropletIp = await getDropletIpWithWait(DROPLET_NAME)
  await waitForSsh(dropletIp, REMOTE_USER)

  const knownHostsPath = resolve(import.meta.dir, '..', '..', '..', '.github', 'known_hosts')
  await pinHostKeys(CLIPROXY_DOMAIN, dropletIp, knownHostsPath, {
    marker: `# cliproxy droplet (${dropletIp} / ${CLIPROXY_DOMAIN})`,
  })

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
