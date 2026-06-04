/**
 * IndexedDB cache for offline book reading: markdown, reading guide, image blobs,
 * annotations (bookmarks + notes), and outbox for sync.
 */

const DB_NAME = 'readingPalOffline';
const DB_VERSION = 2;

const STORE_META = 'meta';
const STORE_GUIDE = 'guide';
const STORE_BLOBS = 'blobs';
const STORE_ANNOTATIONS = 'annotations';
const STORE_OUTBOX = 'outbox';
const STORE_BOOK_LIST = 'bookListSnapshot';

const BOOK_LIST_SCOPE_DEFAULT = 'default';

let dbPromise = null;

function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(req.result);
      req.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_META)) {
          db.createObjectStore(STORE_META, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(STORE_GUIDE)) {
          db.createObjectStore(STORE_GUIDE, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS);
        }
        if (!db.objectStoreNames.contains(STORE_ANNOTATIONS)) {
          db.createObjectStore(STORE_ANNOTATIONS, { keyPath: 'bookId' });
        }
        if (!db.objectStoreNames.contains(STORE_OUTBOX)) {
          db.createObjectStore(STORE_OUTBOX, { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains(STORE_BOOK_LIST)) {
          db.createObjectStore(STORE_BOOK_LIST, { keyPath: 'scope' });
        }
      };
    });
  }
  return dbPromise;
}

export function graphBlobKey(bookId, cardId) {
  return `book:${bookId}:graph:${cardId}`;
}

export function mdImgBlobKey(bookId, pathKey) {
  return `book:${bookId}:mdimg:${pathKey}`;
}

/** Extract app image paths from markdown image syntax for caching keys. */
export function extractMarkdownImagePaths(markdown) {
  if (!markdown || typeof markdown !== 'string') return [];
  const paths = new Set();
  const re = /!\[[^\]]*\]\(([^)\s]+)/g;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const raw = m[1].replace(/^["']|["']$/g, '');
    const path = imageUrlToStablePath(raw);
    if (path) paths.add(path);
  }
  return [...paths];
}

/** Normalize URL to stable storage path under app images. */
export function imageUrlToStablePath(url) {
  if (!url || typeof url !== 'string') return null;
  try {
    const noQuery = url.split('?')[0];
    if (noQuery.includes('/api/books/images/app/')) {
      return noQuery.split('/api/books/images/app/')[1] || null;
    }
    if (noQuery.includes('/images/app/')) {
      return noQuery.split('/images/app/')[1] || null;
    }
  } catch (_e) {
    return null;
  }
  return null;
}

/**
 * Rewrite markdown: replace image URLs whose path we have cached with blob URLs.
 */
export async function rewriteMarkdownWithCachedImages(bookId, markdown, registerObjectUrl) {
  if (!markdown) return markdown;
  const db = await openDb();
  const re = /(!\[[^\]]*\]\()([^)\s]+)(\))/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = re.exec(markdown)) !== null) {
    out += markdown.slice(last, m.index);
    const urlPart = m[2].replace(/^["']|["']$/g, '');
    const path = imageUrlToStablePath(urlPart);
    if (path) {
      const key = mdImgBlobKey(bookId, path);
      const buf = await getBlobKey(db, key);
      if (buf) {
        const blob = new Blob([buf], { type: 'image/png' });
        const blobUrl = URL.createObjectURL(blob);
        if (registerObjectUrl) registerObjectUrl(blobUrl);
        out += m[1] + blobUrl + m[3];
        last = re.lastIndex;
        continue;
      }
    }
    out += m[0];
    last = re.lastIndex;
  }
  out += markdown.slice(last);
  return out;
}

function getBlobKey(db, key) {
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_BLOBS, 'readonly').objectStore(STORE_BLOBS).get(key);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export async function putBlob(key, arrayBuffer) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_BLOBS, 'readwrite').objectStore(STORE_BLOBS).put(arrayBuffer, key);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function fetchAndCacheUrlAsBlob(key, url) {
  if (!url) return;
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return;
    const ab = await res.arrayBuffer();
    await putBlob(key, ab);
  } catch (_e) {
    /* ignore */
  }
}

