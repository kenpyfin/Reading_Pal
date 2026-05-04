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

## 2026-05-04 — Explicit pagination now always resets to page start

- **What:** Hardened explicit pagination in Book View to clear stale initial-scroll restore state and force top-of-page landing for target pages in both Original and Guide modes, while zeroing per-page cached scroll for the target page.
- **Why:** `Previous`/`Next` and direct page jumps could still reopen the destination page at an old offset due to competing restore state, so readers did not reliably land at the beginning of the new page.
- **Where:** `frontend/src/pages/BookView.js`

## 2026-05-04 — Deploy volume purge changed to opt-in

- **What:** Made `deploy.sh` preserve Docker volumes by default, and added `--purge-volumes` to explicitly enable destructive volume removal. The script now uses non-volume `docker compose down` and `docker system prune` unless this flag is provided.
- **Why:** Default-safe deploy behavior avoids accidental data loss for useful stopped-container or named-volume data while still allowing full cleanup on demand.
- **Where:** `deploy.sh`

## 2026-05-04 — Deploy script now purges unused Docker storage

- **What:** Expanded `deploy.sh` cleanup to run a full unused Docker storage purge (`docker system prune -af --volumes`) plus builder cache prune before the no-cache rebuild.
- **Why:** The prior script only cleared builder cache, which could still leave stale unused containers/images/networks/volumes consuming space and occasionally interfering with clean deploy expectations.
- **Where:** `deploy.sh`

## 2026-05-01 — Roadmap card reference excerpt with leading context

- **What:** Reference preview (`preview_text`) now prepends up to ~140 characters of segment text immediately before the first meaningful sentence (trimmed at a prior sentence boundary when possible), optionally followed by short continuation; the card blockquote shows `preview_text` when present. `key_quote` remains sentence-only so “View in original text” highlighting still anchors on that sentence first.
- **Why:** Showing only the headline sentence felt abrupt; readers expect a brief lead-in from the passage before the anchor sentence on the roadmap card.
- **Where:** `backend/services/llm_service.py`, `frontend/src/components/ReadingGuidePane.js`

## 2026-05-01 — Next/Prev top scroll after guide jump (stale highlight scroll)

- **What:** Added `bookPaneScrollEpochRef` bumped on explicit pagination so delayed guide-highlight `scrollIntoView` timeouts cannot run after page changes; switched highlight scroll to `behavior: 'auto'`; sync `bookScrollPositionByPage` to `0` on explicit pagination and re-apply top via nested `requestAnimationFrame`. Explicit-pagination top scroll now runs even when `viewMode` is still `guide` (same scroll container).
- **Why:** Guide search used a 200ms timeout and smooth scrolling; explicit pagination cleared guards synchronously, so a stale timeout could move the pane after `scrollTop = 0`, making Next/Prev appear broken after jumping from the roadmap.
- **Where:** `frontend/src/pages/BookView.js`

## 2026-05-01 — PDF service image now bundles parser package

- **What:** Updated the `pdf_service` Docker image build to copy the `parsers/` package into `/app` so `app.py` can import `parsers.document_parsers` at startup.
- **Why:** The container was starting with `ModuleNotFoundError: No module named 'parsers'`, which kept `pdf_service` down and caused backend uploads to fail with 503/connection-refused errors.
- **Where:** `pdf_service/Dockerfile`

## 2026-05-01 — Roadmap cutoff marker and deterministic reference sentence

- **What:** Made roadmap card reference text deterministic by extracting the first meaningful sentence from each segment source excerpt, and used that sentence as the card quote/reference baseline. Added a visible inline cutoff marker in Original Text mode at the roadmap segment `end_offset` when navigating from `View in original text`.
- **Why:** Users needed a reliable, source-grounded reference sentence on every card and a clear visual indicator in-book showing where each roadmap segment ends.
- **Where:** `backend/services/llm_service.py`, `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`

## 2026-05-01 — Explicit pagination top-scroll restored after guide jumps

- **What:** Hardened explicit pagination (`Previous`/`Next`/page input) to always force original-pane top scroll on target-page render by resetting stale top-scroll page markers at pagination start and removing an over-strict `pageActuallyChanged` gate on explicit-pagination landing.
- **Why:** After navigating from Reading Guide into Original text, stale page-tracking state could prevent explicit pagination from re-applying the expected top-of-page landing behavior.
- **Where:** `frontend/src/pages/BookView.js`

