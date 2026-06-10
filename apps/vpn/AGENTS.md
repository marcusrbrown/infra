# apps/vpn — Fro Bot WireGuard VPN egress box

> Placeholder — populated in the VPN docs unit. See `docs/plans/2026-06-09-001-feat-vpn-egress-box-plan.md`.

WireGuard egress box on AWS Lightsail (`eu-west-1`, Ireland). The first AWS-backed deployable in the repo. Native `wg-quick@wg0` + systemd (no Docker). Provisioned via `@aws-sdk/client-lightsail`; deployed over SSH.
