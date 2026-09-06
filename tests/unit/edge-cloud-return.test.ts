import { describe, it, expect } from 'vitest';
import { toCloudReturn, returnIdOf } from '../../edge/store-edge/src/cloud-return';

/**
 * **The seam between the lane's offline refund and the cloud's synced-return contract, in isolation.**
 *
 * The store edge queues a refund taken with the cable out; the sync agent relays it to
 * `POST /v1/sales/:saleId/returns/synced`, which reads `returnId`, `processedBy`, the lane approver
 * `approvedBy`, `reasonCode`, `refundMinor`, `refundTender` and `lines`, and takes `originalSaleId`
 * from the path (via `returnAcceptedRoute`). The mirror of `toCloudSale`. Two properties matter and
 * are proved here: a genuine `originalSaleId: null` (a no-receipt return) is PRESERVED, because the
 * transport has no synced endpoint for one and squashing null to '' would misroute it; and `approvedBy`
 * is carried only when present, so the cloud can tell "no approver" from "this approver" (§28).
 */

// The record a lane commits offline — exactly the ReturnAccepted payload `packages/returns` mints.
const RETURN_RECORD = {
  returnId: 'RT1', number: 'RT1', originalSaleId: 'S1', noReceipt: false, laneId: 'lane-1',
  processedBy: 'u-lanecash', approvedBy: 'u-mgr', reasonCode: 'customer_changed_mind',
  refundMinor: 5000, currency: 'INR', refundTender: 'cash', refundStatus: 'settled', processedAt: '2026-08-07T10:00:00.000Z',
  lines: [{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }],
};

describe('toCloudReturn — the lane refund record → the cloud synced-return contract', () => {
  it('carries the fields the synced route reads, and the approver the cloud re-verifies', () => {
    const r = toCloudReturn(RETURN_RECORD);
    expect(r.returnId).toBe('RT1');
    expect(r.originalSaleId).toBe('S1');
    expect(r.processedBy).toBe('u-lanecash');
    expect(r.approvedBy).toBe('u-mgr');
    expect(r.reasonCode).toBe('customer_changed_mind');
    expect(r.refundMinor).toBe(5000);
    expect(r.refundTender).toBe('cash');
    expect(r.lines).toEqual([{ productId: 'P1', uom: 'each', quantityMinor: 1, disposition: 'resell' }]);
  });

  it('PRESERVES a no-receipt return\'s null originalSaleId — the transport must see null, not ""', () => {
    const noReceipt = toCloudReturn({ ...RETURN_RECORD, originalSaleId: null, noReceipt: true });
    expect(noReceipt.originalSaleId).toBeNull();
  });

  it('carries approvedBy only when present, so "no approver" and "this approver" stay distinct (§28)', () => {
    const noApprover = toCloudReturn({ ...RETURN_RECORD, approvedBy: undefined });
    expect('approvedBy' in noApprover).toBe(false);
    const emptyApprover = toCloudReturn({ ...RETURN_RECORD, approvedBy: '' });
    expect('approvedBy' in emptyApprover).toBe(false);
  });

  it('tolerates a bare id in place of returnId, both here and in returnIdOf', () => {
    expect(toCloudReturn({ ...RETURN_RECORD, returnId: undefined, id: 'RT9' }).returnId).toBe('RT9');
    expect(returnIdOf({ returnId: 'RT1' })).toBe('RT1');
    expect(returnIdOf({ id: 'RT2' })).toBe('RT2');
    expect(returnIdOf({ nothing: true })).toBeUndefined();
  });

  it('does not throw on unreadable junk off the disk — it degrades to a return the cloud will flag', () => {
    const r = toCloudReturn('not an object');
    expect(r.returnId).toBe('');
    expect(r.originalSaleId).toBeNull();
    expect(r.refundMinor).toBe(0);
    expect(r.lines).toEqual([]);
  });
});
