/**
 * Lowercase ASCII `A-Z` only. Unicode lowercasing can change a string's length, which would misalign match
 * offsets between the folded copy and the original text.
 */
function lowerAscii(value: string): string {
  let result = ''
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    result += code >= 65 && code <= 90 ? String.fromCodePoint(code + 32) : char
  }
  return result
}

/**
 * Replace every occurrence of `host` in `text` with `<host>`, matching ASCII letters case-insensitively and
 * every other character literally. OpenSSH lowercases the hostname in its errors, and the host can be a
 * misdirected secret, so it must never survive in text returned to an MCP consumer. An empty host is a no-op.
 */
export function redactHost(text: string, host: string): string {
  if (!host) return text

  const foldedText = lowerAscii(text)
  const foldedHost = lowerAscii(host)

  let result = ''
  let cursor = 0
  let match = foldedText.indexOf(foldedHost, cursor)
  while (match !== -1) {
    result += `${text.slice(cursor, match)}<host>`
    cursor = match + foldedHost.length
    match = foldedText.indexOf(foldedHost, cursor)
  }

  return result + text.slice(cursor)
}
