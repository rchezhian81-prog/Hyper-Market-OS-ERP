import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// Replenishment suggestions (M09-FR-02, API-04) end to end through the real API. A stateless what-if:
// given per-product stock parameters it proposes WHAT to reorder and HOW MUCH — only items below their
// reorder point, each brought up to the max level (rounded up to the pack, raised to the supplier
// minimum) — and every proposal is ADVISORY ONLY (it can never become a purchase order by itself,
// hard rule #5). A blocked item is suppressed; the reorder point is computed from demand × lead + safety
// when not stated. The rule is the pure engine — this proves it is reachable and authorized.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const propose = (h: ApiHarness, t: string, u: string, items: unknown, key?: string) =>
  h.request({ method: 'POST', path: `/v1/replenishment/propose`, userId: u, tenantId: t, idempotencyKey: key ?? `rp-${u}-${String((items as unknown[]).length)}`, body: { items } });

const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;
interface Proposal { productId: string; position: number; reorderPoint: number; suggestedQty: number; reason: string; advisoryOnly: boolean; shelfLifeCap?: number; shelfLifeCapped?: boolean }
const proposals = (res: { body: unknown }): Proposal[] => (res.body as { proposals: Proposal[] }).proposals;

describe('replenishment: advisory reorder proposals up to max level, pack/MOQ rounding, blocked suppressed (M09-FR-02)', () => {
  it('proposes only for items below their reorder point, up to the max level, advisory only', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const out = proposals(await propose(h, A, 'u-owner', [
      { productId: 'P1', onHand: 5, maxLevel: 100, reorderPoint: 10 },   // 5 <= 10 → reorder 95
      { productId: 'P2', onHand: 50, maxLevel: 100, reorderPoint: 10 },  // 50 > 10 → none
    ]));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ productId: 'P1', suggestedQty: 95, reason: 'below_reorder_point', advisoryOnly: true });
  });

  it('rounds up to the pack and raises to the supplier minimum, and suppresses a blocked item', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const out = proposals(await propose(h, A, 'u-owner', [
      { productId: 'P1', onHand: 0, maxLevel: 100, reorderPoint: 50, orderMultiple: 12 },   // 100 → ceil(100/12)*12 = 108
      { productId: 'P2', onHand: 0, maxLevel: 5, reorderPoint: 10, minOrderQty: 20 },        // 5 → raised to 20
      { productId: 'P3', onHand: 0, maxLevel: 100, reorderPoint: 50, blocked: true },        // suppressed
    ], 'rp-round'));
    expect(out.find((p) => p.productId === 'P1')?.suggestedQty).toBe(108);
    expect(out.find((p) => p.productId === 'P2')?.suggestedQty).toBe(20);
    expect(out.find((p) => p.productId === 'P3')).toBeUndefined();
  });

  it('computes the reorder point from demand × lead + safety when it is not stated', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const out = proposals(await propose(h, A, 'u-owner', [
      { productId: 'P1', onHand: 10, maxLevel: 100, avgDailyDemand: 5, leadTimeDays: 3, safetyStock: 4 },  // ROP = 4 + 15 = 19
    ], 'rp-computed'));
    expect(out[0]).toMatchObject({ productId: 'P1', reorderPoint: 19, suggestedQty: 90 });
  });

  it('bounds a perishable order by remaining shelf life, and surfaces an over-order as an exception (D-3)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const out = proposals(await propose(h, A, 'u-owner', [
      // 10/day × 3 days left = 30 sellable; max 100 → capped to 30, so order 30 − 0
      { productId: 'FRESH', onHand: 0, maxLevel: 100, reorderPoint: 50, avgDailyDemand: 10, remainingShelfLifeDays: 3 },
      // 5/day × 2 days = 10 sellable, but 15 on hand → ordering anything over-stocks it → held exception
      { productId: 'HELD', onHand: 15, maxLevel: 100, reorderPoint: 50, avgDailyDemand: 5, remainingShelfLifeDays: 2 },
    ], 'rp-shelf'));

    const fresh = out.find((p) => p.productId === 'FRESH');
    expect(fresh?.suggestedQty).toBe(30);
    expect(fresh?.shelfLifeCap).toBe(30);
    expect(fresh?.shelfLifeCapped).toBe(true);

    const held = out.find((p) => p.productId === 'HELD');
    expect(held?.suggestedQty).toBe(0);
    expect(held?.reason).toBe('held_shelf_life');
    expect(held?.shelfLifeCapped).toBe(true);
  });

  it('is authorized and refuses malformed input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager');   // may read/plan
    await h.provisionRole(A, 'u-cash', 'cashier');        // may not

    expect((await propose(h, A, 'u-mgr', [{ productId: 'P1', onHand: 1, maxLevel: 10, reorderPoint: 5 }], 'rp-mgr')).status).toBe(200);
    expect((await propose(h, A, 'u-cash', [{ productId: 'P1', onHand: 1, maxLevel: 10, reorderPoint: 5 }], 'rp-cash')).status).toBe(403);

    expect((await h.request({ method: 'POST', path: '/v1/replenishment/propose', userId: 'u-owner', tenantId: A, idempotencyKey: 'rp-bad1', body: { items: 'not-a-list' } })).status).toBe(400);
    expect(codeOf(await propose(h, A, 'u-owner', [{ productId: 'P1', onHand: 1 }], 'rp-bad2'))).toBe('not_readable_as_an_item');   // no maxLevel
    expect(codeOf(await propose(h, A, 'u-owner', [{ productId: 'P1', onHand: 1, maxLevel: 0, reorderPoint: 5 }], 'rp-bad3'))).toBe('invalid_replenishment_parameter');  // maxLevel < 1
  });
});

