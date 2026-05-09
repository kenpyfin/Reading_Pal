# Reading Pal Operations Guide

This guide documents how to run, reload, and deploy the current multi-service stack.

## Services

Defined in `docker-compose.yml`:

- `backend` (FastAPI, host network)
- `frontend` (React static build served in container)
- `pdf_service` (FastAPI worker for multi-format document conversion)
- `image_server` (FastAPI image upload/serving)

MongoDB is external to this compose file and must already be running and reachable by `MONGO_URI`.

## Environment Variables

Root `.env` is loaded by services. Important variables:

- Core
  - `MONGO_URI`
  - `BACKEND_PORT`
  - `FRONTEND_PORT`
  - `PDF_SERVICE_PORT`
  - `IMAGE_SERVICE_PORT`
- Service integration
  - `PDF_CLIENT_URL` (used by backend to reach pdf service)
  - `BACKEND_CALLBACK_URL` (set for pdf service in compose)
  - `APP_IMAGE_SECRET` (required for secure app-image URL signing)
- Storage paths (host absolute paths)
  - `PDF_STORAGE_PATH`
  - `MARKDOWN_PATH`
  - `IMAGES_PATH`
- PDF OCR/processing tuning
  - `PDF_OCR_ENGINE` (`paddle`, `none`, `text-only`)
  - `PDF_OCR_LANG`
  - `PDF_PAGE_DPI`
- Image upload security
  - `IMAGE_UPLOAD_API_KEY` (optional; enables upload auth when non-empty)

## Storage and Mounting Rules

- Host directories from `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, and `IMAGES_PATH` must exist before startup.
- Those directories are mounted into multiple services, but with different container paths:
  - Backend markdown path: `/app/storage/markdown`
  - PDF service markdown path: `/app/storage/output`
- Both container paths map to the same host `MARKDOWN_PATH`.

## Run Modes

## Standard mode (recommended)

Run all services together in Compose:

```bash
docker compose up --build
```

This includes `pdf_service` and avoids split-runtime drift.

## Split mode (standalone pdf service)

Run `pdf_service` outside Compose (for special environments) and run remaining services in Compose:

```bash
docker compose up --build backend frontend image_server
```

When using split mode:

- `PDF_CLIENT_URL` must point from backend runtime to the standalone PDF service.
- The standalone PDF service should write to the same host storage paths.

## Networking Notes

- Backend uses `network_mode: host`.
- Other services use bridged networking with published ports.
- Compose includes `extra_hosts: host.docker.internal:host-gateway` so containers can call host services.
- PDF callback URL in compose uses `host.docker.internal:${BACKEND_PORT}/api/books/callback`.

## Scripts

## `redeploy_app.sh`

Targeted redeploy for normal development iteration and post-pull refresh:

- Detects changed files from:
  - current git working tree
  - latest commit (`HEAD~1..HEAD`) by default
  - custom range via `--since-ref <ref> --until-ref <ref>`
- Maps changed paths to compose services
- Runs targeted `docker compose up -d --build --no-deps ...`

Useful options:

- `--service <name>` explicit service selection
- `--all` all services
- `--no-build` restart only
- `--with-deps` include dependencies
- `--no-last-commit` disable default `HEAD~1..HEAD` detection
- `--dry-run` show command only

## `reload_dev.sh`

Fast developer reload:

- Detects changed files from git status
- Maps changed files to services
- Runs targeted `docker compose up -d --build --no-deps ...`

Useful options:

- `--service <name>` explicit service selection
- `--all` all services
- `--no-build` restart only
- `--with-deps` include dependencies
- `--dry-run` show command only

## `deploy.sh`

Clean rebuild/recreate flow:

1. `docker compose down --remove-orphans` (or `--volumes` only when `--purge-volumes` is provided)
2. `docker system prune -af` (and `--volumes` only when `--purge-volumes`)
3. `docker builder prune -af`
4. `docker compose build --no-cache`
5. `docker compose up --force-recreate -d`

Caution: this is a heavy cleanup/rebuild flow and should not be used casually in data-sensitive environments. Only use `--purge-volumes` when explicit volume removal is intended.

## `start_services.sh` (legacy helper)

- Starts `pdf_service/app.py` with a hardcoded local Python interpreter path.
- Then runs `docker compose up`.
- Prefer standard Compose mode unless you specifically need that local interpreter setup.

## Operational Checks

Before running:

- Confirm MongoDB connectivity from container context.
- Confirm host storage directories exist and are writable.
- Confirm `APP_IMAGE_SECRET` is non-empty in non-dev environments.
- Confirm callback path and backend port alignment.

After startup:

- Check backend health: `GET /health`
- Upload a sample supported book file (PDF/EPUB/DOCX/TXT/HTML) and verify callback-driven status transition to completed/failed.
- Verify app images load through backend image route, and public uploads load from `/images/public/...`.
