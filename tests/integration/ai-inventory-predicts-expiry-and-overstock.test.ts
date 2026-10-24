import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { apiHarness } from '../support/api-harness';
import { inventoryPredictions, forecastReorders, OVERSTOCK_COVER_DAYS, LOOKAHEAD_DAYS, FIT_DAYS } from '../../services/api/src/ai-predictions';
import type { ExpiryActionItem } from '../../packages/fefo/src/index';

/**
 * **A03's expiry prediction and the forecast's limits (OB-288 lane 4 · P1 · A03 "stockout/overstock/expiry prediction").**
 *
 * Over the real stock and sales ledgers (written through the real routes), with the near-expiry reader standing in for
 * the batch register: a batch beyond the seven-day markdown window that will NOT sell before its date at the rate the
 * product sells is a draft for the manager, saying how many would be left; a batch that WILL sell in time is not; a
 * batch inside seven days is the markdown leg's, never this one's. Nothing is written by any leg.
 */
describe('A03 predicts expiry and overstock from the shop\'s own sales', () => {
  it('drafts what will not sell in time, leaves what will, and writes nothing', async () => {
    const h = apiHarness();
    const T = randomUUID();
    const today = new Date().toISOString().slice(0, 10);
    const dayAgo = (n: number): string => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-cash', 'cashier');
    const post = (path: string, body: unknown, key: string, u = 'u-owner') => h.request({ method: 'POST', path, userId: u, tenantId: T, idempotencyKey: key, body });
    expect((await post('/v1/inventory/movements', { movementId: 'rx-curd', productId: 'CURD', locationId: 'S1', kind: 'received', quantityMinor: 200, uom: 'ea', occurredAt: new Date(Date.now() - 7_200_000).toISOString(), enteredBy: 'u-owner', unitCostMinor: 2_000 }, 'rx-curd')).status).toBe(202);
    for (let i = 1; i <= 14; i += 1) {
      expect((await post('/v1/sales', {
        saleId: `curd-${i}`, receiptNumber: `R-curd-${i}`, laneId: 'lane-1', locationId: 'S1', cashierId: 'u-cash', tradingDay: dayAgo(i), committedAt: new Date(Date.now() - 60_000).toISOString(),
        totalMinor: 8 * 3_000, currency: 'INR', packVersion: 1, lines: [{ productId: 'CURD', quantityMinor: 8, uom: 'ea', unitPriceMinor: 3_000, lineTotalMinor: 8 * 3_000 }], tenders: [{ kind: 'cash', amountMinor: 8 * 3_000 }],
      }, `curd-${i}`, 'u-cash')).status).toBe(202);
    }
    // 112 sold over the 56-day window → 2 a day. Three batches on the register:
    const batches: ExpiryActionItem[] = [
      { batchId: 'B-LATE', productId: 'CURD', expiry: '2099-01-01', qty: 60, status: 'near_expiry', action: 'markdown', daysToExpiry: 20 }, // 2 × 20 = 40 sell → 20 left
      { batchId: 'B-FINE', productId: 'CURD', expiry: '2099-01-01', qty: 30, status: 'near_expiry', action: 'markdown', daysToExpiry: 30 }, // 60 would sell → fine
      { batchId: 'B-SOON', productId: 'CURD', expiry: '2099-01-01', qty: 50, status: 'near_expiry', action: 'markdown', daysToExpiry: 3 },  // the markdown leg's
    ];
    const asked: { asOf: string; nearExpiryDays: number }[] = [];
    const before = (await h.store.readStream(T, 'ai')).length;
    const drafts = await inventoryPredictions(h.store, T, new Date().toISOString(), async (_t, opts) => { asked.push(opts as { asOf: string; nearExpiryDays: number }); return batches; });
    expect(asked).toEqual([{ asOf: today, nearExpiryDays: OVERSTOCK_COVER_DAYS }]);
    const expiry = drafts.filter((d) => d.proposalId.startsWith('a03-expiry-forecast-'));
    expect(expiry.map((d) => d.proposalId)).toEqual([`a03-expiry-forecast-B-LATE-${today}`]);
    expect(expiry[0]!.summary).toMatch(/about 20 would be left at expiry/);
    expect(expiry[0]!.summary).toMatch(/the manager decides/);
    expect(expiry[0]!.confidence).toMatchObject({ band: 'medium', basis: 'forecast' });
    expect(expiry[0]!.confidence!.uncertainty).toMatch(/festival/);
    // 200 − 112 = 88 on hand at 2 a day is 44 days of cover — inside the 91-day line, so NOT overstock.
    expect(drafts.some((d) => d.proposalId.startsWith('a03-overstock-CURD'))).toBe(false);
    // 88 on hand against ~14 in the next seven days — no stock-out to forecast either.
    expect(await forecastReorders(h.store, T, new Date().toISOString())).toEqual([]);
    expect(LOOKAHEAD_DAYS).toBe(7);
    expect(FIT_DAYS).toBe(56);
    // Read-only: no AI fact (or any other) was written by the legs.
    expect((await h.store.readStream(T, 'ai')).length).toBe(before);
  });
});
