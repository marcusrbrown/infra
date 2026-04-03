# KeeWeb Deploy Package

Self-hosted KeeWeb v1.18.7 password manager at `kw.igg.ms`. Download-based build (not from source).

## WHERE TO LOOK

| Task | Location | Notes |
| --- | --- | --- |
| Change KeeWeb version | `src/build.ts` | Update `KEEWEB_VERSION` constant |
| Modify nginx config | `config/kw.igg.ms.conf` | Requires `--nginx` flag to deploy |
| Change app config template | `config/config.json` | Never put real secrets here |
| Modify deploy behavior | `deploy.sh` | Content-only by default |
| Re-provision server user | `server/setup-deploy-user.ts` | Run via `bun run` locally, SSHes into server |

## BUILD FLOW

1. `src/build.ts` downloads `KeeWeb-{version}.html.zip` from GitHub Releases
2. Zip cached in `.cache/` (skipped if already present)
3. `dist/` cleared and rebuilt every run
4. `DROPBOX_APP_SECRET` env var injected into `dist/config.json` at `.settings.dropboxSecret`
5. `config/kw.igg.ms.conf` copied to `dist/`

**Critical**: `config/config.json` (template) is never modified. Secret only goes into `dist/config.json`.

## DEPLOY FLOW

```text
deploy.sh [--nginx]
  ├── Validates dist/index.html and dist/config.json exist
  ├── rsync dist/ → deploy-kw@box.heatvision.co:/home/user-data/www/kw.igg.ms/
  ├── ssh: sudo /usr/local/bin/kw-deploy-activate (set perms 775 + setgid)
  └── [--nginx] backup existing conf → scp new conf → nginx -t → reload (auto-restore on failure)
```

## SERVER

- User: `deploy-kw` (uid 997, `www-data` group)
- Site path: `/home/user-data/www/kw.igg.ms/`
- Sudo scope: only `/usr/local/bin/kw-deploy-activate`
- Backup dir: `/home/deploy-kw/backups/`
- Activation: `chmod -R 775` + `find -type d -exec chmod g+s` for group-write persistence

## ANTI-PATTERNS

- Never commit real `dropboxSecret` — template stays empty, CI injects from env.
- Never run `deploy.sh` without building first — it validates `dist/` contents.
- Never deploy nginx config without `--nginx` flag — content-only is the safe default.
- `rsync` uses `--no-times --no-perms` to avoid permission errors with the deploy user.
