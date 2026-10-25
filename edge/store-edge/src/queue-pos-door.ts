// THE QUEUE TILL'S DOOR on the device socket — a staff handheld that scans in the queue, takes a card or UPI payment where
// the shop has switched it on, and otherwise hands the basket to a till by a code (D04-FR-05 mobile POS and queue-busting ·
// OB-288 · OB-316 · ADR-0019 · ADR-0020 · ADR-0023 · P-01 · P-02 · hard rules #1, #3, #4, #10).
//
// The handheld reaches THIS store computer over the shop's wifi through the authenticated device socket (an enrolled
// device, ADR-0019) — never the internet, so the queue keeps moving with head office down (hard rule #1, "offline through
// the store computer"). Everything it does is the box's tested machinery, reached under the handheld's own identity:
//
//   • WHO: the person signs in on the handheld with their staff ID and the SAME personal till PIN (`TillOperators`,
//     ADR-0020) — for SELLING (`pos.sale.sync`), so a warehouse or picker sign-in on the same phone opens nothing here. The
//     session belongs to the phone (`device:<id>`), lasts four hours (OB-184), and ends when somebody else signs in.
//   • THE PRICE: the page is served the box's SIGNED pack — prices, offers, bundles, the tobacco, liquor, BIS and expiry
//     gates — and the handheld runs the till's own model (`apps/pos`), so the basket is priced exactly as a till prices it.
//   • THE SALE: a card or UPI payment goes through the till's own lane pipeline on this box (`lane-server.ts`, one loopback
//     instance per handheld, its lane `device:<id>`): the attempt recorded BEFORE the machine is asked, the box's receipt
//     number, the legal gates again before the disk, the seal on who rang it, card data removed, the fsync, then the SAME
//     sale record queued for head office as any till's — so stock, GST and the books reconcile. Only card and UPI: whether
//     a handheld may take CASH is not decided (the roadmap is silent), so cash — and points, store credit or "paid on old
//     system" — is refused here before anything is written.
//   • THE HAND-OVER: otherwise the basket is handed to a till by a four-digit code (`queue-baskets.ts`); the till rings it
//     through its own pack.
//   • THE SWITCHES (OB-316): `pos.queue_busting` for this box's lane (or its branch) serves any of this; `payments.mobile_pos`
//     on top lets the handheld take money. Neither set is OFF — the page says so, and why, in English and Tamil.

