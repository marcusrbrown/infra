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

/**
 * Tempo's data on the host: the files of the Docker named volume `traces_tempo_data` (compose project `traces`, volume
 * `tempo_data`, mounted at `/var/tempo` in the container). Docker's data root is on the encrypted volume, so Tempo's
 * blocks are at `<this>/blocks/<tenant>/<block-uuid>/`.
 */
export const TRACES_TEMPO_DATA_DIR = `${TRACES_DOCKER_ROOT}/volumes/traces_tempo_data/_data`

/**
 * Where a restore moves Tempo blocks whose metadata is torn, under `<this>/<YYYYMMDD-HHMM>/<tenant>/<block-uuid>`. On
 * the same filesystem as the blocks, so the move is a rename. Nothing prunes it: the operator deletes it.
 */
export const TRACES_TEMPO_QUARANTINE_ROOT = `${TRACES_VOLUME_MOUNT}/tempo-quarantine`

/** The app directory: compose file, configs, secret files, token directories and collector queues. */
export const TRACES_APP_DIR = `${TRACES_VOLUME_MOUNT}/app`

/** Parent of the per-group token directories. Deploy creates it; only the sender-token commands write inside it. */
export const TRACES_TOKEN_ROOT = `${TRACES_APP_DIR}/tokens`

/** The token directory of one sender group, mounted into the collector as a directory. */
export function tracesTokenDir(group: SenderGroup): string {
  return `${TRACES_TOKEN_ROOT}/${group}`
}

// ─── Container users ──────────────────────────────────────────────────────────

/**
 * The uid and gid Tempo runs as (the user its image declares; the compose file gives Tempo no `user`), and the
 * uid and gid the health reporter runs as. The two must match: Tempo creates its data directories (`blocks`,
 * `wal`, `live-store`) with mode 0700, so only its own user can list them, and the reporter lists `blocks` to
 * read the age of the oldest block. Another user gets "Permission denied" and the check is `unknown`, which
 * fails the verdict and keeps ingest from ever opening. Deploy owns `secrets/reporter/*` by this id so the
 * reporter can read its two password files as that user.
 *
 * A change of Tempo's image user is a change of this constant; `docker-compose.test.ts` pins the reporter's
 * `user` to it and pins that Tempo has no `user` of its own.
 */
export const TEMPO_USER_ID = 10_001

/**
 * The uid and gid Grafana runs as. The image's own user is 472 with group 0, and the compose file gives Grafana
 * `user: "472:472"` so that its group is 472. Deploy makes `secrets/grafana` owned `root:472` with mode 0750, so
 * the directory can be entered by group 472 only: a process whose group is 0 gets "Permission denied" on both
 * secret files, and Grafana starts on its defaults (admin password `admin`, the built-in secret key). Deploy owns
 * `secrets/grafana/*` by this id too. `docker-compose.test.ts` pins Grafana's `user` to it.
 */
export const GRAFANA_USER_ID = 472

/**
 * The uid and gid Prometheus runs as: `nobody`, the user its image declares. The compose file gives Prometheus
 * `user: "65534:65534"`, and deploy makes its data volume's directory owned by this id, once, like the collector's
 * queue volume. `docker-compose.test.ts` pins Prometheus's `user` to it.
 */
export const PROMETHEUS_USER_ID = 65_534

/**
 * The uid and gid the Topics embedder runs as: `nobody`. The image declares no user, so the compose file names one, and
 * deploy makes the model volume's directory owned by this id, once, like Prometheus's data volume.
 * `docker-compose.test.ts` pins the embedder's `user` to it.
 */
export const EMBEDDER_USER_ID = 65_534

/**
 * The uid and gid the reader gate runs as. Deploy owns `readers/token` and `secrets/reader-gate/*` by `root:<this>`, and
 * the gate's own user is the only one besides root that can read them. Distinct from Tempo's id, so the gate cannot read
 * what the health reporter reads. `docker-compose.test.ts` pins the gate's `user` to it.
 */
export const READER_GATE_USER_ID = 10_003

/**
 * The uid the Grafana MCP server runs as: `mcp-grafana`, the user its image declares (`useradd -r -u 1000`, whose primary
 * group is 999). The compose file gives it `user: "1000:1000"` so that its group matches the group of the secret
 * directory, as for Grafana above. Deploy owns `secrets/grafana-mcp/*` by `root:<this>`. `docker-compose.test.ts` pins
 * the service's `user` to it.
 */
export const GRAFANA_MCP_USER_ID = 1000

/**
 * The reader gate's deadline to the first response header from an upstream, in milliseconds. The gate answers 504 after it.
 * Caddy's response-header timeout on the agent routes and its server write timeout must both stay above it (the write timeout also covers `read_body` plus the gate's `RESPONSE_DEADLINE_MS`), or Caddy
 * would cut off the gate's own answer; `config/Caddyfile.test.ts` pins that rule against this value.
 */
