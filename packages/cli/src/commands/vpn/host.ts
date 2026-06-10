// ─── VPN CLI host validation ──────────────────────────────────────────────────
//
// Validates VPN_HOST values before they are passed as ssh argv arguments.
// A value starting with `-` would be interpreted by ssh as an option flag,
// enabling ProxyCommand injection and local code execution.
//
// This is the CLI-side validator. The deploy-side validator lives at
// apps/vpn/src/host.ts. Both enforce the same rules.

const VALID_HOST_RE = /^[a-z\d][a-z\d.\-]*$/i

/**
 * Validates a candidate VPN_HOST value against a strict hostname allowlist.
 *
 * Accepts: hostnames, FQDNs, IPv4 addresses, `localhost`.
 * Rejects: empty strings, values starting with `-`, and anything containing
 * characters outside `[A-Za-z0-9.-]`.
 *
 * @throws {Error} when empty or not a valid hostname. The rejected value is
 *   never included in the message (it may be a misdirected secret).
 * @returns The validated host string (unchanged).
 */
export function validateVpnHost(host: string): string {
  if (!host) {
    throw new Error('Invalid VPN_HOST: value is empty')
  }

  if (!VALID_HOST_RE.test(host)) {
    // Do NOT echo the value — it may be a secret that was redirected via --key
    throw new Error(
      `Invalid VPN_HOST: value is not a valid hostname (must match ${String.raw`[A-Za-z0-9][A-Za-z0-9.\-]*`})`,
    )
  }

  return host
}
