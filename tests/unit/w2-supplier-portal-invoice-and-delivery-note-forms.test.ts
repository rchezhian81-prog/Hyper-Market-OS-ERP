import { describe, it, expect } from 'vitest';
import {
  readInvoiceSubmission, readAsnSubmission, minorOfTyped, paiseOfTyped, lineValueMinor, DOCUMENT_MAX_LINES,
  SUPPLIER_PORTAL_COPY, COPY_KEYS, type SupplierOrdersFeed, type AsnLineInput,
} from '../../apps/supplier-app/src/supplier-portal-session';
import { valueAtUnitCost } from '../../packages/contracts/src/quantity';
import { bilingualGaps } from '../../packages/ui/src/index';

/**
 * OB-624 (owner, 1 Nov 2026, "allow both"): the supplier portal's Invoice and Delivery note (ASN) forms are checked before
 * anything is sent — the supplier's own open orders only, head office's own quantity scale and arithmetic (OB-31), every
 * refusal named in the supplier's words, English and Tamil.
 */

const feed: SupplierOrdersFeed = { ordersKnown: true, mayUpdate: false, orders: [{ poId: 'po-a', number: 'PO-1', issuedAt: null, deliverToLocationId: null }] };
const at = () => '2026-11-03T05:00:00.000Z';
const asnLine = (over: Partial<AsnLineInput> = {}): AsnLineInput => ({ productId: 'p-oil', quantity: '12', uom: 'ea', batchId: '', expiry: '', manufacturedOn: '', ...over });

describe('quantities and money are read on head office\'s scale', () => {
  it('pieces are whole; kg and litres to the gram and millilitre; a line is quantity × price per whole unit, rounded once', () => {
    expect(minorOfTyped('12', 'ea')).toBe(12);
    expect(minorOfTyped('1.5', 'ea')).toBeUndefined();
    expect(minorOfTyped('2.5', 'kg')).toBe(2500);
    expect(minorOfTyped('0.125', 'L')).toBe(125);
    expect(minorOfTyped('0.1255', 'kg')).toBeUndefined();
    expect(minorOfTyped('0', 'ea')).toBeUndefined();
    expect(minorOfTyped('3', 'box')).toBeUndefined();
    expect(paiseOfTyped('18.5')).toBe(1850);
    expect(paiseOfTyped('₹ 1,200.00')).toBe(120000);
    expect(paiseOfTyped('18.505')).toBeUndefined();
    // The same value head office computes (valueAtUnitCost) — so a bill the form lets through multiplies at review.
    for (const [q, u, p] of [[2500, 'kg', 4500], [333, 'kg', 4799], [1, 'kg', 1], [12, 'ea', 1800], [1505, 'L', 9999]] as const) {
      expect(lineValueMinor(q, u, p), `${q} ${u} @ ${p}`).toBe(valueAtUnitCost(q, u, p));
    }
  });
});

describe('the invoice form', () => {
  const line = { productId: 'p-rice', quantity: '2.5', uom: 'kg', unitPrice: '45' };
  it('builds the invoice document head office takes: its own order, lines multiplied, the total as on the paper', () => {
    expect(readInvoiceSubmission({ poId: 'po-a', invoiceId: ' INV-9 ', total: '112.50', lines: [line, { productId: '', quantity: '', uom: 'ea', unitPrice: '' }] }, feed, true)).toEqual({
      ok: true, document: { invoiceId: 'INV-9', poId: 'po-a', declaredTotalMinor: 11250, lines: [{ productId: 'p-rice', quantity: 2500, uom: 'kg', unitPriceMinor: 4500, lineTotalMinor: 11250 }] },
    });
    // Not against an order: no poId at all.
    const free = readInvoiceSubmission({ poId: '', invoiceId: 'INV-10', total: '112.5', lines: [line] }, null, true);
    expect(free.ok && !('poId' in free.document)).toBe(true);
  });

  it('refuses before sending — each by name, with the line', () => {
    const r = (over: Partial<Parameters<typeof readInvoiceSubmission>[0]>, f: SupplierOrdersFeed | null = feed, may = true) =>
      readInvoiceSubmission({ poId: 'po-a', invoiceId: 'INV-9', total: '112.50', lines: [line], ...over }, f, may);
    expect(r({}, feed, false)).toEqual({ ok: false, why: 'cannotSubmit' });
    expect(r({ poId: 'po-z' })).toEqual({ ok: false, why: 'notYourOrder' });
    expect(r({}, null)).toEqual({ ok: false, why: 'ordersUnknownSend' });
    expect(r({ invoiceId: ' ' })).toEqual({ ok: false, why: 'needInvoiceNo' });
    expect(r({ lines: [] })).toEqual({ ok: false, why: 'needLine' });
    expect(r({ lines: Array.from({ length: DOCUMENT_MAX_LINES + 1 }, () => line) })).toEqual({ ok: false, why: 'tooManyLines' });
    expect(r({ lines: [line, { ...line, productId: '' }] })).toEqual({ ok: false, why: 'needItem', line: 2 });
    expect(r({ lines: [{ ...line, uom: 'box' }] })).toEqual({ ok: false, why: 'badUnit', line: 1 });
    expect(r({ lines: [{ ...line, quantity: '2.5555' }] })).toEqual({ ok: false, why: 'badLineQty', line: 1 });
    expect(r({ lines: [{ ...line, unitPrice: 'forty' }] })).toEqual({ ok: false, why: 'badPrice', line: 1 });
    expect(r({ total: '' })).toEqual({ ok: false, why: 'needTotal', linesMinor: 11250 });
    expect(r({ total: '112.00' })).toEqual({ ok: false, why: 'totalDisagrees', linesMinor: 11250, totalMinor: 11200 });
  });
});