## 2026-05-01 — Added bulk Author Shortcut generation button

- **What:** Added a `Generate All Shortcuts` action in the roadmap panel that iterates all roadmap cards and triggers Author Shortcut generation sequentially. Shared the single-card update path so word counts and shortcut text are persisted in roadmap state/cached guide consistently; disabled per-card shortcut buttons while bulk generation is running.
- **Why:** Generating shortcuts one card at a time is slow and repetitive for large roadmaps; bulk generation makes the workflow practical for full-book coverage.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/components/ReadingGuidePane.js`, `frontend/src/components/ReadingGuidePane.css`

## 2026-04-30 — Author Shortcut panel shows source/output word counts

- **What:** Added `alternative_source_word_count` and `alternative_word_count` to roadmap items, computed and returned these counts from the Author Shortcut generation endpoint, and surfaced them in the expanded Author Shortcut details UI.
- **Why:** Readers need quick visibility into how compressed the generated shortcut is relative to its reference text.
- **Where:** `backend/api/books.py`, `backend/models/reading_guide.py`, `frontend/src/pages/BookView.js`, `frontend/src/components/ReadingGuidePane.js`, `frontend/src/components/ReadingGuidePane.css`

## 2026-04-30 — Author Shortcut now uses full source passage

- **What:** Removed the 6000-character cap in Author Shortcut generation so the LLM receives the full selected source passage from the roadmap card offsets.
- **Why:** Truncation could exclude later context from long sections and made shortcut generation depend only on the first part of the source.
- **Where:** `backend/services/llm_service.py`

## 2026-04-29 — Multi-format ebook ingestion in document worker

- **What:** Extended the `pdf_service` worker to ingest common ebook/document formats (`pdf`, `epub`, `mobi`, `azw`, `azw3`, `docx`, `txt`, `html`) using format routing plus parser helpers, with strict-fail behavior for unsupported/failed extraction and unchanged callback contract. Added parser dependencies and Calibre runtime support for MOBI/AZW conversion, widened backend/frontend upload validation and file picker support, and refreshed architecture/operations/readme guidance plus smoke coverage for non-PDF formats.
- **Why:** Upload flow was effectively PDF-only; users needed first-class ebook ingestion without fallback ambiguity and with explicit failure when extraction cannot be trusted.
- **Where:** `pdf_service/app.py`, `pdf_service/parsers/document_parsers.py`, `pdf_service/requirements.txt`, `pdf_service/Dockerfile`, `pdf_service/scripts/smoke_test_pdf_pipeline.py`, `backend/services/pdf_client.py`, `backend/api/books.py`, `frontend/src/components/PdfUploadForm.js`, `frontend/src/components/NavBar.js`, `frontend/src/pages/BookList.js`, `frontend/src/pages/BookView.js`, `README.md`, `docs/architecture.md`, `docs/operations.md`, `AGENTS.md`

## 2026-04-28 — Architecture and operations documentation refresh with targeted backend cleanup

- **What:** Rewrote the root `README.md` to reflect the current multi-service stack and added `docs/architecture.md` and `docs/operations.md` covering service boundaries, request/data flow, run modes, env vars, and deployment caveats. Added `.cursor/rules/docs-architecture-ops-sync.mdc` so future architecture/ops changes require matching doc updates. Applied quick readability/efficiency fixes by removing verbose auth-header logging in the books auth dependency, routing PDF upload calls through the shared `backend/services/pdf_client.py` helper, aligning `backend/api/llm.py` markdown path with env configuration, and removing a duplicate `get_client_ip` definition in `image_server/app.py`.
- **Why:** Current documentation had drifted from implemented behavior (networking, service roles, runtime paths), and several low-risk code cleanup opportunities were adding noise and maintenance overhead.
- **Where:** `README.md`, `docs/architecture.md`, `docs/operations.md`, `.cursor/rules/docs-architecture-ops-sync.mdc`, `backend/api/books.py`, `backend/api/llm.py`, `backend/main.py`, `image_server/app.py`

## 2026-04-28 — Paging top-scroll stabilized and offline expectations clarified

- **What:** Added explicit pagination intent handling in Book View so `Previous`/`Next` and direct page jumps clear guide-jump transient scroll state and force deterministic top-of-page landing after page commit. Also gated guide-highlight auto-scroll and guide->original restore interactions so they no longer override explicit pagination. Hardened outbox replay to continue processing after per-entry failures and aligned queued note-create headers with authenticated requests. Added offline behavior notes to README and clearer Book View messaging when no cached copy exists.
- **Why:** Page flips could land away from top due to effect races with guide-highlight/pending-scroll state, and offline behavior appeared unreliable because fallback/sync limits were not clearly surfaced.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/utils/outboxSync.js`, `README.md`

