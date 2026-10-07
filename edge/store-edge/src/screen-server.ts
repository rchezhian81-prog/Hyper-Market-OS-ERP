// The socket every screen is served from — ADR-0004, §31, P-01.
//
// Every screen in this product reads a global at boot (`window.managerData` and its siblings) and
// nothing ever set one. They were built to be told the truth by something, and this is the
// something.
//
// ── Loopback, exactly as the lane socket is, and for a harder reason ────────
//
// This binds to `127.0.0.1`. **The bind address is the entire security control**, and here it is
// carrying more than the lane socket does: the manager's payload names today's exceptions, the
// owner's carries the day's takings and margin, and the customer's carries the price list. Bound
// to the shop network, any phone on the wifi could read the day's takings by opening a URL.
//
// A token would be theatre for the same reason it is on the lane socket: whoever can reach loopback
// is already running code on this machine.
//
// ── Why the payload is injected rather than fetched ─────────────────────────
//
// Each shell loads its bundle as a module, and the bundle reads its global while it evaluates. A
// screen that fetched its data afterwards would render once with nothing — and "nothing" on these
// screens means *not known*, so every screen would flash "this box has told me nothing" before
// correcting itself. On the manager's screen that flash says the day cannot be closed.
//
// So the box serves the shell with the payload already in it, at a marked point above the bundle
// script. The marker is explicit and greppable rather than a guessed position in the file, and a
// guardrail checks every shell still carries one.

import { createServer, type Server, type ServerResponse, type IncomingMessage } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { GLOBAL_FOR, SCREENS, payloadFor, catalogueFreshness, posReceiptTemplate, posLanePayload, posRefundPolicyPayload, type ScreenInput, type ScreenName } from './screen-data';
import { navigationPayload, type NavigationPayload, asSignedInPerson } from './screen-navigation';

/**
 * The address this listens on unless told otherwise — loopback, so on a shop PC nothing on the shop network
 * can read the day's takings. Named so a test can assert on it. The ONE reason to widen it is a container
 * on a private compose network with the public reverse proxy in front (ADR-0018): `EDGE_SCREEN_HOST` names
 * the address explicitly, the boot log says so out loud, and no host port is ever published for it.
 */
export const SCREEN_HOST = '127.0.0.1';

/** The marker each shell carries where its payload belongs. */
export const DATA_MARKER = '<!--SCREEN-DATA-->';

/**
 * Where each screen's shell lives.
 *
 * `dir` is the folder under `apps/`; `file` is the page served for the bare route. They are
 * separate because **two screens can share one app**: the manager and the buyer are both `web-erp`
 * and both load `web-erp.bundle.js`, but they are different jobs for different people, so they get
 * different pages rather than one page with a mode switch on it (P-07). One build, two shells.
 */
export interface AppShell {
  readonly dir: string;
  readonly file: string;
}

