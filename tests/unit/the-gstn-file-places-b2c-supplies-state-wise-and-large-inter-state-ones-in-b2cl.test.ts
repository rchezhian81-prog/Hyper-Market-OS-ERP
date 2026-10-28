import { describe, it, expect } from 'vitest';
import {
  gstr1Return, toGstnGstr1, Gstr1ExportRefused, b2clThresholdOn, B2CL_THRESHOLDS,
  salesToOutwardSupplies, netTable12, toGstnB2cFromSales,
  type OutwardDocument, type OutwardSupplyLine, type GstnGstr1,
} from '../../packages/finance/src/index';

// OB-431 (owner, option A, 28 Oct 2026, in writing) — B2CS and B2CL in the GSTN GSTR-1 file. Every B2C supply carries its
// place of supply: B2CS rows are one (supply type, place of supply, rate) group each, with `pos`; an inter-State B2C invoice
// above the legal line (₹2,50,000 before 1 Aug 2024, ₹1,00,000 from then) is reported invoice-wise in B2CL and is then not in
// B2CS; a document whose place of supply cannot be judged stops the file by name. Till sales are over the counter — the
// store's own State. GSTINs are synthetic ("ZZZZZ9999Z" is no real PAN).

const STORE = '33AABCS1429B1Z1'; // Tamil Nadu
const KL = '32ZZZZZ9999Z1ZH';

const line = (o: Partial<OutwardSupplyLine> = {}): OutwardSupplyLine => ({ hsnCode: '100610', quantityMinor: 1000, uom: 'kg', taxableMinor: 10_000, rateBps: 500, cgstMinor: 250, sgstMinor: 250, igstMinor: 0, ...o });
/** An inter-State line: the whole GST as IGST. */
const igst = (taxableMinor: number, rateBps = 500, igstMinor = Math.round((taxableMinor * rateBps) / 10_000)): OutwardSupplyLine => line({ taxableMinor, rateBps, cgstMinor: 0, sgstMinor: 0, igstMinor });
const b2c = (documentId: string, o: Partial<OutwardDocument> = {}): OutwardDocument => ({ documentId, documentDate: '2026-10-05', supplyType: 'b2c', lines: [line()], ...o });
const file = (docs: OutwardDocument[]): GstnGstr1 => toGstnGstr1(gstr1Return(docs), { gstin: STORE, fp: '102026' });
const refusedBy = (docs: OutwardDocument[]): Gstr1ExportRefused => {
  try { file(docs); } catch (e) { if (e instanceof Gstr1ExportRefused) return e; throw e; }
  throw new Error('the file was made');
};
/** Taxable + tax across every section of the file, in paise — what the HSN summary also holds. */
const sectionTotals = (f: GstnGstr1) => {
  const p = (r: number) => Math.round(r * 100);
  let taxable = 0, tax = 0;
  for (const b of f.b2b) for (const i of b.inv) for (const it of i.itms) { taxable += p(it.itm_det.txval); tax += p(it.itm_det.camt + it.itm_det.samt + it.itm_det.iamt); }
  for (const b of f.b2cl) for (const i of b.inv) for (const it of i.itms) { taxable += p(it.itm_det.txval); tax += p(it.itm_det.iamt); }
  for (const r of f.b2cs) { taxable += p(r.txval); tax += p(r.camt + r.samt + r.iamt); }
  return { taxable, tax };
};