## 2026-04-28 — Medium-width toolbar overlap prevented with row reflow

- **What:** Added a medium breakpoint for the floating book toolbar header that changes layout from 3 columns to a 2-row grid (`left/right` controls on the first row, pagination on the second), and allows controlled wrapping in pagination/font controls.
- **Why:** At medium widths, toolbar sections were competing for horizontal space and visually overlapping; row reflow preserves all controls without collisions.
- **Where:** `frontend/src/pages/BookView.css`

## 2026-04-28 — Author Shortcut length target set to 30%

- **What:** Updated Author Shortcut generation guidance to target approximately 30% of the source passage length, including dynamic source and target word-count hints in the LLM prompt.
- **Why:** Shortcut output needed a more consistent compression ratio so each rewrite is clearly shorter while still retaining core claims and tone.
- **Where:** `backend/services/llm_service.py`

## 2026-04-26 — Note highlight replay anchored with generous fallback

- **What:** Improved Book View note highlight replay by resolving note ranges via anchor-window text matching (`source_text` near `global_character_offset`) with exact then whitespace-normalized matching, plus a bounded generous fallback range when exact mapping fails. Also aligned selection offset capture to the latest page boundaries via a ref to reduce stale offset fallback and softened `.note-highlight` box model so visual bars better match text spans.
- **Why:** Persisted note highlights could appear shifted after select -> add note because selection offsets are computed from rendered DOM text while replay ranges were previously reconstructed with a raw `start + length` assumption.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`

## 2026-04-26 — Floating toolbar reorganized with single view-mode switch

- **What:** Reorganized the floating book toolbar into a three-zone layout: left (`Menu`, single Guide/Original switch, `Add Bookmark`, `Add note`), center (pagination), and right (font size/line-height controls). Replaced the dual view-mode buttons with one switch-style toggle and moved `Add Bookmark`/`Add note` out of the dropdown into visible toolbar buttons.
- **Why:** The prior layout felt crowded and inconsistent with the requested control grouping; a single mode switch reduces button count and makes mode state clearer.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`

## 2026-04-26 — Pagination buttons now land at page top

- **What:** Updated Book View pagination so clicking `Previous` or `Next` always lands at the top of the destination page, even if that page had a previously cached scroll offset.
- **Why:** The per-page scroll-restore effect was reapplying old offsets after page changes, which made button navigation feel inconsistent.
- **Where:** `frontend/src/pages/BookView.js`

## 2026-04-24 — Book toolbar decoupled as floating arrow-origin panel

- **What:** Reworked the book controls toolbar into a `createPortal` fixed overlay so it is no longer part of the in-flow book pane header, and kept it floating in both expanded and retracted states. The retract/expand interaction is now a single right-edge arrow button with an animated panel that expands and collapses from the arrow outward right-to-left.
- **Why:** The prior implementation still behaved like a header-associated control block and used a separate collapsed callout; the requested UX is a consistently floating control with a unified arrow-driven reveal animation.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`

## 2026-04-23 — PDF pipeline formatting/image reliability hardening

- **What:** Aligned PDF service callback payload with backend expectations by including `images` metadata; added backend fallback extraction of image filenames from markdown for legacy callbacks; fixed page merge separator handling to rejoin with canonical `---`; switched markdown image injection to stable `/images/app/<filename>` links; hardened temp upload naming with job-scoped filenames; parameterized compose callback URL with `BACKEND_PORT`; expanded smoke checks for image-link and separator invariants; and made PaddleOCR import optional at startup so text/image flows do not crash when OCR deps are absent.
- **Why:** PDF jobs could complete with poor markdown segmentation and missing image metadata/links due to callback and separator issues, while environment-specific OCR imports could fail the whole worker even for non-OCR paths.
- **Where:** `pdf_service/app.py`, `backend/api/books.py`, `pdf_service/scripts/smoke_test_pdf_pipeline.py`, `docker-compose.yml`

## 2026-04-23 — Book View Menu dropdown as fixed overlay

- **What:** Render the Book View “Menu” dropdown with `createPortal` to `document.body`, position it with `position: fixed` from the menu button’s `getBoundingClientRect()`, and refresh on window resize, capture-phase scroll, and book pane frame updates. Click-outside now treats the portaled menu as inside the control.
- **Why:** The in-flow `position: absolute` panel expanded layout and pushed content; overlaying avoids reflow and matches floating-toolbar UX.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`

