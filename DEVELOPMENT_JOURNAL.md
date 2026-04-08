# Development journal

Chronological log of meaningful implementation work: decisions, behavior changes, and where to look in the codebase. Agents and humans should **read relevant sections before** planning or changing related code, and **append an entry after** non-trivial work.

## How to write an entry

Use a reverse-chronological list (newest first). Each entry should be short and include:

- **Date** (ISO: YYYY-MM-DD)
- **What** — feature, fix, or change
- **Why** — problem or goal (one or two sentences)
- **Where** — main paths, modules, or services touched
- **Notes** — env vars, migrations, follow-ups (optional)

### Template (copy below the line)

```
## YYYY-MM-DD — Short title

- **What:** …
- **Why:** …
- **Where:** `path/or/module` …
- **Notes:** … (optional)
```

---

## Entries

<!-- New entries go below this comment, newest first. -->

## 2026-03-25 — Cross-route offline: book list + upload

- **What:** IndexedDB (`readingPalOffline` v2) gains `bookListSnapshot` for the last successful paginated `/api/books/` response; `getBookSummariesFromMeta()` lists books with cached `meta`. BookList persists on success, rehydrates from snapshot plus meta on network/offline failure, shows a banner, and disables rename/delete/pagination while offline or when showing cache. PdfUploadForm listens for `online`/`offline`, disables inputs and blocks upload without a connection.
- **Why:** Navigating BookView → book list remounted BookList and cleared state; offline fetch left an empty list and a full-page error. Upload offline was confusing without gating.
- **Where:** `frontend/src/utils/offlineBookCache.js`, `frontend/src/pages/BookList.js`, `frontend/src/components/PdfUploadForm.js`
- **Notes:** Existing users get DB upgrade on next open (v1→v2). Pagination while offline is intentionally disabled; coming back online refetches via the `online` event.

## 2026-03-23 — Backend Python corrected to 3.10 for Motor 2.x

- **What:** Corrected backend base image from Python 3.11 to Python 3.10 while keeping `motor<3.0`.
- **Why:** Container crash showed `ImportError: cannot import name 'coroutine' from 'asyncio'` from Motor 2.x on Python 3.11. Python 3.10 is required for this driver line with the current MongoDB 3.6 server.
- **Where:** `backend/Dockerfile`
- **Notes:** Rebuild backend image to apply (`docker compose build --no-cache backend && docker compose up -d backend`).

## 2026-03-23 — Backend Mongo compatibility rollback (restore login)

- **What:** Rolled backend runtime from `python:3.12-slim` to `python:3.11-slim` and reverted Mongo driver to `motor<3.0` to keep compatibility with a MongoDB server exposing wire version 6.
- **Why:** Backend was starting without a usable DB handle (`MongoDB connection failed: ... requires at least wire version 8`), causing Google OAuth callback user upsert to fail with `Could not create or update user.`.
- **Where:** `backend/Dockerfile`, `backend/requirements.txt`
- **Notes:** Rebuild and restart backend after pulling (`docker compose build backend && docker compose up -d backend`). Longer term: upgrade MongoDB to 4.2+ to move back to newer Motor/PyMongo.

## 2026-03-23 — Google login hardening after local-storage rollout

- **What:** Hardened Google OAuth user persistence to normalize/lowercase emails, match existing users case-insensitively by email before insert, and recover from duplicate-key races by refetching and updating existing user records. Updated Mongo startup health check to use `ping` instead of `ismaster`, and added `dnspython` dependency for `mongodb+srv://` URIs.
- **Why:** Production Google callback started returning `500 {"detail":"Could not create or update user."}` after recent deployment; this path was vulnerable to DB connection/URI resolver issues and duplicate/case mismatch user conflicts during create-or-link.
- **Where:** `backend/db/mongodb.py`, `backend/requirements.txt`
- **Notes:** Rebuild/redeploy backend so new dependencies are installed. If issue persists, inspect backend logs for Mongo connection errors or duplicate key details during `/api/auth/auth/google/callback`.

## 2026-03-22 — Backend: Motor upgraded for Python 3.12