export const APP_SHELL: Readonly<Record<ScreenName, AppShell>> = Object.freeze({
  pos: { dir: 'pos', file: 'index.html' },
  manager: { dir: 'web-erp', file: 'index.html' },
  owner: { dir: 'owner-app', file: 'index.html' },
  picker: { dir: 'picker-app', file: 'index.html' },
  driver: { dir: 'delivery-app', file: 'index.html' },
  customer: { dir: 'customer-app', file: 'index.html' },
  buying: { dir: 'web-erp', file: 'buying.html' },
  catalogue: { dir: 'web-erp', file: 'catalogue.html' },
  merchandising: { dir: 'web-erp', file: 'merchandising.html' },
  reporting: { dir: 'web-erp', file: 'reporting.html' },
  service: { dir: 'web-erp', file: 'service.html' },
  expiry: { dir: 'web-erp', file: 'expiry.html' },
  finance: { dir: 'web-erp', file: 'finance.html' },
  'gst-reconciliation': { dir: 'web-erp', file: 'gst-reconciliation.html' },
  'category-policy': { dir: 'web-erp', file: 'category-policy.html' },
  'gst-returns': { dir: 'web-erp', file: 'gst-returns.html' },
  waste: { dir: 'web-erp', file: 'waste.html' },
  'write-off-capture': { dir: 'web-erp', file: 'write-off-capture.html' },
  counts: { dir: 'web-erp', file: 'counts.html' },
  fleet: { dir: 'web-erp', file: 'fleet.html' },
  'product-publish-review': { dir: 'web-erp', file: 'product-publish-review.html' },
  'data-quality': { dir: 'web-erp', file: 'data-quality.html' },
  'operations': { dir: 'web-erp', file: 'operations.html' },
  'loss-prevention': { dir: 'web-erp', file: 'loss-prevention.html' },
  'substitution-exceptions': { dir: 'web-erp', file: 'substitution-exceptions.html' },
  'day-book': { dir: 'web-erp', file: 'day-book.html' },
  'document-templates': { dir: 'web-erp', file: 'document-templates.html' },
  'return-governance': { dir: 'web-erp', file: 'return-governance.html' },
  'cash-office': { dir: 'web-erp', file: 'cash-office.html' },
  'risk-acceptance': { dir: 'web-erp', file: 'risk-acceptance.html' },
  'day-reopen': { dir: 'web-erp', file: 'day-reopen.html' },
  'stock-health': { dir: 'web-erp', file: 'stock-health.html' },
  'stored-value': { dir: 'web-erp', file: 'stored-value.html' },
  'integration-health': { dir: 'web-erp', file: 'integration-health.html' },
  'goods-receipt': { dir: 'web-erp', file: 'goods-receipt.html' },
  suppliers: { dir: 'web-erp', file: 'suppliers.html' },
  indents: { dir: 'web-erp', file: 'indents.html' },
  unsellable: { dir: 'web-erp', file: 'unsellable.html' },
  'data-io': { dir: 'web-erp', file: 'data-io.html' },
  'workforce': { dir: 'web-erp', file: 'workforce.html' },
  ess: { dir: 'web-erp', file: 'ess.html' },
  rostering: { dir: 'web-erp', file: 'rostering.html' },
  checklist: { dir: 'web-erp', file: 'checklist.html' },
  production: { dir: 'web-erp', file: 'production.html' },
  facilities: { dir: 'web-erp', file: 'facilities.html' },
  admin: { dir: 'web-erp', file: 'admin.html' },
  ai: { dir: 'web-erp', file: 'ai.html' },
  migration: { dir: 'web-erp', file: 'migration.html' },
  warehouse: { dir: 'warehouse-app', file: 'index.html' },
  'warehouse-supervisor': { dir: 'web-erp', file: 'warehouse.html' },
  approvals: { dir: 'web-erp', file: 'approvals.html' },
});

export interface ScreenServer {
  readonly port: number;
  /** The address the socket is bound to (`SCREEN_HOST` unless a deployment named another). */
  readonly host: string;
  stop(): Promise<void>;
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  // The one shared stylesheet every screen links (Stage G slice 1). A browser in standards mode refuses a
  // stylesheet served as anything but text/css, so the type is named here rather than sniffed.
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

/**
 * Escape a payload for embedding in a `<script>` element.
 *
 * `</script>` inside a JSON string ends the element early and everything after it becomes markup.
 * That is not a theoretical worry here: a product name is customer-visible text that came from a
 * spreadsheet somebody typed, and it reaches this payload verbatim. Escaping `<` is sufficient and
 * leaves the JSON valid.
 */
export function embed(payload: unknown): string {
  return JSON.stringify(payload).replace(/</g, '\\u003c');
}

/**
 * Put a screen's payload into its shell at the marked point.
 *
 * `extra` globals ride the same script and are injected on EVERY screen, even one whose own payload
 * is `null` — the pack-age badge (SYNC-01) belongs on a screen that has nothing else to show just as
 * much as on one that does. When there is nothing at all to inject, the marker is left untouched and
 * the shell handles being told nothing.
 */
export function injectPayload(
  html: string, global: string, payload: unknown, extra: Readonly<Record<string, unknown>> = {},
): string {
  // Each global in its OWN <script> tag, so a reader (a shell, or a test) can pull one out without
  // the others in the way — the same one-tag shape the screen global has always had.
  const tags: string[] = [];
  if (payload !== null) tags.push(`<script>window.${global} = ${embed(payload)};</script>`);
  for (const [name, value] of Object.entries(extra)) tags.push(`<script>window.${name} = ${embed(value)};</script>`);
  if (tags.length === 0) return html; // nothing to say; the shell already handles being told nothing
  return html.replace(DATA_MARKER, tags.join(''));
}

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer): void => {
  res.writeHead(status, {
    'content-type': type,
    'content-length': String(Buffer.byteLength(body)),
    // Nothing may frame these screens or read them from another origin.
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'cache-control': 'no-store',
  });
  res.end(body);
};