import { request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { safeFile, injectPayload } from './screen-server';
import { deviceLaneOf, TILL_AUTHORITY, type CheckOutcome, type SignInOutcome } from './till-operators';
import { escapeHtml, phoneHolderStrip, withPhoneHolderStrip, FORGET_KEPT_PAGES_SCRIPT } from './handheld-sign-in';
import type { QueueBaskets } from './queue-baskets';

export const QUEUE_POS_PATH = '/queue-pos';
export const QUEUE_POS_SIGN_IN = '/queue-pos/sign-in';
export const QUEUE_POS_SIGN_OUT = '/queue-pos/sign-out';
export const QUEUE_POS_HANDOFF = '/queue-pos/handoff';
export const QUEUE_POS_GIVE_UP = '/queue-pos/handoff/give-up';
/** The lane routes the queue till may reach on its own lane pipeline — nothing else (no refunds, no cash, no approvals). */
export const QUEUE_POS_LANE_ROUTES: Readonly<Record<string, readonly ('GET' | 'POST')[]>> = Object.freeze({
  '/lane/operator': ['GET'],
  '/lane/sync-status': ['GET'],
  '/lane/sales': ['POST'],
  '/lane/receipt-numbers': ['GET', 'POST'],
  '/lane/payment-attempts': ['GET', 'POST'],
  '/lane/payment-attempts/answer': ['POST'],
  '/lane/payment-attempts/recover': ['POST'],
  '/lane/till-activity': ['POST'],
});
/** The routes that move money, or number a bill — served only while `payments.mobile_pos` is on too. */
const PAYMENT_ROUTES = new Set(['/lane/sales', '/lane/receipt-numbers', '/lane/payment-attempts', '/lane/payment-attempts/answer', '/lane/payment-attempts/recover']);
/** The tenders a handheld may take. Cash is an owner decision not yet made; nothing else is offered on a handheld. */
export const HANDHELD_TENDERS: readonly string[] = Object.freeze(['card', 'upi']);
const OPERATOR_COOKIE = 'sre_operator';
const OPERATOR_HEADER = 'x-sre-operator';
/** As long as a phone sign-in (OB-184): four hours. */
const SESSION_SECONDS = 4 * 3600;

/** Is queue-busting on here, and may the handheld take money — read from the signed pack for this box's lane. */
export interface QueuePosSwitches {
  /** The lane of this store computer the switches were judged for — null when the box was never told. */
  readonly laneId: string | null;
  /** True when the pack told this box its rollout switches; false → everything is off, and `why` says so. */
  readonly known: boolean;
  readonly why: string | null;
  readonly queueBusting: boolean;
  /** Only ever true with `queueBusting` true as well. */
  readonly payments: boolean;
}

export interface QueuePosDoorDeps {
  readonly appsDir: string;
  readonly switches: () => QueuePosSwitches;
  /** The till register, addressed by the DEVICE (`phoneOperatorsOf`). Null → nobody can sign in, nothing is served. */
  readonly operators: {
    signIn(input: { readonly staffId: string; readonly pin: string; readonly deviceId: string; readonly authority: string }): Promise<SignInOutcome>;
    check(token: string | undefined, deviceId: string): CheckOutcome;
    signOut(token: string | undefined): Promise<boolean>;
  } | null;
  /** This box's queue-basket register; null → this box keeps no queue baskets (no till lane), said. */
  readonly queueBaskets: QueueBaskets | null;
  /** The loopback lane pipeline that serves THIS handheld's lane (`device:<id>`), started on first use; null → none here. */
  readonly laneFor: (deviceId: string) => Promise<{ readonly host: string; readonly port: number } | null>;
  /** The globals the page is served with for this handheld's lane: the signed pack, the lane, the receipt template. */
  readonly page: (handheldLane: string) => Readonly<Record<string, unknown>>;
  readonly now: () => string;
  readonly maxBytes?: number;
}

const SECURITY_HEADERS = Object.freeze({
  'x-frame-options': 'DENY', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
});
const TYPES: Readonly<Record<string, string>> = Object.freeze({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8', '.map': 'application/json; charset=utf-8',
});
const send = (res: ServerResponse, status: number, type: string, body: string | Buffer, extra: Record<string, string> = {}): void => {
  res.writeHead(status, { 'content-type': type, 'content-length': String(Buffer.byteLength(body)), ...SECURITY_HEADERS, ...extra });
  res.end(body);
};
const sendJson = (res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void => send(res, status, 'application/json', JSON.stringify(body), extra);
const redirect = (res: ServerResponse, location: string, extra: Record<string, string> = {}): void => { res.writeHead(303, { location, ...SECURITY_HEADERS, ...extra }); res.end(); };

function cookieValue(header: string | undefined, name: string): string | undefined {
  if (header === undefined || header === '') return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1 || part.slice(0, eq).trim() !== name) continue;
    try { return decodeURIComponent(part.slice(eq + 1).trim()); } catch { return undefined; }
  }
  return undefined;
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: 'too_large' }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > maxBytes && !done) { done = true; resolve({ ok: false, reason: 'too_large' }); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => { if (!done) { done = true; resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }); } });
    req.on('error', () => { if (!done) { done = true; resolve({ ok: true, text: '' }); } });
  });
}
const parse = (text: string): Record<string, unknown> | null => {
  try { const v = JSON.parse(text) as unknown; return v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null; } catch { return null; }
};
const isJson = (req: IncomingMessage): boolean => (req.headers['content-type'] ?? '').toLowerCase().split(';')[0]!.trim() === 'application/json';
const wantsJson = (req: IncomingMessage): boolean => (req.headers.accept ?? '').includes('application/json');

