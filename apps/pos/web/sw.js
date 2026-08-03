// POS service worker — makes the lane's app shell load with no network (P-01,
// hard rule #1). It pre-caches the static shell on install and serves it
// cache-first, so a cashier can open and bill during an outage. It deliberately
// caches ONLY the shell: business data is not cached here — the sale path keeps its
// own local state and the sync outbox (packages/sync), which is the single place
// unsent work is tracked and made visible.

const CACHE = 'sre-pos-shell-v1';
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
  if (request.method !== 'GET') return; // never intercept writes
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached; // cache-first: the shell always opens offline
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