describe('OB-431 — B2CS is State-wise: one row per supply type, place of supply and rate', () => {
  it('groups by pos and rate; INTRA for the filer\'s own State, INTER for another; a blank State with CGST + SGST is the filer\'s own', () => {
    const f = file([
      b2c('C-1'), // no State recorded, CGST + SGST → 33
      b2c('C-2', { placeOfSupplyStateCode: '33', lines: [line({ taxableMinor: 20_000, cgstMinor: 500, sgstMinor: 500 })] }),
      b2c('C-3', { placeOfSupplyStateCode: '32', lines: [igst(30_000)] }),
      b2c('C-4', { placeOfSupplyStateCode: '32', lines: [igst(40_000, 1200), igst(5_000)] }),
      b2c('C-5', { placeOfSupplyStateCode: '29', lines: [igst(10_000)] }),
    ]);
    expect(f.b2cl).toEqual([]);
    expect(f.b2cs).toEqual([
      { sply_ty: 'INTER', pos: '29', typ: 'OE', rt: 5, txval: 100, camt: 0, samt: 0, iamt: 5 },
      { sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 350, camt: 0, samt: 0, iamt: 17.5 },
      { sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 12, txval: 400, camt: 0, samt: 0, iamt: 48 },
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 5, txval: 300, camt: 7.5, samt: 7.5, iamt: 0 },
    ]);
  });
  it('a B2B-typed document with no GSTIN is a B2C supply and is placed State-wise the same way', () => {
    const f = file([{ documentId: 'X-1', documentDate: '2026-10-05', supplyType: 'b2b', placeOfSupplyStateCode: '32', lines: [igst(10_000)] }]);
    expect(f.b2b).toEqual([]);
    expect(f.b2cs).toEqual([{ sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 100, camt: 0, samt: 0, iamt: 5 }]);
  });
  it('carries the compensation cess in csamt when a line has one, and only then', () => {
    const f = file([b2c('C-1', { lines: [line({ rateBps: 2800, taxableMinor: 10_000, cgstMinor: 1_400, sgstMinor: 1_400, cessMinor: 1_200 })] }), b2c('C-2')]);
    expect(f.b2cs).toEqual([
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 5, txval: 100, camt: 2.5, samt: 2.5, iamt: 0 },
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 28, txval: 100, camt: 14, samt: 14, iamt: 0, csamt: 12 },
    ]);
  });
});

