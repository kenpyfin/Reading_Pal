#!/bin/bash

# Dev helper: host MinerU pdf_service + Docker Compose (backend, frontend, image_server).
# Configure PDF_SERVICE_RUNTIME and MINERU_PYTHON in .env (see docs/operations.md).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=scripts/pdf_service_host.sh
source "${SCRIPT_DIR}/scripts/pdf_service_host.sh"

cleanup() {
    echo "INFO: Shutting down services..."
    if host_runtime_selected; then
        stop_host_pdf_service || true
    fi
    echo "INFO: Stopping Docker Compose services (docker compose down)..."
    docker compose down
    echo "INFO: Cleanup complete."
}

trap cleanup SIGINT SIGTERM EXIT

load_env
mapfile -t COMPOSE_SERVICES < <(compose_pdf_services)

if host_runtime_selected; then
    start_host_pdf_service
else
    echo "INFO: PDF_SERVICE_RUNTIME=docker — pdf_service will run in Compose (not started here)."
fi

echo "INFO: Starting Docker Compose (${COMPOSE_SERVICES[*]})..."
docker compose up "${COMPOSE_SERVICES[@]}"
