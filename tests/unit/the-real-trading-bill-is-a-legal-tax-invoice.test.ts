import { describe, it, expect } from 'vitest';
import {
  buildTaxInvoice, taxInvoiceRows, invoiceRenderProblems, taxInvoiceText, invoiceAmount, invoiceRate, invoiceQuantity, indiaDateTime,
  UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR, type TaxInvoiceInput, type TaxInvoiceDocument, type InvoiceRow, type InvoiceField,
} from '../../packages/receipt/src/index';
import { requiredHsnDigits, OWNER_TURNOVER_BAND_FOR_HSN_MINOR, gstStateOf } from '../../packages/finance/src/index';

/**
 * **OB-271 · roadmap v2.1 A1 / A2 / A4 / A8 / A9 · CGST Rule 46 — the real-trading bill is a legal GST tax invoice, or it is
 * not issued.** The invoice is built from the committed bill and the shop's legal identity (legal name, address, GSTIN from
 * the store's setup), the A1 checker runs on every line, the HSN has the digits the owner's turnover band needs (OB-149:
 * ₹5–10 crore → 6), an over-the-counter sale splits CGST + SGST with the store's State as the place of supply, and the tax
 * comes out of the MRP to the paisa. THE CONTRACT: a render missing ANY mandatory field fails. Synthetic data only.
 */

const SHOP = { legalName: 'SRE Hyper Market Private Limited', gstin: '33ABCDE1234F1Z5', address: ['12 Main Road', 'Tiruppur 641601, Tamil Nadu'] };
const LINES: TaxInvoiceInput['lines'] = [
  { description: 'Toor dal 1kg', hsnCode: '071360', quantityMinor: 2, uom: 'ea', unitPriceMinor: 10_500, lineTotalMinor: 21_000, taxRateBps: 500 },
  { description: 'Bath soap 100g', hsnCode: '34011190', quantityMinor: 1, uom: 'ea', unitPriceMinor: 5_900, lineTotalMinor: 5_900, taxRateBps: 1_800 },
  { description: 'துவரம் பருப்பு (loose)', hsnCode: '071360', quantityMinor: 1_250, uom: 'kg', unitPriceMinor: 12_000, lineTotalMinor: 15_000, taxRateBps: 500 },
];
// 20:00 UTC on 21 Oct is 01:30 on 22 Oct in India — the invoice is dated in India time.
const INPUT: TaxInvoiceInput = { identity: SHOP, number: 'L1-000123', committedAt: '2026-10-21T20:00:00.000Z', laneId: 'lane-1', cashierId: 'u-lanecash', lines: LINES, tenders: [{ kind: 'card', amountMinor: 41_900, machineRef: '123456' }] };

const built = (input: TaxInvoiceInput = INPUT): TaxInvoiceDocument => {
  const b = buildTaxInvoice(input);
  if (!b.ok) throw new Error(b.laneMessage);
  return b.doc;
};
const codes = (input: TaxInvoiceInput): string[] => { const b = buildTaxInvoice(input); return b.ok ? [] : b.problems.map((p) => p.code); };

