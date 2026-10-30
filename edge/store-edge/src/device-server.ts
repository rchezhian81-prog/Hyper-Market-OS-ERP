// The store box's DEVICE socket — the one door a handheld on the shop wifi may use (SP-3a · ADR-0019 · S1 · F11's
// handheld half · hard rules #1/#4/#6/#10).
//
// ── Why a second socket, and why it is not the lane socket ─────────────────
//
// The lane socket binds to loopback and MUST (ADR-0004): anything on the shop LAN could otherwise write to it, and a
// guest's phone on the shop wifi is on the shop LAN. The screens server binds to loopback too, because it carries the
// day's takings. Neither can be widened for the handhelds without giving every device on the wifi the till's write
// path and the owner's figures. So the handhelds get their own socket, which:
//
//   • serves ONLY the handheld shells (warehouse, picker, driver) with their served data, and the three device routes
//     — `POST /lane/outbox`, `GET /lane/outbox/status`, `GET /lane/sync-status` — the SAME paths the loopback lane
//     socket serves, so the shared drain (`packages/sync/device-drain.ts`) and the shells' badges work unchanged with
//     `window.laneWriteBase = ''` (same origin). It never serves the till, the manager, the owner or any ERP screen;
//   • lets nothing through without a DEVICE CREDENTIAL: an HttpOnly, SameSite=Strict cookie the box minted when the
//     handheld enrolled with the one-time code head office issued for it (`device-enrolments.ts`). Every request —
//     the shell itself included — is checked against the register AND against the pack's fleet register, so a device
//     head office blocks is refused at its next request. An unenrolled browser is sent to the enrolment page and
//     nothing else;
//   • constrains the batch's `source` to a handheld surface: a warehouse device cannot speak as `manager` and slip an
//     approval decision or a whole receipt through under its own credential;
//   • binds to loopback unless a deployment names the shop's address (`EDGE_DEVICE_HOST`) — "never widens by itself",
//     and the boot log says in words when it has;
//   • speaks TLS ONLY (OB-422 · ADR-0030): its certificate is signed by the store computer's own authority
//     (`device-tls.ts`), which each device trusts once, at enrolment. A plain-http request on the port is answered with a
//     refusal in words (426) and closed — nothing in it is read. Its cookies are `Secure`, so a browser never sends them
//     in the clear. The lane socket and the screens server stay plain on the PC's own loopback (hard rule #1: the till's
//     sale path is untouched).
//
// The socket carries; the box decides (`relayDeviceEvents`, the allow-list, the dedupe set, the fsync'd log live in
// main.ts). Same origin means no CORS at all: a cross-site page cannot send the cookie (SameSite=Strict) and cannot
// read a reply.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer as createTlsServer, type Server } from 'node:https';
import { createServer as createFrontServer, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { APP_SHELL, routeOf, redirectFor, safeFile, injectPayload } from './screen-server';
import { GLOBAL_FOR, payloadFor, catalogueFreshness, type ScreenInput, type ScreenName } from './screen-data';
import {
  readRelayBatch, readRelayItem, isHandheldSource, isRelayable, DEVICE_OUTBOX_PATH, DEVICE_OUTBOX_STATUS_PATH,
  type BoxItemStatus, type DeviceAck, type HandheldSource, type RelayReply,
} from '../../../packages/sync/src/device-relay';
import type { DeviceEnrolments, PackDevice } from './device-enrolments';
import type { LaneSyncStatus } from './sync-status';
import { deviceLaneOf, sessionHoursFor, type CheckOutcome, type SignInOutcome, type StampVerdict } from './till-operators';
import type { SignInStamp } from '../../../packages/sync/src/sign-in-stamp';
import type { DomainEvent } from '../../../packages/contracts/src/event';
import {
  HANDHELD_AUTHORITY, signInEndedMessageFor, asPhoneHolder, personNamedBy, phoneHolderStrip, phoneSignInPage, signInLockOf, withPhoneHolderStrip,
} from './handheld-sign-in';
import { packTimeZone } from './shop-zone'; // OB-606/607 (R16-A): the handhelds date and time by the pack's zone
import type { QueuePosDoor } from './queue-pos-door'; // D04-FR-05 queue-busting (OB-288 Pkg 6b): the queue till's door
import { ensureDeviceTls, sayDeviceTlsEvent, RENEW_CHECK_MS, type DeviceTlsEvent, type DeviceTlsMaterial } from './device-tls'; // OB-422: TLS only

/** Loopback unless a deployment names the shop's address explicitly — the device socket never widens by itself. */
export const DEVICE_HOST = '127.0.0.1';
/** The only screens this socket serves. A handheld is one job each; nothing here shows takings or approvals. */
export const HANDHELD_SCREENS: readonly ScreenName[] = ['warehouse', 'picker', 'driver'];
export const DEVICE_COOKIE = 'sre_device';
export const DEVICE_ENROL_ROUTE = '/device/enrol';
export const DEVICE_SYNC_STATUS_ROUTE = '/lane/sync-status';
/** DF-3-c (OB-30 "A"): the person holding the phone signs in here with their staff ID and the till PIN, and out again. */
export const PHONE_SIGN_IN_ROUTE = '/device/sign-in';
export const PHONE_SIGN_OUT_ROUTE = '/device/sign-out';
/**
 * The phone holder's session: HttpOnly, SameSite=Strict, the box keeps only its hash. As long as the sign-in: four hours on
 * the warehouse and picker screens (OB-184), twelve on the driver's (OB-187).
 */
export const OPERATOR_COOKIE = 'sre_operator';
const operatorCookieSeconds = (deviceId: string, screen: HandheldSource): number => sessionHoursFor(deviceLaneOf(deviceId), HANDHELD_AUTHORITY[screen]) * 3600;

/**
 * Who is holding the phone (DF-3-c · OB-30 "A"): the box's till register, addressed by the DEVICE. Absent → nobody can
 * sign in on a phone, so no phone screen is served and no phone record is taken (fail closed).
 */
export interface PhoneOperators {
  signIn(input: { readonly staffId: string; readonly pin: string; readonly deviceId: string; readonly authority: string }): Promise<SignInOutcome>;
  check(token: string | undefined, deviceId: string): CheckOutcome;
  signOut(token: string | undefined): Promise<boolean>;
  /** Has this person held this phone — now, or within the last shift (the box's own log and clock)? */
  heldRecently(userId: string, deviceId: string): boolean;
  /** OB-180: the live sign-in's stamp reference and key, for the served page — null when nobody is signed in. */
  stampFor(token: string | undefined, deviceId: string): { readonly ref: string; readonly key: string; readonly userId: string; readonly signedInAt: string; readonly expiresAt: string } | null;
  /** OB-180: is this record's sign-in stamp one this box made, on this phone, for its person, while it was valid? */
  verifyStamp(stamp: SignInStamp, event: DomainEvent, deviceId: string): StampVerdict;
}

/** The handheld screen a sign-in is for — one of the three, or the warehouse's when nothing (or nonsense) was named. */
export function phoneScreenOf(requested: unknown): HandheldSource {
  return typeof requested === 'string' && isHandheldSource(requested) ? requested : 'warehouse';
}
/**
 * Where a freshly enrolled device is sent. The screen it ASKED for when it was turned away (`?next=/picker/`, carried by the
 * redirect and posted back by the enrolment page) — validated against the handheld screens this socket serves, so the
 * enrolment page can never send a device to a page that is not a handheld's; the warehouse shell when nothing was asked.
 */
const HOME_AFTER_ENROL = '/warehouse/';
export function homeAfterEnrol(requested: unknown): string {
  if (typeof requested !== 'string') return HOME_AFTER_ENROL;
  // D04-FR-05: the queue till's page (its own door, served only while its switch is on).
  if (requested.split('?')[0] === '/queue-pos/') return '/queue-pos/';
  const route = routeOf(requested);
  if (route === null || !HANDHELD_SCREENS.includes(route.screen) || route.file !== 'index.html') return HOME_AFTER_ENROL;
  return `/${route.screen}/`;
}

/** A device's batch, with the device this socket authenticated it from — the box logs who handed what. */
export type DeviceRelayHandler = (batch: {
  readonly source: string; readonly items: readonly unknown[]; readonly deviceId: string; readonly phoneHolder?: string;
  /** OB-180: per item key, the person whose sign-in stamp on it this socket verified (made on this phone, while valid). */
  readonly stampedBy?: Readonly<Record<string, string>>;
}) => Promise<RelayReply>;
export type DeviceStatusHandler = (keys: readonly string[]) => readonly BoxItemStatus[];

export interface DeviceServer {
  readonly port: number;
  readonly host: string;
  /** OB-422: always `https` — the door speaks TLS only; a plain-http request is refused in words. */
  readonly scheme: 'https';
  /** The authority enrolled devices trust (public): its certificate, its fingerprint, its key pin. Never a private key. */
  authority(): { readonly pem: string; readonly fingerprint: string; readonly keyPin: string; readonly notAfter: string };
  /** The door's certificate right now: its fingerprint, its end, the addresses it covers. */
  certificate(): { readonly fingerprint: string; readonly notAfter: string; readonly addresses: readonly string[] };
  /**
   * Check the door's certificate against `at` and renew it when due (`ensureDeviceTls`); a renewed one is put in place for
   * the next connection without closing the door. Returns what changed, or the problem in words (the old one stays).
   */
  renew(at: Date): { readonly ok: true; readonly events: readonly DeviceTlsEvent[] } | { readonly ok: false; readonly problem: string };
  stop(): Promise<void>;
}

/** The words a plain-http request to the door gets, before it is closed. Nothing is read from it and nothing is served. */
export const PLAIN_HTTP_REFUSAL = [
  'This is the store computer\'s handheld door. It speaks https only (OB-422): plain http on the shop network is refused.',
  'Open it as https://<the store computer\'s address>:<port>/ on a handheld that trusts this store computer (in-store install runbook, Step 6).',
  'இது கடை கணினியின் கைக்கருவி வாசல். https மட்டுமே — சாதாரண http மறுக்கப்படுகிறது.',
  '',
].join('\n');

const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
});

