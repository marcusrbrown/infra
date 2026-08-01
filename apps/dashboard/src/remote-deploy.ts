const textEncoder = new TextEncoder()

const PAYLOAD_HEADER = 'dashboard-deploy-payload v2\n'
const PAYLOAD_END = 'end\n'

export const REMOTE_RUNTIME_ROOT = '/run/dashboard-deploy' as const
export const REMOTE_LOCK_PATH = `${REMOTE_RUNTIME_ROOT}/lock` as const
export const REMOTE_LOCK_WAIT_SECONDS = 180 as const
export const REMOTE_MIN_FREE_BYTES = 6 * 1024 * 1024 * 1024
export const REMOTE_COMMAND_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' as const

export const REMOTE_TRANSACTION_PROGRAM = [
  'set -euo pipefail',
  'umask 077',
  'readonly RUNTIME_ROOT="/run/dashboard-deploy"',
  'readonly LOCK_PATH="/run/dashboard-deploy/lock"',
  'readonly ROOT_OWNER="0:0"',
  'readonly CONTAINERD_ROOT="/var/lib/containerd"',
  `readonly MIN_FREE_BYTES="${REMOTE_MIN_FREE_BYTES}"`,
  'readonly DASHBOARD_ROOT="/opt/dashboard"',
  'readonly DASHBOARD_CONFIG_DIR="/opt/dashboard/config"',
  'readonly DASHBOARD_DATA_DIR="/opt/dashboard/data"',
  'readonly DASHBOARD_ENV_PATH="/opt/dashboard/.env"',
  'readonly DASHBOARD_COMPOSE_PATH="/opt/dashboard/docker-compose.yaml"',
  'readonly DASHBOARD_CADDYFILE_PATH="/opt/dashboard/config/Caddyfile"',
  'readonly DASHBOARD_APP_KEY_PATH="/opt/dashboard/config/github-app.pem"',
  'readonly DASHBOARD_LEGACY_OVERRIDE_PATH="/opt/dashboard/docker-compose.override.yaml"',
  'readonly MAX_TOTAL_BYTES=786432',
  'readonly MAX_ENV_BYTES=65536',
  'readonly MAX_COMPOSE_BYTES=524288',
  'readonly MAX_CADDYFILE_BYTES=65536',
  'readonly MAX_GITHUB_APP_KEY_BYTES=131072',
  'readonly MAX_EXPECTED_DASHBOARD_DIGEST_BYTES=71',
  'stage=""',
  'publication_tmp=""',
  'transaction_stage="remote-transaction-started"',
  String.raw`mark_stage() { transaction_stage="$1"; printf "%s\n" "stage=$1"; }`,
  String.raw`fail() { printf "%s\n" "$1" >&2; exit 1; }`,
  'cleanup() { if [ -n "$publication_tmp" ] && [ -e "$publication_tmp" ] && [ ! -L "$publication_tmp" ]; then rm -f -- "$publication_tmp" >/dev/null 2>&1 || :; fi; if [ -n "$stage" ] && [ -d "$stage" ] && [ ! -L "$stage" ]; then rm -rf -- "$stage" >/dev/null 2>&1 || :; fi; }',
  'trap cleanup EXIT',
  'trap "exit 129" HUP',
  'trap "exit 130" INT',
  'trap "exit 143" TERM',
  String.raw`printf "%s\n" "stage=$transaction_stage"`,
  'if [ -L "$RUNTIME_ROOT" ] || { [ -e "$RUNTIME_ROOT" ] && [ ! -d "$RUNTIME_ROOT" ]; }; then fail "runtime root is unsafe"; fi',
  'if [ ! -e "$RUNTIME_ROOT" ]; then install -d -m 0700 -o 0 -g 0 "$RUNTIME_ROOT" >/dev/null 2>&1 || fail "runtime root creation failed"; fi',
  '[ -d "$RUNTIME_ROOT" ] && [ ! -L "$RUNTIME_ROOT" ] || fail "runtime root is not a directory"',
  '[ "$(realpath -e -- "$RUNTIME_ROOT" 2>/dev/null)" = "$RUNTIME_ROOT" ] || fail "runtime root is not canonical"',
  'root_stat="$(stat -c "%u:%g:%a:%F" -- "$RUNTIME_ROOT" 2>/dev/null)" || fail "runtime root stat failed"',
  '[ "$root_stat" = "0:0:700:directory" ] || fail "runtime root ownership or mode is unsafe"',
  'if [ -L "$LOCK_PATH" ] || { [ -e "$LOCK_PATH" ] && [ ! -f "$LOCK_PATH" ]; }; then fail "lock path is not a regular file"; fi',
  'if [ ! -e "$LOCK_PATH" ]; then install -m 0600 -o 0 -g 0 /dev/null "$LOCK_PATH" >/dev/null 2>&1 || fail "lock path creation failed"; fi',
  '[ -f "$LOCK_PATH" ] && [ ! -L "$LOCK_PATH" ] || fail "lock path is not a regular file"',
  'lock_stat="$(stat -c "%u:%g:%a:%F" -- "$LOCK_PATH" 2>/dev/null)" || fail "lock path stat failed"',
  '[ "$lock_stat" = "0:0:600:regular file" ] || fail "lock path ownership or mode is unsafe"',
  'exec 9>"$LOCK_PATH" 2>/dev/null || fail "lock descriptor failed"',
  String.raw`if ! flock -w 180 9 >/dev/null 2>&1; then mark_stage lock-contention; exit 75; fi`,
  String.raw`mark_stage lock-acquired`,
  'stage="$(mktemp -d -- "$RUNTIME_ROOT/attempt.XXXXXX" 2>/dev/null)" || fail "staging directory creation failed"',
  'chown 0:0 "$stage" >/dev/null 2>&1 || fail "staging directory ownership failed"',
  'chmod 0700 "$stage" >/dev/null 2>&1 || fail "staging directory mode failed"',
  '[ "$(realpath -e -- "$stage" 2>/dev/null)" = "$stage" ] || fail "staging directory is not canonical"',
  'read_line() { IFS= read -r line || fail "malformed payload"; }',
  'read_line',
  '[ "$line" = "dashboard-deploy-payload v2" ] || fail "unsupported payload protocol"',
  'payload_bytes=0',
  'seen_env=0; seen_compose=0; seen_caddyfile=0; seen_github_app_key=0; seen_expected_dashboard_digest=0',
  'for field_number in 1 2 3 4 5; do',
  '  read_line',
  '  [ "$line" != "end" ] || fail "missing payload field"',
  '  [[ "$line" =~ ^field[[:space:]]([a-z_]+)[[:space:]]([0-9]+)$ ]] || fail "malformed payload field header"',
  `  field_name="$(printf '%s' "$line" | cut -d' ' -f2)"; field_length="$(printf '%s' "$line" | cut -d' ' -f3)"`,
  '  case "$field_length" in 0|[1-9]*) ;; *) fail "malformed payload field length" ;; esac',
  '  case "$field_name" in',
  '    env) [ "$seen_env" -eq 0 ] || fail "duplicate payload field"; seen_env=1; target="$stage/env"; field_limit="$MAX_ENV_BYTES" ;;',
  '    compose) [ "$seen_compose" -eq 0 ] || fail "duplicate payload field"; seen_compose=1; target="$stage/compose"; field_limit="$MAX_COMPOSE_BYTES" ;;',
  '    caddyfile) [ "$seen_caddyfile" -eq 0 ] || fail "duplicate payload field"; seen_caddyfile=1; target="$stage/caddyfile"; field_limit="$MAX_CADDYFILE_BYTES" ;;',
  '    github_app_key) [ "$seen_github_app_key" -eq 0 ] || fail "duplicate payload field"; seen_github_app_key=1; target="$stage/github-app.pem"; field_limit="$MAX_GITHUB_APP_KEY_BYTES" ;;',
  '    expected_dashboard_digest) [ "$seen_expected_dashboard_digest" -eq 0 ] || fail "duplicate payload field"; seen_expected_dashboard_digest=1; target="$stage/expected-dashboard-digest"; field_limit="$MAX_EXPECTED_DASHBOARD_DIGEST_BYTES" ;;',
  '    *) fail "unknown payload field" ;;',
  '  esac',
  '  [ "$field_length" -le "$field_limit" ] || fail "payload field exceeds size limit"',
  '  [ "$field_length" -gt 0 ] || fail "empty payload field"',
  '  payload_bytes=$((payload_bytes + field_length))',
  '  [ "$payload_bytes" -le "$MAX_TOTAL_BYTES" ] || fail "payload exceeds total size limit"',
  '  dd of="$target" bs=1 count="$field_length" status=none 2>/dev/null || fail "payload field read failed"',
  '  actual_size="$(stat -c "%s" -- "$target" 2>/dev/null)" || fail "payload field stat failed"',
  '  [ "$actual_size" = "$field_length" ] || fail "truncated payload field"',
  'done',
  'read_line',
  '[ "$line" = "end" ] || fail "malformed payload terminator"',
  '[ "$seen_env" -eq 1 ] && [ "$seen_compose" -eq 1 ] && [ "$seen_caddyfile" -eq 1 ] && [ "$seen_github_app_key" -eq 1 ] && [ "$seen_expected_dashboard_digest" -eq 1 ] || fail "missing payload field"',
  'remaining_bytes="$(dd bs=1 count=1 status=none 2>/dev/null | wc -c)"',
  '[ "$remaining_bytes" -eq 0 ] || fail "trailing payload data"',
  String.raw`mark_stage payload-decoded`,
  'expected_dashboard_digest="$(cat -- "$stage/expected-dashboard-digest" 2>/dev/null)" || fail "expected dashboard digest read failed"',
  '[[ "$expected_dashboard_digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "malformed expected dashboard digest"',
  'validate_dashboard_path() {',
  '  path="$1"; label="$2"',
  '  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -d "$path" ]; }; then fail "$label path is unsafe"; fi',
  '  if [ -e "$path" ]; then',
  '    canonical_path="$(realpath -e -- "$path" 2>/dev/null)" || fail "$label path canonicalization failed"',
  '    [ "$canonical_path" = "$path" ] || fail "$label path is not canonical"',
  '    printf "%s\n" "evidence=active-path:$label:present"',
  '  else',
  '    printf "%s\n" "evidence=active-path:$label:absent"',
  '  fi',
  '}',
  'validate_safe_identity() { [[ "$1" =~ ^[A-Za-z0-9._/:@+=,-]+$ ]]; }',
  'decimal_bytes() {',
  '  blocks="$1"; block_size="$2"',
  '  [[ "$blocks" =~ ^(0|[1-9][0-9]*)$ ]] && [[ "$block_size" =~ ^(0|[1-9][0-9]*)$ ]] || return 1',
  // The shell parameter expansions are literal remote-program syntax, not JavaScript interpolation.
  // eslint-disable-next-line no-template-curly-in-string
  '  [ "${#blocks}" -le 18 ] && [ "${#block_size}" -le 18 ] || return 1',
  '  [ "$block_size" -gt 0 ] || return 1',
  '  (( blocks <= 9223372036854775807 / block_size )) || return 1',
  '  printf "%s\n" "$((blocks * block_size))"',
  '}',
  'human_bytes() {',
  '  value="$1"',
  '  [[ "$value" =~ ^([0-9]+)(\.[0-9]+)?(B|kB|MB|GB|TB|PB)$ ]] || return 1',
  // eslint-disable-next-line no-template-curly-in-string
  '  number="${BASH_REMATCH[1]}${BASH_REMATCH[2]:-}"',
  // eslint-disable-next-line no-template-curly-in-string
  '  case "${BASH_REMATCH[3]}" in',
  '    B) multiplier=1 ;; kB) multiplier=1000 ;; MB) multiplier=1000000 ;; GB) multiplier=1000000000 ;; TB) multiplier=1000000000000 ;; PB) multiplier=1000000000000000 ;;',
  '    *) return 1 ;;',
  '  esac',
  String.raw`  awk -v value="$number" -v multiplier="$multiplier" 'BEGIN { result = value * multiplier; if (result < 0 || result > 9223372036854775807) exit 1; printf "%.0f\n", result }'`,
  '}',
  `
declare -a storage_keys=() storage_paths=() storage_mounts=() storage_sources=() storage_fs_types=() storage_bytes=()
reset_storage_records() { storage_keys=(); storage_paths=(); storage_mounts=(); storage_sources=(); storage_fs_types=(); storage_bytes=(); }
capture_storage_records() {
  phase="$1"; current_storage_phase="$phase"; reset_storage_records
  docker_root="$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)" || fail "Docker root evidence unavailable"
  [[ "$docker_root" =~ ^/[A-Za-z0-9._/+@=,-]+$ ]] || fail "Docker root evidence malformed"
  [ -d "$docker_root" ] || fail "Docker root path unavailable"
  probes=("$docker_root")
  if [ -e "$CONTAINERD_ROOT" ]; then
    [ -d "$CONTAINERD_ROOT" ] && [ ! -L "$CONTAINERD_ROOT" ] || fail "containerd root path is unsafe"
    probes+=("$CONTAINERD_ROOT")
  fi
  for probe in "\${probes[@]}"; do
    canonical_probe="$(realpath -e -- "$probe" 2>/dev/null)" || fail "storage probe canonicalization failed"
    [ -d "$canonical_probe" ] || fail "storage probe is not a directory"
    mount_info="$(findmnt --noheadings --raw --target "$canonical_probe" --output TARGET,SOURCE,FSTYPE 2>/dev/null)" || fail "storage mount evidence unavailable"
    [ -n "$mount_info" ] && [[ "$mount_info" != *$'\n'* ]] || fail "storage mount evidence malformed"
    IFS=' ' read -r mount_target source fs_type extra <<< "$mount_info"
    [ -n "$mount_target" ] && [ -n "$source" ] && [ -n "$fs_type" ] && [ -z "\${extra:-}" ] || fail "storage mount evidence malformed"
    validate_safe_identity "$mount_target" && validate_safe_identity "$source" && validate_safe_identity "$fs_type" || fail "storage mount identity malformed"
    stat_info="$(stat -f -c "%a:%S" -- "$canonical_probe" 2>/dev/null)" || fail "storage free-byte evidence unavailable"
    IFS=':' read -r free_blocks block_size stat_extra <<< "$stat_info"
    [ -n "$free_blocks" ] && [ -n "$block_size" ] && [ -z "\${stat_extra:-}" ] || fail "storage free-byte evidence malformed"
    available_bytes="$(decimal_bytes "$free_blocks" "$block_size")" || fail "storage free-byte evidence malformed"
    key="$mount_target|$source|$fs_type"; found=-1
    for i in "\${!storage_keys[@]}"; do
      [ "\${storage_mounts[$i]}" = "$mount_target" ] && [ "\${storage_keys[$i]}" != "$key" ] && fail "contradictory storage mount evidence"
      if [ "\${storage_keys[$i]}" = "$key" ]; then found="$i"; break; fi
    done
    if [ "$found" -ge 0 ]; then
      [ "\${storage_bytes[$found]}" = "$available_bytes" ] || fail "contradictory storage free-byte evidence"
      storage_paths[$found]="\${storage_paths[$found]},$canonical_probe"
    else
      storage_keys+=("$key"); storage_paths+=("$canonical_probe"); storage_mounts+=("$mount_target"); storage_sources+=("$source"); storage_fs_types+=("$fs_type"); storage_bytes+=("$available_bytes")
    fi
  done
  [ "\${#storage_keys[@]}" -gt 0 ] || fail "storage evidence is empty"
  storage_min_free="\${storage_bytes[0]}"
  for i in "\${!storage_bytes[@]}"; do
    [ "\${storage_bytes[$i]}" -lt "$storage_min_free" ] && storage_min_free="\${storage_bytes[$i]}"
    printf "%s\n" "evidence=storage:$phase:probe=\${storage_paths[$i]};mount=\${storage_mounts[$i]};source=\${storage_sources[$i]};fstype=\${storage_fs_types[$i]};free-bytes=\${storage_bytes[$i]}"
  done
}
`,
  `
capture_docker_df() {
  phase="$1"
  df_output="$(docker system df --format '{{.Type}}|{{.TotalCount}}|{{.Active}}|{{.Size}}|{{.Reclaimable}}' 2>/dev/null)" || fail "Docker disk summary unavailable"
  df_count=0
  while IFS= read -r df_line; do
    [ -n "$df_line" ] || continue
    IFS='|' read -r df_type df_total df_active df_size df_reclaimable df_extra <<< "$df_line"
    [ -n "$df_type" ] && [ -n "$df_total" ] && [ -n "$df_active" ] && [ -n "$df_size" ] && [ -n "$df_reclaimable" ] && [ -z "\${df_extra:-}" ] || fail "Docker disk summary malformed"
    df_type="\${df_type// /-}"
    [[ "$df_type" =~ ^[A-Za-z][A-Za-z-]*$ ]] && [[ "$df_total" =~ ^(0|[1-9][0-9]*)$ ]] && [[ "$df_active" =~ ^(0|[1-9][0-9]*)$ ]] || fail "Docker disk summary malformed"
    df_size_bytes="$(human_bytes "$df_size")" || fail "Docker disk summary size malformed"
    df_reclaimable="\${df_reclaimable%% *}"
    df_reclaimable_bytes="$(human_bytes "$df_reclaimable")" || fail "Docker disk summary reclaimable size malformed"
    printf "%s\n" "evidence=docker-df:$phase:type=$df_type;count=$df_total;active=$df_active;size-bytes=$df_size_bytes;reclaimable-bytes=$df_reclaimable_bytes"
    df_count=$((df_count + 1))
  done <<< "$df_output"
  [ "$df_count" -gt 0 ] || fail "Docker disk summary is empty"
}
`,
  `
declare -a protected_refs=() protected_counts=()
protected_container_count=0
capture_container_inventory() {
  phase="$1"; protected_refs=(); protected_counts=(); protected_container_count=0
  container_images="$(docker ps -a --no-trunc --format '{{.Image}}' 2>/dev/null)" || fail "container image inventory unavailable"
  while IFS= read -r image_ref; do
    [ -n "$image_ref" ] || continue
    [[ "$image_ref" =~ ^[a-z0-9][a-z0-9._/@:+-]*$ ]] || fail "container image reference malformed"
    protected_container_count=$((protected_container_count + 1)); found=-1
    for i in "\${!protected_refs[@]}"; do
      if [ "\${protected_refs[$i]}" = "$image_ref" ]; then found="$i"; break; fi
    done
    if [ "$found" -ge 0 ]; then
      protected_counts[$found]=$((protected_counts[$found] + 1))
    else
      protected_refs+=("$image_ref"); protected_counts+=(1)
    fi
  done <<< "$container_images"
  printf "%s\n" "evidence=container-inventory:$phase:count=$protected_container_count"
  for i in "\${!protected_refs[@]}"; do
    printf "%s\n" "evidence=protected-image:$phase:ref=\${protected_refs[$i]};count=\${protected_counts[$i]}"
  done
}
`,
  `
capture_active_state() {
  phase="$1"
  if [ -L "$DASHBOARD_COMPOSE_PATH" ]; then
    fail "active Compose path is unsafe"
  elif [ ! -e "$DASHBOARD_COMPOSE_PATH" ]; then
    printf "%s\n" "evidence=active-compose:$phase:absent"
  else
    [ -f "$DASHBOARD_COMPOSE_PATH" ] || fail "active Compose path is unsafe"
    active_compose_image="$(awk '$1 == "image:" && index($2, "ghcr.io/fro-bot/dashboard") == 1 { print $2 }' "$DASHBOARD_COMPOSE_PATH" 2>/dev/null)" || fail "active Compose image evidence unavailable"
    [[ "$active_compose_image" =~ ^ghcr[.]io/fro-bot/dashboard(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || fail "active Compose image evidence malformed"
    active_compose_digest="\${active_compose_image##*@}"
    printf "%s\n" "evidence=active-compose:$phase:ref=$active_compose_image;digest=$active_compose_digest"
  fi
  running_dashboard_ids="$(docker ps --no-trunc --filter 'label=com.docker.compose.project=dashboard' --filter 'label=com.docker.compose.service=dashboard' --format '{{.ID}}' 2>/dev/null)" || fail "running dashboard inventory unavailable"
  running_dashboard_count=0
  running_dashboard_id=""
  while IFS= read -r candidate_id; do
    [ -n "$candidate_id" ] || continue
    [[ "$candidate_id" =~ ^[a-f0-9]{12,64}$ ]] || fail "running dashboard container identity malformed"
    running_dashboard_count=$((running_dashboard_count + 1))
    running_dashboard_id="$candidate_id"
  done <<< "$running_dashboard_ids"
  case "$running_dashboard_count" in
    0)
      printf "%s\n" "evidence=running-dashboard:$phase:absent"
      ;;
    1)
      dashboard_image_sha="$(docker inspect --format '{{.Image}}' "$running_dashboard_id" 2>/dev/null)" || fail "running dashboard image identity unavailable"
      [[ "$dashboard_image_sha" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "running dashboard image identity malformed"
      dashboard_repo_digests="$(docker inspect --format '{{json .RepoDigests}}' "$dashboard_image_sha" 2>/dev/null)" || fail "running dashboard digest evidence unavailable"
      dashboard_repo_digest_entry="$(awk -F '"' 'NF == 3 && $1 == "[" && $3 == "]" { print $2 }' <<< "$dashboard_repo_digests")"
      [[ "$dashboard_repo_digest_entry" =~ ^[a-z0-9][a-z0-9._/:+-]+@sha256:[0-9a-f]{64}$ ]] || fail "running dashboard digest evidence malformed"
      running_digest="\${dashboard_repo_digest_entry##*@}"
      running_health="$(docker inspect --format '{{.State.Health.Status}}' "$running_dashboard_id" 2>/dev/null)" || fail "running dashboard health evidence unavailable"
      [ -n "$running_health" ] || running_health=unknown
      [[ "$running_health" =~ ^(healthy|unhealthy|starting|unknown)$ ]] || fail "running dashboard health evidence malformed"
      printf "%s\n" "evidence=running-dashboard:$phase:digest=$running_digest;health=$running_health"
      ;;
    *)
      fail "running dashboard identity is ambiguous"
      ;;
  esac
}
`,
  `
capture_prune() {
  prune_output="$(docker image prune -af 2>/dev/null)" || fail "unused-image prune failed"
  reclaimed_text=""; eligible_images=0
  while IFS= read -r prune_line; do
    case "$prune_line" in
      "Total reclaimed space: "*) reclaimed_text="\${prune_line#Total reclaimed space: }" ;;
      "deleted: "*) eligible_images=$((eligible_images + 1)) ;;
      ""|"Deleted Images:"|"untagged: "*) ;;
      *) ;;
    esac
  done <<< "$prune_output"
  [ -n "$reclaimed_text" ] || fail "unused-image prune result malformed"
  reclaimed_text="\${reclaimed_text%% *}"
  reclaimed_bytes="$(human_bytes "$reclaimed_text")" || fail "unused-image prune result malformed"
  printf "%s\n" "evidence=prune:reclaimed-bytes=$reclaimed_bytes;eligible-images=$eligible_images;protected-containers=$protected_container_count"
}
`,
  String.raw`
verify_repo_digest_output() {
  repo_digest_output="$1"; expected_repository="$2"; expected_digest="$3"
  expected_repo_digest="$expected_repository@$expected_digest"; repo_digest_matches=0
  while IFS= read -r repo_digest; do
    [ -n "$repo_digest" ] || continue
    [[ "$repo_digest" =~ ^[a-z0-9][a-z0-9._/:+-]*@sha256:[0-9a-f]{64}$ ]] || return 1
    [ "$repo_digest" = "$expected_repo_digest" ] && repo_digest_matches=$((repo_digest_matches + 1))
  done <<< "$repo_digest_output"
  [ "$repo_digest_matches" -eq 1 ]
}
verify_image_exact() {
  expected_repository="$1"; expected_digest="$2"
  canonical_image_ref="$expected_repository@$expected_digest"
  image_repo_digests="$(docker image inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$canonical_image_ref" 2>/dev/null)" || return 1
  verify_repo_digest_output "$image_repo_digests" "$expected_repository" "$expected_digest"
}
validate_final_file_path() {
  path="$1"; label="$2"
  if [ -L "$path" ] || { [ -e "$path" ] && [ ! -f "$path" ]; }; then fail "$label final path is unsafe"; fi
  if [ -e "$path" ]; then
    canonical_path="$(realpath -e -- "$path" 2>/dev/null)" || fail "$label final path canonicalization failed"
    [ "$canonical_path" = "$path" ] || fail "$label final path is not canonical"
  fi
}
validate_parent_directory() {
  path="$1"; label="$2"
  [ -e "$path" ] || return 0
  [ -d "$path" ] && [ ! -L "$path" ] || fail "$label parent directory is unsafe"
  canonical_path="$(realpath -e -- "$path" 2>/dev/null)" || fail "$label parent directory canonicalization failed"
  [ "$canonical_path" = "$path" ] || fail "$label parent directory is not canonical"
  parent_stat="$(stat -c "%u:%g:%a:%F" -- "$path" 2>/dev/null)" || fail "$label parent directory stat failed"
  IFS=':' read -r parent_uid parent_gid parent_mode parent_type parent_extra <<< "$parent_stat"
  [ "$parent_uid:$parent_gid" = "$ROOT_OWNER" ] || fail "$label parent directory ownership is unsafe"
  [[ "$parent_mode" =~ ^[0-7]{3,4}$ ]] || fail "$label parent directory mode is malformed"
  (( (8#$parent_mode & 8#22) == 0 )) || fail "$label parent directory is writable by group or world"
}
publish_active_file() {
  source_path="$1"; destination_path="$2"; label="$3"; destination_parent="$(dirname "$destination_path")"
  validate_parent_directory "$destination_parent" "$label"
  validate_final_file_path "$destination_path" "$label"
  publication_tmp="$(mktemp -- "$destination_parent/.dashboard-deploy.XXXXXX" 2>/dev/null)" || fail "$label temporary file creation failed"
  case "$label" in
    env) install -m 0600 -o 0 -g 0 "$source_path" "$publication_tmp" >/dev/null 2>&1 || fail "environment publication failed" ;;
    caddyfile) install -m 0644 -o 0 -g 0 "$source_path" "$publication_tmp" >/dev/null 2>&1 || fail "Caddyfile publication failed" ;;
    pem) install -m 0600 -o 1000 -g 1000 "$source_path" "$publication_tmp" >/dev/null 2>&1 || fail "GitHub App key publication failed" ;;
    compose) install -m 0644 -o 0 -g 0 "$source_path" "$publication_tmp" >/dev/null 2>&1 || fail "compose publication failed" ;;
    *) fail "unknown active file" ;;
  esac
  [ -f "$publication_tmp" ] && [ ! -L "$publication_tmp" ] || fail "$label temporary file is unsafe"
  mv -f "$publication_tmp" "$destination_path" >/dev/null 2>&1 || fail "$label replacement failed"
  publication_tmp=""
  validate_final_file_path "$destination_path" "$label"
  case "$label" in
    env) expected_stat="0:0:600:regular file" ;;
    caddyfile|compose) expected_stat="0:0:644:regular file" ;;
    pem) expected_stat="1000:1000:600:regular file" ;;
    *) fail "unknown active file" ;;
  esac
  actual_stat="$(stat -c "%u:%g:%a:%F" -- "$destination_path" 2>/dev/null)" || fail "$label readback failed"
  [ "$actual_stat" = "$expected_stat" ] || fail "$label ownership or mode is unsafe"
  printf "%s\n" "evidence=active-state:published=$label"
}
`,
  'validate_dashboard_path "$DASHBOARD_ROOT" root',
  'validate_dashboard_path "$DASHBOARD_CONFIG_DIR" config',
  'validate_dashboard_path "$DASHBOARD_DATA_DIR" data',
  'mark_stage baseline-evidence',
  'capture_storage_records baseline',
  'capture_docker_df baseline',
  'capture_container_inventory baseline',
  'capture_active_state baseline',
  'mark_stage prune-started',
  'capture_prune',
  'mark_stage prune-complete',
  'mark_stage post-prune-capacity',
  'capture_storage_records post-prune',
  'capture_docker_df post-prune',
  'capture_container_inventory post-prune',
  'capture_active_state post-prune',
  '[ "$storage_min_free" -ge "$MIN_FREE_BYTES" ] || fail "post-prune free space is below the minimum"',
  'printf "%s\n" "evidence=capacity:post-prune:free-bytes=$storage_min_free"',
  String.raw`
required_images_file="$stage/required-images"
: > "$required_images_file" || fail "staged image record creation failed"
staged_images_output="$(docker compose --project-directory "$stage" --file "$stage/compose" --env-file "$stage/env" config --images 2>/dev/null)" || fail "staged Compose image enumeration failed"
staged_image_count=0; dashboard_image_count=0
while IFS= read -r staged_image; do
  [ -n "$staged_image" ] || fail "staged Compose image identity is empty"
  [[ "$staged_image" =~ ^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?@sha256:[0-9a-f]{64}$ ]] || fail "staged Compose image identity is malformed"
  image_name="$(printf '%s\n' "$staged_image" | cut -d@ -f1)"
  staged_digest="$(printf '%s\n' "$staged_image" | cut -d@ -f2)"
  staged_repository="$(printf '%s\n' "$image_name" | sed -E 's/:[A-Za-z0-9._-]+$//')"
  staged_identity="$staged_repository@$staged_digest"
  if grep -Fqx -- "$staged_identity" "$required_images_file"; then fail "duplicate staged image identity"; fi
  printf '%s\t%s\t%s\n' "$staged_repository" "$staged_digest" "$staged_image" >> "$required_images_file" || fail "staged image record write failed"
  staged_image_count=$((staged_image_count + 1))
  if [ "$staged_repository" = "ghcr.io/fro-bot/dashboard" ]; then
    dashboard_image_count=$((dashboard_image_count + 1))
    [ "$staged_digest" = "$expected_dashboard_digest" ] || fail "staged dashboard digest is unexpected"
  fi
done <<< "$staged_images_output"
[ "$staged_image_count" -gt 0 ] || fail "staged Compose image set is empty"
[ "$dashboard_image_count" -eq 1 ] || fail "staged dashboard image identity is missing or ambiguous"
mark_stage image-acquisition
if docker compose --project-directory "$stage" --file "$stage/compose" --env-file "$stage/env" pull >/dev/null 2>&1; then
  printf '%s\n' 'evidence=acquisition:mode=pull'
else
  printf '%s\n' 'evidence=acquisition:mode=cache-fallback'
  while IFS="$(printf '\t')" read -r expected_repository expected_digest image_ref; do
    [ -n "$image_ref" ] || fail "staged image record is malformed"
    verify_image_exact "$expected_repository" "$expected_digest" || fail "exact cached staged image is unavailable"
  done < "$required_images_file"
fi
while IFS="$(printf '\t')" read -r expected_repository expected_digest image_ref; do
  [ -n "$image_ref" ] || fail "staged image record is malformed"
  verify_image_exact "$expected_repository" "$expected_digest" || fail "staged image digest verification failed"
  printf '%s\n' "evidence=image-verified:$expected_repository@$expected_digest"
done < "$required_images_file"
mark_stage post-acquisition-capacity
capture_storage_records post-acquisition
printf '%s\n' "evidence=capacity:post-acquisition:free-bytes=$storage_min_free"
[ "$storage_min_free" -ge "$MIN_FREE_BYTES" ] || fail "post-acquisition free space is below the minimum"
`,
  'validate_final_file_path "$DASHBOARD_ENV_PATH" env',
  'validate_final_file_path "$DASHBOARD_CADDYFILE_PATH" caddyfile',
  'validate_final_file_path "$DASHBOARD_APP_KEY_PATH" pem',
  'validate_final_file_path "$DASHBOARD_COMPOSE_PATH" compose',
  'validate_final_file_path "$DASHBOARD_LEGACY_OVERRIDE_PATH" legacy-override',
  'validate_parent_directory "$(dirname "$DASHBOARD_ROOT")" dashboard-parent',
  'validate_parent_directory "$DASHBOARD_ROOT" root',
  'validate_parent_directory "$DASHBOARD_CONFIG_DIR" config',
  'mark_stage active-state-mutation',
  'if [ -L "$DASHBOARD_ROOT" ] || { [ -e "$DASHBOARD_ROOT" ] && [ ! -d "$DASHBOARD_ROOT" ]; }; then fail "dashboard root is unsafe"; fi',
  'if [ -L "$DASHBOARD_CONFIG_DIR" ] || { [ -e "$DASHBOARD_CONFIG_DIR" ] && [ ! -d "$DASHBOARD_CONFIG_DIR" ]; }; then fail "dashboard config is unsafe"; fi',
  'install -d -m 0755 -o 0 -g 0 "$DASHBOARD_ROOT" >/dev/null 2>&1 || fail "dashboard root creation failed"',
  'install -d -m 0755 -o 0 -g 0 "$DASHBOARD_CONFIG_DIR" >/dev/null 2>&1 || fail "dashboard config creation failed"',
  'chown 0:0 "$DASHBOARD_ROOT" "$DASHBOARD_CONFIG_DIR" >/dev/null 2>&1 || fail "dashboard root ownership failed"',
  '[ "$(realpath -e "$DASHBOARD_ROOT" 2>/dev/null)" = "$DASHBOARD_ROOT" ] || fail "dashboard root is not canonical"',
  '[ "$(realpath -e "$DASHBOARD_CONFIG_DIR" 2>/dev/null)" = "$DASHBOARD_CONFIG_DIR" ] || fail "dashboard config is not canonical"',
  'if [ -L "$DASHBOARD_DATA_DIR" ] || { [ -e "$DASHBOARD_DATA_DIR" ] && [ ! -d "$DASHBOARD_DATA_DIR" ]; }; then fail "dashboard data is unsafe"; fi',
  'install -d -m 0700 -o 1000 -g 1000 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data creation failed"',
  'chown -R 1000:1000 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data ownership failed"',
  'chmod 0700 "$DASHBOARD_DATA_DIR" >/dev/null 2>&1 || fail "dashboard data mode failed"',
  '[ -d "$DASHBOARD_DATA_DIR" ] && [ ! -L "$DASHBOARD_DATA_DIR" ] && [ "$(realpath -e "$DASHBOARD_DATA_DIR" 2>/dev/null)" = "$DASHBOARD_DATA_DIR" ] || fail "dashboard data is not canonical"',
  'publish_active_file "$stage/env" "$DASHBOARD_ENV_PATH" env',
  'publish_active_file "$stage/caddyfile" "$DASHBOARD_CADDYFILE_PATH" caddyfile',
  'publish_active_file "$stage/github-app.pem" "$DASHBOARD_APP_KEY_PATH" pem',
  'publish_active_file "$stage/compose" "$DASHBOARD_COMPOSE_PATH" compose',
  'rm -f -- "$DASHBOARD_LEGACY_OVERRIDE_PATH" >/dev/null 2>&1 || fail "legacy override removal failed"',
  String.raw`mark_stage active-state-written`,
  'cd "$DASHBOARD_ROOT" || fail "dashboard directory change failed"',
  'docker compose up -d --no-build --wait --wait-timeout 120 dashboard >/dev/null 2>&1 || fail "dashboard convergence failed"',
  'dashboard_container_id="$(docker compose ps -q dashboard 2>/dev/null)" || fail "dashboard container lookup failed"',
  '[[ "$dashboard_container_id" =~ ^[a-f0-9]{12,64}$ ]] || fail "dashboard container identity is malformed"',
  'dashboard_image_sha="$(docker inspect --format \'{{.Image}}\' "$dashboard_container_id" 2>/dev/null)" || fail "dashboard image lookup failed"',
  '[ -n "$dashboard_image_sha" ] || fail "dashboard image identity is missing"',
  'dashboard_repo_digests="$(docker inspect --format \'{{range .RepoDigests}}{{println .}}{{end}}\' "$dashboard_image_sha" 2>/dev/null)" || fail "dashboard digest lookup failed"',
  'verify_repo_digest_output "$dashboard_repo_digests" ghcr.io/fro-bot/dashboard "$expected_dashboard_digest" || fail "dashboard digest verification failed"',
  'printf "%s\n" "evidence=runtime-digest:$expected_dashboard_digest"',
  'running_health="$(docker inspect --format \'{{.State.Health.Status}}\' "$dashboard_container_id" 2>/dev/null)" || fail "dashboard health lookup failed"',
  '[ "$running_health" = healthy ] || fail "dashboard health verification failed"',
  'printf "%s\n" "evidence=health:$running_health"',
  'docker compose up -d --no-build --force-recreate --wait --wait-timeout 120 caddy >/dev/null 2>&1 || fail "Caddy convergence failed"',
  String.raw`mark_stage runtime-converged`,
  String.raw`mark_stage complete`,
].join('\n')

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`
const REMOTE_SSH_PROGRAM = `/usr/bin/env -i PATH=${REMOTE_COMMAND_PATH} HOME=/root DOCKER_CONTEXT=default DOCKER_HOST=unix:///var/run/docker.sock /bin/bash -c ${shellQuote(REMOTE_TRANSACTION_PROGRAM)}`

