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
  - `PDF_SERVICE_PORT` (default `8502`)
  - `PDF_SERVICE_RUNTIME` (`host` or `docker`; default `host` when `PDF_EXTRACTION_BACKEND=mineru`)
  - `MINERU_PYTHON` — host conda Python for `PDF_SERVICE_RUNTIME=host`
  - `BACKEND_CALLBACK_URL` — pdf_service callback target (host runtime: `http://127.0.0.1:${BACKEND_PORT}/api/books/callback`)
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
  - `PDF_OCR_DEVICE` (default `gpu:0`; auto `cpu` on Maxwell/Kepler when unset — see below)
  - `PDF_OCR_LANG`
  - `PDF_PAGE_DPI`
  - `PDF_FULL_PAGE_IMAGE_COVERAGE_THRESHOLD` (skip page-covering embedded scan backgrounds; default `0.85`)
  - `PDF_EXTRACTION_BACKEND` (`paddle` or `mineru`; default `paddle`) — full PDF parse path for scanned/image-heavy books. **MinerU is not in the default Docker image**; use host MinerU conda (`start_services.sh`) or extend the image with `mineru[pipeline]`.
  - `MINERU_MODELS_PATH` — host path to MinerU/PDF-Extract-Kit weights (mounted to `/app/models` in compose)
  - `MINERU_BACKEND` (default `pipeline`), `MINERU_PARSE_METHOD` (default `auto`)
  - `PDF_SCAN_FIGURE_ENGINE` (`layout`, `heuristic`, or `both`; default `layout`) — how to extract figures from flat scanned pages when using `paddle` backend
  - `PDF_LAYOUT_MODEL_NAME` (default `PP-DocLayout_plus-L`)
  - `PDF_LAYOUT_DEVICE` (default `gpu:0`; auto `cpu` on Maxwell/Kepler when unset)
  - `PDF_LAYOUT_FIGURE_SCORE_THRESHOLD` (default `0.45`)
  - `PDF_LAYOUT_MIN_FIGURE_AREA_RATIO` / `PDF_LAYOUT_MAX_FIGURE_AREA_RATIO` (defaults `0.01` / `0.85`)
  - `PDF_GEMINI_REFORMAT_TIMEOUT_MS` (per-chunk Gemini reformat HTTP timeout in ms; default `360000`)
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

## PDF service GPU notes

- Default Docker image uses **PaddlePaddle 3.0 cu118** (CUDA 11.8 libraries bundled in the wheel). This supports **Maxwell GPUs** (Tesla M40, compute 5.x). Do **not** switch the image to `cu126` on M40 — it segfaults in cuBLAS during layout/OCR inference.
- For GPU inference, set in `.env`:
  - `PDF_OCR_DEVICE=gpu:0`
  - `PDF_LAYOUT_DEVICE=gpu:0`
- If you install a CUDA 12 Paddle wheel manually, Maxwell GPUs fall back to CPU unless those device vars force `gpu:0` (not recommended on M40).
- **MinerU** is configured with `PDF_EXTRACTION_BACKEND=mineru`, not `PDF_SCAN_FIGURE_ENGINE`. The default Docker image does not include MinerU; use host conda (`start_services.sh`) or extend the image.

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

## `deploy.sh`

Full clean deploy:

- Reads `PDF_SERVICE_RUNTIME` from `.env` (`host` for MinerU conda, `docker` for Compose `pdf_service`).
- Default: `host` when `PDF_EXTRACTION_BACKEND=mineru`, otherwise `docker`.
- Host mode: builds/starts `backend`, `frontend`, `image_server` only; starts pdf worker via `scripts/pdf_service_host.sh`.
- Docker mode: includes `pdf_service` in Compose (Paddle cu118 GPU image).

```bash
./deploy.sh
```

## `scripts/pdf_service_host.sh`

Control host pdf_service (MinerU conda):

```bash
./scripts/pdf_service_host.sh start|stop|restart|status
```

Logs: `.run/pdf_service.log` · PID: `.run/pdf_service.pid`

## `start_services.sh` (legacy helper)

- Same runtime split as `deploy.sh`: host MinerU pdf_service + Compose for other services.
- Starts `pdf_service/app.py` with `MINERU_PYTHON` from `.env` when `PDF_SERVICE_RUNTIME=host`.
- Then runs `docker compose up`.
- Prefer standard Compose mode unless you specifically need that local interpreter setup.

## Operational Checks

Before running:

- Confirm MongoDB connectivity from container context.
- Confirm host storage directories exist and are writable.
- Confirm `APP_IMAGE_SECRET` is non-empty in non-dev environments.
- Confirm callback path and backend port alignment.

### Book upload and list behavior

- Output files are keyed by **`sanitized_title`** (e.g. `My_Book.md`), not `job_id`. The API returns **409** if the user already has a book with the same sanitized title in `pending`, `processing`, or `completed` (re-upload after delete is allowed; `failed` rows do not block).
- **Cancel** in the book list deletes the DB row and shared markdown/images for that title; pdf_service may still finish the job in the background.
- Stuck `processing` jobs are marked `failed` after `STUCK_JOB_THRESHOLD_SECONDS` (default 24h); old `pending`/`failed` rows are purged per `OLD_RECORD_THRESHOLD_SECONDS` (default 6h). See `backend/services/cleanup_service.py`.

After startup:

- Check backend health: `GET /health`
- Upload a sample supported book file (PDF/EPUB/DOCX/TXT/HTML) and verify callback-driven status transition to completed/failed.
- Verify app images load through backend image route, and public uploads load from `/images/public/...`.
