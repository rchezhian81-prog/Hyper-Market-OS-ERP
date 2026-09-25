// Pilot resilience drills (Phase 6) — the invariants a pilot must never break, co-located and driven
// through the REAL cloud surface for one tenant. Each of the 16 failure scenarios in the pilot plan is
// already proven by a dedicated test (see docs/pilot/FAILURE-DRILLS.md for the full evidence map); this
// file is the single "run these before the floor pilot" resilience check for the ones cleanly assertable
// at the API surface. Overarching rule: no accepted write is silently lost, duplicated or overwritten.

import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';
import { tamperSignature } from '../support/local-idp';

const AT = '2026-09-25T10:00:00.000Z';
const base = { locationId: 'L1', uom: 'each', occurredAt: AT, enteredBy: 'drill-owner' };

const move = (h: ApiHarness, tenant: string, user: string, m: Record<string, unknown>, key: string) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: tenant, idempotencyKey: key, body: m });
const availability = async (h: ApiHarness, tenant: string, user: string) =>
  ((await h.request({ method: 'GET', path: '/v1/inventory/availability', userId: user, tenantId: tenant })).body as { rows: { productId: string; onHandMinor: number; movements: number }[] }).rows;

interface PromiseLine { requestedMinor?: number; promisedMinor: number; outcome: string }
interface PromiseBody { outcome: string; lines: PromiseLine[] }
const promise = (h: ApiHarness, tenant: string, user: string, orderId: string, quantityMinor: number, key: string) =>
  h.request({ method: 'POST', path: `/v1/orders/${orderId}/promise`, userId: user, tenantId: tenant, idempotencyKey: key, body: { lines: [{ productId: 'P1', quantityMinor }], locationId: 'L1' } });
const reservedTotal = async (h: ApiHarness, tenant: string, user: string): Promise<number> => {
  const outstanding = ((await h.request({ method: 'GET', path: '/v1/orders/reservations', userId: user, tenantId: tenant, query: { locationId: 'L1' } })).body as { outstanding: { quantityMinor: number }[] }).outstanding;
  return outstanding.reduce((s, r) => s + r.quantityMinor, 0);
};

describe('pilot resilience drills — invariants that must hold before the floor pilot (Phase 6)', () => {
  it('a replayed write is idempotent — same key, exactly one durable effect (no duplicate)', async () => {
    const h = apiHarness();
    const T = 'drill-idem';
    await h.seedOwner(T, 'drill-owner');
    const body = { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base };
    const first = await move(h, T, 'drill-owner', body, 'mv-r1');
    const replay = await move(h, T, 'drill-owner', body, 'mv-r1'); // same key, same body
    expect(first.status).toBe(202);
    expect(replay.status).toBe(202);
    const p1 = (await availability(h, T, 'drill-owner')).find((r) => r.productId === 'P1');
    // The replay must NOT have appended a second movement or doubled the stock.
    expect(p1).toMatchObject({ onHandMinor: 100, movements: 1 });
  });

  it('an OMS order never oversells — total reserved never exceeds on-hand (no negative stock)', async () => {
    const h = apiHarness();
    const T = 'drill-stock';
    await h.seedOwner(T, 'drill-owner');
    expect((await move(h, T, 'drill-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base }, 'mv-r1')).status).toBe(202);

    const o1 = (await promise(h, T, 'drill-owner', 'o1', 60, 'pr-o1')).body as PromiseBody;
    expect(o1.outcome).toBe('promised');
    const o2 = (await promise(h, T, 'drill-owner', 'o2', 60, 'pr-o2')).body as PromiseBody; // only 40 free
    expect(o2.lines[0]).toMatchObject({ promisedMinor: 40, outcome: 'partially_promised' });
    const o3 = (await promise(h, T, 'drill-owner', 'o3', 10, 'pr-o3')).body as PromiseBody; // nothing free
    expect(o3.outcome).toBe('cannot_promise');
    expect(o3.lines[0]?.promisedMinor).toBe(0);

    expect(await reservedTotal(h, T, 'drill-owner')).toBe(100); // exactly on-hand, never a unit more
  });

  it('an unauthorized role is refused a privileged write (403), before the body is even read', async () => {
    const h = apiHarness();
    const T = 'drill-authz';
    await h.seedOwner(T, 'drill-owner');
    await h.provisionRole(T, 'drill-cashier', 'cashier');
    const res = await move(h, T, 'drill-cashier', { movementId: 'r9', productId: 'P1', kind: 'received', quantityMinor: 1, ...base, enteredBy: 'drill-cashier' }, 'mv-r9');
    expect(res.status).toBe(403);
  });

  it('one tenant cannot see another tenant’s stock (isolation holds under the same surface)', async () => {
    const h = apiHarness();
    await h.seedOwner('drill-A', 'owner-A');
    await h.seedOwner('drill-B', 'owner-B');
    expect((await move(h, 'drill-A', 'owner-A', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, ...base, enteredBy: 'owner-A' }, 'mv-A-r1')).status).toBe(202);
    // Tenant B, same product code, sees nothing of A's stock.
    const bRows = await availability(h, 'drill-B', 'owner-B');
    expect(bRows).toEqual([]);
  });

  it('a tampered or expired token is rejected (401) — a stale session cannot act', async () => {
    const h = apiHarness();
    const T = 'drill-token';
    await h.seedOwner(T, 'drill-owner');
    const tampered = tamperSignature(h.idp.issue({ sub: 'drill-owner', tenantId: T }));
    const expired = h.idp.issue({ sub: 'drill-owner', tenantId: T, ttlSeconds: -3600 });
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: tampered })).status).toBe(401);
    expect((await h.raw({ method: 'GET', path: '/v1/identity/me', token: expired })).status).toBe(401);
    // Sanity: a valid token for the same user IS accepted, proving the 401s are the token, not the route.
    expect((await h.request({ method: 'GET', path: '/v1/identity/me', userId: 'drill-owner', tenantId: T })).status).toBe(200);
  });
});
