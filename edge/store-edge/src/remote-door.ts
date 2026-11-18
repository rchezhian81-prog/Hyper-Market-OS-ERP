// THE REMOTE DOOR — remote head-office access for the owner (OB-840 · ADR-0035 · owner's decision 18 Nov 2026 "1A, 2A,
// 3A, 4A, 5A") · P-01 · P-03 · P-04 · P-08 · hard rules #1, #4, #6, #10.
//
// The owner, away from the shop, opens his own domain on his phone. A small rented server in India (the RELAY) signs him
// in — his password and a one-time code from an authenticator app — and hands each request, with the identity server's
// signed token, down an encrypted line that THE STORE PC DIALLED OUT (ssh, a reverse forward). The line ends here: a
// listener on THIS PC's loopback only (127.0.0.1:8095), never the ordinary screen socket (8091), never the shop network.
// Nothing on the store PC is opened to the internet; the shop's data stays on the store PC.
//
// This module decides, for every request that arrives through the line, BEFORE any screen or call is reached:
//   1. WHO — the relay's token, checked HERE against the identity server's public key PINNED when the link was set up
//      (never a key the token or the relay brings now): RS256, the realm's own issuer, our API's audience, this shop's
//      tenant, not expired, a lifetime ceiling, and `amr` showing the second factor (a one-time code) was used;
//   2. MAY THEY — the person must be on the remote-allowed list (a setting; its default is the owner only — "4A");
//   3. WHAT — only Today, the reports and the approvals inbox, their own files, and the head-office calls those three pages
//      make (reads, and approve / reject). Everything else — the till, software update, users and roles, device setup,
//      price publishing, the PIN sign-in — is refused in plain words ("5A");
//   4. an approval of a kind 5A keeps in the store (a person's access or role, a device) is refused here too, with its words.
// What passes runs exactly as it would in the store, AS that person, and each call to the office API carries the store
// PC's own seal with the mark 'remote' — so an approval is recorded in his name, exactly as in the store, plus that mark.
// Every request through this door (but a page's own files) is kept on its own append-only log here: who, what, the answer.
//
// The till never touches any of this: a sale never waits on the line, the relay or this door (hard rule #1).

import { verifyToken, type PublicKeyring, type TokenRefusal } from '../../../services/identity/src/token';
import { signingKeysOf } from '../../../services/identity/src/jwks';

/** The remote door listens here: this PC's loopback only. */
export const REMOTE_DOOR_HOST = '127.0.0.1';
/** Its port unless the till's settings name another (`EDGE_REMOTE_DOOR_PORT`). Never the ordinary screen port 8091. */
export const REMOTE_DOOR_PORT = 8095;
/** The pins file `store-computer remote-access setup` writes in the till folder (`EDGE_REMOTE_ACCESS_FILE`). */
export const REMOTE_ACCESS_FILE = 'remote-access.json';
export const REMOTE_ACCESS_KIND = 'sre-remote-access-v1';
/** The door's own append-only log in the till's data folder. */
export const REMOTE_ACCESS_LOG = 'remote-access.log';
/** "4A": only the owner, unless the setting names others. Entries: `role:<role id>` or a person's id, comma-separated. */
export const REMOTE_ALLOWED_DEFAULT = 'role:owner';
/** The identity server's access tokens live five minutes; nothing longer than an hour is believed here. */
export const REMOTE_TOKEN_MAX_LIFETIME_SECONDS = 60 * 60;
/** "5A": the screens reachable from outside — Today, the reports, the approvals inbox. */
export const REMOTE_SCREENS = Object.freeze(['manager', 'reporting', 'approvals'] as const);
export type RemoteScreen = typeof REMOTE_SCREENS[number];

/**
 * "5A": the head-office calls those three pages make — and nothing else. Reads, and the one write: approve or reject.
 * (Today's counts read approvals, purchase orders and the cash office's signed-off shifts; the approvals inbox reads a
 * supplier's bills beside a payment; the reports read a report.)
 */
