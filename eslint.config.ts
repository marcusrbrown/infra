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
    name: 'cli-and-scripts',
    files: ['**/cli.ts', '**/build.ts', '**/setup-*.ts'],
    rules: {
      'no-console': 'off',
    },
  },
  // The preset auto-loads eslint-plugin-jsonc's "prettier" compat rules, but
  // isPackageExists('eslint-plugin-jsonc') returns false under Bun's .bun/
  // symlink layout, so the compat rules never get applied. Disable the
  // stylistic jsonc rules that conflict with Prettier's JSON5 output.
  {
    name: '@marcusrbrown/infra/json5-prettier-compat',
    files: ['**/*.json5'],
    rules: {
      'jsonc/quote-props': 'off',
      'jsonc/quotes': 'off',
      'jsonc/comma-dangle': 'off',
      'jsonc/indent': 'off',
      'jsonc/array-bracket-spacing': 'off',
      'jsonc/object-curly-spacing': 'off',
      'jsonc/object-curly-newline': 'off',
      'jsonc/object-property-newline': 'off',
    },
  },
)
