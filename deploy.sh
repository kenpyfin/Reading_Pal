#!/bin/bash

# Deploy helper aligned with the active architecture:
# - Docker Compose for backend, frontend, image_server (always)
# - pdf_service: Docker (Paddle GPU) OR host MinerU conda (see PDF_SERVICE_RUNTIME in .env)
# - Always perform a fresh no-cache rebuild before startup (Docker services only)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pdf_service_host.sh
source "${SCRIPT_DIR}/scripts/pdf_service_host.sh"

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Options:
  -h, --help           Show this help message.
  --purge-volumes      Also remove Docker volumes (destructive; opt-in).

Behavior:
  Reads PDF_SERVICE_RUNTIME from .env (default: host when PDF_EXTRACTION_BACKEND=mineru,
  otherwise docker). Host mode starts pdf_service via MinerU conda on the host and does
  not run the pdf_service Compose container. Docker mode includes pdf_service in Compose.

  Stop existing stack, purge unused Docker cache/storage (containers, images, networks, builder cache),
  rebuild images with --no-cache,
  then start services with forced recreation.

Notes:
  Volumes are preserved by default for safer deploys. Use --purge-volumes only when you
  explicitly want to remove unused/compose-managed volumes.
EOF
}

cleanup() {
  echo "INFO: Shutting down services..."
  if host_runtime_selected; then
    stop_host_pdf_service || true
  fi
  docker compose down || true
}

purge_unused_docker_storage() {
  if [ "$PURGE_VOLUMES" = "true" ]; then
    echo "INFO: Purging unused Docker cache/storage (including volumes)..."
    docker system prune -af --volumes || true
  else
    echo "INFO: Purging unused Docker cache/storage (excluding volumes)..."
    docker system prune -af || true
  fi
  docker builder prune -af || true
}

compose_services() {
  compose_pdf_services
}

PURGE_VOLUMES="false"

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    --purge-volumes)
      PURGE_VOLUMES="true"
      shift
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

trap cleanup SIGINT SIGTERM

load_env
if host_runtime_selected; then
  echo "INFO: PDF service runtime=host (MinerU on host). Compose will skip pdf_service container."
else
  echo "INFO: PDF service runtime=docker (pdf_service Compose container)."
fi

echo "INFO: Starting clean deployment with no Docker build cache..."
if [ "$PURGE_VOLUMES" = "true" ]; then
  echo "INFO: Bringing down existing stack (including orphan containers and volumes)..."
  stop_host_pdf_service || true
  docker compose down --remove-orphans --volumes || true
else
  echo "INFO: Bringing down existing stack (including orphan containers; preserving volumes)..."
  stop_host_pdf_service || true
  docker compose down --remove-orphans || true
fi

purge_unused_docker_storage

mapfile -t DEPLOY_SERVICES < <(compose_services)
PROFILE_ARGS=( $(compose_profile_args) )
echo "INFO: Rebuilding Docker services with --no-cache: ${DEPLOY_SERVICES[*]}"
docker compose "${PROFILE_ARGS[@]}" build --no-cache "${DEPLOY_SERVICES[@]}"

echo "INFO: Starting Docker Compose services with forced recreation..."
docker compose "${PROFILE_ARGS[@]}" up --force-recreate -d "${DEPLOY_SERVICES[@]}"

if host_runtime_selected; then
  # Ensure orphaned pdf_service container from a prior docker-mode deploy is stopped.
  docker compose --profile docker-pdf stop pdf_service 2>/dev/null || true
  docker compose --profile docker-pdf rm -f pdf_service 2>/dev/null || true
  start_host_pdf_service
else
  stop_host_pdf_service || true
fi

echo "INFO: Deploy complete."
if host_runtime_selected; then
  status_host_pdf_service || true
  if ! curl -sf "http://127.0.0.1:${PDF_SERVICE_PORT:-8502}/docs" >/dev/null; then
    echo "ERROR: host pdf_service is not responding on port ${PDF_SERVICE_PORT:-8502}" >&2
    exit 1
  fi
  echo "INFO: host pdf_service health check passed (http://127.0.0.1:${PDF_SERVICE_PORT:-8502})"
fi
