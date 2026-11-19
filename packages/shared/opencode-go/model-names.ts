/**
 * Name handling shared by the docs parser and the snapshot join: one normalisation, one reviewed alias map, and one
 * bound on how much upstream text an error message may carry.
 */

/**
 * Docs display names that do not normalize to the API's `name`, mapped to the API id they mean. Reviewed by hand:
 * add an entry only after checking that the two names are the same model. The docs page calls the model
 * "DeepSeek V4.1 Flash"; the API names it "DeepSeek V4.1 Flash 1017".
 */
export const DOCS_NAME_ALIASES: Readonly<Record<string, string>> = {
  'deepseek v4.1 flash': 'deepseek-v4.1-flash',
}

/** Case, whitespace and hyphen/space differences are not differences between names. Nothing else is. */
export const normalizeModelName = (name: string): string =>
  name.toLowerCase().replaceAll('-', ' ').replaceAll(/\s+/g, ' ').trim()

const MAX_ECHOED_CHARS = 80

/** Cap upstream text that goes into an error message or log line, so a malformed page cannot dump a huge string. */
export const excerpt = (text: string, max = MAX_ECHOED_CHARS): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`

/** Upstream text as a bounded, double-quoted token for a message. */
export const quoted = (text: string): string => `"${excerpt(text)}"`