// M09 loop: the route DERIVES avgDailyDemand from the store's own banked sales for any item that did not
// supply one, so REAL demand drives the reorder point and the D-3 shelf-life cap. Sales are banked relative
// to the surface clock ("today"), so they land in the trailing derivation window.
const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, qty: number, tradingDay: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `rp-sale-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
    },
  });

const proposeQ = (h: ApiHarness, u: string, items: unknown, key: string, query?: Record<string, string>) =>
  h.request({ method: 'POST', path: '/v1/replenishment/propose', userId: u, tenantId: A, idempotencyKey: key, body: { items }, ...(query === undefined ? {} : { query }) });

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const YESTERDAY = isoDay(Date.now() - 86_400_000);

describe('replenishment derives real demand from banked sales (M09 loop)', () => {
  it('fills a missing avgDailyDemand from sales history — driving both the reorder point and the shelf-life cap', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'D1', 'FRESH', 280, YESTERDAY); // 280 sold → over the trailing 28 days, 10/day

    const res = await proposeQ(h, 'u-owner', [
      // No avgDailyDemand and no reorderPoint — both are now derived from the real 10/day.
      { productId: 'FRESH', onHand: 5, maxLevel: 100, leadTimeDays: 3, safetyStock: 4, remainingShelfLifeDays: 5 },
    ], 'rp-derive');
    const fresh = proposals(res).find((p) => p.productId === 'FRESH')!;

    expect(fresh.reorderPoint).toBe(34);   // 4 + ceil(10 × 3) — derived demand drove the reorder point
    expect(fresh.shelfLifeCap).toBe(50);   // 10 × 5 — derived demand drove the D-3 shelf-life cap
    expect(fresh.shelfLifeCapped).toBe(true);
    expect(fresh.suggestedQty).toBe(45);   // up to min(100, 50) from a position of 5
    expect((res.body as { demandWindow?: { days: number } }).demandWindow?.days).toBe(28);
  });

  it('a supplied avgDailyDemand still wins over the derived one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'D2', 'FRESH', 280, YESTERDAY); // would derive 10/day

    const out = proposals(await proposeQ(h, 'u-owner', [
      { productId: 'FRESH', onHand: 0, maxLevel: 100, reorderPoint: 50, avgDailyDemand: 2, remainingShelfLifeDays: 5 },
    ], 'rp-supplied'));
    expect(out[0]!.shelfLifeCap).toBe(10); // supplied 2/day → 2 × 5, not the derived 10 × 5
  });

  it('honours a custom demand window, and rejects a bad one', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'D3', 'FRESH', 70, YESTERDAY); // 70 sold yesterday

    // Over 7 days that is 10/day (not 70/28 ≈ 3): the window changes the divisor.
    const out = proposals(await proposeQ(h, 'u-owner', [
      { productId: 'FRESH', onHand: 0, maxLevel: 100, reorderPoint: 50, remainingShelfLifeDays: 5 },
    ], 'rp-window', { demandWindowDays: '7' }));
    expect(out[0]!.shelfLifeCap).toBe(50); // 10/day × 5

    expect(codeOf(await proposeQ(h, 'u-owner', [{ productId: 'FRESH', onHand: 0, maxLevel: 10, reorderPoint: 5 }], 'rp-badwin', { demandWindowDays: '0' }))).toBe('bad_demand_window');
  });

  it('with no sales, derivation changes nothing (the pure what-if is preserved)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    const out = proposals(await proposeQ(h, 'u-owner', [
      { productId: 'NOSALE', onHand: 5, maxLevel: 50, reorderPoint: 10 },
    ], 'rp-nosale'));
    expect(out[0]!.suggestedQty).toBe(45); // 50 − 5, exactly as before
    expect(out[0]!.shelfLifeCap).toBeUndefined();
  });
});
