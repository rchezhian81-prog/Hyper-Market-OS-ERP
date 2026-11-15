import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { OFFICE_CALL_PREFIX, OfficeCallNonces, checkOfficeCall, officeCallKey, sealOfficeCall, bodyAsTheApiReadsIt, type OfficeCallRequest } from '../../packages/identity/src/office-call-seal';
import { privilegeSealKey } from '../../packages/identity/src/till-seal';
import { withOfficeCalls } from '../../services/identity/src/office-call-authenticator';

/**
 * Audit C-1 / D-1 · ADR-0033 amendment 3: the store PC's office pages reach the office API as the person signed in by PIN.
 * The box seals ONE request for ONE person; the API believes it only for that exact request, within 60 s, once, and only
 * with the store PC's own key. The person's sign-in evidence is a PIN (`amr: ['pin']`), never MFA.
 */

const KEY = officeCallKey(privilegeSealKey(randomBytes(32).toString('base64url')));
const NOW = Date.parse('2026-11-15T10:00:00Z');
const GET: OfficeCallRequest & { readonly method: 'GET' } = { method: 'GET', path: '/v1/catalogue/products/SALT', query: { b: '2', a: '1' }, body: undefined, idempotencyKey: undefined };
const POST: OfficeCallRequest & { readonly method: 'POST' } = { method: 'POST', path: '/v1/catalogue/changes', query: {}, body: { productId: 'SALT', reason: 'x' }, idempotencyKey: 'k-1' };
const seal = (request: OfficeCallRequest, over: Partial<{ nowMs: number; key: Buffer; userId: string }> = {}): string => sealOfficeCall(over.key ?? KEY, {
  tenantId: 't-1', userId: over.userId ?? 'u-mgr', branchId: 'S1', request, signedInAt: NOW / 1000 - 60, nowMs: over.nowMs ?? NOW,
});

describe('an office-call seal binds one request for one person (audit C-1)', () => {
  it('is believed for exactly the request it was made for, once', () => {
    const nonces = new OfficeCallNonces();
    const s = seal(POST);
    expect(s.startsWith(OFFICE_CALL_PREFIX)).toBe(true);
    const ok = checkOfficeCall(KEY, s, POST, NOW + 1_000, nonces);
    expect(ok).toMatchObject({ ok: true, claims: { tenantId: 't-1', userId: 'u-mgr', branchId: 'S1' } });
    expect(checkOfficeCall(KEY, s, POST, NOW + 2_000, nonces)).toMatchObject({ ok: false, refusedBecause: 'used_before' });
    // The query's order does not matter; its content does.
    expect(checkOfficeCall(KEY, seal(GET), { ...GET, query: { a: '1', b: '2' } }, NOW, nonces).ok).toBe(true);
  });

  it('is refused for another request, another body, another key, an edited seal, or out of time', () => {
    const n = new OfficeCallNonces();
    expect(checkOfficeCall(KEY, seal(POST), { ...POST, body: { productId: 'SALT', reason: 'y' } }, NOW, n)).toMatchObject({ refusedBecause: 'not_this_request' });
    expect(checkOfficeCall(KEY, seal(POST), { ...POST, path: '/v1/identity/grants' }, NOW, n)).toMatchObject({ refusedBecause: 'not_this_request' });
    expect(checkOfficeCall(KEY, seal(POST), { ...POST, idempotencyKey: 'k-2' }, NOW, n)).toMatchObject({ refusedBecause: 'not_this_request' });
    expect(checkOfficeCall(KEY, seal(GET), { ...GET, query: { a: '1', b: '3' } }, NOW, n)).toMatchObject({ refusedBecause: 'not_this_request' });
    expect(checkOfficeCall(KEY, seal(GET, { key: officeCallKey(randomBytes(32)) }), GET, NOW, n)).toMatchObject({ refusedBecause: 'seal_does_not_match' });
    // Edit the person inside the seal: the signature no longer matches.
    const s = seal(GET);
    const [payload, sig] = s.slice(OFFICE_CALL_PREFIX.length).split('.');
    const edited = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload!, 'base64url').toString()), userId: 'u-owner' })).toString('base64url');
    expect(checkOfficeCall(KEY, `${OFFICE_CALL_PREFIX}${edited}.${sig}`, GET, NOW, n)).toMatchObject({ refusedBecause: 'seal_does_not_match' });
    expect(checkOfficeCall(KEY, seal(GET), GET, NOW + 61_000, n)).toMatchObject({ refusedBecause: 'stale' });
    expect(checkOfficeCall(KEY, seal(GET, { nowMs: NOW + 31_000 }), GET, NOW, n)).toMatchObject({ refusedBecause: 'in_the_future' });
  });

  it('the box reads a body exactly as the API does', () => {
    expect(bodyAsTheApiReadsIt(null)).toBeUndefined();
    expect(bodyAsTheApiReadsIt('')).toBeUndefined();
    expect(bodyAsTheApiReadsIt('{"a":1}')).toEqual({ a: 1 });
    expect(bodyAsTheApiReadsIt('not json')).toBe('not json');
  });

  it('the API: a PIN sign-in (never MFA) as that person; other tokens go to the ordinary check; no key → never believed', async () => {
    const raw = randomBytes(32).toString('base64url');
    const k = officeCallKey(privilegeSealKey(raw));
    const fallback = (token: string) => (token === 'ordinary' ? { tenantId: 't-1', userId: 'u-x', branchId: null } : undefined);
    const auth = withOfficeCalls({ privilegeKey: privilegeSealKey(raw), fallback, now: () => NOW });
    const s = sealOfficeCall(k, { tenantId: 't-1', userId: 'u-mgr', branchId: 'S1', request: GET, signedInAt: NOW / 1000 - 60, nowMs: NOW });
    expect(await auth(s, GET)).toEqual({ tenantId: 't-1', userId: 'u-mgr', branchId: 'S1', authTime: NOW / 1000 - 60, amr: ['pin'] });
    expect(await auth(s, GET)).toBeUndefined(); // once
    expect(await auth('ordinary', GET)).toMatchObject({ userId: 'u-x' });
    const noKey = withOfficeCalls({ privilegeKey: undefined, fallback, now: () => NOW });
    const s2 = sealOfficeCall(k, { tenantId: 't-1', userId: 'u-mgr', branchId: 'S1', request: GET, signedInAt: NOW / 1000, nowMs: NOW });
    expect(await noKey(s2, GET)).toBeUndefined();
  });
});
