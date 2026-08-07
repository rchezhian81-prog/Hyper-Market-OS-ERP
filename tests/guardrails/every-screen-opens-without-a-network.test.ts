import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * **The offline shells, and the fault of having written them and never switched them on.**
 *
 * Every one of these apps shipped with a service worker. Every one of them was correct. **Five of
 * the six were never registered by anything**, so nothing was ever cached and every screen fell
 * back to its sample stand-in the moment the store box was unreachable — which, at the goods-in
 * door and on a delivery round, is most of the time (§31, P-01).
 *
 * Switching them on is not, on its own, an improvement. It is a **regression** unless three things
 * are true at once, and this file exists to keep all three true:
 *
 *   1. **The page is fetched from the network first.** These screens are served with the shop's
 *      data injected into the page by the store box. A cache-first page is a cache-first *payload*
 *      — this morning's exception register handed over as this minute's, silently — which is the
 *      one fault this codebase spends most of its effort refusing.
 *   2. **A page served from the cache says so, and says when.** Without that, a manager could close
 *      a trading day on a page from three hours ago and nothing anywhere would tell them (P-08).
 *   3. **A missing script is never answered with a page.** HTML returned where JavaScript was asked
 *      for is a syntax error, and the screen then boots into its sample stand-in for a reason
 *      nobody can see.
 *
 * Static checks on the shipped files. They cannot prove a shell opens on a dead router — a person
 * with the plug out does that — only that the decisions that make it safe are still there.
 */

/** Every screen this product ships, and the bundle each one needs in order to be itself. */
const SCREENS = [
  { name: 'the till', dir: 'pos', view: 'app.js', page: 'index.html', bundle: 'pos.bundle.js' },
  { name: 'the manager', dir: 'web-erp', view: 'app.js', page: 'index.html', bundle: 'web-erp.bundle.js' },
  { name: 'the buyer', dir: 'web-erp', view: 'buying.js', page: 'buying.html', bundle: 'web-erp.bundle.js' },
  { name: 'the pricer', dir: 'web-erp', view: 'catalogue.js', page: 'catalogue.html', bundle: 'web-erp.bundle.js' },
  { name: 'the merchandiser', dir: 'web-erp', view: 'merchandising.js', page: 'merchandising.html', bundle: 'web-erp.bundle.js' },
  { name: 'the analyst', dir: 'web-erp', view: 'reporting.js', page: 'reporting.html', bundle: 'web-erp.bundle.js' },
  { name: 'the store setup', dir: 'web-erp', view: 'setup.js', page: 'setup.html', bundle: 'web-erp.bundle.js' },
  { name: 'the owner', dir: 'owner-app', view: 'app.js', page: 'index.html', bundle: 'owner-app.bundle.js' },
  { name: 'the picker', dir: 'picker-app', view: 'app.js', page: 'index.html', bundle: 'picker-app.bundle.js' },
  { name: 'the driver', dir: 'delivery-app', view: 'app.js', page: 'index.html', bundle: 'delivery-app.bundle.js' },
  { name: 'the customer', dir: 'customer-app', view: 'app.js', page: 'index.html', bundle: 'customer-app.bundle.js' },
] as const;

const read = (path: string): string => readFileSync(path, 'utf8');

/** Comments discuss these on purpose, so only real code counts. */
const code = (source: string): string => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');

const workerFor = (dir: string): string => code(read(`apps/${dir}/web/sw.js`));

describe('the service worker is actually registered', () => {
  it('every screen registers it — it existed for weeks and only one app ever did', () => {
    // A cache nothing installs is not a cache. This is the whole finding.
    for (const screen of SCREENS) {
      expect(code(read(`apps/${screen.dir}/web/${screen.view}`)), `${screen.name} never registers it`)
        .toMatch(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/);
    }
  });

  it('guards the call, so a browser without service workers still opens the screen', () => {
    for (const screen of SCREENS) {
      expect(code(read(`apps/${screen.dir}/web/${screen.view}`)), `${screen.name} assumes support`)
        .toMatch(/'serviceWorker' in navigator/);
    }
  });

  it('tripwire — the detector fires on a view that does not register', () => {
    // Otherwise a regex that silently matched nothing would make the checks above vacuous.
    expect(/navigator\.serviceWorker\.register\('\.\/sw\.js'\)/.test('const x = 1;')).toBe(false);
  });
});

