import { describe, it, expect } from 'vitest';
import { discrepancyOwners, matchBillToReceipt, asnDifferenceLineId, type GoodsReceiptDeps, type GrnRecord, type BillCostPosting } from '../../services/inventory/src/goods-receipt';
import { billedCostOf } from '../../services/api/src/r7b-receiving-adapters';
import { createGoodsReceiptSession, type GrnRecordView } from '../../apps/web-erp/src/goods-receipt-session';

/**
 * **Round 8 (owner, 28 Oct 2026) — receiving.**
 *   • OB-528: near expiry, MRP mismatch and a difference from the supplier's advance ship notice (ASN) are owned by the buyer who
 *     raised the order (an ASN difference per product, its line `asn:<product>`); nobody is invented when there is no order.
 *   • OB-530: the price-difference report uses ONLY the bill matched to that exact receipt — a bill matched to the order (or to
 *     another receipt) is never borrowed; a bill can be matched to a receipt whose cost was already known (the order's), so
 *     the report can compare — and nothing is revalued for those lines. Not by the person who received the goods.
 */

const rec = (over: Partial<GrnRecord> = {}): GrnRecord => ({
  grnId: 'grn-1', number: 'GRN-1', poId: 'po-1', warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: '2030-06-01T06:00:00.000Z',
  captured: {
    receiptId: 'grn-1', discrepancies: [{ lineId: 'L1', productId: 'p1', kind: 'near_expiry', quantityMinor: 10, value: { minor: 0, currency: 'INR' }, requiresApproval: false, detail: 'near' },
      { lineId: 'L2', productId: 'p2', kind: 'mrp_mismatch', quantityMinor: 5, value: { minor: 0, currency: 'INR' }, requiresApproval: false, detail: 'mrp' }],
    lines: [
      { lineId: 'L1', productId: 'p1', orderedMinor: 10, countedMinor: 10, uom: 'ea', unitCost: { minor: 5_000, currency: 'INR' }, condition: 'good', sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 0 },
      { lineId: 'L2', productId: 'p2', orderedMinor: 5, countedMinor: 5, uom: 'ea', unitCost: { minor: 0, currency: 'INR' }, condition: 'good', sellableMinor: 5, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 0, costNotKnown: true },
    ],
    discrepancyValue: { minor: 0, currency: 'INR' }, requiresApproval: false,
  },
  availableMinor: 15, heldMinor: 0, governanceFlags: [], poReceipt: null,
  asnCheck: { asnId: 'asn-1', expectedAt: '2030-06-01', matched: false, differences: [{ productId: 'p1', advisedMinor: 12, receivedMinor: 10, differenceMinor: -2, detail: '2 fewer than advised', valueMinor: 10_000 }] },
  costNotKnown: [{ lineId: 'L2', productId: 'p2', because: 'not_on_order' }],
  ...over,
}) as unknown as GrnRecord;

describe('OB-528 — near expiry, MRP mismatch and an ASN difference are the buyer\'s', () => {
  it('named the buyer who raised the order; an ASN difference per product on its own line id', () => {
    const owners = discrepancyOwners(rec(), { buyer: 'u-buyer', storeManagers: ['u-sm'] });
    expect(owners.map((o) => [o.lineId, o.kind, o.role, o.owners])).toEqual([
      ['L1', 'near_expiry', 'buyer', ['u-buyer']], ['L2', 'mrp_mismatch', 'buyer', ['u-buyer']], ['asn:p1', 'asn_difference', 'buyer', ['u-buyer']],
    ]);
    expect(asnDifferenceLineId('p1')).toBe('asn:p1');
    // Never invented: no order behind the delivery → no buyer named, said.
    expect(discrepancyOwners(rec({ poId: null }), { buyer: null, storeManagers: ['u-sm'] }).every((o) => o.owners.length === 0 && o.missing === 'no_purchase_order')).toBe(true);
  });

  it('the review screen shows the ASN difference and its owner, in English and Tamil', () => {
    const view: GrnRecordView = {
      grnId: 'g', number: 'GRN-1', poId: 'po-1', warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: '2030-06-01T06:00:00Z', requiresApproval: false,
      discrepancyValueMinor: 0, currency: 'INR', sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, returnLines: [],
      discrepancies: [{ kind: 'asn_difference', lineId: 'asn:p1', productId: 'p1', quantityMinor: 2, valueMinor: 10_000, currency: 'INR', requiresApproval: false, detail: '2 fewer than advised', owner: { role: 'buyer', owners: ['u-buyer'] } }],
    } as unknown as GrnRecordView;
    const session = createGoodsReceiptSession({ userId: 'u-owner' }, { snapshot: () => ({ receipts: [view], asAt: '2030-06-01T07:00:00Z' }), mayRead: () => true });
    const en = session.view('en').receipts[0]!.discrepancies[0]!;
    expect(en.label).toContain('Differs from the supplier’s delivery note (ASN)');
    expect(en.ownerLabel).toBe('Owner: u-buyer (the buyer who raised the order)');
    const ta = session.view('ta').receipts[0]!.discrepancies[0]!;
    expect(ta.label).toContain('சப்ளையரின் டெலிவரி அறிவிப்பிலிருந்து (ASN) வேறுபடுகிறது');
    expect(ta.ownerLabel).toBe('பொறுப்பாளர்: u-buyer (ஆர்டர் செய்த வாங்குநர்)');
  });
});

