import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// API-04/API-09 M27-FR-02 — concession stock is EXCLUDED from the store's valuation, end to end
// through the real pipeline. Ownership now rides on the M08 movement ledger itself: a received lot
// can be tagged as a concessionaire's, and the store valuation reads the REAL ledger and leaves that
// stock out — the ₹40,00,000-of-someone-else's-gold-in-the-balance-sheet mistake, prevented at source.
// Each owner's stock is valued in its OWN weighted-average pool, and what is excluded is NAMED, never
// silently dropped. The write is refused if concession stock arrives with no owner. Proven against the
// real per-tenant RBAC, the optional dept.concession entitlement, and stock from the real ledger.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const AT = '2026-09-24T10:00:00.000Z';
const base = { locationId: 'L1', uom: 'each', occurredAt: AT, enteredBy: 'u-owner' };

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

const move = (h: ApiHarness, user: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId: user, tenantId: A, idempotencyKey: `mv-${String(m['movementId'])}`, body: m });

const storeValuation = (h: ApiHarness, user: string, branchId = 'L1') =>
  h.request({ method: 'GET', path: `/v1/concession/branches/${branchId}/store-valuation`, userId: user, tenantId: A });

interface Excluded { ownership: string; ownerId: string; lots: number; valueMinor: number }
interface ValuationBody { branchId: string; ownedValueMinor: number; ownedLots: number; excluded: Excluded[]; excludedValueMinor: number }

describe('concession stock is excluded from the store valuation (M27-FR-02)', () => {
  it('values the store\'s own stock and EXCLUDES concession stock, naming its owner', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'dept.concession');

    // The store's own rice: 10 @ ₹50 = ₹500.
    expect((await move(h, 'u-owner', { movementId: 'r1', productId: 'RICE', kind: 'received', quantityMinor: 10, unitCostMinor: 50, ...base })).status).toBe(202);
    // The jeweller's gold on the store's shelf: 2 @ ₹20,00,000 = ₹40,00,000 — NOT the store's.
    expect((await move(h, 'u-owner', { movementId: 'g1', productId: 'GOLD', kind: 'received', quantityMinor: 2, unitCostMinor: 2_000_000, ownership: 'concession', ownerId: 'jeweller-1', ...base })).status).toBe(202);

    const res = await storeValuation(h, 'u-owner');
    expect(res.status).toBe(200);
    const body = res.body as ValuationBody;
    expect(body.ownedValueMinor).toBe(500);            // the gold is not in the store's value
    expect(body.excludedValueMinor).toBe(4_000_000);
    expect(body.excluded).toEqual([{ ownership: 'concession', ownerId: 'jeweller-1', lots: 1, valueMinor: 4_000_000 }]);
  });

  it('values each owner\'s pool separately — a concessionaire\'s cost never averages into the store\'s', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'dept.concession');
    // Same product code, two owners: the store's at ₹50, the concessionaire's at ₹90. If the pools
    // were merged the average would drag the store's value off; they must stay separate.
    await move(h, 'u-owner', { movementId: 's1', productId: 'BAG', kind: 'received', quantityMinor: 4, unitCostMinor: 50, ...base });
    await move(h, 'u-owner', { movementId: 'c1', productId: 'BAG', kind: 'received', quantityMinor: 2, unitCostMinor: 90, ownership: 'concession', ownerId: 'kiosk-9', ...base });

    const body = (await storeValuation(h, 'u-owner')).body as ValuationBody;
    expect(body.ownedValueMinor).toBe(200);   // 4 × 50, the store's own pool only
    expect(body.excludedValueMinor).toBe(180); // 2 × 90, the kiosk's pool
    expect(body.excluded[0]).toMatchObject({ ownerId: 'kiosk-9', ownership: 'concession' });
  });

  it('refuses concession stock that names no owner — it could not be excluded honestly', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.enableFeature(A, 'dept.concession');
    const bad = await move(h, 'u-owner', { movementId: 'x1', productId: 'GOLD', kind: 'received', quantityMinor: 1, unitCostMinor: 100, ownership: 'consignment', ...base });
    expect(bad.status).toBe(422);
    expect(codeOf(bad)).toBe('ownership_without_an_owner');
  });

  it('is gated on the concession entitlement and on concession.charge.read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    // Without the optional dept.concession feature the route is not reachable (M36-FR-01).
    const notEntitled = await storeValuation(h, 'u-owner');
    expect(notEntitled.status).toBe(403);
    expect(codeOf(notEntitled)).toBe('feature_not_entitled');

    // With the feature on, a cashier still holds no concession read authority.
    await h.enableFeature(A, 'dept.concession');
    expect((await storeValuation(h, 'u-cash')).status).toBe(403);
  });
});