describe('the page is fetched fresh, and a cached one admits it', () => {
  it('goes to the network first for a page, and only falls back when it fails', () => {
    // Cache-first here would mean cache-first PAYLOAD: yesterday's figures served as today's.
    for (const { dir } of SCREENS) {
      const sw = workerFor(dir);
      expect(sw, `apps/${dir} does not treat a page differently`).toMatch(/request\.mode === 'navigate'/);
      const navigate = sw.slice(sw.indexOf("request.mode === 'navigate'"));
      const fetched = navigate.indexOf('fetch(request)');
      const fellBack = navigate.indexOf('caches.match(request)');
      expect(fetched, `apps/${dir} never tries the network for a page`).toBeGreaterThan(-1);
      expect(fellBack, `apps/${dir} never falls back to the cache`).toBeGreaterThan(fetched);
    }
  });

  it('stamps the cached copy with when it was taken, and leaves the live copy alone', () => {
    for (const { dir } of SCREENS) {
      const sw = workerFor(dir);
      expect(sw, `apps/${dir} caches a page with no timestamp`).toMatch(/window\.shellCachedAt=/);
      // The stamp goes on the copy that is PUT, never on the response handed to the browser —
      // otherwise every online load would claim to be cached.
      expect(sw).toMatch(/cache\.put\(request, new Response\(stamped/);
      expect(sw).toMatch(/return response;/);
    }
  });

  it('shows the strip on every screen, in English and Tamil', () => {
    // A cached page shown as a live one is not a stale label on a screen; it is somebody acting on
    // this morning's figures believing they are this minute's.
    for (const screen of SCREENS) {
      const view = read(`apps/${screen.dir}/web/${screen.view}`);
      const html = read(`apps/${screen.dir}/web/${screen.page}`);
      expect(html, `${screen.name} has no strip to show it`).toContain('id="stale"');
      expect(code(view), `${screen.name} never reads the stamp`).toMatch(/window\.shellCachedAt/);
      expect(code(view), `${screen.name} never renders the strip`).toMatch(/function paintStale/);

      const en = view.slice(view.indexOf('  en: {'), view.indexOf('  ta: {'));
      const ta = view.slice(view.indexOf('  ta: {'));
      expect(en, `${screen.name} has no English for the strip`).toMatch(/staleShell:/);
      expect(ta, `${screen.name} has no Tamil for the strip`).toMatch(/staleShell:/);
    }
  });

  it('repaints the strip when the language is switched', () => {
    for (const screen of SCREENS) {
      expect(code(read(`apps/${screen.dir}/web/${screen.view}`)), `${screen.name} leaves it in one language`)
        .toMatch(/el\('lang'\)\.addEventListener\('click', paintStale\)/);
    }
  });

  it('says the time in the reader’s own local time', () => {
    // The person reading it is standing in the shop, not in UTC.
    for (const screen of SCREENS) {
      expect(code(read(`apps/${screen.dir}/web/${screen.view}`)))
        .toMatch(/new Date\(at\)\.toLocaleString\(\)/);
    }
  });
});

describe('what is cached, and what is never answered with a page', () => {
  it('caches the bundle each screen needs to be more than a stand-in', () => {
    // Without it the screen opens offline into its SAMPLE data — which says so on the page, but is
    // not the shop's own data and is not what "works offline" means.
    for (const screen of SCREENS) {
      expect(workerFor(screen.dir), `apps/${screen.dir} does not cache ${screen.bundle}`)
        .toContain(screen.bundle);
    }
  });

  it('adds build artefacts tolerantly, so a missing build cannot stop the install', () => {
    // `addAll` is all-or-nothing: one 404 and the service worker never installs at all.
    for (const { dir } of SCREENS) {
      const sw = workerFor(dir);
      expect(sw, `apps/${dir} would fail to install without a build`).toMatch(/Promise\.allSettled\(BUILT/);
      expect(sw.slice(sw.indexOf('const SHELL')), `apps/${dir} puts a build artefact in SHELL`)
        .not.toMatch(/const SHELL = \[[^\]]*bundle\.js/);
    }
  });

  it('never answers a missing script with a page', () => {
    for (const { dir } of SCREENS) {
      const sw = workerFor(dir);
      const statics = sw.slice(sw.lastIndexOf('self.addEventListener(\'fetch\''));
      expect(statics, `apps/${dir} serves HTML where a script was asked for`).toMatch(/Response\.error\(\)/);
    }
  });

  it('still refuses to intercept a write', () => {
    for (const { dir } of SCREENS) {
      expect(workerFor(dir), `apps/${dir} intercepts writes`).toMatch(/request\.method !== 'GET'/);
    }
  });

  it('drops superseded caches so a new version takes effect', () => {
    for (const { dir } of SCREENS) {
      const sw = workerFor(dir);
      expect(sw).toMatch(/caches\.delete\(k\)/);
      // A cache name that never changes means yesterday's shell is served after a deploy. The
      // VERSION is not pinned to a number here — apps are edited at different times and pinning it
      // would make every shell change a two-file edit, with this file the one people forget.
      expect(sw, `apps/${dir} has no versioned cache name`).toMatch(/const CACHE = 'sre-[a-z-]+-shell-v\d+'/);
    }
  });

  it('gives each app its own cache name, so one deploy cannot evict another’s shell', () => {
    // `activate` deletes every cache that is not this worker's. Two apps sharing a name would then
    // take turns wiping each other on the same origin.
    const names = SCREENS.map(({ dir }) => /const CACHE = '([^']+)'/.exec(workerFor(dir))?.[1]);
    const byDir = new Map(SCREENS.map(({ dir }, i) => [dir, names[i]]));
    expect(new Set(byDir.values()).size, 'two apps share one cache name').toBe(byDir.size);
  });
});

describe('the till keeps its own promise (hard rule #1)', () => {
  it('never routes the lane’s durable write through this cache', () => {
    // A sale must be committed to the till's own disk before the receipt prints. A cached "OK" is
    // a sale the cashier saw succeed that exists nowhere.
    const sw = workerFor('pos');
    expect(sw).toMatch(/request\.method !== 'GET'/);
    expect(sw, 'the lane socket is inside the cache').not.toMatch(/127\.0\.0\.1|\/lane\//);
  });

  it('tells the cashier billing still works when the page came from the cache', () => {
    // The lane sells against its own edge on loopback. A strip that read "no connection" with no
    // more than that would stop a cashier who could have carried on serving people.
    const view = read('apps/pos/web/app.js');
    const en = view.slice(view.indexOf('  en: {'), view.indexOf('  ta: {'));
    expect(en).toMatch(/staleShell: 'No connection[^']*Billing still works/);
  });
});

describe('a bare screen path is redirected, not served broken', () => {
  const SERVER = code(readFileSync('edge/store-edge/src/screen-server.ts', 'utf8'));

  it('sends `/pos` to `/pos/` rather than serving a page whose links all miss', () => {
    // From `/pos` the browser resolves `./pos.bundle.js` against `/` and asks for
    // `/pos.bundle.js`, which this box does not have. The page then opens with no bundle, no view
    // and no service worker registered — a blank screen with nothing saying why.
    expect(SERVER).toMatch(/export function redirectFor/);
    expect(SERVER).toMatch(/res\.writeHead\(301/);
  });

  it('redirects before it routes, so nothing is read off the disk first', () => {
    expect(SERVER.indexOf('redirectFor(req.url')).toBeLessThan(SERVER.indexOf('routeOf(req.url'));
  });

  it('keeps the query string, so a screen opened with one does not lose it', () => {
    expect(SERVER).toMatch(/query === undefined \? '' : `\?\$\{query\}`/);
  });
});
