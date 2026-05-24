/**
 * Minimal `ctx` interface every MCP-capturable action accepts.
 *
 * Structural subtype of goke's real `GokeExecutionContext` — actions
 * consume only `console.{log,error}`, `process.{stdout,stderr}.write`,
 * and `process.exit`, never the `fs` surface. Source files import this
 * shape from this module so the action contract is defined in one place.
 *
 * The `write` parameter is `string` (narrower than goke's real
 * `string | Uint8Array`) because every action passes string values;
 * `CapturedCtx.write(string | Uint8Array)` is still assignable to
 * `ActionCtx.write(string)` via contravariance, so tests using
 * `CapturedCtx` satisfy this interface.
 */
export interface ActionCtx {
  console: {
    log: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
  process: {
    stdout: {write: (chunk: string) => void}
    stderr: {write: (chunk: string) => void}
    exit: (code: number) => never | void
  }
}