/**
 * `/manager/app.js` → `{ screen: 'manager', file: 'app.js' }`, or null if it is not a screen path.
 *
 * A bare route resolves to that screen's own shell, which is **not** always `index.html` — the
 * buyer's page shares the manager's app folder and would otherwise silently serve the manager's
 * screen to somebody who asked for the buyer's.
 */
export function routeOf(url: string): { readonly screen: ScreenName; readonly file: string } | null {
  const [path] = url.split('?');
  const parts = (path ?? '').split('/').filter((p) => p !== '');
  const name = parts[0];
  if (name === undefined || !(SCREENS as readonly string[]).includes(name)) return null;
  const screen = name as ScreenName;
  const file = parts.slice(1).join('/');
  return { screen, file: file === '' ? APP_SHELL[screen].file : file };
}

/**
 * `/pos` must become `/pos/` before anything else happens.
 *
 * **Without the trailing slash every relative URL in the page resolves one level too high.** The
 * shell asks for `./pos.bundle.js`; from `/pos` a browser resolves that against `/`, asks this box
 * for `/pos.bundle.js`, and gets a 404 — so the page opens with no bundle, no view and no service
 * worker registered, which is a blank screen with nothing anywhere saying why. Served happily and
 * broken, which is the worst of the three possible outcomes.
 *
 * Returns the location to redirect to, or `null` when the path is already fine.
 */
/**
 * Menu aliases (P-07): nav paths that are NOT their own screen but open an existing one on a tab.
 *
 * "Products", "Pricing" and "Promotions" are three menu items (navigation.ts) for the ONE built and
 * browser-verified "Products and prices" screen (`catalogue`, M03/M05 — its tabs are items/price/promo).
 * Rather than duplicate that tested screen three times, each menu item opens it on the right tab, so the
 * menu never offers a dead link the box would 404. The catalogue shell reads `?tab=` and shows that tab.
 */
export const SCREEN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  products: '/catalogue/',
  pricing: '/catalogue/?tab=price',
  promotions: '/catalogue/?tab=promo',
});

export function redirectFor(url: string): string | null {
  const [path, query] = url.split('?');
  const parts = (path ?? '').split('/').filter((p) => p !== '');
  if (parts.length !== 1) return null;
  const name = parts[0]!;
  // A menu alias opens its target screen on the right tab (/pricing → /catalogue/?tab=price). Checked
  // before the trailing-slash rule so both /pricing and /pricing/ land there without a redirect loop.
  const alias = SCREEN_ALIASES[name];
  if (alias !== undefined) return alias;
  if (!(SCREENS as readonly string[]).includes(name)) return null;
  if ((path ?? '').endsWith('/')) return null;
  return `/${name}/${query === undefined ? '' : `?${query}`}`;
}

/** Which screen a menu path opens on this box — through its redirects — or null when it opens nothing here. */
/**
 * The public prefix this box is mounted under, when a front says so (`X-Forwarded-Prefix: /store` — the hosted demo's
 * relay, ADR-0016). A page's menu is drawn with the box's own paths; through such a front the browser must be sent to
 * `/store/counts/`, not `/counts/`, so the prefix is put on every link the menu offers (RL-2, 4 Oct 2026). Only a plain
 * absolute path segment counts — nothing with a scheme, a host, a query, a dot or a second slash — and an absent or
 * malformed header means no prefix, exactly as in a store.
 */