export const REMOTE_PAYLOAD_PROTOCOL_VERSION = 2 as const

export const REMOTE_PAYLOAD_FIELD_LIMITS = {
  env: 64 * 1024,
  compose: 512 * 1024,
  caddyfile: 64 * 1024,
  github_app_key: 128 * 1024,
  expected_dashboard_digest: 71,
} as const

export const REMOTE_PAYLOAD_MAX_BYTES = 786432

export interface RemoteSshCommandOptions {
  host: string
  keyPath?: string
}

export interface RemoteProcess {
  stdout: ReadableStream<Uint8Array>
  stderr: ReadableStream<Uint8Array>
  stdin?: {
    write: (data: Uint8Array) => void | Promise<void>
    end: () => void | Promise<void>
  }
  exited: Promise<number>
}

export interface RemoteSpawnOptions {
  env: Readonly<Record<string, string>>
  stdout: 'pipe'
  stderr: 'pipe'
  stdin: 'pipe'
}

export type RemoteSpawnFn = (command: string[], options: RemoteSpawnOptions) => RemoteProcess

export interface RemoteTransactionOptions {
  host: string
  payload: RemoteDeployPayload
  /** Environment for the local SSH client process; passed through unchanged. */
  env: Readonly<Record<string, string>>
  spawn: RemoteSpawnFn
  keyPath?: string
}

