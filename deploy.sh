#!/bin/bash

# Deploy helper aligned with the active architecture:
# - Always run services via Docker Compose (including pdf_service).
# - Always perform a fresh no-cache rebuild before startup.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Options:
  -h, --help           Show this help message.
  --purge-volumes      Also remove Docker volumes (destructive; opt-in).

Behavior:
  Stop existing stack, purge unused Docker cache/storage (containers, images, networks, builder cache),
  rebuild images with --no-cache,
  then start the full Compose stack with forced recreation.

Notes:
  Volumes are preserved by default for safer deploys. Use --purge-volumes only when you
  explicitly want to remove unused/compose-managed volumes.
EOF
}

cleanup() {
  echo "INFO: Shutting down services..."
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

echo "INFO: Starting clean deployment with no Docker build cache..."
if [ "$PURGE_VOLUMES" = "true" ]; then
  echo "INFO: Bringing down existing stack (including orphan containers and volumes)..."
  docker compose down --remove-orphans --volumes || true
else
  echo "INFO: Bringing down existing stack (including orphan containers; preserving volumes)..."
  docker compose down --remove-orphans || true
fi

purge_unused_docker_storage

echo "INFO: Rebuilding all images with --no-cache..."
docker compose build --no-cache

echo "INFO: Starting full Docker Compose stack (including pdf_service) with forced recreation..."
docker compose up --force-recreate -d
