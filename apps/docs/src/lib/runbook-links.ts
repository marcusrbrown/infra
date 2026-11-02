import {existsSync, readFileSync} from 'node:fs'
import {join, resolve} from 'node:path'

export interface RunbookLink {
  slug: string
  /** The runbook's H1, which is also its rendered page title. */
  title: string
}

/** The repo root when the build runs from `apps/docs`. */
export const defaultRepoRoot = (cwd: string = process.cwd()): string => resolve(cwd, '../..')

/** Resolve runbook slugs to titles from `docs/runbooks/<slug>.md`; throws for a slug with no file. */
export function resolveRunbooks(slugs: readonly string[], repoRoot: string = defaultRepoRoot()): RunbookLink[] {
  return slugs.map(slug => {
    const path = join(repoRoot, 'docs/runbooks', `${slug}.md`)
    if (!existsSync(path))
      throw new Error(`services.ts names runbook "${slug}" but docs/runbooks/${slug}.md does not exist`)
    const title = readFileSync(path, 'utf8')
      .split('\n')
      .find(line => line.startsWith('# '))
      ?.slice(2)
      .trim()
    if (title === undefined || title === '') throw new Error(`docs/runbooks/${slug}.md has no H1`)
    return {slug, title}
  })
}
