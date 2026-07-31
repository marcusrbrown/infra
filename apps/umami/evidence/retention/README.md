# Umami retention evidence

Retention attestations are version-controlled, dated Markdown records of one supervised rollout, an explicit operator-override GO, or an explicit NO-GO. The procedure is defined by [`apps/umami/AGENTS.md`](../../AGENTS.md); copy [`TEMPLATE.md`](TEMPLATE.md) for each new record.

## Naming

Use UTC and a short operator handle:

```text
YYYY-MM-DDTHHMMZ-<operator>-<go|no-go>.md
```

Examples: `2026-07-31T0045Z-mrb-go.md`, `2026-07-31T0045Z-mrb-no-go.md`.

## Immutable procedure

1. Copy `TEMPLATE.md` to the dated filename.
2. Fill it from command output and approved plan/revision records. Record hashes, counts, statuses, and categories only.
3. Do not include secrets, raw visitor data, identifiers, URLs with query strings, or raw log payloads.
4. After review, commit the completed Markdown record without later editing it. A correction or supersession is a new dated record that names the record it replaces.
5. Compute the final evidence file SHA-256 externally after filling it. Do not add that digest inside the file; a self-referential hash is not useful.

The committed record path and its externally computed SHA-256 are consumed by the `mrbro.dev` activation review. Actual records live here as dated Markdown files; `TEMPLATE.md` is not an attestation.