export const REMOTE_API: readonly { readonly method: 'GET' | 'POST'; readonly path: RegExp; readonly decide?: true }[] = Object.freeze([
  { method: 'GET', path: /^\/v1\/approvals\/requests$/ },
  { method: 'POST', path: /^\/v1\/approvals\/requests\/[A-Za-z0-9._:-]{1,128}\/decide$/, decide: true },
  { method: 'GET', path: /^\/v1\/purchase\/orders$/ },
  { method: 'GET', path: /^\/v1\/purchase\/suppliers\/[A-Za-z0-9._:%-]{1,128}$/ },
  { method: 'GET', path: /^\/v1\/shifts\/over-short$/ },
  { method: 'GET', path: /^\/v1\/reports\/[A-Za-z0-9._:-]{1,128}$/ },
]);

/**
 * "5A": approvals that stay in the store — a person's access or role, a device. Their decision changes who may do what,
 * or which machine is trusted, which 5A keeps off the remote door ("no user/role/privilege screens, no device setup").
 */
export const REMOTE_DECIDE_REFUSED_KINDS: readonly string[] = Object.freeze([
  'access_change', 'role_permission_change', 'role_scope_change', 'department_scope_change', 'ca_role_grant',
  'emergency_access', 'security_reviewer', 'posh_committee_change', 'store_computer_replaced', 'floor_device_review',
]);

/** A page's own files that may be served through the door (never another page's shell). */
const ASSET = /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.(js|css|woff2|json|webmanifest|map|svg|png|ico)$/;

// ── The pins (written once at setup, on this PC) ──────────────────────────────────────────────────────────────────

/** What `remote-access setup` pinned: the relay's realm, its public signing keys, and who may come in from outside. */
export interface RemoteAccess {
  readonly host: string;
  readonly issuer: string;
  readonly audience: string;
  readonly tenantId: string;
  readonly allowed: string;
  readonly keyring: PublicKeyring;
  readonly keyCount: number;
}

/** Read the pins file. A problem is said in words; the door then refuses everything (never opens on a guess). */
export function readRemoteAccess(text: string | undefined, boxTenantId: string): { readonly ok: true; readonly access: RemoteAccess } | { readonly ok: false; readonly problem: string } {
  if (text === undefined) return { ok: false, problem: 'remote access is not set up on this store computer' };
  let o: Record<string, unknown>;
  try {
    const v = JSON.parse(text) as unknown;
    if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    o = v as Record<string, unknown>;
  } catch { return { ok: false, problem: 'the remote-access file cannot be read' }; }
  const str = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).trim() : '');
  if (o['kind'] !== REMOTE_ACCESS_KIND) return { ok: false, problem: 'the remote-access file is not one this release reads' };
  const issuer = str('issuer');
  const host = str('host');
  if (!/^https:\/\//.test(issuer) || host === '') return { ok: false, problem: 'the remote-access file names no https identity server' };
  if (str('audience') === '') return { ok: false, problem: 'the remote-access file names no audience' };
  if (str('tenantId') !== boxTenantId) return { ok: false, problem: 'the remote-access file was set up for another shop' };
  const keys = signingKeysOf(o['keys']);
  if (keys.size === 0) return { ok: false, problem: 'the remote-access file holds no identity-server signing key' };
  return {
    ok: true,
    access: {
      host, issuer, audience: str('audience'), tenantId: boxTenantId,
      allowed: str('allowed') === '' ? REMOTE_ALLOWED_DEFAULT : str('allowed'),
      keyring: { get: (kid) => keys.get(kid) }, keyCount: keys.size,
    },
  };
}

// ── Who: the relay's token ───────────────────────────────────────────────────────────────────────────────────────

export type RemoteRefusal =
  | 'remote_access_not_set_up' | 'no_sign_in' | 'sign_in_not_believed' | 'sign_in_expired' | 'wrong_issuer'
  | 'second_factor_missing' | 'not_allowed_remotely' | 'not_reachable_remotely' | 'decide_in_the_store'
  | 'not_from_this_screen' | 'office_api_not_reachable';