describe('OB-431 — B2CL: an inter-State B2C invoice above the legal line, invoice by invoice', () => {
  // ₹95,238.10 + 5% IGST ₹4,761.90 = exactly ₹1,00,000 — ON the line, not above it.
  const onTheLine = igst(9_523_810, 500, 476_190);
  const justAbove = igst(9_523_810, 500, 476_191); // ₹1,00,000.01

  it('from 1 Aug 2024 the line is ₹1,00,000: exactly ₹1,00,000 stays in B2CS; one paisa more goes to B2CL', () => {
    const f = file([
      b2c('ON', { documentDate: '2026-10-05', placeOfSupplyStateCode: '32', lines: [onTheLine] }),
      b2c('ABOVE', { documentDate: '2026-10-06', placeOfSupplyStateCode: '32', lines: [justAbove] }),
    ]);
    expect(f.b2cl).toEqual([{ pos: '32', inv: [{ inum: 'ABOVE', idt: '06-10-2026', val: 100_000.01, itms: [{ num: 1, itm_det: { rt: 5, txval: 95_238.1, iamt: 4_761.91 } }] }] }]);
    expect(f.b2cs).toEqual([{ sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 95_238.1, camt: 0, samt: 0, iamt: 4_761.9 }]);
  });

  it('either side of 1 Aug 2024: a ₹2,00,000 invoice on 31 Jul 2024 is B2CS (line ₹2,50,000); the same on 1 Aug 2024 is B2CL', () => {
    const twoLakh = igst(19_047_619, 500, 952_381); // ₹2,00,000
    const f = toGstnGstr1(gstr1Return([
      b2c('JUL', { documentDate: '2024-07-31', placeOfSupplyStateCode: '32', lines: [twoLakh] }),
      b2c('AUG', { documentDate: '2024-08-01', placeOfSupplyStateCode: '32', lines: [twoLakh] }),
    ]), { gstin: STORE, fp: '072024' });
    expect(f.b2cl.flatMap((b) => b.inv.map((i) => i.inum))).toEqual(['AUG']);
    expect(f.b2cs).toEqual([{ sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 190_476.19, camt: 0, samt: 0, iamt: 9_523.81 }]);
    // Before 1 Aug 2024 the ₹2,50,000 line: exactly ₹2,50,000 stays in B2CS, one paisa more goes to B2CL.
    const before = toGstnGstr1(gstr1Return([
      b2c('ON-OLD', { documentDate: '2024-07-31', placeOfSupplyStateCode: '29', lines: [igst(23_809_524, 500, 1_190_476)] }),
      b2c('ABOVE-OLD', { documentDate: '2024-07-31', placeOfSupplyStateCode: '29', lines: [igst(23_809_524, 500, 1_190_477)] }),
    ]), { gstin: STORE, fp: '072024' });
    expect(before.b2cl).toEqual([{ pos: '29', inv: [expect.objectContaining({ inum: 'ABOVE-OLD', val: 250_000.01 })] }]);
    expect(before.b2cs.map((r) => [r.pos, r.txval])).toEqual([['29', 238_095.24]]);
  });

  it('a B2CL invoice is NOT also in B2CS; groups by pos; cess goes in csamt and counts in the invoice value; the sections add up to the HSN summary', () => {
    const docs = [
      b2c('L-2', { documentDate: '2026-10-07', placeOfSupplyStateCode: '32', lines: [igst(10_000_000, 1800), igst(1_000_000, 500)] }),
      b2c('L-1', { documentDate: '2026-10-06', placeOfSupplyStateCode: '32', lines: [{ ...igst(9_000_000, 2800), cessMinor: 1_080_000 }] }),
      b2c('L-3', { documentDate: '2026-10-08', placeOfSupplyStateCode: '29', lines: [igst(20_000_000, 1800)] }),
      b2c('S-1', { placeOfSupplyStateCode: '32', lines: [igst(30_000)] }),
      { documentId: 'B-1', documentDate: '2026-10-05', supplyType: 'b2b' as const, recipientGstin: KL, placeOfSupplyStateCode: '32', lines: [igst(10_000)] },
    ];
    const f = file(docs);
    expect(f.b2cl).toEqual([
      { pos: '29', inv: [{ inum: 'L-3', idt: '08-10-2026', val: 236_000, itms: [{ num: 1, itm_det: { rt: 18, txval: 200_000, iamt: 36_000 } }] }] },
      { pos: '32', inv: [
        // ₹90,000 + 28% IGST ₹25,200 = ₹1,15,200 of GST — with the ₹10,800 cess the invoice is ₹1,26,000.
        { inum: 'L-1', idt: '06-10-2026', val: 126_000, itms: [{ num: 1, itm_det: { rt: 28, txval: 90_000, iamt: 25_200, csamt: 10_800 } }] },
        { inum: 'L-2', idt: '07-10-2026', val: 128_500, itms: [{ num: 1, itm_det: { rt: 5, txval: 10_000, iamt: 500 } }, { num: 2, itm_det: { rt: 18, txval: 100_000, iamt: 18_000 } }] },
      ] },
    ]);
    expect(f.b2cs).toEqual([{ sply_ty: 'INTER', pos: '32', typ: 'OE', rt: 5, txval: 300, camt: 0, samt: 0, iamt: 15 }]);
    // Nothing twice, nothing lost: every section together equals the HSN summary (and the return's totals).
    const ret = gstr1Return(docs);
    expect(sectionTotals(f)).toEqual({ taxable: ret.totalTaxableMinor, tax: ret.totalTaxMinor });
  });

  it('B2CL is only for inter-State supplies: a ₹5,00,000 invoice inside the filer\'s own State stays in B2CS', () => {
    const f = file([b2c('BIG', { lines: [line({ taxableMinor: 47_619_048, cgstMinor: 1_190_476, sgstMinor: 1_190_476 })] })]);
    expect(f.b2cl).toEqual([]);
    expect(f.b2cs).toEqual([{ sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 5, txval: 476_190.48, camt: 11_904.76, samt: 11_904.76, iamt: 0 }]);
  });

  it('the line is a dated table: ₹2,50,000 from 1 Jul 2017, ₹1,00,000 from 1 Aug 2024; nothing before GST', () => {
    expect(B2CL_THRESHOLDS.map((t) => [t.effectiveFrom, t.exceedsMinor])).toEqual([['2017-07-01', 25_000_000], ['2024-08-01', 10_000_000]]);
    expect(b2clThresholdOn('2024-07-31')?.exceedsMinor).toBe(25_000_000);
    expect(b2clThresholdOn('2024-08-01')?.exceedsMinor).toBe(10_000_000);
    expect(b2clThresholdOn('2026-10-28')?.exceedsMinor).toBe(10_000_000);
    expect(b2clThresholdOn('2017-06-30')).toBeUndefined();
  });
});

