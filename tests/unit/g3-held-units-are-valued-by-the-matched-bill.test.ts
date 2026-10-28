import { describe, it, expect } from 'vitest';
import {
  decideReceiptExcess, decideLineDisposition, matchBillToReceipt, receiptsWaitingForBill, stillCostNotKnown,
  type GoodsReceiptDeps, type GrnRecord, type BillCostPosting, type SupplierBillForReceipt,
} from '../../services/inventory/src/goods-receipt';
import type { Movement } from '../../services/inventory/src/index';
import { weightedAverageValuation, type ValuationMovement } from '../../packages/stock/src/valuation';
import { withLandedCost, type StockCostAdjustment } from '../../services/inventory/src/landed-cost';
import { createSupplierBillsSession, billMatchWords, BILL_MATCH_WORDS, type HeadOfficeCall } from '../../apps/web-erp/src/supplier-bills-session';

/**
 * **G3 · OB-509 (owner, 28 Oct 2026) — held and quarantined units of a cost-not-known line are valued by the bill matched to it.**
 *
 * A delivery with no order: 12 brooms counted against 10 (2 HELD as excess) and 5 mops quarantined as damaged. Both lines are
 * booked with their cost NOT KNOWN. Whichever happens first — a second person releasing the held / quarantined units, or a
 * person matching the supplier's bill — every unit that reaches stock ends up valued at the BILL's cost, exactly once:
 *   • released BEFORE the match → the match values them with the sellable units (one value-only posting per line);
 *   • released AFTER the match → their own inbound movement carries the bill's cost (its `per` too), and the match is not
 *     repeated (a second match answers "already matched" and posts nothing).
 * Before this fix the match valued only the sellable units and later releases came in unvalued forever.
 */

const AT = '2030-06-05T06:00:00.000Z';
const base = (): GrnRecord => ({
  grnId: 'g1', number: 'GRN-1', poId: null, warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: '2030-06-01T06:00:00.000Z',
  availableMinor: 10, heldMinor: 2,
  captured: {
    lines: [
      { lineId: 'L1', productId: 'p-brm', orderedMinor: 10, countedMinor: 12, uom: 'ea', unitCost: { minor: 0, currency: 'INR' }, condition: 'good', costNotKnown: true, batchId: null, expiry: null, sellableMinor: 10, quarantinedMinor: 0, rejectedMinor: 0, heldMinor: 2 },
      { lineId: 'L2', productId: 'p-mop', orderedMinor: 5, countedMinor: 5, uom: 'ea', unitCost: { minor: 0, currency: 'INR' }, condition: 'damaged', costNotKnown: true, batchId: null, expiry: null, sellableMinor: 0, quarantinedMinor: 5, rejectedMinor: 0, heldMinor: 0 },
    ],
    discrepancies: [],
  },
  costNotKnown: [
    { lineId: 'L1', productId: 'p-brm', quantityMinor: 12, uom: 'ea', because: 'no_issued_order', detail: '' },
    { lineId: 'L2', productId: 'p-mop', quantityMinor: 5, uom: 'ea', because: 'no_issued_order', detail: '' },
  ],
  governanceFlags: ['no_purchase_order', 'cost_unknown'],
} as unknown as GrnRecord);

// ₹42.00 a broom; ₹60.00 for TWO mops (the bill's own `per`) = ₹30.00 a mop.
const BILL: SupplierBillForReceipt = {
  invoiceId: 'INV-1', supplierId: 'sup-1', poId: null, currency: 'INR', approvedBy: 'u-check',
  lines: [{ productId: 'p-brm', unitPriceMinor: 4_200 }, { productId: 'p-mop', unitPriceMinor: 6_000, unitPricePer: 2 }],
};
const EXPECTED_VALUE = 12 * 4_200 + 5 * 3_000;

