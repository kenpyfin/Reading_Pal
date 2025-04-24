#!/bin/bash

# Exit immediately if a command exits with a non-zero status.
set -e

echo "--- Reading Pal Quick Test Setup ---"

# --- Automatic Cleanup Warning ---
echo "Note: This script will automatically prune dangling Docker volumes and images"
echo "before building, and stop/remove services (including volumes and local images)"
echo "after the test instructions are displayed or if the script encounters an error."
echo "---"

# --- Trap for Cleanup on Exit ---
# This ensures docker-compose down runs even if the script fails partway through
cleanup() {
    echo "--- Running Cleanup ---"
    # Use || true to prevent the trap itself from failing if docker-compose down fails
    # --volumes removes volumes associated with the services
    # --rmi local removes images built locally by the compose file
    docker-compose down --volumes --rmi local || true
    echo "--- Cleanup Complete ---"
}
trap cleanup EXIT

# --- Prerequisites ---
echo "Checking prerequisites..."
if ! command -v docker &> /dev/null
then
    echo "Error: docker command not found. Please install Docker."
    exit 1
fi
if ! command -v docker-compose &> /dev/null
then
    echo "Error: docker-compose command not found. Please install Docker Compose."
    exit 1
fi

# Check for .env file
if [ ! -f .env ]; then
    echo "Error: .env file not found in the project root."
    echo "Please create a .env file based on the requirements (MongoDB URI, LLM keys/URLs, File Paths, PDF_CLIENT_URL)."
    exit 1
fi

# Check if PDF_CLIENT_URL is set in .env
if ! grep -q "^PDF_CLIENT_URL=" .env; then
    echo "Warning: PDF_CLIENT_URL is not set in .env. PDF upload will fail."
fi

# Check if required file paths are set in .env
if ! grep -q "^PDF_STORAGE_PATH=" .env || ! grep -q "^MARKDOWN_PATH=" .env || ! grep -q "^IMAGES_PATH=" \
.env; then
    echo "Warning: PDF_STORAGE_PATH, MARKDOWN_PATH, or IMAGES_PATH not set in .env."
    echo "The PDF service needs these absolute paths configured correctly."
fi


echo "Prerequisites met."

# --- Cleanup Dangling Resources ---
echo "Pruning dangling Docker volumes and images..."
# -f flag forces removal without confirmation
docker volume prune -f
docker image prune -f
echo "Dangling resources pruned."

# --- Build Docker Images ---
echo "Building backend and frontend Docker images..."
docker-compose build --no-cache backend frontend

echo "Docker images built."

# --- Start Services ---
echo "Starting Backend, and Frontend services..."
# Start only the services needed for the core flow.
# The PDF service is assumed to be running separately as per architecture.
docker-compose up -d backend frontend

echo "Services started. Check 'docker-compose ps' to confirm."
docker-compose ps


# --- Test Instructions ---
echo "--- Testing Instructions ---"
echo "1. Ensure your separate PDF Processing Service is running and accessible at the URL configured in PDF_CLIENT_URL in your .env file."
echo "2. Open your web browser and navigate to http://localhost:3100 (or the port configured for the frontend)."
echo "3. Use the form to upload a PDF file."
echo "4. Observe the upload process. If successful, you should be redirected to the book view page."
echo "5. In the book view, verify that the markdown content and images are displayed correctly."
echo "6. Test adding notes in the Note Pane."
echo "7. Test the 'Summarize Book' and 'Ask a Question' features in the Note Pane."
echo "8. Check the backend and PDF service logs for errors if something goes wrong."
echo "   - Backend logs: docker-compose logs backend"
echo "   - PDF Service logs: Check the logs for your separate PDF service instance."
echo "   - Frontend logs: Check your browser's developer console."


echo "Waiting for services to initialize and external dependencies (PDF Service, MongoDB) to be ready."
read -p "Press Enter to continue with testing instructions..."


echo "--- End of Setup ---"
echo "The script will now stop and remove the services it started."

# The trap command will execute cleanup() upon script exit.
# If the script reaches here successfully, it will exit normally,
# triggering the trap and running docker-compose down.
