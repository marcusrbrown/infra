// ─── Umami host validation ────────────────────────────────────────────────────
//
// Validates UMAMI_DOMAIN values before they are passed as ssh argv arguments.
// A value starting with `-` would be interpreted by ssh as an option flag,
// enabling ProxyCommand injection and local code execution.

const VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i

/**
 * Validates a candidate UMAMI_DOMAIN value against a strict hostname allowlist.
 *
 * Accepts: hostnames, FQDNs, IPv4 addresses, `localhost`.
 * Rejects: empty strings, values starting with `-`, and anything containing
 * characters outside `[A-Za-z0-9.-]`.
 *
 * @throws {Error} with a sanitized excerpt of the invalid value.
 * @returns The validated host string (unchanged).
 */
export function validateUmamiHost(host: string): string {
  if (!host) {
    throw new Error('Invalid UMAMI_DOMAIN: value is empty')
  }

  if (!VALID_HOST_RE.test(host)) {
    // Truncate to 30 chars and strip non-printable bytes before echoing back
    const excerpt = host.slice(0, 30).replaceAll(/[^\u0020-\u007E]/g, '?')
    throw new Error(`Invalid UMAMI_DOMAIN: "${excerpt}" — must match ${String.raw`[A-Za-z0-9][A-Za-z0-9.\-]*`}`)
  }

  return host
}
