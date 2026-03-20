# Repository Guidelines

## Development journal

- **`DEVELOPMENT_JOURNAL.md`** (repo root) records meaningful implementations and decisions. Read it when planning or changing features; append a dated entry after non-trivial work (see `.cursor/rules/development-journal.mdc`).

## Project Structure & Module Organization
- `backend/`: FastAPI API (`main.py`), routers in `api/`, persistence in `db/`, shared logic in `services/`, Pydantic models under `models/`.
- `frontend/`: React app (`src/components`, `src/pages`, `src/utils`) with static assets in `public/` and Docker build in `frontend/Dockerfile`.
- `pdf_service/`: Standalone FastAPI worker (`app.py`) for PDF-to-markdown: **PaddleOCR** (GPU) for scanned PDFs and **PyMuPDF** text extraction for digital PDFs. Produces files in `pdf_service/storage/{pdfs,images,output}`. Optional env: `PDF_OCR_ENGINE` (paddle|none|text-only), `PDF_OCR_LANG` (e.g. en), `PDF_PAGE_DPI`, `PDF_SERVICE_PORT` (default 8502).
- `image_server/`: Lightweight FastAPI server for generated images; mounts the same storage volume.
- Helper scripts (`start_services.sh`, `deploy.sh`) coordinate local orchestration and release tasks.

## Build, Test, and Development Commands
- `bash start_services.sh` – runs the PDF worker with the configured Conda interpreter and streams `docker compose up`.
- `docker-compose up --build backend frontend image_server` – rebuild containers when dependencies change.
- `pip install -r backend/requirements.txt && uvicorn backend.main:app --reload` – run the API locally without Docker.
- `npm install --prefix frontend && npm run start --prefix frontend` – launch the React dev server.
- `pip install -r pdf_service/requirements.txt && python pdf_service/app.py` – iterate on the PDF pipeline in isolation.

## Coding Style & Naming Conventions
- Python: 4-space indentation, snake_case functions, PascalCase Pydantic models; keep routers named after resources and stick to dependency-injected services described in `CONVENTIONS.md`.
- React: Functional components in PascalCase (`frontend/src/components`), hooks/utils in camelCase files, CSS colocated when useful.
- Prefer explicit imports, avoid magical helpers, and add brief comments only when behavior is surprising.

## Testing Guidelines
- Frontend: React Testing Library via `npm test --prefix frontend -- --watch=false`; name specs `Component.test.js` near implementation.
- Backend: Create `backend/tests/` suites with `pytest`, using `httpx.AsyncClient` for endpoint tests and fixture data for Mongo collections.
- Services: Validate PDF/image flows with smoke tests driven by sample assets in `pdf_service/storage`. Run the PDF pipeline smoke test: `python pdf_service/scripts/smoke_test_pdf_pipeline.py` (from project root; requires pdf_service deps and optional GPU for PaddleOCR).

## Environment & Configuration Tips
- Maintain a `.env` in the repo root defining `MONGO_URI`, `PDF_CLIENT_URL`, and storage paths consumed by Docker Compose. For the PDF service: `PDF_OCR_ENGINE` (default `paddle`), `PDF_OCR_LANG` (e.g. `en`), `PDF_PAGE_DPI` (default `200`); optional `PDF_SERVICE_PORT` (default `8502`) when running pdf_service in Docker Compose.
- For the whole-book Reading Guide roadmap: `GUIDE_LLM_SERVICE` (default `gemini`), `GUIDE_LLM_MODEL` (default `gemini-2.0-flash`), `GUIDE_LLM_GEMINI_API_KEY` (falls back to `GEMINI_API_KEY`). Uses a cheaper/faster model for roadmap generation.
- Ensure host directories for `PDF_STORAGE_PATH`, `MARKDOWN_PATH`, and `IMAGES_PATH` exist before starting containers; adjust when `host.docker.internal` is unavailable on Linux. The pdf_service container requires GPU access (NVIDIA) for PaddleOCR when processing scanned PDFs.

## Commit & Pull Request Guidelines
- Use conventional commits (`feat:`, `fix:`, `refactor:`, `chore:`) mirroring the existing history.
- Keep commits reviewable: code builds, formatters run, and relevant tests pass before pushing.
- PRs should summarize the change, link issues or plan docs, and attach UI evidence (screenshots/video) when React output shifts.
- Call out configuration changes (new env vars, volume paths) so reviewers can mirror the setup.