/** An in-memory head office: the receipt's versions, every movement and every value-only posting it appended. */
function office() {
  let rec = base();
  const movements: Movement[] = [];
  const postings: BillCostPosting[] = [];
  const deps = {
    grn: () => rec, now: () => AT, supplierBill: (_t: string, id: string) => (id === BILL.invoiceId ? BILL : undefined),
    commitExcessDecision: (_t: string, r: GrnRecord, m: readonly Movement[]) => { rec = r; movements.push(...m); },
    commitDisposition: (_t: string, r: GrnRecord, m: readonly Movement[]) => { rec = r; movements.push(...m); },
    commitBillMatch: (_t: string, r: GrnRecord, p: readonly BillCostPosting[]) => { rec = r; postings.push(...p); },
  } as unknown as GoodsReceiptDeps;
  const approve = () => decideReceiptExcess(deps, { tenantId: 't', grnId: 'g1', decidedBy: 'u-sup', decision: 'approved', reason: 'keep the extra', branchId: null, via: 'direct' });
  const accept = () => decideLineDisposition(deps, { tenantId: 't', grnId: 'g1', lineId: 'L2', decidedBy: 'u-sup', disposition: 'accept', reason: 'only the box was dented', branchId: null, via: 'direct' });
  const match = () => matchBillToReceipt(deps, { tenantId: 't', grnId: 'g1', invoiceId: 'INV-1', matchedBy: 'u-acct', branchId: null });
  /** The stock as the valuation folds it: the capture's own sellable movement (unvalued), the releases, the postings. */
  const valuation = () => {
    const captured: Movement = { movementId: 'g1:L1', productId: 'p-brm', locationId: 'wh-1', kind: 'received', quantityMinor: 10, uom: 'ea', occurredAt: '2030-06-01T06:00:00.000Z', enteredBy: 'u-recv' } as Movement;
    const adjustments: StockCostAdjustment[] = postings.map((p) => ({
      adjustmentId: `bill-cost:g1:${p.lineId}`, invoiceId: p.invoiceId, poId: p.poId, productId: p.productId, locationId: p.locationId,
      quantityMinor: p.quantityMinor, valueMinor: p.valueMinor, occurredAt: AT, postedBy: 'u-acct', matchedAt: AT, costKnown: true, grnId: 'g1', lineId: p.lineId, uom: p.uom,
    }));
    const map = (m: Movement): ValuationMovement => ({
      productId: m.productId, locationId: m.locationId, effect: 1, quantityMinor: m.quantityMinor, isPurchaseReceipt: true,
      ...(m.unitCostMinor === undefined ? {} : { unitCostMinor: m.unitCostMinor }), ...(m.unitCostPer === undefined ? {} : { costPerUnits: m.unitCostPer }),
    });
    return weightedAverageValuation(withLandedCost([captured, ...movements], adjustments, map), 'INR');
  };
  return { deps, approve, accept, match, valuation, movements, postings, record: () => rec };
}

const totals = (rows: ReturnType<ReturnType<typeof office>['valuation']>) => ({
  onHand: rows.reduce((n, r) => n + r.onHandMinor, 0), value: rows.reduce((n, r) => n + r.value.minor, 0), unvalued: rows.reduce((n, r) => n + r.unvaluedMinor, 0),
});

