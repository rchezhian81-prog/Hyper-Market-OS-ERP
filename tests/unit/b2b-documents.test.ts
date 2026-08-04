import { describe, it, expect } from 'vitest';
import {
  issueQuotation,
  convertQuotation,
  issueProforma,
  issueChallan,
  issueTaxInvoice,
  checkChain,
  type B2BLine,
  type B2BDocument,
} from '../../packages/b2b/src/documents';
import type { NumberFormat } from '../../packages/numbering/src/numbering';

// M22-FR-02 acceptance: "a quote converts to an order and flows to a correct tax invoice;
// numbers are gap-free; GST ties out." The controlling design claim: each document is
// derived from the one BEFORE it, and the tax invoice follows what was DELIVERED.

const QUO: NumberFormat = { prefix: 'QUO', padTo: 5 };
const SO: NumberFormat = { prefix: 'SO', padTo: 5 };
const PI: NumberFormat = { prefix: 'PI', padTo: 5 };
const DC: NumberFormat = { prefix: 'DC', padTo: 5 };
const INV: NumberFormat = { prefix: 'INV', padTo: 5 };

const LINES: readonly B2BLine[] = [
  { lineId: 'l-rice', productId: 'p-rice', description: 'Sona Masoori 25kg', qty: 40, unitPriceMinor: 145_000, taxRateBps: 500 },
  { lineId: 'l-oil', productId: 'p-oil', description: 'Sunflower oil 15L', qty: 10, unitPriceMinor: 210_000, taxRateBps: 500 },
];

function quote(over: Partial<Parameters<typeof issueQuotation>[0]> = {}) {
  return issueQuotation({
    documentId: 'q-1', customerId: 'c-school', tenantId: 't-sre', lines: LINES,
    format: QUO, seq: 1, at: '2026-08-04T09:00:00Z', ...over,
  });
}

describe('a quotation is an offer, not a commitment (M22-FR-02)', () => {
  it('fixes the price for a stated window', () => {
    const result = quote();
    expect(result.issued).toBe(true);
    expect(result.document?.number).toBe('QUO00001');
    expect(result.document?.kind).toBe('quotation');
    expect(result.validUntil?.slice(0, 10)).toBe('2026-08-19');
    expect(result.document?.taxClaimable).toBe(false);
  });

  it('computes tax per line and sums it, never as a percentage of the total', () => {
    const result = quote();
    // 40 × 145,000 = 5,800,000 + 5% = 290,000 · 10 × 210,000 = 2,100,000 + 5% = 105,000
    expect(result.document?.netMinor).toBe(7_900_000);
    expect(result.document?.taxMinor).toBe(395_000);
    expect(result.document?.grossMinor).toBe(8_295_000);
  });

  it('DRAWS NO NUMBER when it refuses — a gap in a series is a question with no good answer', () => {
    const result = quote({ lines: [{ ...LINES[0]!, qty: 0 }] });
    expect(result.issued).toBe(false);
    expect(result.outcome).toBe('invalid_quantity');
    expect(result.document).toBeUndefined();
    expect(result.detail).toContain('the series keeps no gap');
  });

  it('refuses an empty quotation', () => {
    expect(quote({ lines: [] }).outcome).toBe('no_lines');
  });
});

const QUOTE = quote().document!;

function convert(over: Partial<Parameters<typeof convertQuotation>[0]> = {}) {
  return convertQuotation({
    documentId: 'so-1', quotation: QUOTE, customerId: 'c-school', format: SO, seq: 1,
    validUntil: '2026-08-19T09:00:00Z', at: '2026-08-10T09:00:00Z', creditAllowed: true, ...over,
  });
}

