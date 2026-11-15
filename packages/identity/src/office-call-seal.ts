// THE STORE PC'S OFFICE PAGES REACH THE OFFICE API AS THE PERSON SIGNED IN BY PIN — audit C-1 / D-1 (OB-795) · OB-773 "1 A"
// ("extend ADR-0033 to every page") · ADR-0033 amendment 3 · OB-259 · P-01 · P-04 · P-08 · hard rules #4, #5.
//
// On the store PC (office PIN sign-in on, no head-office sign-in link) the box never mints a token (ADR-0029 §1). Before
// this, every `/v1` call an office page made was dropped, so no item, price, buying, approval, report or settlement page
// could read or save on the store PC. Now the box SEALS each call, for the person signed in by their own PIN, binding the
// exact request — method, path, query, body digest, idempotency key — the shop, the person, the store, when their PIN
// sign-in began and a fresh one-use nonce, with a key DERIVED from the dedicated privilege-seal key under its own label
// (so an office-call seal can never be read as a privilege record or a till seal, nor the other way round). The office API
// checks the seal, the freshness (60 s) and the nonce, then runs the call as that person through every ordinary check:
// their own roles, branch scope, entitlement, idempotency, audit. The sign-in evidence is `amr: ['pin']`, so a route that
// demands a second step (MFA) still refuses — privilege changes keep their own PIN-typed-again path (ADR-0033 §1–§3).
//
// Pure apart from `node:crypto`. Shared by the box (which seals) and the API (which checks), so both digest the same bytes.

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

/** Every office-call seal starts with this, so the API can tell it from a signed sign-in token at a glance. */
export const OFFICE_CALL_PREFIX = 'sre-office-call.';
/** A seal is good for this long after the box made it, by the API's own clock (both run on the same PC). */
export const OFFICE_CALL_FRESH_SECONDS = 60;
/** A seal dated this far ahead of the API's clock is refused. */
export const OFFICE_CALL_FUTURE_SKEW_SECONDS = 30;
/** How the person proved who they are: their own PIN at the office sign-in (OB-259). */
export const OFFICE_CALL_AMR = Object.freeze(['pin']) as readonly string[];

const LABEL = 'sre-office-call-v1';

/** The office-call key, derived from the privilege-seal key (`privilegeSealKey`) under its own label. */
export function officeCallKey(privilegeKey: Buffer): Buffer {
  return createHmac('sha256', privilegeKey).update(LABEL, 'utf8').digest();
}

/** The request the seal binds, as the API's pipeline sees it (body already read the way the HTTP server reads it). */
export interface OfficeCallRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly idempotencyKey: string | undefined;
}

export interface OfficeCallClaims {
  readonly v: 1;
  readonly tenantId: string;
  readonly userId: string;
  /** The store the box is (its store setup's branch); the person's branch-scoped grants are judged against it. */
  readonly branchId: string | null;
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly body: string;
  readonly idempotencyKey: string;
  /** When the person's PIN sign-in began (epoch seconds) — the API's `auth_time`. */
  readonly signedInAt: number;
  /** When the box sealed this one call (epoch seconds). */
  readonly issuedAt: number;
  readonly nonce: string;
}

