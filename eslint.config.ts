import {defineConfig} from '@bfra.me/eslint-config'

export default defineConfig(
  {
    name: '@marcusrbrown/infra',
    ignores: ['.agents/', 'docs/', 'dist/', '.cache/', '.github/renovate.json5'],
    typescript: true,
  },
  {
    name: 'bun-globals',
    rules: {
      'node/prefer-global/process': 'off',
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