/** The words the handheld shows, English and Tamil. */
export const QUEUE_POS_WORDS = Object.freeze({
  off: {
    en: 'Queue-busting is switched off for this store computer\'s till lane. Ask the manager to switch it on (Trial switches: pos.queue_busting).',
    ta: 'இந்தக் கடை கணினியின் பில்லிங் வரிசைக்கு வரிசை-விரைவு அணைக்கப்பட்டுள்ளது. மேலாளரிடம் இயக்கச் சொல்லவும் (pos.queue_busting).',
  },
  paymentsOff: {
    en: 'This handheld does not take payments here (payments.mobile_pos is off). Hand the basket to a till instead. Nothing was saved.',
    ta: 'இந்தக் கருவி இங்கு கட்டணம் பெறாது (payments.mobile_pos அணைக்கப்பட்டுள்ளது). கூடையை பில்லிங்குக்கு ஒப்படைக்கவும். எதுவும் சேமிக்கப்படவில்லை.',
  },
  tenderNotOnHandheld: {
    en: 'A handheld takes card or UPI only — whether it may take cash is not decided yet. Hand the basket to a till for any other payment. Nothing was saved.',
    ta: 'கருவி அட்டை அல்லது UPI மட்டுமே பெறும் — ரொக்கம் பெறலாமா என்பது இன்னும் முடிவாகவில்லை. வேறு கட்டணத்துக்கு கூடையை பில்லிங்குக்கு ஒப்படைக்கவும். எதுவும் சேமிக்கப்படவில்லை.',
  },
  notSignedIn: {
    en: 'Nobody is signed in on this handheld for the queue till. Sign in with your staff ID and till PIN.',
    ta: 'இந்தக் கருவியில் வரிசை பில்லிங்குக்கு யாரும் உள்நுழையவில்லை. உங்கள் பணியாளர் எண் மற்றும் PIN மூலம் உள்நுழையவும்.',
  },
  noLanePipeline: {
    en: 'This store computer serves no till, so a handheld cannot take payment through it. Hand the basket to a till.',
    ta: 'இந்தக் கடை கணினி பில்லிங் சேவை செய்வதில்லை; கருவி கட்டணம் பெற முடியாது. கூடையை பில்லிங்குக்கு ஒப்படைக்கவும்.',
  },
  notServed: { en: 'The queue till does not do that. Use a till.', ta: 'வரிசை பில்லிங் அதைச் செய்யாது. பில்லிங் இடத்தைப் பயன்படுத்தவும்.' },
  voidOnly: { en: 'The handheld records line voids only.', ta: 'கருவி வரி நீக்கங்களை மட்டுமே பதிவு செய்யும்.' },
  noQueueBaskets: { en: 'This store computer keeps no queue baskets (it serves no till). Scan at a till.', ta: 'இந்தக் கடை கணினி கூடைகளை வைத்திருப்பதில்லை. பில்லிங்கில் ஸ்கேன் செய்யவும்.' },
  unreachableLane: { en: 'The store computer could not reach its own till service. Nothing was saved — try again, or hand the basket to a till.', ta: 'கடை கணினி தன் பில்லிங் சேவையை அணுக முடியவில்லை. எதுவும் சேமிக்கப்படவில்லை.' },
});

const PAGE_STYLE = `<style>
  *{box-sizing:border-box}
  body{margin:0;font:17px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,"Noto Sans","Noto Sans Tamil","Nirmala UI","Latha",sans-serif;background:#f5f7f2;color:#193b31;display:grid;place-items:start center;min-height:100dvh;-webkit-text-size-adjust:100%}
  main{width:min(451px,100%);margin:16px 0;padding:24px 20px 28px;display:grid;gap:18px;background:#fff;border:1px solid #dce4d9;border-top:3px solid #17654f;border-radius:12px}
  @media (max-width:500px){main{margin:0;min-height:100dvh;border-radius:0;border-left:0;border-right:0;align-content:start}}
  .job{justify-self:start;margin:0;padding:4px 12px;border-radius:999px;background:#eaf0e1;color:#143f32;font-size:14px;font-weight:600}
  h1{font-size:24px;line-height:1.25;margin:0}h1 small{display:block;margin-top:6px;font-size:16px;color:#586e61;font-weight:400}
  form{display:grid;gap:18px}
  label{display:grid;gap:6px;font-weight:600}label small{color:#586e61;font-weight:400;font-size:15px}
  input{font:inherit;font-size:20px;padding:0 16px;border-radius:8px;border:1px solid #819483;background:#fcfdfb;color:#193b31;min-height:56px;width:100%}
  input:focus-visible,button:focus-visible{outline:3px solid #17654f;outline-offset:2px}
  button{font:inherit;font-weight:700;font-size:19px;min-height:60px;width:100%;border:1px solid #17654f;border-radius:8px;background:#17654f;color:#fff;cursor:pointer}
  .notice{margin:0;padding:12px 14px;border-radius:8px;background:#fcf0ec;color:#a13932;border:1px solid #f3d6cf;border-left:4px solid #a13932;font-weight:600;font-size:16px}
  .notice span{display:block;font-weight:500}
</style>`;

