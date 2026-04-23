#!/usr/bin/env bash

set -euo pipefail

# Fast reload helper for continuous development.
# Default behavior:
# - Detect changed files from git working tree
# - Map them to docker-compose services
# - Rebuild/restart only affected services with minimal churn
#
# Examples:
#   ./reload_dev.sh
#   ./reload_dev.sh --service backend --service frontend
#   ./reload_dev.sh --all
#   ./reload_dev.sh --no-build
#   ./reload_dev.sh --with-deps

BUILD=1
NO_DEPS=1
DRY_RUN=0
ALL_SERVICES=0
declare -a SELECTED_SERVICES=()

usage() {
  cat <<'EOF'
Usage: ./reload_dev.sh [options]

Options:
  --service <name>   Reload a specific service (repeatable)
  --all              Reload all services in docker-compose.yml
  --no-build         Restart without rebuilding images
  --with-deps        Include dependencies (omit --no-deps)
  --dry-run          Print command only, do not execute
  -h, --help         Show help

Services: backend, frontend, image_server, pdf_service
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

add_all_default_services() {
  add_service_unique backend
  add_service_unique frontend
  add_service_unique image_server
  add_service_unique pdf_service
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

detect_changed_services() {
  local changed
  changed="$(git status --porcelain --untracked-files=no | awk '{print $2}')"

  if [[ -z "$changed" ]]; then
    echo "INFO: No tracked file changes detected. Defaulting to backend + frontend."
    add_service_unique backend
    add_service_unique frontend
    return
  fi

  while IFS= read -r path; do
    [[ -z "$path" ]] && continue
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
      docker-compose.yml|.env|deploy.sh|start_services.sh|reload_dev.sh)
        add_all_default_services
        ;;
      *)
        ;;
    esac
  done <<<"$changed"

  if [[ ${#SELECTED_SERVICES[@]} -eq 0 ]]; then
    echo "INFO: Changes did not map to a specific service. Defaulting to backend + frontend."
    add_service_unique backend
    add_service_unique frontend
  fi
}

validate_services() {
  local valid_regex='^(backend|frontend|image_server|pdf_service)$'
  for svc in "${SELECTED_SERVICES[@]}"; do
    if [[ ! "$svc" =~ $valid_regex ]]; then
      echo "ERROR: Unsupported service '$svc'." >&2
      exit 1
    fi
  done
}

run_reload() {
  local -a cmd
  cmd=(docker compose up -d)
  if [[ $BUILD -eq 1 ]]; then
    cmd+=(--build)
  fi
  if [[ $NO_DEPS -eq 1 ]]; then
    cmd+=(--no-deps)
  fi
  cmd+=("${SELECTED_SERVICES[@]}")

  echo "INFO: Reload target services: ${SELECTED_SERVICES[*]}"
  echo "INFO: Executing: ${cmd[*]}"
  if [[ $DRY_RUN -eq 1 ]]; then
    return
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

  if [[ $ALL_SERVICES -eq 1 ]]; then
    add_all_default_services
  elif [[ ${#SELECTED_SERVICES[@]} -eq 0 ]]; then
    detect_changed_services
  fi

  validate_services
  run_reload
}

main "$@"