export type RemoteTransactionStage =
  | 'starting'
  | 'remote-transaction-started'
  | 'lock-contention'
  | 'lock-acquired'
  | 'payload-decoded'
  | 'baseline-evidence'
  | 'prune-started'
  | 'prune-complete'
  | 'post-prune-capacity'
  | 'post-acquisition-capacity'
  | 'active-state-mutation'
  | 'image-acquisition'
  | 'active-state-written'
  | 'runtime-converged'
  | 'complete'

export interface RemoteTransactionResult {
  stage: RemoteTransactionStage
  evidence: readonly string[]
}

export class RemoteTransactionError extends Error {
  readonly stage: RemoteTransactionStage
  readonly exitCode?: number

  constructor(stage: RemoteTransactionStage, reason: string, exitCode?: number) {
    super(`Remote dashboard deploy failed at ${stage}: ${reason}`)
    this.name = 'RemoteTransactionError'
    this.stage = stage
    this.exitCode = exitCode
  }
}

const HOST_RE = /^[a-z0-9][a-z0-9.-]*$/i

export function buildRemoteSshCommand(options: RemoteSshCommandOptions): string[] {
  if (!HOST_RE.test(options.host)) {
    throw new Error('Invalid dashboard deploy host')
  }

  return [
    'ssh',
    ...(options.keyPath ? ['-i', options.keyPath, '-o', 'IdentitiesOnly=yes'] : []),
    '-o',
    'BatchMode=yes',
    '-o',
    'ConnectTimeout=10',
    '-o',
    'StrictHostKeyChecking=yes',
    `root@${options.host}`,
    REMOTE_SSH_PROGRAM,
  ]
}

