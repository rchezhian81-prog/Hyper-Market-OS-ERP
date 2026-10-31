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
import { packTimeZone } from './shop-zone'; // OB-606
import { wallClockIn } from '../../../packages/calendar/src/trading-day'; // Round A: the copy's time in the shop's clock
import { navigationPayload, type NavigationPayload, asSignedInPerson, permissionsOf } from './screen-navigation';
import { ERP_NAVIGATION, permissionsOpening } from '../../../apps/web-erp/src/navigation';
import {
  SIGN_OUT_BAR, notAllowedPage, officeCookie, officeTokenOf, readSignInForm, safeNext, signInPage, signedInGlobals,
  type OfficeCheck, type OfficeSignIn,
} from './office-sign-in';
import { asPhoneHolder } from './handheld-sign-in';
import { isHandheldSource } from '../../../packages/sync/src/device-relay';
import type { EveningCheckBox } from './evening-check-box';
import { counterLabelFor, readCounterLabelRequest } from './store-work';
import { TILL_SHELL_SCREENS, CUSTOMER_FACING_SCREENS, customerFacingGlobals } from './self-checkout-screens'; // OB-288 P6
import { HEAD_OFFICE_PAGE_SHELLS, isHeadOfficeCall, isHeadOfficePage } from './head-office-pages'; // OB-380
import { HEAD_OFFICE_CALL_MAX_BYTES, headOfficeCallRefusal, headOfficeSignInPage, type HeadOfficeCallRefusal, type HeadOfficeLink } from './head-office-link'; // OB-388
import { rolesAtThisStore } from './office-sign-in';
import { peopleFrom } from './screen-navigation';
import { HANDHELD_SEAL_PATHS, handheldSealPage, handheldSealPanel, type HandheldSealSource } from './handheld-seal'; // OB-424

/**
 * OB-263: the evening check's doors on the migration screen — the only other writes this socket takes. Each is for the
 * person signed in with their own PIN (OB-259), from a page this box served, as JSON; the box decides the rest.
 */
export const EVENING_CHECK_PATHS = Object.freeze({
  day: '/migration/evening-check/day',
  mapping: '/migration/evening-check/mapping',
  load: '/migration/evening-check/load',
  reasons: '/migration/evening-check/reasons',
  sign: '/migration/evening-check/sign',
});
/** The two files of a day, with their JSON quoting, fit inside this; anything larger is refused unread. */
export const EVENING_CHECK_LOAD_MAX_BYTES = 12 * 1024 * 1024;

/**
 * OB-288 lane 2 · M11-FR-03 ("labelling/packing works at the counter offline"): the production screen's counter-label door.
 * The box renders the label from what IT holds — the run (head office's board, or a run captured on this screen), the
 * recipe's shelf life, the catalogue's name and price, the shop's barcode rule — and refuses, by name, anything it cannot
 * vouch for. It records nothing and asks head office nothing, so it works with the cable out.
 */
export const PRODUCTION_LABEL_PATH = '/production/label';

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
  'held-returns': { dir: 'web-erp', file: 'held-returns.html' },
  'recall-trace': { dir: 'web-erp', file: 'recall-trace.html' }, // OB-288 integration follow-up
  help: { dir: 'web-erp', file: 'help.html' }, // OB-288 LP/workforce package (M25-FR-04)
  'service-desk': { dir: 'web-erp', file: 'service-desk.html' },
  'ai-drafts': { dir: 'web-erp', file: 'ai-drafts.html' },
  // OB-288 P6 (R8-3 · D14-FR-02): the self-checkout lane and the price kiosk, each its own app.
  'self-checkout': { dir: 'self-checkout', file: 'index.html' },
  'price-kiosk': { dir: 'price-kiosk', file: 'index.html' },
  // OB-380 (26 Oct 2026): the office pages head office answers, each its own web-erp page (head-office-pages.ts).
  ...HEAD_OFFICE_PAGE_SHELLS,
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

/**
 * Round A (screen gap audit 31 Oct 2026 · P-08): how old this box's copy of head office's store setup is — the time head
 * office's setup reached this box (in the shop's own clock) and its age in whole minutes. `null` when this box has no setup
 * from head office at all (the pages then say they were not told, section by section).
 */
