#!/bin/bash
#
# This script automates the deployment process by pulling the latest changes,
# stopping the current services, and rebuilding/restarting them to ensure a clean deployment.
#
# It ensures that the application is always running the most recent version
# of the code from the main branch.

# Exit immediately if a command exits with a non-zero status.
set -e

# Python interpreter / script for the standalone PDF service.
# Override with PDF_SERVICE_PYTHON if needed.
PYTHON_INTERPRETER="${PDF_SERVICE_PYTHON:-python3}"
PDF_SERVICE_PATH="pdf_service/app.py"
PDF_SERVICE_PID=""

resolve_python_interpreter() {
  # Allow either an absolute path or a command resolved via PATH.
  if [ -x "$PYTHON_INTERPRETER" ]; then
    echo "$PYTHON_INTERPRETER"
    return 0
  fi

  if command -v "$PYTHON_INTERPRETER" >/dev/null 2>&1; then
    command -v "$PYTHON_INTERPRETER"
    return 0
  fi

  return 1
}

stop_standalone_pdf_service() {
  local captured_pid_exited="false"

  # First try the captured PID from this run.
  if [ -n "$PDF_SERVICE_PID" ]; then
    if ps -p "$PDF_SERVICE_PID" > /dev/null 2>&1; then
      echo "INFO: Stopping PDF service (PID: $PDF_SERVICE_PID)..."
      kill "$PDF_SERVICE_PID" || true
      wait "$PDF_SERVICE_PID" 2>/dev/null || true
      echo "INFO: PDF service stopped."
      return
    fi
    echo "INFO: PDF service PID was captured ($PDF_SERVICE_PID) but the process already exited."
    captured_pid_exited="true"
  fi

  # Fallback: stop any existing standalone PDF service started outside this script.
  local stale_pids
  stale_pids="$(pgrep -f "$PDF_SERVICE_PATH" || true)"
  if [ -n "$stale_pids" ]; then
    echo "INFO: Stopping existing PDF service process(es): $stale_pids"
    # shellcheck disable=SC2086
    kill $stale_pids || true
    echo "INFO: Existing PDF service process(es) stopped."
  else
    if [ "$captured_pid_exited" != "true" ]; then
      echo "INFO: PDF service not running or PID not captured."
    fi
  fi
}

cleanup() {
  echo "INFO: Shutting down services..."

  # Stop the standalone Python PDF service.
  stop_standalone_pdf_service

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

# Start the standalone PDF Processing Service (outside Docker)
echo "INFO: Starting standalone PDF service: $PYTHON_INTERPRETER $PDF_SERVICE_PATH ..."
if [ ! -f "$PDF_SERVICE_PATH" ]; then
  echo "ERROR: PDF service script not found at $PDF_SERVICE_PATH. Please run this script from the project root."
  exit 1
fi

RESOLVED_PYTHON="$(resolve_python_interpreter || true)"
if [ -z "$RESOLVED_PYTHON" ]; then
  echo "ERROR: Python interpreter not found or not executable: $PYTHON_INTERPRETER."
  exit 1
fi

"$RESOLVED_PYTHON" "$PDF_SERVICE_PATH" &
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