const settle = async <T>(promise: Promise<T>): Promise<{value?: T; error?: unknown}> => {
  try {
    return {value: await promise}
  } catch (error) {
    return {error}
  }
}

const readOutput = (stream: ReadableStream<Uint8Array>): Promise<string> => new Response(stream).text()

const ALLOWED_STAGES = new Set<string>([
  'remote-transaction-started',
  'lock-contention',
  'lock-acquired',
  'payload-decoded',
  'baseline-evidence',
  'prune-started',
  'prune-complete',
  'post-prune-capacity',
  'post-acquisition-capacity',
  'active-state-mutation',
  'image-acquisition',
  'active-state-written',
  'runtime-converged',
  'complete',
])

const stageFromOutput = (stdout: string): RemoteTransactionStage => {
  let stage: RemoteTransactionStage = 'starting'
  for (const line of stdout.split('\n')) {
    const candidate = line.startsWith('stage=') ? line.slice('stage='.length) : ''
    if (ALLOWED_STAGES.has(candidate)) stage = candidate as RemoteTransactionStage
  }
  return stage
}

const isAllowedEvidenceLine = (line: string): boolean => {
  const candidate = line.startsWith('stage=') ? line.slice('stage='.length) : ''
  if (ALLOWED_STAGES.has(candidate)) return true
  if (/^evidence=active-path:(?:root|config|data):(?:absent|present)$/.test(line)) return true
  if (
    /^evidence=storage:(?:baseline|post-prune|post-acquisition):probe=[\w./:@+=,-]+;mount=[\w./:@+=,-]+;source=[\w./:@+=,-]+;fstype=[\w./:@+=,-]+;free-bytes=\d+$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^evidence=docker-df:(?:baseline|post-prune|post-acquisition):type=[A-Za-z][A-Za-z-]*;count=\d+;active=\d+;size-bytes=\d+;reclaimable-bytes=\d+$/.test(
      line,
    )
  ) {
    return true
  }
  if (/^evidence=container-inventory:(?:baseline|post-prune|post-acquisition):count=\d+$/.test(line)) return true
  if (
    /^evidence=protected-image:(?:baseline|post-prune|post-acquisition):ref=[a-z0-9][a-z0-9._/@:+-]*;count=\d+$/.test(
      line,
    )
  )
    return true
  if (
    /^evidence=active-compose:(?:baseline|post-prune|post-acquisition):(?:absent|ref=ghcr\.io\/fro-bot\/dashboard(?::[\w.-]+)?@sha256:[a-f0-9]{64};digest=sha256:[a-f0-9]{64})$/.test(
      line,
    )
  ) {
    return true
  }
  if (
    /^evidence=running-dashboard:(?:baseline|post-prune|post-acquisition):(?:absent|unavailable|digest=sha256:[a-f0-9]{64};health=(?:healthy|unhealthy|starting|unknown))$/.test(
      line,
    )
  ) {
    return true
  }
  if (/^evidence=capacity:(?:post-prune|post-acquisition):free-bytes=\d+$/.test(line)) return true
  if (/^evidence=acquisition:mode=(?:pull|cache-fallback)$/.test(line)) return true
  if (/^evidence=image-verified:[a-z0-9][a-z0-9._/:+-]*@sha256:[a-f0-9]{64}$/.test(line)) return true
  if (/^evidence=active-state:published=(?:env|caddyfile|pem|compose)$/.test(line)) return true
  if (/^evidence=runtime-digest:sha256:[a-f0-9]{64}$/.test(line)) return true
  if (
    /^evidence=prune:(?:reclaimed-bytes|eligible-images|protected-containers)=\d+(?:;(?:reclaimed-bytes|eligible-images|protected-containers)=\d+)*$/.test(
      line,
    )
  ) {
    return true
  }
  return /^evidence=health:(?:healthy|unhealthy|unknown)$/.test(line)
}

