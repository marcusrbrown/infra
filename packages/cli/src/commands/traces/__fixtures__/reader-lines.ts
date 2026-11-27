import {createHash} from 'node:crypto'

// Token files as whole-file texts, for the test that holds the gate's parser (`apps/traces/reader-gate/tokens.ts`) and
// the CLI's shell classifier to one verdict: the gate refuses the whole file for one malformed line, and a CLI that
// reads the same file differently can show a clean roster while the gate denies everyone.

const sha12 = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 12)

const TOKEN = `trc_${'A'.repeat(43)}`
const OTHER_TOKEN = `trc_${'B'.repeat(43)}`
const VOID_TOKEN = `trc_void_${'V'.repeat(43)}`
const DATE = '2026-10-01T00:00:00.000Z'

const reader = (token = TOKEN, consumer = 'systematic', date = DATE): string =>
  `${token} ${sha12(token)} ${consumer} ${date}`
const voidLine = (date = DATE): string => `${VOID_TOKEN} void ${date}`

export interface ReaderLineCase {
  name: string
  /** The whole token file. */
  text: string
}

/** Files the gate accepts. */
export const ACCEPTED_FILES: ReaderLineCase[] = [
  {name: 'one reader', text: `${reader()}\n`},
  {name: 'a reader and a void line', text: `${voidLine()}\n${reader()}\n`},
  {name: 'a void line alone', text: `${voidLine()}\n`},
  {name: 'two readers of different consumers', text: `${reader()}\n${reader(OTHER_TOKEN, 'fro-bot')}\n`},
  {name: 'two readers of one consumer', text: `${reader()}\n${reader(OTHER_TOKEN)}\n`},
  {name: 'no newline after the last line', text: reader()},
  {name: 'blank lines between lines', text: `\n\n${reader()}\n\n${voidLine()}\n\n`},
  {name: 'a line of spaces and tabs', text: ` \t \n${reader()}\n`},
  {name: 'a date without milliseconds', text: `${reader(TOKEN, 'systematic', '2026-10-01T00:00:00Z')}\n`},
  {name: 'a date with minutes only', text: `${reader(TOKEN, 'systematic', '2026-10-01T00:00Z')}\n`},
  {name: 'a date with a long fraction', text: `${reader(TOKEN, 'systematic', '2026-10-01T00:00:00.123456Z')}\n`},
  {name: 'a date at hour 24, all zero', text: `${reader(TOKEN, 'systematic', '2026-10-01T24:00:00Z')}\n`},
  {name: 'a void line with a short date', text: `${voidLine('2026-10-01T00:00Z')}\n`},
  {name: 'the longest consumer name', text: `${reader(TOKEN, `a${'b'.repeat(30)}`)}\n`},
  {name: 'the shortest token', text: `${reader(`trc_${'a'.repeat(32)}`)}\n`},
  {name: 'the longest token', text: `${reader(`trc_${'a'.repeat(128)}`)}\n`},
  {name: 'a token with hyphens and underscores', text: `${reader(`trc_${'a-b_'.repeat(11)}`)}\n`},
]

const withLine = (line: string): string => `${reader(OTHER_TOKEN, 'fro-bot')}\n${line}\n`

/** Files the gate refuses whole. */
export const REFUSED_FILES: ReaderLineCase[] = [
  {name: 'an empty file', text: ''},
  {name: 'only blank lines', text: '\n\n \t\n'},
  {name: 'two spaces between fields', text: withLine(`${TOKEN}  ${sha12(TOKEN)} systematic ${DATE}`)},
  {name: 'a leading space', text: withLine(` ${reader()}`)},
  {name: 'a trailing space', text: withLine(`${reader()} `)},
  {name: 'tab-separated fields', text: withLine(reader().replaceAll(' ', '\t'))},
  {name: 'CRLF line endings', text: `${reader()}\r\n`},
  {name: 'five fields', text: withLine(`${reader()} extra`)},
  {name: 'three fields', text: withLine(`${TOKEN} ${sha12(TOKEN)} systematic`)},
  {name: 'one field', text: withLine(TOKEN)},
  {name: 'a void line with four fields', text: withLine(`${voidLine()} extra`)},
  {name: 'a void line with a bad date', text: withLine(`${VOID_TOKEN} void 2026-10-01`)},
  {name: 'a void line that does not say void', text: withLine(`${VOID_TOKEN} nothing ${DATE}`)},
  {name: 'a void line with a short token', text: withLine(`trc_void_short void ${DATE}`)},
  {name: 'a void line with a trailing space', text: withLine(`${voidLine()} `)},
  {name: 'a token that is too short', text: withLine(reader('trc_short'))},
  {name: 'a token that is too long', text: withLine(reader(`trc_${'a'.repeat(129)}`))},
  {name: 'a token with a character outside the alphabet', text: withLine(reader(`trc_${'a'.repeat(40)}!`))},
  {name: 'a token without the prefix', text: withLine(reader(`xyz_${'a'.repeat(40)}`))},
  {name: 'a wrong fingerprint', text: withLine(`${TOKEN} 000000000000 systematic ${DATE}`)},
  {name: 'a fingerprint in capitals', text: withLine(`${TOKEN} ${sha12(TOKEN).toUpperCase()} systematic ${DATE}`)},
  {name: 'a short fingerprint', text: withLine(`${TOKEN} ${sha12(TOKEN).slice(0, 11)} systematic ${DATE}`)},
  {name: 'a consumer in capitals', text: withLine(reader(TOKEN, 'Systematic'))},
  {name: 'a consumer that starts with a digit', text: withLine(reader(TOKEN, '1abc'))},
  {name: 'a consumer that is too long', text: withLine(reader(TOKEN, 'a'.repeat(32)))},
  {name: 'a consumer with an underscore', text: withLine(reader(TOKEN, 'a_b'))},
  {name: 'a date without the T', text: withLine(reader(TOKEN, 'systematic', '2026-10-01'))},
  {name: 'a date without the Z', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:00:00.000'))},
  {name: 'a date in month 13', text: withLine(reader(TOKEN, 'systematic', '2026-13-01T00:00:00.000Z'))},
  {name: 'a date in day 32', text: withLine(reader(TOKEN, 'systematic', '2026-10-32T00:00:00.000Z'))},
  {name: 'a date at hour 25', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T25:00:00.000Z'))},
  {name: 'a date at minute 60', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:60:00.000Z'))},
  {name: 'a date at second 60', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:00:60.000Z'))},
  {name: 'a date at hour 24 with minutes', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T24:30:00Z'))},
  {name: 'a date with an empty fraction', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:00:00.Z'))},
  {name: 'a date with a letter in the time', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:00:0aZ'))},
  {name: 'a date with an hour only', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00Z'))},
  {name: 'a date with a fourth time field', text: withLine(reader(TOKEN, 'systematic', '2026-10-01T00:00:00:00Z'))},
  {name: 'a date with month 00', text: withLine(reader(TOKEN, 'systematic', '2026-00-10T00:00:00Z'))},
  {name: 'the same token twice', text: `${reader()}\n${reader(TOKEN, 'fro-bot')}\n`},
  {name: 'a line of globbing characters', text: withLine('* * * *')},
  {name: 'a line of prose', text: withLine('not a token line at all')},
  {name: 'a good file and then garbage', text: `${reader()}\ngarbage\n`},
]
