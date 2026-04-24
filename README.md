# Reading Pal Application

This repository contains the code for the Reading Pal application, a tool for reading PDFs with LLM assistance.

## Components

- `backend/`: Python backend API (FastAPI/Flask)
- `frontend/`: React frontend application
- `pdf_service/`: PDF-to-markdown service (FastAPI). Uses **PaddleOCR** (GPU) for scanned PDFs and **PyMuPDF** for text extraction on digital PDFs. Can run in Docker Compose with GPU or standalone.

## Setup

### Prerequisites

*   Docker and Docker Compose
*   Python 3.10+ (backend Docker image uses 3.12)
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
*   **PDF Processing Service:** The service (`pdf_service/app.py`) is available as a Docker Compose service (`pdf_service`) with GPU support, or can run standalone at the URL in `.env` (`PDF_CLIENT_URL`, default port 8502). It uses PaddleOCR (GPU) for scanned PDFs and PyMuPDF for text PDFs. Optional env: `PDF_OCR_ENGINE` (paddle|none|text-only), `PDF_OCR_LANG`, `PDF_PAGE_DPI`.
*   **LLM Providers:** You will need API keys or access to local LLM services (Ollama) as configured in the `.env` file.
*   **File Storage:** The PDF service requires specific directories on your host machine for storing PDFs, Markdown, and Images. These paths are configured in the `.env` file and the `IMAGES_PATH` is mounted as a volume into the `backend` service container in `docker-compose.yml` so the backend can serve the images. **You must create these directories on your host machine and update the volume paths in the root `.env` and the `docker-compose.yml` backend service volume mount to match.**

### Configuration

1.  Copy the `.env.example` file to `.env` in the root directory.
2.  Populate the `.env` file with your specific configurations, including:
    *   `MONGO_URI` (should point to your host MongoDB, e.g., `mongodb://host.docker.internal:27017/`)
    *   `PDF_CLIENT_URL` (the URL where your standalone PDF service is running, e.g., `http://localhost:8502`)
    *   LLM API keys (`ANTHROPIC_API_KEY`, `DEEPSEEK_API_KEY`, `GEMINI_API_KEY`) or `OLLAMA_BASE_URL`
    *   Absolute paths for `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH` on your host machine.
    *   `APP_IMAGE_SECRET` (non-empty string in `.env`): used by the backend to sign URLs for embedded PDF images in markdown. Without it, `<img>` requests to `/api/books/images/app/...` cannot authenticate (browsers do not send the JWT on image loads).
    *   **Optional:** Formatting-specific LLM configuration (`FORMATTING_LLM_SERVICE`, `FORMATTING_LLM_MODEL`, etc.) for enhanced text formatting. If not set, the system will use the standard LLM service for formatting.

### Running the Application

1.  Ensure your MongoDB instance is running and accessible from `host.docker.internal:27017`.
2.  Ensure the file storage directories exist on your host (`PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH`) and that volume paths in `docker-compose.yml` match your `.env`.
3.  Build and run all services (including the PDF service) with Docker Compose:
    ```bash
    docker compose up --build
    ```
    Or use `bash start_services.sh`, which runs `docker compose up`. The **PDF processing service** is part of the compose stack and starts with the other services. Ensure `PDF_CLIENT_URL` in your `.env` points to where the backend can reach it (e.g. `http://localhost:8502` when the backend uses host networking and the PDF service port is published).
4.  Optionally, you can still run the PDF service **outside** Docker (e.g. in a Conda MinerU environment) and start only the other services: `docker compose up --build backend frontend image_server`. In that case, set `PDF_CLIENT_URL` to the URL of your standalone PDF service.
5.  For faster continuous development reloads, use `./reload_dev.sh` from the project root. It detects changed services and reloads only those (default `docker compose up -d --build --no-deps ...`), avoiding full `down/prune/rebuild` cycles.
5.  The frontend should be accessible at `http://localhost:${FRONTEND_PORT}` (default 3100).
    The backend API should be accessible at `http://localhost:${BACKEND_PORT}` (default 8000).

... (Add other setup instructions later)