export async function runRemoteTransaction(options: RemoteTransactionOptions): Promise<RemoteTransactionResult> {
  const payload = encodeRemotePayload(options.payload)
  const command = buildRemoteSshCommand(options)
  const process = options.spawn(command, {env: options.env, stdout: 'pipe', stderr: 'pipe', stdin: 'pipe'})
  const stdoutPromise = settle(readOutput(process.stdout))
  const stderrPromise = settle(readOutput(process.stderr))
  const exitPromise = settle(process.exited)

  let inputFailure: 'stdin-write' | 'stdin-close' | 'stdin-missing' | undefined
  const stdin = process.stdin
  if (stdin) {
    const writeResult = await Promise.race([
      (async () => {
        try {
          await stdin.write(payload)
          return {kind: 'write' as const, error: undefined}
        } catch (error) {
          return {kind: 'write' as const, error}
        }
      })(),
      exitPromise.then(result => ({kind: 'exit' as const, result})),
    ])

    if (writeResult.kind === 'exit' || writeResult.error) {
      inputFailure = 'stdin-write'
    }

    if (!inputFailure) {
      const closeResult = await Promise.race([
        (async () => {
          try {
            await stdin.end()
            return {kind: 'close' as const, error: undefined}
          } catch (error) {
            return {kind: 'close' as const, error}
          }
        })(),
        exitPromise.then(result => ({kind: 'exit' as const, result})),
      ])

      if (closeResult.kind === 'exit' || closeResult.error) {
        inputFailure = 'stdin-close'
      }
    }
  } else {
    inputFailure = 'stdin-missing'
  }

  const [stdoutResult, stderrResult, exitResult] = await Promise.all([stdoutPromise, stderrPromise, exitPromise])
  const stdout = stdoutResult.value ?? ''
  const stage = stageFromOutput(stdout)

  const exitCode = exitResult.value
  if (exitCode !== undefined && exitCode !== 0) {
    throw new RemoteTransactionError(stage, 'remote process exited unsuccessfully', exitCode)
  }
  if (inputFailure) {
    throw new RemoteTransactionError(stage, inputFailure)
  }
  if (stdoutResult.error || stderrResult.error) {
    throw new RemoteTransactionError(stage, 'output drain failed')
  }
  if (exitResult.error) {
    throw new RemoteTransactionError(stage, 'remote process did not report an exit status')
  }
  if (stage !== 'complete') {
    throw new RemoteTransactionError(stage, 'completion marker missing', exitCode)
  }

  return {
    stage,
    evidence: stdout.split('\n').filter(isAllowedEvidenceLine),
  }
}

