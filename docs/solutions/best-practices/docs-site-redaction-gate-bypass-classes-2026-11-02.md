---
title: "Docs site redaction gate: bypass classes closed and accepted limits"
date: 2026-11-02
problem_type: best_practice
component: tooling
severity: medium
module: apps/docs
root_cause: missing_validation
resolution_type: code_fix
symptoms:
  - "A public address written with ideographic, fullwidth or halfwidth full stops produced no finding"
  - "An address or host split across syntax-highlighter spans in a rendered code block produced no finding"
  - "A host on a non-HTTP URL scheme or an SCP-style remote on an unlisted TLD produced no finding"
  - "Page text in Pagefind fragment files and symlink targets in dist were never scanned"
tags:
  - redaction-gate
  - docs-site
  - pagefind
  - shiki
  - defang
  - symlink
  - url-scheme
---

# Docs site redaction gate: bypass classes closed and accepted limits

Review on #1757 found five gaps in the gate. All were closed before merge; nothing shipped.

## Problem

The docs gate (`apps/docs/scripts/redaction-gate.ts` plus `ip-classify.ts`) blocks publication of globally routable IPs, unlisted hostnames and secret-shaped strings. It runs on the source markdown and again on `apps/docs/dist`. Five input shapes carried a public address or host to the Pages artifact without a finding.

## Symptoms

- A four-octet public address written with ideographic, fullwidth or halfwidth full stops: no finding.
- A public address in a rendered code block, split across styled highlighter spans: no finding.
- A hostname on a database, SSH or Redis style URL, or an SCP-style remote, on a TLD outside the short list: no finding.
- Page text inside Pagefind `.pf_fragment` files was never scanned.
- A symlink in `dist` could ship an unscanned target.

## What Didn't Work

- **Text extraction that kept attributes.** The first HTML extractor inserted attribute values and newlines between adjacent text nodes. Shiki emits every token as a styled span, so a value split across spans never reconstructed.
- **Exempting Pagefind files as gzip.** Fragments are gzip, but they carry page text verbatim.
- **Checking URL hosts against the short TLD list only.** The list keeps bare dotted names such as code identifiers from matching. It must not decide which URL hosts get checked.

## Solution

1. **Unicode full stops.** The defang pass maps them to `.`:

   ```ts
   const DEFANG_RE =
     /\[\.\]|\[dot\]|\(\.\)|\(dot\)|\[:\](?=\/\/)|hxxps?(?=:\/\/|\[:\]\/\/)|%2e|%2f|%3a|%40|[\u3002\uFF0E\uFF61]/gi
   ```

2. **Symlinks.** `scanDist` reports every symlink as a finding and never follows it:

   ```ts
    * Any symlink fails: the Pages upload dereferences symlinks, so a target outside the scan would ship.
   ```

3. **Pagefind fragments.** Fragments are gunzipped and scanned as plain page text, scoped like the matching `.html` page. Only the binary containers stay unscanned:

   <!-- prettier-ignore -->
   ```ts
   const PAGEFIND_FRAGMENT_EXTENSION = '.pf_fragment'
   const PAGEFIND_OPAQUE_EXTENSIONS = new Set(['.pf_index', '.pf_meta', '.pf_filter', '.pagefind'])
   ```

4. **Highlighter spans.** `extractHtml` returns two streams per file, and `scanText` scans each. `visible` drops inline tags and turns block tags into line breaks. `invisible` holds attribute values, comments and script or style bodies, one per line. Both keep original offsets for line numbers:

   ```ts
    * `visible`: inline tags are dropped, so a token that Shiki split across `<span>`s is whole again; block tags
   ```

5. **URL schemes and SCP remotes.** Any `scheme://[userinfo@]host` has its host checked on any TLD. Userinfo is excluded from bare-host matching, so a dotted userinfo name is not reported as a host. IP detection still scans the whole text, userinfo included, so an IP found there is reported. `file://` is skipped:

   <!-- prettier-ignore -->
   ```ts
       // `file://` names a path, not a host: `file:///etc/hosts`, and tools that take `file://merged.json`.
   ```

   SCP-style remotes (`user@host.tld:path`) match only when a path character follows the colon, so `ops@host.tld: text` in prose is not a remote.

IPv4-mapped IPv6 addresses are unwrapped before classification (`ip-classify.ts`). Global reachability follows the IANA special-purpose tables.

## Why This Works

Each fix closes a representation gap between what the scanner reads and what a reader or browser receives: a different codepoint, tag layout, container or scheme. Scanning two HTML streams keeps attribute values from sitting between the halves of a split visible token while still checking them. Treating symlinks as findings removes the mismatch between the scanned `dist` and the uploaded one, because the upload follows links and the scanner did not.

Host and IP findings print the matched value. A secret finding carries the pattern ID only: the `Finding` secret variant has no field that could hold a value. The allowlist is explicit: each entry is an exact host with a reason and a scope. `parseAllowlist` requires exact hosts (no wildcard hosts) and rejects the scope patterns `**`, `**/*` and `*`. Narrower scoped globs such as `**/*.html` are allowed.

## Prevention

- **Every bypass gets a test in `redaction-gate.test.ts`.** The suite covers unicode dots, symlinks of every target shape, fragment text, split spans and each URL scheme. Write the case for the bypass shape before the fix.
- **A new output representation needs a new scan path.** When the site starts emitting another file kind or compression, scan its text, or document why it holds only tokenized data.
- **Keep the build order pinned.** `generate → diagrams → redact:source → astro build → redact:dist → verify:status`. A conventions test (`runs the build gates in order`) asserts the list from `apps/docs/package.json`.
- **Fix false positives by rewording, not by pattern exemption.** The npm scope form `@scope/pkg` is skipped by the bare-host rule. File extensions can never become TLDs: the loader throws on a clash. Two ordinary code-identifier suffixes came off the bare-host TLD list for the same reason.
- **Do not widen the gate's promise.** It catches accidental leaks, not a malicious author. The accepted limits are listed under "Known limits" in [`apps/docs/AGENTS.md`](../../../apps/docs/AGENTS.md).
- **Frontmatter of solution docs is published.** The solutions index renders `title`, `module` and `problem_type`, and the source pass scans exactly those fields. Bodies are not published. Keep hostnames and IPs out of those three fields unless the host is allowlisted.

See [`docs/runbooks/docs-site.md`](../../runbooks/docs-site.md) for allowlisting a hostname and fixing a gate failure.
