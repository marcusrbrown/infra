/**
 * Handoff-manifest `key_layout_version` labels this CLI accepts. The label names the S3 key
 * contract the provisioner grants (apps/agent/src/key-layout.ts KEY_LAYOUT_VERSION), not an
 * Action version. Unknown labels fail closed.
 */
export const KEY_LAYOUT_VERSION = 'fro-bot-agent-s3-layout/1'

/**
 * Manifests written before the layout had its own label carry the Action ref they were verified
 * against. These refs describe the same layout, so an existing manifest keeps working without a
 * re-provision. Keep in sync with LEGACY_KEY_LAYOUT_LABELS in apps/agent/src/key-layout.ts.
 */
const LEGACY_KEY_LAYOUT_LABELS: ReadonlySet<string> = new Set(['fro-bot/agent@v0.118.2', 'fro-bot/agent@v0.119.2'])

export function isKnownKeyLayoutVersion(label: string): boolean {
  return label === KEY_LAYOUT_VERSION || LEGACY_KEY_LAYOUT_LABELS.has(label)
}