- **What:** Updated backend MongoDB async driver dependency from `motor<3.0` to `motor>=3.5,<4`.
- **Why:** Backend container now runs Python 3.12; old Motor versions import `asyncio.coroutine` and crash at startup on 3.12.
- **Where:** `backend/requirements.txt`
- **Notes:** Rebuild backend image after pulling this change so the new dependency is installed (`docker compose build backend && docker compose up backend`).

## 2026-03-20 — Offline book cache, annotations outbox, service worker

- **What:** IndexedDB (`readingPalOffline`) stores per-book markdown, reading guide + progress, graph PNG blobs, markdown image blobs, and a merged bookmarks/notes mirror. Failed network loads fall back to cache; signed image URLs are prefetched into blobs. Outbox replays `create/delete` bookmark & note, and roadmap progress, when the browser goes online. Production-only `public/sw.js` caches same-origin shell assets (`/static/*`, `/`, manifest, favicon). UI banner when offline; reformat / roadmap / graph generation disabled offline; Ask LLM disabled in `NotePane` offline; plain notes still save locally and sync later.
- **Why:** Reading guides and graphs use short-lived signed URLs; users need cached text, guide, and figures plus working bookmarks/notes/jumps without the API, then sync when back online.
- **Where:** `frontend/src/utils/offlineBookCache.js`, `frontend/src/utils/outboxSync.js`, `frontend/src/pages/BookView.js`, `frontend/src/components/NotePane.js`, `frontend/src/components/ReadingGuidePane.js`, `frontend/public/sw.js`, `frontend/src/index.js`.
- **Notes:** First offline visit with empty HTTP cache still needs one prior online load for the bundle. JWT remains in `localStorage`; login still requires network.

## 2026-03-20 — Backend: Python 3.12 + google-genai SDK

- **What:** Backend Docker image uses Python 3.12. Replaced deprecated `google-generativeai` with the GA **`google-genai`** SDK (`from google import genai`, `client.aio.models.generate_content` for async). PDF service requirements/Dockerfile updated the same way; `reformat_markdown_with_gemini` uses `genai.Client` + `models.generate_content`.
- **Why:** Eliminate startup `FutureWarning`s from EOL Python 3.9 and end-of-life `google.generativeai` package.
- **Where:** `backend/Dockerfile`, `backend/requirements.txt`, `backend/services/llm_service.py`; `pdf_service/requirements.txt`, `pdf_service/Dockerfile`, `pdf_service/app.py`.
- **Notes:** Guide/whole-book JSON paths use `types.GenerateContentConfig(system_instruction=..., max_output_tokens=...)`. Fixed misplaced `else` that logged “unknown LLM_SERVICE” when the guide LLM was not Gemini.

## 2026-03-20 — Notes: allow empty body

- **What:** Saving a note no longer requires non-empty text; whitespace-only input is stored as an empty string.
- **Why:** Users wanted to add a placeholder or location-only note without typing body text.
- **Where:** `frontend/src/components/NotePane.js`

## 2026-03-20 — BookView: shorter virtual pages

- **What:** Reduced `APPROX_CHARS_PER_PAGE` from 25000 to 8000 so each in-book page shows less markdown and total page count increases (same splitting logic in `calculatePageBoundaries`). Kept book list at 10 books per page. Synced `APPROX_CHARS_PER_PAGE_FOR_GUIDE` in the backend so reading-guide page boundaries match the UI.
- **Why:** Reading view felt like too much content per page; book list pagination stays at 10 books per page.
- **Where:** `frontend/src/pages/BookView.js`, `backend/api/books.py`

## 2026-03-20 — Book list total count (X-Total-Count)

- **What:** `GET /api/books/` now honors `skip`/`limit`, counts matching documents, and sets `X-Total-Count`. Added `count_books()` in MongoDB layer. CORS exposes `X-Total-Count` for cross-origin clients.
- **Why:** The book list UI read `X-Total-Count` and showed “Total: 0 books” because the backend never sent the header; pagination query params were ignored.
- **Where:** `backend/db/mongodb.py`, `backend/api/books.py` (`list_books`), `backend/main.py` (CORS `expose_headers`).
- **Notes:** Default `limit` remains 100 when query params are omitted (backward compatible).