describe('OB-271 — the tax invoice is built from the bill and the shop\'s setup (A1 · A4 · A8 · A9)', () => {
  it('a complete bill: "Tax Invoice", the supplier, number, India date, place of supply, CGST + SGST per rate, to the paisa', () => {
    const doc = built();
    expect(doc.title).toBe('Tax Invoice');
    expect(doc.supplier).toEqual({ ...SHOP, stateCode: '33', stateName: 'Tamil Nadu' });
    expect(doc).toMatchObject({ number: 'L1-000123', date: '2026-10-22', time: '01:30', reverseCharge: false });
    expect(doc.placeOfSupply).toEqual({ kind: 'intra_state', stateCode: '33', stateName: 'Tamil Nadu' });
    // A9: ₹210 at 5% → ₹200.00 + ₹5.00 CGST + ₹5.00 SGST; ₹59 at 18% → ₹50.00 + ₹4.50 + ₹4.50; ₹150 at 5% → ₹142.86 + 3.57 + 3.57.
    expect(doc.lines.map((l) => [l.taxableMinor, l.cgstMinor, l.sgstMinor])).toEqual([[20_000, 500, 500], [5_000, 450, 450], [14_286, 357, 357]]);
    for (const l of doc.lines) expect(l.taxableMinor + l.cgstMinor + l.sgstMinor).toBe(l.lineTotalMinor);
    expect(doc.bands).toEqual([
      { rateBps: 500, taxableMinor: 34_286, cgstMinor: 857, sgstMinor: 857 },
      { rateBps: 1_800, taxableMinor: 5_000, cgstMinor: 450, sgstMinor: 450 },
    ]);
    expect(doc.taxableMinor + doc.cgstMinor + doc.sgstMinor).toBe(doc.totalMinor);
    expect(doc.totalMinor).toBe(41_900);
  });

  it('A9 · A8: an odd paisa of tax lands on SGST, never lost — ₹1 at 12% is 89p + 5p CGST + 6p SGST', () => {
    const doc = built({ ...INPUT, lines: [{ description: 'Sweet', hsnCode: '170490', quantityMinor: 1, uom: 'ea', unitPriceMinor: 100, lineTotalMinor: 100, taxRateBps: 1_200 }] });
    expect(doc.lines[0]).toMatchObject({ taxableMinor: 89, cgstMinor: 5, sgstMinor: 6, lineTotalMinor: 100 });
  });

  it('A4 · OB-149: the owner\'s ₹5–10 crore band needs a 6-digit HSN — 4 digits are refused, 6 and 8 are kept', () => {
    expect(requiredHsnDigits(OWNER_TURNOVER_BAND_FOR_HSN_MINOR)).toBe(6);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '0713' }] })).toEqual(['line_hsn_digits']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '071360' }] })).toEqual([]);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: '07136000' }] })).toEqual([]);
    // A tax class that is not an HSN code (letters), or none at all, is refused — never padded.
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, hsnCode: 'TC-5' }] })).toEqual(['line_hsn']);
    const { hsnCode: _gone, ...noHsn } = LINES[0]!;
    void _gone;
    expect(codes({ ...INPUT, lines: [noHsn] })).toEqual(['line_hsn']);
  });

  it('the shop\'s setup: no legal name, no address, no or a malformed GSTIN — each refused by name, in words, all at once', () => {
    expect(codes({ ...INPUT, identity: null })).toEqual(expect.arrayContaining(['supplier_legal_name', 'supplier_address', 'supplier_gstin']));
    expect(codes({ ...INPUT, identity: { ...SHOP, legalName: '  ' } })).toEqual(['supplier_legal_name']);
    expect(codes({ ...INPUT, identity: { ...SHOP, address: [] } })).toEqual(['supplier_address']);
    expect(codes({ ...INPUT, identity: { ...SHOP, gstin: '' } })).toEqual(['supplier_gstin']);
    expect(codes({ ...INPUT, identity: { ...SHOP, gstin: 'NOT-A-GSTIN' } })).toEqual(expect.arrayContaining(['supplier_gstin']));
    const r = buildTaxInvoice({ ...INPUT, identity: { ...SHOP, gstin: '' } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.laneMessage).toMatch(/^This bill cannot be issued as a legal tax invoice, so it was NOT saved — do not take money\. the shop's GSTIN is not set up/);
  });

  it('the number (≤16, Rule 46(b)) and the date must read; a line needs a name, a quantity, a unit and a value', () => {
    expect(codes({ ...INPUT, number: 'L1/2026-27/00000123' })).toEqual(['invoice_number']);
    expect(codes({ ...INPUT, committedAt: 'not a time' })).toEqual(['invoice_date']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, description: '' }] })).toEqual(['line_description']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, quantityMinor: 0 }] })).toEqual(['line_quantity']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, uom: '' }] })).toEqual(['line_unit']);
    expect(codes({ ...INPUT, lines: [] })).toEqual(['line_description']);
  });

  it('not decided by the sources, so refused until the owner decides: an exempt / nil-rated line, and a bill of ₹50,000 or more', () => {
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, taxRateBps: 0 }] })).toEqual(['exempt_line']);
    const big = UNREGISTERED_RECIPIENT_DETAILS_FROM_MINOR * 105 / 100; // taxable exactly ₹50,000 inside a 5% MRP
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, quantityMinor: 1, unitPriceMinor: big, lineTotalMinor: big }] })).toEqual(['recipient_details']);
    expect(codes({ ...INPUT, lines: [{ ...LINES[0]!, quantityMinor: 1, unitPriceMinor: big - 2, lineTotalMinor: big - 2 }] })).toEqual([]);
    const r = buildTaxInvoice({ ...INPUT, lines: [{ ...LINES[0]!, taxRateBps: 0 }] });
    if (!r.ok) expect(r.laneMessage).toContain('Toor dal 1kg: an item is exempt or nil-rated');
  });

  it('A8: the GSTIN\'s first two digits are the State the sale is supplied in', () => {
    expect(gstStateOf('33ABCDE1234F1Z5')).toEqual({ code: '33', name: 'Tamil Nadu' });
    expect(gstStateOf('32ABCDE1234F1Z5')).toEqual({ code: '32', name: 'Kerala' });
    expect(gstStateOf('00ABCDE1234F1Z5')).toBeUndefined();
    expect(indiaDateTime('2026-10-21T18:29:00.000Z')).toEqual({ date: '2026-10-21', time: '23:59' });
    expect(indiaDateTime('2026-10-21T18:30:00.000Z')).toEqual({ date: '2026-10-22', time: '00:00' });
  });
});

