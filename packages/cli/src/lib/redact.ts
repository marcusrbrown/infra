/**
 * Redact every occurrence of a host value from text, case-insensitively.
 *
 * Used to scrub a resolved SSH host out of error output before it surfaces to an
 * MCP consumer. The host can be a misdirected secret (an agent may point the
 * `--key` env-var selector at, e.g., `AWS_SECRET_ACCESS_KEY`), so its value must
 * never appear in returned errors.
 *
 * Two subtleties this handles that a plain `replaceAll(host, ...)` does not:
 *   1. OpenSSH lowercases the hostname in "Could not resolve hostname <name>"
 *      stderr, so the match must be case-insensitive.
 *   2. Validated hosts contain `.` and `-`, which are regex-significant, so the
 *      host is escaped before building the matcher (no over-redaction).
 *
 * An empty/falsy host is a no-op (an empty matcher would match everywhere).
 */
export function redactHost(text: string, host: string): string {
  if (!host) return text
  const escaped = host.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`)
  return text.replaceAll(new RegExp(escaped, 'gi'), '<host>')
}
