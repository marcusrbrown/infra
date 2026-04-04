# CLIProxy App Knowledge Base

## Overview

`apps/cliproxy` deploys CLIProxyAPI behind Caddy using a Docker Compose stack.

## Config

- Template config files live in `config/`.
- Secrets are injected at runtime via environment variables.
- Never commit real secrets to tracked files.

## Deploy

- Deploy flow is implemented in TypeScript scripts.
- Do not add a Bash deploy script for this app.

## Management API

- Management endpoints are under `/v0/management/*`.
- Access requires bearer token authentication.
