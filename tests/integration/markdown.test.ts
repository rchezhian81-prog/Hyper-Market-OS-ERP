import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// D-4 expiry markdown ladder on the live API (API-04). Given near-expiry batches, the route proposes a
// marked-down price from remaining shelf life + sell-through — with the sell-through read from the store's
// own sales. Advisory only: a person commits via the price-change approval path (hard rule #5).

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const YESTERDAY = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);

const bankSale = (h: ApiHarness, u: string, saleId: string, productId: string, qty: number, tradingDay: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: `md-${saleId}`,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay, committedAt: `${tradingDay}T09:00:00Z`, totalMinor: qty * 100, currency: 'INR', packVersion: 1,
      lines: [{ productId, quantityMinor: qty, uom: 'each', unitPriceMinor: 100, lineTotalMinor: qty * 100 }],
      tenders: [{ kind: 'cash', amountMinor: qty * 100 }],
    },
  });

const markdown = (h: ApiHarness, u: string, items: unknown, key: string, policy?: unknown) =>
  h.request({ method: 'POST', path: '/v1/pricing/markdown/propose', userId: u, tenantId: A, idempotencyKey: key, body: { items, ...(policy === undefined ? {} : { policy }) } });

interface Proposal { productId: string; markdownBps: number; newPriceMinor: number; reason: string; surplusMinor: number; avgDailyDemandMinor: number }
const proposals = (res: { body: unknown }): Proposal[] => (res.body as { proposals: Proposal[] }).proposals;
const codeOf = (res: { body: unknown }): string | undefined => (res.body as { error?: { code?: string } }).error?.code;

describe('expiry markdown ladder on the live API (D-4)', () => {
  it('proposes a markdown for a near-expiry surplus, using demand read from the store’s own sales', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'M1', 'BREAD', 280, YESTERDAY); // 280 over the trailing 28 days → 10/day

    const out = proposals(await markdown(h, 'u-owner', [
      // No avgDailyDemand → derived 10/day. 10×2 = 20 will sell; 80 of 100 will not → 2 days left = 25% off.
      { productId: 'BREAD', batchId: 'B-1', remainingShelfLifeDays: 2, onHandMinor: 100, currentPriceMinor: 5_000 },
      // Plenty of shelf life and low stock → it will all clear → no markdown.
      { productId: 'BREAD', remainingShelfLifeDays: 30, onHandMinor: 10, currentPriceMinor: 5_000 },
    ], 'md-derive'));

    const near = out[0]!;
    expect(near.avgDailyDemandMinor).toBe(10); // derived from the banked sales
    expect(near.surplusMinor).toBe(80);
    expect(near.markdownBps).toBe(2500);
    expect(near.newPriceMinor).toBe(3_750);
    expect(near.reason).toBe('marked_down');

    expect(out[1]!.reason).toBe('will_clear');
    expect(out[1]!.markdownBps).toBe(0);
  });

  it('lets a supplied demand override the derived one, and honours a custom ladder', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'M2', 'BREAD', 280, YESTERDAY); // would derive 10/day

    // Supplied 100/day → 100×2 = 200 ≥ 100 on hand → it will clear, no markdown (derivation would have said mark down).
    const out = proposals(await markdown(h, 'u-owner', [
      { productId: 'BREAD', remainingShelfLifeDays: 2, onHandMinor: 100, currentPriceMinor: 5_000, avgDailyDemand: 100 },
    ], 'md-supplied'));
    expect(out[0]!.reason).toBe('will_clear');

    // A custom ladder: 40% within two days.
    const custom = proposals(await markdown(h, 'u-owner', [
      { productId: 'BREAD', remainingShelfLifeDays: 2, onHandMinor: 100, currentPriceMinor: 5_000, avgDailyDemand: 0 },
    ], 'md-custom', { ladder: [{ maxDaysLeft: 2, markdownBps: 4000 }] }));
    expect(custom[0]!.markdownBps).toBe(4000);
    expect(custom[0]!.newPriceMinor).toBe(3_000);
  });

  it('is authorized (a pricing proposal, not the till) and refuses malformed input', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds price.change.propose
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    const item = [{ productId: 'BREAD', remainingShelfLifeDays: 2, onHandMinor: 10, currentPriceMinor: 5_000, avgDailyDemand: 1 }];
    expect((await markdown(h, 'u-mgr', item, 'md-mgr')).status).toBe(200);
    expect((await markdown(h, 'u-cash', item, 'md-cash')).status).toBe(403);

    expect(codeOf(await markdown(h, 'u-owner', 'not-a-list', 'md-bad1'))).toBe('not_readable_as_markdown_items');
    expect(codeOf(await markdown(h, 'u-owner', [{ productId: 'BREAD' }], 'md-bad2'))).toBe('not_readable_as_a_markdown_item');
    expect(codeOf(await markdown(h, 'u-owner', [{ productId: 'BREAD', remainingShelfLifeDays: 2, onHandMinor: 10, currentPriceMinor: 0, avgDailyDemand: 1 }], 'md-bad3'))).toBe('invalid_markdown_input');
  });
});
