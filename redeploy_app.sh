#!/usr/bin/env bash

set -euo pipefail

# Fast redeploy helper:
# - Avoids full docker-compose teardown/recreate cycles
# - Rebuilds/restarts only services affected by code changes
# - Detects both local working tree edits and (optionally) recent commit changes

BUILD=1
NO_DEPS=1
DRY_RUN=0
ALL_SERVICES=0
INCLUDE_LAST_COMMIT=1
SINCE_REF=""
UNTIL_REF="HEAD"

declare -a SELECTED_SERVICES=()
declare -a CHANGED_PATHS=()

usage() {
  cat <<'EOF'
Usage: ./redeploy_app.sh [options]

Options:
  --service <name>   Redeploy a specific service (repeatable)
  --all              Redeploy all services
  --no-build         Restart containers without rebuilding images
  --with-deps        Include dependent services (omit --no-deps)
  --dry-run          Print command and target services only
  --since-ref <ref>  Detect changes from git ref <ref> to --until-ref (default HEAD)
  --until-ref <ref>  End ref for --since-ref diff (default HEAD)
  --no-last-commit   Skip automatic HEAD~1..HEAD diff fallback
  -h, --help         Show this help

Services:
  backend, frontend, image_server, pdf_service

Examples:
  ./redeploy_app.sh
  ./redeploy_app.sh --service backend --service frontend
  ./redeploy_app.sh --since-ref origin/main
  ./redeploy_app.sh --all --no-build
EOF
}

contains_service() {
  local needle="$1"
  shift || true
  for item in "$@"; do
    if [[ "$item" == "$needle" ]]; then
      return 0
    fi
  done
  return 1
}

add_service_unique() {
  local svc="$1"
  if ! contains_service "$svc" "${SELECTED_SERVICES[@]}"; then
    SELECTED_SERVICES+=("$svc")
  fi
}

add_path_unique() {
  local path="$1"
  local existing
  for existing in "${CHANGED_PATHS[@]}"; do
    if [[ "$existing" == "$path" ]]; then
      return 0
    fi
  done
  CHANGED_PATHS+=("$path")
}

add_all_default_services() {
  add_service_unique backend
  add_service_unique frontend
  add_service_unique image_server
  add_service_unique pdf_service
}

is_git_repo() {
  git rev-parse --is-inside-work-tree >/dev/null 2>&1
}

collect_paths_from_worktree() {
  if ! is_git_repo; then
    return 0
  fi

  local changed
  changed="$(git status --porcelain --untracked-files=no | awk '{print $2}')"
  if [[ -z "$changed" ]]; then
    return 0
  fi

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    add_path_unique "$path"
  done <<<"$changed"
}

collect_paths_from_ref_range() {
  local from_ref="$1"
  local to_ref="$2"

  if ! is_git_repo; then
    return 0
  fi
  if ! git rev-parse --verify "$from_ref" >/dev/null 2>&1; then
    return 0
  fi
  if ! git rev-parse --verify "$to_ref" >/dev/null 2>&1; then
    return 0
  fi

  local changed
  changed="$(git diff --name-only "$from_ref" "$to_ref")"
  if [[ -z "$changed" ]]; then
    return 0
  fi

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
    add_path_unique "$path"
  done <<<"$changed"
}

map_paths_to_services() {
  local path
  for path in "${CHANGED_PATHS[@]}"; do
    case "$path" in
      backend/*)
        add_service_unique backend
        ;;
      frontend/*)
        add_service_unique frontend
        ;;
      image_server/*)
        add_service_unique image_server
        ;;
      pdf_service/*)
        add_service_unique pdf_service
        ;;
      docker-compose.yml|docker-compose.*.yml|.env|deploy.sh|reload_dev.sh|redeploy_app.sh|start_services.sh)
        add_all_default_services
        ;;
      *)
        ;;
    esac
  done
}

validate_services() {
  local valid_regex='^(backend|frontend|image_server|pdf_service)$'
  local svc
  for svc in "${SELECTED_SERVICES[@]}"; do
    if [[ ! "$svc" =~ $valid_regex ]]; then
      echo "ERROR: Unsupported service '$svc'." >&2
      exit 1
    fi
  done
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --service)
        if [[ $# -lt 2 ]]; then
          echo "ERROR: --service requires a value." >&2
          exit 1
        fi
        add_service_unique "$2"
        shift 2
        ;;
      --all)
        ALL_SERVICES=1
        shift
        ;;
      --no-build)
        BUILD=0
        shift
        ;;
      --with-deps)
        NO_DEPS=0
        shift
        ;;
      --dry-run)
        DRY_RUN=1
        shift
        ;;
      --since-ref)
        if [[ $# -lt 2 ]]; then
          echo "ERROR: --since-ref requires a value." >&2
          exit 1
        fi
        SINCE_REF="$2"
        shift 2
        ;;
      --until-ref)
        if [[ $# -lt 2 ]]; then
          echo "ERROR: --until-ref requires a value." >&2
          exit 1
        fi
        UNTIL_REF="$2"
        shift 2
        ;;
      --no-last-commit)
        INCLUDE_LAST_COMMIT=0
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        echo "ERROR: Unknown option '$1'." >&2
        usage
        exit 1
        ;;
    esac
  done
}

detect_services_if_needed() {
  if [[ ${#SELECTED_SERVICES[@]} -gt 0 ]]; then
    return 0
  fi

  if [[ $ALL_SERVICES -eq 1 ]]; then
    add_all_default_services
    return 0
  fi

  collect_paths_from_worktree

  if [[ -n "$SINCE_REF" ]]; then
    collect_paths_from_ref_range "$SINCE_REF" "$UNTIL_REF"
  elif [[ $INCLUDE_LAST_COMMIT -eq 1 ]]; then
    collect_paths_from_ref_range "HEAD~1" "HEAD"
  fi

  if [[ ${#CHANGED_PATHS[@]} -gt 0 ]]; then
    echo "INFO: Change detection paths:"
    printf '  - %s\n' "${CHANGED_PATHS[@]}"
  fi

  map_paths_to_services

  if [[ ${#SELECTED_SERVICES[@]} -eq 0 ]]; then
    echo "INFO: No mapped changes found. Defaulting to backend + frontend."
    add_service_unique backend
    add_service_unique frontend
  fi
}

run_redeploy() {
  local -a cmd
  cmd=(docker compose up -d)
  if [[ $BUILD -eq 1 ]]; then
    cmd+=(--build)
  fi
  if [[ $NO_DEPS -eq 1 ]]; then
    cmd+=(--no-deps)
  fi
  cmd+=("${SELECTED_SERVICES[@]}")

  echo "INFO: Redeploy target services: ${SELECTED_SERVICES[*]}"
  echo "INFO: Executing: ${cmd[*]}"
  if [[ $DRY_RUN -eq 1 ]]; then
    return 0
  fi

  "${cmd[@]}"
}

main() {
  if ! command -v docker >/dev/null 2>&1; then
    echo "ERROR: docker is not installed or not in PATH." >&2
    exit 1
  fi
  if ! docker compose version >/dev/null 2>&1; then
    echo "ERROR: docker compose is unavailable." >&2
    exit 1
  fi

  parse_args "$@"
  detect_services_if_needed
  validate_services
  run_redeploy
}

main "$@"
