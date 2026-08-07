import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Governed price changes through the real API (M05-FR-02, §28). A price above the legal MRP is
// rejected outright; a below-floor / below-cost price is blocked unless a SEPARATE person — who
// genuinely holds price.change.approve — signs it off with a reason. The separation is enforced
// server-side through the tested price-guard engine and the real per-tenant RBAC, not a name in a
// form. This is "M05's own path"; the pack-publish path re-checks §28 before it reaches the shelf.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
// MRP ₹100, cost ₹50, 20% margin floor → below-floor when price·8000 < 50,000,000, i.e. price < 6250.
const CTX = { mrpMinor: 10_000, costMinor: 5_000, marginFloorBps: 2_000, currency: 'INR' } as const;

const propose = (h: ApiHarness, o: {
  userId: string; priceMinor: number; key: string; approval?: { decidedBy: string; reason: string };
}) => h.request({
  method: 'POST', path: '/v1/prices/changes', userId: o.userId, tenantId: A, idempotencyKey: o.key,
  body: { productId: 'P1', priceMinor: o.priceMinor, ...CTX, ...(o.approval === undefined ? {} : { approval: o.approval }) },
});
const code = (r: { body: unknown }): string => (r.body as { error: { code: string } }).error.code;

async function cast(): Promise<ApiHarness> {
  const h = apiHarness();
  await h.provisionOwner(A, 'owner-1'); // owner: propose + approve
  await h.provisionOwner(A, 'owner-2'); // owner: propose + approve
  await h.provisionRole(A, 'mgr', 'store_manager'); // propose, NOT approve
  await h.provisionRole(A, 'cash', 'cashier'); // neither
  return h;
}

describe('governed price changes enforce MRP and separation of duties (M05-FR-02, §28)', () => {
  it('accepts a healthy price with no approval needed', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 8_000, key: 'k1' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ verdict: 'ok', approvedBy: null });
  });

  it('rejects a price above the MRP outright — no approval can lift it', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 12_000, key: 'k2', approval: { decidedBy: 'owner-2', reason: 'sale' } });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('price_above_mrp');
  });

  it('blocks a below-floor price with no separate approval', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k3' });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('price_below_floor');
  });

  it('refuses a self-approved below-floor price (§28)', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k4', approval: { decidedBy: 'owner-1', reason: 'clear stock' } });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('approved_by_the_setter');
  });

  it('refuses an approval from someone who may not approve prices', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k5', approval: { decidedBy: 'mgr', reason: 'clear stock' } });
    expect(r.status).toBe(422);
    expect(code(r)).toBe('approver_may_not_approve_prices');
  });

  it('allows a below-floor price with a proper two-person approval, and records who approved', async () => {
    const r = await propose(await cast(), { userId: 'owner-1', priceMinor: 6_000, key: 'k6', approval: { decidedBy: 'owner-2', reason: 'clear slow stock' } });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ verdict: 'below_floor', approvedBy: 'owner-2' });
  });

  it('refuses a caller who may not propose a price change (403)', async () => {
    const r = await propose(await cast(), { userId: 'cash', priceMinor: 8_000, key: 'k7' });
    expect(r.status).toBe(403);
  });
});
