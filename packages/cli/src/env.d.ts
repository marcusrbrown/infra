// Ambient module declarations for Bun file-asset imports.
// Bun's `with {type: 'file'}` loader resolves these to string paths at
// source-run time and rewrites them to dist-relative paths under `bun build`.

declare module '*/resources/known_hosts' {
  const path: string
  export default path
}