/** The query in one canonical text: sorted by name, URL-encoded. */
export function canonicalQuery(query: Readonly<Record<string, string>>): string {
  return Object.keys(query).sort().map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(query[k] ?? '')}`).join('&');
}

/** The body as the API's HTTP server reads it: nothing, a JSON value, or plain text — digested the same way on both sides. */
export function bodyDigest(body: unknown): string {
  const text = body === undefined ? 'none' : typeof body === 'string' ? `text:${body}` : `json:${JSON.stringify(body)}`;
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Read raw request bytes exactly as the API's HTTP server will (`services/kernel/src/http-server.ts` readBody). */
export function bodyAsTheApiReadsIt(raw: string | null): unknown {
  if (raw === null || raw === '') return undefined;
  try { return JSON.parse(raw) as unknown; } catch { return raw; }
}

const b64 = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const mac = (key: Buffer, payload: string): Buffer => createHmac('sha256', key).update(payload, 'utf8').digest();

/** The box's seal on one office call, for the person its PIN gate names. */
export function sealOfficeCall(key: Buffer, input: {
  readonly tenantId: string; readonly userId: string; readonly branchId: string | null;
  readonly request: OfficeCallRequest; readonly signedInAt: number; readonly nowMs: number; readonly nonce?: string;
}): string {
  const claims: OfficeCallClaims = {
    v: 1, tenantId: input.tenantId, userId: input.userId, branchId: input.branchId,
    method: input.request.method.toUpperCase(), path: input.request.path, query: canonicalQuery(input.request.query),
    body: bodyDigest(input.request.body), idempotencyKey: input.request.idempotencyKey ?? '',
    signedInAt: Math.floor(input.signedInAt), issuedAt: Math.floor(input.nowMs / 1000), nonce: input.nonce ?? randomUUID(),
  };
  const payload = b64(JSON.stringify(claims));
  return `${OFFICE_CALL_PREFIX}${payload}.${b64(mac(key, payload))}`;
}

export type OfficeCallRefusal = 'not_an_office_call' | 'seal_does_not_match' | 'not_readable' | 'not_this_request' | 'stale' | 'in_the_future' | 'used_before';

export type OfficeCallCheck =
  | { readonly ok: true; readonly claims: OfficeCallClaims }
  | { readonly ok: false; readonly refusedBecause: OfficeCallRefusal; readonly detail: string };

/** The nonces seen inside the freshness window — a seal is taken once. Bounded: entries older than the window are dropped. */
export class OfficeCallNonces {
  private readonly seen = new Map<string, number>();
  /** True the first time a nonce is offered inside its window; false after. */
  take(nonce: string, nowMs: number): boolean {
    for (const [n, at] of this.seen) { if (nowMs - at > (OFFICE_CALL_FRESH_SECONDS + OFFICE_CALL_FUTURE_SKEW_SECONDS) * 1000) this.seen.delete(n); else break; }
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, nowMs);
    return true;
  }
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The API's check of one office-call seal against the request it arrived with. */
export function checkOfficeCall(key: Buffer, token: string, request: OfficeCallRequest, nowMs: number, nonces: OfficeCallNonces): OfficeCallCheck {
  if (!token.startsWith(OFFICE_CALL_PREFIX)) return { ok: false, refusedBecause: 'not_an_office_call', detail: 'not an office-call seal' };
  const rest = token.slice(OFFICE_CALL_PREFIX.length);
  const dot = rest.indexOf('.');
  if (dot <= 0) return { ok: false, refusedBecause: 'not_readable', detail: 'the office-call seal has no signature part' };
  const payload = rest.slice(0, dot);
  const given = Buffer.from(rest.slice(dot + 1), 'base64url');
  const want = mac(key, payload);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return { ok: false, refusedBecause: 'seal_does_not_match', detail: 'the office-call seal was not made with this store PC\'s key, or it was changed' };
  let c: Record<string, unknown>;
  try { c = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>; } catch { return { ok: false, refusedBecause: 'not_readable', detail: 'the office-call seal could not be read' }; }
  if (c === null || typeof c !== 'object' || c['v'] !== 1 || !isStr(c['tenantId']) || c['tenantId'] === '' || !isStr(c['userId']) || c['userId'] === ''
    || !(c['branchId'] === null || isStr(c['branchId'])) || !isStr(c['method']) || !isStr(c['path']) || !isStr(c['query']) || !isStr(c['body'])
    || !isStr(c['idempotencyKey']) || !isNum(c['signedInAt']) || !isNum(c['issuedAt']) || !isStr(c['nonce']) || c['nonce'] === '') {
    return { ok: false, refusedBecause: 'not_readable', detail: 'the office-call seal is missing a field' };
  }
  const claims = c as unknown as OfficeCallClaims;
  if (claims.method !== request.method.toUpperCase() || claims.path !== request.path || claims.query !== canonicalQuery(request.query)
    || claims.body !== bodyDigest(request.body) || claims.idempotencyKey !== (request.idempotencyKey ?? '')) {
    return { ok: false, refusedBecause: 'not_this_request', detail: 'the office-call seal was made for a different request' };
  }
  const age = nowMs - claims.issuedAt * 1000;
  if (age > OFFICE_CALL_FRESH_SECONDS * 1000) return { ok: false, refusedBecause: 'stale', detail: `the office-call seal is older than ${OFFICE_CALL_FRESH_SECONDS} s` };
  if (-age > OFFICE_CALL_FUTURE_SKEW_SECONDS * 1000) return { ok: false, refusedBecause: 'in_the_future', detail: 'the office-call seal is dated in the future' };
  if (!nonces.take(claims.nonce, nowMs)) return { ok: false, refusedBecause: 'used_before', detail: 'the office-call seal was used before' };
  return { ok: true, claims };
}
