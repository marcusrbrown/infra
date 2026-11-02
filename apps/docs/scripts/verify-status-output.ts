import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import process from 'node:process'

import {APP_IDS} from '@marcusrbrown/infra-shared/status/history-schema'

import {historyDirFromEnv} from '../src/lib/history-source'

/**
 * Build-level check on the rendered status pages: they exist, carry the fixture marker exactly when the build
 * used the fixture, show sample counts and coverage, and never show a percentage next to a figure.
 */

export const FIXTURE_MARKER = 'data-history-source="fixture"'

/** Visible text only: tags (and so inline styles and attributes), scripts and styles are removed. */
export function visibleText(html: string): string {
  return html
    .replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
}

export function verifyStatusOutput(distDir: string, options: {expectFixture: boolean}): string[] {
  const problems: string[] = []
  const pages = ['status', ...APP_IDS.map(app => `services/${app}`)]

  for (const page of pages) {
    const path = join(distDir, page, 'index.html')
    if (!existsSync(path)) {
      problems.push(`${page}/index.html was not built`)
      continue
    }

    const html = readFileSync(path, 'utf8')
    const hasMarker = html.includes(FIXTURE_MARKER)
    if (options.expectFixture && !hasMarker) problems.push(`${page}: fixture build is missing the fixture marker`)
    if (!options.expectFixture && hasMarker) problems.push(`${page}: real-history build carries the fixture marker`)

    const text = visibleText(html)
    if (/\d\s*%/.test(text)) problems.push(`${page}: shows a percentage next to a figure`)
    if (page.startsWith('services/')) {
      if (!/samples? recorded of about \d+ expected/.test(text)) problems.push(`${page}: missing the coverage figure`)
      if (!/\d+ of \d+ samples? passed/.test(text)) problems.push(`${page}: missing "N of M samples passed"`)
    } else if (!text.includes('Last sample')) {
      problems.push(`${page}: missing the last-sample time`)
    }
  }

  return problems
}

if (import.meta.main) {
  const dist = process.argv[2] ?? 'dist'
  const expectFixture = historyDirFromEnv() === undefined
  const problems = verifyStatusOutput(dist, {expectFixture})
  if (problems.length > 0) {
    for (const problem of problems) console.error(`status output: ${problem}`)
    process.exit(1)
  }
  console.log(`status output: ${1 + APP_IDS.length} pages verified (${expectFixture ? 'fixture' : 'artifact'} history)`)
}
