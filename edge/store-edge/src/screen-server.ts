// The socket the six screens are served from — ADR-0004, §31, P-01.
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

/** Which folder under `apps/` holds each screen's shell. */
export const APP_DIR: Readonly<Record<ScreenName, string>> = Object.freeze({
  pos: 'pos',
  manager: 'web-erp',
  owner: 'owner-app',
  picker: 'picker-app',
  driver: 'delivery-app',
  customer: 'customer-app',
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

/** `/manager/app.js` → `{ screen: 'manager', file: 'app.js' }`, or null if it is not a screen path. */
export function routeOf(url: string): { readonly screen: ScreenName; readonly file: string } | null {
  const [path] = url.split('?');
  const parts = (path ?? '').split('/').filter((p) => p !== '');
  const screen = parts[0];
  if (screen === undefined || !(SCREENS as readonly string[]).includes(screen)) return null;
  const file = parts.slice(1).join('/');
  return { screen: screen as ScreenName, file: file === '' ? 'index.html' : file };
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

      const onDisk = join(input.appsDir, APP_DIR[route.screen], 'web', file);
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
