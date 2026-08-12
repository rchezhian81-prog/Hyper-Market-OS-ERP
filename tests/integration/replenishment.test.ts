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