describe('OB-530 — the bill matched to THAT receipt, and only that', () => {
  const bill = { invoiceId: 'INV-1', supplierId: 's1', poId: 'po-1', currency: 'INR', approvedBy: 'u-acct', lines: [{ productId: 'p1', unitPriceMinor: 5_300 }, { productId: 'p2', unitPriceMinor: 4_100 }] };
  const deps = (held: GrnRecord, commits: { record: GrnRecord; postings: readonly BillCostPosting[] }[]): GoodsReceiptDeps => ({
    grn: () => held, supplierBill: () => bill, now: () => '2030-06-05T06:00:00.000Z',
    commitBillMatch: (_t: string, record: GrnRecord, postings: readonly BillCostPosting[]) => { commits.push({ record, postings }); },
  }) as unknown as GoodsReceiptDeps;

  it('matches the bill to the cost-not-known line (valued) AND to the line whose cost the order gave (compared, not revalued)', async () => {
    const commits: { record: GrnRecord; postings: readonly BillCostPosting[] }[] = [];
    const out = await matchBillToReceipt(deps(rec(), commits), { tenantId: 't', grnId: 'grn-1', invoiceId: 'INV-1', matchedBy: 'u-acct', branchId: null });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.matched.map((m) => [m.lineId, m.unitCost.minor, m.quantityMinor, m.costWasKnown ?? false])).toEqual([['L2', 4_100, 5, false], ['L1', 5_300, 0, true]]);
    // Only the cost-not-known line's stock is valued by the bill.
    expect(commits[0]!.postings.map((p) => [p.lineId, p.valueMinor])).toEqual([['L2', 5 * 4_100]]);
    // The receiver never matches their own delivery's bill (§28).
    expect(await matchBillToReceipt(deps(rec(), []), { tenantId: 't', grnId: 'grn-1', invoiceId: 'INV-1', matchedBy: 'u-recv', branchId: null })).toMatchObject({ ok: false, refusedBecause: 'self_match' });
    // Matched once: asked again, the same answer — never a second match.
    const again = await matchBillToReceipt(deps(out.record, []), { tenantId: 't', grnId: 'grn-1', invoiceId: 'INV-1', matchedBy: 'u-acct', branchId: null });
    expect(again).toMatchObject({ ok: true, alreadyMatched: true });
  });

  it('the report reads the receipt\'s own bill — a receipt with none is "not yet billed", whatever the order\'s other bills say', async () => {
    const billed = await billedCostOf();
    const withOwn = rec({ billCosts: [{ lineId: 'L1', productId: 'p1', invoiceId: 'INV-1', unitCost: { minor: 5_300, currency: 'INR' }, quantityMinor: 0, valueMinor: 0, matchedBy: 'u-acct', matchedAt: '2030-06-05T06:00:00.000Z', costWasKnown: true }] });
    expect(billed(withOwn, 'L1', 'p1')).toEqual({ unitCost: { minor: 5_300, currency: 'INR' }, invoiceId: 'INV-1' });
    expect(billed(withOwn, 'L2', 'p2')).toBeUndefined();
    // A second receipt on the same order, with no bill matched to IT: not yet billed (the first receipt's bill is not borrowed).
    expect(billed(rec({ grnId: 'grn-2' }), 'L1', 'p1')).toBeUndefined();
  });
});