const SECURITY_HEADERS = Object.freeze({
  'x-frame-options': 'DENY',
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
});

const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), ...SECURITY_HEADERS, ...extra });
  res.end(body);
};
const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void =>
  send(res, status, 'application/json', JSON.stringify(body), extra);
const redirect = (res: ServerResponse, location: string): void => {
  res.writeHead(302, { location, ...SECURITY_HEADERS });
  res.end();
};

/** One cookie's value from the header, or undefined. */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

/** A browser navigating (it will follow a redirect to the enrolment page) rather than a script fetching JSON. */
const wantsHtml = (req: IncomingMessage): boolean => (req.headers.accept ?? '').includes('text/html');

/** Read a small JSON body under a cap; `undefined` when it was too large or not JSON (the caller answers). */
function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<{ readonly ok: true; readonly body: unknown } | { readonly ok: false; readonly reason: 'too_large' | 'not_json' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes && !done) { done = true; resolve({ ok: false, reason: 'too_large' }); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (done) return;
      done = true;
      try { resolve({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown }); } catch { resolve({ ok: false, reason: 'not_json' }); }
    });
    req.on('error', () => { if (!done) { done = true; resolve({ ok: false, reason: 'not_json' }); } });
  });
}

/**
 * The enrolment page: two fields and one button, English and Tamil, no framework. A one-time setup step done by the
 * supervisor with the code head office issued — so, unlike the handheld's working screens, typing is the point here.
 * The refusal shown is the box's own sentence; the code itself is never echoed back.
 */
