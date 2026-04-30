# Reading Pal

Reading Pal is an ebook/document reading application with LLM-assisted study workflows.
The stack is split across multiple services: React frontend, FastAPI backend,
FastAPI document-processing worker, and FastAPI image server.

## System At A Glance

- `frontend/`: React 18 SPA (book list, book reader, notes, bookmarks, reading guide)
- `backend/`: FastAPI API for auth, books, notes, bookmarks, and LLM endpoints
- `pdf_service/`: FastAPI worker that converts supported book formats (PDF, EPUB, MOBI/AZW3, DOCX, TXT, HTML) to markdown/images and calls back to backend
- `image_server/`: FastAPI service for public image upload/serving and local app-image serving
- `nginx/`: Production proxy routing (`/api`, `/images/public`, `/images/upload`, `/images/app`)

Architecture and operations details live in:

- `docs/architecture.md`
- `docs/operations.md`

## Core Runtime Model

- Backend runs in Docker Compose with `network_mode: host` (no container port mapping).
- PDF service calls backend callback via `BACKEND_CALLBACK_URL`.
- Backend, PDF service, and image server share host-mounted storage paths.
- Browser image requests for app content flow through backend signed routes (`/api/books/images/app/...`).

## Prerequisites

- Docker + Docker Compose
- MongoDB reachable from containers (default pattern: `host.docker.internal`)
- Node.js/npm only if you run frontend outside Docker
- Python only if you run backend/pdf_service outside Docker
- NVIDIA runtime if you want PaddleOCR GPU acceleration in `pdf_service`

## Initial Setup

1. Copy `.env.example` to `.env`.
2. Fill required variables in `.env`:
   - `MONGO_URI`
   - `BACKEND_PORT`, `FRONTEND_PORT`, `IMAGE_SERVICE_PORT`, `PDF_SERVICE_PORT`
   - `PDF_CLIENT_URL`
   - `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, `IMAGES_PATH` (absolute host paths)
   - `APP_IMAGE_SECRET` (required for signed app-image URL access)
   - LLM credentials/settings used by backend/pdf service
3. Create host storage directories referenced above.

## Run With Docker Compose

```bash
docker compose up --build
```

Default endpoints:

- Frontend: `http://localhost:${FRONTEND_PORT}`
- Backend: `http://localhost:${BACKEND_PORT}`
- PDF service: `http://localhost:${PDF_SERVICE_PORT:-8502}`
- Image server: `http://localhost:${IMAGE_SERVICE_PORT}`

## Alternative Dev Flows

- Fast reload for changed services:

  ```bash
  ./reload_dev.sh
  ```

- Run PDF service standalone (outside Compose) and keep others in Compose:

  ```bash
  docker compose up --build backend frontend image_server
  ```

  Ensure `PDF_CLIENT_URL` points to that standalone process.

- Legacy helper:
  - `start_services.sh` starts a host Python pdf service from a hardcoded interpreter path, then `docker compose up`.
  - Prefer Compose-only flow unless you specifically need that environment.

## Notes On Versions

- Backend Dockerfile currently uses Python `3.10-slim` for Mongo driver compatibility.
- README/runtime guidance should be treated as authoritative over older comments in historical files.

## Useful Scripts

- `./reload_dev.sh`: rebuild/restart only affected services
- `./deploy.sh`: full clean rebuild/recreate workflow (destructive to compose volumes)

Read `docs/operations.md` before using `deploy.sh` in environments with persistent data expectations.