describe('G3 — held / quarantined units on a cost-not-known line take the matched bill\'s cost, whichever comes first', () => {
  it('released BEFORE the bill is matched: the match values the released units with the sellable ones, once', async () => {
    const o = office();
    expect((await o.approve()).ok).toBe(true);
    expect((await o.accept()).ok).toBe(true);
    // Released while the cost is not known: in stock, unvalued — never at ₹0.
    expect(o.movements.map((m) => [m.movementId, m.quantityMinor, m.unitCostMinor])).toEqual([['g1:L1:excess', 2, undefined], ['g1:L2:accepted', 5, undefined]]);
    expect(totals(o.valuation())).toEqual({ onHand: 17, value: 0, unvalued: 17 });

    const out = await o.match();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.matched.map((m) => [m.lineId, m.quantityMinor, m.valueMinor])).toEqual([['L1', 12, 12 * 4_200], ['L2', 5, 5 * 3_000]]);
    expect(o.postings.map((p) => [p.lineId, p.quantityMinor, p.valueMinor])).toEqual([['L1', 12, 50_400], ['L2', 5, 15_000]]);
    expect(stillCostNotKnown(o.record())).toEqual([]);
    expect(totals(o.valuation())).toEqual({ onHand: 17, value: EXPECTED_VALUE, unvalued: 0 });
    // Once: the same bill again posts nothing.
    expect(await o.match()).toMatchObject({ ok: true, alreadyMatched: true });
    expect(o.postings).toHaveLength(2);
  });

  it('released AFTER the bill is matched: each release carries the bill\'s cost on its own movement; nothing is valued twice', async () => {
    const o = office();
    const out = await o.match();
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    // Only what was in stock at the match is valued by it: 10 brooms; the quarantined mops are not in stock yet.
    expect(out.matched.map((m) => [m.lineId, m.quantityMinor])).toEqual([['L1', 10], ['L2', 0]]);
    expect(o.postings.map((p) => [p.lineId, p.quantityMinor])).toEqual([['L1', 10]]);
    expect(totals(o.valuation())).toEqual({ onHand: 10, value: 10 * 4_200, unvalued: 0 });

    const approved = await o.approve();
    expect(approved.ok).toBe(true);
    if (approved.ok) expect(approved.record.excessDecision?.valuedAtBill).toEqual([{ lineId: 'L1', invoiceId: 'INV-1', unitCost: { minor: 4_200, currency: 'INR' }, quantityMinor: 2, valueMinor: 8_400 }]);
    const accepted = await o.accept();
    expect(accepted.ok).toBe(true);
    if (accepted.ok) {
      // The disposition is valued at the bill (₹30.00 a mop), no longer "value not known".
      expect(accepted.disposition).toMatchObject({ valueMinor: 15_000, valuedAtBill: { invoiceId: 'INV-1', quantityMinor: 5, valueMinor: 15_000 } });
      expect(accepted.disposition.valueNotKnown).toBeUndefined();
    }
    expect(o.movements.map((m) => [m.movementId, m.quantityMinor, m.unitCostMinor, m.unitCostPer])).toEqual([['g1:L1:excess', 2, 4_200, undefined], ['g1:L2:accepted', 5, 6_000, 2]]);
    expect(totals(o.valuation())).toEqual({ onHand: 17, value: EXPECTED_VALUE, unvalued: 0 });
    // The bill is not matched again and nothing more is posted: never double-counted.
    expect(await o.match()).toMatchObject({ ok: true, alreadyMatched: true });
    expect(o.postings).toHaveLength(1);
    expect(totals(o.valuation()).value).toBe(EXPECTED_VALUE);
  });

  it('a mixed order (excess released before, quarantine accepted after) lands on the same value', async () => {
    const o = office();
    await o.approve();
    await o.match();
    await o.accept();
    expect(o.postings.map((p) => [p.lineId, p.quantityMinor])).toEqual([['L1', 12]]);
    expect(totals(o.valuation())).toEqual({ onHand: 17, value: EXPECTED_VALUE, unvalued: 0 });
  });

  it('a line whose cost was KNOWN is untouched: its release keeps its own cost, never a bill\'s', async () => {
    const o = office();
    const known = base();
    const lines = known.captured.lines.map((l) => ({ ...l, unitCost: { minor: 4_000, currency: 'INR' }, costNotKnown: undefined }));
    const rec = { ...known, captured: { ...known.captured, lines }, costNotKnown: undefined, billCosts: [{ lineId: 'L1', productId: 'p-brm', invoiceId: 'INV-1', unitCost: { minor: 4_200, currency: 'INR' }, quantityMinor: 0, valueMinor: 0, matchedBy: 'u-acct', matchedAt: AT, costWasKnown: true as const }] } as unknown as GrnRecord;
    const movements: Movement[] = [];
    const deps = { ...o.deps, grn: () => rec, commitExcessDecision: (_t: string, _r: GrnRecord, m: readonly Movement[]) => { movements.push(...m); } } as unknown as GoodsReceiptDeps;
    await decideReceiptExcess(deps, { tenantId: 't', grnId: 'g1', decidedBy: 'u-sup', decision: 'approved', reason: 'keep', branchId: null, via: 'direct' });
    expect(movements.map((m) => m.unitCostMinor)).toEqual([4_000]);
  });
});