export const READER_GATE_DEADLINE_MS = 60_000

// ─── Deploy state and locks ───────────────────────────────────────────────────
//
// These paths are a contract between the deploy, the sender-token commands and the ingest command. The CLI
// never imports from `apps/`, so it keeps copies of its own and a test pins each copy to the value here. The step
// lock is deploy-internal: the CLI never takes it, so a manual `traces ingest hold` never waits on a deploy step.

/**
 * A regular file. Deploy writes it (a UTC timestamp on one line) before its first change to the host and removes
 * it only as the last step of a deploy that ended with every gate evaluated and the route in its final state. A
 * failed or interrupted deploy leaves it, and the next deploy overwrites it. While it exists, opening ingest is
 * refused; holding never is.
 */
export const TRACES_DEPLOY_MARKER = `${TRACES_APP_DIR}/.deploy-in-progress`

/** Services a deploy has changed on disk and not yet restarted. Written before any file changes, removed after Caddy restarts. */
export const TRACES_PENDING_RESTARTS = `${TRACES_APP_DIR}/.pending-restarts`

/** `flock` lock file. Every script that reads then writes the ingest state and recreates Caddy runs inside `flock -w 30` on it. */
export const TRACES_INGEST_LOCK = `${TRACES_APP_DIR}/.ingest.lock`

/**
 * `flock` lock file, taken on descriptor 8 by every deploy script that changes the host, before its ownership check
 * and held until the script's shell exits (the whole step), and by the script that takes the host over before it
 * writes the deploy marker. So a deploy cannot take ownership while another deploy's step is in flight. When a script
 * takes both locks, this one comes first. Only the deploy takes it.
 */
export const TRACES_DEPLOY_STEP_LOCK = `${TRACES_APP_DIR}/.deploy-step.lock`

/** `flock` lock file. Every script that reads then replaces a token file runs inside `flock -w 30` on it. */
export const TRACES_TOKENS_LOCK = `${TRACES_TOKEN_ROOT}/.lock`

/** What a locked script prints when it could not take its lock in 30 seconds. Never a silent skip. */
export const TRACES_LOCK_BUSY_SENTINEL = 'LOCK_BUSY'

// ─── Token files ──────────────────────────────────────────────────────────────

/**
 * A token file is never empty: the collector's credential file watcher rejects an empty file (it fails at start and
 * keeps the previous credentials on reload), so emptying a file would not revoke anything. A file with no real
 * token holds one void line instead: `trc_void_<43 base64url chars> void <ISO-8601 UTC timestamp>`, a token nobody
 * knows. A real token is any non-blank line whose first field does not start with this prefix.
 */
export const TRACES_VOID_TOKEN_PREFIX = 'trc_void_'

// ─── Reader files ─────────────────────────────────────────────────────────────
//
// The reader tokens live apart from the sender tokens: the collector mounts `tokens/` and never `readers/`, and the gate
// mounts `readers/` and never `tokens/`. A reader line is `<token> <fp12> <consumer> <iso-date>`; a void line is the
// sender void line. The gate denies every request when the file is missing, empty or malformed.

/** Directory of the reader token file, mounted into the gate read-only. Owned `root:READER_GATE_USER_ID`, mode 0750. */
export const TRACES_READER_DIR = `${TRACES_APP_DIR}/readers`

/** The reader token file. Owned `root:READER_GATE_USER_ID`, mode 0640. The CLI replaces it by write-then-rename. */
export const TRACES_READER_TOKEN_FILE = `${TRACES_READER_DIR}/token`

/** `flock` lock file. Every script that reads then replaces the reader token file runs inside `flock -w 30` on it. */
export const TRACES_READER_LOCK = `${TRACES_READER_DIR}/.lock`

/** The Langfuse Viewer key pair as `<public>:<secret>`, read by the gate. Owned `root:READER_GATE_USER_ID`, mode 0440. */
export const TRACES_READER_LANGFUSE_FILE = `${TRACES_APP_DIR}/secrets/reader-gate/langfuse-basic`

/** The Grafana Viewer service-account token, read by the Grafana MCP server. Owned `root:GRAFANA_MCP_USER_ID`, mode 0440. */
export const TRACES_GRAFANA_MCP_TOKEN_FILE = `${TRACES_APP_DIR}/secrets/grafana-mcp/token`

/** Siblings of a credential file: the candidate being checked, and the one it replaced. */
export const READER_STAGED_SUFFIX = '.staged'
export const READER_PREVIOUS_SUFFIX = '.previous'

/** What a credential file holds until the operator installs a real one. Never a working credential. */
export const READER_LANGFUSE_PLACEHOLDER = 'pk-lf-unset:sk-lf-unset'
export const READER_GRAFANA_PLACEHOLDER = 'glsa_unset'
