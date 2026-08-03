// Owner app service worker — makes the brief open with no signal (§31). It
// pre-caches the static shell on install and serves it cache-first, so the owner can
// open the app anywhere and still see the LAST-SYNCED numbers, clearly labelled as
// such by the freshness indicator. It caches only the shell: the brief's data is
// whatever the phone last received, and is never presented as live when it isn't.

const CACHE = 'sre-owner-shell-v1';
const SHELL = ['./index.html', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // Drop superseded shell caches so a new version takes effect cleanly.
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
      if (cached) return cached; // cache-first: the brief always opens
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
