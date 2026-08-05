// Customer app service worker — the shell opens on a slow or absent connection (§31 customer row).
//
// It caches the SHELL only. **Prices are never served from a cache as if they were current**: the
// catalogue arrives with a pack version, the basket review is tied to that version, and paying
// against an older one is refused by the model rather than quietly repriced. A cached price shown
// as today's price is a customer charged a figure they never saw (P-02).
//
// Ordering and payment need the network and say so. The basket does not — it lives in the
// device's own storage, which is why a dropped signal on a bus is a nuisance and not a lost
// afternoon.

const CACHE = 'sre-shop-shell-v1';
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
      if (cached) return cached; // cache-first: the shop always opens
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
