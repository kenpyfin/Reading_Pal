/**
 * IndexedDB cache for offline book reading: markdown, reading guide, image blobs,
 * annotations (bookmarks + notes), and outbox for sync.
 */

const DB_NAME = 'readingPalOffline';
const DB_VERSION = 1;

const STORE_META = 'meta';
const STORE_GUIDE = 'guide';
const STORE_BLOBS = 'blobs';
const STORE_ANNOTATIONS = 'annotations';
const STORE_OUTBOX = 'outbox';

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

export async function putGuide(bookId, { roadmap, completedIds }) {
  const db = await openDb();
  const rec = {
    bookId,
    roadmap: roadmap ? JSON.parse(JSON.stringify(roadmap)) : null,
    completedIds: completedIds || [],
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
    r.onsuccess = () => resolve(r.result || null);
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