/** The person the relay says signed in — one plain id, or null for anything else (absent, several, odd characters). */
export function forwardedUser(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const id = header.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._@-]{0,127}$/.test(id) ? id : null;
}

export function forwardedPrefix(header: string | string[] | undefined): string {
  const raw = Array.isArray(header) ? header[0] : header;
  if (raw === undefined) return '';
  const value = raw.trim().replace(/\/+$/, '');
  return /^\/[a-z0-9-]+$/.test(value) ? value : '';
}

/** The menu with every link under the public prefix; untouched when there is none. */
export function withPublicPrefix(navigation: NavigationPayload, prefix: string): NavigationPayload {
  if (prefix === '') return navigation;
  return { ...navigation, groups: navigation.groups.map((g) => ({ ...g, items: g.items.map((item) => ({ ...item, path: `${prefix}${item.path}` })) })) };
}

export function screenOfPath(path: string): ScreenName | null {
  const target = redirectFor(path) ?? path;
  const route = routeOf(target);
  // Only a screen's own door counts: `/admin/users` would name the admin screen and a file that does not exist.
  if (route === null || route.file !== APP_SHELL[route.screen].file) return null;
  return route.screen;
}

/**
 * Refuse anything that tries to climb out of the screen's own folder.
 *
 * `..%2f..%2fetc%2fpasswd` is the oldest request in the book and this server reads files from disk
 * by name. Normalised first, then checked — checking the raw string first is how `..%2f` gets past,
 * because it is not `..` until it has been decoded.
 */
export function safeFile(file: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(file);
  } catch {
    return null;
  }
  const clean = normalize(decoded);
  if (clean.startsWith('..') || clean.startsWith('/') || clean.includes('\0')) return null;
  return clean;
}

