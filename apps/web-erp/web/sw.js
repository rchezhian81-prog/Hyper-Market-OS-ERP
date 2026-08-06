// Back-office service worker — makes the ERP open with no internet (§31), including at the goods-in
// door and in the cash office, which are the worst two places for wifi in the building.
//
// **This folder serves four screens** — the manager's, the buyer's, prices, and shelves and space —
// sharing one bundle. Each is registered separately by the store box under its own path, so each
// gets its own scope and `./` is always that screen's own page. There is no way for one to be
// served in place of another.
//
// It caches the SHELL and the last page the box actually served. It does not cache the store's
// figures as facts: a cached exception count served hours later as if it were current is the exact
// fault this product spends most of its effort refusing.
//
// ── How this behaves, and why it is not the obvious cache-everything ────────
//
// **The page is fetched from the network first, every time, and only falls back to the cache when
// the network genuinely fails.** A screen in this product is served with its data injected into the
// page by the store box, so a cache-first page is a cache-first *payload* — yesterday's figures
// handed over as today's, silently, which is the exact fault the rest of this codebase spends its
// effort refusing. Static files (the view, the bundle, the manifest) change only on a deploy, so
// those stay cache-first and load instantly.
//
// **A page served from the cache says so.** The copy that goes into the cache carries the time it
// was taken, as `window.shellCachedAt`, and the screen shows a strip saying this is what the shop
// last told it and when. The live copy handed to the browser is untouched, so online there is no
// strip and nothing changes. Without that stamp, turning this cache on would make the screens LESS
// safe than having no cache at all: a manager could close a trading day on a page from this
// morning and nothing anywhere would say so (P-08).
//
// **A missing script is never answered with a page.** Returning HTML where JavaScript was asked for
// gives the browser a syntax error, and the screen then boots into its sample stand-in for a reason
// nobody can see.

const CACHE = 'sre-erp-shell-v2';

/** Committed files. A missing one is a packaging fault and should fail the install loudly. */
const SHELL = ['./app.js', './buying.js', './catalogue.js', './merchandising.js', './manifest.webmanifest'];

/** Build artefacts. Added tolerantly: `addAll` is all-or-nothing and a missing build must not
 *  stop the rest of the shell being cached. Without the bundle the screen opens into its SAMPLE
 *  stand-in — which says so on the page, but is not the shop's own data. */
const BUILT = ['./web-erp.bundle.js'];

/** This screen's own page. One registration per screen, so `./` is always the right one. */
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
      // Take the page now as well, so the screen survives an outage that starts before it has
      // been opened a second time. Tolerant: a box that is already unreachable must not stop the
      // service worker installing at all.
      await fetch(PAGE).then((r) => cachePage(new Request(PAGE), r)).catch(() => undefined);
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

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return; // never intercept writes

  if (request.mode === 'navigate') {
    // Network first: the payload in this page is the shop's data, and a stale one presented as
    // current is worse than no page at all.
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

  // Everything else is a static file that only changes on a deploy.
  event.respondWith(
    caches.match(request).then((cached) => cached ?? fetch(request).catch(() => Response.error())),
  );
});
