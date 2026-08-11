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
