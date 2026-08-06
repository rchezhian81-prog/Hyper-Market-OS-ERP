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
import { GLOBAL_FOR, SCREENS, payloadFor, type ScreenInput, type ScreenName } from './screen-data';

/** The one address this may listen on. Named so a test can assert on it. */
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
});

export interface ScreenServer {
  readonly port: number;
  stop(): Promise<void>;
}

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
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

/** Put a screen's payload into its shell at the marked point. */
export function injectPayload(html: string, global: string, payload: unknown): string {
  if (payload === null) return html; // nothing to say; the shell already handles being told nothing
  return html.replace(DATA_MARKER, `<script>window.${global} = ${embed(payload)};</script>`);
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
export function redirectFor(url: string): string | null {
  const [path, query] = url.split('?');
  const parts = (path ?? '').split('/').filter((p) => p !== '');
  if (parts.length !== 1) return null;
  const name = parts[0]!;
  if (!(SCREENS as readonly string[]).includes(name)) return null;
  if ((path ?? '').endsWith('/')) return null;
  return `/${name}/${query === undefined ? '' : `?${query}`}`;
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
  /** Where `apps/` lives on this box. */
  readonly appsDir: string;
  /** Called per request, so every screen reload gets the CURRENT day rather than boot-time state. */
  readonly snapshot: () => ScreenInput;
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
      // o'clock's exceptions, not the ones this process saw when it started.
      const payload = payloadFor(route.screen, input.snapshot());
      send(res, 200, type, injectPayload(body.toString('utf8'), GLOBAL_FOR[route.screen], payload));
    })();
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    // Loopback only. Not `0.0.0.0`, not the LAN address — see the note at the top of this file.
    server.listen(input.port, SCREEN_HOST, () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : input.port;
      resolve({
        port,
        stop: () => new Promise((done) => { server.close(() => { done(); }); }),
      });
    });
  });
}