export function storeCopyOf(snap: Pick<ScreenInput, 'pack' | 'now'>): { readonly receivedAt: string; readonly shownAt: string; readonly ageMinutes: number } | null {
  const at = snap.pack.receivedAt;
  if (at === null || Number.isNaN(Date.parse(at)) || Number.isNaN(Date.parse(snap.now))) return null;
  return { receivedAt: at, shownAt: wallClockIn(at, packTimeZone(snap.pack)).replace('T', ' '), ageMinutes: Math.max(0, Math.floor((Date.parse(snap.now) - Date.parse(at)) / 60_000)) };
}

/** The screens that stay open with no office sign-in: the till alone — its cashier signs in at the till itself. */
export const OPEN_SCREENS: readonly ScreenName[] = Object.freeze(['pos', ...CUSTOMER_FACING_SCREENS]);

/** The permission a screen's own menu item asks for (apps/web-erp/src/navigation.ts), or null when no item opens it. */
export function permissionForScreen(screen: ScreenName): string | null {
  const item = ERP_NAVIGATION.find((i) => screenOfPath(i.path.split('?')[0] ?? i.path) === screen);
  return item === undefined ? null : item.requires;
}

/**
 * R10-A · OB-543: every word that opens a screen — its menu item's `requires` and any narrower `alsoOpenedWith` (the
 * accountant's `inventory.goodsreceipt.read` for the goods-receipt screen) — or null when no item opens it.
 */
export function permissionsForScreen(screen: ScreenName): readonly string[] | null {
  const item = ERP_NAVIGATION.find((i) => screenOfPath(i.path.split('?')[0] ?? i.path) === screen);
  return item === undefined ? null : permissionsOpening(item);
}

/** The person holds a word that opens this screen (or no menu item gates it). */
function mayOpenScreen(screen: ScreenName, held: readonly string[] | null): boolean {
  const needs = permissionsForScreen(screen);
  return needs === null || needs.some((p) => (held ?? []).includes(p));
}

/** The office gate the screen socket asks (OB-259): edge/store-edge/src/office-sign-in.ts `OfficeSessions`. */
export interface OfficeGate {
  signIn(input: { readonly staffId: string; readonly pin: string }): Promise<OfficeSignIn>;
  check(token: string | undefined): Promise<OfficeCheck>;
  signOut(token: string | undefined): Promise<boolean>;
}

/** A person's name from the store setup, or their id when the setup names them not. */
function displayNameIn(pack: ScreenInput['pack'], userId: string): string {
  return (pack.people.known ? peopleFrom(pack.people.value).find((p) => p.userId === userId)?.displayName : undefined) ?? userId;
}

/** Read a request body, up to `limit` bytes; anything longer reads as too long (never buffered whole). */
function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  return new Promise((resolve) => {
    let size = 0;
    const parts: Buffer[] = [];
    req.on('data', (c: Buffer) => { size += c.length; if (size <= limit) parts.push(c); });
    req.on('end', () => { resolve(size > limit ? null : Buffer.concat(parts).toString('utf8')); });
    req.on('error', () => { resolve(null); });
  });
}

