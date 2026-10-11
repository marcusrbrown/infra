// ─── Gateway Docker volume naming + existence probe ───────────────────────────
//
// Docker Compose prefixes named volumes with the project name, so the mitmproxy
// CA volume on the gateway droplet is `fro-bot_mitmproxy-certs`, not the bare
// compose key `mitmproxy-certs`. `docker run -v <missing>:/x` silently creates
// an empty volume, so backup/restore probe for the volume first and fail closed.
//
// GATEWAY_COMPOSE_PROJECT_NAME must match COMPOSE_PROJECT_NAME in
// apps/gateway/src/deploy.ts (the CLI cannot import app code; volume.test.ts
// guards against drift).

export const GATEWAY_COMPOSE_PROJECT_NAME = 'fro-bot'
export const MITMPROXY_CERTS_VOLUME = `${GATEWAY_COMPOSE_PROJECT_NAME}_mitmproxy-certs`

const VOLUME_EXISTS_SENTINEL = 'EXISTS'
const VOLUME_MISSING_SENTINEL = 'MISSING'

/**
 * Remote shell command that reports whether a Docker volume exists.
 * Always exits 0 on a reachable host and prints exactly one sentinel, so SSH or
 * docker-daemon failures (non-zero exit / unrecognized output) are distinguishable
 * from a genuinely absent volume. `volume` must be a static constant, never user input.
 */
export function volumeProbeCommand(volume: string): string {
  return `docker volume inspect ${volume} >/dev/null 2>&1 && echo ${VOLUME_EXISTS_SENTINEL} || echo ${VOLUME_MISSING_SENTINEL}`
}

/**
 * Interprets the result of {@link volumeProbeCommand}. Fails closed: only exit 0
 * with the `EXISTS` sentinel passes.
 * Returns an error string naming the volume, or undefined when the volume exists.
 */
export function checkVolumeProbeResult(
  volume: string,
  result: {stdout: string; stderr: string; exitCode: number},
): string | undefined {
  if (result.exitCode !== 0) {
    return `Could not verify Docker volume ${volume} on the gateway host (exit ${result.exitCode}): ${result.stderr.trim() || 'unknown error'}`
  }

  const sentinel = result.stdout.trim()
  if (sentinel === VOLUME_EXISTS_SENTINEL) {
    return undefined
  }
  if (sentinel === VOLUME_MISSING_SENTINEL) {
    return `Docker volume ${volume} does not exist on the gateway host; refusing to continue (it would be created empty as a side effect).`
  }
  return `Could not verify Docker volume ${volume} on the gateway host: unrecognized probe output`
}
