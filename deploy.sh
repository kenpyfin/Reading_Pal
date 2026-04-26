#!/bin/bash

# Deploy helper aligned with the active architecture:
# - Always run services via Docker Compose (including pdf_service).
# - Always perform a fresh no-cache rebuild before startup.

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: ./deploy.sh [options]

Options:
  -h, --help        Show this help message.

Behavior:
  Stop existing stack, remove stale containers/volumes/images cache, rebuild images with --no-cache,
  then start the full Compose stack with forced recreation.
EOF
}

cleanup() {
  echo "INFO: Shutting down services..."
  docker compose down || true
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: Unknown option: $1"
      usage
      exit 1
      ;;
  esac
done

trap cleanup SIGINT SIGTERM EXIT

echo "INFO: Starting clean deployment with no Docker build cache..."
echo "INFO: Bringing down existing stack (including orphan containers and volumes)..."
docker compose down --remove-orphans --volumes || true

echo "INFO: Pruning builder cache to avoid stale layers..."
docker builder prune -af || true

echo "INFO: Rebuilding all images with --no-cache..."
docker compose build --no-cache

echo "INFO: Starting full Docker Compose stack (including pdf_service) with forced recreation..."
docker compose up --force-recreate