export interface RemoteDeployPayload {
  env: string
  compose: string
  caddyfile: string
  githubAppKey: string
  expectedDashboardDigest: string
}

type PayloadField = keyof typeof REMOTE_PAYLOAD_FIELD_LIMITS

const PAYLOAD_FIELDS: readonly [PayloadField, keyof RemoteDeployPayload][] = [
  ['env', 'env'],
  ['compose', 'compose'],
  ['caddyfile', 'caddyfile'],
  ['github_app_key', 'githubAppKey'],
  ['expected_dashboard_digest', 'expectedDashboardDigest'],
]

const DASHBOARD_DIGEST_RE = /^sha256:[0-9a-f]{64}$/

const decodeUtf8 = (bytes: Uint8Array, context: string): string => {
  try {
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes)
  } catch {
    throw new Error(`Malformed remote deploy payload: invalid UTF-8 in ${context}`)
  }
}

const assertPayloadField = (field: PayloadField, value: string): Uint8Array => {
  if (value.length === 0) {
    throw new Error(`Malformed remote deploy payload: empty ${field} field`)
  }

  if (value.includes('\0')) {
    throw new Error(`Malformed remote deploy payload: NUL byte in ${field} field`)
  }

  const bytes = textEncoder.encode(value)
  const limit = REMOTE_PAYLOAD_FIELD_LIMITS[field]
  if (bytes.byteLength > limit) {
    throw new Error(`Remote deploy payload ${field} field exceeds its size limit`)
  }

  return bytes
}

