import { describe, it, expect } from 'vitest';
import { gstr1Return, toGstnGstr1, b2clThresholdOn, type OutwardDocument, type OutwardSupplyLine } from '../../packages/finance/src/index';

// OB-434 (owner, option a, 28 Oct 2026, in writing): a B2B invoice's value in the GSTN GSTR-1 file is the whole invoice —
// taxable value, GST and compensation cess — as a B2CL invoice's already is, and each rate line carries its cess as
// `csamt`, so the lines add up to `val`. A line with no cess carries no `csamt`.
// OB-433 (owner, 28 Oct 2026, in writing): the B2CL line is confirmed — more than ₹1,00,000 from 1 Aug 2024, more than
// ₹2,50,000 before. GSTINs are synthetic ("ZZZZZ9999Z" is no real PAN).

const STORE = '33AABCS1429B1Z1'; // Tamil Nadu
const BUYER = '33ZZZZZ9999Z1ZC';

const line = (o: Partial<OutwardSupplyLine> = {}): OutwardSupplyLine => ({ hsnCode: '24022090', quantityMinor: 1000, uom: 'nos', taxableMinor: 10_000, rateBps: 2800, cgstMinor: 1_400, sgstMinor: 1_400, igstMinor: 0, ...o });
const b2b = (documentId: string, lines: OutwardSupplyLine[]): OutwardDocument => ({ documentId, documentDate: '2026-10-05', supplyType: 'b2b', recipientGstin: BUYER, placeOfSupplyStateCode: '33', lines });
const paise = (r: number): number => Math.round(r * 100);

describe('OB-434 — a B2B invoice in the GSTN file carries its cess', () => {
  it('the invoice value includes the cess, and the rate line carries it as csamt: the lines add up to val', () => {
    const ret = gstr1Return([b2b('B-1', [line({ cessMinor: 3_600 })])]);
    expect(ret.b2b[0]!.invoiceValueMinor).toBe(10_000 + 1_400 + 1_400 + 3_600);
    const inv = toGstnGstr1(ret, { gstin: STORE, fp: '102026' }).b2b[0]!.inv[0]!;
    expect(inv.val).toBe(164);
    expect(inv.itms[0]!.itm_det).toEqual({ rt: 28, txval: 100, camt: 14, samt: 14, iamt: 0, csamt: 36 });
    const d = inv.itms[0]!.itm_det;
    expect(paise(d.txval + d.camt + d.samt + d.iamt + (d.csamt ?? 0))).toBe(paise(inv.val));
  });

  it('with cess on one rate only, only that rate line carries csamt', () => {
    const ret = gstr1Return([b2b('B-2', [line({ cessMinor: 3_600 }), line({ hsnCode: '100610', rateBps: 500, cgstMinor: 250, sgstMinor: 250 })])]);
    const inv = toGstnGstr1(ret, { gstin: STORE, fp: '102026' }).b2b[0]!.inv[0]!;
    expect(inv.val).toBe(164 + 105);
    expect(inv.itms.map((i) => i.itm_det.csamt)).toEqual([undefined, 36]);
    expect(inv.itms.find((i) => i.itm_det.rt === 5)!.itm_det).not.toHaveProperty('csamt');
  });

  it('an invoice with no cess is unchanged: same val, no csamt key', () => {
    const inv = toGstnGstr1(gstr1Return([b2b('B-3', [line({ rateBps: 500, cgstMinor: 250, sgstMinor: 250 })])]), { gstin: STORE, fp: '102026' }).b2b[0]!.inv[0]!;
    expect(inv.val).toBe(105);
    expect(inv.itms[0]!.itm_det).not.toHaveProperty('csamt');
  });

  it('the return totals are unchanged by it: cess stays out of taxable value and GST', () => {
    const withCess = gstr1Return([b2b('B-4', [line({ cessMinor: 3_600 })])]);
    const without = gstr1Return([b2b('B-4', [line()])]);
    expect(withCess.totalTaxableMinor).toBe(without.totalTaxableMinor);
    expect(withCess.totalTaxMinor).toBe(without.totalTaxMinor);
  });
});

describe('OB-433 — the B2CL line is confirmed', () => {
  it('more than ₹1,00,000 from 1 Aug 2024; more than ₹2,50,000 before', () => {
    expect(b2clThresholdOn('2024-08-01')!.exceedsMinor).toBe(10_000_000);
    expect(b2clThresholdOn('2026-10-28')!.exceedsMinor).toBe(10_000_000);
    expect(b2clThresholdOn('2024-07-31')!.exceedsMinor).toBe(25_000_000);
  });
});
