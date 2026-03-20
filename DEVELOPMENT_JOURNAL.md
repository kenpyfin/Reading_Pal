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
