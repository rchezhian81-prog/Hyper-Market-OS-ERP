import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Stock valued at WEIGHTED AVERAGE, end to end through the real API (M08-FR-04, API-04). The owner
// chose weighted-average as the one cost basis (OWNER-DECISIONS, 9 Aug 2026). The value is PROJECTED
// from the same append-only movement ledger as on-hand — never a stored figure (hard rule #2) — so a
// receipt at a new cost re-averages, an issue leaves at that average as cost of goods sold, and a
// receipt with no cost is surfaced as UNVALUED rather than folded in at zero (P-08). This proves the
// wired pipeline: append `received`/`sold` movements, read GET /v1/inventory/valuation back, and the
// figures are the weighted average, with real per-tenant RBAC.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const T1 = '2026-08-07T10:00:00.000Z';
const T2 = '2026-08-07T11:00:00.000Z';
const T3 = '2026-08-07T12:00:00.000Z';

interface Valuation {
  productId: string;
  locationId: string;
  onHandMinor: number;
  value: { minor: number; currency: string };
  unitCostMinor: number | 'not_known';
  cogs: { minor: number; currency: string };
  unvaluedMinor: number;
}
interface ValuationBody { rows: Valuation[]; totalValueMinor: number; method: string; asAt: string }

const move = (h: ApiHarness, tenantId: string, userId: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId, tenantId, idempotencyKey: `mv-${m['movementId']}`, body: m });

const valuation = async (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/valuation', userId, tenantId });

const base = { locationId: 'L1', uom: 'each', enteredBy: 'u-owner' };

describe('stock is valued at weighted-average cost, projected from the ledger (M08-FR-04, API-04)', () => {
  it('re-averages on each costed receipt and leaves issues at the average as COGS', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // 100 @ ₹10.00, then 100 @ ₹10.50 → weighted average ₹10.25 (1025 minor) over 200 units.
    expect((await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: T1, ...base })).status).toBe(202);
    expect((await move(h, A, 'u-owner', { movementId: 'r2', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1050, occurredAt: T2, ...base })).status).toBe(202);
    // Sell 50 → COGS 50 × 1025 = 51,250; value falls to 153,750 over 150 units; average holds at 1025.
    expect((await move(h, A, 'u-owner', { movementId: 's1', productId: 'P1', kind: 'sold', quantityMinor: 50, occurredAt: T3, ...base })).status).toBe(202);

    const res = await valuation(h, A, 'u-owner');
    expect(res.status).toBe(200);
    const body = res.body as ValuationBody;
    expect(body.method).toBe('weighted_average');

    const p1 = body.rows.find((r) => r.productId === 'P1' && r.locationId === 'L1');
    expect(p1).toMatchObject({
      onHandMinor: 150,
      value: { minor: 153750, currency: 'INR' },
      unitCostMinor: 1025,
      cogs: { minor: 51250, currency: 'INR' },
      unvaluedMinor: 0,
    });
    expect(body.totalValueMinor).toBe(153750);
  });

  it('surfaces a receipt with no cost as UNVALUED rather than folding it in at zero (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // 20 @ ₹5.00 (valued), then 40 with no cost at all — the uncosted 40 must not drag the average.
    await move(h, A, 'u-owner', { movementId: 'r3', productId: 'P2', kind: 'received', quantityMinor: 20, unitCostMinor: 500, occurredAt: T1, ...base });
    await move(h, A, 'u-owner', { movementId: 'r4', productId: 'P2', kind: 'received', quantityMinor: 40, occurredAt: T2, ...base });

    const body = (await valuation(h, A, 'u-owner')).body as ValuationBody;
    const p2 = body.rows.find((r) => r.productId === 'P2');
    expect(p2).toMatchObject({
      onHandMinor: 60,
      value: { minor: 10000, currency: 'INR' }, // only the costed 20 are in value
      unitCostMinor: 500, // ₹5.00 average of what IS costed, undragged by the uncosted 40
      unvaluedMinor: 40,
    });
  });

  it('is per-tenant and authorized: a cashier cannot read it (403), and another tenant holds nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, A, 'u-owner', { movementId: 'r5', productId: 'P5', kind: 'received', quantityMinor: 10, unitCostMinor: 700, occurredAt: T1, ...base });

    // A cashier holds no inventory.availability.read — the till never sees stock value.
    expect((await valuation(h, A, 'u-cash')).status).toBe(403);

    await h.seedOwner(B, 'u-owner-b');
    const b = (await valuation(h, B, 'u-owner-b')).body as ValuationBody;
    expect(b.rows).toEqual([]);
    expect(b.totalValueMinor).toBe(0);
  });
});
