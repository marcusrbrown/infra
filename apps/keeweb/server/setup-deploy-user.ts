#!/usr/bin/env bun
/**
 * Provision the deploy-kw user on box.heatvision.co for CI/CD deployments.
 *
 * Runs locally — SSHes into the server as root to create the user, key,
 * permissions, activation script, and sudoers entry.
 *
 * Usage:
 *   bun run apps/keeweb/server/setup-deploy-user.ts
 *   bun run apps/keeweb/server/setup-deploy-user.ts --host other.server.co
 */

const HOST = process.argv.includes('--host') ? process.argv[process.argv.indexOf('--host') + 1] : 'box.heatvision.co'

const REMOTE_USER = 'root'
const DEPLOY_USER = 'deploy-kw'
const SITE_DIR = '/home/user-data/www/kw.igg.ms'
const NGINX_CONF = '/home/user-data/www/kw.igg.ms.conf'
const ACTIVATE_SCRIPT_PATH = '/usr/local/bin/kw-deploy-activate'

// The activation script runs on the server via sudo.
// It must be bash since it's a standalone server-side script invoked by sudoers.
const ACTIVATE_SCRIPT = `#!/usr/bin/env bash
set -euo pipefail

SITE_DIR="${SITE_DIR}"
NGINX_CONF="${NGINX_CONF}"
STAGING_DIR="/home/${DEPLOY_USER}/staging"

log() { printf "\\033[1;34m==>\\033[0m %s\\n" "$1"; }
err() { printf "\\033[1;31mERROR:\\033[0m %s\\n" "$1" >&2; }

log "Setting site ownership to www-data:www-data"
chown -R www-data:www-data "$SITE_DIR"
chmod -R 775 "$SITE_DIR"
find "$SITE_DIR" -type d -exec chmod g+s {} +

if [[ "\${1:-}" == "--nginx" ]]; then
    STAGED_CONF="$STAGING_DIR/kw.igg.ms.conf"

    if [[ ! -f "$STAGED_CONF" ]]; then
        err "No staged nginx config at $STAGED_CONF"
        exit 1
    fi

    log "Installing nginx config with validation"

    if [[ -f "$NGINX_CONF" ]]; then
        cp "$NGINX_CONF" "\${NGINX_CONF}.bak"
        log "Backed up current config to \${NGINX_CONF}.bak"
    fi

    cp "$STAGED_CONF" "$NGINX_CONF"
    chown user-data:user-data "$NGINX_CONF"
    chmod 644 "$NGINX_CONF"

    if nginx -t 2>&1; then
        log "nginx config valid — reloading"
        systemctl reload nginx
        log "nginx reloaded successfully"
        rm -f "$STAGED_CONF"
    else
        err "nginx config validation FAILED — rolling back"
        if [[ -f "\${NGINX_CONF}.bak" ]]; then
            cp "\${NGINX_CONF}.bak" "$NGINX_CONF"
            chown user-data:user-data "$NGINX_CONF"
            log "Restored backup config"
        fi
        exit 1
    fi
else
    log "Content-only activation complete (no nginx changes)"
fi
`

const SUDOERS_CONTENT = `${DEPLOY_USER} ALL=(root) NOPASSWD: ${ACTIVATE_SCRIPT_PATH}, ${ACTIVATE_SCRIPT_PATH} --nginx\n`

function ssh(command: string): string[] {
  return ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', `${REMOTE_USER}@${HOST}`, command]
}

