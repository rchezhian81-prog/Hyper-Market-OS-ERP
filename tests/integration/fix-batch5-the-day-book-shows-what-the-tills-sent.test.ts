// Fix batch 5 · daily-work defect D-050 · M23-FR-01 · P-08 — through the real authenticated API: before the day is posted,
// head office's day-book read says what the tills sent (sales, takings by tender, refunds by tender) and that the account
// names are not set up yet; once they are and the day is posted, nothing is left waiting. Facts only — no journal is
// previewed, and the posting itself is unchanged.
import { describe, it, expect } from 'vitest';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { withApprovals } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';

const A = `aaaaaaaa-aaaa-4aaa-8aaa-${Date.now().toString(16).padStart(12, '0').slice(-12)}`; // fresh per run on a shared database
const OWNER = 'u-owner'; const ACCT = 'u-acct';
const DAY = '2026-08-05';

const BACKINGS = useBackings();

async function cast(harness: () => ApiHarness): Promise<ApiHarness> {
  const h = harness();
  await h.seedOwner(A, OWNER);
  await h.provisionRole(A, ACCT, 'accountant');
  await h.provisionRole(A, 'u-mgr', 'store_manager');
  await h.store.append(A, STREAM.catalogue, makeEvent({
    id: 'pack-v1', type: 'CataloguePublished', occurredAt: '2026-08-01T00:00:00Z', idempotencyKey: `catalogue-${A}-v1`, source: 'test/catalogue',
    payload: { snapshot: { tenantId: A, version: 1, builtAt: '2026-08-01T00:00:00Z', products: [{ productId: 'RICE', hsnCode: '1006', taxBps: 500 }], barcodes: [] } },
  }));
  return h;
}
const sale = (h: ApiHarness, saleId: string, totalMinor: number, tenders: { kind: string; amountMinor: number }[]) => h.request({
  method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: A, idempotencyKey: `b5-${saleId}`,
  body: {
    saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: OWNER, tradingDay: DAY, committedAt: `${DAY}T09:00:00Z`,
    totalMinor, currency: 'INR', packVersion: 1, lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'each', unitPriceMinor: totalMinor, lineTotalMinor: totalMinor }], tenders,
  },
});
const read = (h: ApiHarness) => h.request({ method: 'GET', path: `/v1/finance/day-book/${DAY}`, userId: ACCT, tenantId: A });

describe.each(BACKINGS)('D-050 · the day book shows what the tills sent before posting ($name)', ({ harness }) => {
  it('sales, takings and refunds by tender, how many wait, and whether the account names exist — then nothing waits once posted', async () => {
    const h = await cast(harness);
    expect((await sale(h, 's1', 10_500, [{ kind: 'cash', amountMinor: 10_500 }])).status).toBeLessThan(300);
    expect((await sale(h, 's2', 20_000, [{ kind: 'upi', amountMinor: 15_000 }, { kind: 'cash', amountMinor: 5_000 }])).status).toBeLessThan(300);
    const ret = await h.request({
      method: 'POST', path: '/v1/sales/s1/returns', userId: OWNER, tenantId: A, idempotencyKey: 'b5-ret-1',
      body: await withApprovals(h, A, OWNER, 's1', { returnId: 'r1', number: 'r1', reasonCode: 'changed_mind', refundMinor: 10_500, refundTender: 'cash', approvedBy: 'u-mgr', processedAt: `${DAY}T12:00:00Z`, lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'each', disposition: 'resell' }] }),
    });
    expect(ret.status).toBeLessThan(300);

    const before = await read(h);
    expect(before.status).toBe(200);
    expect(before.body).toMatchObject({
      journals: [], postingMapDefined: false,
      tillsSent: {
        sales: { count: 2, totalMinor: 30_500 }, takings: [{ kind: 'cash', amountMinor: 15_500 }, { kind: 'upi', amountMinor: 15_000 }],
        returns: { count: 1, refundsMinor: 10_500 }, refunds: [{ kind: 'cash', amountMinor: 10_500 }], notYetPosted: 3,
      },
    });

    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: ACCT, tenantId: A, idempotencyKey: 'b5-map', body: DEFAULT_RETAIL_POSTING_MAP })).status).toBe(200);
    expect((await h.request({ method: 'POST', path: `/v1/finance/day-book/${DAY}/post`, userId: ACCT, tenantId: A, idempotencyKey: 'b5-post' })).status).toBe(201);
    const after = await read(h);
    expect(after.body).toMatchObject({ postingMapDefined: true, tillsSent: { sales: { count: 2 }, notYetPosted: 0 } });
  });
});
