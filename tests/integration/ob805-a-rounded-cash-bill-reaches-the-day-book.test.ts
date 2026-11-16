// OB-805 A (owner, 16 Nov 2026, in writing) · daily-work defect D-003 · OB-285 · M23-FR-01 — a ₹303.50 CASH bill rung on the
// till's own model is taken as ₹303.00 with a round off of −₹0.50 (down only: never above the goods). The record the till
// saved is relayed exactly as the store computer relays it (`toCloudSale`) and banked through head office's real
// authenticated API; the day book then posts it balanced — cash in hand ₹303.00, the GST of the goods, the 50 paise to the
// round-off account, sales clearing at nil — and a refund of the whole bill stops at the ₹303.00 taken. In memory AND on real
// PostgreSQL (`useBackings`). Synthetic data only (hard rule #7).
import { describe, it, expect } from 'vitest';
import type { ApiHarness } from '../support/api-harness';
import { useBackings } from '../support/backings';
import { withApprovals } from '../support/refund-approval';
import { STREAM } from '../../services/api/src/adapters';
import { makeEvent } from '../../packages/contracts/src/event';
import { DEFAULT_RETAIL_POSTING_MAP } from '../../packages/finance/src/index';
import { bootPos } from '../../apps/pos/src/browser-entry';
import { toCloudSale } from '../../edge/store-edge/src/cloud-sale';

const A = `aaaaaaaa-aaaa-4aaa-8aaa-${(Date.now() + 805).toString(16).padStart(12, '0').slice(-12)}`; // fresh per run on a shared database
const OWNER = 'u-owner'; const ACCT = 'u-acct';
const DAY = '2026-08-06';
const AT = `${DAY}T09:00:00.000Z`;

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

/** Ring ₹303.50 of rice on the till's own model and pay CASH; return the record it saved to the disk. */
async function ringCash(saleId: string): Promise<Record<string, unknown>> {
  const saved: string[] = [];
  const pos = bootPos({
    laneId: 'lane-1', cashierId: OWNER, tradingDay: DAY, taxPercent: 5,
    durable: async (_id, record) => { saved.push(record); return { committed: true, durable: true, detail: 'saved', laneMessage: 'Saved.' }; },
  });
  pos.scan({ productId: 'RICE', description: 'Ponni rice 5kg', unitPriceMinor: 30_350, qty: 1 });
  expect(pos.payableMinor()).toBe(30_350);
  await pos.tenderCash(saleId, `R-${saleId}`, AT);
  return JSON.parse(saved[0]!) as Record<string, unknown>;
}

describe.each(BACKINGS)('OB-805 A · a rounded cash bill is banked and posts balanced ($name)', ({ harness }) => {
  it('₹303.50 in cash: head office banks ₹303.00 with −₹0.50 round off; the day book posts it to round_off; a refund stops at ₹303.00', async () => {
    const h = await cast(harness);
    const record = await ringCash('s805');
    expect(record).toMatchObject({ total: 30_300, roundOffMinor: -50 });

    // Exactly as the store computer relays it.
    const banked = await h.request({ method: 'POST', path: '/v1/sales', userId: OWNER, tenantId: A, idempotencyKey: 'ob805-s1', body: toCloudSale(record, 1) });
    expect(banked.status).toBeLessThan(300);
    // Head office found nothing wrong with the bill: tenders add to the total, lines + round off add to the total.
    expect(JSON.stringify(banked.body)).not.toMatch(/tender_does_not_sum_to_total|lines_do_not_sum_to_total/);

    expect((await h.request({ method: 'PUT', path: '/v1/finance/posting-map', userId: ACCT, tenantId: A, idempotencyKey: 'ob805-map', body: DEFAULT_RETAIL_POSTING_MAP })).status).toBe(200);
    const posted = await h.request({ method: 'POST', path: `/v1/finance/day-book/${DAY}/post`, userId: ACCT, tenantId: A, idempotencyKey: 'ob805-post' });
    expect(posted.status).toBe(201);
    const body = posted.body as { journals: { kind: string; lines: { accountCode: string; debitMinor: number; creditMinor: number }[] }[]; exceptions: unknown[] };
    expect(body.exceptions).toEqual([]);
    const sale = body.journals.find((j) => j.kind === 'sale')!;
    expect(sale.lines).toEqual(expect.arrayContaining([
      { accountCode: 'sales_clearing', debitMinor: 30_300, creditMinor: 0 },
      { accountCode: 'round_off', debitMinor: 50, creditMinor: 0 },
    ]));
    const day = (await h.request({ method: 'GET', path: `/v1/finance/day-book/${DAY}`, userId: ACCT, tenantId: A })).body as { accounts: { accountCode: string; balanceMinor: number; debitMinor: number }[] };
    expect(day.accounts.find((a) => a.accountCode === 'cash_in_hand')).toMatchObject({ debitMinor: 30_300 });
    expect(day.accounts.find((a) => a.accountCode === 'sales_clearing')).toMatchObject({ balanceMinor: 0 });
    expect(day.accounts.find((a) => a.accountCode === 'round_off')).toMatchObject({ debitMinor: 50 });

    // The whole bill back: never more than was taken.
    const refund = async (refundMinor: number, key: string) => h.request({
      method: 'POST', path: '/v1/sales/s805/returns', userId: OWNER, tenantId: A, idempotencyKey: key,
      body: await withApprovals(h, A, OWNER, 's805', { returnId: key, number: key, reasonCode: 'changed_mind', refundMinor, refundTender: 'cash', approvedBy: 'u-mgr', processedAt: `${DAY}T12:00:00Z`, lines: [{ productId: 'RICE', quantityMinor: 1, uom: 'ea', disposition: 'resell' }] }),
    });
    const tooMuch = await refund(30_350, 'ob805-r-over');
    expect(tooMuch.status).toBeGreaterThanOrEqual(400);
    expect((await refund(30_300, 'ob805-r-1')).status).toBeLessThan(300);
  });
});