describe('G3 — the list of receipts still waiting for their bill', () => {
  it('lists only receipts with a line still not known, oldest first, with the registered bills that could be matched', () => {
    const waiting = base();
    const later = { ...base(), grnId: 'g2', number: 'GRN-2', receivedAt: '2030-06-03T06:00:00.000Z', receivedBy: 'u-acct' } as GrnRecord;
    const billed = { ...base(), grnId: 'g3', billCosts: [{ lineId: 'L1' }, { lineId: 'L2' }] } as unknown as GrnRecord;
    const onOrder = { ...base(), grnId: 'g4', poId: 'po-1', receivedAt: '2030-05-01T06:00:00.000Z' } as GrnRecord;
    const bills: SupplierBillForReceipt[] = [
      BILL,
      { ...BILL, invoiceId: 'INV-PO', poId: 'po-1' },
      { ...BILL, invoiceId: 'INV-OTHER', lines: [{ productId: 'p-other', unitPriceMinor: 1 }] },
    ];
    const list = receiptsWaitingForBill([later, billed, waiting, onOrder], bills, 'u-acct');
    expect(list.map((r) => r.grnId)).toEqual(['g4', 'g1', 'g2']);
    // A bill is offered only for its own order (or, with no order, a bill with none) and only if it names a waiting product.
    expect(list.find((r) => r.grnId === 'g1')!.bills.map((b) => b.invoiceId)).toEqual(['INV-1']);
    expect(list.find((r) => r.grnId === 'g4')!.bills.map((b) => b.invoiceId)).toEqual(['INV-PO']);
    expect(list.find((r) => r.grnId === 'g1')!.bills[0]!.prices).toEqual([{ productId: 'p-brm', unitPriceMinor: 4_200 }, { productId: 'p-mop', unitPriceMinor: 6_000, unitPricePer: 2 }]);
    // The reader who booked a delivery in is told before trying (head office refuses them, §28).
    expect(list.map((r) => [r.grnId, r.receivedByYou])).toEqual([['g4', false], ['g1', false], ['g2', true]]);
    expect(list.find((r) => r.grnId === 'g1')!.waiting.map((w) => [w.lineId, w.inStockMinor])).toEqual([['L1', 10], ['L2', 0]]);
  });
});