export interface RemotePerson {
  readonly userId: string;
  /** How they proved it, as the signed token says (`pwd otp mfa`). */
  readonly amr: readonly string[];
  /** When they signed in at the relay (epoch seconds), else the token's issue time. */
  readonly signedInAt: number;
  readonly expiresAt: string;
}

const REFUSAL_OF: Partial<Record<TokenRefusal, RemoteRefusal>> = {
  expired: 'sign_in_expired', issuer_not_ours: 'wrong_issuer',
};

/** The person the relay's token names — or why not. Checked against the PINNED keys only. */
export function remotePersonOf(authorization: string | string[] | undefined, access: RemoteAccess, nowMs: number):
  | { readonly ok: true; readonly person: RemotePerson }
  | { readonly ok: false; readonly refusedBecause: RemoteRefusal; readonly detail: string } {
  const header = typeof authorization === 'string' ? authorization.trim() : '';
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header);
  if (m === null) return { ok: false, refusedBecause: 'no_sign_in', detail: 'no sign-in token came with the request' };
  const verdict = verifyToken(m[1]!, {
    algorithm: 'RS256', secret: '', keyring: access.keyring, subjectClaim: 'sre_user_id',
    issuer: access.issuer, audience: access.audience, tenantId: access.tenantId,
    maxLifetimeSeconds: REMOTE_TOKEN_MAX_LIFETIME_SECONDS, leewaySeconds: 30,
  }, nowMs);
  if (!verdict.ok || verdict.principal === undefined) {
    return { ok: false, refusedBecause: REFUSAL_OF[verdict.refusedBecause ?? 'signature_does_not_verify'] ?? 'sign_in_not_believed', detail: verdict.detail };
  }
  const p = verdict.principal;
  // "3A": the second check is REQUIRED for everyone who signs in remotely — a password alone is never enough here.
  if (!(p.amr ?? []).includes('mfa') || !(p.amr ?? []).includes('otp')) {
    return { ok: false, refusedBecause: 'second_factor_missing', detail: 'the sign-in did not use the one-time code' };
  }
  const payload = JSON.parse(Buffer.from(m[1]!.split('.')[1]!, 'base64url').toString('utf8')) as { exp: number; iat?: number };
  return {
    ok: true,
    person: { userId: p.userId, amr: p.amr ?? [], signedInAt: p.authTime ?? payload.iat ?? Math.floor(nowMs / 1000), expiresAt: new Date(payload.exp * 1000).toISOString() },
  };
}

/** "4A": is this person on the remote-allowed list? `rolesOf` reads their roles at this store from the signed pack. */
export function allowedRemotely(userId: string, allowed: string, rolesOf: (userId: string) => readonly string[] | null): boolean {
  const entries = (allowed.trim() === '' ? REMOTE_ALLOWED_DEFAULT : allowed).split(',').map((e) => e.trim()).filter((e) => e !== '');
  const roles = rolesOf(userId) ?? [];
  // Nobody without an office role at this store comes in, whatever the list says.
  if (roles.length === 0) return false;
  return entries.some((e) => (e.startsWith('role:') ? roles.includes(e.slice('role:'.length)) : e === userId));
}

// ── What: the paths ───────────────────────────────────────────────────────────────────────────────────────────────

export type RemotePath =
  | { readonly kind: 'redirect'; readonly to: string }
  | { readonly kind: 'screen'; readonly screen: RemoteScreen }
  | { readonly kind: 'asset' }
  | { readonly kind: 'api'; readonly decide: string | null }
  | { readonly kind: 'refused' };

