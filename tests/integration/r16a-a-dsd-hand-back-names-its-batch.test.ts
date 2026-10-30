import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { r3OpsBackings, tenantClient } from '../support/r3-ops-backings';
import type { ApiHarness } from '../support/api-harness';
import { approvedSuppliers } from '../support/approved-supplier';

/**
 * **OB-611 (owner, 30 Oct 2026 · round 16, R16-A): at the van-delivery (DSD) door, goods HANDED BACK of a product that came
 * off the van in more than one batch name WHICH batch; head office posts the per-batch figures from it — no guessing.**
 *
 * Before round 16 a hand-back named no batch and head office took it off the batch scanned LAST (round 11's rule), so the
 * stock and the recall trace of each batch could be wrong by what was handed back. On the real API (in memory and on real
 * PostgreSQL, with a cold restart): a hand-back of a two-batch product with no batch is refused by name
 * (`hand_back_batch_required`), one naming a batch that never came off the van is refused (`hand_back_batch_not_scanned`),
 * one of more than its batch came in with is refused (`hand_back_more_than_batch_held`); one naming the FIRST batch is taken
 * off that batch, and the close receives each batch's own kept figure; the debit note's line names the batch. A one-batch
 * product needs no batch named. A relayed check-in from an older handheld with no batch named is refused by name too.
 */

const backings = r3OpsBackings();
const cost = { minor: 1_000, currency: 'INR' };
const B1 = { batchId: 'OIL-1', expiry: '2031-03-31', manufacturedOn: null };
const B2 = { batchId: 'OIL-2', expiry: '2031-04-30', manufacturedOn: null };

