import { describe, it, expect } from 'vitest';
import { apiHarness, type ApiHarness } from '../support/api-harness';

// B11 / M10-FR-03: one-up/one-down lot traceability export on the live API. For a batch, the export lists
// who it came FROM (supplier + GRN) and who it went TO (sales + identified customers), reconciled so an
// over-dispatch surfaces as a gap. A traceability read gated on the manager/owner, not the cashier's till.

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

const inbound = [{ supplierId: 'sup-1', supplierName: 'Amul', grnId: 'GRN-100', receivedDate: '2026-08-01', quantityMinor: 10000 }];
const outbound = [
  { saleId: 'SALE-9', soldDate: '2026-08-05', quantityMinor: 3000, customerId: 'cust-7' },
  { saleId: 'SALE-3', soldDate: '2026-08-03', quantityMinor: 2000 },
];

const trace = (h: ApiHarness, userId: string, body: unknown, key: string) =>
  h.request({ method: 'POST', path: '/v1/quality/lot-trace/export', userId, tenantId: A, idempotencyKey: key, body });

interface Trace {
  batchId: string; totalReceivedMinor: number; totalDispatchedMinor: number; remainingOnHandMinor: number;
  identifiedRecipientCount: number; anonymousSaleCount: number; reconciled: boolean;
  outbound: { saleId: string; customerId?: string }[];
}

describe('lot-trace export on the live API (B11 / M10-FR-03)', () => {
  it('builds the reconciled supplier→store→recipient trace for a batch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const t = (await trace(h, 'u-owner', { batchId: 'B-42', productId: 'milk-1l', inbound, outbound }, 'lt-ok')).body as Trace;
    expect(t.totalReceivedMinor).toBe(10000);
    expect(t.totalDispatchedMinor).toBe(5000);
    expect(t.remainingOnHandMinor).toBe(5000);
    expect(t.identifiedRecipientCount).toBe(1);
    expect(t.anonymousSaleCount).toBe(1); // the walk-in sale is kept, not dropped
    expect(t.reconciled).toBe(true);
    expect(t.outbound.map((r) => r.saleId)).toEqual(['SALE-3', 'SALE-9']); // date-sorted
  });

  it('surfaces an over-dispatch as an unreconciled trace (a traceability gap, never hidden)', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    const t = (await trace(h, 'u-owner', { batchId: 'B-42', productId: 'milk-1l', inbound, outbound: [{ saleId: 'SALE-1', soldDate: '2026-08-05', quantityMinor: 12000 }] }, 'lt-over')).body as Trace;
    expect(t.reconciled).toBe(false);
    expect(t.remainingOnHandMinor).toBe(-2000);
  });

  it('refuses a missing batch and a bad record, and gates on the traceability read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-mgr', 'store_manager'); // holds quality.lottrace.read
    await h.provisionRole(A, 'u-cash', 'cashier');       // does not

    expect((await trace(h, 'u-owner', { productId: 'milk-1l', inbound, outbound }, 'lt-nobatch')).status).toBe(400);
    expect((await trace(h, 'u-owner', { batchId: 'B-42', productId: 'milk-1l', inbound: [{ ...inbound[0], receivedDate: 'Aug' }], outbound }, 'lt-baddate')).status).toBe(400);

    // The manager may run a trace; the till may not.
    expect((await trace(h, 'u-mgr', { batchId: 'B-42', productId: 'milk-1l', inbound, outbound }, 'lt-mgr')).status).toBe(200);
    expect((await trace(h, 'u-cash', { batchId: 'B-42', productId: 'milk-1l', inbound, outbound }, 'lt-rbac')).status).toBe(403);
  });
});

// batch-on-sale inc3a: the OUTBOUND is now folded from the REAL banked sales whose lines carry the batch.
const bankSale = (h: ApiHarness, u: string, saleId: string, batchId: string | undefined, key: string) =>
  h.request({
    method: 'POST', path: '/v1/sales', userId: u, tenantId: A, idempotencyKey: key,
    body: {
      saleId, receiptNumber: `R-${saleId}`, laneId: 'lane-1', cashierId: u,
      tradingDay: '2026-08-11', committedAt: '2026-08-11T10:00:00Z', totalMinor: 5000, currency: 'INR', packVersion: 1,
      lines: [{ productId: 'milk-1l', quantityMinor: 2000, uom: 'each', unitPriceMinor: 2500, lineTotalMinor: 5000, ...(batchId === undefined ? {} : { batchId }) }],
      tenders: [{ kind: 'cash', amountMinor: 5000 }],
    },
  });
const sold = (h: ApiHarness, u: string, batchId: string) =>
  h.request({ method: 'GET', path: `/v1/quality/lot-trace/${batchId}/sold`, userId: u, tenantId: A });

interface Sold { batchId: string; outbound: { saleId: string; quantityMinor: number }[]; totalDispatchedMinor: number; saleCount: number; anonymousSaleCount: number }

describe('lot-trace outbound folds real banked sales (batch-on-sale inc3a)', () => {
  it('lists the batch-tagged banked sales as the outbound for a batch', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');

    await bankSale(h, 'u-owner', 'S-100', 'LOT-9', 'bs-1');
    await bankSale(h, 'u-owner', 'S-101', 'LOT-9', 'bs-2');
    await bankSale(h, 'u-owner', 'S-102', 'LOT-OTHER', 'bs-3'); // a different batch — must not appear

    const r = (await sold(h, 'u-owner', 'LOT-9')).body as Sold;
    expect(r.saleCount).toBe(2);
    expect(r.outbound.map((x) => x.saleId).sort()).toEqual(['S-100', 'S-101']);
    expect(r.totalDispatchedMinor).toBe(4000);
    expect(r.anonymousSaleCount).toBe(2); // no customer captured on the sale yet (M16 linkage is later)
  });

  it('feeds those real sales into the reconciled export when no outbound[] is supplied', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await bankSale(h, 'u-owner', 'S-200', 'LOT-5', 'bs-200');

    // No outbound[] in the body → the trace pulls the live banked sale; 4 received, 2 dispatched.
    const t = (await trace(h, 'u-owner', { batchId: 'LOT-5', productId: 'milk-1l', inbound: [{ supplierId: 's', grnId: 'g', receivedDate: '2026-08-01', quantityMinor: 4000 }] }, 'lt-fold')).body as Trace;
    expect(t.totalDispatchedMinor).toBe(2000);
    expect(t.remainingOnHandMinor).toBe(2000);
    expect(t.reconciled).toBe(true);
    expect(t.outbound.map((r) => r.saleId)).toEqual(['S-200']);
  });

  it('returns an empty outbound for a batch nothing was sold from, and gates on the read', async () => {
    const h = apiHarness();
    await h.seedOwner(A, 'u-owner');
    await h.provisionRole(A, 'u-cash', 'cashier');

    const none = (await sold(h, 'u-owner', 'LOT-NONE')).body as Sold;
    expect(none.saleCount).toBe(0);
    expect(none.totalDispatchedMinor).toBe(0);
    expect((await sold(h, 'u-cash', 'LOT-9')).status).toBe(403);
  });
});
