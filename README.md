# Reading Pal Application

This repository contains the code for the Reading Pal application, a tool for reading PDFs with LLM assistance.

## Components

- `backend/`: Python backend API (FastAPI/Flask)
- `frontend/`: React frontend application
- `pdf_service/`: Python PDF processing service (FastAPI) - *Existing*

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
*   **LLM Providers:** You will need API keys or access to local LLM services (Ollama) as configured in the `.env` file.
*   **File Storage:** The PDF service requires specific directories for storing PDFs, Markdown, and Images. These paths are configured in the `.env` file and mounted as volumes in `docker-compose.yml`. **You must create these directories on your host machine and update the volume paths in `docker-compose.yml` to match.**

### Configuration

1.  Copy the `.env.example` (if you create one later) or manually create a `.env` file in the root directory.
2.  Populate the `.env` file with your specific configurations, including:
    *   `MONGO_URI` (should point to your host MongoDB, e.g., `mongodb://host.docker.internal:27017/`)
    *   LLM API keys (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`) or `OLLAMA_BASE_URL`
    *   `PDF_CLIENT_URL` (should be `http://pdf_service:8502` within the Docker network, but the `.env` is primarily for local/non-docker runs or passing to docker-compose)
    *   Absolute paths for `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH` on your host machine.

### Running the Application

1.  Ensure your MongoDB instance is running and accessible from `host.docker.internal:27017`.
2.  Ensure the file storage directories exist on your host and the volume paths in `docker-compose.yml` are correct.
3.  Build and run the services using Docker Compose:
    ```bash
    docker-compose up --build
    ```
4.  The frontend should be accessible at `http://localhost:${FRONTEND_PORT}` (default 3100).
    The backend API should be accessible at `http://localhost:${BACKEND_PORT}` (default 8000).
    The PDF service should be accessible at `http://localhost:8502`.

... (Add other setup instructions later)