/** Every mandatory field a render must show, and the rows that carry it. */
const MANDATORY: readonly InvoiceField[] = [
  'title', 'supplier_legal_name', 'supplier_address', 'supplier_gstin', 'invoice_number', 'invoice_date', 'place_of_supply',
  'reverse_charge', 'line_description', 'line_hsn', 'line_quantity', 'line_taxable_value', 'line_rate', 'cgst', 'sgst', 'total', 'signatory',
];

describe('THE CONTRACT (A1): a render that is missing any field fails', () => {
  const doc = built();

  it('a complete render, in English and in Tamil, shows every mandatory field', () => {
    expect(invoiceRenderProblems(taxInvoiceRows(doc), doc)).toEqual([]);
    expect(invoiceRenderProblems(taxInvoiceRows(doc, { language: 'ta' }), doc)).toEqual([]);
    expect(invoiceRenderProblems(taxInvoiceRows(doc, { duplicate: true }), doc)).toEqual([]);
  });

  it.each(MANDATORY)('without the rows carrying "%s", the render FAILS the contract', (field) => {
    const rows = taxInvoiceRows(doc).filter((r) => !r.fields.includes(field));
    expect(invoiceRenderProblems(rows, doc).length).toBeGreaterThan(0);
  });

  it.each(MANDATORY)('with "%s" printed blank, the render FAILS the contract', (field) => {
    const rows: InvoiceRow[] = taxInvoiceRows(doc).map((r) => (r.fields.includes(field) ? { ...r, text: '', left: '', right: '' } : r));
    expect(invoiceRenderProblems(rows, doc).length).toBeGreaterThan(0);
  });

  it('a line\'s field printed on ANOTHER line\'s row does not count — each line shows its own', () => {
    const rows = taxInvoiceRows(doc).map((r) => (r.line === 1 && r.fields.includes('line_hsn') ? { ...r, line: 0 } : r));
    expect(invoiceRenderProblems(rows, doc)).toEqual(expect.arrayContaining(['line 2: the HSN code']));
  });

  it('the printed words: "Tax Invoice", GSTIN, HSN per line, "CGST @ 2.5%", the place of supply — and a reprint says DUPLICATE', () => {
    const text = taxInvoiceText(taxInvoiceRows(doc)).join('\n');
    expect(text).toMatch(/^ +Tax Invoice$/m);
    expect(text).toContain('GSTIN: 33ABCDE1234F1Z5');
    expect(text).toContain('Place of supply: Tamil Nadu (33)');
    expect(text).toContain('Tax payable on reverse charge: No');
    expect(text).toMatch(/HSN 071360 · GST 5%/);
    expect(text).toMatch(/^ {2}CGST @ 2\.5% +8\.57$/m);
    expect(text).toMatch(/^ {2}SGST @ 9% +4\.50$/m);
    expect(text).toMatch(/^Total \(incl\. GST\) +419\.00$/m);
    expect(text).toContain('Paid: Card (approval 123456)');
    expect(text).not.toContain('DUPLICATE');
    expect(taxInvoiceText(taxInvoiceRows(doc, { duplicate: true })).join('\n')).toContain('DUPLICATE — reprint');
    const ta = taxInvoiceText(taxInvoiceRows(doc, { language: 'ta', duplicate: true })).join('\n');
    expect(ta).toContain('Tax Invoice / வரி விலைப்பட்டியல்');
    expect(ta).toContain('நகல் (DUPLICATE)');
    expect(ta).toContain('வழங்கல் இடம்: Tamil Nadu (33)');
    expect(ta).toContain('துவரம் பருப்பு (loose)');
    // 58 mm: every line fits 32 columns.
    expect(taxInvoiceText(taxInvoiceRows(doc), 32).every((l) => l.length <= 32)).toBe(true);
  });

  it('amounts, rates and quantities as printed', () => {
    expect(invoiceAmount(41_900)).toBe('419.00');
    expect(invoiceAmount(5)).toBe('0.05');
    expect(invoiceRate(250)).toBe('2.5%');
    expect(invoiceRate(1_800)).toBe('18%');
    expect(invoiceRate(25)).toBe('0.25%');
    expect(invoiceQuantity(2, 'ea')).toBe('2 Nos');
    expect(invoiceQuantity(1_250, 'kg')).toBe('1.250 kg'); // OB-31: weighed goods with their three decimals
    expect(invoiceQuantity(500, 'g')).toBe('500 g');
  });
});
