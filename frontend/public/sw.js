/* eslint-disable no-restricted-globals */
const CACHE_NAME = 'reading-pal-shell-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch (_e) {
    return;
  }

  if (url.origin !== self.location.origin) return;

  const path = url.pathname;
  const cacheable =
    path.startsWith('/static/') ||
    path === '/' ||
    path === '/index.html' ||
    path === '/manifest.json' ||
    path.endsWith('favicon.ico') ||
    path.endsWith('/logo192.png');

  if (!cacheable) return;

  event.respondWith(
    caches.open(CACHE_NAME).then((cache) =>
      cache.match(request).then((cached) => {
        if (cached) return cached;
        return fetch(request).then((response) => {
          if (response && response.ok) {
            cache.put(request, response.clone());
          }
          return response;
        });
      })
    )
  );
});