## 2026-04-22 — Alternative Reading reframed as Author Shortcut

- **What:** Updated the roadmap rewrite prompt to generate a concise passage in the original author's perspective (not editor voice), and renamed visible UI copy from `Alternative Reading` to `Author Shortcut` in the card button/section title and offline error message.
- **Why:** The intended experience is shortcut reading that still feels like the author speaking, rather than edited commentary.
- **Where:** `backend/services/llm_service.py`, `frontend/src/components/ReadingGuidePane.js`, `frontend/src/pages/BookView.js`

## 2026-04-22 — Fast targeted reload script for continuous dev

- **What:** Added `reload_dev.sh`, a lightweight reload helper that targets only affected Docker services instead of full teardown/prune rebuilds. It supports auto-detection from `git status`, explicit `--service` selection, `--all`, `--no-build`, `--with-deps`, and `--dry-run`.
- **Why:** Existing refresh/deploy flow is optimized for clean deployments, but too slow during active iteration because it performs `docker compose down` and image pruning before rebuilding everything.
- **Where:** `reload_dev.sh`, `README.md`
- **Notes:** Default path reloads `backend` + `frontend` when no mapped changes are found.

## 2026-04-22 — Roadmap card Alternative Reading generation

- **What:** Replaced roadmap card `Thought process` display with an `Alternative Reading` section and added an on-demand `Alternative Reading` button per card. Added backend endpoint `POST /api/books/{book_id}/reading-guide/cards/{card_id}/alternative-reading` that reads the card source excerpt, asks the guide LLM for a shorter author-style rewrite, persists it to the roadmap item, and returns it to the UI.
- **Why:** Readers need a faster, easier-to-consume version of referenced content while keeping the original idea and tone. On-demand generation avoids extra roadmap-generation cost and only runs when requested.
- **Where:** `backend/api/books.py`, `backend/services/llm_service.py`, `backend/models/reading_guide.py`, `frontend/src/pages/BookView.js`, `frontend/src/components/ReadingGuidePane.js`, `frontend/src/components/ReadingGuidePane.css`
- **Notes:** `alternative_reading` is optional and backward-compatible for existing guides.

## 2026-04-21 — BookView toolbar retract/expand and guide return-to-card

- **What:** Book pane controls use a sticky wrapper with a **▼ / ▲ toggle** that hides/shows the **entire toolbar** (not a compact subset), with optional **sessionStorage** persistence. When hidden, a fixed **Show bar** callout remains available so users can restore the toolbar from anywhere while scrolling. The toolbar lives **inside** `.book-pane-container` so `position: sticky` pins it while the book body scrolls; content sits in `.book-pane-body` with padding. Reading Guide **View in original text** now sends `sourceItemId`; returning via **Back to Reading Guide** expands roadmap ancestors as needed, scrolls the source card into view, then clears the focus id. Roadmap cards expose `data-roadmap-item-id` for targeting.
- **Why:** Narrow headers wrapped messily; users wanted the same retract/expand everywhere. Scroll-only restore did not reliably return to nested cards after remount.
- **Where:** `frontend/src/pages/BookView.js`, `frontend/src/pages/BookView.css`, `frontend/src/components/ReadingGuidePane.js`
- **Notes:** Guide vertical scroll restore still applies only when saved `scrollTop > 0` (unchanged from prior behavior).

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