async function run(label: string, command: string) {
  console.log(`\u001B[1;34m==>\u001B[0m ${label}`)
  const proc = Bun.spawn(ssh(command), {stdout: 'pipe', stderr: 'pipe'})
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

async function runCapture(command: string): Promise<string> {
  const proc = Bun.spawn(ssh(command), {stdout: 'pipe', stderr: 'pipe'})
  const stdout = await new Response(proc.stdout).text()
  const code = await proc.exited
  if (code !== 0) throw new Error(`Command failed: ${command}`)
  return stdout.trim()
}

async function writeRemoteFile(path: string, content: string, mode: string) {
  await run(`Writing ${path}`, `cat > ${path} << 'FILECONTENT'\n${content}\nFILECONTENT\nchmod ${mode} ${path}`)
}

async function provision() {
  console.log(`\nProvisioning ${DEPLOY_USER} on ${HOST}\n`)

  // Preflight
  await run('Testing SSH connectivity', 'echo ok')
  const siteExists = await runCapture(`test -d ${SITE_DIR} && echo yes || echo no`)
  if (siteExists !== 'yes') {
    console.error(`Site directory ${SITE_DIR} does not exist on ${HOST}`)
    process.exit(1)
  }

  // 1. Create user
  const userExists = await runCapture(`id ${DEPLOY_USER} &>/dev/null && echo yes || echo no`)
  if (userExists === 'yes') {
    console.log(`  User ${DEPLOY_USER} already exists — skipping creation`)
  } else {
    await run(
      'Creating deploy user',
      `useradd --system --create-home --home-dir /home/${DEPLOY_USER} --shell /bin/bash ${DEPLOY_USER}`,
    )
  }
  await run('Adding to www-data group', `usermod -aG www-data ${DEPLOY_USER}`)

  // 2. SSH key
  const keyExists = await runCapture(`test -f /home/${DEPLOY_USER}/.ssh/id_ed25519 && echo yes || echo no`)
  if (keyExists === 'yes') {
    console.log('  SSH key already exists — skipping generation')
  } else {
    await run(
      'Setting up SSH directory',
      [
        `mkdir -p /home/${DEPLOY_USER}/.ssh`,
        `chmod 700 /home/${DEPLOY_USER}/.ssh`,
        `chown ${DEPLOY_USER}:${DEPLOY_USER} /home/${DEPLOY_USER}/.ssh`,
      ].join(' && '),
    )
    await run(
      'Generating ed25519 SSH key',
      `sudo -u ${DEPLOY_USER} ssh-keygen -t ed25519 -f /home/${DEPLOY_USER}/.ssh/id_ed25519 -N "" -C "${DEPLOY_USER}@$(hostname)"`,
    )
  }
  await run(
    'Installing authorized_keys',
    [
      `cp /home/${DEPLOY_USER}/.ssh/id_ed25519.pub /home/${DEPLOY_USER}/.ssh/authorized_keys`,
      `chmod 600 /home/${DEPLOY_USER}/.ssh/authorized_keys`,
      `chown -R ${DEPLOY_USER}:${DEPLOY_USER} /home/${DEPLOY_USER}/.ssh`,
    ].join(' && '),
  )

  // 3. Site directory permissions
  await run(
    'Configuring site directory (setgid + group-writable)',
    [`chmod -R g+w ${SITE_DIR}`, `chmod g+s ${SITE_DIR}`].join(' && '),
  )

  // 4. Staging directory
  await run(
    'Creating staging directory',
    [`mkdir -p /home/${DEPLOY_USER}/staging`, `chown ${DEPLOY_USER}:${DEPLOY_USER} /home/${DEPLOY_USER}/staging`].join(
      ' && ',
    ),
  )

  // 5. Activation script
  await writeRemoteFile(ACTIVATE_SCRIPT_PATH, ACTIVATE_SCRIPT, '755')

  // 6. Sudoers
  await writeRemoteFile(`/etc/sudoers.d/${DEPLOY_USER}`, SUDOERS_CONTENT, '440')
  await run('Validating sudoers', `visudo -cf /etc/sudoers.d/${DEPLOY_USER}`)

  // Verification
  console.log('\n\u001B[1;34m==>\u001B[0m Running verification tests\n')

  await run(
    'deploy-kw can write to site dir',
    `sudo -u ${DEPLOY_USER} touch ${SITE_DIR}/.deploy-test && sudo -u ${DEPLOY_USER} rm ${SITE_DIR}/.deploy-test`,
  )
  await run('deploy-kw can run activation script', `sudo -u ${DEPLOY_USER} sudo ${ACTIVATE_SCRIPT_PATH}`)
  await run(
    'deploy-kw cannot read /etc/shadow',
    `sudo -u ${DEPLOY_USER} cat /etc/shadow 2>/dev/null && exit 1 || echo "Access denied (expected)"`,
  )

  // Output key info
  const fingerprint = await runCapture(`ssh-keygen -lf /home/${DEPLOY_USER}/.ssh/id_ed25519.pub`)
  const identity = await runCapture(`id ${DEPLOY_USER}`)

  console.log(`\n\u001B[1;32m✓\u001B[0m Setup complete!\n`)
  console.log(`  User:        ${identity}`)
  console.log(`  Key:         ${fingerprint}`)
  console.log(`  Site dir:    ${SITE_DIR} (setgid, group-writable)`)
  console.log(`  Staging:     /home/${DEPLOY_USER}/staging`)
  console.log(`  Activate:    sudo ${ACTIVATE_SCRIPT_PATH} [--nginx]`)
  console.log(`  Sudoers:     /etc/sudoers.d/${DEPLOY_USER}`)
  console.log()
  console.log('  Next steps:')
  console.log("    1. Retrieve the private key: ssh root@%s 'cat /home/%s/.ssh/id_ed25519'", HOST, DEPLOY_USER)
  console.log('    2. Store it as DEPLOY_SSH_KEY in GitHub (scoped to production Environment)')
  console.log("    3. Verify: ssh %s@%s 'id'", DEPLOY_USER, HOST)
}

provision().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
