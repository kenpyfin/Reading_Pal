#!/usr/bin/env bash
# Start/stop the pdf_service FastAPI worker on the host (MinerU conda env).
# Used when PDF_SERVICE_RUNTIME=host (MinerU is not in the default Docker image).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${REPO_ROOT}/.env"
PID_FILE="${REPO_ROOT}/.run/pdf_service.pid"
LOG_FILE="${REPO_ROOT}/.run/pdf_service.log"
APP_PATH="${REPO_ROOT}/pdf_service/app.py"

load_env() {
  if [[ -f "$ENV_FILE" ]]; then
    set -a
    # shellcheck disable=SC1090
    source "$ENV_FILE"
    set +a
  fi
}

resolve_python() {
  load_env
  local py="${MINERU_PYTHON:-${PDF_SERVICE_PYTHON:-}}"
  if [[ -z "$py" ]]; then
    echo "ERROR: Set MINERU_PYTHON (or PDF_SERVICE_PYTHON) in .env for host pdf_service." >&2
    exit 1
  fi
  if [[ ! -x "$py" ]]; then
    echo "ERROR: Python interpreter not found or not executable: $py" >&2
    exit 1
  fi
  printf '%s' "$py"
}

host_runtime_selected() {
  load_env
  local runtime="${PDF_SERVICE_RUNTIME:-}"
  if [[ -z "$runtime" ]]; then
    if [[ "${PDF_EXTRACTION_BACKEND:-paddle}" == "mineru" ]]; then
      runtime="host"
    else
      runtime="docker"
    fi
  fi
  [[ "$runtime" == "host" ]]
}

compose_pdf_services() {
  if host_runtime_selected; then
    printf '%s\n' backend frontend image_server
  else
    printf '%s\n' backend frontend image_server pdf_service
  fi
}

compose_profile_args() {
  if host_runtime_selected; then
    printf '%s' ""
  else
    printf '%s' "--profile docker-pdf"
  fi
}

export_host_pdf_env() {
  load_env
  export PORT="${PDF_SERVICE_PORT:-8502}"
  export BACKEND_CALLBACK_URL="${BACKEND_CALLBACK_URL:-http://127.0.0.1:${BACKEND_PORT:-8501}/api/books/callback}"
  export PDF_STORAGE_PATH="${PDF_STORAGE_PATH:?PDF_STORAGE_PATH must be set in .env}"
  export MARKDOWN_PATH="${MARKDOWN_PATH:?MARKDOWN_PATH must be set in .env}"
  export IMAGES_PATH="${IMAGES_PATH:?IMAGES_PATH must be set in .env}"
  if [[ -n "${MINERU_MODELS_PATH:-}" ]]; then
    export MINERU_MODELS_PATH
    export MINERU_MODELS_DIR="${MINERU_MODELS_DIR:-$MINERU_MODELS_PATH}"
  fi
}

stop_host_pdf_service() {
  if [[ ! -f "$PID_FILE" ]]; then
    return 0
  fi
  local pid
  pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [[ -n "$pid" ]] && ps -p "$pid" >/dev/null 2>&1; then
    echo "INFO: Stopping host pdf_service (PID $pid)..."
    kill "$pid" 2>/dev/null || true
    wait "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
}

start_host_pdf_service() {
  local py
  py="$(resolve_python)"
  if [[ ! -f "$APP_PATH" ]]; then
    echo "ERROR: pdf_service entrypoint not found: $APP_PATH" >&2
    exit 1
  fi

  mkdir -p "$(dirname "$PID_FILE")" "$(dirname "$LOG_FILE")"
  stop_host_pdf_service
  export_host_pdf_env

  echo "INFO: Starting host pdf_service on port ${PORT} with $py ..."
  (
    cd "$REPO_ROOT"
    nohup "$py" "$APP_PATH" >>"$LOG_FILE" 2>&1 &
    echo $! >"$PID_FILE"
  )

  sleep 1
  local pid
  pid="$(cat "$PID_FILE")"
  if ! ps -p "$pid" >/dev/null 2>&1; then
    echo "ERROR: host pdf_service failed to start. See $LOG_FILE" >&2
    tail -n 40 "$LOG_FILE" 2>/dev/null || true
    exit 1
  fi
  local port="${PORT:-8502}"
  local waited=0
  while [[ $waited -lt 120 ]]; do
    if curl -sf "http://127.0.0.1:${port}/docs" >/dev/null 2>&1; then
      echo "INFO: host pdf_service running (PID $pid, port $port, log: $LOG_FILE)"
      return 0
    fi
    if ! ps -p "$pid" >/dev/null 2>&1; then
      echo "ERROR: host pdf_service exited during startup. See $LOG_FILE" >&2
      tail -n 40 "$LOG_FILE" 2>/dev/null || true
      exit 1
    fi
    sleep 1
    waited=$((waited + 1))
  done
  echo "ERROR: host pdf_service PID $pid did not respond on port $port. See $LOG_FILE" >&2
  tail -n 40 "$LOG_FILE" 2>/dev/null || true
  exit 1
}

status_host_pdf_service() {
  if [[ -f "$PID_FILE" ]]; then
    local pid
    pid="$(cat "$PID_FILE")"
    if ps -p "$pid" >/dev/null 2>&1; then
      echo "host pdf_service: running (PID $pid)"
      return 0
    fi
  fi
  echo "host pdf_service: not running"
  return 1
}

usage() {
  cat <<EOF
Usage: $(basename "$0") {start|stop|restart|status}

Host pdf_service control (MinerU conda). Configure via .env:
  PDF_SERVICE_RUNTIME=host
  MINERU_PYTHON=/path/to/MinerU/bin/python
EOF
}

main() {
  local cmd="${1:-}"
  case "$cmd" in
    start) start_host_pdf_service ;;
    stop) stop_host_pdf_service ;;
    restart) stop_host_pdf_service; start_host_pdf_service ;;
    status) status_host_pdf_service ;;
    *)
      usage
      exit 1
      ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
