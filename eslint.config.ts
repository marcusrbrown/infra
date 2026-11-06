import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig(
  {
    name: '@marcusrbrown/infra',
    ignores: [
      '.agents/',
      '.opencode/',
      'docs/',
      'dist/',
      '.cache/',
      '.cortexkit/',
      '**/AGENTS.md',
      // apps/docs: Astro/Starlight output and content generated from the sources above
      'apps/docs/.astro/',
      'apps/docs/.diagrams/',
      'apps/docs/dist/',
      'apps/docs/public/diagrams/',
      'apps/docs/src/content/docs/{architecture,guides,runbooks,solutions}/',
    ],
    typescript: true,
  },
  {
    name: 'bun-globals',
    rules: {
      'node/prefer-global/process': 'off',
    },
  },
  {
    name: 'infra-conventions',
    rules: {
      // AGENTS.md: forbid explicit `any` / `as any` — fix the types.
      '@typescript-eslint/no-explicit-any': 'error',
      // AGENTS.md: ban all TS directive comments — fix the types, do not suppress errors.
      '@typescript-eslint/ban-ts-comment': [
        'error',
        {
          'ts-expect-error': true,
          'ts-ignore': true,
          'ts-nocheck': true,
          'ts-check': false,
        },
      ],
    },
  },
  {
    name: 'cli-and-scripts',
    files: ['**/cli.ts', '**/build.ts', '**/setup-*.ts', '**/provision-droplet.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    // Systematic parses its config without trailing-comma support (marcusrbrown/systematic#1313).
    name: 'systematic config overrides',
    files: ['.systematic.jsonc'],
    rules: {
      'prettier/prettier': ['error', {trailingComma: 'none'}],
    },
  },
)
