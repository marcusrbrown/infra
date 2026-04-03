# Copilot Instructions

Read `AGENTS.md` at the repository root and `apps/keeweb/AGENTS.md` for full project conventions before making changes.

## Runtime

- **Bun only.** Never use `npm`, `pnpm`, or `yarn`.
- Run app scripts from the repo root: `bun run --cwd apps/<name> <script>`.
- There is no root-level `build` script. Build KeeWeb with `bun run --cwd apps/keeweb build`.

## Verification

Run these before marking work complete:

```sh
bun run lint
bunx tsc --noEmit
bun run --cwd apps/keeweb build
```

## TypeScript

- No `as any`, `@ts-ignore`, or `@ts-expect-error`. Fix the types.
- Never exclude TypeScript files from type checking.
- Prefer `satisfies` over type annotations when you want inference.
- Use discriminated unions over optional properties.
- Use `import type` for type-only imports.

## Formatting

- ESLint handles all formatting (via `eslint-plugin-prettier`). There is no separate Prettier command.
- Auto-fix with `bun run fix`.
- Do not create or modify `.prettierignore` — use `ignores` in `eslint.config.ts`.

## GitHub Actions

- Use `.yaml` extension for workflow files (not `.yml`).
- SHA-pin all actions to full commit hashes with `# vX.Y.Z` version comments.
- Never use `secrets: inherit` when calling reusable workflows in another org (e.g., `bfra-me/.github`). Pass secrets explicitly.
- Use `bun install --frozen-lockfile --ignore-scripts` in CI.

## Scripts

- Only `apps/keeweb/deploy.sh` is Bash. All other scripts must be TypeScript run via `bun run`.
- The embedded `kw-deploy-activate` script in `setup-deploy-user.ts` must remain Bash (runs standalone as root via sudoers).

## Secrets and Security

- Never commit secret values to tracked files.
- `config/config.json` must never be modified by CI or build scripts. Secrets are injected only into `dist/config.json`.
- `DEPLOY_SSH_KEY` and `DROPBOX_APP_SECRET` are scoped to the `production` GitHub Environment.
- Host keys are pinned in `.github/known_hosts`. Never use `ssh-keyscan`.

## Collaboration

- Read existing PR comments and issue context before making changes.
- When Fro Bot has reviewed a PR, read its comments and address any blocking findings.
- Preserve acceptance criteria from issues when creating PRs.
