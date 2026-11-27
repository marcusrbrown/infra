/** Read a whole file as text. A missing file throws an error with `code: 'ENOENT'`. */
export function readTextFile(path: string): Promise<string> {
  return Bun.file(path).text()
}

/** The errno code of a thrown value, when it has one. */
export function errorCode(error: unknown): string | undefined {
  if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string')
    return error.code
  return undefined
}
