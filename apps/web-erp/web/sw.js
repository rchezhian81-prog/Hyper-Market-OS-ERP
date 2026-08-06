// Back-office service worker — makes the ERP open with no internet (§31). It pre-caches the static
// shells on install and serves them cache-first.
//
// **It caches the SHELL only, never the store's figures.** The manager's screen shows what it was
// last told, and a cached exception count served hours later as if it were current is the exact
// fault this product spends most of its effort refusing. When there is nothing fresh, the registers
// answer "not known" and the day cannot close — which is correct, and is what a manager should see.
//
// ── Two shells, and why the fallback has to know which ──────────────────────
//
// This folder serves two screens: the manager's `index.html` and the buyer's `buying.html`. They
// share one bundle and are different jobs for different people. A navigation that fell back to
// `index.html` regardless would hand a day close to somebody who opened the goods-in screen — the
// same confusion the store box's routing is built to avoid, reintroduced the moment the wifi drops
// at the loading bay, which is exactly where it is worst.
//
// ── Why the bundle is cached separately ─────────────────────────────────────
//
// `addAll` is all-or-nothing: one 404 and the service worker never installs at all. `web-erp.bundle.js`
// is a build artefact rather than a committed file, so it is added tolerantly. Without it in the
// cache these screens open offline with their SAMPLE stand-in — which says so on the page, loudly,
// but is not the shop's own data and is not what "works offline" is supposed to mean.

const CACHE = 'sre-erp-shell-v2';

/** Committed files. Missing one is a packaging fault and should fail the install. */
const SHELL = ['./index.html', './buying.html', './app.js', './buying.js', './manifest.webmanifest'];

/** Built files. Added tolerantly so a missing build cannot stop the shell caching at all. */
const BUILT = ['./web-erp.bundle.js'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      await Promise.allSettled(BUILT.map((url) => cache.add(url)));
    }),
  );
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

/** Which of the two shells a failed navigation belongs to. Never the other one. */
function shellFor(url) {
  return new URL(url).pathname.includes('buying') ? './buying.html' : './index.html';
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached; // cache-first: the shell always opens
      return fetch(request).catch(() => {
        // Only a page request falls back to a page. Returning HTML in place of a missing script
        // gives the browser a syntax error instead of a clean failure, and the screen then boots
        // into its sample stand-in for a reason nobody can see.
        if (request.mode !== 'navigate') return Response.error();
        return caches.match(shellFor(request.url));
      });
    }),
  );
});
