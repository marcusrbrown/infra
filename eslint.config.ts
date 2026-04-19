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
      // R1: Enforce no explicit `any` — AGENTS.md forbids `as any` and broader uses.
      '@typescript-eslint/no-explicit-any': 'error',
      // R2: Ban all TS directive comments outright — no description carveouts.
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