export function enrolPage(why: string | null, next: string | null = null): string {
  const notice = why === null ? '' : `<p class="notice" role="status">${escapeHtml(WHY_WORDS[why] ?? 'This handheld must be enrolled before it can be used. · இந்த கருவியைப் பயன்படுத்த முன் பதிவு செய்ய வேண்டும்.')}</p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Enrol this handheld · கருவியைப் பதிவு செய்</title>
<style>
  body{margin:0;font:17px/1.45 system-ui,sans-serif;background:#0f172a;color:#f8fafc;display:grid;place-items:center;min-height:100dvh}
  main{width:min(480px,92vw);display:grid;gap:14px;padding:20px}
  h1{font-size:22px;margin:0}h1 small{display:block;font-size:15px;color:#cbd5e1;font-weight:400}
  label{display:grid;gap:6px;font-weight:600}label small{color:#cbd5e1;font-weight:400}
  input{font:inherit;padding:14px;border-radius:12px;border:2px solid #334155;background:#1e293b;color:#f8fafc;min-height:56px}
  input:focus-visible{outline:3px solid #fbbf24;outline-offset:2px}
  button{font:inherit;font-weight:700;min-height:64px;border:0;border-radius:14px;background:#22c55e;color:#052e16;font-size:19px}
  .notice{margin:0;padding:12px 14px;border-radius:12px;background:#7f1d1d;color:#fee2e2}
  .ok{background:#14532d;color:#dcfce7}
</style></head><body><main>
  <h1>Enrol this handheld<small>இந்தக் கருவியைக் கடை கணினியில் பதிவு செய்யவும்</small></h1>
  ${notice}
  <form id="f">
    <label>Device id <small>கருவி அடையாளம் — head office's label for this handheld</small><input id="deviceId" name="deviceId" autocomplete="off" autocapitalize="none" required></label>
    <label>Enrolment code <small>பதிவு குறியீடு — the one-time code head office issued</small><input id="code" name="code" autocomplete="one-time-code" autocapitalize="characters" required></label>
    <button type="submit">Enrol · பதிவு செய்</button>
  </form>
  <p class="notice" id="out" hidden role="alert"></p>
  <script>
    document.getElementById('f').addEventListener('submit', async (e) => {
      e.preventDefault();
      const out = document.getElementById('out');
      out.hidden = true; out.className = 'notice';
      const body = { deviceId: document.getElementById('deviceId').value.trim(), code: document.getElementById('code').value.trim(), next: ${JSON.stringify(homeAfterEnrol(next))} };
      try {
        const res = await fetch(${JSON.stringify(DEVICE_ENROL_ROUTE)}, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), credentials: 'same-origin' });
        const reply = await res.json();
        if (reply.enrolled) { out.className = 'notice ok'; out.textContent = 'Enrolled. Opening the handheld… · பதிவு முடிந்தது.'; out.hidden = false; location.assign(reply.next); return; }
        out.textContent = (reply.why || 'This handheld could not be enrolled.') + ' · பதிவு செய்ய முடியவில்லை.';
      } catch { out.textContent = 'The store computer did not answer. · கடை கணினி பதிலளிக்கவில்லை.'; }
      out.hidden = false;
    });
  </script>
</main></body></html>`;
}

