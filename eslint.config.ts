import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig(
  {
    name: '@marcusrbrown/infra',
    ignores: ['.agents/', '.opencode/', 'docs/', 'dist/', '.cache/', '**/AGENTS.md'],
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
    files: ['**/cli.ts', '**/build.ts', '**/setup-*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
)