describe('an order takes the QUOTED price, not today\'s price list', () => {
  it('converts inside the window at the quoted total', () => {
    const result = convert();
    expect(result.converted).toBe(true);
    expect(result.document?.grossMinor).toBe(QUOTE.grossMinor);
    expect(result.document?.derivedFrom).toBe('q-1');
    expect(result.document?.detail).toContain("not at today's price list");
  });

  it('REFUSES outside the window rather than quietly re-pricing at the invoice', () => {
    const result = convert({ at: '2026-08-25T09:00:00Z' });
    expect(result.outcome).toBe('expired');
    expect(result.detail).toContain('re-quote rather than re-price quietly');
  });

  it('refuses when credit control has not cleared it (M22-FR-01)', () => {
    expect(convert({ creditAllowed: false }).outcome).toBe('credit_blocked');
    expect(convert({ creditAllowed: undefined }).outcome).toBe('credit_blocked');
  });

  it('refuses another customer\'s quotation', () => {
    expect(convert({ customerId: 'c-hostel' }).outcome).toBe('wrong_customer');
  });

  it('converts once — one quote, one order', () => {
    expect(convert({ alreadyConvertedFrom: ['q-1'] }).outcome).toBe('already_converted');
  });
});

const ORDER = convert().document!;

describe('a proforma is NOT a tax invoice', () => {
  it('carries no tax claim and says so on its face', () => {
    const proforma = issueProforma({ documentId: 'pi-1', order: ORDER, format: PI, seq: 1, at: '2026-08-10T10:00:00Z' });
    expect(proforma.kind).toBe('proforma');
    expect(proforma.taxClaimable).toBe(false);
    expect(proforma.number).toBe('PI00001');
    expect(proforma.detail).toContain('no input credit may be claimed against it');
  });
});

describe('a challan carries what actually LEFT the building', () => {
  it('records a partial dispatch as partial', () => {
    const result = issueChallan({
      documentId: 'dc-1', order: ORDER, dispatched: { 'l-rice': 25 },
      format: DC, seq: 1, at: '2026-08-12T06:00:00Z',
    });
    expect(result.issued).toBe(true);
    expect(result.document?.lines).toHaveLength(1);
    expect(result.document?.lines[0]?.qty).toBe(25);
    expect(result.detail).toContain('not what was ordered');
  });

  it('REFUSES to dispatch more than was ordered, across challans', () => {
    const result = issueChallan({
      documentId: 'dc-2', order: ORDER, dispatched: { 'l-rice': 20 },
      alreadyDispatched: { 'l-rice': 25 }, format: DC, seq: 2, at: '2026-08-13T06:00:00Z',
    });
    expect(result.outcome).toBe('over_delivery');
    expect(result.detail).toContain('the driver has the argument');
  });

  it('refuses a challan for nothing', () => {
    const result = issueChallan({
      documentId: 'dc-3', order: ORDER, dispatched: {}, format: DC, seq: 3, at: '2026-08-13T06:00:00Z',
    });
    expect(result.outcome).toBe('nothing_dispatched');
  });
});

const CHALLAN_1 = issueChallan({
  documentId: 'dc-1', order: ORDER, dispatched: { 'l-rice': 25 },
  format: DC, seq: 1, at: '2026-08-12T06:00:00Z',
}).document!;

const CHALLAN_2 = issueChallan({
  documentId: 'dc-2', order: ORDER, dispatched: { 'l-rice': 15, 'l-oil': 10 },
  alreadyDispatched: { 'l-rice': 25 }, format: DC, seq: 2, at: '2026-08-14T06:00:00Z',
}).document!;

