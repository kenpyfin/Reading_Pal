#!/bin/bash

# Define the Python interpreter and script path
PYTHON_INTERPRETER="/home/ken/miniconda3/envs/MinerU/bin/python"
# Assuming this script is run from the project root, and pdf_service is a subdirectory
PDF_SERVICE_PATH="pdf_service/app.py" 

PDF_SERVICE_PID=""

# Function to clean up processes
cleanup() {
    echo "INFO: Shutting down services..."

    # Stop the Python PDF service
    if [ -n "$PDF_SERVICE_PID" ] && ps -p "$PDF_SERVICE_PID" > /dev/null; then
        echo "INFO: Stopping PDF service (PID: $PDF_SERVICE_PID)..."
        kill "$PDF_SERVICE_PID"
        # Wait for the process to terminate to avoid race conditions
        wait "$PDF_SERVICE_PID" 2>/dev/null
        echo "INFO: PDF service stopped."
    else
        echo "INFO: PDF service (PID: $PDF_SERVICE_PID) not running or PID not captured."
    fi

    # Stop Docker Compose services
    # This command will stop and remove containers, networks, etc., defined in the compose file.
    echo "INFO: Stopping Docker Compose services (docker compose down)..."
    docker compose down
    echo "INFO: Docker Compose services stopped."

    echo "INFO: Cleanup complete."
}

# Trap signals to ensure cleanup function is called
# SIGINT: Sent when Ctrl+C is pressed.
# SIGTERM: A generic signal used to cause program termination.
# EXIT: Triggered when the script exits for any reason (normal termination or due to a signal).
trap cleanup SIGINT SIGTERM EXIT

# Start the Python PDF service in the background
echo "INFO: Starting PDF service: $PYTHON_INTERPRETER $PDF_SERVICE_PATH ..."
if [ ! -f "$PDF_SERVICE_PATH" ]; then
    echo "ERROR: PDF service script not found at $PDF_SERVICE_PATH. Please ensure the path is correct and the script is run from the project root."
    exit 1
fi
if [ ! -x "$PYTHON_INTERPRETER" ]; then
    echo "ERROR: Python interpreter not found or not executable at $PYTHON_INTERPRETER."
    exit 1
fi

"$PYTHON_INTERPRETER" "$PDF_SERVICE_PATH" &
PDF_SERVICE_PID=$!
echo "INFO: PDF service started with PID: $PDF_SERVICE_PID"

# Check if PDF service started successfully
# A small delay to allow the process to potentially fail quickly
sleep 1 
if ! ps -p "$PDF_SERVICE_PID" > /dev/null; then
    echo "ERROR: PDF service (PID: $PDF_SERVICE_PID) failed to start or exited prematurely."
    # The EXIT trap will handle cleanup
    exit 1
fi

# Start Docker Compose in the foreground
# This will block and stream logs. Ctrl+C here will trigger the SIGINT trap.
echo "INFO: Starting Docker Compose (logs will follow)..."
docker compose up

# When `docker compose up` exits (e.g., due to Ctrl+C or if services stop),
# the script will proceed to exit, and the EXIT trap will call the cleanup function.
echo "INFO: Docker Compose process has finished."