export function startScreenServer(input: {
  readonly port: number;
  /** The address to bind — `SCREEN_HOST` (loopback) unless a deployment names another (see `SCREEN_HOST`). */
  readonly host?: string;
  /** Where `apps/` lives on this box. */
  readonly appsDir: string;
  /** Called per request, so every screen reload gets the CURRENT day rather than boot-time state. */
  readonly snapshot: () => ScreenInput;
  /**
   * The loopback base of this box's lane write socket, e.g. `http://127.0.0.1:8123` (M14-FR-04).
   * Injected as `window.laneWriteBase` so the manager's screen can POST the day close to the box (the
   * one screen action that writes to the box rather than reading a synced snapshot). Absent when this
   * box serves no lane socket, in which case the screen keeps its local, read-only behaviour.
   */
  readonly laneWriteBase?: string;
  /** Which LANE this box is (`EDGE_LANE_ID`, SP-4b · F09) — told to the served till so every sale names it. */
  readonly laneId?: string;
  /**
   * Run the ERP screens as the person the relay's `X-Sre-User` header names (OB-16). ONLY a deployment whose screens
   * are reached solely through a front that authenticates every request and sets this header itself
   * (`infra/compose/nginx.pilot.conf`, behind the sign-in) may turn this on — `EDGE_SCREEN_TRUST_FORWARDED_USER=1`.
   * A store box, whose screens are loopback-only with nobody in front, leaves it off and the header is ignored.
   */
  readonly trustForwardedUser?: boolean;
}): Promise<ScreenServer> {
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      if (req.method !== 'GET') {
        send(res, 405, 'text/plain; charset=utf-8', 'this box serves screens, and only reads');
        return;
      }
      const redirect = redirectFor(req.url ?? '/');
      if (redirect !== null) {
        res.writeHead(301, {
          location: redirect,
          'cache-control': 'no-store',
          'x-frame-options': 'DENY',
          'referrer-policy': 'no-referrer',
        });
        res.end();
        return;
      }

      const route = routeOf(req.url ?? '/');
      if (route === null) {
        send(res, 404, 'text/plain; charset=utf-8', `not a screen. This box serves: ${SCREENS.join(', ')}`);
        return;
      }
      const file = safeFile(route.file);
      if (file === null) {
        send(res, 400, 'text/plain; charset=utf-8', 'bad path');
        return;
      }

      const onDisk = join(input.appsDir, APP_SHELL[route.screen].dir, 'web', file);
      let body: Buffer;
      try {
        body = await readFile(onDisk);
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', 'no such file on this screen');
        return;
      }

      const extension = file.slice(file.lastIndexOf('.'));
      const type = TYPES[extension] ?? 'application/octet-stream';

      if (extension !== '.html') {
        send(res, 200, type, body);
        return;
      }

      // The payload is built PER REQUEST. A screen reloaded at four o'clock must show four
      // o'clock's exceptions, not the ones this process saw when it started. The pack-age badge
      // (SYNC-01) rides alongside it on every screen, from the same one snapshot.
      const snap = input.snapshot();
      const built = payloadFor(route.screen, snap);
      // OB-16: behind the authenticated relay the ERP screens run as the person who SIGNED IN — their id, their
      // permissions from this box's role register — never as whoever the pack named for the screen. The till and
      // the handhelds are untouched: the person signs in at the device itself.
      const signedIn = input.trustForwardedUser === true && APP_SHELL[route.screen].dir === 'web-erp' ? forwardedUser(req.headers['x-sre-user']) : null;
      const payload = signedIn === null ? built : asSignedInPerson(built, signedIn, snap.pack);
      // The till alone also gets the receipt template head office published, when this box has pulled one
      // (M01-FR-02): its own global beside the catalogue, so a bill printed offline carries the words and the
      // version. Absent when none has reached this box — the till prints with its defaults and stamps nothing.
      const receiptTemplate = route.screen === 'pos' ? posReceiptTemplate(snap) : undefined;
      // The till alone is also told which lane it IS and when the shop's day ends (SP-4b · F09) — never who the cashier
      // is; the person signs in at the till.
      const posLane = route.screen === 'pos' ? posLanePayload(snap, input.laneId) : undefined;
      // And the refund policy its store pack carries (SP-9b-i · M13-FR-01): the approval threshold and the no-receipt
      // cap. Absent when the box holds none — the till then offers no return without a receipt, rather than guessing a cap.
      const posRefundPolicy = route.screen === 'pos' ? posRefundPolicyPayload(snap) : undefined;
      // Every ERP page also gets its menu — the screens THIS viewer may open on THIS box, worked out per request
      // from the pack's role register and the screen's named viewer (Stage G slice 5b · §27 · P-07). Only the ERP:
      // the till, the handhelds and the apps are one job each and have no menu to draw.
      const navigation = APP_SHELL[route.screen].dir === 'web-erp'
        ? withPublicPrefix(navigationPayload({ screen: route.screen, pack: snap.pack, payload: payload ?? (signedIn === null ? null : { userId: signedIn }), screenOf: screenOfPath }), forwardedPrefix(req.headers['x-forwarded-prefix']))
        : undefined;
      send(res, 200, type, injectPayload(
        body.toString('utf8'), GLOBAL_FOR[route.screen], payload,
        {
          catalogueFreshness: catalogueFreshness(snap),
          ...(receiptTemplate === undefined ? {} : { posReceiptTemplate: receiptTemplate }),
          ...(posLane === undefined ? {} : { posLane }),
          ...(posRefundPolicy === undefined ? {} : { posRefundPolicy }),
          ...(navigation === undefined ? {} : { sreNavigation: navigation }),
          // The one write a screen makes back to the box: the manager's day close (M14-FR-04). Only
          // present when this box serves a lane socket to post to; the screen falls back to read-only
          // (a local preview) when it is absent.
          ...(input.laneWriteBase === undefined ? {} : { laneWriteBase: input.laneWriteBase }),
        },
      ));
    })();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Loopback unless a deployment names another address explicitly — see the note on SCREEN_HOST.
    server.listen(input.port, input.host ?? SCREEN_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : input.port;
      resolve({
        port,
        host: input.host ?? SCREEN_HOST,
        // Stop accepting, then drop the connections still open (see the lane server's stop for why).
        stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }),
      });
    });
  });
}