const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const length = parts.reduce((total, part) => total + part.byteLength, 0)
  const result = new Uint8Array(length)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.byteLength
  }
  return result
}

export function encodeRemotePayload(payload: RemoteDeployPayload): Uint8Array {
  const parts: Uint8Array[] = [textEncoder.encode(PAYLOAD_HEADER)]

  for (const [wireField, payloadField] of PAYLOAD_FIELDS) {
    const value = payload[payloadField]
    if (payloadField === 'expectedDashboardDigest' && !DASHBOARD_DIGEST_RE.test(value)) {
      throw new Error('Malformed remote deploy payload: invalid expected dashboard digest')
    }
    const bytes = assertPayloadField(wireField, value)
    parts.push(textEncoder.encode(`field ${wireField} ${bytes.byteLength}\n`), bytes)
  }

  parts.push(textEncoder.encode(PAYLOAD_END))
  const encoded = concatBytes(parts)
  if (encoded.byteLength > REMOTE_PAYLOAD_MAX_BYTES) {
    throw new Error('Remote deploy payload exceeds its total size limit')
  }

  return encoded
}

class PayloadReader {
  readonly #bytes: Uint8Array
  #offset = 0

  constructor(bytes: Uint8Array) {
    this.#bytes = bytes
  }

  get offset(): number {
    return this.#offset
  }