/** What a path is on the remote door. `shellOf` names each screen's own page file (screen-server's APP_SHELL). */
export function remotePathOf(method: string | undefined, url: string | undefined, shellOf: (screen: RemoteScreen) => string): RemotePath {
  const m = (method ?? 'GET').toUpperCase();
  const path = (url ?? '/').split('?')[0] ?? '/';
  if (path.includes('..') || path.includes('\\') || /%(2f|5c|2e|00)/i.test(path) || path.includes('//')) return { kind: 'refused' };
  if (path.startsWith('/v1/')) {
    const hit = REMOTE_API.find((a) => a.method === m && a.path.test(path));
    if (hit === undefined) return { kind: 'refused' };
    return { kind: 'api', decide: hit.decide === true ? decodeURIComponent(path.split('/')[4] ?? '') : null };
  }
  const read = m === 'GET' || m === 'HEAD';
  // The PIN sign-in is not offered here: the front door and /office/ go to Today (the person signed in at the relay).
  if (read && (path === '/' || path === '/office' || path === '/office/')) return { kind: 'redirect', to: '/manager/' };
  const parts = path.split('/').filter((p) => p !== '');
  const screen = parts[0] as RemoteScreen | undefined;
  if (screen === undefined || !(REMOTE_SCREENS as readonly string[]).includes(screen) || !read) return { kind: 'refused' };
  if (parts.length === 1) return path.endsWith('/') ? { kind: 'screen', screen } : { kind: 'redirect', to: `/${screen}/` };
  // The pages' own type faces live one folder down (fonts/*.woff2); nothing else below a page is served.
  if (parts.length === 3 && parts[1] === 'fonts' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,120}\.woff2$/.test(parts[2]!)) return { kind: 'asset' };
  if (parts.length !== 2) return { kind: 'refused' };
  const file = parts[1]!;
  if (file === shellOf(screen)) return { kind: 'screen', screen };
  return ASSET.test(file) ? { kind: 'asset' } : { kind: 'refused' };
}

// ── Words (the three-part style: what happened, was it saved, what to do next) ────────────────────────────────────

interface Words { readonly status: number; readonly en: string; readonly ta: string; readonly next: string; readonly nextTa: string }

