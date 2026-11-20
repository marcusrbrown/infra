import type {AppId} from '@marcusrbrown/infra-shared/status/history-schema'
import {existsSync, readFileSync} from 'node:fs'
import {join} from 'node:path'
import process from 'node:process'

import {APP_IDS, APPS_NOT_YET_DEPLOYED} from '@marcusrbrown/infra-shared/status/history-schema'

import {historyDirFromEnv} from '../src/lib/history-source'
import {NOT_YET_DEPLOYED_LABEL, NOT_YET_DEPLOYED_TEXT, RESULT_DISPLAY, VERDICT_DISPLAY} from '../src/lib/history-view'

/**
 * Build-level check on the rendered status pages: they exist, carry the fixture marker exactly when the build
 * used the fixture, show the last-sample time with its stale-warning hook, show sample counts and coverage, and never show a percentage next to a figure.
 * An app on `APPS_NOT_YET_DEPLOYED` is held to the opposite: its page and its status row say it is not yet deployed
 * and show no verdict, result or figure.
 */

export const FIXTURE_MARKER = 'data-history-source="fixture"'
/** The hidden stale warning that the shared last-sample client script reveals. */
export const STALE_HOOK = 'id="status-stale"'

/** What a service page says when the history holds no sample for it (see `AppStatus.astro`). */
export const NO_DATA_TEXT = 'No data yet. No samples have been recorded for this service.'

/** Every word a verdict or a result can show, bar the not-yet-deployed one. None may appear for an undeployed app. */
const HEALTH_WORDS = new RegExp(
  String.raw`\b(?:${[...Object.values(VERDICT_DISPLAY), ...Object.values(RESULT_DISPLAY)]
    .map(display => display.word)
    .filter(word => word !== NOT_YET_DEPLOYED_LABEL)
    .join('|')})\b`,
)

/** Visible text only: tags (and so inline styles and attributes), scripts and styles are removed. */
export function visibleText(html: string): string {
  return html
    .replaceAll(/<(script|style)\b[\s\S]*?<\/\1>/gi, ' ')
    .replaceAll(/<[^>]*>/g, ' ')
    .replaceAll(/\s+/g, ' ')
}

/** The status page's table row for `app`, as visible text; undefined when the page has none. */
function statusRowText(html: string, app: AppId): string | undefined {
  const row = (html.match(/<tr\b[\s\S]*?<\/tr>/g) ?? []).find(candidate => candidate.includes(`/services/${app}/`))
  return row === undefined ? undefined : visibleText(row)
}

export function verifyStatusOutput(
  distDir: string,
  options: {expectFixture: boolean; notYetDeployed?: readonly AppId[]},
): string[] {
  const problems: string[] = []
  const notYetDeployed = options.notYetDeployed ?? APPS_NOT_YET_DEPLOYED
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
    if (!text.includes('Last sample')) problems.push(`${page}: missing the last-sample time`)
    if (!html.includes(STALE_HOOK)) problems.push(`${page}: missing the stale-warning hook`)

    if (page === 'status') {
      for (const app of notYetDeployed) {
        const row = statusRowText(html, app)
        if (row === undefined) problems.push(`status: no row for ${app}`)
        else {
          if (!row.includes(NOT_YET_DEPLOYED_LABEL))
            problems.push(`status: the ${app} row does not say it is not yet deployed`)
          if (HEALTH_WORDS.test(row)) {
            problems.push(`status: the ${app} row shows a result or verdict for an app that is not yet deployed`)
          }
        }
      }
      continue
    }

    const app = APP_IDS.find(candidate => page === `services/${candidate}`)
    if (app !== undefined && notYetDeployed.includes(app)) {
      // Nothing about its health may be shown, and "No data yet" is a different state (a deployed app, no samples).
      if (!text.includes(NOT_YET_DEPLOYED_TEXT)) problems.push(`${page}: missing the not-yet-deployed statement`)
      if (/samples? recorded of about \d+ expected/.test(text)) {
        problems.push(`${page}: shows a coverage figure for an app that is not yet deployed`)
      }
      if (/\d+ of \d+ samples? passed/.test(text)) {
        problems.push(`${page}: shows a passed-sample count for an app that is not yet deployed`)
      }
      if (HEALTH_WORDS.test(text)) problems.push(`${page}: shows a verdict for an app that is not yet deployed`)
      if (text.includes('No data yet'))
        problems.push(`${page}: shows "No data yet" for an app that is not yet deployed`)
      continue
    }

    // A service with no samples yet says so; it has no coverage or passed-sample figure to show.
    if (page.startsWith('services/') && !text.includes(NO_DATA_TEXT)) {
      if (!/samples? recorded of about \d+ expected/.test(text)) problems.push(`${page}: missing the coverage figure`)
      if (!/\d+ of \d+ samples? passed/.test(text)) problems.push(`${page}: missing "N of M samples passed"`)
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
