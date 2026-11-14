// THE STORE PC'S OFFICE REACHES THIS PC'S OWN API AS THE PERSON — CR-01 step 4 (OI-06 · OI-07 · ADR-0032 · ADR-0033) ·
// OB-257 · OB-259 · M02-FR-01 · P-01 · P-04 · hard rules #1, #4, #5.
//
// On the store PC the shop's own API runs beside the till, on this PC only (ADR-0032). The Office app's Users & roles and
// Import & export pages must work there WITHOUT the head-office internet sign-in (OB-388): a person signs in to the office
// screens with their staff ID and their own till PIN (OB-259), and every important act asks their PIN AGAIN. Only after
// that PIN matched does this module make a short-lived token for THAT person and carry the one call to this PC's API —
// exactly what the import page and the owner setup commands already do (scripts/lib/operator-env.ts buildPersonToken,
// OB-257; a test holds the two byte-for-byte equal):
//
//   • the token names the person (`sub`), the shop (`tenant_id`), WHEN their PIN was checked (`auth_time`) and how
//     (`amr` pin + swk, the store PC's stand-in two-step sign-in, OB-251); it lasts five minutes and never leaves this
//     process — never written, never logged, never shown;
//   • the API is reached on THIS PC's loopback only: an address that is not 127.0.0.1 / localhost / ::1 is refused, so a
//     settings mistake can never send a person's token across the shop network or the internet;
//   • head office (this PC's API) then judges every call exactly as anywhere else: its permission check, its two-person
//     rule, its step-up, its audit. Nothing here grants, approves or decides anything.
//
// Nothing here is on the till's sale path (hard rule #1): a sale never calls it.

import { createHmac, randomUUID } from 'node:crypto';

/** The marks the store PC's PIN sign-in carries (the same as scripts/lib/operator-env.ts STORE_PC_PIN_AMR). */
export const STORE_PC_PIN_AMR: readonly string[] = Object.freeze(['pin', 'swk']);
/** How long one call's token lasts. */
export const PERSON_TOKEN_SECONDS = 300;
/** The till setting that turns this on: the office pages talk to THIS PC's own API (the store PC, CR-01). */
export const THIS_PC_SETTING = 'EDGE_OFFICE_HEAD_OFFICE';
export const THIS_PC_VALUE = 'this-pc';

export interface ThisPcPolicy { readonly secret: string; readonly issuer: string; readonly audience: string }

export interface ThisPcApiSettings {
  readonly apiBase: string;
  readonly tenantId: string;
  readonly policy: ThisPcPolicy;
}

/** Is this an address on this PC only? */
export function isLoopbackUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  return u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
}

/**
 * The link's settings from the till's own settings, or why it is off — in words, naming the settings, never a value.
 * Off unless `EDGE_OFFICE_HEAD_OFFICE=this-pc` AND the office PIN sign-in is on (`EDGE_OFFICE_SIGN_IN=pin`).
 */
export function thisPcApiSettingsFrom(env: Readonly<Record<string, string | undefined>>): { readonly on: true; readonly settings: ThisPcApiSettings } | { readonly on: false; readonly why: string | null } {
  const v = (k: string): string => String(env[k] ?? '').trim();
  if (v(THIS_PC_SETTING) !== THIS_PC_VALUE) return { on: false, why: null };
  if (v('EDGE_OFFICE_SIGN_IN') !== 'pin') return { on: false, why: 'the office PIN sign-in is not on (EDGE_OFFICE_SIGN_IN=pin), so nobody could be known by their own PIN' };
  const missing = ['CLOUD_API_URL', 'EDGE_TENANT_ID', 'IDP_SIGNING_KEY', 'IDP_ISSUER', 'IDP_AUDIENCE'].filter((k) => v(k) === '');
  if (missing.length > 0) return { on: false, why: `these settings are missing: ${missing.join(', ')}` };
  if (!isLoopbackUrl(v('CLOUD_API_URL'))) return { on: false, why: 'CLOUD_API_URL is not an address on this PC (127.0.0.1) — a person\'s token is never sent off this PC' };
  if (v('IDP_SIGNING_KEY').length < 32) return { on: false, why: 'IDP_SIGNING_KEY is too short to be this PC\'s key' };
  return { on: true, settings: { apiBase: v('CLOUD_API_URL').replace(/\/+$/, ''), tenantId: v('EDGE_TENANT_ID'), policy: { secret: v('IDP_SIGNING_KEY'), issuer: v('IDP_ISSUER'), audience: v('IDP_AUDIENCE') } } };
}

