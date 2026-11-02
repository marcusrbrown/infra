import type {AppId} from '@marcusrbrown/infra-shared/status/history-schema'

export interface ServiceInfo {
  title: string
  summary: string
  /** Slugs under `docs/runbooks/` (no extension). Checked against the files at build time. */
  runbooks: readonly string[]
  /** Whether the operator dashboard is a relevant place to look. */
  dashboard: boolean
}

/** Public operator dashboard. Linked as a normal link only: the site has no controls. */
export const DASHBOARD_URL = 'https://dashboard.fro.bot'

export const SERVICES: Record<AppId, ServiceInfo> = {
  keeweb: {
    title: 'KeeWeb',
    summary: 'Password manager web client, deployed as static files to a Mail-in-a-Box host.',
    runbooks: [],
    dashboard: false,
  },
  cliproxy: {
    title: 'CLIProxyAPI',
    summary: 'Claude proxy on a DigitalOcean droplet, with a management API and an auth monitor.',
    runbooks: ['cliproxy-provider-version-skew'],
    dashboard: false,
  },
  gateway: {
    title: 'Fro Bot gateway',
    summary: 'Discord gateway and operator listener that run Fro Bot workspaces.',
    runbooks: [
      'discord-token-lifecycle',
      'gateway-announce-event-verification',
      'gateway-operator-auth-lifecycle',
      'gateway-operator-private-path-verification',
      'operator-push-enablement',
    ],
    dashboard: true,
  },
  umami: {
    title: 'Umami analytics',
    summary: 'Self-hosted, cookieless aggregate analytics.',
    runbooks: ['umami-postgres-major-upgrade'],
    dashboard: false,
  },
  dashboard: {
    title: 'Operator dashboard',
    summary: 'Same-origin operator web app in front of the gateway operator listener.',
    runbooks: [
      'dashboard-released-image-rollback',
      'github-app-key-lifecycle',
      'operator-surface-acceptance-automated',
      'operator-surface-acceptance',
    ],
    dashboard: true,
  },
  vpn: {
    title: 'WireGuard VPN',
    summary: 'WireGuard egress box on an AWS Lightsail static IP. No external probe: deploy state only.',
    runbooks: ['vpn-egress-box'],
    dashboard: false,
  },
  broker: {
    title: 'Credential broker',
    summary: 'OIDC credential broker that mints and revokes short-lived credentials.',
    runbooks: [],
    dashboard: false,
  },
}

export const cliStatusCommand = (app: AppId): string => `bunx @marcusrbrown/infra ${app} status`
