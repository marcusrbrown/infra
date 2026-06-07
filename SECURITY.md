# Security Policy

## Reporting a Vulnerability

Please use GitHub's private vulnerability reporting to disclose security issues in this repo. You can open a report from the **Security** tab → **"Report a vulnerability"**. This is the preferred channel because it keeps the disclosure private until a fix is shipped.

Do not open a public issue for security vulnerabilities.

## Scope

In scope:

- The `@marcusrbrown/infra` CLI package (published to npm)
- The deploy and provisioning automation in this repository

Out of scope:

- The upstream services this repo deploys — **KeeWeb**, **CLIProxyAPI**, **Umami**, and the **fro-bot** daemon. Report vulnerabilities in those projects to their respective upstream maintainers.

## What to Include

A useful report covers:

- **Affected component and version** — which package, script, or workflow; which version or commit
- **Reproduction steps** — enough detail to reproduce the issue
- **Impact** — what an attacker could achieve and under what conditions

## Response Expectations

I'm a single maintainer. I'll do my best to acknowledge reports within a few days and work toward a fix as quickly as the severity warrants. There is no formal SLA and no bug bounty program.

## Supported Versions

Only the latest released version of `@marcusrbrown/infra` receives security fixes.

| Version | Supported |
| ------- | --------- |
| Latest  | Yes       |
| Older   | No        |
