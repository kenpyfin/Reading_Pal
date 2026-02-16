#!/bin/bash
#
# This script automates the deployment process by pulling the latest changes,
# stopping the current services, and rebuilding/restarting them to ensure a clean deployment.
#
# It ensures that the application is always running the most recent version
# of the code from the main branch.

# Exit immediately if a command exits with a non-zero status.
set -e

# Python interpreter / script for the standalone PDF service (MinerU environment)
PYTHON_INTERPRETER="/home/ken/miniconda3/envs/MinerU/bin/python"
PDF_SERVICE_PATH="pdf_service/app.py"
PDF_SERVICE_PID=""

cleanup() {
  echo "INFO: Shutting down services..."

  # Stop the standalone Python PDF service
  if [ -n "$PDF_SERVICE_PID" ] && ps -p "$PDF_SERVICE_PID" > /dev/null 2>&1; then
    echo "INFO: Stopping PDF service (PID: $PDF_SERVICE_PID)..."
    kill "$PDF_SERVICE_PID" || true
    wait "$PDF_SERVICE_PID" 2>/dev/null || true
    echo "INFO: PDF service stopped."
  else
    echo "INFO: PDF service not running or PID not captured."
  fi

  # Stop Docker Compose services
  echo "INFO: Stopping Docker Compose services (docker compose down)..."
  docker compose down || true
  echo "INFO: Docker Compose services stopped."

  echo "INFO: Cleanup complete."
}

trap cleanup SIGINT SIGTERM EXIT

echo "🚀 Starting deployment process..."

# Stop and remove the old containers, networks, and volumes.
echo "🧹 Stopping and removing old containers..."
docker compose down || true

# Clean up any unused Docker images.
echo "🗑️  Cleaning up dangling images..."
docker system prune -af

# Project root and models dir for standalone PDF service (must match your downloaded models)
PROJECT_ROOT="$(cd "$(dirname "$0")" && pwd)"
STANDALONE_MODELS_DIR="$PROJECT_ROOT/pdf_service/models"
STANDALONE_CONFIG="$PROJECT_ROOT/pdf_service/magic-pdf.standalone.json"

# Generate config that points to project models dir so magic_pdf loads from disk, not HF cache
sed "s|\"/app/models\"|\"$STANDALONE_MODELS_DIR\"|g" "$PROJECT_ROOT/pdf_service/magic-pdf.json" > "$STANDALONE_CONFIG"
export MINERU_TOOLS_CONFIG_JSON="$STANDALONE_CONFIG"

# Start the standalone PDF Processing Service (outside Docker)
echo "INFO: Starting standalone PDF service: $PYTHON_INTERPRETER $PDF_SERVICE_PATH ..."
echo "INFO: Using models dir: $STANDALONE_MODELS_DIR (config: $STANDALONE_CONFIG)"
if [ ! -f "$PDF_SERVICE_PATH" ]; then
  echo "ERROR: PDF service script not found at $PDF_SERVICE_PATH. Please run this script from the project root."
  exit 1
fi
if [ ! -x "$PYTHON_INTERPRETER" ]; then
  echo "ERROR: Python interpreter not found or not executable at $PYTHON_INTERPRETER."
  exit 1
fi

"$PYTHON_INTERPRETER" "$PDF_SERVICE_PATH" &
PDF_SERVICE_PID=$!
echo "INFO: PDF service started with PID: $PDF_SERVICE_PID"

sleep 1
if ! ps -p "$PDF_SERVICE_PID" > /dev/null 2>&1; then
  echo "ERROR: PDF service (PID: $PDF_SERVICE_PID) failed to start or exited prematurely."
  exit 1
fi

# Rebuild and restart the Docker containers.
echo "🏗️  Building and restarting Docker services..."
docker compose up --build

echo "✅ Deployment finished successfully!"