/** The sign-in page for the queue till: staff ID and the till PIN, English and Tamil, 56 px fields. */
export function queuePosSignInPage(message: { readonly en: string; readonly ta: string } | null): string {
  const notice = message === null ? '' : `<p class="notice" role="alert">${escapeHtml(message.en)}<span lang="ta">${escapeHtml(message.ta)}</span></p>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Queue till · வரிசை பில்லிங் — sign in</title>${PAGE_STYLE}</head><body><main>
  <p class="job">Queue till · வரிசை பில்லிங்</p>
  <h1>Sign in on this handheld<small>உங்கள் பணியாளர் எண் மற்றும் PIN</small></h1>
  ${notice}
  <form method="post" action="${QUEUE_POS_SIGN_IN}">
    <label>Staff ID <small>பணியாளர் எண் — scan your badge or key it</small><input name="staffId" autocomplete="off" autocapitalize="none" required></label>
    <label>Till PIN <small>பில்லிங் PIN — your own six digits</small><input name="pin" type="password" inputmode="numeric" autocomplete="off" pattern="[0-9]{6}" maxlength="6" required></label>
    <button type="submit">Sign in · உள்நுழை</button>
  </form>
</main>${FORGET_KEPT_PAGES_SCRIPT}</body></html>`;
}

/** The page shown when the switch is off (or the box cannot tell) — the reason, never a silent blank. */
export function queuePosOffPage(s: QueuePosSwitches): string {
  const why = s.known ? QUEUE_POS_WORDS.off : { en: `${QUEUE_POS_WORDS.off.en} (${s.why ?? 'not told'})`, ta: QUEUE_POS_WORDS.off.ta };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Queue till · வரிசை பில்லிங் — off</title>${PAGE_STYLE}</head><body><main>
  <p class="job">Queue till · வரிசை பில்லிங்</p>
  <h1>Switched off<small>அணைக்கப்பட்டுள்ளது</small></h1>
  <p class="notice" role="alert" data-queue-pos-off>${escapeHtml(why.en)}<span lang="ta">${escapeHtml(why.ta)}</span></p>
</main></body></html>`;
}

/** Relay one request to the handheld's own loopback lane pipeline, with the phone holder's session as the till's. */
function relay(target: { readonly host: string; readonly port: number }, input: { readonly method: string; readonly path: string; readonly token: string; readonly body?: string }): Promise<{ readonly status: number; readonly text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      host: target.host, port: target.port, method: input.method, path: input.path,
      headers: { [OPERATOR_HEADER]: input.token, ...(input.body === undefined ? {} : { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(input.body)) }) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    if (input.body !== undefined) req.write(input.body);
    req.end();
  });
}

/** A sale the handheld may record: card and UPI parts only (hard rule #3 holds below, in the lane pipeline). */
export function handheldTenderRefusal(sale: Record<string, unknown>): boolean {
  const tenders = sale['tenders'];
  if (!Array.isArray(tenders) || tenders.length === 0) return true;
  return tenders.some((t) => t === null || typeof t !== 'object' || !HANDHELD_TENDERS.includes(String((t as Record<string, unknown>)['kind'])));
}

export interface QueuePosDoor {
  /** True when the path is the queue till's — the device socket hands it here after the device credential is checked. */
  owns(pathname: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, ctx: { readonly deviceId: string; readonly pathname: string; readonly search: string }): Promise<void>;
}

export function queuePosDoor(deps: QueuePosDoorDeps): QueuePosDoor {
  const maxBytes = deps.maxBytes ?? 256 * 1024;
  return {
    owns: (pathname) => pathname === QUEUE_POS_PATH || pathname.startsWith(`${QUEUE_POS_PATH}/`),
    handle: async (req, res, { deviceId, pathname, search }) => {
      if (pathname === QUEUE_POS_PATH) { redirect(res, `${QUEUE_POS_PATH}/`); return; }
      const switches = deps.switches();
      const lane = deviceLaneOf(deviceId);
      const token = cookieValue(req.headers.cookie, OPERATOR_COOKIE);

      // ── Sign-out works whatever the switches say: ending a session is always allowed.
      if (pathname === QUEUE_POS_SIGN_OUT) {
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'sign-out is a POST'); return; }
        req.resume();
        if (deps.operators !== null) await deps.operators.signOut(token);
        redirect(res, QUEUE_POS_SIGN_IN, { 'set-cookie': `${OPERATOR_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0` });
        return;
      }

      // ── The switch (OB-316): off, or never set, or the box was not told → nothing but the reason.
      if (!switches.queueBusting) {
        req.resume();
        if (req.method === 'GET' && !wantsJson(req) && !/\.[a-z]+$/.test(pathname)) { send(res, 403, TYPES['.html']!, queuePosOffPage(switches)); return; }
        // The till's own ports read a 403 as "not allowed to work a till"; on its lane routes the refusal is the body (200),
        // exactly as the lane socket answers a refusal — so the handheld shows these words, never another's.
        sendJson(res, pathname.startsWith(`${QUEUE_POS_PATH}/lane/`) ? 200 : 403, { committed: false, issued: false, ok: false, recorded: false, signedIn: false, refusedBecause: 'queue_busting_off', laneMessage: QUEUE_POS_WORDS.off.en, laneMessageTa: QUEUE_POS_WORDS.off.ta, why: switches.why });
        return;
      }

      // ── Sign-in: the person's own staff ID and till PIN, checked on this box, for SELLING.
      if (pathname === QUEUE_POS_SIGN_IN) {
        if (req.method === 'GET') { send(res, 200, TYPES['.html']!, queuePosSignInPage(new URL(`http://x${search}`).searchParams.get('ended') === '1' ? { en: 'Your sign-in on this handheld has ended. Sign in again.', ta: 'இந்தக் கருவியில் உங்கள் உள்நுழைவு முடிந்தது. மீண்டும் உள்நுழையவும்.' } : null)); return; }
        if (req.method !== 'POST') { send(res, 405, 'text/plain; charset=utf-8', 'sign-in is a POST'); return; }
        const read = await readBody(req, 4096);
        const type = (req.headers['content-type'] ?? '').toLowerCase();
        const fields: Record<string, string> = {};
        if (read.ok && type.startsWith('application/json')) { for (const [k, v] of Object.entries(parse(read.text) ?? {})) if (typeof v === 'string') fields[k] = v; }
        else if (read.ok && type.startsWith('application/x-www-form-urlencoded')) Object.assign(fields, Object.fromEntries(new URLSearchParams(read.text)));
        const answer = (status: number, words: { en: string; ta: string }, refusedBecause: string): void => {
          if (wantsJson(req)) sendJson(res, status, { signedIn: false, refusedBecause, laneMessage: words.en, laneMessageTa: words.ta });
          else send(res, status, TYPES['.html']!, queuePosSignInPage(words));
        };
        if (deps.operators === null) { answer(503, { en: 'This store computer cannot sign anybody in on a handheld. Tell the manager.', ta: 'இந்தக் கடை கணினியால் கருவியில் உள்நுழைய முடியாது. மேலாளரிடம் சொல்லவும்.' }, 'no_sign_in_here'); return; }
        const outcome = await deps.operators.signIn({ staffId: fields['staffId'] ?? '', pin: fields['pin'] ?? '', deviceId, authority: TILL_AUTHORITY });
        if (!outcome.signedIn) { answer(outcome.refusedBecause === 'locked' || outcome.refusedBecause === 'lane_locked' ? 429 : 401, { en: outcome.laneMessage, ta: 'உள்நுழைவு மறுக்கப்பட்டது — பணியாளர் எண் மற்றும் PIN-ஐச் சரிபார்க்கவும்.' }, outcome.refusedBecause); return; }
        const cookie = `${OPERATOR_COOKIE}=${encodeURIComponent(outcome.token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_SECONDS}`;
        if (wantsJson(req)) { sendJson(res, 200, { signedIn: true, userId: outcome.userId, displayName: outcome.displayName, expiresAt: outcome.expiresAt, next: `${QUEUE_POS_PATH}/` }, { 'set-cookie': cookie }); return; }
        redirect(res, `${QUEUE_POS_PATH}/`, { 'set-cookie': cookie });
        return;
      }

      // ── Static files of the shell (script, style, worker, manifest) — no data in them.
      const file = safeFile(pathname.slice(`${QUEUE_POS_PATH}/`.length) || 'index.html');
      const isPage = file === 'index.html';
      const isData = pathname.startsWith(`${QUEUE_POS_PATH}/lane/`) || pathname === QUEUE_POS_HANDOFF || pathname === QUEUE_POS_GIVE_UP;
      if (!isData && !isPage) {
        if (req.method !== 'GET') { send(res, 405, 'text/plain; charset=utf-8', 'the queue till serves its files by GET'); return; }
        if (file === null) { send(res, 400, 'text/plain; charset=utf-8', 'bad path'); return; }
        let body: Buffer;
        try { body = await readFile(join(deps.appsDir, 'queue-pos', 'web', file)); } catch { send(res, 404, 'text/plain; charset=utf-8', 'no such file on the queue till'); return; }
        const ext = file.slice(file.lastIndexOf('.'));
        send(res, 200, TYPES[ext] ?? 'application/octet-stream', body);
        return;
      }

      // ── Everything else is the signed-in person's: a live session on THIS phone, opened for selling.
      const holder = deps.operators === null ? null : deps.operators.check(token, deviceId);
      const selling = holder !== null && holder.ok && holder.authority === TILL_AUTHORITY ? holder : null;

      if (isPage) {
        if (req.method !== 'GET') { send(res, 405, 'text/plain; charset=utf-8', 'the page is a GET'); return; }
        if (selling === null) { redirect(res, QUEUE_POS_SIGN_IN); return; }
        let body: Buffer;
        try { body = await readFile(join(deps.appsDir, 'queue-pos', 'web', 'index.html')); } catch { send(res, 404, 'text/plain; charset=utf-8', 'the queue till is not installed on this store computer'); return; }
        const strip = phoneHolderStrip({
          displayName: selling.displayName, signOutAction: QUEUE_POS_SIGN_OUT, expiresAt: selling.expiresAt, now: deps.now(),
          lockTo: { url: `${QUEUE_POS_SIGN_IN}?ended=1`, page: queuePosSignInPage({ en: 'Your sign-in on this handheld has ended. Sign in again.', ta: 'இந்தக் கருவியில் உங்கள் உள்நுழைவு முடிந்தது. மீண்டும் உள்நுழையவும்.' }) },
        });
        const globals = { ...deps.page(lane), queuePos: { laneId: lane, boxLaneId: switches.laneId, payments: switches.payments, signedIn: { userId: selling.userId, displayName: selling.displayName, expiresAt: selling.expiresAt } }, laneWriteBase: '' };
        send(res, 200, TYPES['.html']!, injectPayload(withPhoneHolderStrip(body.toString('utf8'), strip), 'queuePosPage', null, globals));
        return;
      }

      if (selling === null) {
        req.resume();
        sendJson(res, 401, { refusedBecause: holder !== null && !holder.ok ? holder.refusedBecause : 'operator_not_signed_in', laneMessage: QUEUE_POS_WORDS.notSignedIn.en, laneMessageTa: QUEUE_POS_WORDS.notSignedIn.ta });
        return;
      }

      // ── The hand-over: park the basket on this box's disk and give the code; list what is waiting; give one up.
      if (pathname === QUEUE_POS_HANDOFF || pathname === QUEUE_POS_GIVE_UP) {
        const baskets = deps.queueBaskets;
        if (baskets === null) { req.resume(); sendJson(res, 404, { handedOver: false, refusedBecause: 'not_served', laneMessage: QUEUE_POS_WORDS.noQueueBaskets.en, laneMessageTa: QUEUE_POS_WORDS.noQueueBaskets.ta }); return; }
        if (req.method === 'GET' && pathname === QUEUE_POS_HANDOFF) { sendJson(res, 200, { waiting: baskets.waiting(lane) }); return; }
        if (req.method !== 'POST') { req.resume(); send(res, 405, 'text/plain; charset=utf-8', 'a hand-over is a POST'); return; }
        if (!isJson(req)) { req.resume(); sendJson(res, 415, { handedOver: false, refusedBecause: 'not_json', laneMessage: 'A hand-over is sent as application/json.' }); return; }
        const read = await readBody(req, maxBytes);
        if (!read.ok) { sendJson(res, 413, { handedOver: false, refusedBecause: 'too_large', laneMessage: QUEUE_POS_WORDS.notServed.en }); return; }
        const b = parse(read.text);
        if (b === null) { sendJson(res, 400, { handedOver: false, refusedBecause: 'not_readable', laneMessage: 'The hand-over could not be read.' }); return; }
        if (pathname === QUEUE_POS_GIVE_UP) { sendJson(res, 200, await baskets.giveUp({ handheldLane: lane, by: selling.userId, code: b['code'], reason: b['reason'] })); return; }
        sendJson(res, 200, await baskets.handOver({ handheldLane: lane, by: selling.userId, basketId: b['basketId'], lines: b['lines'], handheldTotalMinor: b['handheldTotalMinor'] }));
        return;
      }

      // ── The till's own routes, on this handheld's lane pipeline — only the ones a queue till needs.
      const route = pathname.slice(QUEUE_POS_PATH.length);
      const methods = QUEUE_POS_LANE_ROUTES[route];
      if (methods === undefined || !methods.includes(req.method as 'GET' | 'POST')) {
        req.resume();
        sendJson(res, 404, { committed: false, issued: false, ok: false, recorded: false, refusedBecause: 'not_served_on_the_queue_till', laneMessage: QUEUE_POS_WORDS.notServed.en, laneMessageTa: QUEUE_POS_WORDS.notServed.ta });
        return;
      }
      if (PAYMENT_ROUTES.has(route) && !switches.payments) {
        req.resume();
        sendJson(res, 200, { committed: false, issued: false, ok: false, refusedBecause: 'mobile_pos_payment_off', laneMessage: QUEUE_POS_WORDS.paymentsOff.en, laneMessageTa: QUEUE_POS_WORDS.paymentsOff.ta });
        return;
      }
      let body: string | undefined;
      if (req.method === 'POST') {
        if (!isJson(req)) { req.resume(); sendJson(res, 415, { committed: false, refusedBecause: 'unauthorized_request', laneMessage: 'The queue till sends application/json only.' }); return; }
        const read = await readBody(req, maxBytes);
        if (!read.ok) { sendJson(res, 413, { committed: false, refusedBecause: 'too_large', laneMessage: 'The request is too large.' }); return; }
        body = read.text;
        const b = parse(body);
        // Cash, points, store credit or "paid on old system" on a handheld: not decided, so never written (hard rule #10:
        // a refusal in words, before the disk — never a silent acceptance).
        if (route === '/lane/sales' && (b === null || handheldTenderRefusal(b))) {
          sendJson(res, 200, { committed: false, refusedBecause: 'tender_not_on_handheld', laneMessage: QUEUE_POS_WORDS.tenderNotOnHandheld.en, laneMessageTa: QUEUE_POS_WORDS.tenderNotOnHandheld.ta });
          return;
        }
        if (route === '/lane/till-activity' && (b === null || b['kind'] !== 'void')) {
          sendJson(res, 200, { recorded: false, refusedBecause: 'not_served_on_the_queue_till', laneMessage: QUEUE_POS_WORDS.voidOnly.en, laneMessageTa: QUEUE_POS_WORDS.voidOnly.ta });
          return;
        }
      }
      const target = await deps.laneFor(deviceId).catch(() => null);
      if (target === null) {
        sendJson(res, 503, { committed: false, issued: false, ok: false, refusedBecause: 'no_lane_here', laneMessage: QUEUE_POS_WORDS.noLanePipeline.en, laneMessageTa: QUEUE_POS_WORDS.noLanePipeline.ta });
        return;
      }
      try {
        const out = await relay(target, { method: req.method ?? 'GET', path: `${route}${search}`, token: token!, ...(body === undefined ? {} : { body }) });
        send(res, out.status, 'application/json', out.text);
      } catch {
        sendJson(res, 502, { committed: false, issued: false, ok: false, refusedBecause: 'lane_unreachable', laneMessage: QUEUE_POS_WORDS.unreachableLane.en, laneMessageTa: QUEUE_POS_WORDS.unreachableLane.ta });
      }
    },
  };
}