describe('OB-431 — every B2C supply carries its place of supply, or the file stops by name', () => {
  it('a B2C document that charged IGST with no State is refused, named as an unregistered buyer, together with any B2B one', () => {
    const e = refusedBy([
      b2c('C-9', { lines: [igst(10_000)] }),
      { documentId: 'B-9', documentDate: '2026-10-05', supplyType: 'b2b', recipientGstin: KL, lines: [igst(10_000)] },
      b2c('C-OK'),
    ]);
    expect(e.problems).toEqual([
      { invoiceNumber: 'B-9', recipientGstin: KL, why: 'it charged IGST (a supply to another State) but no place of supply is recorded on it' },
      { invoiceNumber: 'C-9', why: 'it charged IGST (a supply to another State) but no place of supply is recorded on it' },
    ]);
    expect(e.message).toContain('C-9 (unregistered buyer)');
  });
  it('a State that disagrees with the split is refused: IGST to the own State; CGST + SGST to another', () => {
    expect(refusedBy([b2c('C-1', { placeOfSupplyStateCode: '33', lines: [igst(10_000)] })]).problems[0]!.why).toMatch(/charged IGST but its place of supply \(33\) is the filer's own State/);
    expect(refusedBy([b2c('C-2', { placeOfSupplyStateCode: '32' })]).problems[0]!.why).toMatch(/charged CGST \+ SGST but its place of supply \(32\) is not the filer's own State \(33\)/);
  });
  it('an inter-State invoice dated before GST began is refused rather than measured against no line', () => {
    expect(refusedBy([b2c('OLD', { documentDate: '2017-06-30', placeOfSupplyStateCode: '32', lines: [igst(10_000)] })]).problems[0]!.why).toMatch(/before GST began/);
  });
});

describe('OB-431 — till sales are over the counter: the store\'s own State', () => {
  const SMALL = 1_000_000;
  it('each till b2cs row is INTRA with the filer\'s State as pos, grouped by rate', () => {
    const t12 = salesToOutwardSupplies({
      sales: [
        { productId: 'MILK', quantityMinor: 1, uom: 'each', lineTotalMinor: 11_800 },
        { productId: 'GHEE', quantityMinor: 1, uom: 'each', lineTotalMinor: 23_600 },
        { productId: 'RICE', quantityMinor: 1, uom: 'each', lineTotalMinor: 10_500 },
      ],
      taxTable: [{ productId: 'MILK', hsnCode: '0401', rateBps: 1800 }, { productId: 'GHEE', hsnCode: '0405', rateBps: 1800 }, { productId: 'RICE', hsnCode: '1006', rateBps: 500 }],
      annualTurnoverMinor: SMALL,
    }).table12;
    const empty = { rows: [], totalTaxableMinor: 0, totalTaxMinor: 0, b2bTaxableMinor: 0, b2cTaxableMinor: 0, detail: '' };
    const gstn = toGstnB2cFromSales(netTable12(t12, empty), { gstin: STORE, fp: '102026' });
    expect(gstn.b2cs).toEqual([
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 5, txval: 100, camt: 2.5, samt: 2.5, iamt: 0 },
      { sply_ty: 'INTRA', pos: '33', typ: 'OE', rt: 18, txval: 300, camt: 27, samt: 27, iamt: 0 },
    ]);
    expect(gstn).not.toHaveProperty('b2cl');
  });
});
