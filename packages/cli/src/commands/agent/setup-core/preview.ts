import type {ProviderId} from './providers'
import type {Harness, HarnessTemplate} from './templates'

export interface DryRunPreviewOptions {
  repo: string
  harness: Harness
  providers: ProviderId[]
  model: string
  template: HarnessTemplate
  commandLabel?: string
}

/**
 * Format a dry-run preview string. The proxy key value is NEVER included —
 * it is rendered as `<proxy-key>` in all positions.
 */
export function formatDryRunPreview(opts: DryRunPreviewOptions): string {
  const {repo, harness, providers, model, template} = opts

  const lines: string[] = [
    `Dry run: ${opts.commandLabel ?? 'cliproxy setup'} --harness ${harness}`,
    `Repository: ${repo}`,
    `Providers: ${providers.join(', ')}`,
    `Model: ${model}`,
    'Planned secrets:',
  ]

  for (const secret of template.secrets) {
    const size = new TextEncoder().encode(secret.value).byteLength
    lines.push(`  - ${secret.name} (${size} bytes)`)
  }

  lines.push('Planned variables:')
  for (const variable of template.variables) {
    lines.push(`  - ${variable.name} = ${variable.value}`)
  }

  lines.push('Proxy key (redacted): <proxy-key>')
  lines.push('No mutations will be performed.')

  return lines.join('\n')
}