describe('G3 — the Supplier bills page model: the waiting deliveries and the match, refusals in English and Tamil', () => {
  const recorder = (answers: Record<string, { status: number; body: unknown } | 'unreachable'>) => {
    const calls: { method: string; path: string; body?: unknown; idempotencyKey?: string }[] = [];
    const call: HeadOfficeCall = async (req) => {
      calls.push(req);
      const hit = Object.entries(answers).find(([k]) => `${req.method} ${req.path}`.startsWith(k));
      return hit === undefined ? { status: 404, body: {} } : hit[1];
    };
    return { call, calls };
  };
  const refusal = (status: number, code: string, whatHappened: string) => ({ status, body: { error: { code, whatHappened, nextSafeAction: 'Nothing was changed.' } } });

  it('reads the waiting list, sends ONLY the chosen bill (never a cost), and says each answer in both languages', async () => {
    const rec = recorder({
      'GET /v1/inventory/receipts-cost-not-known': { status: 200, body: { receipts: [{ grnId: 'g1', number: 'GRN-1', poId: null, warehouseId: 'wh-1', receivedBy: 'u-recv', receivedAt: AT, waiting: [], bills: [], receivedByYou: false }], count: 1, asAt: AT } },
      'POST /v1/inventory/goods-receipt/g1/bill-match': { status: 201, body: { matched: [{ lineId: 'L1', productId: 'p-brm', unitCost: { minor: 4_200, currency: 'INR' }, quantityMinor: 12, valueMinor: 50_400 }], stillNotKnown: [{ lineId: 'L2', productId: 'p-mop' }], alreadyMatched: false } },
    });
    const s = createSupplierBillsSession(rec.call, { permissions: ['purchase.invoice.match'] });
    expect(s.mayMatch).toBe(true);
    const list = await s.waitingForBill();
    expect(list).toMatchObject({ ok: true, value: { count: 1, receipts: [{ grnId: 'g1' }] } });
    // Nothing chosen → nothing sent.
    expect(await s.matchToReceipt('g1', ' ')).toMatchObject({ ok: false, code: 'pick_a_bill' });
    expect(rec.calls.filter((c) => c.method === 'POST')).toHaveLength(0);
    const out = await s.matchToReceipt('g1', ' INV-1 ');
    expect(rec.calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/inventory/goods-receipt/g1/bill-match', body: { invoiceId: 'INV-1' } });
    expect(Object.keys(rec.calls.at(-1)!.body as object)).toEqual(['invoiceId']);
    expect(rec.calls.at(-1)!.idempotencyKey).toMatch(/^bill-match-g1-/);
    if (out.ok) {
      expect(s.matchWords('en', out).text).toBe('Matched — the cost of these goods is now the bill\'s, and their stock is valued at it. Still waiting for a bill: p-mop');
      expect(s.matchWords('ta', out).text).toMatch(/^பொருத்தப்பட்டது — .* இன்னும் பில்லுக்காகக் காத்திருப்பவை: p-mop$/);
    } else throw new Error('expected a match');
  });

  it('every refusal head office can give has plain words in English AND Tamil, with head office\'s own words beside them', () => {
    const codes = ['self_match', 'bill_for_another_order', 'bill_unknown', 'receipt_unknown', 'nothing_waiting_for_a_bill', 'bill_names_none_of_these_goods', 'bill_match_not_available', 'not_readable_as_a_bill_match', 'forbidden', 'outside_your_branch_scope', 'pick_a_bill'];
    for (const code of codes) {
      expect(BILL_MATCH_WORDS.en[code], code).toBeTruthy();
      expect(BILL_MATCH_WORDS.ta[code], code).toMatch(/[஀-௿]/);
    }
    expect(Object.keys(BILL_MATCH_WORDS.ta).sort()).toEqual(Object.keys(BILL_MATCH_WORDS.en).sort());
    const self = { ok: false as const, unreachable: false as const, status: 403, code: 'self_match', whatHappened: 'u-recv received this delivery and cannot also match its bill (§28 separation of duties).', nextSafeAction: '' };
    expect(billMatchWords('en', self)).toEqual({ good: false, text: 'Not matched — you booked this delivery in, so another person (the buyer or the accountant) must match its bill. Head office said: u-recv received this delivery and cannot also match its bill (§28 separation of duties).' });
    expect(billMatchWords('ta', self).text).toMatch(/^பொருத்தப்படவில்லை — இந்த டெலிவரியை நீங்கள் பெற்றீர்கள்.* தலைமை அலுவலகம் சொன்னது: u-recv/);
    expect(billMatchWords('en', { ok: false, unreachable: true }).text).toMatch(/cannot be reached — nothing was changed/);
    expect(billMatchWords('en', { ...self, code: 'something_new', whatHappened: '' }).text).toBe('Not matched — head office refused it.');
  });

  it('a role without the bill-checking right is not offered the match', async () => {
    const rec = recorder({ 'GET /v1/inventory/receipts-cost-not-known': refusal(403, 'forbidden', 'This account does not hold "purchase.invoice.match".') });
    const s = createSupplierBillsSession(rec.call, { permissions: ['purchase.invoice.capture'] });
    expect(s.mayMatch).toBe(false);
    expect(await s.waitingForBill()).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
