// ─── Traces host validation and host layout ───────────────────────────────────
//
// Validates TRACES_HOST values before they are passed as ssh argv arguments.
// A value starting with `-` would be interpreted by ssh as an option flag,
// enabling ProxyCommand injection and local code execution.
//
// The path constants below are the single description of where content lives on
// the traces host. Provisioning builds the host to match them; deploy, the
// sender-token commands and the health reporter read them. Every path that can
// hold trace content is under TRACES_VOLUME_MOUNT, the encrypted attached volume.

const VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i

/**
 * Validates a candidate TRACES_HOST value against a strict hostname allowlist.
 *
 * Accepts: hostnames, FQDNs, IPv4 addresses, `localhost`.
 * Rejects: empty strings, values starting with `-`, and anything containing
 * characters outside `[A-Za-z0-9.-]`.
 *
 * @throws {Error} with a sanitized excerpt of the invalid value.
 * @returns The validated host string (unchanged).
 */
export function validateTracesHost(host: string): string {
  if (!host) {
    throw new Error('Invalid TRACES_HOST: value is empty')
  }

  if (!VALID_HOST_RE.test(host)) {
    // Truncate to 30 chars and strip non-printable bytes before echoing back
    const excerpt = host.slice(0, 30).replaceAll(/[^\u0020-\u007E]/g, '?')
    throw new Error(`Invalid TRACES_HOST: "${excerpt}" — must match ${String.raw`[A-Za-z0-9][A-Za-z0-9.\-]*`}`)
  }

  return host
}

// ─── Sender groups ────────────────────────────────────────────────────────────

/** The three sender groups. Each has one receiver, one token directory and one ingest path. */
export const SENDER_GROUPS = ['marcusrbrown', 'fro-bot', 'workstation'] as const

export type SenderGroup = (typeof SENDER_GROUPS)[number]

export function isSenderGroup(value: string): value is SenderGroup {
  return (SENDER_GROUPS as readonly string[]).includes(value)
}

// ─── Host layout ──────────────────────────────────────────────────────────────

/** Droplet name, and the name the CLI and workflows use to find the host. */
export const TRACES_DROPLET_NAME = 'traces'

/** Block-storage volume name. The backup job matches snapshots by this prefix. */
export const TRACES_VOLUME_NAME = 'traces-data'

/** Mount point of the encrypted volume. */
export const TRACES_VOLUME_MOUNT = '/mnt/traces'

/** Sentinel file on the volume. Docker and containerd refuse to start without it. */
export const TRACES_SENTINEL_PATH = `${TRACES_VOLUME_MOUNT}/.traces-volume`

/** The first line of the sentinel file. A file with any other content is not recognised. */
export const TRACES_SENTINEL_CONTENT = 'traces-volume-v1'

/** Docker's data root: images, layers, named volumes, writable layers and container logs. */
export const TRACES_DOCKER_ROOT = `${TRACES_VOLUME_MOUNT}/docker`

/** The containerd root: the content and snapshot stores that hold images on this droplet image. */
export const TRACES_CONTAINERD_ROOT = `${TRACES_VOLUME_MOUNT}/containerd`

/** The app directory: compose file, configs, secret files, token directories and collector queues. */
export const TRACES_APP_DIR = `${TRACES_VOLUME_MOUNT}/app`

/** Parent of the per-group token directories. Deploy creates it; only the sender-token commands write inside it. */
export const TRACES_TOKEN_ROOT = `${TRACES_APP_DIR}/tokens`

/** The token directory of one sender group, mounted into the collector as a directory. */
export function tracesTokenDir(group: SenderGroup): string {
  return `${TRACES_TOKEN_ROOT}/${group}`
}
