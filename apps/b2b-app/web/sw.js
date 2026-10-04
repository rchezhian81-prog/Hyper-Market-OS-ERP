// Business-customer portal service worker — the portal opens on a slow or absent connection (§31), and says so.
//
// **The figures are never served from a cache as if they were current.** A customer's balance, invoices,
// statement and documents are read LIVE; a cached balance shown as today's is exactly the fault the rest of this
// codebase refuses (P-08). The page is fetched fresh whenever there is a connection, and a cached one says when
// it was taken (`window.shellCachedAt` → the stale strip). Static files (the view, the bundle, the manifest)
// change only on a deploy, so those stay cache-first and load instantly. A missing script is never answered with
// a page (that would boot the sample stand-in for a reason nobody can see).

const CACHE = 'sre-b2b-shell-c8bab1acbdbe';

/** Committed files. A missing one is a packaging fault and should fail the install loudly. */
const SHELL = ['./sre-foundation.css', './app.js', './manifest.webmanifest'];

/** Build artefacts. Added tolerantly: `addAll` is all-or-nothing and a missing build must not stop the rest of
 *  the shell being cached. Without the bundle the portal opens into its SAMPLE stand-in — which says so. */
const BUILT = ['./b2b-app.bundle.js'];

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
    // Network first: a stale page presented as current is worse than no page at all.
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

  // A COMMITTED file (SHELL) changes only with a deploy, and a deploy changes CACHE (its name is a digest of the
  // shell, scripts/sync-ui-foundation.mjs) — so it is served from the cache, instantly. A BUILT file is produced on
  // the box at each deploy and keeps its name, so it is asked for on the network first and the cached copy is only
  // the fallback for a lane with no network. Found 4 Oct 2026 (RL-1): a new look reached the box and not one
  // browser, because the shell was cache-first under a name nobody had changed.
  event.respondWith(BUILT.some((p) => request.url.endsWith(p.slice(1))) ? networkFirst(request) : cacheFirst(request));
});

const cacheFirst = (request) => caches.match(request).then((cached) => cached ?? fetch(request).catch(() => Response.error()));
const networkFirst = (request) => fetch(request)
  .then((response) => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => undefined); }
    return response;
  })
  .catch(async () => (await caches.match(request)) ?? Response.error());