export const REMOTE_WORDS: Readonly<Record<RemoteRefusal, Words>> = Object.freeze({
  remote_access_not_set_up: { status: 503, en: 'Remote access is not set up on the store computer.', ta: 'கடைக் கணினியில் தொலை அணுகல் அமைக்கப்படவில்லை.', next: 'At the store computer, run the remote-access setup (owner guide: remote access).', nextTa: 'கடைக் கணினியில் தொலை அணுகல் அமைப்பை இயக்கவும்.' },
  no_sign_in: { status: 401, en: 'You are not signed in.', ta: 'நீங்கள் உள்நுழையவில்லை.', next: 'Open your shop\'s address again and sign in with your password and the code from your authenticator app.', nextTa: 'உங்கள் கடை முகவரியை மீண்டும் திறந்து, கடவுச்சொல்லும் அங்கீகாரச் செயலியின் குறியீடும் கொண்டு உள்நுழையவும்.' },
  sign_in_not_believed: { status: 401, en: 'The store computer could not confirm your sign-in.', ta: 'உங்கள் உள்நுழைவைக் கடைக் கணினியால் உறுதிப்படுத்த முடியவில்லை.', next: 'Sign out and sign in again. If it happens again, run the remote-access setup again at the store computer.', nextTa: 'வெளியேறி மீண்டும் உள்நுழையவும்.' },
  sign_in_expired: { status: 401, en: 'Your sign-in has ended.', ta: 'உங்கள் உள்நுழைவு முடிந்தது.', next: 'Reload the page; if it asks, sign in again.', nextTa: 'பக்கத்தை மீண்டும் ஏற்றவும்; கேட்டால் மீண்டும் உள்நுழையவும்.' },
  wrong_issuer: { status: 401, en: 'This sign-in came from a different sign-in server than the one this store computer was set up with.', ta: 'இந்தக் கடைக் கணினி அமைக்கப்பட்டதைவிட வேறு உள்நுழைவு சேவையகத்திலிருந்து இந்த உள்நுழைவு வந்தது.', next: 'Use your own shop\'s address. If you changed the server, run the remote-access setup again at the store computer.', nextTa: 'உங்கள் கடையின் சொந்த முகவரியைப் பயன்படுத்தவும்.' },
  second_factor_missing: { status: 401, en: 'Remote access needs the one-time code from your authenticator app, and this sign-in did not use it.', ta: 'தொலை அணுகலுக்கு அங்கீகாரச் செயலியின் ஒருமுறைக் குறியீடு தேவை; இந்த உள்நுழைவில் அது பயன்படுத்தப்படவில்லை.', next: 'Sign out, then sign in again and type the code from your authenticator app.', nextTa: 'வெளியேறி, மீண்டும் உள்நுழைந்து அங்கீகாரச் செயலியின் குறியீட்டை உள்ளிடவும்.' },
  not_allowed_remotely: { status: 403, en: 'Only the owner may use the store\'s office pages from outside the shop.', ta: 'கடைக்கு வெளியிலிருந்து அலுவலகப் பக்கங்களை உரிமையாளர் மட்டுமே பயன்படுத்தலாம்.', next: 'Use the office pages at the store computer, in the shop.', nextTa: 'கடையில் உள்ள கடைக் கணினியில் அலுவலகப் பக்கங்களைப் பயன்படுத்தவும்.' },
  not_reachable_remotely: { status: 403, en: 'This page is not reachable from outside the shop. From outside you can see Today, the reports and your approvals, and approve or reject.', ta: 'இந்தப் பக்கத்தைக் கடைக்கு வெளியிலிருந்து திறக்க முடியாது. வெளியிலிருந்து இன்று, அறிக்கைகள், உங்கள் அனுமதிகளைப் பார்க்கலாம்; அனுமதிக்கலாம் அல்லது மறுக்கலாம்.', next: 'Open Today, Reports or Approvals. Everything else is done at the store computer, in the shop.', nextTa: 'இன்று, அறிக்கைகள் அல்லது அனுமதிகளைத் திறக்கவும்.' },
  decide_in_the_store: { status: 403, en: 'This approval changes a person\'s access or a device, and is decided at the store computer, in the shop.', ta: 'இந்த அனுமதி ஒருவரின் அணுகலை அல்லது ஒரு சாதனத்தை மாற்றுகிறது; இது கடையில் உள்ள கடைக் கணினியில் முடிவு செய்யப்படும்.', next: 'Decide it at the store computer when you are in the shop. It stays waiting for you.', nextTa: 'கடையில் இருக்கும்போது கடைக் கணினியில் முடிவு செய்யவும்.' },
  not_from_this_screen: { status: 403, en: 'Refused: this did not come from a page of your shop.', ta: 'மறுக்கப்பட்டது: இது உங்கள் கடையின் பக்கத்திலிருந்து வரவில்லை.', next: 'Use the page\'s own buttons.', nextTa: 'பக்கத்தின் சொந்தப் பொத்தான்களைப் பயன்படுத்தவும்.' },
  office_api_not_reachable: { status: 503, en: 'The store computer\'s office service did not answer.', ta: 'கடைக் கணினியின் அலுவலகச் சேவை பதிலளிக்கவில்லை.', next: 'Try again in a few minutes. If it goes on, check the store computer in the shop.', nextTa: 'சில நிமிடங்களில் மீண்டும் முயலவும்.' },
});