/** A POST to the office doors comes from a page this box served, never another site (the browser says where from). */
function sameOrigin(req: IncomingMessage): boolean {
  // A browser says where a request comes from (Fetch Metadata). These pages send no referrer, so a form's Origin reads
  // "null" — the browser's own Sec-Fetch-Site is what tells this page from another site's.
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string') return site === 'same-origin' || site === 'none';
  const origin = req.headers['origin'];
  if (origin === undefined || origin === 'null') return origin === undefined;
  try { return new URL(origin).host === req.headers['host']; } catch { return false; }
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
  /** B13 (OB-138): the hallmark HUIDs this box has sold — told to the served till with its lane, per request. */
  readonly soldHuids?: () => readonly string[];
  /** OB-252: whether this box takes guest sales only, and who turned it on — told to the served till, per request. */
  readonly guestSalesOnly?: () => { readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null };
  /**
   * OB-271: whether this box's tills are in REAL TRADING, the shop's legal identity for the tax invoice and the bill's paper
   * — told to the served till with its lane, per request (a later pack may change the identity). Absent: not told (off).
   */
  readonly realTrading?: () => {
    readonly on: boolean; readonly by: 'store_pack' | 'store_computer_setting' | null;
    readonly taxInvoice: { readonly legalName: string; readonly gstin: string; readonly placeOfBusiness: readonly string[] } | null;
    readonly billPaper?: string;
  };
  /**
   * Run the ERP screens as the person the relay's `X-Sre-User` header names (OB-16). ONLY a deployment whose screens
   * are reached solely through a front that authenticates every request and sets this header itself
   * (`infra/compose/nginx.pilot.conf`, behind the sign-in) may turn this on — `EDGE_SCREEN_TRUST_FORWARDED_USER=1`.
   * A store box, whose screens are loopback-only with nobody in front, leaves it off and the header is ignored.
   */
  readonly trustForwardedUser?: boolean;
  /**
   * OB-259: every screen but the till asks for the person's own PIN (`EDGE_OFFICE_SIGN_IN=pin`, which the installer writes).
   * Absent: the screens open as before (a test box, or the hosted copy behind its own sign-in front).
   */
  readonly officeSignIn?: OfficeGate;
  /** OB-263: the evening check kept on this box, and whether it is open (the mirror pilot). Absent: its doors answer 404. */
  readonly eveningCheck?: { readonly box: EveningCheckBox; readonly on: () => boolean };
  /**
   * OB-388 · ADR-0029: the link to head office for the office pages — the person's OWN head-office sign-in (the product's
   * sign-in service, code + PKCE, second step) and each page's `/v1` call carried with THAT person's token. Made once the
   * socket knows its own address (the sign-in returns to it). Absent: the box never answers `/v1` (a lost link, P-08).
   */
  readonly headOffice?: (origin: string) => HeadOfficeLink;
  /**
   * OB-424 · ADR-0030: the "Handheld seal" panel — the public authority certificate the handheld door is locked under, its
   * QR and its short fingerprint code, read per request from the RUNNING door. Served here (the PC's loopback) only, never
   * on the shop network. Absent: the panel's paths answer 404, as on a box with no screens for it.
   */
  readonly handheldSeal?: () => HandheldSealSource;
}): Promise<ScreenServer> {
  const office = input.officeSignIn;
  let link: HeadOfficeLink | undefined;
  const page = (res: ServerResponse, status: number, html: string, cookie?: string): void => {
    if (cookie !== undefined) res.setHeader('set-cookie', cookie);
    send(res, status, 'text/html; charset=utf-8', html);
  };
  const json = (res: ServerResponse, status: number, body: unknown): void => send(res, status, 'application/json; charset=utf-8', JSON.stringify(body));
  /**
   * WHO is at the evening check: the person signed in with their own PIN (OB-259), or — on the hosted copy only — the
   * person the front's sign-in named. Never a name in the request. They must hold the migration screen's own permission.
   */
  const eveningPerson = async (req: IncomingMessage): Promise<{ readonly userId: string; readonly via: string } | { readonly status: number; readonly refusedBecause: string; readonly detail: string }> => {
    const snap = input.snapshot();
    let person: { userId: string; via: string } | null = null;
    if (office !== undefined) {
      const session = await office.check(officeTokenOf(req.headers['cookie']));
      if (!session.ok) return { status: 401, refusedBecause: session.refusedBecause, detail: 'Your office sign-in has ended. Enter your PIN again (open the migration screen again).' };
      person = { userId: session.userId, via: 'office_pin' };
    } else if (input.trustForwardedUser === true) {
      const user = forwardedUser(req.headers['x-sre-user']);
      if (user !== null) person = { userId: user, via: 'verified_sign_in' };
    }
    if (person === null) {
      return { status: 403, refusedBecause: 'no_sign_in', detail: 'This store computer does not ask for a PIN on its office screens, so it cannot tell who is loading the evening check. Nothing was saved. Turn the office PIN on (owner guide Part 26e).' };
    }
    const needs = permissionForScreen('migration');
    if (needs !== null && !(permissionsOf(person.userId, snap.pack) ?? []).includes(needs)) {
      return { status: 403, refusedBecause: 'not_allowed', detail: `${person.userId} may not open the migration screen. Nothing was saved.` };
    }
    return person;
  };
  const eveningDoor = async (req: IncomingMessage, res: ServerResponse, path: string): Promise<void> => {
    const ec = input.eveningCheck;
    if (ec === undefined || !ec.on()) { req.resume(); json(res, 404, { ok: false, refusedBecause: 'not_in_the_mirror_pilot', detail: 'The evening check from the old system\'s files is for the mirror pilot, and this store computer is not set for it.' }); return; }
    const isRead = path === EVENING_CHECK_PATHS.day;
    if (isRead ? req.method !== 'GET' : req.method !== 'POST') { req.resume(); json(res, 405, { ok: false, refusedBecause: 'wrong_method', detail: isRead ? 'read with GET' : 'send with POST' }); return; }
    if (!isRead) {
      if (!sameOrigin(req)) { req.resume(); json(res, 403, { ok: false, refusedBecause: 'not_from_this_screen', detail: 'refused: not from a page this store computer served' }); return; }
      if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) { req.resume(); json(res, 415, { ok: false, refusedBecause: 'not_json', detail: 'send JSON' }); return; }
    }
    const person = await eveningPerson(req);
    if ('status' in person) { req.resume(); json(res, person.status, { ok: false, refusedBecause: person.refusedBecause, detail: person.detail }); return; }
    if (isRead) {
      const date = new URL(req.url ?? '', 'http://screens').searchParams.get('date') ?? '';
      json(res, 200, {
        ok: true, mappings: ec.box.mappings(), days: ec.box.days(),
        ...(/^\d{4}-\d{2}-\d{2}$/.test(date) ? { day: await ec.box.day(date) } : {}),
      });
      return;
    }
    const raw = await readBody(req, path === EVENING_CHECK_PATHS.load ? EVENING_CHECK_LOAD_MAX_BYTES : 256 * 1024);
    if (raw === null) { json(res, 413, { ok: false, refusedBecause: 'too_large', detail: 'The files are too large to be one day\'s reports. Nothing was saved.' }); return; }
    let body: Record<string, unknown>;
    try {
      const parsed = JSON.parse(raw) as unknown;
      body = parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
    } catch { json(res, 400, { ok: false, refusedBecause: 'not_readable', detail: 'The request could not be read. Nothing was saved.' }); return; }
    const at = new Date().toISOString();
    const who = { by: person.userId, via: person.via, at };
    const box = ec.box;
    const out = path === EVENING_CHECK_PATHS.mapping ? await box.setMapping({ report: body['report'], mapping: body['mapping'], header: body['header'], ...who })
      : path === EVENING_CHECK_PATHS.load ? await box.load({ businessDate: body['businessDate'], itemWise: body['itemWise'], billWise: body['billWise'], tolerance: body['tolerance'], ...who })
        : path === EVENING_CHECK_PATHS.reasons ? await box.explain({ businessDate: body['businessDate'], reasons: body['reasons'], ...who })
          : await box.sign({ businessDate: body['businessDate'], statement: body['statement'], ...who });
    json(res, out.ok ? 200 : out.refusedBecause === 'not_the_named_reconciler' || out.refusedBecause === 'nobody_named_to_reconcile' ? 403 : 422, { ...out, mappings: box.mappings(), days: box.days() });
  };
  /**
   * The counter-label door (OB-288 lane 2). From a page this box served, as JSON. With the office PIN on, only a person
   * signed in who may open the production screen; behind the hosted front, the person it signed in. A box serving its
   * screens openly (no PIN, nobody in front) renders for its own production screen, as it serves that screen openly.
   */
  const labelDoor = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'POST') { req.resume(); json(res, 405, { ok: false, refusedBecause: 'wrong_method', detail: 'send with POST' }); return; }
    if (!sameOrigin(req)) { req.resume(); json(res, 403, { ok: false, refusedBecause: 'not_from_this_screen', detail: 'refused: not from a page this store computer served' }); return; }
    if (!/^application\/json\b/.test(String(req.headers['content-type'] ?? ''))) { req.resume(); json(res, 415, { ok: false, refusedBecause: 'not_json', detail: 'send JSON' }); return; }
    const snap = input.snapshot();
    let userId: string | null = null;
    if (office !== undefined) {
      const session = await office.check(officeTokenOf(req.headers['cookie']));
      if (!session.ok) { req.resume(); json(res, 401, { ok: false, refusedBecause: session.refusedBecause, detail: 'Your office sign-in has ended. Enter your PIN again (open the production screen again). Nothing was printed.' }); return; }
      userId = session.userId;
    } else if (input.trustForwardedUser === true) {
      userId = forwardedUser(req.headers['x-sre-user']);
      if (userId === null) { req.resume(); json(res, 403, { ok: false, refusedBecause: 'no_sign_in', detail: 'Nobody is signed in on this screen. Nothing was printed.' }); return; }
    }
    if (userId !== null) {
      const needs = permissionForScreen('production');
      if (needs !== null && !(permissionsOf(userId, snap.pack) ?? []).includes(needs)) { req.resume(); json(res, 403, { ok: false, refusedBecause: 'not_allowed', detail: `${userId} may not open the production screen. Nothing was printed.` }); return; }
    }
    const raw = await readBody(req, 16 * 1024);
    let parsed: unknown;
    try { parsed = raw === null ? undefined : JSON.parse(raw) as unknown; } catch { parsed = undefined; }
    const request = readCounterLabelRequest(parsed);
    if (request === undefined) { json(res, 400, { ok: false, refusedBecause: 'not_readable_as_a_label', detail: 'A label needs the run, and for a weighed pack its weight in whole grams. Nothing was printed.' }); return; }
    const label = counterLabelFor(snap, request);
    json(res, label.ok ? 200 : 422, label);
  };
  /**
   * OB-388 · ADR-0029: a page's `/v1` call, carried to head office with the person's OWN head-office session — never the
   * box's machine credential, never a PIN. Refused here, in head office's own error shape, when there is no head-office
   * session (401), when the office PIN sign-in (if on) has ended (401) or is another person (403), when the person holds no
   * role at this store (403), or when a write did not come from a page this box served (403).
   */
  const carryToHeadOffice = async (req: IncomingMessage, res: ServerResponse, ho: HeadOfficeLink): Promise<void> => {
    const refuse = (status: number, code: HeadOfficeCallRefusal): void => { req.resume(); send(res, status, 'application/json; charset=utf-8', headOfficeCallRefusal(code)); };
    const write = req.method !== 'GET' && req.method !== 'HEAD';
    if (write && !sameOrigin(req)) { refuse(403, 'not_from_this_screen'); return; }
    let pinUser: string | null = null;
    if (office !== undefined) {
      const pin = await office.check(officeTokenOf(req.headers['cookie']));
      if (!pin.ok) { refuse(401, 'office_sign_in_needed'); return; }
      pinUser = pin.userId;
    }
    const session = await ho.sessionOf(req);
    if (session === null) { refuse(401, 'head_office_sign_in_needed'); return; }
    if (pinUser !== null && pinUser !== session.userId) { refuse(403, 'not_the_signed_in_person'); return; }
    const roles = rolesAtThisStore(session.userId, input.snapshot().pack);
    if (roles === null || roles.length === 0) { refuse(403, 'not_at_this_store'); return; }
    const body = write ? await readBody(req, HEAD_OFFICE_CALL_MAX_BYTES) : null;
    if (write && body === null) { send(res, 413, 'application/json; charset=utf-8', headOfficeCallRefusal('too_large')); return; }
    if (!write) req.resume();
    await ho.carry(req, res, session, body === null ? null : Buffer.from(body, 'utf8'));
  };

  /**
   * OB-424: the seal panel and its `authority.crt`. Read-only. With the office PIN on, for a person signed in to the office
   * screens (anyone who sets up a handheld is); the material itself is public. Nothing to show → the panel says why in
   * words, and the download answers 404 in words: never a made-up seal.
   */
  const sealDoor = async (req: IncomingMessage, res: ServerResponse, path: string, source: () => HandheldSealSource): Promise<void> => {
    req.resume();
    if (req.method !== 'GET' && req.method !== 'HEAD') { send(res, 405, 'text/plain; charset=utf-8', 'the handheld seal is only read'); return; }
    if (office !== undefined) {
      const session = await office.check(officeTokenOf(req.headers['cookie']));
      if (!session.ok) {
        page(res, 401, signInPage({ next: HANDHELD_SEAL_PATHS.page, problem: session.refusedBecause }), session.refusedBecause === 'not_signed_in' ? undefined : officeCookie(undefined));
        return;
      }
    }
    const panel = handheldSealPanel(source());
    if (path !== HANDHELD_SEAL_PATHS.certificate) { page(res, 200, handheldSealPage(panel)); return; }
    if (!panel.ok) {
      send(res, 404, 'text/plain; charset=utf-8', `No seal to download. ${panel.en}\n${panel.ta}\n`);
      return;
    }
    res.setHeader('content-disposition', `attachment; filename="${panel.download.fileName}"`);
    send(res, 200, panel.download.type, panel.certificateDer);
  };

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      // OB-259: the office's two doors — the only writes this socket takes, and only when the gate is on.
      const doorPath = (req.url ?? '/').split('?')[0];
      // OB-388: Sign out on a box with the head-office link also ends the person's head-office session here.
      if (office === undefined && link !== undefined && req.method === 'POST' && doorPath === '/office/sign-out') {
        if (!sameOrigin(req)) { send(res, 403, 'text/plain; charset=utf-8', 'refused: not from a page this store computer served'); return; }
        await link.end(req);
        res.writeHead(303, { location: '/manager/', 'set-cookie': 'sre_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
        res.end();
        return;
      }
      if (office !== undefined && req.method === 'POST' && (doorPath === '/office/sign-in' || doorPath === '/office/sign-out')) {
        if (!sameOrigin(req)) { send(res, 403, 'text/plain; charset=utf-8', 'refused: not from a page this store computer served'); return; }
        if (doorPath === '/office/sign-out') {
          await office.signOut(officeTokenOf(req.headers['cookie']));
          await link?.end(req); // OB-388: the head-office session on this PC ends with the office sign-in
          res.setHeader('set-cookie', [officeCookie(undefined), 'sre_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict']);
          send(res, 200, 'text/html; charset=utf-8', signInPage({ next: '/manager/' }));
          return;
        }
        const body = await readBody(req, 4096);
        const form = readSignInForm(body ?? '');
        const next = safeNext(form.next);
        const outcome = await office.signIn({ staffId: form.staffId, pin: form.pin });
        if (!outcome.ok) {
          page(res, outcome.refusedBecause === 'not_an_office_role' ? 403 : outcome.refusedBecause === 'locked' ? 429 : 401, signInPage({ next, problem: outcome.refusedBecause }), officeCookie(undefined));
          return;
        }
        res.writeHead(303, { location: next, 'set-cookie': officeCookie(outcome.token), 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
        res.end();
        return;
      }
      // OB-263: the evening check's doors (the day's figures, the mapping, the load, the reasons, the signature).
      if ((Object.values(EVENING_CHECK_PATHS) as string[]).includes(doorPath ?? '')) {
        await eveningDoor(req, res, doorPath!);
        return;
      }
      // OB-288 lane 2 · M11-FR-03: the counter label, rendered here from what this box holds (works offline).
      if (doorPath === PRODUCTION_LABEL_PATH) {
        await labelDoor(req, res);
        return;
      }
      // OB-380 · P-08: a page's same-origin call to head office that nothing in front of this box carried there. The box
      // holds no head-office answer and never makes one up (no copy, no blank list, no "refused"): the call fails as a lost
      // link, exactly as it does when the line is down, so every page says in its OWN tested words, in English or Tamil,
      // that head office cannot be reached and nothing on it is current.
      // OB-388: the head-office sign-in doors (`/login/`, `/login/callback`, `/login/logout`) — the product's own sign-in.
      if (link !== undefined && link.isSignInPath(doorPath ?? '')) {
        if (req.method === 'POST' && !sameOrigin(req)) { req.resume(); send(res, 403, 'text/plain; charset=utf-8', 'refused: not from a page this store computer served'); return; }
        req.resume();
        await link.signInDoor(req, res);
        return;
      }
      if (isHeadOfficeCall(doorPath)) {
        if (link === undefined) {
          req.resume();
          req.socket.destroy();
          return;
        }
        await carryToHeadOffice(req, res, link);
        return;
      }
      // OB-424 · ADR-0030: the handheld seal — public material only, on this loopback socket only.
      if (input.handheldSeal !== undefined && (doorPath === HANDHELD_SEAL_PATHS.page || doorPath === HANDHELD_SEAL_PATHS.page.slice(0, -1) || doorPath === HANDHELD_SEAL_PATHS.certificate)) {
        await sealDoor(req, res, doorPath, input.handheldSeal);
        return;
      }
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
      // OB-259: on the store PC every screen but the till opens only for a person who typed their own PIN, holds an office
      // role here, and (for a screen in the menu) holds that screen's own permission. Then it runs AS that person.
      let officeUser: { readonly userId: string; readonly displayName: string; readonly expiresAt: string } | null = null;
      if (office !== undefined && !OPEN_SCREENS.includes(route.screen)) {
        const session = await office.check(officeTokenOf(req.headers['cookie']));
        if (!session.ok) {
          page(res, 401, signInPage({ next: safeNext(req.url), problem: session.refusedBecause }), session.refusedBecause === 'not_signed_in' ? undefined : officeCookie(undefined));
          return;
        }
        if (!mayOpenScreen(route.screen, permissionsOf(session.userId, snap.pack))) { // R10-A · OB-543: any word that opens it
          const menu = navigationPayload({ screen: route.screen, pack: snap.pack, payload: { userId: session.userId }, screenOf: screenOfPath });
          page(res, 403, notAllowedPage({ displayName: session.displayName, links: menu.groups.flatMap((g) => g.items.map((i) => ({ path: i.path, label: i.label }))) }));
          return;
        }
        officeUser = session;
      }
      // OB-388 · ADR-0029: an office page head office answers opens only for a person signed in to head office on this PC
      // with their own login and second step — the SAME person as the office PIN sign-in, when that is on. With nobody
      // signed in to head office the box sends them to the sign-in (which says plainly when head office cannot be reached).
      let headOfficeUser: string | null = null;
      if (link !== undefined && isHeadOfficePage(route.screen)) {
        const ho = await link.sessionOf(req);
        if (ho === null) {
          res.writeHead(303, { location: `/login/?next=${encodeURIComponent(safeNext(req.url))}`, 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' });
          res.end();
          return;
        }
        if (officeUser !== null && officeUser.userId !== ho.userId) {
          page(res, 403, headOfficeSignInPage({ problem: 'not_the_same_person', next: safeNext(req.url) }));
          return;
        }
        if (officeUser === null) {
          if (!mayOpenScreen(route.screen, permissionsOf(ho.userId, snap.pack))) { // R10-A · OB-543
            const menu = navigationPayload({ screen: route.screen, pack: snap.pack, payload: { userId: ho.userId }, screenOf: screenOfPath });
            page(res, 403, notAllowedPage({ displayName: ho.userId, links: menu.groups.flatMap((g) => g.items.map((i) => ({ path: i.path, label: i.label }))) }));
            return;
          }
        }
        headOfficeUser = ho.userId;
      }
      // SEC-1 (P-04 least privilege): behind the authenticating front (the hosted copy, `trustForwardedUser`), the person
      // the front signed in is held to the SAME per-screen rule as the PIN and head-office paths above — every screen but
      // the till and the customer-facing lanes, whatever app it is (the owner's figures too). A person who may not open it
      // gets the same refusal page and status, carrying none of this box's figures; with nobody named, a gated screen is
      // refused outright rather than served as whoever the pack named.
      if (officeUser === null && headOfficeUser === null && input.trustForwardedUser === true && !OPEN_SCREENS.includes(route.screen)) {
        const front = forwardedUser(req.headers['x-sre-user']);
        if (!mayOpenScreen(route.screen, front === null ? null : permissionsOf(front, snap.pack))) {
          const menu = front === null ? null : withPublicPrefix(navigationPayload({ screen: route.screen, pack: snap.pack, payload: { userId: front }, screenOf: screenOfPath }), forwardedPrefix(req.headers['x-forwarded-prefix']));
          page(res, 403, notAllowedPage({
            displayName: front === null ? 'Nobody signed in' : displayNameIn(snap.pack, front),
            links: menu === null ? [] : menu.groups.flatMap((g) => g.items.map((i) => ({ path: i.path, label: i.label }))),
          }));
          return;
        }
      }
      // OB-16: behind the authenticated relay the ERP screens run as the person who SIGNED IN — their id, their
      // permissions from this box's role register — never as whoever the pack named for the screen. The till is
      // untouched: the person signs in at the till itself.
      // DF-3-c (OB-30 "A"): so do the phone screens served here (the hosted copy) — the job is done as the person the
      // front signed in, exactly as a phone on the shop wifi does it as the person who signed in on it with their PIN.
      const handheld = isHandheldSource(route.screen) ? route.screen : null;
      const signedIn = officeUser !== null ? officeUser.userId
        : headOfficeUser !== null ? headOfficeUser
        : input.trustForwardedUser === true && (APP_SHELL[route.screen].dir === 'web-erp' || handheld !== null) ? forwardedUser(req.headers['x-sre-user']) : null;
      const built = payloadFor(route.screen, snap, handheld !== null && signedIn !== null ? signedIn : undefined);
      const payload = signedIn === null ? built : handheld !== null ? asPhoneHolder(handheld, built, signedIn) : asSignedInPerson(built, signedIn, snap.pack);
      // The till alone also gets the receipt template head office published, when this box has pulled one
      // (M01-FR-02): its own global beside the catalogue, so a bill printed offline carries the words and the
      // version. Absent when none has reached this box — the till prints with its defaults and stamps nothing.
      // OB-288 P6: the self-checkout lane IS a till the customer operates, so it is served exactly what the till is.
      const tillShell = TILL_SHELL_SCREENS.has(route.screen);
      const receiptTemplate = tillShell ? posReceiptTemplate(snap) : undefined;
      // The till alone is also told which lane it IS and when the shop's day ends (SP-4b · F09) — never who the cashier
      // is; the person signs in at the till.
      const posLane = tillShell
        ? {
          ...posLanePayload(snap, input.laneId), ...(input.soldHuids === undefined ? {} : { soldHuids: input.soldHuids() }),
          // OB-252: guest sales only — the till shows it whenever it is on, and takes no customer number or loyalty.
          ...(input.guestSalesOnly === undefined ? {} : { guestSalesOnly: input.guestSalesOnly() }),
          // OB-271: real trading (off during the mirror pilot), the shop's legal identity for the tax invoice, the paper.
          ...(input.realTrading === undefined ? {} : ((rt) => ({
            realTrading: { on: rt.on, by: rt.by }, taxInvoice: rt.taxInvoice, ...(rt.billPaper === undefined ? {} : { billPaper: rt.billPaper }),
          }))(input.realTrading())),
        }
        : undefined;
      // And the refund policy its store pack carries (SP-9b-i · M13-FR-01): the approval threshold and the no-receipt
      // cap. Absent when the box holds none — the till then offers no return without a receipt, rather than guessing a cap.
      const posRefundPolicy = tillShell ? posRefundPolicyPayload(snap) : undefined;
      // Every ERP page also gets its menu — the screens THIS viewer may open on THIS box, worked out per request
      // from the pack's role register and the screen's named viewer (Stage G slice 5b · §27 · P-07). Only the ERP:
      // the till, the handhelds and the apps are one job each and have no menu to draw.
      const navigation = APP_SHELL[route.screen].dir === 'web-erp'
        ? withPublicPrefix(navigationPayload({ screen: route.screen, pack: snap.pack, payload: payload ?? (signedIn === null ? null : { userId: signedIn }), screenOf: screenOfPath }), forwardedPrefix(req.headers['x-forwarded-prefix']))
        : undefined;
      const served = injectPayload(
        body.toString('utf8'), GLOBAL_FOR[route.screen], payload,
        {
          // OB-259: who is signed in to the office screens, and until when — the box draws the Sign out bar from it.
          ...(officeUser === null ? {} : signedInGlobals(officeUser)),
          // OB-388: with no office PIN on this box, the head-office sign-in names who is looking — and draws the Sign out bar.
          ...(officeUser !== null || headOfficeUser === null ? {} : signedInGlobals({ userId: headOfficeUser, displayName: displayNameIn(snap.pack, headOfficeUser), expiresAt: '' })),
          catalogueFreshness: catalogueFreshness(snap),
          // OB-606: the shop's zone from this box's SIGNED store pack (else the shop default) — every page dates "today",
          // a month and a shown date by it (packages/calendar shop-day), never by its device's own zone; no network call.
          shopTimeZone: packTimeZone(snap.pack),
          // Round A (P-08): when head office last sent this box the store setup every office page's figures come from — the
          // page's chrome says "the store computer's copy, as head office last sent it at …, N old" wherever a page asks.
          ...(APP_SHELL[route.screen].dir !== 'web-erp' ? {} : { storeCopy: storeCopyOf(snap) }),
          ...(receiptTemplate === undefined ? {} : { posReceiptTemplate: receiptTemplate }),
          ...(posLane === undefined ? {} : { posLane }),
          ...(posRefundPolicy === undefined ? {} : { posRefundPolicy }),
          // OB-288 P6: the owner's self-checkout watch numbers / the kiosk's "stop quoting after" — only when set (P-08).
          ...customerFacingGlobals(route.screen, snap.pack.policies.known ? snap.pack.policies.value : undefined),
          ...(navigation === undefined ? {} : { sreNavigation: navigation }),
          // The one write a screen makes back to the box: the manager's day close (M14-FR-04). Only
          // present when this box serves a lane socket to post to; the screen falls back to read-only
          // (a local preview) when it is absent.
          ...(input.laneWriteBase === undefined ? {} : { laneWriteBase: input.laneWriteBase }),
        },
      );
      // The Sign out bar goes on every office page, drawn by the box, just before the page's own end.
      const barred = officeUser !== null || headOfficeUser !== null;
      send(res, 200, type, !barred ? served : served.includes('</body>') ? served.replace('</body>', `${SIGN_OUT_BAR}</body>`) : `${served}${SIGN_OUT_BAR}`);
    })();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Loopback unless a deployment names another address explicitly — see the note on SCREEN_HOST.
    server.listen(input.port, input.host ?? SCREEN_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : input.port;
      // OB-388: the head-office sign-in returns to THIS PC's own screen address (the person's browser is on this PC).
      if (input.headOffice !== undefined) link = input.headOffice(`http://127.0.0.1:${port}`);
      resolve({
        port,
        host: input.host ?? SCREEN_HOST,
        // Stop accepting, then drop the connections still open (see the lane server's stop for why).
        stop: () => new Promise((done) => { server.close(() => { done(); }); server.closeAllConnections(); }),
      });
    });
  });
}