const b64url = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64url');

/** One person's token, for one call, made only after their own PIN matched. Identical bytes to `buildPersonToken`. */
export function personToken(claims: { readonly sub: string; readonly tenantId: string; readonly ttlSeconds: number; readonly authTimeSec: number; readonly jti?: string }, policy: ThisPcPolicy, nowMs: number): string {
  const nowSec = Math.floor(nowMs / 1000);
  const header = b64url({ alg: 'HS256', typ: 'JWT' });
  const payload = b64url({ sub: claims.sub, tenant_id: claims.tenantId, iss: policy.issuer, aud: policy.audience, iat: nowSec, jti: claims.jti ?? randomUUID(), exp: nowSec + claims.ttlSeconds, auth_time: claims.authTimeSec, amr: [...STORE_PC_PIN_AMR] });
  const signature = createHmac('sha256', policy.secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

/** The person a call is made as: who, and when THEIR PIN was last checked on this PC. */
export interface PinPerson { readonly userId: string; readonly pinCheckedAt: string }

/**
 * A `fetch` that carries a page-shaped call (`/v1/…`, same-origin) to this PC's API as `person`. Anything that is not a
 * `/v1/` path is refused without a call (a page cannot use it to reach anything else).
 */
export function personFetch(settings: ThisPcApiSettings, person: PinPerson, deps: { readonly fetch: typeof globalThis.fetch; readonly now: () => number }): typeof globalThis.fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const u = new URL(raw, 'http://this-pc.invalid');
    if (!u.pathname.startsWith('/v1/') || u.origin !== 'http://this-pc.invalid') {
      return new Response(JSON.stringify({ error: { code: 'not_a_head_office_call', whatHappened: 'Only this PC\'s own API is called from here.', wasItSaved: 'not_saved', nextSafeAction: 'Nothing was sent.' } }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const token = personToken({ sub: person.userId, tenantId: settings.tenantId, ttlSeconds: PERSON_TOKEN_SECONDS, authTimeSec: Math.floor(Date.parse(person.pinCheckedAt) / 1000) }, settings.policy, deps.now());
    const headers = new Headers(init?.headers);
    headers.set('authorization', `Bearer ${token}`);
    return deps.fetch(`${settings.apiBase}${u.pathname}${u.search}`, { ...init, headers });
  }) as typeof globalThis.fetch;
}

/** A plain JSON call to this PC's API as `person`; a lost link is a status 0, never a made-up answer (P-08). */
export async function callAs(f: typeof globalThis.fetch, method: string, path: string, body?: unknown, idempotencyKey?: string): Promise<{ readonly status: number; readonly body: unknown }> {
  try {
    const res = await f(path, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(idempotencyKey === undefined ? {} : { 'idempotency-key': idempotencyKey }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* keep the text */ }
    return { status: res.status, body: parsed };
  } catch {
    return { status: 0, body: undefined };
  }
}

/** Head office's own words from an error answer, or a plain fallback naming the status. */
export function wordsOf(r: { readonly status: number; readonly body: unknown }): string {
  if (r.status === 0) return 'This PC\'s own system did not answer. Nothing was done.';
  const b = r.body as { error?: { whatHappened?: unknown; nextSafeAction?: unknown } } | undefined;
  const e = b?.error;
  const w = e === undefined ? '' : `${String(e.whatHappened ?? '')} ${String(e.nextSafeAction ?? '')}`.trim();
  return w === '' ? `The shop's system answered ${r.status}.` : w;
}