/** The refusal as the API's three-part error (JSON). Nothing was saved: a refusal here is before anything is reached. */
export function remoteRefusalJson(code: RemoteRefusal): string {
  const w = REMOTE_WORDS[code];
  return JSON.stringify({ error: { code, whatHappened: w.en, wasItSaved: 'not_saved', nextSafeAction: w.next, ta: { whatHappened: w.ta, nextSafeAction: w.nextTa } } });
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The refusal as a page, in English and Tamil, with the three parts in plain words. No script. */
export function remoteRefusalPage(code: RemoteRefusal): string {
  const w = REMOTE_WORDS[code];
  return [
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    '<title>SRE Hyper Market — remote access</title>',
    '<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;padding:24px 16px;background:#f7f4ec;color:#10231c}main{max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:20px;border:1px solid #d9d2c0}h1{font-size:20px;margin:0 0 12px}p{margin:8px 0}a{color:#0b5d3b;font-weight:600}</style>',
    '</head><body><main>',
    `<h1>${esc(w.en)}</h1>`,
    `<p><strong>Was anything saved?</strong> No. Nothing was changed.</p>`,
    `<p><strong>What to do:</strong> ${esc(w.next)}</p>`,
    `<p lang="ta">${esc(w.ta)} எதுவும் மாற்றப்படவில்லை. ${esc(w.nextTa)}</p>`,
    '<p><a href="/manager/">Today</a> · <a href="/reporting/">Reports</a> · <a href="/approvals/">Approvals</a></p>',
    '</main></body></html>',
  ].join('');
}

// ── P-08: the link's state, in plain words, for Today ─────────────────────────────────────────────────────────────

export interface RemoteLinkView { readonly state: 'connected' | 'not_connected' | 'off'; readonly en: string; readonly ta: string }

/** How long the link service may go without a word before its last word is no longer believed. */
export const REMOTE_LINK_STALE_MS = 3 * 60_000;

/**
 * What Today says about the remote link, from the link service's status file (`status.json`, written by the store-computer
 * tool's link runner) — connected; not connected since <time>; or turned off. A file that is old or unreadable is said as
 * "not connected", never as connected (P-08: no silent failure). `shopTime` formats a moment in the shop's own clock.
 */
export function remoteLinkView(input: { readonly doorOn: boolean; readonly statusText: string | undefined; readonly nowMs: number; readonly shopTime: (iso: string) => string }): RemoteLinkView {
  const off: RemoteLinkView = { state: 'off', en: 'Remote access: turned off.', ta: 'தொலை அணுகல்: அணைக்கப்பட்டுள்ளது.' };
  if (!input.doorOn) return off;
  let s: Record<string, unknown> | undefined;
  try { const v = input.statusText === undefined ? undefined : JSON.parse(input.statusText) as unknown; s = v !== null && typeof v === 'object' ? v as Record<string, unknown> : undefined; } catch { s = undefined; }
  if (s === undefined || s['kind'] !== 'sre-remote-link-status-v1') {
    return { state: 'not_connected', en: 'Remote access: not connected — the link service on this computer has not reported.', ta: 'தொலை அணுகல்: இணைக்கப்படவில்லை — இந்தக் கணினியின் இணைப்புச் சேவை எதுவும் சொல்லவில்லை.' };
  }
  if (s['state'] === 'off') return off;
  const updated = typeof s['updatedAt'] === 'string' ? Date.parse(s['updatedAt']) : Number.NaN;
  const fresh = Number.isFinite(updated) && input.nowMs - updated <= REMOTE_LINK_STALE_MS;
  if (s['state'] === 'connected' && fresh) return { state: 'connected', en: 'Remote access: connected.', ta: 'தொலை அணுகல்: இணைக்கப்பட்டுள்ளது.' };
  const sinceIso = typeof s['since'] === 'string' && s['state'] !== 'connected' ? s['since'] : (Number.isFinite(updated) ? new Date(updated).toISOString() : undefined);
  const since = sinceIso === undefined || Number.isNaN(Date.parse(sinceIso)) ? undefined : input.shopTime(sinceIso);
  return since === undefined
    ? { state: 'not_connected', en: 'Remote access: not connected.', ta: 'தொலை அணுகல்: இணைக்கப்படவில்லை.' }
    : { state: 'not_connected', en: `Remote access: not connected since ${since}.`, ta: `தொலை அணுகல்: ${since} முதல் இணைக்கப்படவில்லை.` };
}