export async function prefetchMarkdownImages(bookId, markdown) {
  if (!markdown) return;
  const re = /!\[[^\]]*\]\(([^)\s]+)\)/g;
  const tasks = [];
  let m;
  while ((m = re.exec(markdown)) !== null) {
    const raw = m[1].replace(/^["']|["']$/g, '');
    const path = imageUrlToStablePath(raw);
    if (!path) continue;
    const fetchUrl = raw.startsWith('http') ? raw.split('?')[0] : raw.split('?')[0];
    const key = mdImgBlobKey(bookId, path);
    tasks.push(fetchAndCacheUrlAsBlob(key, fetchUrl));
  }
  await Promise.all(tasks);
}

export function walkRoadmapItems(items, fn) {
  for (const item of items || []) {
    fn(item);
    walkRoadmapItems(item.children, fn);
  }
}

export async function cacheRoadmapGraphImages(bookId, roadmap) {
  if (!roadmap?.items) return;
  const tasks = [];
  walkRoadmapItems(roadmap.items, (item) => {
    const url = item.graph_image_url;
    if (url && item.id) {
      const u = typeof url === 'string' ? url : '';
      if (u.startsWith('blob:')) return;
      tasks.push(
        fetchAndCacheUrlAsBlob(graphBlobKey(bookId, item.id), u.startsWith('/') ? u : `/${u.replace(/^\//, '')}`)
      );
    }
  });
  await Promise.all(tasks);
}

/**
 * Clone roadmap and set graph_image_url from cached blobs (object URLs).
 */
export async function hydrateRoadmapWithCachedGraphs(bookId, roadmap, registerObjectUrl) {
  if (!roadmap) return null;
  const clone = JSON.parse(JSON.stringify(roadmap));
  const db = await openDb();
  const walkAsync = async (items) => {
    for (const item of items || []) {
      if (item.id) {
        const key = graphBlobKey(bookId, item.id);
        const buf = await getBlobKey(db, key);
        if (buf) {
          const blob = new Blob([buf], { type: 'image/png' });
          const blobUrl = URL.createObjectURL(blob);
          if (registerObjectUrl) registerObjectUrl(blobUrl);
          item.graph_image_url = blobUrl;
        }
      }
      await walkAsync(item.children);
    }
  };
  await walkAsync(clone.items);
  return clone;
}

export async function putBookMeta(bookId, { bookData, markdownContent }) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const rec = {
      bookId,
      bookData,
      markdownContent,
      cachedAt: Date.now(),
    };
    const r = db.transaction(STORE_META, 'readwrite').objectStore(STORE_META).put(rec);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getBookMeta(bookId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).get(bookId);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

/** Last successful paginated book list from the API (for offline navigation back to BookList). */
export async function putBookListSnapshot({ books, totalBooks, currentPage }) {
  const db = await openDb();
  const rec = {
    scope: BOOK_LIST_SCOPE_DEFAULT,
    books: Array.isArray(books) ? books.map((b) => ({ ...b })) : [],
    totalBooks: typeof totalBooks === 'number' ? totalBooks : 0,
    currentPage: typeof currentPage === 'number' && currentPage > 0 ? currentPage : 1,
    cachedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_BOOK_LIST, 'readwrite').objectStore(STORE_BOOK_LIST).put(rec);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getBookListSnapshot() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_BOOK_LIST, 'readonly').objectStore(STORE_BOOK_LIST).get(BOOK_LIST_SCOPE_DEFAULT);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

/** Remove one book from the cached list snapshot (e.g. after cancel/delete). */
export async function removeBookFromListSnapshot(bookId) {
  const snap = await getBookListSnapshot();
  if (!snap?.books?.length) return;
  const idStr = String(bookId);
  const filtered = snap.books.filter((b) => b && String(b.id) !== idStr);
  if (filtered.length === snap.books.length) return;
  await putBookListSnapshot({
    books: filtered,
    totalBooks: Math.max(0, (snap.totalBooks || filtered.length) - 1),
    currentPage: snap.currentPage || 1,
  });
}

/**
 * Minimal list rows for books that have cached meta (e.g. opened in BookView) but may not appear in list snapshot.
 */
export async function getBookSummariesFromMeta() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_META, 'readonly').objectStore(STORE_META).getAll();
    r.onsuccess = () => {
      const rows = [];
      for (const rec of r.result || []) {
        if (!rec || !rec.bookId || !rec.bookData) continue;
        const bd = rec.bookData;
        const id = bd.id || bd._id || rec.bookId;
        rows.push({
          id: String(id),
          title: bd.title,
          original_filename: bd.original_filename,
          status: bd.status || 'completed',
          ...(bd.job_id ? { job_id: bd.job_id } : {}),
        });
      }
      resolve(rows);
    };
    r.onerror = () => reject(r.error);
  });
}

