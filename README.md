# Reading Pal Application

This repository contains the code for the Reading Pal application, a tool for reading PDFs with LLM assistance.

## Components

- `backend/`: Python backend API (FastAPI/Flask)
- `frontend/`: React frontend application
- `pdf_service/`: Python PDF processing service (FastAPI) - *This service runs independently.*

## Setup

### Prerequisites

*   Docker and Docker Compose
*   Python 3.9+
*   Node.js and npm/yarn
*   **MongoDB:** The application requires a running MongoDB instance. By default, the `docker-compose.yml` is configured to connect to a MongoDB instance running on your host machine at `mongodb://host.docker.internal:27017/`.
    *   `host.docker.internal` is a special DNS name that resolves to the internal IP address used by the host from within a Docker container. This works on Docker Desktop (Mac/Windows) and recent versions of Docker Engine on Linux. If you are on an older Linux setup, you might need to find your host's IP address and use that instead.
    *   If you do not have MongoDB installed on your host, you can install it manually or run it via Docker. A simple `docker-compose.yml` for just MongoDB would look like this:
        ```yaml
        version: '3.8'
        services:
          mongodb:
            image: mongo:latest
            ports:
              - "27017:27017"
            volumes:
              - mongo_data:/data/db
            environment:
              MONGO_INITDB_DATABASE: reading_pal
        volumes:
          mongo_data:
        ```
        Save this as `docker-compose.mongo.yml` and run `docker-compose -f docker-compose.mongo.yml up -d`.
*   **PDF Processing Service:** This service (`pdf_service/app.py`) must be running independently and accessible at the URL configured in the `.env` file (`PDF_CLIENT_URL`). It requires its own Python environment (e.g., Conda) and dependencies (`magic_pdf`, `fastapi`, `uvicorn`, `anthropic`, etc.).
*   **LLM Providers:** You will need API keys or access to local LLM services (Ollama) as configured in the `.env` file.
*   **File Storage:** The PDF service requires specific directories on your host machine for storing PDFs, Markdown, and Images. These paths are configured in the `.env` file and the `IMAGES_PATH` is mounted as a volume into the `backend` service container in `docker-compose.yml` so the backend can serve the images. **You must create these directories on your host machine and update the volume paths in the root `.env` and the `docker-compose.yml` backend service volume mount to match.**

### Configuration

1.  Copy the `.env.example` (if you create one later) or manually create a `.env` file in the root directory.
2.  Populate the `.env` file with your specific configurations, including:
    *   `MONGO_URI` (should point to your host MongoDB, e.g., `mongodb://host.docker.internal:27017/`)
    *   `PDF_CLIENT_URL` (the URL where your standalone PDF service is running, e.g., `http://localhost:8502`)
    *   LLM API keys (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`) or `OLLAMA_BASE_URL`
    *   Absolute paths for `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH` on your host machine.

### Running the Application

1.  Ensure your MongoDB instance is running and accessible from `host.docker.internal:27017`.
2.  **Start the PDF Processing Service independently** in its required environment (e.g., `uvicorn pdf_service.app:app --host 0.0.0.0 --port 8502`). Ensure it is accessible at the `PDF_CLIENT_URL` specified in your `.env`.
3.  Ensure the file storage directories exist on your host and the volume paths for the `backend` service in `docker-compose.yml` are correct and match the `IMAGES_PATH` in your `.env`.
4.  Build and run the backend and frontend services using Docker Compose:
    ```bash
    docker-compose up --build backend frontend
    ```
5.  The frontend should be accessible at `http://localhost:${FRONTEND_PORT}` (default 3100).
    The backend API should be accessible at `http://localhost:${BACKEND_PORT}` (default 8000).

... (Add other setup instructions later)
