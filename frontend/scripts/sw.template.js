/* eslint-disable no-restricted-globals */
const CACHE_NAME = 'reading-pal-shell-__BUILD_ID__';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME && key.startsWith('reading-pal-shell-'))
            .map((key) => caches.delete(key))
        )
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

function isShellRequest(path) {
  return (
    path === '/' ||
    path === '/index.html' ||
    path === '/manifest.json' ||
    path.endsWith('favicon.ico') ||
    path.endsWith('/logo192.png')
  );
}

function isStaticAsset(path) {
  return path.startsWith('/static/');
}

function isSwRequest(path) {
  return path.endsWith('/sw.js');
}

async function networkFirst(cache, request) {
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch (_err) {
    const cached = await cache.match(request);
    if (cached) {
      return cached;
    }
    throw _err;
  }
}

async function cacheFirst(cache, request) {
  const cached = await cache.match(request);
  if (cached) {
    return cached;
  }
  const response = await fetch(request);
  if (response && response.ok) {
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }

  let url;
  try {
    url = new URL(request.url);
  } catch (_e) {
    return;
  }

  if (url.origin !== self.location.origin) {
    return;
  }

  const path = url.pathname;
  if (isSwRequest(path)) {
    return;
  }

  const shell = isShellRequest(path);
  const staticAsset = isStaticAsset(path);
  if (!shell && !staticAsset) {
    return;
  }

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) => {
      if (staticAsset) {
        return cacheFirst(cache, request);
      }
      return networkFirst(cache, request);
    })
  );
});