describe('the tax invoice follows the CHALLANS, never the order', () => {
  it('bills only what has actually been delivered', () => {
    const result = issueTaxInvoice({
      documentId: 'inv-1', order: ORDER, challans: [CHALLAN_1],
      format: INV, seq: 1, at: '2026-08-12T18:00:00Z',
    });
    expect(result.issued).toBe(true);
    expect(result.document?.taxClaimable).toBe(true);
    // 25 × 145,000 = 3,625,000 + 5% = 181,250
    expect(result.document?.netMinor).toBe(3_625_000);
    expect(result.document?.grossMinor).toBe(3_806_250);
    // NOT the order's 8,295,000.
    expect(result.document?.grossMinor).not.toBe(ORDER.grossMinor);
    expect(result.detail).toContain('remain undelivered and are NOT billed');
  });

  it('bills the balance on the second challan without double-billing the first', () => {
    const second = issueTaxInvoice({
      documentId: 'inv-2', order: ORDER, challans: [CHALLAN_1, CHALLAN_2],
      alreadyInvoiced: { 'l-rice': 25 }, format: INV, seq: 2, at: '2026-08-14T18:00:00Z',
    });
    expect(second.issued).toBe(true);
    expect(second.document?.lines.map((l) => `${l.lineId}:${l.qty}`).sort()).toEqual(['l-oil:10', 'l-rice:15']);
    // The two invoices together equal the order exactly.
    const first = 3_806_250;
    expect(first + (second.document?.grossMinor ?? 0)).toBe(ORDER.grossMinor);
  });

  it('REFUSES to invoice with nothing delivered', () => {
    const result = issueTaxInvoice({
      documentId: 'inv-3', order: ORDER, challans: [], format: INV, seq: 3, at: '2026-08-12T18:00:00Z',
    });
    expect(result.outcome).toBe('no_challan');
    expect(result.detail).toContain('never from the order');
  });

  it('refuses to invoice past what the challans record', () => {
    const result = issueTaxInvoice({
      documentId: 'inv-4', order: ORDER, challans: [CHALLAN_1],
      alreadyInvoiced: { 'l-rice': 40 }, format: INV, seq: 4, at: '2026-08-12T18:00:00Z',
    });
    expect(result.outcome).toBe('exceeds_delivered');
    expect(result.detail).toContain('an overcharge with a tax invoice attached to it');
  });

  it('refuses a challan belonging to another order', () => {
    const strayOrder: B2BDocument = { ...ORDER, documentId: 'so-other' };
    const stray = issueChallan({
      documentId: 'dc-x', order: strayOrder, dispatched: { 'l-rice': 1 },
      format: DC, seq: 9, at: '2026-08-12T06:00:00Z',
    }).document!;
    const result = issueTaxInvoice({
      documentId: 'inv-5', order: ORDER, challans: [stray], format: INV, seq: 5, at: '2026-08-12T18:00:00Z',
    });
    expect(result.outcome).toBe('wrong_order');
  });
});

describe('the chain reconciles end to end', () => {
  const invoice1 = issueTaxInvoice({
    documentId: 'inv-1', order: ORDER, challans: [CHALLAN_1], format: INV, seq: 1, at: '2026-08-12T18:00:00Z',
  }).document!;

  it('names goods that have gone out with no claim on them', () => {
    const check = checkChain({ order: ORDER, challans: [CHALLAN_1, CHALLAN_2], invoices: [invoice1] });
    expect(check.complete).toBe(false);
    expect(check.uninvoicedMinor).toBeGreaterThan(0);
    expect(check.detail).toContain('stock gone with no claim on it');
  });

  it('agrees when everything ordered has gone and been billed', () => {
    const invoice2 = issueTaxInvoice({
      documentId: 'inv-2', order: ORDER, challans: [CHALLAN_1, CHALLAN_2],
      alreadyInvoiced: { 'l-rice': 25 }, format: INV, seq: 2, at: '2026-08-14T18:00:00Z',
    }).document!;
    const check = checkChain({
      order: ORDER, challans: [CHALLAN_1, CHALLAN_2], invoices: [invoice1, invoice2],
    });
    expect(check.complete).toBe(true);
    expect(check.undeliveredMinor).toBe(0);
    expect(check.uninvoicedMinor).toBe(0);
  });

  it('names an order still to go out', () => {
    const check = checkChain({ order: ORDER, challans: [CHALLAN_1], invoices: [invoice1] });
    expect(check.undeliveredMinor).toBeGreaterThan(0);
    expect(check.detail).toContain('still to go');
  });
});
