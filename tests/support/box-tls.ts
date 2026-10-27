// Tests talk to the store computer's handheld door the way an ENROLLED device does (OB-422 · ADR-0030): over https,
// trusting the store computer's own authority — never by switching certificate checks off.
//
//   • `deviceBase(edge)`        the door's https origin; remembers that box's authority for `trustTheBoxes`
//   • `trustTheBoxes(fetch)`    a fetch that, for a door `deviceBase` named, checks the certificate against THAT box's
//                               authority (node:https with `ca`); every other URL goes to the fetch it wraps
//   • `trustingFetch(pem)`      the same, for one authority, for a test that holds the PEM itself
//   • `sharedDeviceTls()`       one authority for a browser test file (its key pin goes on Chromium's command line, the
//                               way a handheld that installed the authority trusts it); every edge in the file uses it
//   • `trustingBrowserArgs(pin)` Chromium's flag that trusts exactly that authority's key — nothing else

import { request } from 'node:https';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureDeviceTls } from '../../edge/store-edge/src/device-tls';
import type { DeviceServer } from '../../edge/store-edge/src/device-server';

const trusted = new Map<string, string>();

/** The door's https origin on this computer, and the box's authority remembered for `trustTheBoxes`. */
export function deviceBase(edge: { readonly devices: DeviceServer | null }): string {
  const devices = edge.devices;
  if (devices === null) throw new Error('this edge has no device socket');
  const base = `https://127.0.0.1:${devices.port}`;
  trusted.set(base, devices.authority().pem);
  return base;
}

type Init = RequestInit;
const NULL_BODY = new Set([101, 204, 205, 304]);

async function bodyBytes(body: RequestInit['body']): Promise<Buffer | undefined> {
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body instanceof URLSearchParams) return Buffer.from(body.toString(), 'utf8');
  if (body instanceof ArrayBuffer) return Buffer.from(body);
  if (ArrayBuffer.isView(body)) return Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  return Buffer.from(await new Response(body as ConstructorParameters<typeof Response>[0]).arrayBuffer());
}

function once(url: URL, init: Init, ca: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    void (async () => {
      const headers = new Headers(init.headers);
      if ((init.body instanceof URLSearchParams) && !headers.has('content-type')) headers.set('content-type', 'application/x-www-form-urlencoded;charset=UTF-8');
      const payload = await bodyBytes(init.body);
      if (payload !== undefined) headers.set('content-length', String(payload.length));
      const req = request(url, { method: init.method ?? 'GET', headers: Object.fromEntries(headers.entries()), ca, minVersion: 'TLSv1.2' }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const out = new Headers();
          for (let i = 0; i < res.rawHeaders.length; i += 2) out.append(res.rawHeaders[i]!, res.rawHeaders[i + 1]!);
          const status = res.statusCode ?? 500;
          const response = new Response(NULL_BODY.has(status) ? null : Buffer.concat(chunks), { status, statusText: res.statusMessage ?? '', headers: out });
          Object.defineProperty(response, 'url', { value: url.toString() });
          resolve(response);
        });
        res.on('error', reject);
      });
      req.on('error', reject);
      if (init.signal !== undefined && init.signal !== null) init.signal.addEventListener('abort', () => { req.destroy(new Error('aborted')); });
      req.end(payload);
    })().catch(reject);
  });
}

/** A fetch for https URLs checked against `ca`; follows redirects unless `redirect: 'manual'`, as fetch does. */
async function fetchTrusting(input: string | URL, init: Init, ca: string): Promise<Response> {
  let url = new URL(String(input));
  let current: Init = init;
  for (let hop = 0; hop < 10; hop += 1) {
    const res = await once(url, current, ca);
    const location = res.headers.get('location');
    if (current.redirect === 'manual' || location === null || res.status < 300 || res.status > 399) {
      if (hop > 0) Object.defineProperty(res, 'redirected', { value: true });
      return res;
    }
    url = new URL(location, url);
    const method = (current.method ?? 'GET').toUpperCase();
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && method === 'POST')) {
      const headers = new Headers(current.headers);
      headers.delete('content-type'); headers.delete('content-length');
      current = { ...current, method: 'GET', body: undefined, headers };
    }
  }
  throw new TypeError('too many redirects');
}

/** One authority's fetch: https checked against `authorityPem`; anything else goes to `fallback`. */
export function trustingFetch(authorityPem: string, fallback: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: string | URL | Request, init: Init = {}) => {
    const href = input instanceof Request ? input.url : String(input);
    return href.startsWith('https://') ? fetchTrusting(href, init, authorityPem) : fallback(input as string, init);
  }) as typeof fetch;
}

/** A fetch that trusts each door `deviceBase` has named by ITS box's authority; every other URL goes to `fallback`. */
export function trustTheBoxes(fallback: typeof fetch = globalThis.fetch): typeof fetch {
  return ((input: string | URL | Request, init: Init = {}) => {
    const href = input instanceof Request ? input.url : String(input);
    const origin = href.startsWith('https://') ? new URL(href).origin : undefined;
    const ca = origin === undefined ? undefined : trusted.get(origin);
    return ca === undefined ? fallback(input as string, init) : fetchTrusting(href, init, ca);
  }) as typeof fetch;
}

/** One authority (and door certificate) for a test file, made the way the installer makes it. */
export async function sharedDeviceTls(): Promise<{ readonly dir: string; readonly keyPin: string; readonly authorityPem: string }> {
  const dir = join(await mkdtemp(join(tmpdir(), 'sre-device-tls-')), 'device-tls');
  const made = ensureDeviceTls({ dir, addresses: ['127.0.0.1'], now: new Date() });
  if (!made.ok) throw new Error(made.problem);
  return { dir, keyPin: made.tls.authorityKeyPin, authorityPem: made.tls.authorityPem };
}

/** Chromium trusts exactly this authority's key (a handheld that installed it at enrolment) — not "ignore errors". */
export const trustingBrowserArgs = (keyPin: string): string[] => [`--ignore-certificate-errors-spki-list=${keyPin}`];