const WHY_WORDS: Readonly<Record<string, string>> = Object.freeze({
  no_credential: 'This handheld has not been enrolled on this store computer yet. · இந்தக் கருவி இன்னும் பதிவு செய்யப்படவில்லை.',
  not_enrolled: 'This handheld has not been enrolled on this store computer yet. · இந்தக் கருவி இன்னும் பதிவு செய்யப்படவில்லை.',
  credential_malformed: 'The device credential could not be read — enrol again. · மீண்டும் பதிவு செய்யவும்.',
  token_wrong: 'This handheld’s credential does not match the store computer’s record — enrol again. · மீண்டும் பதிவு செய்யவும்.',
  revoked: 'This handheld’s enrolment was withdrawn on this store computer. · இந்தக் கருவியின் பதிவு திரும்பப் பெறப்பட்டது.',
  device_unknown: 'Head office no longer lists this handheld for this shop. · தலைமை அலுவலகம் இந்தக் கருவியை இனி பட்டியலிடவில்லை.',
  device_not_active: 'Head office has blocked or retired this handheld. · தலைமை அலுவலகம் இந்தக் கருவியைத் தடுத்துள்ளது.',
  no_devices_register: 'This store computer has not been told which handhelds belong to the shop. · கடை கணினிக்கு கருவிப் பட்டியல் வரவில்லை.',
});

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c));
}

/** A small form body (`application/x-www-form-urlencoded`) or JSON, as fields. */
async function readFormOrJson(req: IncomingMessage, maxBytes: number): Promise<Record<string, string> | null> {
  const type = (req.headers['content-type'] ?? '').toLowerCase();
  if (type.startsWith('application/json')) {
    const read = await readJsonBody(req, maxBytes);
    if (!read.ok || read.body === null || typeof read.body !== 'object') return null;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(read.body as Record<string, unknown>)) if (typeof v === 'string') out[k] = v;
    return out;
  }
  if (!type.startsWith('application/x-www-form-urlencoded')) { req.resume(); return null; }
  const raw = await new Promise<string | null>((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size > maxBytes) { resolve(null); req.destroy(); return; } chunks.push(c); });
    req.on('end', () => { resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', () => { resolve(null); });
  });
  if (raw === null) return null;
  return Object.fromEntries(new URLSearchParams(raw));
}

