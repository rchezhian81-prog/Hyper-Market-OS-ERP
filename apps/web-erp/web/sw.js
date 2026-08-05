// Store manager service worker — makes the back office open with no internet (§31). It pre-caches
// the static shell on install and serves it cache-first.
//
// **It caches the SHELL only, never the store's figures.** The manager's screen shows what it was
// last told, and a cached exception count served hours later as if it were current is the exact
// fault this product spends most of its effort refusing. When there is nothing fresh, the registers
// answer "not known" and the day cannot close — which is correct, and is what a manager should see.

const CACHE = 'sre-manager-shell-v1';
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
      if (cached) return cached; // cache-first: the shell always opens
      return fetch(request).catch(() => caches.match('./index.html'));
    }),
  );
});
