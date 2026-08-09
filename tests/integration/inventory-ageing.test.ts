import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Stock ageing, end to end through the real API (M08-FR-04, API-04). "How long has the money been
// asleep, and how much of it?" The remaining stock is PROJECTED from the append-only movement ledger
// (hard rule #2), aged by receipt date, and valued at weighted-average cost — so the ageing total
// RECONCILES to the valuation endpoint's stock value (two reports about one shelf that cannot
// disagree). Uncosted stock is surfaced as an unvalued quantity, never priced at a guess (P-08).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

interface AgeingRow { label: string; quantityMinor: number; value: { minor: number }; shareBp: number }
interface AgeingBody {
  asOfDate: string;
  rows: AgeingRow[];
  totalValue: { minor: number; currency: string };
  oldestBucketValue: { minor: number };
  unvaluedMinor: number;
  method: string;
  asAt: string;
}

const move = (h: ApiHarness, tenantId: string, userId: string, m: Record<string, unknown>) =>
  h.request({ method: 'POST', path: '/v1/inventory/movements', userId, tenantId, idempotencyKey: `mv-${m['movementId']}`, body: m });

const ageing = (h: ApiHarness, tenantId: string, userId: string) =>
  h.request({ method: 'GET', path: '/v1/inventory/ageing', userId, tenantId });

const base = { locationId: 'L1', uom: 'each', enteredBy: 'u-owner' };

describe('stock ageing is projected from the ledger and valued at weighted-average (M08-FR-04)', () => {
  it('buckets remaining stock by receipt age and reconciles to the valuation stock value', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    // 100 units received ~100 days ago at ₹10.00, and 100 today at ₹10.50 → WAC value 205,000.
    await move(h, A, 'u-owner', { movementId: 'r1', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: daysAgo(100), ...base });
    await move(h, A, 'u-owner', { movementId: 'r2', productId: 'P1', kind: 'received', quantityMinor: 100, unitCostMinor: 1050, occurredAt: daysAgo(0), ...base });

    const res = await ageing(h, A, 'u-owner');
    expect(res.status).toBe(200);
    const body = res.body as AgeingBody;
    expect(body.method).toBe('weighted_average');
    expect(body.unvaluedMinor).toBe(0);
    expect(body.totalValue).toEqual({ minor: 205000, currency: 'INR' });

    const byLabel = new Map(body.rows.map((r) => [r.label, r]));
    // Each 100-unit lot carries its share of the WAC value: 205,000 ÷ 200 × 100 = 102,500.
    expect(byLabel.get('over 90 days')).toMatchObject({ quantityMinor: 100, value: { minor: 102500 } });
    expect(byLabel.get('0-30 days')).toMatchObject({ quantityMinor: 100, value: { minor: 102500 } });
    expect(body.oldestBucketValue.minor).toBe(102500);

    // The ageing total equals the valuation endpoint's stock value — the two never disagree.
    const val = (await h.request({ method: 'GET', path: '/v1/inventory/valuation', userId: 'u-owner', tenantId: A })).body as { totalValueMinor: number };
    expect(body.totalValue.minor).toBe(val.totalValueMinor);
  });

  it('ages only what is still on the shelf — an issue draws the oldest stock down first (FIFO)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r3', productId: 'P2', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: daysAgo(100), ...base });
    await move(h, A, 'u-owner', { movementId: 'r4', productId: 'P2', kind: 'received', quantityMinor: 100, unitCostMinor: 1000, occurredAt: daysAgo(0), ...base });
    // Sell 60 — the oldest 60 leave, so only 40 old remain, all 100 new remain.
    await move(h, A, 'u-owner', { movementId: 's1', productId: 'P2', kind: 'sold', quantityMinor: 60, occurredAt: daysAgo(0), ...base });

    const body = (await ageing(h, A, 'u-owner')).body as AgeingBody;
    const byLabel = new Map(body.rows.map((r) => [r.label, r]));
    expect(byLabel.get('over 90 days')?.quantityMinor).toBe(40);
    expect(byLabel.get('0-30 days')?.quantityMinor).toBe(100);
  });

  it('surfaces an uncosted receipt as unvalued quantity (P-08)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await move(h, A, 'u-owner', { movementId: 'r5', productId: 'P3', kind: 'received', quantityMinor: 20, unitCostMinor: 500, occurredAt: daysAgo(10), ...base });
    await move(h, A, 'u-owner', { movementId: 'r6', productId: 'P3', kind: 'received', quantityMinor: 40, occurredAt: daysAgo(5), ...base });

    const body = (await ageing(h, A, 'u-owner')).body as AgeingBody;
    expect(body.unvaluedMinor).toBe(40);
    expect(body.totalValue.minor).toBe(10000); // only the costed 20 carry a known value
  });

  it('is per-tenant and authorized: a cashier cannot read it (403), another tenant holds nothing', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');
    await move(h, A, 'u-owner', { movementId: 'r7', productId: 'P4', kind: 'received', quantityMinor: 10, unitCostMinor: 700, occurredAt: daysAgo(0), ...base });

    expect((await ageing(h, A, 'u-cash')).status).toBe(403);

    await h.seedOwner(B, 'u-owner-b');
    const b = (await ageing(h, B, 'u-owner-b')).body as AgeingBody;
    expect(b.totalValue.minor).toBe(0);
    expect(b.rows.every((r) => r.quantityMinor === 0)).toBe(true);
  });
});