describe.each(backings)('a DSD hand-back names its batch — on $name (OB-611)', ({ harness, restart }) => {
  it('refuses a hand-back with no batch, an unscanned batch and too many of a batch; posts the named batch; one batch needs none', async () => {
    const T = randomUUID();
    let h: ApiHarness = harness();
    await h.seedOwner(T, 'u-owner');
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-po-buyer', 'store_manager');
    await approvedSuppliers(h, T, 'sup-oil');
    const { req, ok, code } = tenantClient(() => h, T);
    await ok(req('POST', '/v1/org/nodes/C1', { kind: 'company', name: 'SRE Retail' }), 'company');
    await ok(req('POST', '/v1/org/nodes/S-A', { kind: 'branch', name: 'Store A', parentId: 'C1', companyId: 'C1' }), 'store');
    await ok(req('POST', '/v1/purchase/orders/po-oil', { supplierId: 'sup-oil', deliverToLocationId: 'S-A', lines: [{ productId: 'p-oil', orderedQty: 10, unitCost: cost }, { productId: 'p-salt', orderedQty: 5, unitCost: cost }] }, 'u-po-buyer'), 'po');
    await ok(req('POST', '/v1/purchase/orders/po-oil/approval', { reason: 'weekly oil' }), 'issue po');
    await ok(req('POST', '/v1/inventory/dsd-checkins/c-1', { supplierId: 'sup-oil', storeId: 'S-A', poId: 'po-oil', driverName: 'Ravi', arrivedAt: '2030-06-01T06:30:00.000Z' }, 'u-recv'), 'open');
    const scan = (scanId: string, productId: string, q: number, batch?: typeof B1) => ok(req('POST', `/v1/inventory/dsd-checkins/c-1/scans/${scanId}`, { productId, quantityMinor: q, ...(batch === undefined ? {} : { batchId: batch.batchId, expiry: batch.expiry }) }, 'u-recv'), `scan ${scanId}`);
    await scan('s1', 'p-oil', 3, B1);
    await scan('s2', 'p-oil', 4, B2);
    await scan('s3', 'p-salt', 5, { batchId: 'SALT-1', expiry: '2032-01-31', manufacturedOn: null });
    const handBack = (id: string, body: Record<string, unknown>) => req('POST', `/v1/inventory/dsd-checkins/c-1/hand-backs/${id}`, { reason: 'damaged', ...body }, 'u-recv');

    // Two batches: which one must be said; a batch that never came off the van, or more than a batch came in with, is refused.
    expect(code(await handBack('h0', { productId: 'p-oil', quantityMinor: 1 }))).toBe('hand_back_batch_required');
    expect(code(await handBack('h0', { productId: 'p-oil', quantityMinor: 1, batch: { batchId: 'OIL-9', expiry: '2031-03-31', manufacturedOn: null } }))).toBe('hand_back_batch_not_scanned');
    expect(code(await handBack('h0', { productId: 'p-oil', quantityMinor: 4, batch: B1 }))).toBe('hand_back_more_than_batch_held');
    expect(code(await handBack('h0', { productId: 'p-oil', quantityMinor: 1, batch: 'OIL-1' }))).toBe('not_readable_as_a_dsd_hand_back');
    // The FIRST batch, named: 2 of OIL-1 go back (the old rule would have taken them off OIL-2, scanned last).
    await ok(handBack('h1', { productId: 'p-oil', quantityMinor: 2, batch: B1 }), 'hand back 2 of OIL-1');
    // One batch only: no batch is needed.
    await ok(handBack('h2', { productId: 'p-salt', quantityMinor: 1 }), 'hand back 1 salt');

    h = restart(h); // ── COLD RESTART: the close is judged on the stored check-in ─────────────────────────────────────────
    await h.provisionRole(T, 'u-recv', 'store_manager');
    await h.provisionRole(T, 'u-box', 'store_computer', ['S-A']);
    type Line = { productId: string; batches?: { batchId: string | null; handedBackMinor: number; keptMinor: number; receivableMinor: number }[] };
    type Rec = { checkIn: { reconciliation: { lines: Line[] }; debitNote: { lines: { productId: string; quantityMinor: number; batch?: { batchId: string | null } }[] } | null } };
    const closed = (await ok(req('POST', '/v1/inventory/dsd-checkins/c-1/close', { deliveryNote: { noteRef: 'DN-SUP-1', driverSignedName: 'Ravi' } }, 'u-recv'), 'close')).body as Rec;
    const oil = closed.checkIn.reconciliation.lines.find((l) => l.productId === 'p-oil')!;
    expect(oil.batches!.map((b) => [b.batchId, b.handedBackMinor, b.keptMinor, b.receivableMinor])).toEqual([['OIL-1', 2, 1, 1], ['OIL-2', 0, 4, 4]]);
    expect(closed.checkIn.debitNote!.lines).toEqual([
      { productId: 'p-oil', quantityMinor: 2, reason: 'damaged', batch: { batchId: 'OIL-1', expiry: '2031-03-31', manufacturedOn: null } },
      { productId: 'p-salt', quantityMinor: 1, reason: 'damaged' },
    ]);
    const salt = closed.checkIn.reconciliation.lines.find((l) => l.productId === 'p-salt')!;
    expect(salt.batches!.map((b) => [b.batchId, b.handedBackMinor, b.keptMinor])).toEqual([['SALT-1', 1, 4]]);
    const read = (await ok(req('GET', '/v1/inventory/dsd-checkins/c-1', undefined, 'u-recv'), 'read')).body as Rec;
    expect(read.checkIn.reconciliation.lines.find((l) => l.productId === 'p-oil')!.batches!.map((b) => b.handedBackMinor)).toEqual([2, 0]);

    // A relayed check-in from a handheld that named no batch for a two-batch product is refused by name — nothing posted.
    const relayed = {
      checkInId: 'c-2', supplierId: 'sup-oil', storeId: 'S-A', poId: 'po-oil', driverName: 'Ravi', arrivedAt: '2030-06-02T06:30:00.000Z', receivedBy: 'u-recv', at: '2030-06-02T07:00:00.000Z',
      scans: [{ scanId: 'x1', productId: 'p-oil', quantityMinor: 1, at: '2030-06-02T06:40:00.000Z', ...B1, manufacturedOn: undefined }, { scanId: 'x2', productId: 'p-oil', quantityMinor: 1, at: '2030-06-02T06:41:00.000Z', ...B2, manufacturedOn: undefined }],
      handBacks: [{ handBackId: 'y1', productId: 'p-oil', quantityMinor: 1, reason: 'damaged', at: '2030-06-02T06:50:00.000Z' }],
      deliveryNote: { noteRef: 'DN-SUP-2', driverSignedName: 'Ravi' },
    };
    const refused = await req('POST', '/v1/inventory/dsd-checkins/c-2/synced', relayed, 'u-box');
    expect([refused.status, code(refused)]).toEqual([422, 'hand_back_batch_required']);
    expect((await req('GET', '/v1/inventory/dsd-checkins/c-2', undefined, 'u-recv')).status).toBe(404);
  }, 60_000);
});
