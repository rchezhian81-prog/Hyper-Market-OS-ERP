// Service worker — the shell opens with no signal (§31).
//
// It caches the SHELL only, never the assigned work. The wave and the route are whatever the
// device was last given, and the queue of what has been done lives in the device's own storage
// where the app can reason about it — a cached copy of yesterday's assigned work served as if it
// were today's is the fault this product spends most of its effort refusing.

const CACHE = 'sre-handheld-shell-v1';
const SHELL = ['./index.html', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached; // cache-first: the handheld always opens
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
