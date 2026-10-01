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

  it('PRESERVES a no-receipt return\'s null originalSaleId AND its noReceipt flag — the transport routes on the flag (M13-FR-01)', () => {
    const noReceipt = toCloudReturn({ ...RETURN_RECORD, originalSaleId: null, noReceipt: true });
    expect(noReceipt.originalSaleId).toBeNull();
    expect(noReceipt.noReceipt).toBe(true);
    expect(noReceipt.laneId).toBe('lane-1'); // where a resold unit goes back when the lane named no location
  });

  it('never carries a false or missing noReceipt flag — a receipted return has no flag at all', () => {
    expect('noReceipt' in toCloudReturn(RETURN_RECORD)).toBe(false);
    expect('noReceipt' in toCloudReturn({ ...RETURN_RECORD, noReceipt: 'yes' })).toBe(false);
  });

  it('carries approvedBy only when present, so "no approver" and "this approver" stay distinct (§28)', () => {
    const noApprover = toCloudReturn({ ...RETURN_RECORD, approvedBy: undefined });
    expect('approvedBy' in noApprover).toBe(false);
    const emptyApprover = toCloudReturn({ ...RETURN_RECORD, approvedBy: '' });
    expect('approvedBy' in emptyApprover).toBe(false);
  });

  it('carries customerRef for a store-credit refund, only when present, so the cloud can issue the credit (M13-FR-03/§31)', () => {
    const withCustomer = toCloudReturn({ ...RETURN_RECORD, refundTender: 'store_credit', customerRef: 'c-asha' });
    expect(withCustomer.customerRef).toBe('c-asha');
    // A cash refund, or a store-credit refund with no customer captured, leaves the field absent so the
    // cloud tells "no customer" apart from "this customer" and record-and-flags the former (P-08).
    expect('customerRef' in toCloudReturn(RETURN_RECORD)).toBe(false);
    expect('customerRef' in toCloudReturn({ ...RETURN_RECORD, customerRef: '' })).toBe(false);
  });

  it('stamps the store this box belongs to as the return\'s locationId, so a resold no-receipt unit re-enters THIS shop\'s stock (F17 · M08-FR-01)', () => {
    // A no-receipt return has no bill to take the location from. Before SP-9b-i the cloud fell back to a location
    // named after the LANE ("lane-1" — stated as assumed), a shelf nobody sells from, so the store's own figure
    // stayed short. The box now stamps the store its pack names, exactly as it does on a sale (Stage D slice 2).
    const noReceipt = { ...RETURN_RECORD, originalSaleId: null, noReceipt: true };
    expect(toCloudReturn(noReceipt, 'S1').locationId).toBe('S1');
    // A record that declared its own location keeps it; the box never overrides what the lane said.
    expect(toCloudReturn({ ...noReceipt, locationId: 'S1-FLOOR' }, 'S1').locationId).toBe('S1-FLOOR');
    // A box that knows no store stamps nothing — the cloud's stated fallback stands (P-08), nothing is invented.
    expect(toCloudReturn(noReceipt)).not.toHaveProperty('locationId');
    expect(toCloudReturn(noReceipt, '')).not.toHaveProperty('locationId');
    // A receipted return carries it too; the cloud takes the bill's own location for that one.
    expect(toCloudReturn(RETURN_RECORD, 'S1').locationId).toBe('S1');
  });

  it('carries an EXCHANGE settlement as the lane wrote it (SP-9b-ii · M13-FR-03), only when present and readable — nothing invented', () => {
    const settlement = { replacementSaleId: 'S-X', replacementTotalMinor: 7000, appliedMinor: 5000, balance: 'top_up', balanceMinor: 2000, topUpTenders: [{ kind: 'cash', amountMinor: 2000 }] };
    const r = toCloudReturn({ ...RETURN_RECORD, refundTender: 'exchange', exchange: settlement });
    expect(r.refundTender).toBe('exchange');
    expect(r.exchange).toEqual({ exchangeId: 'RT1', ...settlement }); // the exchange is the return's own id unless the lane named one
    expect(toCloudReturn(RETURN_RECORD)).not.toHaveProperty('exchange');
    // A block naming no replacement sale is not an exchange the cloud can link — dropped; the cloud flags the odd tender itself.
    expect(toCloudReturn({ ...RETURN_RECORD, exchange: { balance: 'even' } })).not.toHaveProperty('exchange');
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