describe('the delivery note (ASN) form', () => {
  it('builds the ASN document head office takes: numbered lines, the shop\'s clock, batch, best-before and month made', () => {
    expect(readAsnSubmission({ poId: 'po-a', asnId: 'ASN-3', expectedAt: '2026-11-03T10:30', lines: [asnLine({ quantity: '25', uom: 'kg', batchId: ' B-1 ', expiry: '2027-05-01', manufacturedOn: '2026-10' }), asnLine({ productId: '', quantity: '', uom: 'ea' }), asnLine()] }, feed, true, at)).toEqual({
      ok: true, document: { asnId: 'ASN-3', poId: 'po-a', expectedAt: '2026-11-03T05:00:00.000Z', lines: [
        { lineId: 'L1', productId: 'p-oil', quantityMinor: 25000, uom: 'kg', batchId: 'B-1', expiry: '2027-05-01', manufacturedOn: '2026-10' },
        { lineId: 'L2', productId: 'p-oil', quantityMinor: 12, uom: 'ea' },
      ] },
    });
  });

  it('refuses before sending — each by name, with the line', () => {
    const r = (over: Partial<Parameters<typeof readAsnSubmission>[0]>, may = true, instant: (s: string) => string = at) =>
      readAsnSubmission({ poId: 'po-a', asnId: 'ASN-3', expectedAt: '2026-11-03T10:30', lines: [asnLine()], ...over }, feed, may, instant);
    expect(r({}, false)).toEqual({ ok: false, why: 'cannotSubmit' });
    expect(r({ poId: 'po-z' })).toEqual({ ok: false, why: 'notYourOrder' });
    expect(r({ asnId: '' })).toEqual({ ok: false, why: 'needAsnNo' });
    expect(r({}, true, () => '')).toEqual({ ok: false, why: 'needExpectedAt' });
    expect(r({ lines: [] })).toEqual({ ok: false, why: 'needLine' });
    expect(r({ lines: [asnLine({ quantity: '1.5' })] })).toEqual({ ok: false, why: 'badLineQty', line: 1 });
    expect(r({ lines: [asnLine({ expiry: '31/12/2027' })] })).toEqual({ ok: false, why: 'badExpiry', line: 1 });
    expect(r({ lines: [asnLine({ manufacturedOn: '2026-13' })] })).toEqual({ ok: false, why: 'badMade', line: 1 });
    expect(r({ lines: [asnLine({ batchId: 'x'.repeat(65) })] })).toEqual({ ok: false, why: 'badBatch', line: 1 });
  });
});

describe('every word of the two forms is in English and Tamil', () => {
  it('has no gap, and each line-numbered refusal names its line in both', () => {
    const gaps = bilingualGaps(SUPPLIER_PORTAL_COPY, COPY_KEYS);
    expect(gaps).toEqual({ en: [], ta: [] });
    for (const k of ['needItem', 'badUnit', 'badLineQty', 'badPrice', 'badExpiry', 'badMade', 'badBatch'] as const) {
      expect(SUPPLIER_PORTAL_COPY.en[k], k).toContain('{n}');
      expect(SUPPLIER_PORTAL_COPY.ta[k], k).toContain('{n}');
    }
    expect(SUPPLIER_PORTAL_COPY.ta.totalDisagrees).toMatch(/\{lines\}.*\{total\}/);
  });
});
