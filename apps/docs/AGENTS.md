# apps/docs — Public docs site

Starlight site published to `https://mrbro.dev/infra/` by `.github/workflows/site.yaml`. It renders the repo's own markdown, Archify diagrams and a status view built from the `status-history` artifact. It is a private workspace, not a deploy package: no droplet, no SSH, no secrets. Day-2 operations are in `docs/runbooks/docs-site.md`.

## Layout

| Path | Role |
| --- | --- |
| `scripts/` | Build steps and their tests: `generate-content.ts`, `render-diagrams.ts`, `redaction-gate.ts`, `ip-classify.ts`, `verify-status-output.ts` |
| `diagrams/` | Archify specs, named `<name>.<type>.json`; nested folders flatten to `-` |
| `redaction/` | Gate data: vendored secret rules and notice, TLD list, `hostname-allowlist.json` |
| `fixtures/history/` | Committed history used by PR builds and local runs |
| `src/` | Astro pages, components, content collection config, `data/services.ts`, and the history reader and view in `lib/` |

Gitignored output: `src/content/docs/{architecture,guides,runbooks,solutions}`, `.diagrams/`, `public/diagrams/`, `src/generated/`, `dist/`.

## Build pipeline

`bun run --cwd apps/docs build` runs, in order:

1. `generate` copies rendered sources into `src/content/docs`, takes titles from the H1, and rewrites links to site routes or commit-pinned GitHub links.
2. `diagrams` renders each spec with Archify, publishes only the `*.html` files, and writes the manifest.
3. `redact:source` runs the gate on the source markdown.
4. `astro build` writes `dist`.
5. `redact:dist` runs the gate on every text file in `dist`.
6. `verify:status` checks the built status pages against the history source.

History comes from `STATUS_HISTORY_DIR`, or the fixture when it is unset. `STATUS_HISTORY_REQUIRED=1` makes an unset directory a build error, so a publishing build never falls back to the fixture. CI sets both on every non-PR run.

## Adding things

- **Diagram:** add `diagrams/<name>.<type>.json`, then embed it with `<Diagram name="<name>" title="…" />`. Per-app specs live in `diagrams/apps/` and attach to the service page by name.
- **Rendered source:** add the path to `discoverSources` and `RENDERED_PATH_RE` in `scripts/generate-content.ts`, add the path to the `paths` filters in `site.yaml`, and cover it with a test.
- **Service:** add the app to the shared status contract, give it an entry in `src/data/services.ts` and an `apps/<name>.architecture.json` spec, and add its fixture history file.
- **Hostname:** a reasoned entry in `redaction/hostname-allowlist.json`, in the same PR as the text that needs it.

## Anti-patterns

- **Never exempt a gate finding by pattern.** Allowlist a real hostname with a reason and a narrow scope; reword anything else.
- **Never publish a `.delivery.json`.** Archify receipts stay in `.diagrams/`; only `*.html` is copied to `public/`.
- **Never render non-bounded history detail.** Status pages show only the closed result codes and the bounded `at_gate`, `running` and `none` details.
- **Never print a secret finding's match.** Report the pattern ID, file and line only.
- **Never deploy a directory the gate did not scan.** The Pages artifact is exactly `apps/docs/dist`.
- **Never let a pull request publish.** PR builds use the fixture and have no write permission.