export function isRecoverableListFetchError(err) {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return true;
  if (!err) return false;
  if (err.name === 'TypeError') return true;
  const msg = err.message != null ? String(err.message) : '';
  return msg.includes('Failed to fetch');
}

export const DEFAULT_GUIDE_ID = 'default';
export const MAX_READING_GUIDES = 5;

function normalizeGuideRecord(rec) {
  if (!rec) return null;
  if (Array.isArray(rec.guides)) {
    return {
      ...rec,
      activeGuideId: rec.activeGuideId || rec.guides[0]?.guideId || DEFAULT_GUIDE_ID,
    };
  }
  if (rec.roadmap) {
    return {
      bookId: rec.bookId,
      activeGuideId: DEFAULT_GUIDE_ID,
      guides: [
        {
          guideId: DEFAULT_GUIDE_ID,
          name: 'Reading Roadmap',
          custom_requirements: null,
          roadmap: rec.roadmap,
          completedIds: rec.completedIds || [],
          progressTouchedAt: rec.progressTouchedAt || {},
        },
      ],
      cachedAt: rec.cachedAt,
    };
  }
  return rec;
}

export function getGuideEntry(cache, guideId) {
  const norm = normalizeGuideRecord(cache);
  if (!norm?.guides?.length) return null;
  const id = guideId || norm.activeGuideId || DEFAULT_GUIDE_ID;
  return norm.guides.find((g) => g.guideId === id) || norm.guides[0];
}

