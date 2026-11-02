# Docs Site

The public docs site at `https://mrbro.dev/infra/` is built by `.github/workflows/site.yaml` from `apps/docs`. It renders `ARCHITECTURE.md`, `STRUCTURE.md`, each app's `AGENTS.md`, `docs/runbooks/`, and `docs/solutions/`, plus Archify diagrams and a status page fed by the `status-history` artifact. This runbook covers enablement, history, recovery, takedown, and the redaction gate. Package internals are in `apps/docs/AGENTS.md`.

---

## How it flows

1. `Status Snapshot` (`status-snapshot.yaml`) runs at minutes 11 and 41 of every hour. It is the only writer of the `status-history` artifact.
2. When a snapshot run completes, `Site` starts through `workflow_run`. It builds only if that run succeeded, ran on `main`, and came from `schedule` or `workflow_dispatch`.
3. `Site` downloads the triggering run's artifact, builds, runs the redaction gate twice, and deploys `apps/docs/dist`.
4. A push to `main` that touches a rendered source or `apps/docs/**`, or a manual dispatch, locates the newest usable artifact with `status history-locate` and fails if there is none.
5. Pull requests build with the committed fixture and never download history, upload a Pages artifact, or deploy.

History lives only in the artifact (7-day retention, newest copy wins). The site never writes it.

---

## One-time Pages enablement

Marcus does this by hand. It is a repo setting, so the workflow cannot do it.

1. Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Leave the custom domain empty. `mrbro.dev` comes from the user site, and this project site is served under `/infra/`.
3. Make sure the `github-pages` environment allows deployments from `main`.
4. Dispatch the workflow: `gh workflow run site.yaml --repo marcusrbrown/infra --ref main`.
5. Verify `https://mrbro.dev/infra/` serves the status page and a diagram. The next snapshot run should republish with one more sample.

Order matters: bootstrap the history first (below), then enable Pages, then dispatch `Site`. Before bootstrap, a main build fails on purpose.

---

## Bootstrap

Scheduled snapshots never create history. To create the first artifact:

```bash
gh workflow run status-snapshot.yaml --repo marcusrbrown/infra --ref main -f bootstrap=true
```

The run refuses if a valid history already exists, and refuses off `main`. Verify two samples per app after the next scheduled run.

---

## Expired or corrupt history

Snapshots stop for more than 7 days, or an invariant failure leaves a corrupt artifact: the history is gone or unreadable. Recovery accepts a **history reset**; the 90-day view starts over.

1. List the artifacts:

   ```bash
   gh api 'repos/marcusrbrown/infra/actions/artifacts?name=status-history&per_page=100' --jq '.artifacts[] | [.id, .created_at, .expired] | @tsv'
   ```

2. Delete every `status-history` artifact:

   ```bash
   gh api 'repos/marcusrbrown/infra/actions/artifacts?name=status-history&per_page=100' --jq '.artifacts[].id' \
     | xargs -I{} gh api -X DELETE repos/marcusrbrown/infra/actions/artifacts/{}
   ```

3. Bootstrap again (see above).

A lookup error is not the same as an empty history: the lookup exits non-zero on API errors, so an outage never triggers a reset. Retry the failed run before deleting anything.

---

## Emergency takedown

In this order, so nothing republishes while you unpublish:

1. Disable both workflows:

   ```bash
   gh workflow disable "Status Snapshot" --repo marcusrbrown/infra
   gh workflow disable Site --repo marcusrbrown/infra
   ```

2. Unpublish Pages:

   ```bash
   gh api -X DELETE repos/marcusrbrown/infra/pages
   ```

   Re-enabling later repeats the one-time enablement.

3. Optionally delete the remaining `status-history` artifacts (see the delete command above).

Anything already fetched or indexed stays out of reach. If a secret leaked, rotate it first; takedown does not undo exposure.

---

## Redaction gate

The gate runs on the source markdown and again on `apps/docs/dist`. A failure blocks the deploy.

### Allowlisting a hostname

A real hostname the docs need goes into `apps/docs/redaction/hostname-allowlist.json` in the same PR that adds it. Each entry carries:

- `host`: the hostname.
- `reason`: why it is public and needed.
- `scope`: the file classes it applies to, such as `**/*.md` or `**/*.html`.

Keep the scope narrow. Third-party runtime URLs in Archify HTML or Starlight bundles get a scoped entry, never a global one. A pattern-level exemption is not allowed.

### Fixing a gate failure

Reword the source. Hostname and IP findings print the value, file and line. A false positive (a non-hostname or non-IP that matched) is fixed by rewording, not by exempting it. Secret findings print the pattern ID only, never the match; find it in the file and line, remove it, and rotate the credential if it was real.

---

## Schedule auto-disable

GitHub disables scheduled workflows after 60 days without repo activity. If the daily report's snapshot-age row goes stale and no run appears, re-enable both:

```bash
gh workflow enable "Status Snapshot" --repo marcusrbrown/infra
gh workflow enable Site --repo marcusrbrown/infra
```

If snapshots were off for more than 7 days, the history has expired; follow the reset path above.

---

## Gap threshold

A gap is a spacing between samples of more than 45 minutes (`GAP_THRESHOLD_MS` in `apps/docs/src/lib/history-view.ts`). The cron runs every 30 minutes, so this leaves room for one late run. Tune it against measured jitter after a week of real data. Gaps are shown, never interpolated.