  readLine(context: string): string {
    const lineEnd = this.#bytes.indexOf(10, this.#offset)
    if (lineEnd === -1) {
      throw new Error(`Malformed remote deploy payload: missing ${context} terminator`)
    }

    const line = decodeUtf8(this.#bytes.subarray(this.#offset, lineEnd), context)
    this.#offset = lineEnd + 1
    return line
  }

  readBytes(length: number, field: PayloadField): string {
    const end = this.#offset + length
    if (end > this.#bytes.byteLength) {
      throw new Error(`Malformed remote deploy payload: truncated ${field} field`)
    }

    const value = decodeUtf8(this.#bytes.subarray(this.#offset, end), `${field} field`)
    this.#offset = end
    if (value.length === 0) {
      throw new Error(`Malformed remote deploy payload: empty ${field} field`)
    }
    if (value.includes('\0')) {
      throw new Error(`Malformed remote deploy payload: NUL byte in ${field} field`)
    }
    return value
  }
}

export function decodeRemotePayload(encoded: Uint8Array): RemoteDeployPayload {
  if (encoded.byteLength > REMOTE_PAYLOAD_MAX_BYTES) {
    throw new Error('Remote deploy payload exceeds its total size limit')
  }

  const reader = new PayloadReader(encoded)
  if (reader.readLine('protocol header') !== PAYLOAD_HEADER.slice(0, -1)) {
    throw new Error('Malformed remote deploy payload: unsupported protocol version')
  }

  const values: Partial<RemoteDeployPayload> = {}
  const seen = new Set<PayloadField>()

  while (true) {
    const line = reader.readLine('field header')
    if (line === 'end') break

    const match = /^field ([a-z_]+) (\d+)$/.exec(line)
    if (!match) {
      throw new Error('Malformed remote deploy payload: invalid field header')
    }

    const wireField = match[1] as PayloadField
    if (!Object.prototype.hasOwnProperty.call(REMOTE_PAYLOAD_FIELD_LIMITS, wireField)) {
      throw new Error('Malformed remote deploy payload: unknown field')
    }
    if (seen.has(wireField)) {
      throw new Error('Malformed remote deploy payload: duplicate field')
    }

    const lengthText = match[2]
    if (!lengthText) {
      throw new Error('Malformed remote deploy payload: invalid field length')
    }
    if (lengthText !== '0' && lengthText.startsWith('0')) {
      throw new Error('Malformed remote deploy payload: invalid field length')
    }
    const length = Number(lengthText)
    if (!Number.isSafeInteger(length) || length > REMOTE_PAYLOAD_FIELD_LIMITS[wireField]) {
      throw new Error(`Remote deploy payload ${wireField} field exceeds its size limit`)
    }

    seen.add(wireField)
    const payloadField = PAYLOAD_FIELDS.find(([name]) => name === wireField)?.[1]
    if (!payloadField) {
      throw new Error('Malformed remote deploy payload: unknown field')
    }
    values[payloadField] = reader.readBytes(length, wireField)
  }

  if (seen.size !== PAYLOAD_FIELDS.length) {
    throw new Error('Malformed remote deploy payload: missing field')
  }
  if (reader.offset !== encoded.byteLength) {
    throw new Error('Malformed remote deploy payload: trailing data')
  }

  const expectedDashboardDigest = values.expectedDashboardDigest as string
  if (!DASHBOARD_DIGEST_RE.test(expectedDashboardDigest)) {
    throw new Error('Malformed remote deploy payload: invalid expected dashboard digest')
  }

  return {
    env: values.env as string,
    compose: values.compose as string,
    caddyfile: values.caddyfile as string,
    githubAppKey: values.githubAppKey as string,
    expectedDashboardDigest,
  }
}
