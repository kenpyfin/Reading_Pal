# Reading Pal

AI reading tools often flatten a long PDF or EPUB into a generic summary and lose the author’s thought process. Reading Pal is a lens-based reading roadmap that mentors you through the author’s ideas—speeding up reading with custom guides tailored to your angle while keeping the original text and figures side by side for one-tap passage jumps, notes, and Q&A.

You choose the angle. The guide stays with the author’s moves in that lens: why a stretch matters, the sequence of ideas, and what to carry forward. The book itself stays open beside the guide. A jump lands on the passage, where you can take a note or ask a question.

## Read with the book open

A long PDF or EPUB has an order. The author sets up a problem, changes the terms, shows a figure, and only then lands the claim. A generic summary lifts the claim out of that order. The figures go with it. You can recite the topic and still not know how the author thought.

Reading Pal does not retire the book. You pick an angle, and it builds a guide that walks the author’s moves in that lens. The original text stays open beside the guide. The guide is a roadmap. It is not a replacement for the pages.

### What a session feels like

You name the angle first. The guide comes back as a sequence of cards, one stretch of the book at a time. You read the card, then tap **View in original text**. On a phone, the same control is **Read this section**. That opens the passage in the book. You are on the page the card was talking about, not on a detached recap.

### The guide card

Each card opens with a short signpost: why this stretch is on the path. **Read along** lists the author’s moves in order, and you can step through them one line at a time. **Carry forward** is the line you keep when you leave the stretch. When the guide has a line from the passage, that quote sits under the card.

Two drawers stay closed until you open them. **Author Shortcut** is a shorter pass over the same stretch, and it is written when you generate it. **Outsider Guide** rewrites the stretch for a reader who does not already share the author’s vocabulary. Each card can take a question about that section.

### The book stays open

The book stays open beside the guide. Text and figures stay in the chapter. A jump lands on the passage, so a note, a bookmark, or a question has a place to attach. Pictures extracted from an EPUB remain in the flow of the chapter. When a card sends you to a figure, the figure is still there.

### Guides you can shape

One book holds up to five guides. Each guide keeps its own angle, so a second pass does not erase the first. You can start from a preset — Executive, Systems, First principles, or Quick — or write the angle in your own words. Depth is Compact, Standard, or Detailed. Emphasis is Balance, Craft, or Takeaways. Compact keeps the path short. Detailed stays with the smaller moves. Craft follows how the author builds the piece. Takeaways keeps what you should leave with. Balance holds those in one pass.

### Books you can bring

Bring a PDF, EPUB, MOBI or AZW3, DOCX, TXT, or HTML file. The document worker turns it into the text and images the reader uses. The guide is built from that book, in the angle you named.

Under that reading experience, the stack is a React frontend, a FastAPI backend, a FastAPI document-processing worker, and a FastAPI image server.

## System At A Glance

- `frontend/`: React 18 SPA (book list, book reader, notes, bookmarks, reading guide)
- `backend/`: FastAPI API for auth, books, notes, bookmarks, and LLM endpoints
- `pdf_service/`: FastAPI worker that converts supported book formats (PDF, EPUB, MOBI/AZW3, DOCX, TXT, HTML) to markdown/images and calls back to backend
- `image_server/`: FastAPI service for public image upload/serving and local app-image serving
- `nginx/`: Production proxy routing (`/api`, `/images/public`, `/images/upload`, `/images/app`)

Architecture and operations details live in:

- `docs/architecture.md`
- `docs/operations.md`
- `docs/knowledge_mapping.md` (Semantic mapping & filtering logic)

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

## Two checkouts

Public traffic stays on the production worktree (`reading_pal_6-prod`, branch `prod`, `./deploy.sh`). Day-to-day edits stay in this directory (`STACK_ROLE=dev`, `./reload_dev.sh`, frontend port 3200). The two stacks share the database and the book files. See `docs/operations.md`.

## Alternative Dev Flows

- Fast reload for changed services:

  ```bash
  ./redeploy_app.sh
  ```

  This detects changed services from your local edits and latest commit by default.

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

- `./redeploy_app.sh`: targeted redeploy for changed services (recommended for day-to-day fixes/features)
- `./reload_dev.sh`: rebuild/restart only affected services
- `./deploy.sh`: full clean rebuild/recreate workflow (volumes preserved unless `--purge-volumes`)

Read `docs/operations.md` before using `deploy.sh` in environments with persistent data expectations.