export function startDeviceServer(input: {
  readonly port: number;
  /** The address to bind — `DEVICE_HOST` (loopback) unless a deployment names the shop's address. */
  readonly host?: string;
  readonly appsDir: string;
  /** Per request, so a handheld reloaded at four o'clock gets four o'clock's assignment. */
  readonly snapshot: () => ScreenInput;
  readonly enrolments: DeviceEnrolments;
  /** The pack's fleet register right now, or undefined when the pack carries none (then nothing is served). */
  readonly devices: () => readonly PackDevice[] | undefined;
  readonly relayDeviceEvents: DeviceRelayHandler;
  readonly deviceEventStatus: DeviceStatusHandler;
  readonly syncStatus: () => LaneSyncStatus;
  /** Who is holding each phone (DF-3-c). Null → nobody can sign in, so nothing is served or taken (fail closed). */
  readonly operators: PhoneOperators | null;
  readonly now: () => string;
  /** Largest device batch accepted. A body cap is a denial-of-service control. */
  readonly maxBytes?: number;
  /** D04-FR-05 (OB-288 Pkg 6b): the queue till's door — `/queue-pos/…`, for an enrolled device only. Absent → 404 as before. */
  readonly queuePos?: QueuePosDoor;
  /**
   * OB-422: the door's lock — the folder holding the store computer's authority and the door's certificate, the addresses
   * the certificate covers, and what `ensureDeviceTls` gave at start. Required: there is no plain-http device socket.
   */
  readonly tls: { readonly dir: string; readonly addresses: readonly string[]; readonly material: DeviceTlsMaterial };
  /** How often the door checks whether its certificate is due for renewal (default `RENEW_CHECK_MS`); 0 = never by itself. */
  readonly renewEveryMs?: number;
  /** Told, in words, of every renewal or problem the timer finds — the boot log. Never a key. */
  readonly onTls?: (line: string) => void;
}): Promise<DeviceServer> {
  const maxBytes = input.maxBytes ?? 256 * 1024;
  let material = input.tls.material;
  const secure = (m: DeviceTlsMaterial) => ({ key: m.socketKeyPem, cert: m.socketChainPem });

  const server: Server = createTlsServer({ ...secure(material), minVersion: 'TLSv1.2' }, (req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const raw = req.url ?? '/';
      const url = ((): URL => { try { return new URL(raw, 'http://device'); } catch { return new URL('/', 'http://device'); } })();
      const pathname = url.pathname;

      // ── Enrolment: the one route open to a device that holds no credential yet ──
      if (pathname === DEVICE_ENROL_ROUTE) {
        if (req.method === 'GET') { send(res, 200, TYPES['.html']!, enrolPage(url.searchParams.get('why'), url.searchParams.get('next'))); return; }
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'enrolment is a POST'); return; }
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { enrolled: false, refusal: 'not_json', why: 'an enrolment is sent as application/json' }); req.resume(); return;
        }
        const read = await readJsonBody(req, 4096);
        if (!read.ok) { sendJson(res, read.reason === 'too_large' ? 413 : 400, { enrolled: false, refusal: read.reason, why: 'the enrolment request could not be read' }); return; }
        const b = (read.body !== null && typeof read.body === 'object' ? read.body : {}) as Record<string, unknown>;
        const deviceId = typeof b['deviceId'] === 'string' ? b['deviceId'] : '';
        const code = typeof b['code'] === 'string' ? b['code'] : '';
        if (deviceId.trim() === '' || code.trim() === '') { sendJson(res, 400, { enrolled: false, refusal: 'incomplete', why: 'an enrolment needs the device id and the code' }); return; }
        const outcome = await input.enrolments.enrol({ deviceId, code, devices: input.devices(), now: input.now() });
        if (!outcome.ok) {
          const status = outcome.refusal === 'too_many_attempts' ? 429 : outcome.refusal === 'device_unknown' ? 404 : outcome.refusal === 'no_devices_register' ? 503 : 403;
          sendJson(res, status, { enrolled: false, refusal: outcome.refusal, why: outcome.why });
          return;
        }
        // The credential rides in an HttpOnly, SameSite=Strict cookie: the page's scripts never see it, a cross-site
        // page never sends it. A year, because revocation is head office's and this register's — never the clock's.
        const cookie = `${DEVICE_COOKIE}=${encodeURIComponent(`${outcome.deviceId}.${outcome.token}`)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=31536000`;
        // SP-3c: back to the screen the device asked for (the picker's, the driver's), never to a page that is not a handheld's.
        sendJson(res, 200, { enrolled: true, deviceId: outcome.deviceId, next: homeAfterEnrol(b['next']) }, { 'set-cookie': cookie });
        return;
      }

      // ── Everything else needs a live device credential, checked against this register AND the pack's fleet ──
      const auth = input.enrolments.authenticate(cookieValue(req.headers.cookie, DEVICE_COOKIE), input.devices());
      if (!auth.ok) {
        if (req.method === 'GET' && wantsHtml(req)) {
          // Carry the screen the browser asked for, so enrolment lands it there (SP-3c) — a handheld screen or nothing.
          const next = homeAfterEnrol(pathname);
          redirect(res, `${DEVICE_ENROL_ROUTE}?why=${encodeURIComponent(auth.refusal)}${next === HOME_AFTER_ENROL ? '' : `&next=${encodeURIComponent(next)}`}`);
          return;
        }
        sendJson(res, 403, { error: auth.refusal, detail: auth.why });
        req.resume();
        return;
      }

      // ── D04-FR-05: the queue till has its own door (its own sign-in, for selling) — handed the authenticated device ──
      if (input.queuePos?.owns(pathname) === true) { await input.queuePos.handle(req, res, { deviceId: auth.deviceId, pathname, search: url.search }); return; }

      // ── Who is holding the phone (DF-3-c · OB-30 "A") ──
      const operatorToken = cookieValue(req.headers.cookie, OPERATOR_COOKIE);
      const holder = input.operators === null ? null : input.operators.check(operatorToken, auth.deviceId);
      if (pathname === PHONE_SIGN_IN_ROUTE) {
        const screen = phoneScreenOf(url.searchParams.get('screen'));
        const action = `${PHONE_SIGN_IN_ROUTE}?screen=${screen}`;
        // OB-186: a screen that locked itself at the end of its sign-in comes here marked `ended=1`, and is told why.
        // (`ended=clock`: it locked because the phone's clock was turned back — verifier hh NEW-1.)
        if (req.method === 'GET') {
          const ended = url.searchParams.get('ended');
          send(res, 200, TYPES['.html']!, phoneSignInPage({ screen, action, message: ended === '1' ? signInEndedMessageFor(screen) : ended === 'clock' ? signInEndedMessageFor(screen, 'clock') : null }));
          return;
        }
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'sign-in is a POST'); return; }
        const wantsJson = (req.headers.accept ?? '').includes('application/json');
        const fields = await readFormOrJson(req, 4096);
        const answer = (status: number, message: string, refusedBecause: string): void => {
          if (wantsJson) sendJson(res, status, { signedIn: false, refusedBecause, laneMessage: message });
          else send(res, status, TYPES['.html']!, phoneSignInPage({ screen, action, message }));
        };
        if (fields === null) { answer(400, 'The sign-in could not be read. Key your staff ID and PIN again.', 'not_readable'); return; }
        if (input.operators === null) { answer(503, 'This store computer cannot sign anybody in on a phone. Tell the manager.', 'no_sign_in_here'); return; }
        const outcome = await input.operators.signIn({ staffId: fields['staffId'] ?? '', pin: fields['pin'] ?? '', deviceId: auth.deviceId, authority: HANDHELD_AUTHORITY[screen] });
        if (!outcome.signedIn) { answer(outcome.refusedBecause === 'locked' || outcome.refusedBecause === 'lane_locked' ? 429 : 401, outcome.laneMessage, outcome.refusedBecause); return; }
        const cookie = `${OPERATOR_COOKIE}=${encodeURIComponent(outcome.token)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${operatorCookieSeconds(auth.deviceId, screen)}`;
        if (wantsJson) { sendJson(res, 200, { signedIn: true, userId: outcome.userId, displayName: outcome.displayName, expiresAt: outcome.expiresAt, next: `/${screen}/` }, { 'set-cookie': cookie }); return; }
        res.writeHead(303, { location: `/${screen}/`, 'set-cookie': cookie, ...SECURITY_HEADERS });
        res.end();
        return;
      }
      if (pathname === PHONE_SIGN_OUT_ROUTE) {
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'sign-out is a POST'); return; }
        req.resume();
        if (input.operators !== null) await input.operators.signOut(operatorToken);
        const screen = phoneScreenOf(url.searchParams.get('screen'));
        res.writeHead(303, { location: `${PHONE_SIGN_IN_ROUTE}?screen=${screen}`, 'set-cookie': `${OPERATOR_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`, ...SECURITY_HEADERS });
        res.end();
        return;
      }

      // ── The device routes: the same paths as the loopback lane socket, so the shared drain works unchanged ──
      if (req.method === 'POST' && pathname === DEVICE_OUTBOX_PATH) {
        if (!(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
          sendJson(res, 415, { acks: [], reason: 'a device batch is sent as application/json' }); req.resume(); return;
        }
        const read = await readJsonBody(req, maxBytes);
        if (!read.ok) { sendJson(res, read.reason === 'too_large' ? 413 : 400, { acks: [], reason: read.reason === 'too_large' ? 'the device batch is too large — send fewer items at a time' : 'the device batch could not be read' }); return; }
        const batch = readRelayBatch(read.body);
        if (!batch.ok) { sendJson(res, 400, { acks: [], reason: batch.reason }); return; }
        // A handheld speaks as a handheld. `manager` — and any surface nobody reviewed — is refused before the box is asked.
        if (!isHandheldSource(batch.source)) { sendJson(res, 403, { acks: [], reason: `${batch.source} is not a handheld surface this socket relays for` }); return; }
        // DF-3-c: nobody signed in on this phone → nothing is taken. Not a refusal: the phone keeps every item and retries
        // once somebody signs in (a 401 is "not now", never "never").
        if (holder === null || !holder.ok) {
          // The box's clock rides along (as on every hand-over reply), so the phone reckons from it again (verifier hh L1).
          sendJson(res, 401, { acks: [], reason: holder === null ? 'this store computer cannot sign anybody in on a phone' : holder.laneMessage, boxNow: input.now() });
          return;
        }
        // Each record must name a person who held THIS phone this shift — the box's log and clock decide. Anything
        // else is refused by name (a person must look), never re-stamped (hard rule #10).
        // OB-180: a record carrying a sign-in stamp must carry a TRUE one — made by a sign-in on this phone, for the person
        // the record names, over this very record, while that sign-in was valid. A forged, altered, replayed or out-of-window
        // stamp is refused by name; it never falls back to an unstamped record's path.
        const stampedBy: Record<string, string> = {};
        const verdicts: (DeviceAck | null)[] = batch.items.map((raw) => {
          const read = readRelayItem(raw);
          if (!read.ok) return null; // the box's relay refuses a malformed item with its own reason
          if (!isRelayable(read.item.event.type, batch.source)) return null; // and a type this surface may not send, by its allow-list
          const named = personNamedBy(read.item.event);
          if (!named.ok) return { key: read.item.key, status: 'refused', reason: named.reason };
          if (!input.operators!.heldRecently(named.userId, auth.deviceId)) {
            return { key: read.item.key, status: 'refused', reason: `the record names ${named.userId}, who has not been signed in on this phone this shift` };
          }
          const stamp = read.item.stamp;
          if (stamp !== undefined) {
            if (stamp.userId !== named.userId) {
              return { key: read.item.key, status: 'refused', reason: `the record names ${named.userId}, but it was made under ${stamp.userId}'s sign-in` };
            }
            const verdict = input.operators!.verifyStamp(stamp, read.item.event, auth.deviceId);
            if (!verdict.ok) return { key: read.item.key, status: 'refused', reason: verdict.reason };
            stampedBy[read.item.key] = verdict.userId;
          }
          return null;
        });
        try {
          const passed = batch.items.filter((_, i) => verdicts[i] === null);
          const relayed = passed.length === 0 ? { acks: [] } : await input.relayDeviceEvents({ source: batch.source, items: passed, deviceId: auth.deviceId, phoneHolder: holder.userId, stampedBy });
          let next = 0;
          sendJson(res, 200, { acks: verdicts.map((v) => v ?? relayed.acks[next++]!), boxNow: input.now() });
        } catch (e) {
          // The box failed mid-batch: no verdict on any item; the device keeps them all and tries again.
          sendJson(res, 500, { acks: [], reason: e instanceof Error ? e.message : String(e) });
        }
        return;
      }
      if (req.method === 'GET' && pathname === DEVICE_OUTBOX_STATUS_PATH) {
        const keys = (url.searchParams.get('keys') ?? '').split(',').map((k) => k.trim()).filter((k) => k !== '');
        sendJson(res, 200, { items: input.deviceEventStatus(keys) });
        return;
      }
      if (req.method === 'GET' && pathname === DEVICE_SYNC_STATUS_ROUTE) {
        sendJson(res, 200, input.syncStatus());
        return;
      }

      // ── The handheld shells, and nothing else ──
      if (req.method !== 'GET') { send(res, 405, 'text/plain; charset=utf-8', 'this socket serves the handheld screens and their device routes'); return; }
      if (pathname === '/') { redirect(res, HOME_AFTER_ENROL); return; }
      const moved = redirectFor(raw);
      if (moved !== null) {
        const target = routeOf(moved);
        if (target === null || !HANDHELD_SCREENS.includes(target.screen)) { send(res, 404, 'text/plain; charset=utf-8', `not a handheld screen. This socket serves: ${HANDHELD_SCREENS.join(', ')}`); return; }
        res.writeHead(301, { location: moved, ...SECURITY_HEADERS });
        res.end();
        return;
      }
      const route = routeOf(raw);
      if (route === null || !HANDHELD_SCREENS.includes(route.screen)) {
        send(res, 404, 'text/plain; charset=utf-8', `not a handheld screen. This socket serves: ${HANDHELD_SCREENS.join(', ')}`);
        return;
      }
      const file = safeFile(route.file);
      if (file === null) { send(res, 400, 'text/plain; charset=utf-8', 'bad path'); return; }
      let body: Buffer;
      try {
        body = await readFile(join(input.appsDir, APP_SHELL[route.screen].dir, 'web', file));
      } catch {
        send(res, 404, 'text/plain; charset=utf-8', 'no such file on this screen');
        return;
      }
      const extension = file.slice(file.lastIndexOf('.'));
      const type = TYPES[extension] ?? 'application/octet-stream';
      if (extension !== '.html') { send(res, 200, type, body); return; }
      // DF-3-c: the working screen only for the person signed in on this phone, for THIS job — otherwise the sign-in page.
      const screen = route.screen as HandheldSource;
      if (holder === null || !holder.ok || holder.authority !== HANDHELD_AUTHORITY[screen]) {
        redirect(res, `${PHONE_SIGN_IN_ROUTE}?screen=${screen}`);
        return;
      }
      const snap = input.snapshot();
      // OB-180: the sign-in this page's records are stamped under — its reference and key, and the box's clock now.
      const stamping = input.operators!.stampFor(operatorToken, auth.deviceId);
      const page = withPhoneHolderStrip(body.toString('utf8'), phoneHolderStrip({ displayName: holder.displayName, signOutAction: `${PHONE_SIGN_OUT_ROUTE}?screen=${screen}`, expiresAt: holder.expiresAt, now: input.now(), lockTo: signInLockOf(screen, PHONE_SIGN_IN_ROUTE) }));
      send(res, 200, type, injectPayload(page, GLOBAL_FOR[route.screen], asPhoneHolder(screen, payloadFor(route.screen, snap, holder.userId), holder.userId), {
        catalogueFreshness: catalogueFreshness(snap),
        // OB-606/607 (R16-A): the shop's zone from this box's SIGNED store pack (else the shop default), as the screens server
        // gives every page — the handheld shows "today" and every time by it, never by its phone's own zone; no network call.
        shopTimeZone: packTimeZone(snap.pack),
        // Same origin: the shell's drain and badge post to `/lane/…` on THIS socket, under the device's cookie.
        laneWriteBase: '',
        deviceId: auth.deviceId,
        ...(stamping === null ? {} : { phoneSignIn: { ...stamping, boxNow: input.now() } }),
      }));
    })();
  });

  // A failed handshake (a device that does not trust this store computer yet, a scanner probing the port) is the
  // client's refusal; the door just closes that connection.
  server.on('tlsClientError', (_e: Error, socket: Socket) => { socket.destroy(); });

  // ── The front: one port, TLS only. The first byte of a TLS connection is a handshake record (0x16); anything else
  // is plain text — answered with the refusal in words (426) and closed, never read, never served (OB-422).
  const sockets = new Set<Socket>();
  const front = createFrontServer((socket: Socket) => {
    sockets.add(socket);
    socket.on('close', () => { sockets.delete(socket); });
    socket.on('error', () => { socket.destroy(); });
    socket.setTimeout(15_000, () => { socket.destroy(); });
    socket.once('data', (first: Buffer) => {
      socket.setTimeout(0);
      if (first[0] === 0x16) {
        socket.pause();
        socket.unshift(first);
        server.emit('connection', socket);
        process.nextTick(() => { socket.resume(); });
        return;
      }
      const body = Buffer.from(PLAIN_HTTP_REFUSAL, 'utf8');
      socket.end(Buffer.concat([
        Buffer.from(`HTTP/1.1 426 Upgrade Required\r\nupgrade: TLS/1.2\r\nconnection: close\r\ncontent-type: text/plain; charset=utf-8\r\ncontent-length: ${body.length}\r\ncache-control: no-store\r\n\r\n`, 'latin1'),
        body,
      ]));
    });
  });

  const renew = (at: Date): { readonly ok: true; readonly events: readonly DeviceTlsEvent[] } | { readonly ok: false; readonly problem: string } => {
    const out = ensureDeviceTls({ dir: input.tls.dir, addresses: input.tls.addresses, now: at });
    if (!out.ok) return out;
    // The next handshake gets the renewed certificate; connections already open finish on the old one.
    if (out.tls.socketFingerprint !== material.socketFingerprint) server.setSecureContext({ ...secure(out.tls), minVersion: 'TLSv1.2' });
    material = out.tls;
    return { ok: true, events: out.events };
  };
  const every = input.renewEveryMs ?? RENEW_CHECK_MS;
  const timer = every > 0 ? setInterval(() => {
    const out = renew(new Date());
    if (!out.ok) input.onTls?.(`handheld door: the certificate could not be renewed — ${out.problem}. The current one stays until ${material.socketNotAfter}.`);
    else for (const e of out.events) if (e.kind !== 'authority_ends_soon') input.onTls?.(sayDeviceTlsEvent(e));
  }, every) : null;
  timer?.unref();

  return new Promise((resolve, reject) => {
    front.on('error', (e) => { if (timer !== null) clearInterval(timer); reject(e); });
    front.listen(input.port, input.host ?? DEVICE_HOST, () => {
      const address = front.address();
      resolve({
        port: typeof address === 'object' && address !== null ? address.port : input.port,
        host: input.host ?? DEVICE_HOST,
        scheme: 'https',
        authority: () => ({ pem: material.authorityPem, fingerprint: material.authorityFingerprint, keyPin: material.authorityKeyPin, notAfter: material.authorityNotAfter }),
        certificate: () => ({ fingerprint: material.socketFingerprint, notAfter: material.socketNotAfter, addresses: material.addresses }),
        renew,
        stop: () => new Promise<void>((done) => {
          if (timer !== null) clearInterval(timer);
          front.close(() => { done(); });
          server.closeAllConnections();
          for (const s of sockets) s.destroy();
        }),
      });
    });
  });
}
