/**
 * Replay IndexedDB outbox to the API (bookmarks, notes, roadmap progress).
 */

import {
  removeOutboxEntry,
  getAllOutboxEntries,
  isLocalId,
  putAnnotations,
  getAnnotations,
  removePendingCreateNote,
  removePendingCreateBookmark,
} from './offlineBookCache';

async function getAuthHeaders() {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('authToken') : null;
  if (!token) return null;
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

/**
 * Process outbox in order. Stops on first hard failure (non-local delete).
 * @returns {number} number of entries processed
 */
export async function flushOutbox() {
  const headers = await getAuthHeaders();
  if (!headers) return 0;

  const entries = await getAllOutboxEntries();
  let processed = 0;
  let failed = 0;

  for (const entry of entries) {
    const { id, type, bookId, payload } = entry;
    try {
      if (type === 'create_bookmark') {
        const { clientId, ...body } = payload;
        const res = await fetch('/api/bookmarks/', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const saved = await res.json();
        const ann = await getAnnotations(bookId);
        if (ann) {
          let replaced = false;
          const bookmarks = (ann.bookmarks || []).map((b) => {
            const bid = b.id || b._id;
            if (b._localClientId === clientId || bid === clientId) {
              replaced = true;
              return { ...saved, id: saved.id || saved._id };
            }
            return b;
          });
          if (!replaced) {
            bookmarks.push({ ...saved, id: saved.id || saved._id });
          }
          await putAnnotations(bookId, { bookmarks, notes: ann.notes || [] });
        }
        await removeOutboxEntry(id);
        processed += 1;
      } else if (type === 'delete_bookmark') {
        const { bookmarkId } = payload;
        if (isLocalId(bookmarkId)) {
          await removePendingCreateBookmark(bookmarkId);
          await removeOutboxEntry(id);
          processed += 1;
          continue;
        }
        const res = await fetch(`/api/bookmarks/${bookmarkId}`, {
          method: 'DELETE',
          headers,
        });
        if (!res.ok && res.status !== 404) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        await removeOutboxEntry(id);
        processed += 1;
      } else if (type === 'create_note') {
        const { clientId, ...body } = payload;
        const res = await fetch('/api/notes/', {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        const saved = await res.json();
        const ann = await getAnnotations(bookId);
        if (ann) {
          let replaced = false;
          const notes = (ann.notes || []).map((n) => {
            const nid = n.id || n._id;
            if (n._localClientId === clientId || nid === clientId) {
              replaced = true;
              return { ...saved, id: saved.id || saved._id };
            }
            return n;
          });
          if (!replaced) {
            notes.push({ ...saved, id: saved.id || saved._id });
          }
          await putAnnotations(bookId, { bookmarks: ann.bookmarks || [], notes });
        }
        await removeOutboxEntry(id);
        processed += 1;
      } else if (type === 'delete_note') {
        const { noteId } = payload;
        if (isLocalId(noteId)) {
          await removePendingCreateNote(noteId);
          await removeOutboxEntry(id);
          processed += 1;
          continue;
        }
        const res = await fetch(`/api/notes/${noteId}`, {
          method: 'DELETE',
          headers,
        });
        if (!res.ok && res.status !== 404) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        await removeOutboxEntry(id);
        processed += 1;
      } else if (type === 'roadmap_progress') {
        const { item_id, completed, guide_id: guideId } = payload;
        const guideSegment = guideId
          ? `/reading-guides/${encodeURIComponent(guideId)}`
          : '/reading-guide';
        const res = await fetch(`/api/books/${bookId}${guideSegment}/progress`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ item_id, completed }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.detail || `HTTP ${res.status}`);
        }
        await removeOutboxEntry(id);
        processed += 1;
      } else {
        await removeOutboxEntry(id);
        processed += 1;
      }
    } catch (e) {
      console.warn('[outboxSync] flush failed for entry', entry, e);
      failed += 1;
    }
  }

  if (failed > 0) {
    console.warn(`[outboxSync] flush completed with ${failed} failed entr${failed === 1 ? 'y' : 'ies'}`);
  }

  return processed;
}