export async function putGuide(bookId, options = {}) {
  const {
    roadmap,
    completedIds,
    progressTouchedAt,
    activeGuideId,
    guides,
    guideId,
    guidesList,
  } = options;
  const db = await openDb();
  const previous = normalizeGuideRecord(await getGuide(bookId));
  const targetGuideId = guideId || activeGuideId || previous?.activeGuideId || DEFAULT_GUIDE_ID;

  let nextGuides = guides || previous?.guides || [];
  if (guidesList) {
    nextGuides = guidesList.map((summary) => {
      const existing = (previous?.guides || []).find((g) => g.guideId === summary.guide_id);
      return {
        guideId: summary.guide_id,
        name: summary.name,
        custom_requirements: summary.custom_requirements ?? null,
        roadmap: existing?.roadmap ?? null,
        completedIds: existing?.completedIds || [],
        progressTouchedAt: existing?.progressTouchedAt || {},
      };
    });
  } else if (roadmap !== undefined) {
    const cloneRoadmap = roadmap ? JSON.parse(JSON.stringify(roadmap)) : null;
    let found = false;
    nextGuides = nextGuides.map((g) => {
      if (g.guideId === targetGuideId) {
        found = true;
        return {
          ...g,
          roadmap: cloneRoadmap,
          completedIds: completedIds !== undefined ? completedIds : g.completedIds,
          progressTouchedAt: progressTouchedAt !== undefined ? progressTouchedAt : g.progressTouchedAt,
        };
      }
      return g;
    });
    if (!found) {
      nextGuides.push({
        guideId: targetGuideId,
        name: roadmap?.name || 'Reading Roadmap',
        custom_requirements: roadmap?.custom_requirements ?? null,
        roadmap: cloneRoadmap,
        completedIds: completedIds || [],
        progressTouchedAt: progressTouchedAt || {},
      });
    }
  } else if (completedIds !== undefined || progressTouchedAt !== undefined) {
    nextGuides = nextGuides.map((g) =>
      g.guideId === targetGuideId
        ? {
            ...g,
            completedIds: completedIds !== undefined ? completedIds : g.completedIds,
            progressTouchedAt: progressTouchedAt !== undefined ? progressTouchedAt : g.progressTouchedAt,
          }
        : g
    );
  }

  const rec = {
    bookId,
    activeGuideId: activeGuideId || previous?.activeGuideId || targetGuideId,
    guides: nextGuides,
    cachedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_GUIDE, 'readwrite').objectStore(STORE_GUIDE).put(rec);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getGuide(bookId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_GUIDE, 'readonly').objectStore(STORE_GUIDE).get(bookId);
    r.onsuccess = () => resolve(normalizeGuideRecord(r.result || null));
    r.onerror = () => reject(r.error);
  });
}

export async function putAnnotations(bookId, { bookmarks, notes }) {
  const db = await openDb();
  const rec = {
    bookId,
    bookmarks: bookmarks || [],
    notes: notes || [],
    cachedAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_ANNOTATIONS, 'readwrite').objectStore(STORE_ANNOTATIONS).put(rec);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getAnnotations(bookId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_ANNOTATIONS, 'readonly').objectStore(STORE_ANNOTATIONS).get(bookId);
    r.onsuccess = () => resolve(r.result || null);
    r.onerror = () => reject(r.error);
  });
}

export function newLocalId() {
  return `local-${crypto.randomUUID()}`;
}

export function isLocalId(id) {
  return typeof id === 'string' && id.startsWith('local-');
}

export async function addOutboxEntry({ type, bookId, payload }) {
  const db = await openDb();
  const id = crypto.randomUUID();
  const rec = {
    id,
    type,
    bookId,
    payload,
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_OUTBOX, 'readwrite').objectStore(STORE_OUTBOX).put(rec);
    r.onsuccess = () => resolve(id);
    r.onerror = () => reject(r.error);
  });
}

export async function getAllOutboxEntries() {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_OUTBOX, 'readonly').objectStore(STORE_OUTBOX).getAll();
    r.onsuccess = () => {
      const list = r.result || [];
      list.sort((a, b) => a.createdAt - b.createdAt);
      resolve(list);
    };
    r.onerror = () => reject(r.error);
  });
}

export async function removeOutboxEntry(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const r = db.transaction(STORE_OUTBOX, 'readwrite').objectStore(STORE_OUTBOX).delete(id);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function getOutboxCount() {
  const all = await getAllOutboxEntries();
  return all.length;
}

/** Cancel a pending create_note when the local note was deleted before sync. */
export async function removePendingCreateNote(clientId) {
  const all = await getAllOutboxEntries();
  for (const e of all) {
    if (e.type === 'create_note' && e.payload?.clientId === clientId) {
      await removeOutboxEntry(e.id);
    }
  }
}

/** Cancel a pending create_bookmark when the local bookmark was deleted before sync. */
export async function removePendingCreateBookmark(clientId) {
  const all = await getAllOutboxEntries();
  for (const e of all) {
    if (e.type === 'create_bookmark' && e.payload?.clientId === clientId) {
      await removeOutboxEntry(e.id);
    }
  }
}

export function isOfflineContext() {
  return typeof navigator !== 'undefined' && !navigator.onLine;
}
