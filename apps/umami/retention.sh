#!/usr/bin/env bash

set -Eeuo pipefail
IFS=$'\n\t'

script_directory="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly script_directory

mode='check'
compose_file="${UMAMI_COMPOSE_FILE:-$script_directory/docker-compose.yaml}"

usage() {
  cat <<'EOF'
Usage: retention.sh [--check|--dry-run|--apply] [--compose-file PATH]

Modes:
  --check, --dry-run  Count rows older than 13 calendar months without deleting.
  --apply             Delete expired rows transactionally.

The default mode is --check.
EOF
}

while (($# > 0)); do
  case "$1" in
    --apply)
      mode='apply'
      shift
      ;;
    --check|--dry-run)
      mode='check'
      shift
      ;;
    --compose-file)
      if (($# < 2)); then
        printf 'error: --compose-file requires a path\n' >&2
        exit 2
      fi
      compose_file="$2"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'error: unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ ! -f "$compose_file" ]]; then
  printf 'error: compose file does not exist: %s\n' "$compose_file" >&2
  exit 2
fi

sql_file="$script_directory/retention-check.sql"
if [[ "$mode" == 'apply' ]]; then
  sql_file="$script_directory/retention.sql"
fi

compose=(docker compose --file "$compose_file")

if "${compose[@]}" exec -T db psql \
  --no-password \
  --username umami \
  --dbname umami \
  --no-psqlrc \
  --no-align \
  --tuples-only \
  --quiet \
  --set=ON_ERROR_STOP=1 \
  --file=- < "$sql_file"; then
  exit 0
else
  exit_code=$?
  printf 'RETENTION|mode=%s|status=failure|exit=%s|reason=psql\n' "$mode" "$exit_code" >&2
  exit "$exit_code"
fi
