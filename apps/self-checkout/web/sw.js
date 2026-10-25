// Self-checkout lane service worker — the lane opens with the store computer's own page, and with no internet (§31).
//
// The lane talks only to its own store computer on this machine; this worker keeps the shell and the last page that
// store computer served, so a reload while the box restarts still shows the lane — and SAYS it is an old copy
// (`window.shellCachedAt`). The page is fetched from the network first every time: it carries the box's signed price
// list, and yesterday's prices must never be served as today's (P-08). A missing script is never answered with a page.

const CACHE = 'sre-self-checkout-shell-86045e372aba';

/** Committed files. A missing one is a packaging fault and should fail the install loudly. */
const SHELL = ['./sre-foundation.css', './sre-icons.js', './sre-update.js', './app.js', './manifest.webmanifest'];

/** Build artefacts. Added tolerantly: a missing build must not stop the rest of the shell being cached. */
const BUILT = ['./self-checkout.bundle.js'];

/** This screen's own page. */
const PAGE = './';

/** Put a copy in the cache, stamped with when it was taken. The response returned is untouched. */
async function cachePage(request, response) {
  if (!response.ok) return;
  const html = await response.clone().text();
  const stamp = `<script>window.shellCachedAt=${JSON.stringify(new Date().toISOString())};</script>`;
  const stamped = html.includes('</body>')
    ? html.replace('</body>', `${stamp}</body>`)
    : html + stamp;
  const cache = await caches.open(CACHE);
  await cache.put(request, new Response(stamped, {
    headers: { 'content-type': 'text/html; charset=utf-8' },
  }));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then(async (cache) => {
      await cache.addAll(SHELL);
      await Promise.allSettled(BUILT.map((url) => cache.add(url)));
      await fetch(PAGE).then((r) => cachePage(new Request(PAGE), r)).catch(() => undefined);
    }),
  );
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
  if (request.method !== 'GET') return; // never intercept writes

  if (request.mode === 'navigate') {
    // Network first: the payload in this page is the shop's price list.
    event.respondWith(
      fetch(request)
        .then((response) => {
          event.waitUntil(cachePage(request, response));
          return response;
        })
        .catch(async () => (await caches.match(request)) ?? (await caches.match(PAGE)) ?? Response.error()),
    );
    return;
  }

  event.respondWith(BUILT.some((p) => request.url.endsWith(p.slice(1))) ? networkFirst(request) : cacheFirst(request));
});

const cacheFirst = (request) => caches.match(request).then((cached) => cached ?? fetch(request).catch(() => Response.error()));
const networkFirst = (request) => fetch(request)
  .then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined); }
    return response;
  })
  .catch(async () => (await caches.match(request)) ?? Response.error());
